/**
 * Replaying one recorded session for the replay check: the whole of what the
 * live runner does to a session, with every model call handed in.
 *
 * The session is cut two or three times in a chain (see `replay-corpus.ts`),
 * and replayed in two lanes side by side, both starting from the recording as
 * it stood before the first cut:
 *
 * - ours: the compaction extension, registered on the same stand-in for pi the
 *   offline suite drives (`tests/fake-pi.ts`), so that `turn_end` and
 *   `session_before_compact` are chained exactly as pi chains them. Each
 *   recorded turn is replayed as its `turn_end`, with pressure reported under
 *   notice, so that nothing happens until a cut. At a cut, pressure is reported
 *   high enough for that kind of compaction, and the extension writes its
 *   Handoff with its real writer chain.
 * - pi's default: the same recording with no extension at all, compacted at the
 *   same cuts by pi's own `compact`, chained on its own summaries.
 *
 * At each cut, each lane's continuation carries on from its Handoff against
 * the recording, the deterministic checks run on its Handoff, and the judge
 * scores the cut with both Handoffs in front of it, blind.
 *
 * The cuts: a forced cut reports the forced level at the turn's boundary. A
 * Self-compaction cut reports warning, so that the extension sends its real
 * steer, and asks the session's model what it does next; if it calls
 * `self_compact`, its own note goes to the Handoff, and if it doesn't, the cut
 * compacts as forced and says so. A cut before a user message is `/compact`,
 * through pi's hook, once the prompt has ended. The recording is only ever read:
 * every session here is in memory.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage, TranscriptContext } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	type CompactionEntry,
	compact,
	convertToLlm,
	getLatestCompactionEntry,
	type SessionEntry,
	SessionManager,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
// pi's own preparation for a compaction, not exported from the package root.
import { prepareCompaction } from "../tests/pi-internals.ts";
import { type CompactionOptions, registerCompaction, SELF_COMPACT_TOOL, STEER_TYPE } from "../index.ts";
import { piCompactionTokens, resolveLevels, type SettingsLike } from "../pressure.ts";
import { type CollapseReport, collapseGuard, type FileStateDiff, fileStateDiff, type Retention, recurringDetailRetention } from "./replay.ts";
import { type Continuation, continueFrom, futureAfter, proposer } from "./replay-continuation.ts";
import { type Boundary, boundariesOf, type CutKind, type PlannedCut, planCuts, type Recording, USER_TURNS_AFTER } from "./replay-corpus.ts";
import { type Cited, type ContinuationVerdict, judgeCut, type Side } from "./replay-judge.ts";
import { type FakePi, fakePi } from "../tests/fake-pi.ts";
import { retryPolicy } from "../writers.ts";

/** What a model call is spent on, as the report totals it. */
export type Spending = "writer" | "steered" | "pi-default" | "continuation" | "judge";

/** A model call as pi's model registry makes it: `ctx.modelRegistry.streamSimple`. */
export type ModelCall = NonNullable<CompactionOptions["stream"]>;

export interface ReplayDeps {
	/** pi's settings, as the extension would read them. */
	settings: SettingsLike;
	/** The kinds to cut this session with, in chain order. */
	kinds: readonly CutKind[];
	/** A model the session recorded, if it can be reached: known to pi, with credentials. */
	findModel(provider: string, id: string): Model<any> | undefined;
	/** The model call on the session's own model, for what it is spent on. */
	stream(spending: Spending): ModelCall;
	judge: { model: Model<any>; stream: ModelCall };
	/** Which side the judge sees our Handoff as, at the next cut judged. */
	oursSide(): Side;
	/** Where Pruning saves its full copies. */
	prunedDir: string;
}

/** One lane's Handoff at a cut, and what it came to. */
export interface LaneCut {
	handoff: CompactionEntry;
	fileState: FileStateDiff;
	retention: Retention;
	continuation: Continuation;
}

/** The judge's verdict on a cut, with the sides named again. */
export interface CutVerdict {
	constraints: { quote: string; ours: Cited<boolean>; pi: Cited<boolean> }[];
	ours: ContinuationVerdict;
	pi: ContinuationVerdict;
	/** What the judge said that was dropped, and why. */
	dropped: string[];
}

