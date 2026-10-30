/**
 * Handoff: what stands in for the span a compaction removed.
 *
 * A Handoff has two halves. Code writes what it can extract exactly — the
 * user's own words, the Constraint ledger, file state, the agent's note — and a
 * writer from the chain writes the judgment part: Goal, Progress, Decisions and
 * why, Open problems, Critical context and Next step.
 *
 * `details` is the record. The summary text pi stores is rendered from it, and
 * the next compaction merges from the previous `details`; old summary text is
 * never parsed back. So everything a later compaction needs to carry forward
 * has to live here, not only in the rendered text.
 *
 * Pure but for the writers it is handed: no pi, no I/O of its own.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { type CompactionEntry, getLatestCompactionEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Attempt, runChain, type Writer, type WriterName } from "./writers.ts";

/** What a file went through, as far as the session's tool calls say. */
export type FileOp = "created" | "edited" | "deleted" | "read";

/** The six judgment sections, keyed as they are stored. */
export type SectionKey = "goal" | "progress" | "decisions" | "openProblems" | "criticalContext" | "nextStep";

/** The headings the judgment sections render under, in the order they appear. */
export const SECTION_HEADINGS: Record<SectionKey, string> = {
	goal: "Goal",
	progress: "Progress",
	decisions: "Decisions and why",
	openProblems: "Open problems",
	criticalContext: "Critical context",
	nextStep: "Next step",
};

/**
 * The judgment part: the six sections, or — when pi's own summarizer wrote it —
 * pi's text standing in for all six, unchecked against any headings.
 */
export type Judgment = Record<SectionKey, string> | { piDefault: string };

/** One Constraint ledger entry: a user's rule, preference or exclusion, quoted exactly. */
export interface LedgerEntry {
	quote: string;
	kind: "constraint" | "focus";
	/** The user's later words that replaced it. A superseded entry stays in `details`, but is not rendered. */
	supersededBy?: string;
}

/**
 * The record a compaction of ours carries in its `details`.
 *
 * The shape is spec #32's ("The Handoff: parts and storage"), plus `kind`,
 * which is what marks a compaction entry as ours, and `droppedUserMessages`,
 * the count behind the dropped-messages marker, kept as a number so a repeat
 * compaction adds to it instead of parsing it out of text.
 */
export interface HandoffDetails {
	kind: "handoff";
	version: 1;
	/** Which compaction on this branch this is, from 1. */
	compactionNo: number;
	/** Who wrote the judgment part. */
	writer: WriterName;
	/** The attempts that failed before `writer` succeeded, oldest first. */
	attempts: Attempt[];
	/** Every message the user typed, oldest first: the first one, then the newest that fit. */
	userMessages: string[];
	/** How many user messages were dropped between the first and the rest, to fit. */
	droppedUserMessages: number;
	ledger: LedgerEntry[];
	/** Every file the session touched, by path as the tool was given it, in the order first touched. */
	fileState: Record<string, FileOp>;
	/** The agent's own note, from Self-compaction. Lasts this compaction only: never merged forward. */
	note?: string;
	sections: Judgment;
	/** What happened that nobody is shown: dropped quotes and edits, a missing ledger, a cache miss. */
	log: string[];
}

/** Our record, if `details` is one. */
export function handoffOf(details: unknown): HandoffDetails | undefined {
	const candidate = details as Partial<HandoffDetails> | undefined;
	return candidate?.kind === "handoff" && candidate.version === 1 ? (candidate as HandoffDetails) : undefined;
}

// ---------- the user's words ----------

/** Roughly 20K tokens of user messages in all. */
const USER_MESSAGES_TOKENS = 20_000;
/** Roughly 2K tokens for any one message. */
const USER_MESSAGE_TOKENS = 2_000;

/** pi's own estimate: four characters to a token. */
function tokens(text: string): number {
	return Math.ceil(text.length / 4);
}

const thousands = new Intl.NumberFormat("en-US");

