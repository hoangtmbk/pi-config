/**
 * Pruning: shrinking context without summarizing it.
 *
 * Turns a branch's projected entries into a batch of checked `context_edit`
 * drafts. Only tool results are touched, and only by replacing their content —
 * never omitted, because pi-ai answers a missing result with a synthetic
 * failure. What a result is replaced with is a one-line marker pointing at a
 * saved copy of the full output, which the agent can open with plain `read`.
 *
 * Two batches use it, and they differ only in what they may pick: the notice
 * batch takes old bulk output and superseded reads, the kept tail at a
 * compaction superseded reads only. When either runs is the caller's business;
 * this module plans, checks and saves.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type ContextEditEntryDraft,
	estimateTokens,
	type ExtensionContext,
	type ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

/** The session as an extension sees it: read-only. */
type Session = ExtensionContext["sessionManager"];

/** The least a notice batch must free to be worth the cache miss it costs. */
export const MIN_BATCH_TOKENS = 20_000;
/** The newest tool output, in tokens, that old-bulk Pruning never reaches into. */
const PROTECTED_TOKENS = 40_000;
/** A result this size or smaller is never old bulk: the marker would save next to nothing. */
const PRUNABLE_FLOOR_TOKENS = 1_000;
/** A `bash` result keeps its last lines after the marker, where the exit status and errors usually are… */
const KEPT_BASH_LINES = 10;
/** …but no more than this many characters of them, so that a few huge lines don't defeat the point. */
const KEPT_BASH_CHARS = 2_000;
/** The longest a command or argument gets in a marker. */
const LABEL_CHARS = 80;

/**
 * Results that are never pruned, whatever their size or age: a Question's
 * answer is the user's words, a Run's result can't be fetched again and is
 * costly to regenerate, and `self_compact`'s line is what the agent carries on
 * from. Names only, so as not to tie this extension to the subagents one.
 */
const NEVER_PRUNED = new Set(["ask_question", "subagent", "subagent_wait", "subagent_answer", "self_compact"]);

/** Which results a batch may pick. */
export type PruneScope = "notice" | "kept-tail";

/** One result to prune, and what it becomes. */
export interface Prune {
	/** The session entry holding the result: the `context_edit`'s target. */
	targetId: string;
	/** The tool call this result answers. A failing edit is dropped together with every edit on its pair. */
	toolCallId: string;
	/** The result's full text, as saved. */
	text: string;
	/** Where the full text is saved, and what the marker points at. */
	path: string;
	/** The marker, plus a `bash` result's last lines. */
	replacement: string;
	/** Tokens the replacement frees, by pi's own chars/4 estimate. */
	freed: number;
}

/** A batch ready to return from `turn_end`: checked drafts, and what they free. */
export interface Batch {
	drafts: ContextEditEntryDraft[];
	freed: number;
}

/**
 * Where a session's pruned copies go: beside its session file, or, for a
 * session with none (a `--no-session` Run), under the OS temp directory. In
 * both, a folder named for the session; nothing of ours ever cleans it up.
 */
export function prunedDir(session: Session): string {
	const name = `${session.getSessionId()}.pruned`;
	return session.getSessionFile() === undefined ? join(tmpdir(), name) : join(session.getSessionDir(), name);
}

/** A tool result as it stands in the context, with the call it answers. */
interface Seen {
	entryId: string;
	result: ToolResultMessage;
	call: ToolCall | undefined;
	tokens: number;
	/** The position of its entry, so later results can be told from earlier ones. */
	at: number;
}

/** Every tool result in the projected context, oldest first, paired with its call. */
function toolResults(entries: ProjectedSessionEntry[]): Seen[] {
	const calls = new Map<string, ToolCall>();
	const seen: Seen[] = [];
	entries.forEach(({ sourceEntry, messages }, at) => {
		for (const message of messages) {
			if (message.role === "assistant") {
				for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, part);
			} else if (message.role === "toolResult") {
				seen.push({ entryId: sourceEntry.id, result: message, call: calls.get(message.toolCallId), tokens: estimateTokens(message), at });
			}
		}
	});
	return seen;
}

/**
 * The result's text, if it is text and nothing else, and has not been edited
 * since pi recorded it. An image can't be saved as a `.txt` copy, and an edited
 * result is one some batch — ours or another extension's — has already dealt
 * with.
 */
