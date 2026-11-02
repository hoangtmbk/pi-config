/**
 * The Effort core, fed by hand: `effort.jsonl` lines and new inputs in, the
 * folded state, the lines to append and the mechanical actions out. Every step
 * is also checked to fold back to the state it returned, because the lines are
 * all a restart has.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type EffortInput, type EffortLine, type EffortState, fold, openEffort, type Step, step } from "../core.ts";

const OPENED = openEffort({
	effortId: "software-2026-11-02",
	team: "software",
	repo: "/work/app",
	playbook: "a".repeat(64),
	at: "2026-11-02T10:00:00.000Z",
});

/** Feed `input` to the core after `lines`, and check the step folds back to its own state. */
function run(lines: EffortLine[], input: EffortInput): Step {
	const result = step(fold(lines), input);
	if (result.ok) assert.deepEqual(fold([...lines, ...result.append]), result.state, "the appended lines fold to a different state than the step returned");
	return result;
}

/** Apply a step that must succeed, returning the lines with its own appended. */
function applied(lines: EffortLine[], input: EffortInput): EffortLine[] {
	const result = run(lines, input);
	assert.ok(result.ok, result.ok ? "" : result.refusal);
	return [...lines, ...result.append];
}

const DRAFT = "/agent/team/efforts/software-2026-11-02/brief.draft.md";

function request(sha: string, at = "2026-11-02T10:05:00.000Z"): Extract<EffortInput, { kind: "request-approval" }> {
	return { kind: "request-approval", checkpoint: "brief", path: DRAFT, sha256: sha, snapshot: `brief ${sha}`, at };
}

function refusal(lines: EffortLine[], input: EffortInput): string {
	const result = run(lines, input);
	assert.equal(result.ok, false, "expected the core to refuse");
	return result.ok ? "" : result.refusal;
}

describe("opening an Effort", () => {
	it("starts effort.jsonl with one line naming the Team, the repo and the Playbook sha in force", () => {
		const state: EffortState = fold([OPENED]);

		assert.deepEqual(OPENED, {
			type: "effort-opened",
			effortId: "software-2026-11-02",
			team: "software",
			repo: "/work/app",
			playbook: "a".repeat(64),
			at: "2026-11-02T10:00:00.000Z",
		});
		assert.equal(state.effortId, "software-2026-11-02");
		assert.equal(state.team, "software");
		assert.equal(state.repo, "/work/app");
		assert.equal(state.playbook, "a".repeat(64));
		assert.equal(state.brief, undefined);
		assert.deepEqual(state.pending, []);
	});

	it("refuses to fold lines that don't start with the Effort being opened", () => {
		assert.throws(() => fold([]), /effort-opened/);
		assert.throws(() => fold([{ type: "approval-answered", id: "r1", answer: "approved", at: "x" }]), /effort-opened/);
	});
});

describe("before the Brief is approved", () => {
	it("refuses to start any Teammate, from planning or from a handoff", () => {
		for (const tool of ["team_plan", "team_handoff"] as const) {
			const text = refusal([OPENED], { kind: "start-teammate", tool });

			assert.match(text, /Brief/);
			assert.match(text, /`\/team pending`/);
			assert.ok(text.includes("software-2026-11-02"), text);
		}
	});
});

describe("asking for the Brief's approval", () => {
	it("adds a pending item holding the snapshot, and tells the Lead its path and sha", () => {
		const result = run([OPENED], request("b".repeat(64)));

		assert.ok(result.ok);
		assert.deepEqual(result.state.pending, [
			{ id: "r1", checkpoint: "brief", path: DRAFT, sha256: "b".repeat(64), snapshot: `brief ${"b".repeat(64)}`, at: "2026-11-02T10:05:00.000Z" },
		]);
		assert.deepEqual(result.actions, []);
		assert.ok(result.reply?.includes(DRAFT), result.reply);
		assert.ok(result.reply?.includes("b".repeat(64)), result.reply);
		assert.match(result.reply ?? "", /`\/team pending`/);
	});

	it("replaces a request the human hasn't answered with the newer one", () => {
		const lines = applied([OPENED], request("b".repeat(64)));
		const result = run(lines, request("c".repeat(64), "2026-11-02T10:09:00.000Z"));

		assert.ok(result.ok);
		assert.deepEqual(
			result.state.pending.map((item) => [item.id, item.sha256]),
			[["r2", "c".repeat(64)]],
		);
		assert.match(result.reply ?? "", /replaces/);
	});

	it("refuses a checkpoint other than the Brief, naming the one that is open", () => {
		const text = refusal([OPENED], { ...request("b".repeat(64)), checkpoint: "design-review" });

		assert.match(text, /`design-review`/);
		assert.match(text, /`brief`/);
	});
});

describe("the human's answer", () => {
	const asked = applied([OPENED], request("b".repeat(64)));

	it("approving promotes the snapshot asked about, wakes the Lead and counts the Brief approved", () => {
		const result = run(asked, { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });

		assert.ok(result.ok);
		assert.deepEqual(result.state.pending, []);
		assert.deepEqual(result.state.brief, { sha256: "b".repeat(64), approvedAt: "2026-11-02T11:00:00.000Z", request: "r1" });
		assert.deepEqual(result.actions[0], { kind: "promote-brief", approval: fold(asked).pending[0], at: "2026-11-02T11:00:00.000Z" });
		assert.equal(result.actions[1].kind, "wake-lead");
		assert.match(result.actions[1].kind === "wake-lead" ? result.actions[1].text : "", /approved the Brief/);
	});

	it("lets Teammates start once the Brief is approved", () => {
		const approved = applied(asked, { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });

		const result = run(approved, { kind: "start-teammate", tool: "team_handoff" });

		assert.ok(result.ok);
		assert.deepEqual(result.append, []);
	});

	it("sending back drops the item and wakes the Lead with the note, approving nothing", () => {
		const result = run(asked, { kind: "answer", id: "r1", answer: "sent-back", note: "AC3 is two criteria.", at: "2026-11-02T11:00:00.000Z" });

		assert.ok(result.ok);
		assert.deepEqual(result.state.pending, []);
		assert.equal(result.state.brief, undefined);
		assert.equal(result.actions.length, 1);
		const [wake] = result.actions;
		assert.equal(wake.kind, "wake-lead");
		assert.match(wake.kind === "wake-lead" ? wake.text : "", /AC3 is two criteria\./);
		assert.match(wake.kind === "wake-lead" ? wake.text : "", /`team_request_approval`/);
	});

	it("refuses an answer to a request that isn't pending", () => {
		const text = refusal(asked, { kind: "answer", id: "r9", answer: "approved", at: "2026-11-02T11:00:00.000Z" });

		assert.match(text, /`r9`/);
	});

	it("refuses another Brief request once the Brief is approved, since an approved Brief is never edited", () => {
		const approved = applied(asked, { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });

		assert.match(refusal(approved, request("d".repeat(64))), /already approved/);
	});
});
