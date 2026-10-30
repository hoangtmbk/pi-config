/**
 * Re-drafting a sunk compaction: when another extension's bad draft makes pi
 * drop a whole boundary, our compaction with it, the next boundary drafts the
 * same Handoff again, once, without writing it again.
 *
 * Driven only through the recording fake pi, which drops a boundary the way
 * pi does when any one of its drafts would not replay. A neighbour's bad draft
 * is one an earlier extension proposed, which ours is spread after.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getLatestCompactionEntry, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
// pi's own preparation for `/compact`, reached by path as the fake reaches it: the oracle for the cut.
import { prepareCompaction } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { registerCompaction } from "../index.ts";
import { aborted, type FakeSetup, fakePi, said, user } from "./fake-pi.ts";
import { type Reply, scriptModel } from "./scripted-model.ts";

/** pi's summarizer's reply, the only writer so far. */
const PI_SUMMARY = "## Goal\nAdd retries to the fetcher.\n\n## Progress\n- Wrote the wrapper.";

const KEEP = 400;

const SETUP: FakeSetup = { settings: { compaction: { keepRecentTokens: KEEP }, retry: { enabled: false } } };

/** A neighbour's draft pi won't replay: an edit of an entry that doesn't exist. */
const BAD: SessionBoundaryDraft = { type: "context_edit", targetId: "no-such-entry", replacement: { content: [{ type: "text", text: "x" }] } };

const FAILED_TWICE =
	"Compaction failed (pi dropped it twice, with another extension's invalid draft). Context will keep growing until the next run or pi's own compaction.";
const CUT_GONE =
	"Compaction failed (its kept tail is no longer on the branch). Context will keep growing until the next run or pi's own compaction.";

function forcing(replies: Reply[], setup: FakeSetup = SETUP) {
	const model = scriptModel(...replies);
	const pi = fakePi(setup, (api) => registerCompaction(api, { stream: model.stream }));
	return { pi, model };
}

function words(tokens: number, tag: string): string {
	return `${tag} `.padEnd(tokens * 4, "x");
}

async function history(pi: ReturnType<typeof fakePi>, exchanges = 4): Promise<void> {
	for (let n = 1; n <= exchanges; n++) {
		pi.session.appendMessage(user(words(150, `ask ${n}`)));
		await pi.turnEnd({ tokens: 40_000 + n * 1_000 });
	}
}

function compactionIn(drafts: SessionBoundaryDraft[]) {
	return drafts.find((draft): draft is Extract<SessionBoundaryDraft, { type: "compaction" }> => draft.type === "compaction");
}

/** The error toasts shown, which are what a compaction given up says. */
function errorsShown(pi: ReturnType<typeof fakePi>) {
	return pi.notifications.filter((n) => n.type === "error");
}

function pisCut(pi: ReturnType<typeof fakePi>): string | undefined {
	return prepareCompaction(pi.session.getBranch(), { enabled: true, reserveTokens: 16_384, keepRecentTokens: KEEP })?.firstKeptEntryId;
}

/** A forced compaction that a neighbour's draft sinks. Returns the cut it was drafted with. */
async function sunk(pi: ReturnType<typeof fakePi>): Promise<string | undefined> {
	await history(pi);
	assert.deepEqual(await pi.turnEnd({ tokens: 172_000, entries: [BAD] }), []);
	assert.ok(pi.errors.some((e) => e.error.startsWith("Invalid boundary entries")), "pi dropped the boundary");
	// Nothing was committed, so the branch is as the compaction was cut from it.
	return pisCut(pi);
}

