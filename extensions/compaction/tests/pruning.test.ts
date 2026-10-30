/**
 * The notice Pruning batch: at the first `turn_end` at or above notice, old
 * bulky tool output and superseded reads are replaced with a one-line marker
 * pointing at a saved full copy — if that frees enough to be worth the cache
 * miss — and the notice steer is decided on what is left.
 *
 * Driven only through the recording fake pi: a test builds a session out of
 * turns, crosses notice, and reads back the drafts the boundary returned, the
 * steers sent and the files saved. The pruned-copy folder is a temp dir.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type SessionBoundaryDraft, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { registerCompaction } from "../index.ts";
import { calling, type FakeSetup, fakePi, MODEL, result } from "./fake-pi.ts";

const folders: string[] = [];

/** A fresh, empty folder for pruned copies, removed after the test. */
function folder(): string {
	const dir = mkdtempSync(join(tmpdir(), "compaction-pruned-"));
	folders.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake pi whose pruned copies land in a temp dir. */
function pruningPi(setup: FakeSetup = {}, dir = folder()) {
	const pi = fakePi(setup, (api) => registerCompaction(api, { prunedDir: dir }));
	return Object.assign(pi, { dir });
}

/** Output of exactly `tokens` tokens (pi counts four characters to one), in 100-character lines. */
function output(tokens: number, tag = "out"): string {
	const lines: string[] = [];
	for (let i = 1; lines.length * 101 < tokens * 4; i++) lines.push(`${tag} line ${i} `.padEnd(100, "."));
	return lines.join("\n").slice(0, tokens * 4);
}

/** A turn that ran one tool and got `text` back, below notice. */
function ran(name: string, args: Record<string, unknown>, text: string, isError = false) {
	const message = calling(name, args);
	return { tokens: 60_000, message, toolResults: [result(message, text, isError)] };
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

/** Commit a boundary's edits to the session, as pi does once the chain is done. Throws where pi's replay would. */
function commit(pi: ReturnType<typeof fakePi>, drafts: SessionBoundaryDraft[]): void {
	for (const draft of drafts) if (draft.type === "context_edit") pi.session.appendContextEdit(draft.targetId, draft.replacement);
}

/** The session entry id of the newest tool result. */
function lastResultId(pi: ReturnType<typeof fakePi>): string {
	const entry = [...pi.session.getBranch()].reverse().find((e) => e.type === "message" && e.message.role === "toolResult");
	if (!entry) throw new Error("no tool result yet");
	return entry.id;
}

describe("the notice batch", () => {
	it("replaces old bulk output with a marker pointing at a saved copy, at the first turn at notice", async () => {
		const pi = pruningPi();
		await pi.turnEnd(ran("bash", { command: "npm test" }, output(30_000, "test")));
		const old = lastResultId(pi);
		await pi.turnEnd(ran("bash", { command: "cat a.log" }, output(25_000, "a")));
		await pi.turnEnd(ran("bash", { command: "cat b.log" }, output(25_000, "b")));
		const drafts = await pi.turnEnd({ tokens: 125_000 });

		const path = join(pi.dir, `${old}.txt`);
		const text = edits(drafts).get(old);
		assert.ok(text, "the old output is pruned");
		assert.equal(text.split("\n")[0], `[Pruned: output of \`npm test\` (${output(30_000, "test").length.toLocaleString("en-US")} chars, exit 0). Full output: ${path}]`);
		assert.equal(readFileSync(path, "utf8"), output(30_000, "test"));
		// The two newer outputs sit inside the protected window.
		assert.equal(edits(drafts).size, 1);
	});
});

const NOTICE_STEER =
	"This is a good point to Self-compact at your next natural break, such as after finishing the current step. Finish what you are doing first. Don't shorten or skip work.";

/**
 * Three turns whose first result, `tokens` big, is old bulk: two 25K outputs
 * fill the protected window after it. Pressure reads `at` throughout.
 */
async function history(pi: ReturnType<typeof fakePi>, tokens: number, tag = "test", at = 60_000): Promise<string> {
	await pi.turnEnd({ ...ran("bash", { command: "npm test" }, output(tokens, tag)), tokens: at });
	const old = lastResultId(pi);
	await pi.turnEnd({ ...ran("bash", { command: "cat a.log" }, output(25_000, `${tag}-a`)), tokens: at });
	await pi.turnEnd({ ...ran("bash", { command: "cat b.log" }, output(25_000, `${tag}-b`)), tokens: at });
	return old;
}

describe("whether the batch goes out", () => {
	it("sends nothing when it would free under 20K, and the notice steer goes out as usual", async () => {
		const pi = pruningPi();
		await history(pi, 19_000);
		const drafts = await pi.turnEnd({ tokens: 125_000 });
		assert.deepEqual(drafts, []);
		assert.deepEqual(pi.sent.map((m) => m.content), [NOTICE_STEER]);
		assert.equal(pi.status(), "<muted>ctx notice · 125k</muted>");
	});

	it("sends no steer when what it frees brings pressure back under notice, and notice re-arms", async () => {
		const pi = pruningPi();
		await history(pi, 30_000);
		const drafts = await pi.turnEnd({ tokens: 125_000 });
		assert.equal(edits(drafts).size, 1);
		assert.deepEqual(pi.sent, []);
		// The footer follows the reading the steer was judged on: back under notice.
		assert.equal(pi.status(), undefined);
		// Notice re-armed: the next crossing is a crossing, with a batch of its own.
		await history(pi, 30_000, "again");
		const again = await pi.turnEnd({ tokens: 121_000 });
		assert.ok(edits(again).size > 0);
	});

	it("treats the next reading at or above notice as a fresh crossing, once the batch has brought pressure under it", async () => {
		const pi = pruningPi();
		await history(pi, 30_000);
		commit(pi, await pi.turnEnd({ tokens: 125_000 }));
		assert.equal(pi.sent.length, 0);
		// Nothing is left to prune, so this crossing steers.
		await pi.turnEnd({ tokens: 121_000 });
		assert.deepEqual(pi.sent.map((m) => m.content), [NOTICE_STEER]);
	});

	it("still steers when pressure stays at or above notice after it", async () => {
		const pi = pruningPi();
		await history(pi, 21_000);
		// About 20.7K freed from 145K leaves the reading at about 124K.
		const drafts = await pi.turnEnd({ tokens: 145_000 });
		assert.equal(edits(drafts).size, 1);
		assert.deepEqual(pi.sent.map((m) => m.content), [NOTICE_STEER]);
		assert.equal(pi.status(), "<muted>ctx notice · 124k</muted>");
	});

	it("runs once per crossing: not on the turns spent above notice after it", async () => {
		const pi = pruningPi();
		await history(pi, 19_000);
		await pi.turnEnd({ tokens: 125_000 });
		await history(pi, 30_000, "later", 130_000);
		assert.deepEqual(pi.boundaries.flat(), []);
	});

	it("never runs at warning, even on a jump from under notice", async () => {
		const pi = pruningPi();
		await history(pi, 30_000);
		assert.deepEqual(await pi.turnEnd({ tokens: 152_000 }), []);
		assert.deepEqual(await pi.turnEnd({ tokens: 175_000 }), []);
	});

	it("never runs on an ordinary turn below notice", async () => {
		const pi = pruningPi();
		await history(pi, 30_000);
		await pi.turnEnd({ tokens: 119_000 });
		assert.deepEqual(pi.boundaries.flat(), []);
	});

	it("runs at the scaled notice on a small window", async () => {
		// On a 128K window with pi's default reserve, notice scales to 66,970 and warning to 83,712.
		const pi = pruningPi({ model: { ...MODEL, provider: "openai", id: "mini-4", contextWindow: 128_000 } as Model<any> });
		await history(pi, 30_000, "test", 40_000);
		assert.deepEqual(await pi.turnEnd({ tokens: 66_969 }), []);
		await pi.turnEnd({ tokens: 40_000 });
		assert.equal(edits(await pi.turnEnd({ tokens: 70_000 })).size, 1);
		assert.equal(pi.sent.length, 0);
	});
});

describe("what the batch picks", () => {
	it("leaves alone everything inside the newest 40K tokens of tool output, a result straddling its edge included", async () => {
		const pi = pruningPi();
		await pi.turnEnd(ran("bash", { command: "npm test" }, output(30_000, "old")));
		await pi.turnEnd(ran("bash", { command: "cat a.log" }, output(39_000, "a")));
		// 39K newer than the old output, plus the crossing turn's own small result: under 40K.
		assert.deepEqual(await pi.turnEnd({ tokens: 125_000 }), []);
	});

	it("takes no result of 1K tokens or under as old bulk, however many there are", async () => {
		const pi = pruningPi();
		for (let i = 0; i < 40; i++) await pi.turnEnd(ran("bash", { command: `cat ${i}.log` }, output(1_000, `f${i}`)));
		await pi.turnEnd(ran("bash", { command: "cat a.log" }, output(25_000, "a")));
		await pi.turnEnd(ran("bash", { command: "cat b.log" }, output(25_000, "b")));
		assert.deepEqual(await pi.turnEnd({ tokens: 125_000 }), []);
	});

	it("takes a result just over 1K tokens as old bulk", async () => {
		const pi = pruningPi();
		for (let i = 0; i < 40; i++) await pi.turnEnd(ran("bash", { command: `cat ${i}.log` }, output(1_100, `f${i}`)));
		await pi.turnEnd(ran("bash", { command: "cat a.log" }, output(25_000, "a")));
		await pi.turnEnd(ran("bash", { command: "cat b.log" }, output(25_000, "b")));
		assert.equal(edits(await pi.turnEnd({ tokens: 125_000 })).size, 40);
	});

	it("leaves alone a result that has been edited since pi recorded it, by us or by another extension", async () => {
		const pi = pruningPi();
		const old = await history(pi, 30_000);
		pi.session.appendContextEdit(old, { content: [{ type: "text", text: output(29_000, "theirs") }] });
		assert.deepEqual(await pi.turnEnd({ tokens: 125_000 }), []);
	});

	it("never prunes Questions, Runs, self_compact or errors, however old and bulky", async () => {
		const pi = pruningPi();
		for (const name of ["ask_question", "subagent", "subagent_wait", "subagent_answer", "self_compact"]) {
			await pi.turnEnd(ran(name, { task: "x" }, output(30_000, name)));
		}
		await pi.turnEnd(ran("bash", { command: "npm test" }, output(30_000, "failing"), true));
		await pi.turnEnd(ran("bash", { command: "cat a.log" }, output(25_000, "a")));
		await pi.turnEnd(ran("bash", { command: "cat b.log" }, output(25_000, "b")));
		assert.deepEqual(await pi.turnEnd({ tokens: 125_000 }), []);
	});
});

describe("superseded reads", () => {
	/** A recent 25K read of `src/a.ts` — inside the protected window, so prunable only as superseded — then `then`. */
	async function readThen(pi: ReturnType<typeof fakePi>, ...then: ReturnType<typeof ran>[]): Promise<string> {
		await pi.turnEnd(ran("read", { path: "src/a.ts" }, output(25_000, "a.ts v1")));
		const first = lastResultId(pi);
		for (const turn of then) await pi.turnEnd(turn);
		return first;
	}

	it("prunes a read once the same file and range is read again, at any age", async () => {
		const pi = pruningPi();
		const first = await readThen(pi, ran("read", { path: "./src/a.ts" }, output(25_000, "a.ts v2")));
		const text = edits(await pi.turnEnd({ tokens: 125_000 })).get(first);
		assert.equal(text, `[Pruned: output of \`read src/a.ts\` (100,000 chars). Full output: ${join(pi.dir, `${first}.txt`)}]`);
	});

	it("prunes a read once the whole file is written", async () => {
		const pi = pruningPi();
		const first = await readThen(pi, ran("write", { path: "/work/src/a.ts", content: "new" }, "Successfully wrote to src/a.ts"));
		assert.ok(edits(await pi.turnEnd({ tokens: 125_000 })).has(first));
	});

	it("keeps a read that was only edited since: most of it stays true", async () => {
		const pi = pruningPi();
		await readThen(pi, ran("edit", { path: "src/a.ts", edits: [] }, "Successfully replaced 1 block"));
		assert.deepEqual(await pi.turnEnd({ tokens: 125_000 }), []);
	});

	it("keeps a read when the later one covers another range or another file", async () => {
		const pi = pruningPi();
		await readThen(
			pi,
			ran("read", { path: "src/a.ts", offset: 200, limit: 50 }, output(500, "a.ts part")),
			ran("read", { path: "src/b.ts" }, output(500, "b.ts")),
		);
		assert.deepEqual(await pi.turnEnd({ tokens: 125_000 }), []);
	});

	it("keeps a read when the later read or write failed, which changed nothing", async () => {
		const pi = pruningPi();
		await readThen(pi, ran("read", { path: "src/a.ts" }, "ENOENT", true), ran("write", { path: "src/a.ts", content: "x" }, "EACCES", true));
		assert.deepEqual(await pi.turnEnd({ tokens: 125_000 }), []);
	});
});

describe("the marker", () => {
	it("keeps a bash result's last 10 lines after it", async () => {
		const pi = pruningPi();
		const old = await history(pi, 30_000);
		const lines = edits(await pi.turnEnd({ tokens: 125_000 })).get(old)?.split("\n") ?? [];
		assert.equal(lines.length, 11);
		assert.match(lines[0] ?? "", /^\[Pruned: output of `npm test` \(120,000 chars, exit 0\)\. Full output: .*\]$/);
		// 120,000 characters in 101-character lines (newline included): 1,188
		// whole lines, then 12 characters of the next.
		assert.equal(lines[1], "test line 1180 ".padEnd(100, "."));
		assert.equal(lines[9], "test line 1188 ".padEnd(100, "."));
		assert.equal(lines[10], "test line 11");
	});

	it("is all that is left of any other tool's result, named by the tool and its first argument", async () => {
		const pi = pruningPi();
		await pi.turnEnd(ran("web_fetch", { url: "https://example.com/docs", format: "markdown" }, output(30_000, "page")));
		const old = lastResultId(pi);
		await pi.turnEnd(ran("bash", { command: "cat a.log" }, output(25_000, "a")));
		await pi.turnEnd(ran("bash", { command: "cat b.log" }, output(25_000, "b")));
		assert.equal(
			edits(await pi.turnEnd({ tokens: 125_000 })).get(old),
			`[Pruned: output of \`web_fetch https://example.com/docs\` (120,000 chars). Full output: ${join(pi.dir, `${old}.txt`)}]`,
		);
	});
});

describe("the saved copies", () => {
	it("go beside the session file, in a folder named for the session, when there is one", async () => {
		const sessionDir = folder();
		const session = SessionManager.create("/work", sessionDir);
		const pi = fakePi({ session });
		const old = await history(pi, 30_000);
		const text = edits(await pi.turnEnd({ tokens: 125_000 })).get(old) ?? "";
		const path = join(sessionDir, `${session.getSessionId()}.pruned`, `${old}.txt`);
		assert.ok(session.getSessionFile(), "the session has a file by notice");
		assert.ok(text.includes(`Full output: ${path}]`));
		assert.equal(readFileSync(path, "utf8"), output(30_000, "test"));
	});

	it("go under the OS temp directory, in a folder named for the session, when it has no file", async () => {
		const pi = fakePi();
		const dir = join(tmpdir(), `${pi.session.getSessionId()}.pruned`);
		folders.push(dir);
		const old = await history(pi, 30_000);
		await pi.turnEnd({ tokens: 125_000 });
		assert.equal(pi.session.getSessionFile(), undefined);
		assert.equal(readFileSync(join(dir, `${old}.txt`), "utf8"), output(30_000, "test"));
	});

	it("are written only for a batch that goes out", async () => {
		const pi = pruningPi();
		await history(pi, 19_000);
		await pi.turnEnd({ tokens: 125_000 });
		assert.deepEqual(readdirSync(pi.dir), []);
	});
});

describe("the drafts", () => {
	it("come after earlier extensions' drafts, which they never replace", async () => {
		const pi = pruningPi();
		const old = await history(pi, 30_000);
		const theirs: SessionBoundaryDraft = { type: "custom", customType: "other", data: { n: 1 } };
		const drafts = await pi.turnEnd({ tokens: 125_000, entries: [theirs] });
		assert.deepEqual(drafts[0], theirs);
		assert.deepEqual(
			drafts.slice(1).map((d) => d.type === "context_edit" && d.targetId),
			[old],
		);
	});

	it("replay in pi's own session: the result keeps its call, its id and its place, with only its content replaced", async () => {
		const pi = pruningPi();
		const old = await history(pi, 30_000);
		const before = pi.session.buildSessionProjection().messages.length;
		commit(pi, await pi.turnEnd({ tokens: 125_000 }));
		const projected = pi.session.buildSessionProjection();
		assert.equal(projected.messages.length, before + 2);
		const pruned = projected.entries.find((e) => e.sourceEntry.id === old)?.messages[0];
		assert.ok(pruned?.role === "toolResult");
		assert.equal(pruned.toolName, "bash");
		assert.equal(pruned.isError, false);
		assert.match(pruned.content[0]?.type === "text" ? pruned.content[0].text : "", /^\[Pruned: /);
	});

	it("are not drafted at a boundary where a compaction already lands", async () => {
		const pi = pruningPi();
		await history(pi, 30_000);
		const compaction: SessionBoundaryDraft = { type: "compaction", summary: "theirs", firstKeptEntryId: null };
		assert.deepEqual(await pi.turnEnd({ tokens: 125_000, entries: [compaction] }), [compaction]);
	});

	it("are not drafted at a turn the user aborted", async () => {
		const pi = pruningPi();
		await history(pi, 30_000);
		pi.escape();
		const call = calling("bash", { command: "npm test" });
		await pi.turnEnd({ tokens: 125_000, message: call, toolResults: [result(call, "Operation aborted", true)] });
		assert.deepEqual(pi.boundaries.flat(), []);
	});
});

describe("the edit checks", () => {
	/**
	 * Two old bulk outputs, each enough for a batch alone. pi's preview is made
	 * to point the older one at `target` — so its edit would fail pi's replay —
	 * while the newer stays good.
	 */
	async function withBadTarget(target: (pi: ReturnType<typeof pruningPi>, old: string) => string) {
		const pi = pruningPi();
		await pi.turnEnd(ran("bash", { command: "npm test" }, output(30_000, "first")));
		const bad = lastResultId(pi);
		const good = await history(pi, 30_000);
		const into = target(pi, bad);
		const drafts = await pi.turnEnd({
			tokens: 140_000,
			preview: (context) => ({
				...context,
				contextEntries: context.contextEntries.map((e) => (e.sourceEntry.id === bad ? { ...e, sourceEntry: { ...e.sourceEntry, id: into } } : e)),
			}),
		});
		return { pi, drafts, good, into };
	}

	for (const [rule, target] of [
		["is not found", () => "nowhere"],
		["is not on the active branch", (pi: ReturnType<typeof pruningPi>) => {
			// An entry on a branch left behind: pi still holds it, but not on the path being sent.
			const leaf = pi.session.getLeafId() ?? "";
			const elsewhere = pi.session.appendMessage(result(calling(), "elsewhere"));
			pi.session.branch(leaf);
			return elsewhere;
		}],
		["carries no editable content", (pi: ReturnType<typeof pruningPi>) => pi.session.appendCustomEntry("state", { n: 1 })],
	] as const) {
		it(`drops an edit whose target ${rule}, without sending it or saving its copy, and sends the rest`, async () => {
			const { pi, drafts, good, into } = await withBadTarget(target);
			assert.deepEqual([...edits(drafts).keys()], [good]);
			assert.deepEqual(readdirSync(pi.dir), [`${good}.txt`]);
			// What did go out replays cleanly in pi's own session.
			commit(pi, drafts);
			assert.throws(() => pi.session.appendContextEdit(into, { content: [{ type: "text", text: "x" }] }));
		});
	}
});