export interface CutResult {
	/** Its place in the chain, the first cut being 1. */
	depth: number;
	kind: CutKind;
	/** What the rotation asked for. */
	requested: CutKind;
	/** A Self-compaction cut whose agent didn't compact when steered to, so that it compacted as forced. */
	declined?: boolean;
	ours?: LaneCut;
	pi?: LaneCut;
	verdict?: CutVerdict;
	/** Why the judge's verdict is missing. */
	unjudged?: string;
	/** Why the cut couldn't be replayed. The chain stops there. */
	error?: string;
}

export interface SessionResult {
	name: string;
	/** `provider/id` of the model the session is replayed on. */
	model?: string;
	/** Why the session wasn't replayed at all. */
	skipped?: string;
	cuts: CutResult[];
	/** Each lane's chain of Handoffs, counted. */
	collapse?: { ours: CollapseReport; pi: CollapseReport };
}

const key = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

/** A turn as recorded: its assistant message and the results of its calls. */
function turnAt(branch: readonly SessionEntry[], boundary: Boundary): { message: AssistantMessage; toolResults: ToolResultMessage[] } {
	const messages = branch.slice(boundary.at, boundary.end + 1).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	return { message: messages[0] as AssistantMessage, toolResults: messages.slice(1) as ToolResultMessage[] };
}

/** The messages of message entries in `entries`, as recorded. */
function messagesOf(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

/** What the model was shown of `entries`, before any compaction: every message, raw. */
function seenIn(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries.flatMap((entry) => (entry.type === "compaction" ? [] : sessionEntryToContextMessages(entry).filter((message) => message.role !== "system")));
}

function userText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	return typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}

/**
 * Append a recorded entry to a replayed session, as pi appended it: the
 * messages and what changes the model or the thinking level. What only
 * annotates a session (labels, names, an extension's own state) is left out,
 * and so are recorded Pruning edits, whose targets a replayed session doesn't
 * share; a replay holds no recorded compaction past its first cut.
 */
function appendRecorded(session: SessionManager, entry: SessionEntry): void {
	if (entry.type === "message") session.appendMessage(entry.message as Parameters<SessionManager["appendMessage"]>[0]);
	else if (entry.type === "custom_message") session.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
	else if (entry.type === "model_change") session.appendModelChange(entry.provider, entry.modelId);
	else if (entry.type === "thinking_level_change") session.appendThinkingLevelChange(entry.thinkingLevel);
}

/** The two lanes of one session's replay. */
interface Lanes {
	ours: FakePi;
	pi: SessionManager;
}

/**
 * Replay the recorded entries in `[from, to)` into both lanes. In ours, a
 * user's message starts a prompt, as in pi, and each recorded turn is its
 * `turn_end`, with pressure under notice, its drafts committed as pi would.
 */
async function replay(lanes: Lanes, branch: readonly SessionEntry[], from: number, to: number): Promise<void> {
	for (let i = from; i < to; i++) {
		const entry = branch[i]!;
		appendRecorded(lanes.pi, entry);
		const message = entry.type === "message" ? entry.message : undefined;
		if (message?.role === "assistant") {
			const toolResults: ToolResultMessage[] = [];
			while (i + 1 < to) {
				const next = branch[i + 1]!;
				if (next.type !== "message" || next.message.role !== "toolResult") break;
				appendRecorded(lanes.pi, next);
				toolResults.push(next.message);
				i++;
			}
			lanes.ours.commit(await lanes.ours.turnEnd({ message, toolResults, tokens: 0 }));
			continue;
		}
		if (message?.role === "user") await lanes.ours.startRun();
		appendRecorded(lanes.ours.session, entry);
	}
}

/** Why the extension wrote no Handoff, as far as it said. */
function noHandoff(ours: FakePi, what: string): Error {
	const said = [...ours.notifications.filter((n) => n.type === "error").map((n) => n.message), ...ours.errors.map((e) => `${e.event}: ${e.error}`)];
	return new Error(`${what}${said.length ? `: ${said.at(-1)}` : ""}`);
}

