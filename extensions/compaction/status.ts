/**
 * The status codec: the one line of footer text a session shows about its
 * Context pressure, and the reading of it back.
 *
 * It is exported because a Run has no footer of its own: a child's `setStatus`
 * travels to its parent as an RPC `extension_ui_request`, and the parent's
 * subagents extension reads it with `parseStatus`. One codec on both sides is
 * what keeps the two from drifting.
 *
 * There is no `forced` status. Forced is where compaction happens, and while it
 * does the status reads `compacting`.
 */

/** The Pressure levels a status can name. */
export type StatusLevel = "notice" | "warning";

/** What the footer says: a level and the live count, or that a compaction is under way. */
export type PressureStatus = { level: StatusLevel; tokens: number } | "compacting";

/** The key the status is set under. pi sorts the footer's extension statuses by it. */
export const STATUS_KEY = "compaction";

/** `152_400` → `152k`. Lowercase, everywhere: the footer and the toasts say counts the same way. */
export function thousands(tokens: number): string {
	return `${Math.round(tokens / 1000)}k`;
}

/** `ctx notice · 124k`, `ctx warning · 152k` or `ctx compacting`. Plain text: colour is the caller's. */
export function formatStatus(status: PressureStatus): string {
	return status === "compacting" ? "ctx compacting" : `ctx ${status.level} · ${thousands(status.tokens)}`;
}

/** Terminal colour, which a child in RPC mode would send along with the text. */
const SGR = /\x1b\[[0-9;]*m/g;

const STATUS = /^ctx (?:(notice|warning) · (\d+)k|(compacting))$/;

/**
 * The status a footer text says, or `undefined` for a cleared status or text
 * that isn't one of ours. The count comes back in whole thousands, which is
 * all the text carries.
 */
export function parseStatus(text: string | undefined): PressureStatus | undefined {
	const match = text?.replace(SGR, "").trim().match(STATUS);
	if (!match) return undefined;
	if (match[3]) return "compacting";
	return { level: match[1] as StatusLevel, tokens: Number(match[2]) * 1000 };
}