function plainText({ entryId, result }: Seen, entries: ProjectedSessionEntry[]): string | undefined {
	if (!result.content.every((part): part is TextContent => part.type === "text")) return undefined;
	const source = entries.find((e) => e.sourceEntry.id === entryId)?.sourceEntry;
	if (source?.type !== "message" || source.message.role !== "toolResult") return undefined;
	if (JSON.stringify(source.message.content) !== JSON.stringify(result.content)) return undefined;
	return result.content.map((part) => part.text).join("\n");
}

/** A path argument as the tools resolve it: `@` dropped, `~` expanded, relative to the working directory. */
function filePath(path: unknown, cwd: string): string | undefined {
	if (typeof path !== "string" || path.trim() === "") return undefined;
	let p = path.trim().replace(/^@/, "");
	if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
	return resolve(cwd, p);
}

/** What a `read` covered: its file and its range. */
function readKey(call: ToolCall | undefined, cwd: string): string | undefined {
	if (call?.name !== "read") return undefined;
	const path = filePath(call.arguments.path, cwd);
	if (!path) return undefined;
	const { offset, limit } = call.arguments;
	return `${path}\0${typeof offset === "number" ? offset : 1}\0${typeof limit === "number" ? limit : ""}`;
}

/**
 * Whether a later result makes this `read` stale: a later `read` of the same
 * file and range, or a `write` of the whole file. An `edit` does not — most of
 * the old read stays true, and the agent builds its next edit from it. A
 * later call that failed changed nothing, so it supersedes nothing.
 */
function superseded(read: Seen, all: Seen[], cwd: string): boolean {
	const key = readKey(read.call, cwd);
	if (!key) return false;
	const path = filePath(read.call?.arguments.path, cwd);
	return all.some(
		(later) =>
			later.at > read.at &&
			!later.result.isError &&
			(readKey(later.call, cwd) === key || (later.call?.name === "write" && filePath(later.call.arguments.path, cwd) === path)),
	);
}

/** `npm test` for `bash`, `read src/a.ts` for the rest: the tool and its first string argument, on one line. */
function label(name: string, call: ToolCall | undefined): string {
	const args = call?.arguments ?? {};
	const subject = name === "bash" ? args.command : Object.values(args).find((v) => typeof v === "string");
	const text = typeof subject !== "string" ? name : name === "bash" ? subject : `${name} ${subject}`;
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > LABEL_CHARS ? `${line.slice(0, LABEL_CHARS - 1)}…` : line;
}

/**
 * `[Pruned: output of \`npm test\` (8,200 chars, exit 0). Full output: <path>]`.
 *
 * Only a `bash` result names an exit code, and it is always 0: pi marks every
 * non-zero exit as an error, and errors are never pruned.
 */
function marker(name: string, call: ToolCall | undefined, text: string, path: string): string {
	const exit = name === "bash" ? ", exit 0" : "";
	return `[Pruned: output of \`${label(name, call)}\` (${text.length.toLocaleString("en-US")} chars${exit}). Full output: ${path}]`;
}

/** A `bash` result's last lines, which it keeps after the marker. */
function tail(text: string): string {
	const lines = text.trimEnd().split("\n").slice(-KEPT_BASH_LINES).join("\n");
	return lines.length > KEPT_BASH_CHARS ? `…${lines.slice(-KEPT_BASH_CHARS)}` : lines;
}

/**
 * What a batch would prune, oldest first: every result the scope's rules
 * pick, as it would be replaced. Pure — nothing is checked against the session
 * and nothing is saved yet, so a caller may narrow the list first.
 *
 * - Old bulk (notice only): a result above the prunable floor that lies
 *   outside the newest 40K tokens of tool output. A result that straddles the
 *   edge of that window is inside it.
 * - Superseded reads, at any age.
 * - Never: the never-pruned tools, a result with `isError`, a result that isn't
 *   plain text, or one already edited.
 */
