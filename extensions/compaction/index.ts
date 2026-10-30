/**
 * compaction — Pressure levels, and what the agent and the user hear of them.
 *
 * At every `turn_end` the Context pressure pi reports is checked against three
 * Pressure levels: notice, warning and forced. The user sees nothing below
 * notice, then one quiet footer status; the agent gets one calm steer the first
 * time pressure crosses notice and again at warning. Pi's own compaction stays
 * on underneath as the backstop (ADR-0005).
 */

import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { Crossings, DEFAULT_LEVELS, type Level, levelAt, type Levels } from "./pressure.ts";
import { formatStatus, STATUS_KEY, thousands } from "./status.ts";

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

export function registerCompaction(pi: ExtensionAPI, _options: CompactionOptions = {}): void {
	const levels = DEFAULT_LEVELS;
	const crossings = new Crossings();
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

	function paint(ctx: ExtensionContext, tokens: number): void {
		const text = statusText(ctx, tokens, levels);
		if (text === shown) return;
		shown = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	pi.on("turn_end", (event, ctx) => {
		// A turn that was aborted or failed is not one to act on. The outcome alone
		// misses half of an Escape: one that lands while tools run ends that turn
		// as "completed", since the model had finished streaming, and only the
		// turn after it comes back "aborted". The run's signal says it for both.
		if (event.outcome !== "completed" || ctx.signal?.aborted) return;
		// No reading — no model, or a compaction not yet answered — is no action.
		const tokens = ctx.getContextUsage()?.tokens;
		if (tokens === null || tokens === undefined) return;
		const acts = crossings.observe(tokens, levels);
		if (acts === "notice" || acts === "warning") steer(acts, event);
		// The one toast on the way up, so that forced never comes as a surprise.
		if (acts === "warning") {
			ctx.ui.notify(
				`Context at ${thousands(tokens)} (warning). The agent has been told it's a good time to compact; forced at ${thousands(levels.forced)}.`,
				"warning",
			);
		}
		paint(ctx, tokens);
	});
}

export default function (pi: ExtensionAPI) {
	registerCompaction(pi);
}
