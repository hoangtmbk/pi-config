/**
 * compaction — Pressure levels, and what the agent and the user hear of them.
 *
 * At every `turn_end` the Context pressure pi reports is checked against three
 * Pressure levels: notice, warning and forced. The user sees nothing below
 * notice, then one quiet footer status; the agent gets one calm steer the first
 * time pressure crosses notice and again at warning. Before notice's steer, one
 * Pruning batch may win the room back without a compaction. Pi's own compaction
 * stays on underneath as the backstop (ADR-0005).
 *
 * At forced, the extension compacts at that same boundary, without ending the
 * run: the boundary path. Every compaction that reaches `session_before_compact`
 * — `/compact`, and pi's own threshold and overflow backstop — is the hook
 * path. Both get our Handoff instead of pi's summary (see `handoff.ts`).
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	getLatestCompactionEntry,
	type SessionBoundaryDraft,
	type SessionEntry,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { cutFor } from "./cut.ts";
import { type HandoffOutcome, handoffOf, writeHandoff } from "./handoff.ts";
import {
	Crossings,
	Forced,
	forcedEnabled,
	type Level,
	levelAt,
	type Levels,
	piCompactionTokens,
	resolveLevels,
	type SettingsLike,
} from "./pressure.ts";
import { checkPrunes, planPrunes, type Prune, pruneBatch, pruneDrafts, prunedDir, savePrunes } from "./pruning.ts";
import { formatStatus, STATUS_KEY, thousands } from "./status.ts";
import { piDefaultWriter, replyModel, retryPolicy, type StreamFn, type Writer } from "./writers.ts";

/** A clock and a timer: what the writers' stall timeout runs on. */
export interface Clock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/**
 * What a test swaps in for pi's real world. Every field is optional, and every
 * default is the real thing: the default export passes none of them.
 */
export interface CompactionOptions {
	/**
	 * The model call every writer makes — the forked call, serialized mode and
	 * pi's own summarizer alike. Defaults to the session's
	 * `ctx.modelRegistry.streamSimple`. Injected by tests, and by nothing else.
	 */
	stream?: ExtensionContext["modelRegistry"]["streamSimple"];
	/**
	 * The folder Pruning saves full copies into. Defaults to one beside the
	 * session file, or under the OS temp directory for a session with none (a
	 * Run). Injected by tests, and by nothing else.
	 */
	prunedDir?: string;
	/** Defaults to the system clock. Injected by tests, and by nothing else. */
	clock?: Clock;
}

/** The custom message type our steers go out as. */
export const STEER_TYPE = "compaction";

type SteeredLevel = Exclude<Level, "forced">;

/**
 * What the agent is told as pressure crosses notice and warning.
 *
 * Calm on purpose: no token counts, and nothing about running out or a limit,
 * because pressure that reads as a deadline makes a model cut corners. Forced
 * has no steer — by then compaction happens for the agent.
 */
const STEERS: Record<SteeredLevel, string> = {
	notice:
		"This is a good point to Self-compact at your next natural break, such as after finishing the current step. Finish what you are doing first. Don't shorten or skip work.",
	warning:
		"Self-compact at your next natural break, before you start a new subtask. If you don't, compaction will happen for you, possibly in the middle of a step.",
};

/**
 * The footer text for a reading, or `undefined` below notice.
 *
 * Forced reads as warning: forced is where compaction happens, and once it
 * does the status says so instead. Coloured only in the TUI. Anywhere else the
 * text is read rather than looked at — in a Run it travels to the parent, which
 * parses it — so it goes plain.
 */
function statusText(ctx: ExtensionContext, tokens: number, levels: Levels): string | undefined {
	const level = levelAt(tokens, levels);
	if (!level) return undefined;
	const text = formatStatus({ level: level === "notice" ? "notice" : "warning", tokens });
	if (ctx.mode !== "tui") return text;
	return ctx.ui.theme.fg(level === "notice" ? "muted" : "warning", text);
}

/** Whether a turn's assistant message called a tool — which is what keeps pi's loop going. */
function hasToolCalls(message: TurnEndEvent["message"]): boolean {
	return message.role === "assistant" && message.content.some((part) => part.type === "toolCall");
}

/** The toast that says pi's summarizer, the last writer, wrote the Handoff's judgment part. */
const PI_DEFAULT_TOAST = "Compaction used pi's default summary; the Handoff may be thinner.";