/** One message cut to its head and tail when it is over the per-message budget, such as a pasted log. */
function cut(text: string): string {
	if (tokens(text) <= USER_MESSAGE_TOKENS) return text;
	const keep = (USER_MESSAGE_TOKENS * 4) / 2;
	const removed = text.length - keep * 2;
	return `${text.slice(0, keep)}\n[… ${thousands.format(removed)} characters cut …]\n${text.slice(-keep)}`;
}

/**
 * The text of every message the user typed in `span`, in order.
 *
 * Only `user` messages: that includes an `ask_question` answer, which reaches a
 * Run as its next prompt, and a message the user typed while the agent worked.
 * It leaves out tool results and every custom message — our own steers, and
 * what the subagents extension says about Runs and Steers — which pi only turns
 * into user messages when it sends them to the model.
 */
function userMessagesIn(span: readonly AgentMessage[]): string[] {
	const texts: string[] = [];
	for (const message of span) {
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
		if (text.trim()) texts.push(cut(text));
	}
	return texts;
}

/**
 * The previous record's user messages followed by `added`, within budget.
 *
 * Over budget, the first message — the task as given — is kept, and then as
 * many of the newest as fit; the ones between are dropped and counted. A repeat
 * compaction drops from the same place, so the count only ever grows and the
 * marker stays right after the first message.
 */
function keepUserMessages(previous: HandoffDetails | undefined, added: string[]): Pick<HandoffDetails, "userMessages" | "droppedUserMessages"> {
	const all = [...(previous?.userMessages ?? []), ...added];
	const dropped = previous?.droppedUserMessages ?? 0;
	const total = all.reduce((sum, text) => sum + tokens(text), 0);
	if (total <= USER_MESSAGES_TOKENS || all.length < 2) return { userMessages: all, droppedUserMessages: dropped };
	const [first, ...rest] = all as [string, ...string[]];
	let room = USER_MESSAGES_TOKENS - tokens(first);
	let from = rest.length;
	while (from > 0 && tokens(rest[from - 1]!) <= room) room -= tokens(rest[--from]!);
	return { userMessages: [first, ...rest.slice(from)], droppedUserMessages: dropped + from };
}

// ---------- file state ----------

/**
 * Paths a `bash` command deleted, as far as can be told for sure.
 *
 * pi tracks reads, writes and edits through its own tools, but nothing deletes
 * a file except a shell command, so `rm`, `git rm` and the source of a `mv` are
 * read out of the command. Conservatively: a segment with quoting, globs or
 * expansions is skipped rather than guessed at, `git rm --cached` deletes
 * nothing, and nothing after a `cd` is read, since its paths are relative to
 * somewhere else.
 */
