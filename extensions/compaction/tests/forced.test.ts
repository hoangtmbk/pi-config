/**
 * Forced compaction at the turn boundary: what `turn_end` does once Context
 * pressure reaches the forced Pressure level — compacts there, without ending
 * the run, with our Handoff and pi's own cut — and the guards around it.
 *
 * Driven only through the recording fake pi, with the model call scripted: a
 * test builds a session out of turns, takes pressure to forced, and reads back
 * the drafts the boundary returned, what the user was shown and what the
 * writer was asked. pi's own preparation for `/compact` stands as the oracle
 * for the cut.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findCutPoint, getLatestCompactionEntry, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
// pi's own preparation for `/compact` and its measure of the context, reached
// by path as the fake reaches them: what a forced compaction must agree with.
import {
	estimateProjectedContextTokens,
	prepareCompaction,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { registerCompaction } from "../index.ts";
import { aborted, calling, type FakeSetup, failed, fakePi, result, said, user } from "./fake-pi.ts";
import { type Reply, scriptModel } from "./scripted-model.ts";

/** pi's summarizer's reply. */
const PI_SUMMARY = "## Goal\nAdd retries to the fetcher.\n\n## Progress\n- Wrote the wrapper.";

/** What the forked call and serialized mode get here: a reply neither can use, so that pi's summarizer, last in the chain, writes. */
const NO_HANDOFF: Reply = { text: "I'll carry on with the fetcher." };

/** A small kept tail, so a short session has something to remove. */
const KEEP = 400;

const SETUP: FakeSetup = { settings: { compaction: { keepRecentTokens: KEEP }, retry: { enabled: false } } };

/**
 * A fake pi with the extension on it, and pi's summarizer scripted to answer
 * each compaction with the next of `replies`. Each compaction is three model
 * calls: the forked call's and serialized mode's, which fail, and then pi's
 * summarizer's.
 */
function forcing(replies: Reply[], setup: FakeSetup = SETUP) {
	const model = scriptModel(...replies.flatMap((reply) => [NO_HANDOFF, NO_HANDOFF, reply]));
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

/** Our compaction among a boundary's drafts. */
function compactionIn(drafts: SessionBoundaryDraft[]) {
	return drafts.find((draft): draft is Extract<SessionBoundaryDraft, { type: "compaction" }> => draft.type === "compaction");
}

/** pi's own cut for the branch as it stands, with the kept tail `keep`. */
function pisCut(pi: ReturnType<typeof fakePi>, keep = KEEP): string | undefined {
	return prepareCompaction(pi.session.getBranch(), { enabled: true, reserveTokens: 16_384, keepRecentTokens: keep })?.firstKeptEntryId;
}

describe("at the forced level", () => {
	it("compacts at the first boundary at or above forced, with our Handoff and pi's own cut", async () => {
		const { pi, model } = forcing([{ text: PI_SUMMARY }]);
		await history(pi);
		const drafts = await pi.turnEnd({ tokens: 172_000 });

		const compaction = compactionIn(drafts);
		assert.ok(compaction, "a compaction was drafted");
		assert.equal(compaction.firstKeptEntryId, pisCut(pi));
		assert.equal((compaction.details as any).kind, "handoff");
		assert.equal((compaction.details as any).writer, "pi-default");
		assert.match(compaction.summary, /Add retries to the fetcher\./);
		// About 165 tokens an exchange: a 400-token tail keeps asks 2 to 4, and removes ask 1.
		assert.deepEqual((compaction.details as any).userMessages.map((text: string) => text.split(" x")[0]), ["ask 1"]);
		assert.equal(model.calls.length, 3);
		assert.deepEqual(pi.sent, []);
		assert.deepEqual(pi.errors, []);
	});

	it("compacts at the turn that ends the run too", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }]);
		await history(pi);
		const drafts = await pi.turnEnd({ tokens: 172_000, message: said("All done.") });
		assert.equal(compactionIn(drafts)?.firstKeptEntryId, pisCut(pi));
	});

	it("skips the notice and warning steers and the warning toast as moot, and they stay crossed", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }]);
		await history(pi);
		assert.ok(compactionIn(await pi.turnEnd({ tokens: 175_000 })));
		await pi.turnEnd({ tokens: 160_000 });
		await pi.turnEnd({ tokens: 130_000 });
		assert.deepEqual(pi.sent, []);
		assert.deepEqual(
			pi.notifications.filter((n) => n.message.startsWith("Context at")),
			[],
		);
	});

	it("does nothing on a turn the provider failed, however high the reading", async () => {
		const { pi, model } = forcing([]);
		await history(pi);
		assert.deepEqual(await pi.turnEnd({ tokens: 175_000, message: failed() }), []);
		assert.equal(model.calls.length, 0);
	});
});

