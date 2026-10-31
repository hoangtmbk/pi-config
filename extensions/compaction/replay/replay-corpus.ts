/**
 * The replay check's corpus: which recorded sessions it replays, and where in
 * each one it cuts.
 *
 * - The manifest is a local file, never committed, that names the recorded
 *   main sessions by path. Transcripts stay where pi wrote them; nothing here
 *   copies them anywhere.
 * - A recording is one session file read into its active branch, without
 *   touching the file: pi's in-memory `SessionManager`, never one that persists.
 * - A cut sits at a turn boundary the recording really had: mid-run, after a
 *   turn whose tool calls the run went on from, or just before a user message,
 *   after the turn that ended a run. Each cut needs at least three user turns
 *   recorded after it, so that there is a future to compare with; a session
 *   is cut two or three times in a chain.
 *
 * Plain functions over text and entries: no model, and no I/O but what the
 * caller hands in.
 */

import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	type CompactionEntry,
	estimateTokens,
	parseSessionEntries,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

// ---------- the manifest ----------

/** One recorded session the manifest names. */
export interface ManifestSession {
	/** The session file, absolute. */
	path: string;
	/** What the report calls it: the manifest's `name`, or the file's name. */
	name: string;
}

export interface Manifest {
	sessions: ManifestSession[];
	/** Everything wrong with it. The runner runs nothing while there is any. */
	problems: string[];
}

export interface ManifestPlace {
	/** The manifest file itself: a relative path in it is read from beside it. */
	at: string;
	/** What `~` stands for. */
	home: string;
	exists: (path: string) => boolean;
}

const ENTRY_SHAPE = 'expected a path, or { "path": …, "name": … }';

/**
 * Read the manifest's text: `{ "sessions": [ "<path>", { "path": "<path>", "name": "<name>" } ] }`.
 *
 * A path is absolute, starts `~/`, or is read from beside the manifest. Every
 * problem is reported at once, so that one edit fixes them all.
 */