/** A boundary's drafts, committed, and the compaction among them; an error if there is none. */
function compacted(ours: FakePi, drafts: Awaited<ReturnType<FakePi["turnEnd"]>>, what: string): void {
	ours.commit(drafts);
	if (!drafts.some((draft) => draft.type === "compaction")) throw noHandoff(ours, what);
}

/**
 * Ask the session's model what it does after the extension's steer at
 * warning, on a copy of our lane at the cut. Returns the steer as delivered
 * and the agent's reply cut to its `self_compact` call, if it made one with a
 * note: the calls beside it are never run in a replay, so they go.
 */
async function steered(lanes: Lanes, cut: PlannedCut, turn: ReturnType<typeof turnAt>, context: CutContext) {
	const header = lanes.ours.session.getHeader()!;
	const copy = fakePi(
		{ settings: context.settings, model: context.model, session: SessionManager.inMemory(header.cwd, undefined, [header, ...lanes.ours.session.getBranch()]), thinkingLevel: context.thinkingLevel },
		(api) => registerCompaction(api, { stream: () => { throw new Error("the replay's steer copy compacts nothing"); }, prunedDir: context.deps.prunedDir }),
	);
	await copy.turnEnd({ ...turn, tokens: context.levels.warning });
	const steer = copy.sent.find((message) => message.customType === STEER_TYPE && message.landed === "steer");
	if (!steer) throw new Error(`the extension sent no steer at warning (cut at entry ${cut.boundary.at})`);
	copy.session.appendCustomMessageEntry(steer.customType, steer.content as string, steer.display ?? false, steer.details);
	const events = await context.deps.stream("steered")(
		context.model,
		{ messages: convertToLlm(copy.session.buildSessionProjection().messages) as Message[] } as unknown as TranscriptContext,
		{ sessionId: header.id, ...(context.thinkingLevel !== "off" ? { reasoning: context.thinkingLevel } : {}) },
	);
	const reply = await events.result();
	if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(`the steered call failed: ${reply.errorMessage ?? reply.stopReason}`);
	const call = reply.content.find((part): part is ToolCall => part.type === "toolCall" && part.name === SELF_COMPACT_TOOL);
	const note = call?.arguments.note;
	const compacts = call && typeof note === "string" && note.trim() ? { ...reply, content: reply.content.filter((part) => part.type !== "toolCall" || part === call) } : undefined;
	return { steer, compacts };
}

/** What every cut of one session shares. */
interface CutContext {
	deps: ReplayDeps;
	settings: SettingsLike;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	levels: ReturnType<typeof resolveLevels>["levels"];
	keep: number;
	reserve: number;
	sessionId: string;
}

/** Our lane at a cut: the extension compacts, the way the cut's kind does. Returns whether a Self-compaction was declined. */
async function compactOurs(lanes: Lanes, cut: PlannedCut, turn: ReturnType<typeof turnAt>, context: CutContext): Promise<{ kind: CutKind; declined?: boolean }> {
	const { ours } = lanes;
	ours.model = context.model;
	if (cut.kind === "before-user") {
		ours.commit(await ours.turnEnd({ ...turn, tokens: 0 }));
		const done = await ours.compact({ reason: "manual" });
		if (!done?.entryId) throw noHandoff(ours, "/compact wrote no Handoff");
		return { kind: "before-user" };
	}
	if (cut.kind === "self") {
		const { steer, compacts } = await steered(lanes, cut, turn, context);
		if (compacts) {
			ours.commit(await ours.turnEnd({ ...turn, tokens: context.levels.warning }));
			ours.session.appendCustomMessageEntry(steer.customType, steer.content as string, steer.display ?? false, steer.details);
			compacted(ours, await ours.turnEnd({ message: compacts, tokens: context.levels.warning }), "Self-compaction wrote no Handoff");
			return { kind: "self" };
		}
		compacted(ours, await ours.turnEnd({ ...turn, tokens: context.levels.forced }), "forced compaction wrote no Handoff");
		return { kind: "forced", declined: true };
	}
	compacted(ours, await ours.turnEnd({ ...turn, tokens: context.levels.forced }), "forced compaction wrote no Handoff");
	return { kind: "forced" };
}

