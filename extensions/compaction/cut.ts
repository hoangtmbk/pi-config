/**
 * The cut: where a compaction on the boundary path ends the removed span and
 * starts the kept tail.
 *
 * It is pi's cut, so that a forced compaction (or a Self-compaction) keeps
 * exactly the tail `/compact` and pi's backstop would: the exported
 * `findCutPoint`, with pi's `keepRecentTokens`. On the hook path pi has chosen
 * it already; this is for the boundary path, where nobody has.
 *
 * `findCutPoint` alone is not quite pi's cut, though. It sizes entries from
 * their raw messages, and pi's own preparation sizes them as the model sees
 * them: after `context_edit`s, so a pruned tool result counts at its pruned
 * size, and from just after the newest compaction. So it is handed the
 * session's projection rather than its branch, mapped back to entries that
 * carry what the model sees.
 *
 * Pure: no pi, no I/O.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	findCutPoint,
	type ProjectedSessionEntry,
	type SessionEntry,
	type SessionProjection,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

export interface Cut {
	/** The first entry the compaction keeps. */
	firstKeptEntryId: string;
	/** The removed span, oldest first, as the model saw it: what the Handoff stands in for. */
	span: AgentMessage[];
	/** What the compaction keeps after the Handoff, oldest first, as the model sees it. */
	tail: AgentMessage[];
}

/**
 * One projected entry as a session entry `findCutPoint` sizes the way the
 * model sees it.
 *
 * An edited message carries its edited content. One that an edit omitted, or
 * an older compaction the newest one has made inert, becomes an entry that
 * projects to nothing, as it does for the model — keeping its id and its
 * place, and a compaction keeping its type, which `findCutPoint` stops at.
 */
function asSeen(projected: ProjectedSessionEntry): SessionEntry {
	const { sourceEntry: source, messages } = projected;
	if (source.type === "compaction") return messages.length > 0 ? source : { ...source, summary: "", systemMessage: undefined };
	if (sessionEntryToContextMessages(source).length === 0) return source;
	const [seen] = messages;
	if (!seen) return { type: "custom", id: source.id, parentId: source.parentId, timestamp: source.timestamp, customType: "omitted" };
	if (source.type === "message") return { ...source, message: seen };
	if (source.type === "custom_message" && seen.role === "custom") return { ...source, content: seen.content };
	return source;
}

/**
 * pi's cut for the session as it stands, keeping about `keepRecentTokens`, or
 * `undefined` when there is nothing to remove — the cases where `/compact`
 * would say "Already compacted" or that there is nothing to compact.
 *
 * Only what came after the newest compaction is cut, which re-summarises that
 * compaction's kept tail, as pi does. On a cut inside a turn, the turn's start
 * is part of the removed span.
 */
export function cutFor(projection: SessionProjection, keepRecentTokens: number): Cut | undefined {
	const projected = projection.entries;
	if (projected.at(-1)?.sourceEntry.type === "compaction") return undefined;
	const entries = projected.map(asSeen);
	const previous = projected.findIndex((entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0);
	const start = previous + 1;
	const { firstKeptEntryIndex } = findCutPoint(entries, start, entries.length, keepRecentTokens);
	const firstKept = projected[firstKeptEntryIndex]?.sourceEntry;
	if (!firstKept) return undefined;
	const seen = (from: readonly ProjectedSessionEntry[]) =>
		from.flatMap((entry) => (entry.sourceEntry.type === "compaction" ? [] : entry.messages.filter((message) => message.role !== "system")));
	const span = seen(projected.slice(start, firstKeptEntryIndex));
	if (span.length === 0) return undefined;
	return { firstKeptEntryId: firstKept.id, span, tail: seen(projected.slice(firstKeptEntryIndex)) };
}