describe("the kept tail", () => {
	it("is pi's `keepRecentTokens` for the model in use, its override included", async () => {
		const settings = { compaction: { keepRecentTokens: 5_000, modelOverrides: { "anthropic/fable-5": { keepRecentTokens: 200 } } }, retry: { enabled: false } };
		const { pi } = forcing([{ text: PI_SUMMARY }], { settings });
		await history(pi, 6);
		const compaction = compactionIn(await pi.turnEnd({ tokens: 172_000 }));
		assert.equal(compaction?.firstKeptEntryId, pisCut(pi, 200));
		assert.notEqual(compaction?.firstKeptEntryId, pisCut(pi, 5_000));
	});

	it("counts a pruned tool result at its pruned size, as pi's own cut does", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }]);
		await history(pi);
		// A big result inside the would-be tail, already replaced by a marker.
		const run = calling("bash", { command: "npm test" });
		await pi.turnEnd({ tokens: 60_000, message: run, toolResults: [result(run, words(2_000, "log"))] });
		const big = pi.session.getBranch().at(-1)!.id;
		pi.session.appendContextEdit(big, { content: [{ type: "text", text: "[Pruned: output of `npm test`]" }] });
		pi.session.appendMessage(user(words(100, "ask 5")));

		const compaction = compactionIn(await pi.turnEnd({ tokens: 172_000 }));
		assert.equal(compaction?.firstKeptEntryId, pisCut(pi));
		// Sized raw, the 2,000-token log alone would fill the tail.
		const raw = pi.session.getBranch();
		assert.notEqual(compaction?.firstKeptEntryId, raw[findCutPoint(raw, 0, raw.length, KEEP).firstKeptEntryIndex]?.id);
	});

	it("starts after the previous compaction, whose kept tail is cut again", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }, { text: PI_SUMMARY }]);
		await history(pi);
		pi.commit(await pi.turnEnd({ tokens: 172_000 }));
		await history(pi, 3);
		const second = compactionIn(await pi.turnEnd({ tokens: 171_000 }));
		assert.equal(second?.firstKeptEntryId, pisCut(pi));
		assert.equal((second?.details as any).compactionNo, 2);
	});
});

describe("the drafts", () => {
	it("go after the ones earlier extensions proposed, which are kept", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }]);
		await history(pi);
		const theirs: SessionBoundaryDraft = { type: "custom_message", customType: "other", content: "hello", display: false };
		const drafts = await pi.turnEnd({ tokens: 172_000, entries: [theirs] });
		assert.deepEqual(drafts.map((draft) => draft.type), ["custom_message", "compaction"]);
		assert.equal(drafts[0], theirs);
	});

	it("are not added to a boundary where an earlier extension already compacts", async () => {
		const { pi, model } = forcing([]);
		await history(pi);
		const theirs: SessionBoundaryDraft = { type: "compaction", summary: "theirs", firstKeptEntryId: null };
		assert.deepEqual(await pi.turnEnd({ tokens: 172_000, entries: [theirs] }), [theirs]);
		assert.equal(model.calls.length, 0);
	});

	it("measure the context as it was before our compaction, which pi records as its size", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }]);
		await history(pi);
		const drafts = await pi.turnEnd({ tokens: 172_000 });
		const before = estimateProjectedContextTokens(pi.session.buildSessionProjection(), pi.session.getBranch()).tokens;
		pi.commit(drafts);
		const entry = getLatestCompactionEntry(pi.session.getBranch());
		assert.equal(entry?.tokensBefore, before);
		assert.equal(entry?.fromHook, true);
	});
});

