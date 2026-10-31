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
 * run: the boundary path. Self-compaction, the `self_compact` tool, takes the
 * same path at a break of the agent's choosing. Every compaction that reaches
 * `session_before_compact` — `/compact`, and pi's own threshold and overflow
 * backstop — is the hook path. Both get our Handoff instead of pi's summary (see `handoff.ts`).
 */

import type { Message } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type ProjectedSessionEntry,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writerChain } from "./chain.ts";
import { cutFor, keptFrom, seenIn } from "./cut.ts";
import { type HandoffOutcome, writeHandoff } from "./handoff.ts";
import { type Compacting, GIVE_UP, type GiveUp, Landing, type OurDraft } from "./landing.ts";
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
import { SELF_COMPACT_TOOL } from "./tools.ts";
import type { Clock } from "./writers.ts";

export type { Clock } from "./writers.ts";

/**
 * What a test, or the replay check, swaps in for pi's real world. Every field
 * is optional, and every default is the real thing: the default export, which
 * is what pi loads, passes none of them.
 */
export interface CompactionOptions {
	/**
	 * The model call every writer makes — the forked call, serialized mode and
	 * pi's own summarizer alike. Defaults to the session's
	 * `ctx.modelRegistry.streamSimple`. Injected by tests, with a scripted
	 * model, and by the replay check, which meters what each call spends.
	 */
	stream?: ExtensionContext["modelRegistry"]["streamSimple"];
	/**
	 * The folder Pruning saves full copies into. Defaults to one beside the
	 * session file, or under the OS temp directory for a session with none (a
	 * Run). Injected by tests, and by the replay check, which keeps its
	 * replayed sessions' copies in a temp folder of its own.
	 */
	prunedDir?: string;
	/** Defaults to the system clock. Injected by tests, and by nothing else. */
	clock?: Clock;
}

export { SELF_COMPACT_TOOL } from "./tools.ts";

const SelfCompactParams = Type.Object({
	note: Type.String({ description: "What you're doing and what you'll do next, in your own words." }),
});

/**
 * What `self_compact` says back: one plain line, true to what happened, with
 * no token counts — the agent is meant to simply carry on.
 */
const SELF_COMPACT = {
	compacted: "Context compacted. The Handoff above carries the task; continue from its Next step.",
	failed: "Compaction failed; carry on with the task.",
	refused: "Not compacted: the context isn't large enough yet for a compaction to help. Carry on with the task; you'll be told when it's a good time.",
};

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

/** The Context pressure pi reports, or `undefined` for no reading: no model, or a compaction not yet answered. */
function pressureOf(ctx: ExtensionContext): number | undefined {
	return ctx.getContextUsage()?.tokens ?? undefined;
}

/** Why a compaction at a boundary is happening: forced, at a reading, or the agent's own. */
type Trigger = { forcedAt: number } | "self";

/** A trigger as pi's working row opens with it. */
function triggerText(trigger: Trigger): string {
	return trigger === "self" ? "Self-compacting" : `Compacting at ${thousands(trigger.forcedAt)} (forced)`;
}

/** Why a compaction didn't happen: the last writer's error, or why one that couldn't land was given up. */
type Failure = { lastError: string } | GiveUp;

/** The toast that says pi's summarizer, the last writer, wrote the Handoff's judgment part. */
const PI_DEFAULT_TOAST = "Compaction used pi's default summary; the Handoff may be thinner.";

