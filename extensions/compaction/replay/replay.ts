/**
 * The replay check's deterministic half: what can be scored about a Handoff
 * without a model, given the session it was written for and what really
 * happened next.
 *
 * - The file-state diff compares the Handoff's file state with the true one at
 *   the cut. "Exact" is the pass bar.
 * - Recurring-detail retention is the share of identifiers from the removed
 *   span that come up again after the cut and survive in the Handoff. It is
 *   reported, not gated; below 70% is the trigger to add an identifier dump.
 * - The collapse guard flags a chained Handoff that has lost content compared
 *   with the one before it.
 *
 * Plain functions over messages and compaction entries, so the live runner can
 * score both our Handoff and pi's default summary with them. A Handoff here is
 * whatever stands in for the removed span: our compaction entry, or pi's own.
 * No pi, no I/O, no model.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import { type FileOp, fileStateAfter, handoffOf, judgmentText, knownFiles } from "../handoff.ts";

/** What is checked: a compaction entry, ours or pi's, as far as the checks read it. */
export type Handoff = Pick<CompactionEntry, "summary" | "details"> & Partial<Pick<CompactionEntry, "fromHook">>;

// ---------- the file-state diff ----------

export interface FileStateDiff {
	/** The pass bar: the Handoff says exactly what the session did to every file, and nothing more. */
	exact: boolean;
	/** The true file state at the cut, from the session's own tool calls. */
	truth: Record<string, FileOp>;
	/** The file state the Handoff carries. */
	handoff: Record<string, FileOp>;
	/** Paths the session touched that the Handoff leaves out. */
	missing: string[];
	/** Paths the Handoff lists that the session never touched. */
	extra: string[];
	/** Paths in both, with a different operation. */
	wrong: { path: string; handoff: FileOp; truth: FileOp }[];
}

/**
 * The Handoff's file state against the true one at the cut.
 *
 * `removed` is every message the Handoff stands in for, from the start of the
 * session — so at a chained cut, the spans of every compaction before it too.
 * The truth is read from it with the same mapping the Handoff uses: a `write`
 * to a path not seen before created it, a successful `bash` `rm`, `git rm` or
 * `mv` deleted it. pi's own compaction can say only read or modified, so its
 * modified files count as edited, and a created or deleted file is wrong there.
 */
export function fileStateDiff(handoff: Handoff, removed: readonly AgentMessage[]): FileStateDiff {
	const truth = fileStateAfter({}, removed);
	const carried = knownFiles(handoff);
	const missing = Object.keys(truth).filter((path) => !(path in carried));
	const extra = Object.keys(carried).filter((path) => !(path in truth));
	const wrong = Object.keys(truth)
		.filter((path) => path in carried && carried[path] !== truth[path])
		.map((path) => ({ path, handoff: carried[path]!, truth: truth[path]! }));
	return { exact: missing.length + extra.length + wrong.length === 0, truth, handoff: carried, missing, extra, wrong };
}

// ---------- recurring-detail retention ----------

/**
 * What looks like an identifier rather than prose, in the order tried at each
 * position: URLs, backticked code, paths and file names, `--flags`, commit
 * hashes, snake_case, camelCase and PascalCase names, ALL-CAPS codes such as
 * `ENOENT`, `#123` references, and versions and numbers of three digits or
 * more. A path needs a dot in its last part, a leading `/`, `./` or `~/`, or
 * two slashes, so that "and/or" is not one.
 */