describe("the run, after a forced compaction", () => {
	it("carries on from the Handoff and the kept tail, in the same run", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }]);
		await history(pi);
		const drafts = await pi.turnEnd({ tokens: 172_000 });
		const last = pi.session.getLeafId();
		pi.commit(drafts);
		// What the next request of the run is built from: the Handoff, then the tail.
		const [first, ...rest] = pi.session.buildSessionProjection().messages.filter((m) => m.role !== "system");
		assert.equal(first?.role, "compactionSummary");
		assert.equal(rest.at(-1), pi.session.getEntry(last!)?.type === "message" ? (pi.session.getEntry(last!) as any).message : undefined);
		// The next boundary of the same run goes on as usual.
		await pi.turnEnd({ tokens: 45_000 });
		assert.equal(pi.status(), undefined);
		assert.deepEqual(pi.errors, []);
	});
});

describe("`compaction.enabled: false`", () => {
	const OFF: FakeSetup = { settings: { compaction: { enabled: false, keepRecentTokens: KEEP }, retry: { enabled: false } } };

	it("turns off forced only: notice, warning, their steers and the toast go on", async () => {
		const { pi, model } = forcing([], OFF);
		await history(pi);
		await pi.turnEnd({ tokens: 125_000 });
		assert.deepEqual(await pi.turnEnd({ tokens: 175_000 }), []);
		assert.deepEqual(await pi.turnEnd({ tokens: 190_000 }), []);
		assert.equal(model.calls.length, 0);
		assert.deepEqual(
			pi.sent.map((m) => (m.details as { level: string }).level),
			["notice", "warning"],
		);
		// Nothing will be forced, so the toast doesn't say when.
		assert.deepEqual(pi.notifications, [
			{ message: "Context at 175k (warning). The agent has been told it's a good time to compact.", type: "warning" },
		]);
		assert.equal(pi.status(), "<warning>ctx warning · 190k</warning>");
	});

	it("leaves /compact and our Handoff on it alone", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }], OFF);
		await history(pi);
		assert.ok((await pi.compact())?.entryId);
	});
});

describe("the warning-pause guard", () => {
	const LEFT_HIGH = "Compaction left context at 158k, still above warning. Forced compaction is paused until it drops.";

	it("tells the user when a forced compaction leaves pressure at or above warning, and holds forcing until it drops below", async () => {
		const { pi, model } = forcing([{ text: PI_SUMMARY }, { text: PI_SUMMARY }]);
		await history(pi);
		pi.commit(await pi.turnEnd({ tokens: 172_000 }));
		pi.session.appendMessage(user(words(150, "ask 5")));
		await pi.turnEnd({ tokens: 158_000 });
		assert.ok(pi.notifications.some((n) => n.message === LEFT_HIGH && n.type === "warning"));
		assert.deepEqual(await pi.turnEnd({ tokens: 175_000 }), []);
		assert.equal(model.calls.length, 3);
		// Below warning, forcing is armed again.
		await pi.turnEnd({ tokens: 149_000 });
		assert.ok(compactionIn(await pi.turnEnd({ tokens: 171_000 })));
		assert.equal(model.calls.length, 6);
	});

	it("goes on after /compact or pi's backstop too", async () => {
		const { pi, model } = forcing([{ text: PI_SUMMARY }]);
		await history(pi);
		await pi.compact({ reason: "threshold" });
		await pi.turnEnd({ tokens: 158_000 });
		assert.ok(pi.notifications.some((n) => n.message === LEFT_HIGH));
		assert.deepEqual(await pi.turnEnd({ tokens: 175_000 }), []);
		assert.equal(model.calls.length, 3);
	});

	it("stays off after a compaction that brought pressure under warning", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }]);
		await history(pi);
		pi.commit(await pi.turnEnd({ tokens: 172_000 }));
		await pi.turnEnd({ tokens: 60_000 });
		assert.deepEqual(
			pi.notifications.filter((n) => n.message.startsWith("Compaction left")),
			[],
		);
	});

	it("is not set off by a compaction pi never committed", async () => {
		// Another extension's bad draft sinks the whole boundary, ours included.
		const { pi } = forcing([{ text: PI_SUMMARY }, { text: PI_SUMMARY }]);
		await history(pi);
		await pi.turnEnd({ tokens: 172_000 });
		assert.ok(compactionIn(await pi.turnEnd({ tokens: 173_000 })));
		assert.deepEqual(
			pi.notifications.filter((n) => n.message.startsWith("Compaction left")),
			[],
		);
	});
});