/** A tool result of one plain line. */
function line(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

export function registerCompaction(pi: ExtensionAPI, options: CompactionOptions = {}): void {
	const crossings = new Crossings();
	const forced = new Forced();
	/** Our compactions on the boundary path, from written to committed. */
	const landing = new Landing();
	/** The footer text last set, so an unchanged one is not set again. */
	let shown: string | undefined;
	/** pi's merged settings as they stand, read afresh wherever they are needed. */
	const settings = () => pi.getSettings() as SettingsLike;
	/** Where this session's pruned copies go. */
	const prunedDirOf = (ctx: ExtensionContext) => options.prunedDir ?? prunedDir(ctx.sessionManager);

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
		const { levels, problems } = resolveLevels(settings(), ctx.model);
		for (const problem of problems) {
			if (warned.has(problem)) continue;
			warned.add(problem);
			ctx.ui.notify(problem, "warning");
		}
		return levels;
	}

	/** Set the footer to `text` exactly, or clear it — only when that changes it. */
	function setFooter(ctx: ExtensionContext, text: string | undefined): void {
		if (text === shown) return;
		shown = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	/** The footer for a reading: the level it is at, or nothing below notice. */
	function showPressure(ctx: ExtensionContext, tokens: number, levels: Levels): void {
		setFooter(ctx, statusText(ctx, tokens, levels));
	}

	/** What a compaction from the hook keeps after the Handoff: the branch from pi's cut on, as the model sees it. */
	function keptTail(event: SessionBeforeCompactEvent) {
		return seenIn(keptFrom(buildSessionProjection(event.branchEntries).entries, event.preparation.firstKeptEntryId) ?? []);
	}

	/**
	 * The footer while a compaction writes: cleared, so that only pi's working
	 * row or compaction indicator says what is happening. In a Run, whose status
	 * its parent reads, it says `compacting` instead.
	 */
	function showCompacting(ctx: ExtensionContext): void {
		setFooter(ctx, ctx.mode === "tui" ? undefined : formatStatus("compacting"));
	}

	/**
	 * Every writer failing, or what stands for it: nothing is compacted, the
	 * user is told why, and forced is disarmed for the rest of the prompt.
	 */
	function giveUp(ctx: ExtensionContext, failure: Failure): void {
		const why = typeof failure === "string" ? GIVE_UP[failure] : failure.lastError;
		ctx.ui.notify(`Compaction failed (${why}). Context will keep growing until your next message or pi's own compaction.`, "error");
		forced.disarm();
	}

	/**
	 * What the user hears of a writer chain, on either path. Escape is silent.
	 * Every writer failing is an error, and disarms forced for the rest of the
	 * prompt, so that a chain that can't write isn't run again at every boundary;
	 * pi's own trigger stays as the backstop. Pi's summarizer having written
	 * the judgment part is a warning: that Handoff may be thinner. Returns
	 * whether there is a Handoff to compact with.
	 */
	function settle(ctx: ExtensionContext, outcome: HandoffOutcome): outcome is Extract<HandoffOutcome, { status: "written" }> {
		if (outcome.status === "aborted") return false;
		if (outcome.status === "failed") {
			giveUp(ctx, { lastError: outcome.error });
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
	 * The forked call sends the branch as the model sees it, which is what the
	 * next request would send — except on overflow, where that is exactly what
	 * didn't fit, and the chain starts at serialized mode.
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
					tail: keptTail(event),
					branch: event.branchEntries,
					focus: event.customInstructions,
					signal: event.signal,
				},
				writerChain(
					ctx,
					settings(),
					event.branchEntries,
					event.reason === "overflow" ? undefined : convertToLlm(buildSessionProjection(event.branchEntries).messages),
					options,
				),
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
			setFooter(ctx, compacted ? undefined : before);
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
			dir: prunedDirOf(ctx),
			session: ctx.sessionManager,
		});
	}

	/**
	 * The kept tail's Pruning at a compaction: superseded reads among the entries
	 * the compaction keeps, from `firstKeptEntryId` on, and nothing else of the
	 * tail. No minimum: right after a compaction the cache is cold anyway.
	 * Planned and checked over `entries`, the context as the compaction sees it
	 * — at a boundary, the one it previews, so that a result an earlier
	 * extension edited here is left to it. Nothing is saved yet.
	 */
	function planKeptTail(entries: readonly ProjectedSessionEntry[], ctx: ExtensionContext, firstKeptEntryId: string, dir: string): Prune[] {
		const kept = keptFrom(entries, firstKeptEntryId);
		if (!kept) return [];
		return checkPrunes(planPrunes(kept, { scope: "kept-tail", cwd: ctx.cwd, dir }), ctx.sessionManager);
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
	 * signal — or the signal pi hands `self_compact`, which is the run's: Escape
	 * here stops the run, and the compaction with it.
	 *
	 * `transcript` is what the forked call sends: the live context, as the
	 * next request would. At a boundary that is the context pi previews there.
	 *
	 * Self-compaction drafts it from inside its tool call, before the boundary:
	 * the branch then ends at the assistant message making the call, which the
	 * kept tail ends in; the context it plans Pruning over and the transcript
	 * are the session's own projection, since there is no boundary preview yet
	 * — the previous request plus the call; and the agent's `note`, with the
	 * signal pi handed the tool, comes as `asked`.
	 */
	async function compactAtBoundary(
		context: readonly ProjectedSessionEntry[],
		transcript: readonly Message[],
		ctx: ExtensionContext,
		trigger: Trigger,
		asked: { note: string; signal: AbortSignal | undefined } | undefined = undefined,
	): Promise<Compacting | undefined> {
		const keep = piCompactionTokens(settings(), ctx.model, "keepRecentTokens");
		const cut = cutFor(ctx.sessionManager.buildSessionProjection(), keep);
		if (!cut) return undefined;
		const branch = ctx.sessionManager.getBranch();
		const dir = prunedDirOf(ctx);
		const before = shown;
		let compacting: Compacting | undefined;
		showCompacting(ctx);
		try {
			ctx.ui.setWorkingMessage(`${triggerText(trigger)} · pruning old tool output…`);
			const prunes = planKeptTail(context, ctx, cut.firstKeptEntryId, dir);
			ctx.ui.setWorkingMessage(`${triggerText(trigger)} · writing Handoff…`);
			const request = { span: cut.span, tail: cut.tail, branch, note: asked?.note, signal: asked ? asked.signal : ctx.signal };
			const outcome = await writeHandoff(request, writerChain(ctx, settings(), branch, transcript, options));
			if (!settle(ctx, outcome)) return undefined;
			const draft: OurDraft = {
				type: "compaction",
				summary: outcome.summary,
				firstKeptEntryId: cut.firstKeptEntryId,
				details: outcome.details,
				usage: outcome.usage,
			};
			compacting = { draft, prunes: prunes.length > 0 ? await savePrunes(prunes, dir) : [] };
			return compacting;
		} finally {
			// pi's own text again, rather than ours lingering into the next working row.
			ctx.ui.setWorkingMessage();
			// A compaction that didn't happen changed nothing: the status goes back
			// to what it was, even where no boundary follows to paint it — a
			// Self-compaction that Escape stopped ends on an aborted turn.
			if (!compacting) setFooter(ctx, before);
		}
	}

	/**
	 * Self-compaction: the agent compacts at a natural break, and carries on in
	 * the same run. Always declared, so the tool list never changes and the
	 * prompt cache holds; below notice it refuses, since a compaction there
	 * gains little.
	 *
	 * A tool can't append to the session, so `execute` runs the writer chain
	 * itself and keeps the compaction for this turn's `turn_end`, which pi fires
	 * once every tool of the turn has finished. The result line says what really
	 * happened. Escape mid-write is a failure, as is every writer failing, and
	 * forced compaction tries again: after Escape at the next boundary at forced,
	 * after every writer failing (which disarms it, as on any path) from the
	 * next prompt.
	 */
	pi.registerTool({
		name: SELF_COMPACT_TOOL,
		label: "Self-compact",
		description: [
			"Compact your context at a natural break in your work, such as after finishing a step or before starting a new subtask, and carry on straight after in the same run.",
			"The older part of the conversation is replaced by a Handoff: the goal, progress, decisions, the user's own words and rules, the files touched, and a Next step that opens with your note, word for word. The newest messages stay as they are.",
			"Use it when you are told it's a good time. Finish what you are doing first, and don't shorten or skip work to get there.",
		].join(" "),
		promptSnippet: "Compact your context at a natural break in your work, then carry on",
		parameters: SelfCompactParams,

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const note = params.note.trim();
			if (!note) throw new Error("A note cannot be empty. Say what you're doing and what you'll do next.");
			const tokens = pressureOf(ctx);
			if (tokens === undefined || tokens < levelsFor(ctx).notice) return line(SELF_COMPACT.refused);
			const projection = ctx.sessionManager.buildSessionProjection();
			const compacting = await compactAtBoundary(projection.entries, convertToLlm(projection.messages), ctx, "self", { note, signal });
			if (!compacting) return line(SELF_COMPACT.failed);
			landing.prepare(compacting, toolCallId);
			return line(SELF_COMPACT.compacted);
		},
	});

	pi.on("agent_start", () => {
		forced.rearm();
		landing.newRun();
	});

	pi.on("turn_end", async (event, ctx) => {
		// The warning-pause guard hears of a compaction of ours that landed.
		if (landing.settle(ctx.sessionManager)) forced.compacted();
		const selfCompaction = landing.takePrepared(event, ctx.sessionManager);
		// A turn that was aborted or failed is not one to act on — not even to
		// draft again a forced compaction that sank, which is let go, silently,
		// as Escape lets go of one being written. The outcome alone misses half
		// of an Escape: one that lands while tools run ends that turn as
		// "completed", since the model had finished streaming, and only the turn
		// after it comes back "aborted". The run's signal says it for both. A
		// Self-compaction already written still lands, though: the agent has been
		// told it did, and a sibling call cut short doesn't make that untrue. On
		// a turn that didn't complete at all, it is held for the next that does.
		// No reading — no model, or a compaction not yet answered — is no action
		// either.
		const tokens = pressureOf(ctx);
		if (event.outcome !== "completed" || (ctx.signal?.aborted && !selfCompaction) || tokens === undefined) {
			if (selfCompaction) {
				landing.hold(selfCompaction, ctx.sessionManager);
				// Not `compacting` until it is drafted: the next boundary paints the status.
				setFooter(ctx, undefined);
			}
			landing.pass();
			return;
		}
		// A level already past after a model switch is simply crossed now, and
		// only the highest of those acts.
		const levels = levelsFor(ctx);
		const enabled = forcedEnabled(settings());
		// Ours never go on top of a compaction an earlier extension drafted here.
		// A Self-compaction is held for the next boundary, which can see whether
		// theirs landed.
		const theirs = event.entries.some((entry) => entry.type === "compaction");
		if (theirs) {
			if (selfCompaction) landing.hold(selfCompaction, ctx.sessionManager);
			landing.pass();
		}
		// A Self-compaction written during this turn is this boundary's
		// compaction, whatever pressure reads now, and newer than any held.
		// Otherwise a compaction held is, and given up, it disarms forced from
		// this boundary on.
		const held = selfCompaction || theirs ? undefined : landing.redraft(ctx.sessionManager);
		if (typeof held === "string") giveUp(ctx, held);
		const heldCompaction = typeof held === "string" ? undefined : held;
		const { forces, leftHigh } = forced.observe(tokens, levels, enabled);
		if (leftHigh) {
			ctx.ui.notify(`Compaction left context at ${thousands(tokens)}, still above warning. Forced compaction is paused until it drops.`, "warning");
		}
		// Forced is decided on its own, above; the crossings are notice's and
		// warning's. When a compaction lands here their steers are moot, but they
		// still count as crossed, so that neither speaks up later.
		const steered = { ...levels, forced: Number.POSITIVE_INFINITY };
		let crossed = crossings.observe(tokens, steered);
		if (selfCompaction || heldCompaction || forces) {
			const compacting = theirs
				? undefined
				: (selfCompaction ??
						heldCompaction ??
						(await compactAtBoundary(event.context.contextEntries, event.context.llmMessages, ctx, { forcedAt: tokens })));
			if (!compacting) {
				showPressure(ctx, tokens, levels);
				return;
			}
			// pi has no reading after a compaction until the next response, and the
			// next boundary paints the status again if pressure is still at notice
			// or above. Ours go after the drafts before them, so that they stand,
			// and pi measures `tokensBefore` with them applied. No notice batch
			// here: the compaction removes what it would prune.
			setFooter(ctx, undefined);
			const { draft, prunes } = compacting;
			landing.drafting(compacting, ctx.sessionManager, compacting === selfCompaction);
			return { entries: [...event.entries, draft, ...pruneDrafts(prunes)] };
		}
		// Pruning first, so that the agent is steered to Self-compact only once
		// Pruning can no longer free enough. What the batch frees is judged on the
		// last measured usage, not on pi's chars/4 count of the edited context,
		// which runs high until the next response. Pressure that falls back under
		// notice re-arms it and sends no steer.
		const batch = crossed === "notice" ? await noticeBatch(event, ctx) : undefined;
		const reading = tokens - (batch?.freed ?? 0);
		if (batch) {
			crossings.observe(reading, steered);
			if (reading < levels.notice) crossed = undefined;
		}
		if (crossed === "notice" || crossed === "warning") steer(crossed, event);
		// The one toast on the way up, so that forced never comes as a surprise —
		// or, with `compaction.enabled: false`, so that nobody expects it.
		if (crossed === "warning") {
			const then = enabled ? `; forced at ${thousands(levels.forced)}` : "";
			ctx.ui.notify(`Context at ${thousands(tokens)} (warning). The agent has been told it's a good time to compact${then}.`, "warning");
		}
		showPressure(ctx, reading, levels);
		if (batch) return { entries: [...event.entries, ...batch.drafts] };
	});
}

export default function (pi: ExtensionAPI) {
	registerCompaction(pi);
}