const DETAIL = new RegExp(
	[
		/https?:\/\/[^\s<>"'`)\]]+/,
		/`([^`\n]+)`/,
		/(?<![\w.@-])(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)*|[\w.@-]+(?:\/[\w.@-]+){2,}|[\w.@-]+\/[\w@-]*\.[\w.@-]+/,
		/\b[\w-]{2,}\.[a-z][a-z0-9]{0,4}\b/,
		/(?<![\w-])--[a-z][\w-]*/,
		/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/,
		/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/,
		/\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/,
		/\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/,
		/\b[A-Z][A-Z0-9]{3,}\b/,
		/#\d+\b/,
		/\b\d+(?:\.\d+)+\b|\b\d{3,}\b/,
	]
		.map((pattern) => pattern.source)
		.join("|"),
	"g",
);

/** The identifiers in `text`, each once, in the order they first appear. */
function detailsIn(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(DETAIL)) {
		// A path or name that ends a sentence keeps its full stop out.
		const detail = (match[1] ?? match[0]).replace(/[.,:;]+$/, "");
		if (detail) found.add(detail);
	}
	return [...found];
}

/** Every string inside a tool call's arguments. */
function stringsIn(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(stringsIn);
	if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
	return [];
}

/**
 * What the model read and wrote in `messages`: the user's words, the agent's
 * replies and tool calls, the tools' results, and the user's own `!` commands.
 * Thinking is left out, and so are custom messages, which are the extensions'
 * words, not the work's.
 */
function textOf(messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user" || message.role === "toolResult") {
			if (typeof message.content === "string") parts.push(message.content);
			else for (const part of message.content) if (part.type === "text") parts.push(part.text);
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text") parts.push(part.text);
				else if (part.type === "toolCall") parts.push(...stringsIn(part.arguments));
			}
		} else if (message.role === "bashExecution") {
			parts.push(message.command, message.output);
		}
	}
	return parts.join("\n");
}

/** One cut of a recorded session. */
export interface Cut {
	/** Every message the Handoff stands in for, from the start of the session. */
	removed: readonly AgentMessage[];
	/** The kept tail: what survives the compaction verbatim. */
	tail: readonly AgentMessage[];
	/** What really happened next, as recorded. */
	after: readonly AgentMessage[];
}

export interface Retention {
	/** Identifiers from the removed span, not in the kept tail, that come up again after the cut, in the order first seen. */
	recurring: string[];
	/** Those the Handoff carries, word for word. */
	retained: string[];
	/** Those it does not. */
	lost: string[];
	/** `retained` as a share of `recurring`, from 0 to 1; `undefined` when nothing recurs. */
	share: number | undefined;
	/** The Handoff's size in characters, which the share is reported beside. */
	handoffChars: number;
}

/**
 * How many of the details that matter after the cut the Handoff kept.
 *
 * A detail is an identifier (see `DETAIL`) from the removed span that comes up
 * again in what really happened next. One the kept tail already shows is not
 * the Handoff's to carry, so it is not counted. Each is looked up as an exact
 * substring: in what happened next, and in the Handoff's text.
 */
export function recurringDetailRetention(handoff: Handoff, cut: Cut): Retention {
	const tail = textOf(cut.tail);
	const after = textOf(cut.after);
	const recurring = detailsIn(textOf(cut.removed)).filter((detail) => !tail.includes(detail) && after.includes(detail));
	const retained = recurring.filter((detail) => handoff.summary.includes(detail));
	return {
		recurring,
		retained,
		lost: recurring.filter((detail) => !retained.includes(detail)),
		share: recurring.length === 0 ? undefined : retained.length / recurring.length,
		handoffChars: handoff.summary.length,
	};
}

// ---------- the collapse guard ----------

/**
 * What a Handoff carries, counted. Each is something a chained Handoff should
 * keep from the one before it, so none of them should ever fall.
 *
 * A count our record has and pi's compaction lacks is `undefined` for pi's,
 * and so is the open-item count when pi's summarizer wrote our judgment part.
 */
export interface HandoffMeasure {
	/** The judgment part's size in characters: what a writer wrote. For pi's own compaction, its whole summary. */
	size: number;
	/** Constraint ledger entries, superseded ones included: the ledger only grows. */
	ledger: number | undefined;
	/** Files in the file state, which is unioned across compactions. */
	files: number;
	/** User messages, those dropped to fit included: the record appends them. */
	userMessages: number | undefined;
	/** Items under Open problems. */
	openItems: number | undefined;
}

/** The items in a section: its list items, or one for prose, or none when it says there are none. */
function itemsIn(section: string): number {
	const items = section.split("\n").filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)).length;
	if (items > 0) return items;
	return /^\(?(?:none|nothing)?\.?\)?$/i.test(section.trim()) ? 0 : 1;
}

/** One Handoff, counted. */
export function measureHandoff(handoff: Handoff): HandoffMeasure {
	const ours = handoffOf(handoff.details);
	const files = Object.keys(knownFiles(handoff)).length;
	if (!ours) return { size: handoff.summary.length, ledger: undefined, files, userMessages: undefined, openItems: undefined };
	return {
		size: judgmentText(ours.sections).length,
		ledger: ours.ledger.length,
		files,
		userMessages: ours.userMessages.length + ours.droppedUserMessages,
		openItems: "piDefault" in ours.sections ? undefined : itemsIn(ours.sections.openProblems),
	};
}

/** One measure that fell from one Handoff in a chain to the next. */
export interface CollapseFlag {
	/** The Handoff that lost it: its place in the chain, the first compaction being 1. */
	depth: number;
	measure: keyof HandoffMeasure;
	before: number;
	after: number;
}

export interface CollapseReport {
	/** Each Handoff in the chain, counted, oldest first. */
	measures: HandoffMeasure[];
	/** Every measure that fell, by depth. */
	flags: CollapseFlag[];
	/** Whether any Handoff in the chain lost content compared with the one before it. */
	collapsed: boolean;
}

/**
 * Whether a chain of Handoffs, oldest first, held its content.
 *
 * Each Handoff is compared with the one before it, and every measure that fell
 * is flagged. Strictly: any fall at all is flagged, for whoever reads the
 * report to look at, since a repeat compaction is meant to edit the previous
 * Handoff, removing only what was superseded. A measure one of the two lacks
 * is not compared.
 */
export function collapseGuard(chain: readonly Handoff[]): CollapseReport {
	const measures = chain.map(measureHandoff);
	const flags: CollapseFlag[] = [];
	for (let i = 1; i < measures.length; i++) {
		const before = measures[i - 1]!;
		const after = measures[i]!;
		for (const measure of Object.keys(after) as (keyof HandoffMeasure)[]) {
			const was = before[measure];
			const is = after[measure];
			if (was !== undefined && is !== undefined && is < was) flags.push({ depth: i + 1, measure, before: was, after: is });
		}
	}
	return { measures, flags, collapsed: flags.length > 0 };
}