export function parseManifest(text: string, place: ManifestPlace): Manifest {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { sessions: [], problems: [`it is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const list = (value as { sessions?: unknown } | null)?.sessions;
	if (!Array.isArray(list)) return { sessions: [], problems: ['expected an object with a "sessions" list'] };
	if (list.length === 0) return { sessions: [], problems: ["it names no sessions"] };

	const sessions: ManifestSession[] = [];
	const problems: string[] = [];
	list.forEach((item: unknown, i) => {
		const entry = typeof item === "string" ? { path: item } : (item as { path?: unknown; name?: unknown } | null);
		if (typeof entry?.path !== "string" || !entry.path.trim() || (entry.name !== undefined && typeof entry.name !== "string")) {
			problems.push(`sessions[${i}]: ${ENTRY_SHAPE}`);
			return;
		}
		const path = entry.path.startsWith("~/")
			? join(place.home, entry.path.slice(2))
			: isAbsolute(entry.path)
				? entry.path
				: resolve(dirname(place.at), entry.path);
		const name = (entry.name as string | undefined)?.trim() || (path.split("/").at(-1) ?? path).replace(/\.jsonl$/, "");
		if (!place.exists(path)) problems.push(`sessions[${i}]: ${path} does not exist`);
		else if (sessions.some((session) => session.path === path)) problems.push(`sessions[${i}]: ${path} is named twice`);
		else if (sessions.some((session) => session.name === name)) problems.push(`sessions[${i}]: the name "${name}" is already taken; give it a "name" of its own`);
		else sessions.push({ path, name });
	});
	return { sessions, problems };
}

// ---------- a recording ----------

/** One recorded session, read. */
export interface Recording {
	header: SessionHeader;
	/** The session's active branch, oldest first, exactly as recorded. */
	branch: SessionEntry[];
}

/**
 * A session file's text, read into its active branch: the path from its first
 * entry to its newest one, as `pi --resume` would open it.
 *
 * Refused when it carries no system message: pi keeps the system prompt and
 * the tool declarations in the transcript, and without them neither the
 * writers nor the continuation could send the session as its own requests did.
 */
export function readRecording(text: string): Recording | { problem: string } {
	const entries = parseSessionEntries(text);
	const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
	if (!header) return { problem: "it is not a pi session file" };
	// In memory only: a session manager that persists would write to the file.
	const branch = SessionManager.inMemory(header.cwd, undefined, entries).getBranch();
	if (!branch.some((entry) => entry.type === "message" && entry.message.role === "system")) {
		return { problem: "it records no system message, so its prompt and tools can't be replayed (recorded before pi kept them in the transcript)" };
	}
	return { header, branch };
}

// ---------- turn boundaries ----------

/** Where a cut can sit: mid-run, or just before a user message. */
export type BoundaryKind = "mid-run" | "before-user";

/** One turn boundary the recording really had. */
export interface Boundary {
	kind: BoundaryKind;
	/** The turn's assistant message, by its index in the branch. */
	at: number;
	/** The turn's last entry: its last tool result, or the message itself. */
	end: number;
	/** About how many tokens of context the session held once the turn was in, as pi estimates them, leaving out the system prompt, which no compaction removes. */
	tokens: number;
	/** How many user messages were recorded after it. */
	userTurnsAfter: number;
	/** The model that wrote the turn. */
	model: { provider: string; id: string };
}

/**
 * The tokens an entry adds to the context that a compaction could remove, as
 * pi estimates them: everything but the system prompt and tool declarations,
 * which a compaction always keeps.
 */
function removable(entry: SessionEntry): number {
	return sessionEntryToContextMessages(entry).reduce((sum, message) => sum + (message.role === "system" ? 0 : estimateTokens(message)), 0);
}

function messageOf(entry: SessionEntry | undefined): AgentMessage | undefined {
	return entry?.type === "message" ? entry.message : undefined;
}

/**
 * Every turn boundary in the recording a cut could sit at, oldest first.
 *
 * - Mid-run: after a turn that called tools, every call answered, where the
 *   run went on — the next message is the agent's again, not the user's.
 * - Before a user message: after a turn that answered in text and ended the
 *   run, where the user spoke next.
 *
 * A turn cut short or failed is no boundary, and nor is anything at or before
 * the newest compaction the recording has: a replayed chain is the
 * extension's alone. The tokens are counted from that compaction's kept tail
 * on, its summary included, since that is the context the session held.
 */
export function boundariesOf(recording: Recording): Boundary[] {
	const { branch } = recording;
	let lastCompaction = -1;
	branch.forEach((entry, i) => entry.type === "compaction" && (lastCompaction = i));
	const keptFrom = lastCompaction < 0 ? 0 : Math.max(0, branch.findIndex((entry) => entry.id === (branch[lastCompaction] as CompactionEntry).firstKeptEntryId));

	const userAt: number[] = [];
	branch.forEach((entry, i) => messageOf(entry)?.role === "user" && userAt.push(i));
	/** The next message after `i` that pi sends the model: a user's, the agent's, or an extension's. */
	const nextMessage = (i: number) => {
		for (let j = i + 1; j < branch.length; j++) {
			const message = messageOf(branch[j]);
			if (message && message.role !== "toolResult") return message;
		}
		return undefined;
	};

	const boundaries: Boundary[] = [];
	let tokens = 0;
	for (let i = keptFrom; i < branch.length; i++) {
		const entry = branch[i]!;
		tokens += removable(entry);
		const message = messageOf(entry);
		if (i <= lastCompaction || message?.role !== "assistant") continue;
		const calls = message.content.filter((part) => part.type === "toolCall");
		let end = i;
		let kind: BoundaryKind;
		if (message.stopReason === "toolUse" && calls.length > 0) {
			const answered = new Set<string>();
			while (messageOf(branch[end + 1])?.role === "toolResult") answered.add((messageOf(branch[++end]) as ToolResultMessage).toolCallId);
			if (!calls.every((call) => answered.has(call.id)) || nextMessage(end)?.role !== "assistant") continue;
			kind = "mid-run";
		} else if (message.stopReason === "stop" && calls.length === 0 && nextMessage(i)?.role === "user") {
			kind = "before-user";
		} else continue;
		for (let j = i + 1; j <= end; j++) tokens += removable(branch[j]!);
		boundaries.push({
			kind,
			at: i,
			end,
			tokens,
			userTurnsAfter: userAt.filter((u) => u > end).length,
			model: { provider: message.provider, id: message.model },
		});
		i = end;
	}
	return boundaries;
}

// ---------- the cuts ----------

/**
 * How a cut compacts: mid-run, as Self-compaction after the extension's real
 * steer, or as a forced compaction; or just before a user message, through
 * pi's `/compact` hook. Together they cover every path a Handoff is written on.
 */
export type CutKind = "self" | "forced" | "before-user";

const CUT_KINDS: readonly CutKind[] = ["self", "forced", "before-user"];

/**
 * The kinds the `session`th session of a run (from 0) is cut with, in chain
 * order: the three, rotated by one per session. Over a run, every depth then
 * sees every kind, and the mid-run cuts split evenly between Self-compaction
 * and forced.
 */
export function kindsFor(session: number, depth = CUT_KINDS.length): CutKind[] {
	return Array.from({ length: depth }, (_, j) => CUT_KINDS[(session + j) % CUT_KINDS.length]!);
}

/** One cut in a chain. */
export interface PlannedCut {
	boundary: Boundary;
	kind: CutKind;
	/** The kind the rotation asked for; `kind` differs when no boundary of that kind fitted. */
	requested: CutKind;
}

export interface CutPlan {
	/** The kinds to cut with, in chain order: as many as the chain is to be deep. */
	kinds: readonly CutKind[];
	/**
	 * The fewest tokens a cut removes: none closer than this to the one before
	 * it, and the first at twice this, so that every compaction has a span to
	 * stand in for beside the tail it keeps. pi's `keepRecentTokens`.
	 */
	gap: number;
}

/** Recorded user turns a cut needs after it, so that there is a future to compare the continuation with. */
export const USER_TURNS_AFTER = 3;

/** The shortest chain worth replaying. */
const MIN_DEPTH = 2;

const boundaryFor = (kind: CutKind): BoundaryKind => (kind === "before-user" ? "before-user" : "mid-run");

/**
 * Where a session is cut: a chain as deep as `kinds` if it fits, else one cut
 * shorter, down to two; none if not even two fit.
 *
 * The cuts are spread evenly over the boundaries that qualify — from the first
 * with twice the gap before it to the last with three user turns after it —
 * each taking the boundary of its kind nearest its even share, while leaving
 * the gap before it and room for the cuts still to come. When no boundary of
 * the kind fits, the nearest of the other does, and the cut says what it was
 * asked to be: a mid-run boundary then compacts as forced.
 */
export function planCuts(boundaries: readonly Boundary[], plan: CutPlan): PlannedCut[] {
	const eligible = boundaries.filter((b) => b.userTurnsAfter >= USER_TURNS_AFTER && b.tokens >= 2 * plan.gap);
	if (eligible.length === 0) return [];
	const lo = eligible[0]!.tokens;
	const hi = eligible.at(-1)!.tokens;
	for (let depth = plan.kinds.length; depth >= MIN_DEPTH; depth--) {
		const cuts: PlannedCut[] = [];
		for (let j = 0; j < depth; j++) {
			const target = lo + ((hi - lo) * j) / (depth - 1);
			const previous = cuts.at(-1)?.boundary;
			const fits = eligible.filter(
				(b) => (!previous || (b.at > previous.end && b.tokens >= previous.tokens + plan.gap)) && b.tokens <= hi - (depth - 1 - j) * plan.gap,
			);
			const nearest = (among: Boundary[]) =>
				among.reduce<Boundary | undefined>((best, b) => (!best || Math.abs(b.tokens - target) < Math.abs(best.tokens - target) ? b : best), undefined);
			const requested = plan.kinds[j]!;
			const boundary = nearest(fits.filter((b) => b.kind === boundaryFor(requested))) ?? nearest(fits);
			if (!boundary) break;
			const kind = boundary.kind === boundaryFor(requested) ? requested : boundary.kind === "before-user" ? "before-user" : "forced";
			cuts.push({ boundary, kind, requested });
		}
		if (cuts.length === depth) return cuts;
	}
	return [];
}
