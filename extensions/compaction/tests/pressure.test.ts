/**
 * Pressure levels at their built-in defaults: what each `turn_end` does about
 * the Context pressure pi reports — the footer status, the steers to the agent,
 * the one warning toast — and what it leaves alone.
 *
 * Driven only through the recording fake pi: a test sets the pressure pi would
 * report and reads back what crossed pi's boundary.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import loadCompaction from "../index.ts";
import { aborted, calling, failed, fakePi, result, said } from "./fake-pi.ts";

describe("loading", () => {
	it("is what pi's loader gets from the default export, with the real defaults", async () => {
		const pi = fakePi({}, loadCompaction);
		await pi.turnEnd({ tokens: 121_000 });
		assert.equal(pi.sent.length, 1);
		assert.equal(pi.status(), "<muted>ctx notice · 121k</muted>");
	});
});

describe("below notice", () => {
	it("shows nothing, says nothing and leaves pi's footer alone", async () => {
		const pi = fakePi();
		await pi.turnEnd({ tokens: 40_000 });
		await pi.turnEnd({ tokens: 119_999 });
		assert.deepEqual(pi.statuses, []);
		assert.deepEqual(pi.sent, []);
		assert.deepEqual(pi.notifications, []);
		assert.deepEqual(pi.errors, []);
	});
});

const NOTICE_STEER =
	"This is a good point to Self-compact at your next natural break, such as after finishing the current step. Finish what you are doing first. Don't shorten or skip work.";
const WARNING_STEER =
	"Self-compact at your next natural break, before you start a new subtask. If you don't, compaction will happen for you, possibly in the middle of a step.";

/** The text of every steer sent so far, in order. */
function steers(pi: ReturnType<typeof fakePi>): unknown[] {
	return pi.sent.map((m) => m.content);
}

describe("the steers", () => {
	it("tells the agent once, as a steer, when pressure crosses notice", async () => {
		const pi = fakePi();
		await pi.turnEnd({ tokens: 100_000 });
		await pi.turnEnd({ tokens: 121_000 });
		await pi.turnEnd({ tokens: 125_000 });
		await pi.turnEnd({ tokens: 140_000 });
		assert.deepEqual(steers(pi), [NOTICE_STEER]);
		assert.equal(pi.sent[0]?.deliverAs, "steer");
		assert.equal(pi.sent[0]?.landed, "steer");
	});

	it("holds a steer for the next prompt when the crossing turn is the one that ends the prompt", async () => {
		// A steer queued at the prompt's last boundary would start a turn nobody
		// asked for, just to answer it. The agent has stopped, which is itself
		// the natural break; it hears this with whatever the user says next.
		const pi = fakePi();
		await pi.turnEnd({ tokens: 121_000, message: said("All done.") });
		assert.deepEqual(steers(pi), [NOTICE_STEER]);
		assert.equal(pi.sent[0]?.deliverAs, "nextTurn");
		assert.equal(pi.sent[0]?.landed, "nextTurn");
	});

	it("tells the agent again, differently, when pressure crosses warning", async () => {
		const pi = fakePi();
		await pi.turnEnd({ tokens: 125_000 });
		await pi.turnEnd({ tokens: 150_000 });
		await pi.turnEnd({ tokens: 160_000 });
		assert.deepEqual(steers(pi), [NOTICE_STEER, WARNING_STEER]);
	});

	it("sends only warning's steer when one turn jumps from below notice past warning", async () => {
		const pi = fakePi();
		await pi.turnEnd({ tokens: 100_000 });
		await pi.turnEnd({ tokens: 155_000 });
		assert.deepEqual(steers(pi), [WARNING_STEER]);
		// Notice counts as crossed all the same, so it does not speak up later.
		await pi.turnEnd({ tokens: 140_000 });
		assert.deepEqual(steers(pi), [WARNING_STEER]);
	});

	it("sends no steer at forced, even on a jump straight past it", async () => {
		const pi = fakePi();
		await pi.turnEnd({ tokens: 100_000 });
		await pi.turnEnd({ tokens: 175_000 });
		await pi.turnEnd({ tokens: 160_000 });
		await pi.turnEnd({ tokens: 130_000 });
		assert.deepEqual(steers(pi), []);
	});

	it("steers at a level again only after pressure has fallen below it", async () => {
		const pi = fakePi();
		await pi.turnEnd({ tokens: 121_000 });
		await pi.turnEnd({ tokens: 119_000 });
		await pi.turnEnd({ tokens: 122_000 });
		await pi.turnEnd({ tokens: 151_000 });
		await pi.turnEnd({ tokens: 140_000 });
		await pi.turnEnd({ tokens: 151_000 });
		assert.deepEqual(steers(pi), [NOTICE_STEER, NOTICE_STEER, WARNING_STEER, WARNING_STEER]);
	});

	it("does not resend a steer that Escape cleared from the queue", async () => {
		const pi = fakePi();
		await pi.turnEnd({ tokens: 121_000 });
		// Escape clears pi's steering queue silently; the agent never read it.
		pi.escape();
		await pi.turnEnd({ message: aborted() });
		await pi.startRun();
		await pi.turnEnd({ tokens: 123_000 });
		assert.deepEqual(steers(pi), [NOTICE_STEER]);
	});

	it("never gives the agent a count, or anything about running out or a limit", async () => {
		const pi = fakePi();
		await pi.turnEnd({ tokens: 121_000 });
		await pi.turnEnd({ tokens: 151_000 });
		for (const text of steers(pi)) assert.doesNotMatch(String(text), /\d|running out|limit/i);
	});
});