function deletedBy(command: string): string[] {
	const paths: string[] = [];
	for (const segment of command.split(/&&|\|\||[;|\n]/)) {
		const words = segment.trim().split(/\s+/).filter(Boolean);
		if (words[0] === "cd" || words[0] === "pushd") break;
		if (/[*?[\]{}$`~<>()'"\\]/.test(segment)) continue;
		const git = words[0] === "git";
		const verb = git ? words[1] : words[0];
		const args = words.slice(git ? 2 : 1);
		if (git && verb !== "rm" && verb !== "mv") continue;
		if (args.includes("--cached")) continue;
		const operands = args.filter((word) => !word.startsWith("-"));
		if (verb === "rm") paths.push(...operands);
		// A move deletes its sources. What it creates may be a folder, so it is left out.
		else if (verb === "mv" && operands.length >= 2) paths.push(...operands.slice(0, -1));
	}
	return paths;
}

/** One file operation applied to what is already known about the file. */
function apply(state: Record<string, FileOp>, path: string, op: "read" | "write" | "edit" | "delete"): void {
	const known = state[path];
	if (op === "read") state[path] = known ?? "read";
	else if (op === "delete") state[path] = "deleted";
	// A file still "created" stays so however often it is rewritten: it did not exist before.
	else if (known === "created") return;
	// A write to a file nothing had seen, or one deleted, makes it; anything else changes it.
	else state[path] = op === "write" && (known === undefined || known === "deleted") ? "created" : "edited";
}

/**
 * File state after `span`, starting from what was already known.
 *
 * Reads, writes and edits come from the same tool calls pi's own compaction
 * tracks — the `read`, `write` and `edit` tools by their `path`, including the
 * ones a codemode script made — and deletes from `bash` (see `deletedBy`), but
 * only when its result says it succeeded. Operations are applied in order, so a
 * file read and then written was edited, and one written first was created.
 */
export function fileStateAfter(known: Record<string, FileOp>, span: readonly AgentMessage[]): Record<string, FileOp> {
	const state = { ...known };
	const succeeded = new Set<string>();
	for (const message of span) if (message.role === "toolResult" && !message.isError) succeeded.add(message.toolCallId);

	const call = (name: string, args: Record<string, unknown> | undefined, id?: string) => {
		if (name === "bash" && id !== undefined && succeeded.has(id) && typeof args?.command === "string") {
			for (const path of deletedBy(args.command)) apply(state, path, "delete");
			return;
		}
		const path = typeof args?.path === "string" ? args.path : undefined;
		if (path && (name === "read" || name === "write" || name === "edit")) apply(state, path, name);
	};
	for (const message of span) {
		if (message.role === "assistant") {
			for (const part of message.content) if (part.type === "toolCall") call(part.name, part.arguments, part.id);
		} else if (message.role === "toolResult") {
			for (const nested of message.nestedCalls?.calls ?? []) call(nested.name, nested.arguments as Record<string, unknown> | undefined);
		}
	}
	return state;
}

/**
 * What the previous compaction says about files: ours, its file state; pi's
 * own, its read and modified lists. A pi compaction cannot say which of its
 * modified files were created, so they count as edited.
 */
export function knownFiles(previous: Pick<CompactionEntry, "details" | "fromHook"> | undefined): Record<string, FileOp> {
	const ours = handoffOf(previous?.details);
	if (ours) return ours.fileState;
	const state: Record<string, FileOp> = {};
	const pis = previous?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	if (previous?.fromHook || !pis) return state;
	for (const path of Array.isArray(pis.readFiles) ? pis.readFiles : []) if (typeof path === "string") state[path] = "read";
	for (const path of Array.isArray(pis.modifiedFiles) ? pis.modifiedFiles : []) if (typeof path === "string") state[path] = "edited";
	return state;
}

// ---------- rendering ----------

/** The judgment part on its own, as a writer is shown the previous one to edit. */
export function judgmentText(judgment: Judgment): string {
	if ("piDefault" in judgment) return judgment.piDefault;
	return (Object.keys(SECTION_HEADINGS) as SectionKey[]).map((key) => `## ${SECTION_HEADINGS[key]}\n${judgment[key]}`).join("\n\n");
}

/**
 * The summary text pi stores and sends: the Handoff, in its fixed order.
 *
 * Goal, Constraint ledger, Progress, Decisions and why, Open problems, Critical
 * context, File state, User messages (verbatim), Next step — rules near the top,
 * and Next step last, right before the kept tail the agent acts from. When pi's
 * summarizer wrote the judgment part, its text stands in where the judgment
 * sections begin, and the parts code wrote follow it in their order.
 *
 * No wrapper of its own: pi already wraps a compaction summary when it sends it.
 */
export function renderHandoff(details: HandoffDetails): string {
	const ledger = details.ledger
		.filter((entry) => entry.supersededBy === undefined)
		.map((entry) => (entry.kind === "focus" ? `- Compaction focus: "${entry.quote}"` : `- "${entry.quote}"`));
	const files = Object.entries(details.fileState).map(([path, op]) => `- ${op} ${path}`);
	const users = details.userMessages.map((text, i) => `[${i === 0 ? 1 : i + 1 + details.droppedUserMessages}] ${text}`);
	if (details.droppedUserMessages > 0) {
		const them = details.droppedUserMessages === 1 ? "1 message" : `${details.droppedUserMessages} messages`;
		users.splice(1, 0, `[… ${them} dropped here to fit …]`);
	}
	const note = details.note === undefined ? undefined : `Agent's note (verbatim): "${details.note}"`;

	const codeParts = {
		ledger: `## Constraint ledger\n${ledger.join("\n") || "(none)"}`,
		files: `## File state\n${files.join("\n") || "(none)"}`,
		users: `## User messages (verbatim)\n${users.join("\n") || "(none)"}`,
	};
	const judgment = details.sections;
	if ("piDefault" in judgment) {
		return [judgment.piDefault, codeParts.ledger, codeParts.files, codeParts.users, ...(note ? [`## Next step\n${note}`] : [])].join("\n\n");
	}
	const section = (key: SectionKey) => `## ${SECTION_HEADINGS[key]}\n${judgment[key]}`;
	return [
		section("goal"),
		codeParts.ledger,
		section("progress"),
		section("decisions"),
		section("openProblems"),
		section("criticalContext"),
		codeParts.files,
		codeParts.users,
		`## Next step\n${[note, judgment.nextStep].filter(Boolean).join("\n\n")}`,
	].join("\n\n");
}

// ---------- the whole Handoff ----------

/** One compaction's worth of input, from whichever path is compacting. */
export interface HandoffRequest {
	/** The removed span, oldest first, as the model saw it. */
	span: readonly AgentMessage[];
	/** What stays after the Handoff, verbatim, oldest first, as the model saw it. */
	tail: readonly AgentMessage[];
	/** The branch as it stands before this compaction. The previous record is read from it. */
	branch: readonly SessionEntry[];
	/** What the user asked this compaction to care about: `/compact <instructions>`. */
	focus?: string;
	/** The agent's own note, on Self-compaction. */
	note?: string;
	/** The path's own abort signal. On the hook path that is the event's, not the run's. */
	signal: AbortSignal | undefined;
}

export type HandoffOutcome =
	| { status: "written"; summary: string; details: HandoffDetails; usage?: Usage }
	/** Escape: nothing is compacted, and nobody is told. */
	| { status: "aborted" }
	/** Every writer failed. `error` is the last one's reason. */
	| { status: "failed"; error: string; attempts: Attempt[] };

/**
 * Write the Handoff for a compaction: run the writer chain, then build the
 * record — merged from the previous one, if that was ours — and render it.
 */
export async function writeHandoff(request: HandoffRequest, writers: readonly Writer[]): Promise<HandoffOutcome> {
	const branch = [...request.branch];
	const previousEntry = getLatestCompactionEntry(branch) ?? undefined;
	const previous = handoffOf(previousEntry?.details);

	const chain = await runChain(writers, {
		span: request.span,
		tail: request.tail,
		// What the writer edits rather than rewrites: our previous judgment part,
		// or a summary pi wrote, which is all there is to go on from one of pi's.
		previousJudgment: previous ? judgmentText(previous.sections) : previousEntry?.summary,
		previousHandoff: previousEntry?.summary,
		focus: request.focus,
		note: request.note,
		signal: request.signal,
	});
	if (chain.status === "aborted") return chain;
	if (chain.status === "failed") return { status: "failed", error: chain.attempts.at(-1)?.reason ?? "no writer ran", attempts: chain.attempts };

	const details: HandoffDetails = {
		kind: "handoff",
		version: 1,
		compactionNo: branch.filter((entry) => entry.type === "compaction").length + 1,
		writer: chain.writer,
		attempts: chain.attempts,
		...keepUserMessages(previous, userMessagesIn(request.span)),
		ledger: previous?.ledger ?? [],
		fileState: fileStateAfter(knownFiles(previousEntry), request.span),
		...(request.note === undefined ? {} : { note: request.note }),
		sections: chain.written.judgment,
		log: [],
	};
	return { status: "written", summary: renderHandoff(details), details, usage: chain.written.usage };
}
