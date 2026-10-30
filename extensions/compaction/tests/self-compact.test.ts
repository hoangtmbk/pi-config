/**
 * Self-compaction: the `self_compact` tool, with which the agent compacts at a
 * natural break, from notice up, and carries on in the same run.
 *
 * Driven only through the recording fake pi, with the model call scripted: a
 * test builds a session out of turns, has the agent call `self_compact`, and
 * reads back what crossed pi's boundary — the tool's result line, the
 * boundary's drafts and the Handoff in them, what the writer was asked, and
 * what the user was shown.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { registerCompaction, SELF_COMPACT_TOOL } from "../index.ts";
import type { SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { aborted, calling, type FakeSetup, fakePi, result, user } from "./fake-pi.ts";
import { type Reply, scriptModel } from "./scripted-model.ts";

/** A writer's reply in exactly the shape the instruction asks for. */
const HANDOFF = [
	"<handoff>",
	"## Goal",
	'Add retries to the fetcher. "Add retries to the fetcher."',
	"",
	"## Progress",
	"### Done",
	"- Wrote the wrapper in src/retry.ts.",
	"",
	"## Decisions and why",
	"(none)",
	"",
	"## Open problems",
	"(none)",
	"",
	"## Critical context",
	"- `npm test` runs the suite.",
	"",
	"## Next step",
	'Run the suite, then fix what fails. "Go ahead."',
	"</handoff>",
	"<ledger></ledger>",
].join("\n");

const COMPACTED = "Context compacted. The Handoff above carries the task; continue from its Next step.";
const FAILED = "Compaction failed; carry on, and it will be retried at the forced level.";

const NOTE ="Retries are wired into fetch.ts; next I run npm test and fix what fails.";

/** A small kept tail, so a short session has something to remove. */
const SETUP: FakeSetup = { settings: { compaction: { keepRecentTokens: 400 }, retry: { enabled: false } } };

/** A fake pi with the extension on it, its model call answering with `replies` in order. */
function selfCompacting(replies: Reply[] = [], setup: FakeSetup = SETUP) {
	const model = scriptModel(...replies);
	const pi = fakePi(setup, (api) => registerCompaction(api, { stream: model.stream }));
	return { pi, model };
}

/** Text of `tokens` tokens, as pi counts them (four characters to one). */
function words(tokens: number, tag: string): string {
	return `${tag} `.padEnd(tokens * 4, "x");
}

/** A few exchanges below notice: enough to be worth a cut. */
async function history(pi: ReturnType<typeof fakePi>, exchanges = 4): Promise<void> {
	for (let n = 1; n <= exchanges; n++) {
		pi.session.appendMessage(user(words(150, `ask ${n}`)));
		await pi.turnEnd({ tokens: 40_000 + n * 1_000 });
	}
}

/** The text of the one result a turn's tool call came back with. */
function resultText(pi: ReturnType<typeof fakePi>): string {
	const entry = pi.session.getBranch().at(-1)!;
	assert.equal(entry.type, "message");
	const message = (entry as { message: { role: string; content: { text?: string }[] } }).message;
	assert.equal(message.role, "toolResult");
	return message.content.map((part) => part.text ?? "").join("");
}

/** Our compaction among a boundary's drafts. */
function compactionIn(drafts: SessionBoundaryDraft[]) {
	return drafts.find((draft): draft is Extract<SessionBoundaryDraft, { type: "compaction" }> => draft.type === "compaction");
}

