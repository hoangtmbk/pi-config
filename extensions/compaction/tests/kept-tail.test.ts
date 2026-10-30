/**
 * Kept-tail Pruning: at a compaction, superseded reads in the tail it keeps
 * are replaced with the same one-line marker the notice batch writes, with no
 * minimum gain — the cache is cold after a compaction anyway. The rest of the
 * tail stays verbatim.
 *
 * Driven only through the recording fake pi, with the model call scripted and
 * the pruned-copy folder a temp dir: a test builds a session out of turns,
 * takes pressure to forced, and reads back the drafts the boundary returned,
 * the files saved and pi's working row.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getLatestCompactionEntry, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { registerCompaction } from "../index.ts";
import { calling, type FakeSetup, fakePi, result, user } from "./fake-pi.ts";
import { type Reply, scriptModel } from "./scripted-model.ts";

const PI_SUMMARY = "## Goal\nAdd retries to the fetcher.\n\n## Progress\n- Wrote the wrapper.";

/** What the forked call and serialized mode get here: a reply neither can use, so that pi's summarizer, last in the chain, writes. */
const NO_HANDOFF: Reply = { text: "I'll carry on with the fetcher." };

/** A kept tail that holds the last few tool turns, and not the asks before them. */
const KEEP = 30_000;

const SETUP: FakeSetup = { settings: { compaction: { keepRecentTokens: KEEP }, retry: { enabled: false } } };

const folders: string[] = [];

