/**
 * Landing: our compactions on the boundary path, from the moment one is
 * written until pi has committed it.
 *
 * A boundary's drafts are only proposed. pi drops all of them if any one won't
 * replay, ours included, so whether a compaction of ours landed is known only
 * at the next boundary. One that sank is drafted again, once, from the same
 * Handoff; one that can't be is given up, as every writer failing is. A
 * Self-compaction is written in its tool call, before its boundary, and waits
 * here for it.
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

/** Why a compaction that sank is given up, in the toast that every writer failing shows. */
export type GiveUp = "sunk-twice" | "cut-gone";

export const GIVE_UP: Record<GiveUp, string> = {
	"sunk-twice": "pi dropped it twice, with another extension's invalid draft",
	"cut-gone": "its kept tail is no longer on the branch",
};

/** A compaction of ours sent from a boundary, kept until the next one says whether pi committed it. */
interface Drafted extends Compacting {
	/** The newest compaction on the branch when it was drafted, which it was to follow. */
	after: string | undefined;
	/** Whether this is already the re-draft of one that sank. */
	redrafted: boolean;
}

/** A Self-compaction `execute` has written, waiting for its turn's boundary. */
interface Prepared extends Compacting {
	/** The `self_compact` call that wrote it. */
	toolCallId: string;
}

export class Landing {
	/** The Self-compaction written during this turn, which its `turn_end` applies. */
	private prepared: Prepared | undefined;
	/**
	 * The compaction last drafted at a boundary, until the next boundary has
	 * seen whether pi committed it.
	 */
	private drafted: Drafted | undefined;
	/** The one that sank, handed out again by `redraft`. */
	private sank: Drafted | undefined;

	/** A Self-compaction written by the `self_compact` call `toolCallId`, for its turn's boundary. */
	prepare(compacting: Compacting, toolCallId: string): void {
		this.prepared = { ...compacting, toolCallId };
	}

	/** A new run: a Self-compaction written in the last is stale. */
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
	 * previous one — and `redraft` hands it back. A compaction that someone
	 * else landed in between leaves it nothing to follow, and it is let go.
	 */
	settle(session: Session): boolean {
		const was = this.drafted;
		this.drafted = undefined;
		this.sank = undefined;
		if (!was) return false;
		const latest = getLatestCompactionEntry(session.getBranch());
		if (handoffOf(latest?.details)?.compactionNo === was.draft.details.compactionNo) return true;
		if (latest?.id === was.after) this.sank = was;
		return false;
	}

	/**
	 * A compaction that sank, drafted again: the same Handoff over the same
	 * cut, with no writer run again, so that a neighbour's bad draft doesn't
	 * silently lose it. Once only — sunk twice, or with its cut entry gone from
	 * the branch, it is given up, which the caller handles as every writer
	 * failing. `undefined` when none sank.
	 *
	 * Its kept tail's Pruning goes with it, checked again against the branch
	 * as it stands now: copies already saved, so an edit that would fail is
	 * dropped with its pair, as at the first try.
	 */
	redraft(session: Session): Compacting | GiveUp | undefined {
		const sank = this.sank;
		if (!sank) return undefined;
		if (sank.redrafted) return "sunk-twice";
		const cut = sank.draft.firstKeptEntryId;
		if (!session.getBranch().some((entry) => entry.id === cut)) return "cut-gone";
		return { draft: sank.draft, prunes: checkPrunes(sank.prunes, session) };
	}

	/** Ours, drafted at this boundary: `redrafted` if it is the one `redraft` handed out. */
	drafting(compacting: Compacting, session: Session, redrafted: boolean): void {
		this.drafted = { ...compacting, after: getLatestCompactionEntry(session.getBranch())?.id, redrafted };
	}
}