describe("the `self_compact` tool", () => {
	it("from notice up, writes the Handoff itself and says so, and that turn's boundary applies it", async () => {
		const { pi, model } = selfCompacting([{ text: HANDOFF }]);
		await history(pi);
		const drafts = await pi.turnEnd({ tokens: 125_000, message: calling(SELF_COMPACT_TOOL, { note: NOTE }) });
		assert.equal(resultText(pi), COMPACTED);
		assert.equal(model.calls.length, 1);
		const compaction = compactionIn(drafts);
		assert.ok(compaction, "a compaction was drafted");
		assert.equal((compaction.details as any).kind, "handoff");
		assert.equal((compaction.details as any).writer, "fork");
		assert.match(compaction.summary, /Add retries to the fetcher\./);
		assert.deepEqual(pi.errors, []);
	});

	it("refuses below notice, and says why", async () => {
		const { pi, model } = selfCompacting();
		await history(pi);
		const drafts = await pi.turnEnd({ tokens: 90_000, message: calling(SELF_COMPACT_TOOL, { note: NOTE }) });
		assert.equal(
			resultText(pi),
			"Not compacted: the context isn't large enough yet for a compaction to help. Carry on with the task; you'll be told when it's a good time.",
		);
		assert.deepEqual(drafts, []);
		assert.equal(model.calls.length, 0);
		assert.deepEqual(pi.working, []);
	});

	it("is declared with one required note, and no wording about running out or a limit", () => {
		const { pi } = selfCompacting();
		const tool = pi.tools.find((t) => t.name === SELF_COMPACT_TOOL) as any;
		assert.ok(tool, "self_compact is registered");
		assert.deepEqual(Object.keys(tool.parameters.properties), ["note"]);
		assert.deepEqual(tool.parameters.required, ["note"]);
		assert.equal(tool.parameters.properties.note.description, "What you're doing and what you'll do next, in your own words.");
		for (const text of [tool.description, tool.promptSnippet]) {
			assert.ok(text);
			assert.doesNotMatch(text, /running out|limit|\d/i);
		}
	});

	it("says it failed, compacts nothing and tells the user why, when every writer fails", async () => {
		const { pi } = selfCompacting([{ text: "I'll carry on." }, { text: "I'll carry on." }, { errorMessage: "overloaded" }]);
		await history(pi);
		const drafts = await pi.turnEnd({ tokens: 125_000, message: calling(SELF_COMPACT_TOOL, { note: NOTE }) });
		assert.equal(resultText(pi), FAILED);
		assert.deepEqual(drafts, []);
		assert.deepEqual(pi.notifications, [
			{
				message: "Compaction failed (Summarization failed: overloaded). Context will keep growing until the next run or pi's own compaction.",
				type: "error",
			},
		]);
		// The status says where pressure stands, as it did before the attempt.
		assert.equal(pi.status(), "<muted>ctx notice · 125k</muted>");
	});

	it("says it failed when Escape stops it mid-write, with nothing compacted, no toast, and forced still armed", async () => {
		const { pi, model } = selfCompacting([{ text: HANDOFF, during: () => pi.escape() }, { text: HANDOFF }]);
		await history(pi);
		assert.deepEqual(await pi.turnEnd({ tokens: 125_000, message: calling(SELF_COMPACT_TOOL, { note: NOTE }) }), []);
		assert.equal(resultText(pi), FAILED);
		assert.deepEqual(pi.notifications, []);
		await pi.turnEnd({ message: aborted() });
		await pi.startRun();
		assert.ok(compactionIn(await pi.turnEnd({ tokens: 172_000 })));
		assert.equal(model.calls.length, 2);
	});

	it("in a Run, says compacting while it writes, and no longer once Escape has stopped it", async () => {
		const { pi } = selfCompacting([{ text: HANDOFF, during: () => pi.escape() }], { ...SETUP, mode: "rpc" });
		await history(pi);
		await pi.turnEnd({ tokens: 125_000, message: calling(SELF_COMPACT_TOOL, { note: NOTE }) });
		assert.equal(resultText(pi), FAILED);
		assert.ok(pi.statuses.some((s) => s.text === "ctx compacting"), "the status said compacting while it wrote");
		// Back as it stood before the call, the last reading being below notice.
		assert.equal(pi.status(), undefined);
	});

	it("lands at that turn's boundary in place of the notice Pruning batch and steer", async () => {
		const { pi } = selfCompacting([{ text: HANDOFF }]);
		await history(pi);
		// Old bulky output that a notice batch would prune, and enough newer output to put it outside the protected window.
		for (const [log, size] of [["old.log", 30_000], ["a.log", 25_000], ["b.log", 25_000]] as const) {
			const run = calling("bash", { command: `cat ${log}` });
			await pi.turnEnd({ tokens: 60_000, message: run, toolResults: [result(run, words(size, log))] });
		}
		const drafts = await pi.turnEnd({ tokens: 125_000, message: calling(SELF_COMPACT_TOOL, { note: NOTE }) });
		assert.deepEqual(drafts.map((draft) => draft.type), ["compaction"]);
		assert.deepEqual(pi.sent, []);
	});

	it("prunes a superseded read in the kept tail, its edit going out after the compaction", async () => {
		const dir = mkdtempSync(join(tmpdir(), "compaction-self-"));
		try {
			const model = scriptModel({ text: HANDOFF });
			const settings = { compaction: { keepRecentTokens: 30_000 }, retry: { enabled: false } };
			const pi = fakePi({ settings }, (api) => registerCompaction(api, { stream: model.stream, prunedDir: dir }));
			for (let n = 1; n <= 4; n++) {
				pi.session.appendMessage(user(words(12_000, `ask ${n}`)));
				await pi.turnEnd({ tokens: 40_000 + n * 1_000 });
			}
			const reads: string[] = [];
			for (const version of ["v1", "v2"]) {
				const read = calling("read", { path: "src/a.ts" });
				await pi.turnEnd({ tokens: 60_000, message: read, toolResults: [result(read, words(2_000, `a.ts ${version}`))] });
				reads.push(pi.session.getBranch().at(-1)!.id);
			}
			const drafts = await pi.turnEnd({ tokens: 125_000, message: calling(SELF_COMPACT_TOOL, { note: NOTE }) });
			assert.equal(resultText(pi), COMPACTED);
			assert.deepEqual(drafts.map((draft) => draft.type), ["compaction", "context_edit"]);
			const edit = drafts[1] as Extract<SessionBoundaryDraft, { type: "context_edit" }>;
			assert.equal(edit.targetId, reads[0]);
			assert.equal(readFileSync(join(dir, `${reads[0]}.txt`), "utf8"), words(2_000, "a.ts v1"));
			pi.commit(drafts);
			assert.deepEqual(pi.errors, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("pi's working row says Self-compacting while it prunes and writes, and is handed back after", async () => {
		const { pi } = selfCompacting([{ text: HANDOFF }]);
		await history(pi);
		await pi.turnEnd({ tokens: 125_000, message: calling(SELF_COMPACT_TOOL, { note: NOTE }) });
		assert.deepEqual(pi.working, ["Self-compacting · pruning old tool output…", "Self-compacting · writing Handoff…", undefined]);
	});
});

describe("the run, after a Self-compaction", () => {
	it("carries on from the Handoff and then the kept tail, which ends in its own self_compact call and result", async () => {
		const { pi } = selfCompacting([{ text: HANDOFF }]);
		await history(pi);
		const call = calling(SELF_COMPACT_TOOL, { note: NOTE });
		pi.commit(await pi.turnEnd({ tokens: 125_000, message: call }));
		const messages = pi.session.buildSessionProjection().messages.filter((m) => m.role !== "system");
		assert.equal(messages[0]?.role, "compactionSummary");
		const [calledIt, answer] = messages.slice(-2) as any[];
		assert.equal(calledIt, call);
		assert.equal(answer.role, "toolResult");
		assert.equal(answer.toolCallId, call.content[0]!.type === "toolCall" ? call.content[0]!.id : undefined);
		assert.equal(answer.content[0].text, COMPACTED);
		// The next boundary of the same run goes on as usual.
		await pi.turnEnd({ tokens: 45_000 });
		assert.equal(pi.status(), undefined);
		assert.deepEqual(pi.errors, []);
	});
});

describe("a Self-compaction another extension's draft sank", () => {
	it("is re-drafted at the next boundary, as written, without writing it again", async () => {
		const { pi, model } = selfCompacting([{ text: HANDOFF }]);
		await history(pi);
		// A neighbour's edit of an entry that doesn't exist: pi drops the whole boundary.
		const bad: SessionBoundaryDraft = { type: "context_edit", targetId: "no-such-entry", replacement: { content: [{ type: "text", text: "x" }] } };
		assert.deepEqual(await pi.turnEnd({ tokens: 125_000, message: calling(SELF_COMPACT_TOOL, { note: NOTE }), entries: [bad] }), []);
		const again = compactionIn(await pi.turnEnd({ tokens: 126_000 }));
		assert.equal((again?.details as any).note, NOTE);
		assert.equal(model.calls.length, 1);
	});
});

describe("the agent's note", () => {
	it("opens Next step verbatim, labelled as the agent's own, and the writer is asked to agree with it", async () => {
		const { pi, model } = selfCompacting([{ text: HANDOFF }]);
		await history(pi);
		const compaction = compactionIn(await pi.turnEnd({ tokens: 125_000, message: calling(SELF_COMPACT_TOOL, { note: `  ${NOTE}\n` }) }));
		assert.equal((compaction?.details as any).note, NOTE);
		const nextStep = compaction!.summary.slice(compaction!.summary.indexOf("## Next step"));
		assert.equal(nextStep, `## Next step\nAgent's note (verbatim): "${NOTE}"\n\nRun the suite, then fix what fails. "Go ahead."`);
		// The forked call is the agent itself: the note is its own.
		assert.match(
			model.prompt(0),
			new RegExp(`You called self_compact with this note: "${escape(NOTE)}"\\. Code puts it verbatim at the top of Next step\\. Write the rest of Next step to agree with it`),
		);
	});

	it("is restated to serialized mode as the agent's", async () => {
		const { pi, model } = selfCompacting([{ text: "I'll carry on." }, { text: HANDOFF }]);
		await history(pi);
		const compaction = compactionIn(await pi.turnEnd({ tokens: 125_000, message: calling(SELF_COMPACT_TOOL, { note: NOTE }) }));
		assert.equal((compaction?.details as any).writer, "serialized");
		assert.match(model.prompt(1), new RegExp(`The agent called self_compact with this note: "${escape(NOTE)}"\\. Code puts it verbatim at the top of Next step\\.`));
	});

	it("lasts for that compaction only: the next one neither carries it nor shows it to its writer", async () => {
		// The second compaction's forked call fails, so that serialized mode shows what the previous Handoff it edits holds.
		const { pi, model } = selfCompacting([{ text: HANDOFF }, { text: "I'll carry on." }, { text: HANDOFF }]);
		await history(pi);
		pi.commit(await pi.turnEnd({ tokens: 125_000, message: calling(SELF_COMPACT_TOOL, { note: NOTE }) }));
		await history(pi, 3);
		const next = compactionIn(await pi.turnEnd({ tokens: 172_000 }));
		assert.equal((next?.details as any).compactionNo, 2);
		assert.equal((next?.details as any).note, undefined);
		assert.ok(!next!.summary.includes(NOTE));
		assert.ok(!next!.summary.includes("Agent's note"));
		// The call itself is still in the conversation the writer reads; the previous Handoff it edits has no note.
		const previous = /<previous-handoff>\n([\s\S]*?)\n<\/previous-handoff>/.exec(model.prompt(2))?.[1];
		assert.ok(previous?.includes("## Next step\nRun the suite, then fix what fails."));
		assert.ok(!previous?.includes(NOTE));
		assert.ok(!model.prompt(2).includes("called self_compact with this note"));
		assert.ok(!model.prompt(1).includes("called self_compact with this note"));
	});

	it("can't be empty", async () => {
		const { pi, model } = selfCompacting();
		await history(pi);
		await pi.turnEnd({ tokens: 125_000, message: calling(SELF_COMPACT_TOOL, { note: "  " }) });
		assert.equal(resultText(pi), "A note cannot be empty. Say what you're doing and what you'll do next.");
		assert.equal(model.calls.length, 0);
	});
});

/** `text` as a regular expression matching it literally. */
function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