/** A compaction draft, as a boundary returns it. */
type CompactionDraft = Extract<SessionBoundaryDraft, { type: "compaction" }>;

export function registerCompaction(pi: ExtensionAPI, options: CompactionOptions = {}): void {
	const crossings = new Crossings();
	const forced = new Forced();
	/**
	 * The number of the compaction last drafted at a boundary, until the next
	 * boundary has seen whether pi committed it: the whole chain's drafts are
	 * dropped if any one of them is bad, ours included.
	 */
	let drafted: number | undefined;
	/** The footer text last set, so an unchanged one is not set again. */
	let shown: string | undefined;

	/**
	 * Tell the agent, once. Escape may clear it from pi's queue unread; it is not
	 * sent again, and the level stays crossed.
	 *
	 * A steer is taken at the next boundary — unless this boundary is the run's
	 * last, where a queued steer would keep the run going for one more turn just
	 * to answer it. There it waits for the next prompt instead: an agent that has
	 * stopped is already at its natural break.
	 */
	function steer(level: SteeredLevel, event: TurnEndEvent): void {
		pi.sendMessage(
			{ customType: STEER_TYPE, content: STEERS[level], display: false, details: { level } },
			{ deliverAs: hasToolCalls(event.message) ? "steer" : "nextTurn" },
		);
	}

	/** Configuration problems already told to the user: each is told once a session. */
	const warned = new Set<string>();

	/**
	 * The levels for the model in use, from pi's settings as they stand. Read
	 * afresh at each boundary, so a settings change or a model switch is what the
	 * next turn goes by. A bad setting is told once, never thrown.
	 */
	function levelsFor(ctx: ExtensionContext): Levels {
		const { levels, problems } = resolveLevels(pi.getSettings() as SettingsLike, ctx.model);
		for (const problem of problems) {
			if (warned.has(problem)) continue;
			warned.add(problem);
			ctx.ui.notify(problem, "warning");
		}
		return levels;
	}

	function show(ctx: ExtensionContext, text: string | undefined): void {
		if (text === shown) return;
		shown = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function paint(ctx: ExtensionContext, tokens: number, levels: Levels): void {
		show(ctx, statusText(ctx, tokens, levels));
	}

	/**
	 * The writers for one compaction, in chain order. Only pi's summarizer so
	 * far; serialized mode and the forked call go in front of it.
	 */
	function writers(ctx: ExtensionContext, branch: readonly SessionEntry[]): Writer[] {
		const stream: StreamFn = (model, context, streamOptions) =>
			(options.stream ?? ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry))(model, context, streamOptions);
		return [
			piDefaultWriter({
				model: replyModel(ctx, branch),
				thinkingLevel: ctx.thinkingLevel,
				sessionId: ctx.sessionManager.getSessionId(),
				stream,
				retry: retryPolicy(pi.getSettings()),
			}),
		];
	}

	/**
	 * The footer while a compaction writes: cleared, so that only pi's working
	 * row or compaction indicator says what is happening. In a Run, whose status
	 * its parent reads, it says `compacting` instead.
	 */
	function showCompacting(ctx: ExtensionContext): void {
		show(ctx, ctx.mode === "tui" ? undefined : formatStatus("compacting"));
	}

	/**
	 * What the user hears of a writer chain, on either path. Escape is silent.
	 * Every writer failing is an error, and disarms forced for the rest of the
	 * run, so that a chain that can't write isn't run again at every boundary;
	 * pi's own trigger stays as the backstop. Pi's summarizer having written
	 * the judgment part is a warning: that Handoff may be thinner. Returns
	 * whether there is a Handoff to compact with.
	 */
	function settle(ctx: ExtensionContext, outcome: HandoffOutcome): outcome is Extract<HandoffOutcome, { status: "written" }> {
		if (outcome.status === "aborted") return false;
		if (outcome.status === "failed") {
			ctx.ui.notify(`Compaction failed (${outcome.error}). Context will keep growing until the next run or pi's own compaction.`, "error");
			forced.disarm();
			return false;
		}
		if (outcome.details.writer === "pi-default") ctx.ui.notify(PI_DEFAULT_TOAST, "warning");
		return true;
	}

	/**
	 * `/compact` and pi's backstop: our Handoff in place of pi's summary.
	 *
	 * The cut is pi's own, so the tail kept is the same as pi's would be. The
	 * removed span is what pi prepared — including, on a cut inside a turn, that
	 * turn's start. Writers stop on the event's signal: `/compact` has already
	 * aborted the run, and Escape here aborts the compaction, not the run.
	 *
	 * While it writes, the footer status is cleared, so that only pi's own
	 * compaction indicator shows. Pi's indicator is not ours to relabel:
	 * `setWorkingMessage` reaches only pi's working row, which a compaction
	 * replaces, so it is left alone here rather than set for a row nobody sees.
	 * Nor is the kept tail pruned here: pi takes a compaction from this hook,
	 * and no drafts beside it (#43).
	 *
	 * A compaction comes back marked ours by its `details`. When every writer
	 * fails, or Escape stops them, it is cancelled rather than handed to pi's
	 * default: nothing is compacted. Only if our own code throws does pi's
	 * runner fall back to pi's whole default.
	 */
	pi.on("session_before_compact", async (event, ctx) => {
		const before = shown;
		showCompacting(ctx);
		let compacted = false;
		try {
			const outcome = await writeHandoff(
				{
					span: [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages],
					branch: event.branchEntries,
					focus: event.customInstructions,
					signal: event.signal,
				},
				writers(ctx, event.branchEntries),
			);
			if (!settle(ctx, outcome)) return { cancel: true };
			compacted = true;
			forced.compacted();
			return {
				compaction: {
					summary: outcome.summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: outcome.details,
					usage: outcome.usage,
				},
			};
		} finally {
			// After a compaction pi has no reading until the next response, and the
			// next `turn_end` paints the status again if pressure is still at notice
			// or above. A compaction that didn't happen changed nothing.
			show(ctx, compacted ? undefined : before);
		}
	});

	/**
	 * The notice batch: one per notice crossing, at the crossing boundary, and
	 * only if it frees enough to be worth the cache miss. Not when a compaction
	 * already lands here, which removes that span anyway.
	 */
	async function noticeBatch(event: TurnEndEvent, ctx: ExtensionContext) {
		if (event.entries.some((draft) => draft.type === "compaction")) return undefined;
		return pruneBatch(event.context.contextEntries, {
			scope: "notice",
			cwd: ctx.cwd,
			dir: options.prunedDir ?? prunedDir(ctx.sessionManager),
			session: ctx.sessionManager,
		});
	}

	/**
	 * The kept tail's Pruning at a compaction: superseded reads among the entries
	 * the compaction keeps, from `firstKeptEntryId` on, and nothing else of the
	 * tail. No minimum: right after a compaction the cache is cold anyway.
	 * Planned and checked over the context this boundary sees, so that a result
	 * an earlier extension edited here is left to it. Nothing is saved yet.
	 */
	function planKeptTail(event: TurnEndEvent, ctx: ExtensionContext, firstKeptEntryId: string, dir: string): Prune[] {
		const entries = event.context.contextEntries;
		const at = entries.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
		if (at < 0) return [];
		return checkPrunes(planPrunes(entries.slice(at), { scope: "kept-tail", cwd: ctx.cwd, dir }), ctx.sessionManager);
	}

	/**
	 * A compaction at this boundary, drafted: our Handoff over pi's cut, then the
	 * kept tail's Pruning, with `trigger` saying why on pi's working row.
	 * `undefined` when it didn't come to one — nothing to remove, every writer
	 * failed, or Escape.
	 *
	 * The drafts go out compaction first, so that pi measures `tokensBefore` on
	 * the context before any of them, then edits on kept-tail entries only: one
	 * in the removed span would do nothing. Pruned copies are saved only once
	 * there is a compaction for them to go out with.
	 *
	 * The run goes on streaming through it, so pi's working row is up, and says
	 * what is happening until the chain is done. Writers stop on the run's own
	 * signal: Escape here stops the run, and the compaction with it.
	 */
	async function compactAtBoundary(event: TurnEndEvent, ctx: ExtensionContext, trigger: string): Promise<SessionBoundaryDraft[] | undefined> {
		const keep = piCompactionTokens(pi.getSettings() as SettingsLike, ctx.model, "keepRecentTokens");
		const cut = cutFor(ctx.sessionManager.buildSessionProjection(), keep);
		if (!cut) return undefined;
		const branch = ctx.sessionManager.getBranch();
		const dir = options.prunedDir ?? prunedDir(ctx.sessionManager);
		showCompacting(ctx);
		try {
			ctx.ui.setWorkingMessage(`${trigger} · pruning old tool output…`);
			const prunes = planKeptTail(event, ctx, cut.firstKeptEntryId, dir);
			ctx.ui.setWorkingMessage(`${trigger} · writing Handoff…`);
			const outcome = await writeHandoff({ span: cut.span, branch, signal: ctx.signal }, writers(ctx, branch));
			if (!settle(ctx, outcome)) return undefined;
			drafted = outcome.details.compactionNo;
			const compaction: CompactionDraft = {
				type: "compaction",
				summary: outcome.summary,
				firstKeptEntryId: cut.firstKeptEntryId,
				details: outcome.details,
				usage: outcome.usage,
			};
			return [compaction, ...pruneDrafts(prunes.length > 0 ? await savePrunes(prunes, dir) : [])];
		} finally {
			// pi's own text again, rather than ours lingering into the next working row.
			ctx.ui.setWorkingMessage();
		}
	}

	/** Whether the compaction drafted at the last boundary landed: the newest on the branch, and ours. */
	function checkLanded(ctx: ExtensionContext): void {
		if (drafted === undefined) return;
		const latest = handoffOf(getLatestCompactionEntry(ctx.sessionManager.getBranch())?.details);
		if (latest?.compactionNo === drafted) forced.compacted();
		drafted = undefined;
	}

	pi.on("agent_start", () => {
		forced.rearm();
	});

	pi.on("turn_end", async (event, ctx) => {
		checkLanded(ctx);
		// A turn that was aborted or failed is not one to act on. The outcome alone
		// misses half of an Escape: one that lands while tools run ends that turn
		// as "completed", since the model had finished streaming, and only the
		// turn after it comes back "aborted". The run's signal says it for both.
		if (event.outcome !== "completed" || ctx.signal?.aborted) return;
		// No reading — no model, or a compaction not yet answered — is no action.
		const tokens = ctx.getContextUsage()?.tokens;
		if (tokens === null || tokens === undefined) return;
		// A level already past after a model switch is simply crossed now, and
		// only the highest of those acts.
		const levels = levelsFor(ctx);
		const enabled = forcedEnabled(pi.getSettings() as SettingsLike);
		const { forces, leftHigh } = forced.observe(tokens, levels, enabled);
		if (leftHigh) {
			ctx.ui.notify(`Compaction left context at ${thousands(tokens)}, still above warning. Forced compaction is paused until it drops.`, "warning");
		}
		// Forced is decided on its own, above; the crossings are notice's and
		// warning's. When forced acts their steers are moot, but they still count
		// as crossed, so that neither speaks up later.
		const steered = { ...levels, forced: Number.POSITIVE_INFINITY };
		let acts = crossings.observe(tokens, steered);
		if (forces) {
			// Not on top of a compaction an earlier extension drafted here.
			const drafts = event.entries.some((entry) => entry.type === "compaction")
				? undefined
				: await compactAtBoundary(event, ctx, `Compacting at ${thousands(tokens)} (forced)`);
			if (!drafts) {
				paint(ctx, tokens, levels);
				return;
			}
			// pi has no reading after a compaction until the next response, and the
			// next boundary paints the status again if pressure is still at notice
			// or above. Ours go after the drafts before them, so that they stand,
			// and pi measures `tokensBefore` with them applied. No notice batch
			// here: the compaction removes what it would prune.
			show(ctx, undefined);
			return { entries: [...event.entries, ...drafts] };
		}
		// Pruning first, so that the agent is steered to Self-compact only once
		// Pruning can no longer free enough. What the batch frees is judged on the
		// last measured usage, not on pi's chars/4 count of the edited context,
		// which runs high until the next response. Pressure that falls back under
		// notice re-arms it and sends no steer.
		const batch = acts === "notice" ? await noticeBatch(event, ctx) : undefined;
		const reading = tokens - (batch?.freed ?? 0);
		if (batch) {
			crossings.observe(reading, steered);
			if (reading < levels.notice) acts = undefined;
		}
		if (acts === "notice" || acts === "warning") steer(acts, event);
		// The one toast on the way up, so that forced never comes as a surprise —
		// or, with `compaction.enabled: false`, so that nobody expects it.
		if (acts === "warning") {
			const then = enabled ? `; forced at ${thousands(levels.forced)}` : "";
			ctx.ui.notify(`Context at ${thousands(tokens)} (warning). The agent has been told it's a good time to compact${then}.`, "warning");
		}
		paint(ctx, reading, levels);
		if (batch) return { entries: [...event.entries, ...batch.drafts] };
	});
}

export default function (pi: ExtensionAPI) {
	registerCompaction(pi);
}
