/**
 * The Constraint ledger: the user's rules, preferences and exclusions, kept as
 * exact quotes, so that none is paraphrased away or invented.
 *
 * The writer proposes; code checks. Every quote it adds, and every quote that
 * supersedes an entry, must be found in a message the user really wrote —
 * whitespace aside, nothing else forgiven — and whatever fails is dropped and
 * logged, never shown. The ledger only grows: an entry leaves the rendered
 * Handoff only when a later quote from the user supersedes it, and even then it
 * stays in `details`, with what superseded it.
 *
 * Pure: no pi, no I/O.
 */

import type { LedgerEntry } from "./handoff.ts";
import type { LedgerProposal } from "./instruction.ts";

/** A quote shorter than this says too little to be a rule, and matches too much to be checked. */
const MIN_QUOTE_CHARS = 12;

/** Every run of whitespace as one space: the only difference the quote check forgives. */
function norm(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export interface LedgerInput {
	/** The ledger so far: the previous record's, superseded entries included. */
	previous: readonly LedgerEntry[];
	/**
	 * What the writer proposed. `undefined` from a writer asked for none, or
	 * one that was asked and wrote no `<ledger>`: see `missing`.
	 */
	proposal: LedgerProposal | undefined;
	/** Whether the writer was asked for a `<ledger>` and wrote none, which is logged. */
	missing: boolean;
	/**
	 * Every message the user wrote that a quote may come from: the ones the
	 * writer saw, kept tail included, and the previous record's. Only the
	 * user's: an assistant's words, a tool result or a Handoff's prose never
	 * pass.
	 */
	userTexts: readonly string[];
	/** `/compact <instructions>`, which code writes in as the focus. */
	focus?: string;
}

/** The ledger after one compaction, and what was dropped on the way, for `details.log`. */
export function mergeLedger(input: LedgerInput): { ledger: LedgerEntry[]; log: string[] } {
	const ledger = input.previous.map((entry) => ({ ...entry }));
	const log: string[] = [];
	if (input.missing) log.push("ledger: the reply had no <ledger> block, so nothing was added");
	const corpus = input.userTexts.map(norm);
	/** Why `quote` isn't the user's words, or `undefined` if it is. */
	const unchecked = (quote: string): string | undefined => {
		if (quote.length < MIN_QUOTE_CHARS) return `shorter than ${MIN_QUOTE_CHARS} characters`;
		if (!corpus.some((text) => text.includes(quote))) return "not found in any user message";
		return undefined;
	};

	/**
	 * The entries in force that the writer may name: the user's own rules. A
	 * focus is code's, from `/compact`, and only the next focus replaces it.
	 */
	const active = () => ledger.filter((entry) => entry.kind === "constraint" && entry.supersededBy === undefined);

	// Adds first, so that a supersede may name an entry added in the same reply.
	for (const proposed of input.proposal?.adds ?? []) {
		const quote = norm(proposed);
		const why = unchecked(quote);
		if (why) {
			log.push(`ledger: dropped add "${quote}": ${why}`);
			continue;
		}
		const covering = active().find((entry) => entry.quote.includes(quote));
		if (covering) {
			log.push(`ledger: dropped add "${quote}": a duplicate of "${covering.quote}"`);
			continue;
		}
		ledger.push({ quote, kind: "constraint" });
	}

	for (const proposed of input.proposal?.supersedes ?? []) {
		const old = norm(proposed.old);
		const by = norm(proposed.by);
		// The entry it names exactly, or else the one entry that contains it.
		const exact = active().filter((entry) => entry.quote === old);
		const targets = exact.length > 0 || old === "" ? exact : active().filter((entry) => entry.quote.includes(old));
		if (targets.length !== 1) {
			const why = targets.length === 0 ? "it matches no active entry" : `it matches ${targets.length} active entries`;
			log.push(`ledger: dropped supersede of "${old}": ${why}`);
			continue;
		}
		const why = unchecked(by);
		if (why) {
			log.push(`ledger: dropped supersede of "${old}": its "by" quote "${by}" is ${why}`);
			continue;
		}
		targets[0]!.supersededBy = by;
	}

	// A focus is for one stretch of work, not a standing rule: the next one
	// replaces it. One asked for again stays as it is.
	const focus = input.focus === undefined ? "" : norm(input.focus);
	const current = ledger.find((entry) => entry.kind === "focus" && entry.supersededBy === undefined);
	if (focus && current?.quote !== focus) {
		if (current) current.supersededBy = focus;
		ledger.push({ quote: focus, kind: "focus" });
	}
	return { ledger, log };
}
