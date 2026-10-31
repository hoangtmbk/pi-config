/**
 * Landing: our compactions on the boundary path, from the moment one is
 * written until pi has committed it.
 *
 * A boundary's drafts are only proposed. pi drops all of them if any one won't
 * replay, ours included, so whether a compaction of ours landed is known only
 * at the next boundary. One that sank is drafted again, once, from the same
 * Handoff; one that can't be is given up, as every writer failing is. A
 * Self-compaction is written in its tool call, before its boundary, and waits
 * here for it — and since the agent has been told it happened, one that its
 * boundary can't draft is held for the next that can, as one that sank is.
 *
 * No pi of its own: it reads the session it is handed, and the caller does
 * the acting.
 */

import { type ExtensionContext, getLatestCompactionEntry, type SessionBoundaryDraft, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { type HandoffDetails, handoffOf } from "./handoff.ts";
import { checkPrunes, type Prune } from "./pruning.ts";

/** The session as an extension sees it: read-only. */
type Session = ExtensionContext["sessionManager"];

/** A compaction draft, as a boundary returns it. */
type CompactionDraft = Extract<SessionBoundaryDraft, { type: "compaction" }>;

/** A compaction draft of ours: always a cut, always our Handoff. */
export type OurDraft = CompactionDraft & { firstKeptEntryId: string; details: HandoffDetails };

/** A compaction of ours at a boundary, with the kept tail's Pruning that goes out with it. */
export interface Compacting {
	draft: OurDraft;
	/** Checked and saved: their drafts follow the compaction's. */
	prunes: Prune[];
}

/** Why a compaction that couldn't land is given up, in the toast that every writer failing shows. */
export type GiveUp = "sunk" | "sunk-twice" | "cut-gone";

export const GIVE_UP: Record<GiveUp, string> = {
	sunk: "pi dropped it, with another extension's invalid draft",
	"sunk-twice": "pi dropped it twice, with another extension's invalid draft",
	"cut-gone": "its kept tail is no longer on the branch",
};

/** A compaction of ours on its way: drafted at a boundary, or held for the next. */
interface Flight extends Compacting {
	/** The newest compaction on the branch when it was written, which it is to follow. */
	after: string | undefined;
	/** Whether the agent was told it happened: a Self-compaction. */
	promised: boolean;
	/** How many times pi has dropped it. */
	sunk: number;
	/** Whether it has been drafted again already. */
	redrafted: boolean;
}

/** A Self-compaction `execute` has written, waiting for its turn's boundary. */
interface Prepared extends Compacting {
	/** The `self_compact` call that wrote it. */
	toolCallId: string;
}

function latestId(session: Session): string | undefined {
	return getLatestCompactionEntry(session.getBranch())?.id;
}

export class Landing {
	/** The Self-compaction written during this turn, which its `turn_end` applies. */
	private prepared: Prepared | undefined;
	/** The compaction drafted at the last boundary, until the next has seen whether pi committed it. */
	private drafted: Flight | undefined;
	/** The one to draft again: it sank, or its boundary couldn't draft it. */
	private held: Flight | undefined;
	/** What `redraft` handed out, and what it came from. */
	private redrafting: { compacting: Compacting; from: Flight } | undefined;

	/** A Self-compaction written by the `self_compact` call `toolCallId`, for its turn's boundary. */
	prepare(compacting: Compacting, toolCallId: string): void {
		this.prepared = { ...compacting, toolCallId };
	}

	/** A new prompt: a Self-compaction written in the last, and not yet at its boundary, is stale. */
	newRun(): void {
		this.prepared = undefined;
	}

	/**
	 * The Self-compaction this turn's `self_compact` wrote, if any; one from any
	 * other turn is stale, and let go. Its kept tail's Pruning is checked again
	 * against the branch, which now holds the turn's tool results too.
	 */
	takePrepared(event: TurnEndEvent, session: Session): Compacting | undefined {
		const was = this.prepared;
		this.prepared = undefined;
		if (!was || event.message.role !== "assistant") return undefined;
		if (!event.message.content.some((part) => part.type === "toolCall" && part.id === was.toolCallId)) return undefined;
		return { draft: was.draft, prunes: checkPrunes(was.prunes, session) };
	}

	/**
	 * What became of the compaction drafted at the last boundary: first thing
	 * at every boundary. Returns whether it landed.
	 *
	 * It landed if the newest compaction on the branch is ours with its number.
	 * It sank if no compaction at all has landed since it was drafted — "the
	 * newest isn't ours" alone can't say so, because the newest may be our
	 * previous one — and it is held to be drafted again. A compaction that
	 * someone else landed in between leaves it, or one already held, nothing to
	 * follow, and it is let go: the context was compacted after all.
	 */
	settle(session: Session): boolean {
		const was = this.drafted;
		this.drafted = undefined;
		this.redrafting = undefined;
		const latest = getLatestCompactionEntry(session.getBranch());
		if (was && handoffOf(latest?.details)?.compactionNo === was.draft.details.compactionNo) return true;
		if (was) this.held = { ...was, sunk: was.sunk + 1 };
		if (this.held && latest?.id !== this.held.after) this.held = undefined;
		return false;
	}

	/**
	 * A Self-compaction this boundary can't draft — a turn that didn't
	 * complete, or an earlier extension compacting here — held for the next
	 * boundary that can. Newer than any held before it.
	 */
	hold(compacting: Compacting, session: Session): void {
		this.held = { ...compacting, after: latestId(session), promised: true, sunk: 0, redrafted: false };
	}

	/**
	 * A boundary that drafts nothing of ours. A forced compaction held is let
	 * go, as Escape lets go of one being written: forced comes round again. A
	 * Self-compaction held waits for the next boundary.
	 */
	pass(): void {
		if (!this.held?.promised) this.held = undefined;
		this.redrafting = undefined;
	}

	/**
	 * The compaction held, drafted again: the same Handoff over the same cut,
	 * with no writer run again, so that a neighbour's bad draft doesn't
	 * silently lose it. Once only — dropped again, or with its cut entry gone
	 * from the branch, it is given up, which the caller handles as every
	 * writer failing. `undefined` when none is held.
	 *
	 * Its kept tail's Pruning goes with it, checked again against the branch
	 * as it stands now: copies already saved, so an edit that would fail is
	 * dropped with its pair, as at the first try.
	 */
	redraft(session: Session): Compacting | GiveUp | undefined {
		const held = this.held;
		this.held = undefined;
		if (!held) return undefined;
		if (held.redrafted) return held.sunk > 1 ? "sunk-twice" : "sunk";
		const cut = held.draft.firstKeptEntryId;
		if (!session.getBranch().some((entry) => entry.id === cut)) return "cut-gone";
		const compacting = { draft: held.draft, prunes: checkPrunes(held.prunes, session) };
		this.redrafting = { compacting, from: held };
		return compacting;
	}

	/** Ours, drafted at this boundary: a Self-compaction if `promised`, or the one `redraft` handed out. */
	drafting(compacting: Compacting, session: Session, promised: boolean): void {
		const from = this.redrafting?.compacting === compacting ? this.redrafting.from : undefined;
		this.redrafting = undefined;
		this.held = undefined;
		this.drafted = {
			...compacting,
			after: latestId(session),
			promised: from?.promised ?? promised,
			sunk: from?.sunk ?? 0,
			redrafted: from !== undefined,
		};
	}
}