describe("a compaction another extension's draft sank", () => {
	it("is re-drafted at the next boundary from the same Handoff, with no writer called again", async () => {
		const { pi, model } = forcing([{ text: PI_SUMMARY }, { text: PI_SUMMARY }]);
		const cut = await sunk(pi);
		const drafts = await pi.turnEnd({ tokens: 173_000 });
		const again = compactionIn(drafts);
		assert.ok(again, "the compaction was drafted again");
		assert.equal(again.firstKeptEntryId, cut);
		assert.equal((again.details as any).compactionNo, 1);
		assert.match(again.summary, /Add retries to the fetcher\./);
		assert.equal(model.calls.length, 1);
		// It lands, and the boundary after it doesn't draft it a third time.
		pi.commit(drafts);
		assert.equal((getLatestCompactionEntry(pi.session.getBranch())?.details as any).compactionNo, 1);
		assert.equal(compactionIn(await pi.turnEnd({ tokens: 60_000 })), undefined);
		assert.deepEqual(errorsShown(pi), []);
	});

	it("is re-drafted when the latest compaction on the branch is our previous one", async () => {
		const { pi, model } = forcing([{ text: PI_SUMMARY }, { text: PI_SUMMARY }, { text: PI_SUMMARY }]);
		await history(pi);
		pi.commit(await pi.turnEnd({ tokens: 172_000 }));
		await history(pi, 3);
		assert.deepEqual(await pi.turnEnd({ tokens: 171_000, entries: [BAD] }), []);
		const again = compactionIn(await pi.turnEnd({ tokens: 172_000 }));
		assert.equal((again?.details as any).compactionNo, 2);
		assert.equal(model.calls.length, 2);
	});

	it("is re-drafted after the drafts earlier extensions propose at that boundary, which stand", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }]);
		await sunk(pi);
		const theirs: SessionBoundaryDraft = { type: "custom_message", customType: "other", content: "hello", display: false };
		const drafts = await pi.turnEnd({ tokens: 173_000, entries: [theirs] });
		assert.deepEqual(drafts.map((draft) => draft.type), ["custom_message", "compaction"]);
	});

	it("is re-drafted whatever pressure reads at that boundary", async () => {
		const { pi } = forcing([{ text: PI_SUMMARY }]);
		await sunk(pi);
		assert.ok(compactionIn(await pi.turnEnd({ tokens: 130_000 })));
		assert.deepEqual(pi.sent, []);
	});

	it("sunk again, is given up as every writer failing: nothing compacted, an error toast, forced disarmed for the run", async () => {
		const { pi, model } = forcing([{ text: PI_SUMMARY }, { text: PI_SUMMARY }]);
		await sunk(pi);
		assert.deepEqual(await pi.turnEnd({ tokens: 173_000, entries: [BAD] }), []);
		assert.deepEqual(await pi.turnEnd({ tokens: 174_000 }), []);
		assert.deepEqual(errorsShown(pi), [{ message: FAILED_TWICE, type: "error" }]);
		assert.deepEqual(await pi.turnEnd({ tokens: 176_000, message: said("Done.") }), []);
		assert.equal(model.calls.length, 1);
		// A new run arms forced again, and writes a new Handoff.
		await pi.startRun();
		assert.ok(compactionIn(await pi.turnEnd({ tokens: 177_000 })));
		assert.equal(model.calls.length, 2);
	});

	it("whose cut entry has left the branch, is given up as every writer failing", async () => {
		const { pi, model } = forcing([{ text: PI_SUMMARY }]);
		const cut = await sunk(pi);
		// Back to before the cut, and on along another branch.
		const before = pi.session.getEntry(cut!)?.parentId;
		pi.session.branch(before!);
		assert.deepEqual(await pi.turnEnd({ tokens: 173_000 }), []);
		assert.deepEqual(errorsShown(pi), [{ message: CUT_GONE, type: "error" }]);
		assert.deepEqual(await pi.turnEnd({ tokens: 174_000 }), []);
		assert.equal(model.calls.length, 1);
	});

	it("is not re-drafted at a boundary Escape cut short, and nothing is said", async () => {
		const { pi, model } = forcing([{ text: PI_SUMMARY }, { text: PI_SUMMARY }]);
		await sunk(pi);
		pi.escape();
		assert.deepEqual(await pi.turnEnd({ message: aborted() }), []);
		assert.deepEqual(errorsShown(pi), []);
		// Forced stays armed: the next run writes a new Handoff.
		await pi.startRun();
		assert.ok(compactionIn(await pi.turnEnd({ tokens: 175_000 })));
		assert.equal(model.calls.length, 2);
	});
});