/** pi's lane at a cut: pi's own compaction, as `/compact` would run it with no extension loaded. */
async function compactPi(lanes: Lanes, branch: readonly SessionEntry[], cut: PlannedCut, context: CutContext): Promise<void> {
	for (let i = cut.boundary.at; i <= cut.boundary.end; i++) appendRecorded(lanes.pi, branch[i]!);
	const preparation = prepareCompaction(lanes.pi.getBranch(), { enabled: true, reserveTokens: context.reserve, keepRecentTokens: context.keep });
	if (!preparation) throw new Error("pi's compaction found nothing to compact");
	const done = await compact(
		preparation,
		context.model,
		undefined,
		undefined,
		undefined,
		undefined,
		context.thinkingLevel,
		context.deps.stream("pi-default"),
		undefined,
		retryPolicy(context.settings),
		undefined,
		context.sessionId,
	);
	lanes.pi.appendCompaction(done.summary, done.firstKeptEntryId, done.tokensBefore, done.details, false, done.usage);
}

/** One lane's Handoff at the cut just made, checked, and carried on from. */
async function laneCut(session: SessionManager, recording: Recording, cut: PlannedCut, next: PlannedCut | undefined, context: CutContext): Promise<LaneCut> {
	const branch = session.getBranch();
	const handoff = getLatestCompactionEntry(branch)!;
	const kept = branch.findIndex((entry) => entry.id === handoff.firstKeptEntryId);
	const removed = messagesOf(branch.slice(0, kept));
	const tail = seenIn(branch.slice(kept, branch.indexOf(handoff)));
	// What really happened next, up to the next cut: the details that come up again there are this Handoff's to carry.
	const after = seenIn(recording.branch.slice(cut.boundary.end + 1, next ? next.boundary.end + 1 : undefined));
	const continuation = await continueFrom(
		buildSessionProjection(branch).messages,
		futureAfter(recording.branch, cut.boundary.end),
		proposer(context.deps.stream("continuation"), context.model, { sessionId: context.sessionId, thinkingLevel: context.thinkingLevel }),
		recording.header.cwd,
	);
	return { handoff, fileState: fileStateDiff(handoff, removed), retention: recurringDetailRetention(handoff, { removed, tail, after }), continuation };
}

/** User turns after a cut the judge is shown, where the recording has them: more than a cut needs, so that a re-ask further on still shows. */
const JUDGED_USER_TURNS = 3;

/** The recording after the cut, up to and including its third user turn, or to its end. */
function futureFor(recording: Recording, end: number): AgentMessage[] {
	const future = seenIn(recording.branch.slice(end + 1));
	let users = 0;
	const upTo = future.findIndex((message) => message.role === "user" && ++users === JUDGED_USER_TURNS);
	return upTo < 0 ? future : future.slice(0, upTo + 1);
}

/** The judge's verdict on a cut, with the sides named again, or why there is none. */
async function judged(recording: Recording, cut: PlannedCut, ours: LaneCut, pi: LaneCut, deps: ReplayDeps): Promise<CutVerdict | { problem: string }> {
	const history = seenIn(recording.branch.slice(0, cut.boundary.end + 1));
	const oursIs = deps.oursSide();
	const piIs: Side = oursIs === "A" ? "B" : "A";
	const verdict = await judgeCut(deps.judge.stream, deps.judge.model, {
		userMessages: history.flatMap((message) => userText(message) ?? []),
		history,
		handoffs: { [oursIs]: ours.handoff.summary, [piIs]: pi.handoff.summary } as Record<Side, string>,
		continuations: { [oursIs]: ours.continuation, [piIs]: pi.continuation } as Record<Side, Continuation>,
		future: futureFor(recording, cut.boundary.end),
	});
	if ("problem" in verdict) return verdict;
	return {
		constraints: verdict.constraints.map((c) => ({ quote: c.quote, ours: c[oursIs], pi: c[piIs] })),
		ours: verdict[oursIs],
		pi: verdict[piIs],
		dropped: verdict.dropped,
	};
}