function folder(): string {
	const dir = mkdtempSync(join(tmpdir(), "compaction-kept-tail-"));
	folders.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake pi with pi's summarizer scripted to answer each compaction with the
 * next of `replies`, and its pruned copies in a temp dir.
 */
function compacting(replies: Reply[] = [{ text: PI_SUMMARY }], setup: FakeSetup = SETUP) {
	const model = scriptModel(...replies.flatMap((reply) => [NO_HANDOFF, NO_HANDOFF, reply]));
	const dir = folder();
	const pi = fakePi(setup, (api) => registerCompaction(api, { stream: model.stream, prunedDir: dir }));
	return Object.assign(pi, { dir, script: model });
}

type Pi = ReturnType<typeof compacting>;

/** Output of exactly `tokens` tokens, as pi counts them (four characters to one). */
function output(tokens: number, tag: string): string {
	return `${tag} `.padEnd(tokens * 4, "x");
}

/** A turn that ran one tool and got `text` back, below notice. */
function ran(name: string, args: Record<string, unknown>, text: string, isError = false) {
	const message = calling(name, args);
	return { tokens: 60_000, message, toolResults: [result(message, text, isError)] };
}

/** Asks big enough that the kept tail can't reach them: what a compaction removes. */
async function asks(pi: Pi, count = 4): Promise<void> {
	for (let n = 1; n <= count; n++) {
		pi.session.appendMessage(user(output(12_000, `ask ${n}`)));
		await pi.turnEnd({ tokens: 40_000 + n * 1_000 });
	}
}

/** Run one tool turn and return the session entry id of its result. */
async function turn(pi: Pi, ...args: Parameters<typeof ran>): Promise<string> {
	await pi.turnEnd(ran(...args));
	const entry = [...pi.session.getBranch()].reverse().find((e) => e.type === "message" && e.message.role === "toolResult");
	if (!entry) throw new Error("no tool result yet");
	return entry.id;
}

/** The `context_edit` drafts in a boundary's answer, by target. */
function edits(drafts: SessionBoundaryDraft[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const draft of drafts) {
		if (draft.type !== "context_edit") continue;
		const content = draft.replacement?.content;
		out.set(draft.targetId, Array.isArray(content) ? content.map((c) => ("text" in c ? c.text : "")).join("") : String(content));
	}
	return out;
}

function compactionIn(drafts: SessionBoundaryDraft[]) {
	return drafts.find((draft): draft is Extract<SessionBoundaryDraft, { type: "compaction" }> => draft.type === "compaction");
}

/** Whether an entry is in the tail a compaction keeps: at or after its first kept entry. */
function kept(pi: Pi, firstKeptEntryId: string, id: string): boolean {
	const ids = pi.session.getBranch().map((entry) => entry.id);
	return ids.indexOf(id) >= ids.indexOf(firstKeptEntryId);
}

describe("at a forced compaction", () => {
	it("prunes a superseded read in the kept tail, with no minimum, the compaction going out first", async () => {
		const pi = compacting();
		await asks(pi);
		const first = await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v1"));
		await turn(pi, "read", { path: "./src/a.ts" }, output(2_000, "a.ts v2"));
		const drafts = await pi.turnEnd({ tokens: 172_000 });

		const compaction = compactionIn(drafts);
		assert.ok(compaction, "a compaction was drafted");
		assert.ok(kept(pi, compaction.firstKeptEntryId!, first), "the first read is in the kept tail");
		assert.deepEqual(drafts.map((draft) => draft.type), ["compaction", "context_edit"]);
		const path = join(pi.dir, `${first}.txt`);
		assert.equal(edits(drafts).get(first), `[Pruned: output of \`read src/a.ts\` (8,000 chars). Full output: ${path}]`);
		assert.equal(readFileSync(path, "utf8"), output(2_000, "a.ts v1"));
		assert.deepEqual(pi.errors, []);
	});

	it("prunes however little it frees", async () => {
		const pi = compacting();
		await asks(pi);
		const first = await turn(pi, "read", { path: "src/a.ts" }, output(60, "a.ts v1"));
		await turn(pi, "read", { path: "src/a.ts" }, output(60, "a.ts v2"));
		assert.deepEqual([...edits(await pi.turnEnd({ tokens: 172_000 })).keys()], [first]);
	});

	it("leaves the rest of the tail verbatim: old bulk, edited reads, the never-pruned set and errors", async () => {
		const pi = compacting(undefined, { settings: { compaction: { keepRecentTokens: 100_000 }, retry: { enabled: false } } });
		await asks(pi, 9);
		// Bulk the notice batch would take: 30K with 50K of newer tool output after it.
		const bulk = await turn(pi, "bash", { command: "npm test" }, output(30_000, "test"));
		await turn(pi, "read", { path: "src/b.ts" }, output(2_000, "b.ts"));
		await turn(pi, "edit", { path: "src/b.ts", edits: [] }, "Successfully replaced 1 block");
		for (const name of ["ask_question", "subagent", "self_compact"]) await turn(pi, name, { task: "x" }, output(2_000, name));
		await turn(pi, "read", { path: "src/c.ts" }, output(2_000, "c.ts failing"), true);
		await turn(pi, "read", { path: "src/c.ts" }, output(2_000, "c.ts"));
		await turn(pi, "bash", { command: "cat a.log" }, output(25_000, "a"));
		await turn(pi, "bash", { command: "cat b.log" }, output(25_000, "b"));
		const drafts = await pi.turnEnd({ tokens: 172_000 });
		const compaction = compactionIn(drafts);
		assert.ok(compaction, "a compaction was drafted");
		assert.ok(kept(pi, compaction.firstKeptEntryId!, bulk), "the bulk output is in the kept tail");
		assert.deepEqual(drafts.map((draft) => draft.type), ["compaction"]);
		assert.deepEqual(readdirSync(pi.dir), []);
	});

	it("never edits an entry in the removed span, even a read the kept tail supersedes", async () => {
		const pi = compacting();
		const removed = await turn(pi, "read", { path: "src/a.ts" }, output(12_000, "a.ts v1"));
		await asks(pi);
		await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v2"));
		const drafts = await pi.turnEnd({ tokens: 172_000 });
		const compaction = compactionIn(drafts);
		assert.ok(compaction && !kept(pi, compaction.firstKeptEntryId!, removed), "the old read is in the removed span");
		assert.deepEqual(drafts.map((draft) => draft.type), ["compaction"]);
	});
});

describe("the drafts", () => {
	it("go after earlier extensions' drafts: theirs, then our compaction, then our edits", async () => {
		const pi = compacting();
		await asks(pi);
		const first = await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v1"));
		await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v2"));
		const theirs: SessionBoundaryDraft = { type: "custom", customType: "other", data: { n: 1 } };
		const drafts = await pi.turnEnd({ tokens: 172_000, entries: [theirs] });
		assert.equal(drafts[0], theirs);
		assert.deepEqual(drafts.map((draft) => draft.type), ["custom", "compaction", "context_edit"]);
		assert.deepEqual([...edits(drafts).keys()], [first]);
	});

	it("replay in pi's own session: the Handoff, then the tail with the stale read as a marker", async () => {
		const pi = compacting();
		await asks(pi);
		const first = await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v1"));
		const second = await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v2"));
		pi.commit(await pi.turnEnd({ tokens: 172_000 }));
		const projected = pi.session.buildSessionProjection();
		assert.equal(projected.messages.filter((m) => m.role !== "system")[0]?.role, "compactionSummary");
		const text = (id: string) => {
			const message = projected.entries.find((e) => e.sourceEntry.id === id)?.messages[0];
			return message?.role === "toolResult" && message.content[0]?.type === "text" ? message.content[0].text : undefined;
		};
		assert.match(text(first) ?? "", /^\[Pruned: output of `read src\/a\.ts`/);
		assert.equal(text(second), output(2_000, "a.ts v2"));
	});

	it("drop an edit pi's replay would refuse, and the compaction still goes out", async () => {
		const pi = compacting();
		await asks(pi);
		const bad = await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v1"));
		const good = await turn(pi, "read", { path: "src/b.ts" }, output(2_000, "b.ts v1"));
		await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v2"));
		await turn(pi, "read", { path: "src/b.ts" }, output(2_000, "b.ts v2"));
		// pi's preview points the stale a.ts read at an entry that isn't there.
		const drafts = await pi.turnEnd({
			tokens: 172_000,
			preview: (context) => ({
				...context,
				contextEntries: context.contextEntries.map((e) => (e.sourceEntry.id === bad ? { ...e, sourceEntry: { ...e.sourceEntry, id: "nowhere" } } : e)),
			}),
		});
		assert.deepEqual(drafts.map((draft) => draft.type), ["compaction", "context_edit"]);
		assert.deepEqual([...edits(drafts).keys()], [good]);
		assert.deepEqual(readdirSync(pi.dir), [`${good}.txt`]);
		pi.commit(drafts);
		assert.equal(getLatestCompactionEntry(pi.session.getBranch())?.summary, compactionIn(drafts)?.summary);
	});

	it("are not drafted, and no copy is saved, when every writer fails", async () => {
		const pi = compacting([{ errorMessage: "overloaded" }]);
		await asks(pi);
		await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v1"));
		await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v2"));
		assert.deepEqual(await pi.turnEnd({ tokens: 172_000 }), []);
		assert.deepEqual(readdirSync(pi.dir), []);
	});
});

describe("the notice batch, at a boundary where a compaction lands", () => {
	it("is skipped: a jump from under notice to forced prunes the kept tail only", async () => {
		const pi = compacting(undefined, { settings: { compaction: { keepRecentTokens: 8_000 }, retry: { enabled: false } } });
		// Old bulk the notice batch would take, with 50K of newer tool output after it.
		await turn(pi, "bash", { command: "npm test" }, output(30_000, "test"));
		await turn(pi, "bash", { command: "cat a.log" }, output(25_000, "a"));
		await turn(pi, "bash", { command: "cat b.log" }, output(25_000, "b"));
		const first = await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v1"));
		await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v2"));
		const drafts = await pi.turnEnd({ tokens: 172_000 });
		assert.deepEqual(drafts.map((draft) => draft.type), ["compaction", "context_edit"]);
		assert.deepEqual([...edits(drafts).keys()], [first]);
		assert.deepEqual(pi.sent, []);
	});
});

describe("pi's working row", () => {
	it("reads `<trigger> · pruning old tool output…`, then `· writing Handoff…`, and is handed back after", async () => {
		const pi = compacting();
		await asks(pi);
		await pi.turnEnd({ tokens: 172_400 });
		assert.deepEqual(pi.working, [
			"Compacting at 172k (forced) · pruning old tool output…",
			"Compacting at 172k (forced) · writing Handoff…",
			undefined,
		]);
	});
});

describe("a compaction another extension's draft sank", () => {
	/** A neighbour's draft pi won't replay: an edit of an entry that doesn't exist. */
	const BAD: SessionBoundaryDraft = { type: "context_edit", targetId: "no-such-entry", replacement: { content: [{ type: "text", text: "x" }] } };

	it("is re-drafted with its kept tail's edits, which replay after it", async () => {
		const pi = compacting();
		await asks(pi);
		const first = await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v1"));
		await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v2"));
		assert.deepEqual(await pi.turnEnd({ tokens: 172_000, entries: [BAD] }), []);
		const written = pi.script.calls.length;

		const drafts = await pi.turnEnd({ tokens: 173_000 });
		assert.deepEqual(drafts.map((draft) => draft.type), ["compaction", "context_edit"]);
		assert.deepEqual([...edits(drafts).keys()], [first]);
		assert.equal(pi.script.calls.length, written);
		pi.commit(drafts);
		assert.equal(readFileSync(join(pi.dir, `${first}.txt`), "utf8"), output(2_000, "a.ts v1"));
	});

	it("re-checks those edits against the branch as it stands, dropping one whose target has left it", async () => {
		const pi = compacting();
		await asks(pi);
		const fork = pi.session.getLeafId()!;
		// A stale read in the kept tail, after the point the branch goes back to.
		const a = await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v1"));
		await turn(pi, "read", { path: "src/a.ts" }, output(2_000, "a.ts v2"));
		assert.deepEqual(await pi.turnEnd({ tokens: 172_000, entries: [BAD] }), []);
		// Edits are planned at the boundary that sank; then the branch moves back.
		pi.session.branch(fork);

		const drafts = await pi.turnEnd({ tokens: 173_000 });
		assert.ok(compactionIn(drafts), "the compaction was drafted again");
		assert.equal(edits(drafts).has(a), false);
		pi.commit(drafts);
	});
});