describe("the warning toast", () => {
	it("tells the user once, as pressure crosses warning, that the agent was told and where forced is", async () => {
		const pi = fakePi();
		await pi.turnEnd({ tokens: 152_000 });
		await pi.turnEnd({ tokens: 160_000 });
		assert.deepEqual(pi.notifications, [
			{ message: "Context at 152k (warning). The agent has been told it's a good time to compact; forced at 170k.", type: "warning" },
		]);
	});

	it("is not shown at notice, or at forced", async () => {
		const notice = fakePi();
		await notice.turnEnd({ tokens: 125_000 });
		assert.deepEqual(notice.notifications, []);
		const forced = fakePi();
		await forced.turnEnd({ tokens: 172_000 });
		assert.deepEqual(forced.notifications, []);
	});
});

describe("a turn that did not complete", () => {
	it("does nothing when the user aborted it, and marks no level crossed", async () => {
		const pi = fakePi();
		pi.escape();
		await pi.turnEnd({ tokens: 155_000, message: aborted() });
		assert.deepEqual(pi.statuses, []);
		assert.deepEqual(pi.sent, []);
		assert.deepEqual(pi.notifications, []);
		// Had warning been marked crossed, this would say nothing.
		await pi.startRun();
		await pi.turnEnd({ tokens: 156_000 });
		assert.deepEqual(steers(pi), [WARNING_STEER]);
	});

	it("does nothing when the provider failed it, and marks no level crossed", async () => {
		const pi = fakePi();
		await pi.turnEnd({ tokens: 125_000, message: failed() });
		assert.deepEqual(pi.statuses, []);
		assert.deepEqual(pi.sent, []);
		await pi.turnEnd({ tokens: 125_000 });
		assert.deepEqual(steers(pi), [NOTICE_STEER]);
	});

	it("does nothing at either boundary of an Escape that landed while tools ran", async () => {
		const pi = fakePi();
		// pi ends the turn whose tools were cut short with outcome "completed" —
		// the model had finished streaming — then goes round once more into an
		// aborted stream and ends that turn too. Neither is a turn that happened.
		const call = calling("bash", { command: "npm test" });
		pi.escape();
		await pi.turnEnd({ tokens: 125_000, message: call, toolResults: [result(call, "Operation aborted", true)] });
		await pi.turnEnd({ message: aborted() });
		assert.deepEqual(pi.statuses, []);
		assert.deepEqual(pi.sent, []);
	});
});

describe("the footer status", () => {
	it("reads `ctx notice · 124k`, muted, from notice up, and follows the count each turn", async () => {
		const pi = fakePi();
		await pi.turnEnd({ tokens: 120_000 });
		assert.equal(pi.status(), "<muted>ctx notice · 120k</muted>");
		await pi.turnEnd({ tokens: 124_300 });
		assert.equal(pi.status(), "<muted>ctx notice · 124k</muted>");
	});

	it("reads `ctx warning · 152k` in the warning colour from warning up, forced included", async () => {
		const pi = fakePi();
		await pi.turnEnd({ tokens: 152_000 });
		assert.equal(pi.status(), "<warning>ctx warning · 152k</warning>");
		await pi.turnEnd({ tokens: 172_000 });
		assert.equal(pi.status(), "<warning>ctx warning · 172k</warning>");
	});

	it("is cleared once pressure falls back below notice", async () => {
		const pi = fakePi();
		await pi.turnEnd({ tokens: 130_000 });
		await pi.turnEnd({ tokens: 60_000 });
		assert.equal(pi.status(), undefined);
		assert.equal(pi.statuses.length, 2);
	});

	it("is left as it was by a turn with no reading", async () => {
		const pi = fakePi();
		await pi.turnEnd({ tokens: 130_000 });
		await pi.turnEnd({ tokens: null });
		await pi.turnEnd({ tokens: undefined });
		assert.deepEqual(pi.statuses, [{ key: "compaction", text: "<muted>ctx notice · 130k</muted>" }]);
	});

	it("is plain codec text in a Run, where it travels to the parent over RPC", async () => {
		const pi = fakePi({ mode: "rpc" });
		await pi.turnEnd({ tokens: 131_000 });
		assert.equal(pi.status(), "ctx notice · 131k");
	});
});