describe("when every writer fails", () => {
	const FAILED = "Compaction failed (Summarization failed: overloaded). Context will keep growing until the next run or pi's own compaction.";

	it("compacts nothing, says why, and disarms forced for the rest of the run", async () => {
		const { pi, model } = forcing([{ errorMessage: "overloaded" }, { text: PI_SUMMARY }]);
		await history(pi);
		assert.deepEqual(await pi.turnEnd({ tokens: 172_000 }), []);
		assert.deepEqual(pi.notifications, [{ message: FAILED, type: "error" }]);
		assert.deepEqual(await pi.turnEnd({ tokens: 175_000 }), []);
		assert.deepEqual(await pi.turnEnd({ tokens: 178_000, message: said("Done.") }), []);
		assert.equal(model.calls.length, 3);
		// The status says where pressure stands, as it did before the attempt.
		assert.equal(pi.status(), "<warning>ctx warning · 178k</warning>");
	});

	it("re-arms forced at the next run", async () => {
		const { pi, model } = forcing([{ errorMessage: "overloaded" }, { text: PI_SUMMARY }]);
		await history(pi);
		await pi.turnEnd({ tokens: 172_000, message: said("Done.") });
		await pi.startRun();
		assert.ok(compactionIn(await pi.turnEnd({ tokens: 174_000 })));
		assert.equal(model.calls.length, 6);
	});
});

describe("Escape during the writer chain", () => {
	it("compacts nothing, says nothing, and leaves forced armed for the next run", async () => {
		const { pi, model } = forcing([{ text: PI_SUMMARY, during: () => pi.escape() }, { text: PI_SUMMARY }]);
		await history(pi);
		assert.deepEqual(await pi.turnEnd({ tokens: 172_000 }), []);
		assert.deepEqual(pi.notifications, []);
		// pi goes round once more into an aborted stream, and that ends the run.
		await pi.turnEnd({ message: aborted() });
		await pi.startRun();
		assert.ok(compactionIn(await pi.turnEnd({ tokens: 173_000 })));
		assert.equal(model.calls.length, 6);
	});
});

describe("what the user sees", () => {
	it("pi's working row says why while the Handoff is written, and is handed back after", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }]);
		await history(pi);
		await pi.turnEnd({ tokens: 172_400 });
		assert.deepEqual(pi.working, [
			"Compacting at 172k (forced) · pruning old tool output…",
			"Compacting at 172k (forced) · writing Handoff…",
			undefined,
		]);
	});

	it("the status is cleared while compacting, and stays clear after a compaction", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }]);
		await history(pi);
		await pi.turnEnd({ tokens: 160_000 });
		await pi.turnEnd({ tokens: 172_000 });
		assert.deepEqual(
			pi.statuses.map((s) => s.text),
			["<warning>ctx warning · 160k</warning>", undefined],
		);
	});

	it("the status comes back after a compaction only once pressure is still at or above notice", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }]);
		await history(pi);
		pi.commit(await pi.turnEnd({ tokens: 172_000 }));
		await pi.turnEnd({ tokens: 60_000 });
		assert.equal(pi.status(), undefined);
		await pi.turnEnd({ tokens: 125_000 });
		assert.equal(pi.status(), "<muted>ctx notice · 125k</muted>");
	});

	it("in a Run, the status reads `ctx compacting` while it writes", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }], { ...SETUP, mode: "rpc" });
		await history(pi);
		await pi.turnEnd({ tokens: 172_000 });
		assert.deepEqual(
			pi.statuses.map((s) => s.text),
			["ctx compacting", undefined],
		);
	});

	it("pi's default summary having written the Handoff is a warning, as on the hook path", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }]);
		await history(pi);
		await pi.turnEnd({ tokens: 172_000 });
		assert.deepEqual(pi.notifications, [{ message: "Compaction used pi's default summary; the Handoff may be thinner.", type: "warning" }]);
	});
});