/** Replay one recorded session (see the module's comment). */
export async function replaySession(recording: Recording, name: string, deps: ReplayDeps): Promise<SessionResult> {
	const boundaries = boundariesOf(recording);
	const last = boundaries.at(-1)?.model;
	const sessionModel = last ? deps.findModel(last.provider, last.id) : undefined;
	if (!last) return { name, skipped: "it has no turn boundary to cut at", cuts: [] };
	if (!sessionModel) return { name, model: key(last), skipped: `its model ${key(last)} can't be reached`, cuts: [] };

	// The settings our lane runs on: pi's, with forced compaction on whatever they say, and pi's
	// compaction numbers resolved for this model, so that `/compact` keeps the tail ours does.
	const keep = piCompactionTokens(deps.settings, sessionModel, "keepRecentTokens");
	const reserve = piCompactionTokens(deps.settings, sessionModel, "reserveTokens");
	const compaction = (deps.settings.compaction ?? {}) as Record<string, unknown>;
	const settings = { ...deps.settings, compaction: { ...compaction, enabled: true, keepRecentTokens: keep, reserveTokens: reserve } };

	const plan = planCuts(boundaries, { kinds: deps.kinds, gap: keep });
	if (plan.length === 0) return { name, model: key(sessionModel), skipped: `it is too short for a chain of two cuts, ${keep} tokens apart, with ${USER_TURNS_AFTER === 1 ? "a user turn" : `${USER_TURNS_AFTER} user turns`} after the last`, cuts: [] };
	const unreachable = plan.map((cut) => cut.boundary.model).find((model) => !deps.findModel(model.provider, model.id));
	if (unreachable) return { name, model: key(unreachable), skipped: `its model ${key(unreachable)} can't be reached`, cuts: [] };

	const first = plan[0]!;
	const seed = [recording.header, ...recording.branch.slice(0, first.boundary.at)];
	const thinkingLevel = (buildSessionProjection(recording.branch.slice(0, first.boundary.at)).thinkingLevel || "off") as ThinkingLevel;
	const firstModel = deps.findModel(first.boundary.model.provider, first.boundary.model.id)!;
	const lanes: Lanes = {
		ours: fakePi({ settings, model: firstModel, session: SessionManager.inMemory(recording.header.cwd, undefined, seed), thinkingLevel }, (api) =>
			registerCompaction(api, { stream: deps.stream("writer"), prunedDir: deps.prunedDir }),
		),
		pi: SessionManager.inMemory(recording.header.cwd, undefined, seed),
	};
	await lanes.ours.startRun();

	const cuts: CutResult[] = [];
	let cursor = first.boundary.at;
	for (const [i, cut] of plan.entries()) {
		const result: CutResult = { depth: i + 1, kind: cut.kind, requested: cut.requested };
		cuts.push(result);
		const model = deps.findModel(cut.boundary.model.provider, cut.boundary.model.id)!;
		const context: CutContext = { deps, settings, model, thinkingLevel, levels: resolveLevels(settings, model).levels, keep, reserve, sessionId: recording.header.id };
		try {
			await replay(lanes, recording.branch, cursor, cut.boundary.at);
			const done = await compactOurs(lanes, cut, turnAt(recording.branch, cut.boundary), context);
			result.kind = done.kind;
			if (done.declined) result.declined = true;
			await compactPi(lanes, recording.branch, cut, context);
			result.ours = await laneCut(lanes.ours.session, recording, cut, plan[i + 1], context);
			result.pi = await laneCut(lanes.pi, recording, cut, plan[i + 1], context);
			const verdict = await judged(recording, cut, result.ours, result.pi, deps);
			if ("problem" in verdict) result.unjudged = verdict.problem;
			else result.verdict = verdict;
		} catch (error) {
			result.error = error instanceof Error ? error.message : String(error);
			break;
		}
		cursor = cut.boundary.end + 1;
	}

	const chain = (lane: "ours" | "pi") => cuts.flatMap((cut) => (cut[lane] ? [cut[lane]!.handoff] : []));
	return { name, model: key(sessionModel), cuts, collapse: { ours: collapseGuard(chain("ours")), pi: collapseGuard(chain("pi")) } };
}