export function planPrunes(entries: ProjectedSessionEntry[], options: { scope: PruneScope; cwd: string; dir: string }): Prune[] {
	const all = toolResults(entries);
	// Tool output newer than each result, counted from the newest back.
	const newer = new Map<Seen, number>();
	let total = 0;
	for (const seen of [...all].reverse()) {
		newer.set(seen, total);
		total += seen.tokens;
	}

	const prunes: Prune[] = [];
	for (const seen of all) {
		const { result, call } = seen;
		if (result.isError || NEVER_PRUNED.has(result.toolName)) continue;
		const oldBulk = options.scope === "notice" && seen.tokens > PRUNABLE_FLOOR_TOKENS && (newer.get(seen) ?? 0) >= PROTECTED_TOKENS;
		if (!oldBulk && !superseded(seen, all, options.cwd)) continue;
		const text = plainText(seen, entries);
		if (text === undefined) continue;
		const path = join(options.dir, `${seen.entryId}.txt`);
		const head = marker(result.toolName, call, text, path);
		const replacement = result.toolName === "bash" ? `${head}\n${tail(text)}` : head;
		const freed = seen.tokens - estimateTokens({ ...result, content: [{ type: "text", text: replacement }] });
		if (freed <= 0) continue;
		prunes.push({ targetId: seen.entryId, toolCallId: result.toolCallId, text, path, replacement, freed });
	}
	return prunes;
}

/**
 * The prunes whose edits pi will replay, checked the way `appendContextEdit`
 * checks them: a target that exists, on the active branch, and of a kind that
 * carries editable model content. (Its fourth check, a well-formed
 * replacement, holds by construction: `pruneDrafts` always sends a content
 * array.) One failing edit at a boundary makes pi drop every extension's
 * drafts there, ours included, so a failing edit never goes out: it is dropped
 * together with every edit on its call/result pair.
 */
export function checkPrunes(prunes: Prune[], session: Session): Prune[] {
	const branch = new Set(session.getBranch().map((entry) => entry.id));
	const failed = new Set<string>();
	for (const prune of prunes) {
		const target = session.getEntry(prune.targetId);
		const editable =
			target?.type === "custom_message" ||
			(target?.type === "message" && ["user", "assistant", "toolResult"].includes(target.message.role));
		if (!target || !branch.has(target.id) || !editable) failed.add(prune.toolCallId);
	}
	return prunes.filter((prune) => !failed.has(prune.toolCallId));
}

/**
 * Save each prune's full text to its path. A prune whose copy couldn't be
 * written is left out — a marker must never point at nothing — along with the
 * rest of its pair.
 */
export async function savePrunes(prunes: Prune[], dir: string): Promise<Prune[]> {
	try {
		await mkdir(dir, { recursive: true });
	} catch {
		return [];
	}
	const failed = new Set<string>();
	await Promise.all(
		prunes.map((prune) => writeFile(prune.path, prune.text, "utf8").catch(() => failed.add(prune.toolCallId))),
	);
	return prunes.filter((prune) => !failed.has(prune.toolCallId));
}

/** The drafts for a set of prunes: their replacements, as `context_edit`s on their results. */
export function pruneDrafts(prunes: Prune[]): ContextEditEntryDraft[] {
	return prunes.map((prune) => ({
		type: "context_edit",
		targetId: prune.targetId,
		replacement: { content: [{ type: "text", text: prune.replacement }] },
	}));
}

function freedBy(prunes: Prune[]): number {
	return prunes.reduce((sum, prune) => sum + prune.freed, 0);
}

/**
 * Plan, check and save one batch over the context a boundary sees. The notice
 * batch goes out only if it frees at least `MIN_BATCH_TOKENS`, judged before
 * anything is saved and again after, in case a copy failed; the kept tail has
 * no minimum. Returns `undefined` when there is nothing worth sending.
 */
export async function pruneBatch(
	entries: ProjectedSessionEntry[],
	options: { scope: PruneScope; cwd: string; dir: string; session: Session },
): Promise<Batch | undefined> {
	const minimum = options.scope === "notice" ? MIN_BATCH_TOKENS : 1;
	const checked = checkPrunes(planPrunes(entries, options), options.session);
	if (freedBy(checked) < minimum) return undefined;
	const saved = await savePrunes(checked, options.dir);
	const freed = freedBy(saved);
	if (freed < minimum) return undefined;
	return { drafts: pruneDrafts(saved), freed };
}
