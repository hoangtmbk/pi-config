/**
 * The Effort core, fed by hand: `effort.jsonl` lines and new inputs in, the
 * folded state, the lines to append and the mechanical actions out. Every step
 * is also checked to fold back to the state it returned, because the lines are
 * all a restart has.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { awayText, currentResult, type EffortAction, type EffortInput, type EffortLine, type EffortState, fold, freshStatusLine, heldPauses, type JournalLine, openEffort, openEscalations, openMerges, type Step, step, taskStatus, type UsageItem, type UsageReading, usageText, waitingInTerminal, workdir } from "../core.ts";

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
		assert.match(result.actions[1].kind === "wake-lead" ? result.actions[1].text : "", /`team_plan`.*the plan Report with `team_report`/);
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

describe("planning", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const ROLES = ["architect", "dev", "qa"];
	const CRITERIA = ["AC1", "AC2"];

	function plan(tasks: Extract<EffortInput, { kind: "plan" }>["tasks"], at = "2026-11-02T11:10:00.000Z"): Extract<EffortInput, { kind: "plan" }> {
		return { kind: "plan", tasks, criteria: CRITERIA, roles: ROLES, at };
	}

	const DESIGN = { slug: "design", role: "architect", goal: "Design the rename.", criteria: ["AC2"] };
	const RENAME = { slug: "rename", role: "dev", goal: "Rename the key.", dependsOn: ["design"], criteria: ["AC1", "AC2"] };

	it("refuses a plan before the Brief is approved", () => {
		assert.match(refusal([OPENED], plan([DESIGN, RENAME])), /before the human approves the Brief/);
	});

	it("refuses a plan that leaves an acceptance criterion uncovered, naming it", () => {
		const text = refusal(approved, plan([DESIGN]));

		assert.match(text, /`AC1`/);
		assert.doesNotMatch(text, /`AC2`/);
	});

	it("refuses a Role the Team snapshot lacks, naming the Roles it has", () => {
		const text = refusal(approved, plan([DESIGN, { ...RENAME, role: "devops" }]));

		assert.match(text, /`devops`/);
		assert.match(text, /`architect`, `dev`, `qa`/);
	});

	it("refuses a criterion the Brief doesn't have, a repeated or non-kebab slug, and a dependency on no planned Task", () => {
		const text = refusal(approved, plan([DESIGN, { ...RENAME, criteria: ["AC1", "AC2", "AC9"], dependsOn: ["desing"] }, { ...DESIGN, slug: "design" }, { ...DESIGN, slug: "Big Task" }]));

		assert.match(text, /`AC9`/);
		assert.match(text, /`desing`/);
		assert.match(text, /`design` is used more than once/);
		assert.match(text, /`Big Task`/);
	});

	it("takes a plan covering every criterion with known Roles, as the whole Task list", () => {
		const result = run(approved, plan([DESIGN, RENAME]));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.state.plan, [
			{ slug: "design", role: "architect", goal: "Design the rename.", dependsOn: [], criteria: ["AC2"] },
			{ slug: "rename", role: "dev", goal: "Rename the key.", dependsOn: ["design"], criteria: ["AC1", "AC2"] },
		]);
		assert.deepEqual(result.actions, [{ kind: "write-plan" }]);
	});

	it("replaces the plan when the Lead plans again while the Brief is unchanged", () => {
		const planned = applied(approved, plan([DESIGN, RENAME]));

		const result = run(planned, plan([{ ...RENAME, dependsOn: [] }], "2026-11-02T11:20:00.000Z"));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(
			result.state.plan?.map((task) => task.slug),
			["rename"],
		);
	});
});

describe("handing off", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const planned = applied(approved, {
		kind: "plan",
		tasks: [
			{ slug: "design", role: "architect", goal: "Design the rename.", criteria: ["AC2"] },
			{ slug: "rename", role: "dev", goal: "Rename the key.", dependsOn: ["design"], criteria: ["AC1"] },
		],
		criteria: ["AC1", "AC2"],
		roles: ["architect", "dev", "qa"],
		at: "2026-11-02T11:10:00.000Z",
	});

	function handoff(slug: string): Extract<EffortInput, { kind: "handoff" }> {
		return { kind: "handoff", slug, at: "2026-11-02T11:30:00.000Z" };
	}

	it("refuses a Task that isn't planned, naming the planned ones", () => {
		const text = refusal(planned, handoff("deploy"));

		assert.match(text, /`deploy`/);
		assert.match(text, /`design`, `rename`/);
	});

	it("starts a fresh Teammate in the Task's Role, numbering the Task folder and the Teammate, and refreshes plan.md", () => {
		const result = run(planned, handoff("design"));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.actions, [
			{ kind: "write-task", slug: "design", folder: "001-architect-design" },
			{
				kind: "launch-teammate",
				teammate: { id: "architect-1", role: "architect", name: "team-software-2026-11-02-architect-1" },
				task: { slug: "design", folder: "001-architect-design" },
				at: "2026-11-02T11:30:00.000Z",
			},
			{ kind: "write-plan" },
		]);
		assert.match(result.reply ?? "", /^started architect-1/);
		assert.deepEqual(result.state.teammates, [
			{ id: "architect-1", role: "architect", name: "team-software-2026-11-02-architect-1", task: "design", startedAt: "2026-11-02T11:30:00.000Z" },
		]);
	});

	it("numbers the next Task folder and the next Teammate of a Role on from the last", () => {
		const designed = applied(planned, handoff("design"));

		const result = run(designed, handoff("rename"));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		const launch = result.actions.find((action) => action.kind === "launch-teammate");
		assert.deepEqual(launch?.kind === "launch-teammate" ? [launch.teammate.id, launch.task.folder] : [], ["dev-1", "002-dev-rename"]);
	});

	it("refuses a Task that is already running", () => {
		const designed = applied(planned, handoff("design"));

		assert.match(refusal(designed, handoff("design")), /`design` is already running.*`architect-1`/);
	});

	it("drops a handed-off Task left out of a re-plan, and replans one given another Role", () => {
		const designed = applied(planned, handoff("design"));
		const replan = (tasks: Extract<EffortInput, { kind: "plan" }>["tasks"]) => ({
			kind: "plan" as const,
			tasks,
			criteria: ["AC1", "AC2"],
			roles: ["architect", "dev", "qa"],
			at: "2026-11-02T11:40:00.000Z",
		});

		const left = run(designed, replan([{ slug: "rename", role: "dev", goal: "Rename.", criteria: ["AC1", "AC2"] }]));
		assert.ok(left.ok, left.ok ? "" : left.refusal);
		assert.equal(taskStatus(left.state, "design"), "dropped");
		const reviewed = run(applied(designed, replan([{ slug: "rename", role: "dev", goal: "Rename.", criteria: ["AC1", "AC2"] }])), { kind: "review", slug: "design", verdict: "accept", result: { path: "/r.md", written: true }, sendBackLimit: 2, at: "2026-11-02T11:50:00.000Z" });
		assert.ok(!reviewed.ok);
		assert.match(reviewed.refusal, /Task `design` was dropped from the plan/);
		const moved = run(designed, replan([{ slug: "design", role: "dev", goal: "Design.", criteria: ["AC1", "AC2"] }]));
		assert.ok(moved.ok, moved.ok ? "" : moved.refusal);
		assert.equal(taskStatus(moved.state, "design"), "planned");
	});
});

describe("a Teammate's journal", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const started = applied(
		applied(approved, {
			kind: "plan",
			tasks: [{ slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1"] }],
			criteria: ["AC1"],
			roles: ["dev"],
			at: "2026-11-02T11:10:00.000Z",
		}),
		{ kind: "handoff", slug: "rename", at: "2026-11-02T11:30:00.000Z" },
	);
	const RESULT = "/agent/team/efforts/software-2026-11-02/tasks/001-dev-rename/result-1.md";
	const SESSION = "8f3c2a1b-0000-4000-8000-000000000001";

	function event(cursor: number, name: string, payload: Record<string, unknown> = {}, extra: Partial<JournalLine> = {}, written = false): Extract<EffortInput, { kind: "journal" }> {
		return {
			kind: "journal",
			teammate: "dev-1",
			cursor,
			line: { from: "hook", at: `2026-11-02T11:3${cursor}:00.000Z`, event: name, payload: { session_id: SESSION, hook_event_name: name, ...payload }, ...extra },
			result: { path: RESULT, written },
		};
	}

	it("names the result file a Teammate's current Task is due to write", () => {
		assert.deepEqual(currentResult(fold(started), "dev-1"), { slug: "rename", folder: "001-dev-rename", round: 1 });
		assert.equal(currentResult(fold(started), "qa-1"), undefined);
	});

	it("records a SessionStart's session id, short id and inbox socket, with the cursor it consumed, and wakes nobody", () => {
		const result = run(started, event(1, "SessionStart", { source: "startup" }, { inbox: { socket: "/tmp/cc-socks/4242.sock", token: "inbox-token" } }));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.actions, []);
		assert.equal(result.append.length, 1);
		assert.equal(result.append[0].type, "teammate-session");
		assert.equal((result.append[0] as { cursor: number }).cursor, 1);
		const [teammate] = result.state.teammates;
		assert.equal(teammate.sessionId, SESSION);
		assert.equal(teammate.shortId, "8f3c2a1b");
		assert.deepEqual(teammate.inbox, { socket: "/tmp/cc-socks/4242.sock", token: "inbox-token" });
		assert.equal(teammate.cursor, 1);
	});

	it("keeps the short id across a clear while taking the new session id", () => {
		const opened = applied(started, event(1, "SessionStart", { source: "startup" }, { inbox: { socket: "/tmp/cc-socks/4242.sock", token: "inbox-token" } }));

		const result = run(opened, event(2, "SessionStart", { source: "clear", session_id: "0b1c2d3e-0000-4000-8000-000000000002" }));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		const [teammate] = result.state.teammates;
		assert.equal(teammate.sessionId, "0b1c2d3e-0000-4000-8000-000000000002");
		assert.equal(teammate.shortId, "8f3c2a1b");
		assert.deepEqual(teammate.inbox, { socket: "/tmp/cc-socks/4242.sock", token: "inbox-token" });
	});

	it("logs a landed prompt and a denied permission without waking the Lead, and drops an idle notification", () => {
		const prompted = run(started, event(1, "UserPromptSubmit", { prompt: "New Task `rename`: read …" }));
		const denied = run(started, event(1, "PermissionDenied", { tool_name: "Bash", tool_input: { command: "git push" } }));
		const idle = run(started, event(1, "Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" }));

		assert.ok(prompted.ok && denied.ok && idle.ok);
		assert.deepEqual(
			[prompted, denied].map((result) => (result.ok ? [result.append.map((line) => line.type), result.actions] : [])),
			[
				[["prompt-landed"], []],
				[["permission-denied"], []],
			],
		);
		assert.deepEqual([idle.append, idle.actions], [[], []]);
	});

	it("counts a Stop with the round's result written as done, waking the Lead with the Task and the result's path", () => {
		const result = run(started, event(3, "Stop", { last_assistant_message: "Renamed it." }, {}, true));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append.map((line) => [line.type, (line as { cursor: number }).cursor]), [["task-done", 3]]);
		assert.equal(result.actions.length, 1);
		const [wake] = result.actions;
		assert.equal(wake.kind, "wake-lead");
		assert.match(wake.kind === "wake-lead" ? wake.text : "", /`dev-1`.*`rename`/);
		assert.ok(wake.kind === "wake-lead" && wake.text.includes(RESULT));
	});

	it("counts a Stop without the round's result as stopped short, giving the Lead the last assistant message", () => {
		const result = run(started, event(3, "Stop", { last_assistant_message: "I couldn't find the config loader." }));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append.map((line) => line.type), ["teammate-stopped"]);
		const [wake] = result.actions;
		const text = wake?.kind === "wake-lead" ? wake.text : "";
		assert.match(text, /stopped short/);
		assert.match(text, /I couldn't find the config loader\./);
		assert.ok(text.includes(RESULT));
	});

	it("doesn't count a result already reported as new", () => {
		const done = applied(started, event(3, "Stop", {}, {}, true));

		const result = run(done, event(4, "Stop", { last_assistant_message: "Anything else?" }, {}, true));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append.map((line) => line.type), ["teammate-stopped"]);
	});

	it("applies each journal line once: a line at or before the Teammate's cursor changes nothing", () => {
		const done = applied(started, event(3, "Stop", {}, {}, true));

		const again = run(done, event(3, "Stop", {}, {}, true));
		const earlier = run(done, event(2, "UserPromptSubmit", { prompt: "New Task" }));

		assert.ok(again.ok && earlier.ok);
		assert.deepEqual([again.append, again.actions, earlier.append, earlier.actions], [[], [], [], []]);
	});
});

describe("reviewing a Task", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const started = applied(
		applied(approved, {
			kind: "plan",
			tasks: [
				{ slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1"] },
				{ slug: "docs", role: "dev", goal: "Document it.", criteria: ["AC1"] },
			],
			criteria: ["AC1"],
			roles: ["dev"],
			at: "2026-11-02T11:10:00.000Z",
		}),
		{ kind: "handoff", slug: "rename", at: "2026-11-02T11:30:00.000Z" },
	);
	const INBOX = { socket: "/tmp/cc-socks/4242.sock", token: "inbox-token" };
	const DIR = "/agent/team/efforts/software-2026-11-02/tasks/001-dev-rename";

	function journal(lines: EffortLine[], cursor: number, event: string, written = false): EffortLine[] {
		return applied(lines, {
			kind: "journal",
			teammate: "dev-1",
			cursor,
			line: { from: "hook", at: `2026-11-02T12:0${cursor}:00.000Z`, event, payload: { session_id: "8f3c2a1b-0000-4000-8000-000000000001", source: "startup" }, ...(event === "SessionStart" ? { inbox: INBOX } : {}) },
			result: { path: `${DIR}/result-1.md`, written },
		});
	}

	const running = journal(started, 1, "SessionStart");
	const done = journal(running, 2, "Stop", true);

	function review(verdict: "accept" | "send_back", written = true, options: { slug?: string; feedback?: string; limit?: number; round?: number } = {}): Extract<EffortInput, { kind: "review" }> {
		return {
			kind: "review",
			slug: options.slug ?? "rename",
			verdict,
			...(verdict === "send_back" ? { feedback: options.feedback ?? "The loader still reads `colour`." } : {}),
			result: { path: `${DIR}/result-${options.round ?? 1}.md`, written },
			sendBackLimit: options.limit ?? 2,
			at: "2026-11-02T13:00:00.000Z",
		};
	}

	it("refuses a review when the current round's result isn't written, naming the result it waits for", () => {
		const text = refusal(running, review("accept", false));

		assert.match(text, /`rename`/);
		assert.ok(text.includes(`${DIR}/result-1.md`), text);
	});

	it("refuses a review while the Teammate is still on the round, though its result is already on disk: never before its Stop is counted done", () => {
		const text = refusal(running, review("accept", true));

		assert.match(text, /`dev-1` hasn't finished round 1/);
	});

	it("accepts a Task whose round's result is written, moving it to accepted and refreshing plan.md, waking nobody", () => {
		assert.equal(taskStatus(fold(done), "rename"), "in review");

		const result = run(done, review("accept"));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append, [{ type: "task-accepted", slug: "rename", round: 1, at: "2026-11-02T13:00:00.000Z" }]);
		assert.deepEqual(result.actions, [{ kind: "write-plan" }]);
		assert.equal(taskStatus(result.state, "rename"), "accepted");
		assert.match(result.reply ?? "", /^Accepted Task `rename`/);
	});

	it("refuses to review a Task that was never handed off, or one already accepted", () => {
		const accepted = applied(done, review("accept"));

		assert.match(refusal(done, review("accept", true, { slug: "docs" })), /`docs` hasn't been handed off.*`rename`/);
		assert.match(refusal(accepted, review("send_back")), /`rename` is already accepted/);
	});

	it("refuses to hand off again a Task that is running, in review or accepted", () => {
		const handoff: EffortInput = { kind: "handoff", slug: "rename", at: "2026-11-02T14:00:00.000Z" };

		assert.match(refusal(running, handoff), /`rename` is already running, with `dev-1`.*`team_review`/);
		assert.match(refusal(done, handoff), /`rename` is already in review, with `dev-1`/);
		assert.match(refusal(applied(done, review("accept")), handoff), /`rename` is accepted.*never handed off again/);
	});

	it("sends a Task back to the Teammate that did it, over its inbox and with no clear, starting the next round", () => {
		const result = run(done, review("send_back"));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append, [{ type: "task-sent-back", slug: "rename", round: 1, at: "2026-11-02T13:00:00.000Z" }]);
		assert.deepEqual(result.actions, [
			{ kind: "send-back", teammate: "dev-1", inbox: INBOX, slug: "rename", folder: "001-dev-rename", round: 1, feedback: "The loader still reads `colour`." },
			{ kind: "write-plan" },
		]);
		assert.equal(taskStatus(result.state, "rename"), "sent back");
		assert.equal(result.state.tasks.rename.sendBacks, 1);
		assert.deepEqual(currentResult(result.state, "dev-1"), { slug: "rename", folder: "001-dev-rename", round: 2 });
		assert.match(result.reply ?? "", /`rename`.*`dev-1`.*feedback-1\.md.*result-2\.md/);
		assert.match(result.reply ?? "", /send-back 1 of 2/);
	});

	it("refuses a send-back without feedback", () => {
		assert.match(refusal(done, review("send_back", true, { feedback: "  " })), /feedback/);
	});

	it("refuses to review round 2 until its result is reported written, then counts each send-back toward the limit", () => {
		const sentBack = applied(done, review("send_back"));

		assert.match(refusal(sentBack, review("accept", false, { round: 2 })), /round 2's .*result-2\.md isn't written/);
		const second = applied(journal(sentBack, 3, "Stop", true), review("send_back", true, { round: 2 }));
		assert.equal(fold(second).tasks.rename.sendBacks, 2);
		assert.equal(fold(second).tasks.rename.round, 3);
	});

	it("refuses a send-back at the Playbook's sendBackLimit, telling the Lead to escalate to the human, and still accepts", () => {
		const once = journal(applied(done, review("send_back", true, { limit: 1 })), 3, "Stop", true);

		const text = refusal(once, review("send_back", true, { limit: 1, round: 2 }));

		assert.match(text, /`rename`.*sent back 1 time.*`sendBackLimit` of 1/);
		assert.match(text, /[Ee]scalate.*human/);
		assert.ok(run(once, review("accept", true, { limit: 1, round: 2 })).ok);
	});

	it("refuses a send-back to a Teammate whose inbox socket isn't known yet", () => {
		const noInbox = applied(started, {
			kind: "journal",
			teammate: "dev-1",
			cursor: 1,
			line: { from: "hook", at: "2026-11-02T12:01:00.000Z", event: "Stop", payload: {} },
			result: { path: `${DIR}/result-1.md`, written: true },
		});

		assert.match(refusal(noInbox, review("send_back")), /`dev-1`.*inbox/);
	});
});

describe("a Teammate's permission mode", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const started = applied(
		applied(approved, { kind: "plan", tasks: [{ slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1"] }], criteria: ["AC1"], roles: ["dev"], at: "2026-11-02T11:10:00.000Z" }),
		{ kind: "handoff", slug: "rename", at: "2026-11-02T11:30:00.000Z", mode: "auto" },
	);

	function hook(cursor: number, name: string, mode: string): Extract<EffortInput, { kind: "journal" }> {
		return {
			kind: "journal",
			teammate: "dev-1",
			cursor,
			line: { from: "hook", at: `2026-11-02T11:4${cursor}:00.000Z`, event: name, payload: { session_id: "8f3c2a1b-0000", hook_event_name: name, permission_mode: mode } },
			result: { path: "/r/result-1.md", written: false },
		};
	}

	it("records the mode a Teammate launched in", () => {
		assert.equal(fold(started).teammates[0].mode, "auto");
	});

	it("logs a mode its hooks report other than the one last known, once per change, before the event's own line and waking nobody", () => {
		const same = run(started, hook(1, "SessionStart", "auto"));
		assert.ok(same.ok);
		assert.deepEqual(same.append.map((line) => line.type), ["teammate-session"]);

		const opened = applied(started, hook(1, "SessionStart", "auto"));
		const drifted = run(opened, hook(2, "UserPromptSubmit", "acceptEdits"));
		assert.ok(drifted.ok);
		assert.deepEqual(drifted.append[0], { type: "teammate-mode", teammate: "dev-1", cursor: 2, mode: "acceptEdits", at: "2026-11-02T11:42:00.000Z" });
		assert.deepEqual(drifted.append.map((line) => line.type), ["teammate-mode", "prompt-landed"]);
		assert.deepEqual(drifted.actions, []);
		assert.equal(drifted.state.teammates[0].observedMode, "acceptEdits");

		const steady = run([...opened, ...drifted.append], hook(3, "PostToolUse", "acceptEdits"));
		assert.ok(steady.ok);
		assert.deepEqual(steady.append, []);
	});

	it("reads Claude Code's `default` as manual", () => {
		const result = run(started, hook(1, "SessionStart", "default"));
		assert.ok(result.ok);
		assert.deepEqual(result.append[0], { type: "teammate-mode", teammate: "dev-1", cursor: 1, mode: "manual", at: "2026-11-02T11:41:00.000Z" });
	});
});

describe("staffing a handoff", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const planned = applied(approved, {
		kind: "plan",
		tasks: [
			{ slug: "design", role: "architect", goal: "Design the rename.", criteria: ["AC1"] },
			{ slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1"] },
			{ slug: "docs", role: "dev", goal: "Document it.", criteria: ["AC1"] },
			{ slug: "tests", role: "qa", goal: "Test it.", criteria: ["AC1"] },
			{ slug: "cleanup", role: "dev", goal: "Clean up.", criteria: ["AC1"] },
		],
		criteria: ["AC1"],
		roles: ["architect", "dev", "qa"],
		at: "2026-11-02T11:10:00.000Z",
	});
	const T0 = "2026-11-02T11:30:00.000Z";
	const TASKS = "/agent/team/efforts/software-2026-11-02/tasks";

	function handoff(slug: string, options: { at?: string; max?: number } = {}): Extract<EffortInput, { kind: "handoff" }> {
		return { kind: "handoff", slug, at: options.at ?? T0, ...(options.max === undefined ? {} : { maxTeammates: options.max }) };
	}

	function inboxOf(id: string) {
		return { socket: `/tmp/cc-socks/${id}.sock`, token: `token-${id}` };
	}

	/** Play `id`'s journal up to the end of its round: its SessionStart once, then a Stop with or without the result. */
	function stops(lines: EffortLine[], id: string, written = true): EffortLine[] {
		const state = fold(lines);
		const teammate = state.teammates.find((each) => each.id === id);
		assert.ok(teammate, `no Teammate ${id}`);
		const due = currentResult(state, id);
		const result = { path: `${TASKS}/${due?.folder}/result-${due?.round}.md`, written };
		let cursor = teammate.cursor ?? 0;
		let out = lines;
		if (teammate.sessionId === undefined) {
			cursor += 1;
			out = applied(out, {
				kind: "journal",
				teammate: id,
				cursor,
				line: { from: "hook", at: T0, event: "SessionStart", payload: { session_id: `${id.padEnd(8, "0")}-0000-4000-8000-000000000001`, source: "startup" }, inbox: inboxOf(id) },
				result,
			});
		}
		return applied(out, { kind: "journal", teammate: id, cursor: cursor + 1, line: { from: "hook", at: T0, event: "Stop", payload: { last_assistant_message: "Done." } }, result });
	}

	/** Accept the round `id` just finished, taking whatever the acceptance unblocks. */
	function accept(lines: EffortLine[], id: string, max?: number): Step {
		const state = fold(lines);
		const slug = state.teammates.find((each) => each.id === id)?.task ?? "";
		const task = state.tasks[slug];
		return run(lines, {
			kind: "review",
			slug,
			verdict: "accept",
			result: { path: `${TASKS}/${task?.folder}/result-${task?.round}.md`, written: true },
			sendBackLimit: 2,
			at: "2026-11-02T13:00:00.000Z",
			...(max === undefined ? {} : { maxTeammates: max }),
		});
	}

	function accepted(lines: EffortLine[], id: string, max?: number): EffortLine[] {
		const result = accept(lines, id, max);
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		return [...lines, ...result.append];
	}

	it("reuses an idle Teammate of the Role whose Task is accepted, clearing it before the pointer goes, and launches nothing", () => {
		const renamed = accepted(stops(applied(planned, handoff("rename")), "dev-1"), "dev-1");

		const result = run(renamed, handoff("docs", { at: "2026-11-02T14:00:00.000Z" }));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append, [
			{ type: "task-handed-off", slug: "docs", folder: "002-dev-docs", role: "dev", teammate: "dev-1", at: "2026-11-02T14:00:00.000Z", round: 1 },
			{ type: "clear-requested", teammate: "dev-1", slug: "docs", at: "2026-11-02T14:00:00.000Z" },
		]);
		assert.deepEqual(result.actions, [
			{ kind: "write-task", slug: "docs", folder: "002-dev-docs" },
			{ kind: "clear-then-send", teammate: "dev-1", inbox: inboxOf("dev-1"), slug: "docs", folder: "002-dev-docs" },
			{ kind: "write-plan" },
		]);
		assert.match(result.reply ?? "", /^reused dev-1 on Task `docs` \(tasks\/002-dev-docs\/task\.md\)/);
		assert.equal(result.state.teammates.length, 1);
		assert.equal(result.state.teammates[0].task, "docs");
		assert.deepEqual(currentResult(result.state, "dev-1"), { slug: "docs", folder: "002-dev-docs", round: 1 });
		assert.equal(taskStatus(result.state, "docs"), "running");
	});

	it("starts a new Teammate under the cap rather than take one mid-Task: running, in review or stopped short", () => {
		const running = applied(planned, handoff("rename"));
		const inReview = stops(running, "dev-1");
		const short = stops(running, "dev-1", false);

		for (const lines of [running, inReview, short]) {
			const result = run(lines, handoff("docs"));
			assert.ok(result.ok, result.ok ? "" : result.refusal);
			assert.match(result.reply ?? "", /^started dev-2 on Task `docs`/);
			assert.ok(!result.actions.some((action) => action.kind === "clear-then-send"));
			assert.deepEqual(
				result.actions.map((action) => action.kind),
				["write-task", "launch-teammate", "write-plan"],
			);
		}
	});

	it("counts every live Teammate toward the cap, busy, idle in review or stopped short, and queues past it saying why", () => {
		const designing = applied(planned, handoff("design"));
		const inReview = stops(applied(designing, handoff("rename")), "dev-1");
		const full = stops(applied(inReview, handoff("tests")), "qa-1", false);

		const result = run(full, handoff("docs"));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		const why = "cap 3 reached; waits for 001, 002 and 003";
		assert.deepEqual(result.append, [{ type: "task-queued", slug: "docs", folder: "004-dev-docs", role: "dev", why, at: T0 }]);
		assert.deepEqual(result.actions, [{ kind: "write-task", slug: "docs", folder: "004-dev-docs" }, { kind: "write-plan" }]);
		assert.match(result.reply ?? "", new RegExp(`^queued Task \`docs\` \\(tasks/004-dev-docs/task\\.md\\): ${why}\\.`));
		assert.deepEqual(result.state.queue, [{ slug: "docs", folder: "004-dev-docs", role: "dev", why, at: T0 }]);
		assert.equal(result.state.teammates.length, 3);
		assert.equal(taskStatus(result.state, "docs"), "queued");
	});

	it("takes the cap from the input, defaulting to 3", () => {
		const one = applied(planned, handoff("design", { max: 1 }));

		const result = run(one, handoff("rename", { max: 1 }));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.match(result.reply ?? "", /^queued Task `rename`.*cap 1 reached; waits for 001\./);
	});

	it("refuses to hand off a queued Task again, saying it starts by itself", () => {
		const queued = applied(applied(planned, handoff("design", { max: 1 })), handoff("rename", { max: 1 }));

		assert.match(refusal(queued, handoff("rename", { max: 1 })), /`rename` is already queued.*starts by itself/);
	});

	it("drops a queued Task a re-plan leaves out or gives another Role, so no drain starts it", () => {
		const queued = applied(applied(applied(planned, handoff("design", { max: 1 })), handoff("rename", { max: 1 })), handoff("docs", { max: 1 }));
		const replan = run(queued, {
			kind: "plan",
			tasks: [
				{ slug: "design", role: "architect", goal: "Design the rename.", criteria: ["AC1"] },
				{ slug: "rename", role: "qa", goal: "Rename the key.", criteria: ["AC1"] },
			],
			criteria: ["AC1"],
			roles: ["architect", "dev", "qa"],
			at: "2026-11-02T11:40:00.000Z",
		});

		assert.ok(replan.ok, replan.ok ? "" : replan.refusal);
		assert.deepEqual(replan.state.queue, []);
		assert.equal(taskStatus(replan.state, "rename"), "planned");
		assert.match(replan.reply ?? "", /Dropped queued Task `docs`\./);
		assert.match(replan.reply ?? "", /Dropped queued Task `rename`: it is planned again in Role `qa`/);
		const drained = run([...queued, ...replan.append], { kind: "drain", at: "2026-11-02T13:00:05.000Z", maxTeammates: 3 });
		assert.ok(drained.ok);
		assert.deepEqual(drained.append, []);
	});

	it("at the cap, stops an idle Teammate of a Role with no queued Task to start one for this Role", () => {
		const designed = accepted(stops(applied(planned, handoff("design", { max: 2 })), "architect-1"), "architect-1", 2);
		const full = applied(designed, handoff("rename", { max: 2 }));

		const result = run(full, handoff("tests", { max: 2, at: "2026-11-02T14:00:00.000Z" }));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append.map((line) => line.type), ["teammate-retired", "teammate-started", "task-handed-off"]);
		assert.deepEqual(result.append[0], { type: "teammate-retired", teammate: "architect-1", at: "2026-11-02T14:00:00.000Z" });
		assert.deepEqual(result.actions, [
			{ kind: "write-task", slug: "tests", folder: "003-qa-tests" },
			{ kind: "stop-teammate", teammate: "architect-1", shortId: "architec" },
			{
				kind: "launch-teammate",
				teammate: { id: "qa-1", role: "qa", name: "team-software-2026-11-02-qa-1" },
				task: { slug: "tests", folder: "003-qa-tests" },
				at: "2026-11-02T14:00:00.000Z",
			},
			{ kind: "write-plan" },
		]);
		assert.match(result.reply ?? "", /^started qa-1 on Task `tests`.*stopped idle `architect-1`.*cap of 2/);
		assert.deepEqual(
			result.state.teammates.filter((teammate) => teammate.retiredAt === undefined).map((teammate) => teammate.id),
			["dev-1", "qa-1"],
		);
	});

	it("staggers starts at most one every 5 s, counting from the last start", () => {
		const first = run(planned, handoff("design"));
		assert.ok(first.ok);
		const second = run([...planned, ...first.append], handoff("rename", { at: "2026-11-02T11:30:02.000Z" }));
		assert.ok(second.ok);
		const third = run([...planned, ...first.append, ...second.append], handoff("tests", { at: "2026-11-02T11:30:03.000Z" }));
		assert.ok(third.ok);
		const later = run([...planned, ...first.append, ...second.append, ...third.append], handoff("docs", { at: "2026-11-02T11:31:00.000Z", max: 4 }));
		assert.ok(later.ok);

		const launches = [first, second, third, later].map((result) => result.actions.find((action) => action.kind === "launch-teammate"));
		assert.deepEqual(
			launches.map((launch) => (launch?.kind === "launch-teammate" ? launch.at : undefined)),
			["2026-11-02T11:30:00.000Z", "2026-11-02T11:30:05.000Z", "2026-11-02T11:30:10.000Z", "2026-11-02T11:31:00.000Z"],
		);
		assert.deepEqual(
			fold([...planned, ...first.append, ...second.append, ...third.append]).teammates.map((teammate) => teammate.startedAt),
			["2026-11-02T11:30:00.000Z", "2026-11-02T11:30:05.000Z", "2026-11-02T11:30:10.000Z"],
		);
	});

	/** Start the next queued Task that can start now, as the shell asks after each acceptance. */
	function drain(lines: EffortLine[], max?: number): Step {
		return run(lines, { kind: "drain", at: "2026-11-02T13:00:05.000Z", ...(max === undefined ? {} : { maxTeammates: max }) });
	}

	it("accepts without starting anything itself: a queued Task waits for the drain that follows", () => {
		const full = applied(applied(planned, handoff("rename", { max: 1 })), handoff("docs", { max: 1 }));

		const result = accept(stops(full, "dev-1"), "dev-1", 1);

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append.map((line) => line.type), ["task-accepted"]);
		assert.deepEqual(result.actions, [{ kind: "write-plan" }]);
		assert.deepEqual(result.state.queue.map((each) => each.slug), ["docs"]);
	});

	it("starts a queued Task when its blocker clears: an accepted Teammate of its Role is reused for it", () => {
		const full = applied(applied(planned, handoff("rename", { max: 1 })), handoff("docs", { max: 1 }));

		const result = drain(accepted(stops(full, "dev-1"), "dev-1", 1), 1);

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append, [
			{ type: "task-handed-off", slug: "docs", folder: "002-dev-docs", role: "dev", teammate: "dev-1", at: "2026-11-02T13:00:05.000Z", round: 1 },
			{ type: "clear-requested", teammate: "dev-1", slug: "docs", at: "2026-11-02T13:00:05.000Z" },
		]);
		assert.deepEqual(result.state.queue, []);
		assert.deepEqual(result.actions, [
			{ kind: "clear-then-send", teammate: "dev-1", inbox: inboxOf("dev-1"), slug: "docs", folder: "002-dev-docs" },
			{ kind: "write-plan" },
		]);
		assert.match(result.reply ?? "", /^Queued Task `docs` reused dev-1 \(tasks\/002-dev-docs\/task\.md\)/);
	});

	it("starts a queued Task of another Role by stopping the accepted Teammate, launching when the drain runs in the mode the handoff asked for", () => {
		const full = applied(applied(planned, handoff("rename", { max: 1 })), { ...handoff("tests", { max: 1 }), mode: "acceptEdits" });

		const result = drain(accepted(stops(full, "dev-1"), "dev-1", 1), 1);

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append.map((line) => line.type), ["teammate-retired", "teammate-started", "task-handed-off"]);
		assert.deepEqual(
			result.actions.map((action) => action.kind),
			["stop-teammate", "launch-teammate", "write-plan"],
		);
		const launch = result.actions.find((action) => action.kind === "launch-teammate");
		assert.equal(launch?.kind === "launch-teammate" ? launch.at : undefined, "2026-11-02T13:00:05.000Z");
		assert.equal(result.state.teammates.find((teammate) => teammate.id === "qa-1")?.mode, "acceptEdits");
		assert.match(result.reply ?? "", /^Queued Task `tests` started qa-1/);
	});

	it("keeps an idle Teammate whose Role has a Task queued rather than stop it for another Role, and a drain with nothing to start does nothing", () => {
		const queued = applied(applied(applied(planned, handoff("rename", { max: 1 })), handoff("tests", { max: 1 })), handoff("docs", { max: 1 }));
		const first = drain(accepted(stops(queued, "dev-1"), "dev-1", 1), 1);
		assert.ok(first.ok, first.ok ? "" : first.refusal);

		const second = run([...accepted(stops(queued, "dev-1"), "dev-1", 1), ...first.append], { kind: "drain", at: "2026-11-02T13:00:06.000Z", maxTeammates: 1 });

		assert.equal(first.state.tasks.docs.teammate, "dev-1");
		assert.ok(!first.actions.some((action) => action.kind === "stop-teammate"));
		assert.ok(second.ok, second.ok ? "" : second.refusal);
		assert.deepEqual([second.append, second.actions, second.reply], [[], [], undefined]);
		assert.deepEqual(second.state.queue.map((each) => each.slug), ["tests"]);
	});
});

describe("clearing between Tasks", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const planned = applied(approved, {
		kind: "plan",
		tasks: [
			{ slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1"] },
			{ slug: "docs", role: "dev", goal: "Document it.", criteria: ["AC1"] },
		],
		criteria: ["AC1"],
		roles: ["dev"],
		at: "2026-11-02T11:10:00.000Z",
	});
	const DIR = "/agent/team/efforts/software-2026-11-02/tasks/001-dev-rename";
	const INBOX = { socket: "/tmp/cc-socks/4242.sock", token: "inbox-token" };
	const FIRST = "8f3c2a1b-0000-4000-8000-000000000001";
	const SECOND = "0b1c2d3e-0000-4000-8000-000000000002";

	function hook(cursor: number, event: string, payload: Record<string, unknown>, written = false): Extract<EffortInput, { kind: "journal" }> {
		return {
			kind: "journal",
			teammate: "dev-1",
			cursor,
			line: { from: "hook", at: `2026-11-02T12:0${cursor}:00.000Z`, event, payload, ...(event === "SessionStart" ? { inbox: INBOX } : {}) },
			result: { path: `${DIR}/result-1.md`, written },
		};
	}

	const running = applied(applied(planned, { kind: "handoff", slug: "rename", at: "2026-11-02T11:30:00.000Z" }), hook(1, "SessionStart", { session_id: FIRST, source: "startup" }));
	const done = applied(running, hook(2, "Stop", { session_id: FIRST }, true));
	const review = (verdict: "accept" | "send_back"): EffortInput => ({
		kind: "review",
		slug: "rename",
		verdict,
		feedback: "Still reads `colour`.",
		result: { path: `${DIR}/result-1.md`, written: true },
		sendBackLimit: 2,
		at: "2026-11-02T13:00:00.000Z",
	});
	const clearing = applied(applied(done, review("accept")), { kind: "handoff", slug: "docs", at: "2026-11-02T14:00:00.000Z" });

	it("clears for a different Task: once its SessionStart `clear` lands, records the new session id, keeps the short id and sends the pointer", () => {
		assert.equal(fold(clearing).teammates[0].clearing, "docs");

		const result = run(clearing, hook(3, "SessionStart", { session_id: SECOND, source: "clear" }));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append.map((line) => line.type), ["teammate-session"]);
		assert.deepEqual(result.actions, [{ kind: "send-pointer", teammate: "dev-1", inbox: INBOX, slug: "docs", folder: "002-dev-docs", round: 1 }]);
		const [teammate] = result.state.teammates;
		assert.equal(teammate.sessionId, SECOND);
		assert.equal(teammate.shortId, "8f3c2a1b");
		assert.equal(teammate.clearing, undefined);
	});

	it("sends no pointer for a clear nobody asked for, nor for a SessionStart other than a clear while one is asked", () => {
		const unasked = run(done, hook(3, "SessionStart", { session_id: SECOND, source: "clear" }));
		const resumed = run(clearing, hook(3, "SessionStart", { session_id: FIRST, source: "resume" }));

		assert.ok(unasked.ok && resumed.ok);
		assert.deepEqual(unasked.actions, []);
		assert.deepEqual(resumed.actions, []);
		assert.equal(resumed.state.teammates[0].clearing, "docs");
	});

	it("never clears a send-back to the Teammate that did the Task with nothing in between", () => {
		const result = run(done, review("send_back"));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.ok(!result.actions.some((action) => action.kind === "clear-then-send"));
		assert.ok(!result.append.some((line) => line.type === "clear-requested"));
	});

	it("never clears mid-Task: a handoff for the Role while its Teammate works starts another", () => {
		const result = run(running, { kind: "handoff", slug: "docs", at: "2026-11-02T12:30:00.000Z" });

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.ok(!result.actions.some((action) => action.kind === "clear-then-send"));
		assert.equal(fold(running).teammates[0].task, "rename");
		assert.equal(result.state.teammates[0].task, "rename");
	});

	it("starts its Teammate afresh, not cleared, at its next Task once an approved Brief change alters its Role's launch options; its old session's end is no crash", () => {
		const done_ = applied(running, hook(2, "Stop", { session_id: FIRST }, true));
		const asked = applied(done_, {
			kind: "request-approval",
			checkpoint: "brief-change",
			path: "/agent/team/efforts/software-2026-11-02/brief.draft.md",
			sha256: "c".repeat(64),
			snapshot: "---\n---\n",
			affects: [],
			at: "2026-11-02T12:10:00.000Z",
		});
		const changed = applied(asked, { kind: "answer", id: "r2", answer: "approved", refresh: ["dev"], at: "2026-11-02T12:11:00.000Z" });
		assert.equal(fold(changed).teammates[0].freshDue, true);
		const accepted = applied(changed, review("accept"));

		const result = run(accepted, { kind: "handoff", slug: "docs", at: "2026-11-02T14:00:00.000Z" });

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.match(result.reply ?? "", /^started dev-1 afresh on Task `docs`/);
		assert.deepEqual(
			result.actions.filter((action) => action.kind === "stop-teammate" || action.kind === "launch-teammate" || action.kind === "clear-then-send"),
			[
				{ kind: "stop-teammate", teammate: "dev-1", shortId: "8f3c2a1b" },
				{ kind: "launch-teammate", teammate: { id: "dev-1", role: "dev", name: "team-software-2026-11-02-dev-1" }, task: { slug: "docs", folder: "002-dev-docs" }, at: "2026-11-02T14:00:00.000Z" },
			],
		);
		const relaunched = [...accepted, ...result.append];
		assert.deepEqual(fold(relaunched).teammates.map(({ id, task, freshDue, relaunching }) => ({ id, task, freshDue, relaunching })), [{ id: "dev-1", task: "docs", freshDue: undefined, relaunching: true }]);

		const old = run(relaunched, hook(3, "SessionEnd", { session_id: FIRST, reason: "other" }));
		assert.ok(old.ok && old.append.length === 0 && old.actions.length === 0, "the stopped session's end is no crash");

		const fresh = run(relaunched, hook(3, "SessionStart", { session_id: SECOND, source: "startup" }));
		assert.ok(fresh.ok, fresh.ok ? "" : fresh.refusal);
		const [teammate] = fresh.state.teammates;
		assert.deepEqual({ shortId: teammate.shortId, newShortId: teammate.newShortId, relaunching: teammate.relaunching }, { shortId: "0b1c2d3e", newShortId: true, relaunching: undefined });
		const late = run([...relaunched, ...fresh.append], hook(4, "SessionEnd", { session_id: FIRST, reason: "other" }));
		assert.ok(late.ok && late.append.length === 0, "an end of the old session after the new one started is no crash either");
	});

	it("clears as before at the next Task when an approved Brief change leaves its Role's launch options alone", () => {
		const done_ = applied(running, hook(2, "Stop", { session_id: FIRST }, true));
		const asked = applied(done_, { kind: "request-approval", checkpoint: "brief-change", path: "/agent/team/efforts/software-2026-11-02/brief.draft.md", sha256: "c".repeat(64), snapshot: "---\n---\n", affects: [], at: "2026-11-02T12:10:00.000Z" });
		const changed = applied(asked, { kind: "answer", id: "r2", answer: "approved", at: "2026-11-02T12:11:00.000Z" });

		const result = run(applied(changed, review("accept")), { kind: "handoff", slug: "docs", at: "2026-11-02T14:00:00.000Z" });

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.match(result.reply ?? "", /^reused dev-1 on Task `docs`/);
	});

	it("starts afresh at its next Task a Teammate holding a session rule once an approved Brief change alters what the Lead answers under; one without a rule is cleared as before", () => {
		const ruled: EffortLine = { type: "request-answered", teammate: "dev-1", request: "p1", task: "rename", decision: { behavior: "allow" }, rule: "Bash(npm test:*)", at: "2026-11-02T12:05:00.000Z" };
		const done_ = applied([...running, ruled], hook(2, "Stop", { session_id: FIRST }, true));
		const ask: EffortInput = { kind: "request-approval", checkpoint: "brief-change", path: "/agent/team/efforts/software-2026-11-02/brief.draft.md", sha256: "c".repeat(64), snapshot: "---\n---\n", affects: [], at: "2026-11-02T12:10:00.000Z" };
		const asked = applied(done_, ask);

		const answered = run(asked, { kind: "answer", id: "r2", answer: "approved", terms: true, at: "2026-11-02T12:11:00.000Z" });
		assert.ok(answered.ok, answered.ok ? "" : answered.refusal);
		const wake = answered.actions.find((action) => action.kind === "wake-lead");
		assert.match(wake?.kind === "wake-lead" ? wake.text : "", /`dev-1` holds session rules .* fresh session at its next Task/);
		const result = run(applied([...asked, ...answered.append], review("accept")), { kind: "handoff", slug: "docs", at: "2026-11-02T14:00:00.000Z" });
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.match(result.reply ?? "", /^started dev-1 afresh on Task `docs`/);

		const unruled = applied(applied(running, hook(2, "Stop", { session_id: FIRST }, true)), ask);
		const plain = run(unruled, { kind: "answer", id: "r2", answer: "approved", terms: true, at: "2026-11-02T12:11:00.000Z" });
		assert.ok(plain.ok);
		const next = run(applied([...unruled, ...plain.append], review("accept")), { kind: "handoff", slug: "docs", at: "2026-11-02T14:00:00.000Z" });
		assert.match(next.ok ? (next.reply ?? "") : "", /^reused dev-1 on Task `docs`/);
	});
});

describe("a Teammate's held requests", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const started = applied(
		applied(approved, {
			kind: "plan",
			tasks: [{ slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1"] }],
			criteria: ["AC1"],
			roles: ["dev"],
			at: "2026-11-02T11:10:00.000Z",
		}),
		{ kind: "handoff", slug: "rename", at: "2026-11-02T11:30:00.000Z" },
	);
	const RESULT = "/agent/team/efforts/software-2026-11-02/tasks/001-dev-rename/result-1.md";
	const SESSION = "8f3c2a1b-0000-4000-8000-000000000001";
	const BASH = { command: "npm publish --dry-run", description: "Check the package contents" };
	const QUESTIONS = {
		questions: [
			{ question: "Which store should the renamed key live in?", header: "Store", multiSelect: false, options: [{ label: "Redis", description: "Shared" }, { label: "Memory", description: "Per process" }] },
			{ question: "Which callers should move now?", header: "Callers", multiSelect: true, options: [{ label: "api", description: "" }, { label: "worker", description: "" }] },
		],
	};

	function line(cursor: number, event: string, extra: Partial<JournalLine> = {}, payload?: Record<string, unknown>): Extract<EffortInput, { kind: "journal" }> {
		return {
			kind: "journal",
			teammate: "dev-1",
			cursor,
			line: { from: "hook", at: `2026-11-02T11:4${cursor}:00.000Z`, event, ...(payload === undefined ? {} : { payload: { session_id: SESSION, hook_event_name: event, ...payload } }), ...extra },
			result: { path: RESULT, written: false },
		};
	}

	function asked(cursor: number, request: string, tool = "Bash", input: Record<string, unknown> = BASH): Extract<EffortInput, { kind: "journal" }> {
		return line(cursor, "PermissionRequest", { request } as Partial<JournalLine>, { tool_name: tool, tool_input: input });
	}

	function answer(request: string, extra: Partial<Extract<EffortInput, { kind: "answer-request" }>>): Extract<EffortInput, { kind: "answer-request" }> {
		return { kind: "answer-request", request, at: "2026-11-02T11:50:00.000Z", ...extra };
	}

	/** The decision a successful answer sends the hook holding the request. */
	function decision(result: Step): unknown {
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		const action = result.actions.find((each) => each.kind === "answer-hook");
		assert.ok(action?.kind === "answer-hook", "expected an answer-hook action");
		return action.decision;
	}

	function wake(result: Step): string {
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		const action = result.actions.find((each) => each.kind === "wake-lead");
		assert.ok(action?.kind === "wake-lead", "expected the Lead to be woken");
		return action.text;
	}

	const held = applied(started, asked(1, "req-0000000a"));

	it("wakes the Lead with a permission request: who asks, on which Task, for what, and that the terminal can answer first", () => {
		const text = wake(run(started, asked(1, "req-0000000a")));

		assert.match(text, /`dev-1` asks permission to use `Bash` on Task `rename` \(`req-0000000a`\)/);
		assert.match(text, /npm publish --dry-run/);
		assert.match(text, /team_answer/);
		assert.match(text, /live in dev-1's terminal; the first answer wins/);
	});

	it("sends an allow or a deny to the hook holding the request, each with the Lead's reason", () => {
		assert.deepEqual(decision(run(held, answer("req-0000000a", { decision: "allow", reason: "a dry run publishes nothing" }))), { behavior: "allow" });
		assert.deepEqual(decision(run(held, answer("req-0000000a", { decision: "deny", reason: "publishing is the human's call" }))), {
			behavior: "deny",
			message: "publishing is the human's call",
		});
	});

	it("passes a rule only as a session-scoped rule for the request's tool, and keeps it on the Teammate with its Task", () => {
		const result = run(held, answer("req-0000000a", { decision: "allow", reason: "dry runs are harmless", rule: "Bash(npm publish --dry-run:*)" }));

		assert.deepEqual(decision(result), {
			behavior: "allow",
			updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm publish --dry-run:*" }], behavior: "allow", destination: "session" }],
		});
		assert.ok(result.ok);
		assert.deepEqual(result.state.teammates[0].rules, [{ rule: "Bash(npm publish --dry-run:*)", task: "rename" }]);
	});

	it("refuses an answer without a decision or a reason, a rule on a deny or for another tool, and answers to a permission request", () => {
		assert.match(refusal(held, answer("req-0000000a", { reason: "fine" })), /allow or deny/);
		assert.match(refusal(held, answer("req-0000000a", { decision: "allow" })), /reason/);
		assert.match(refusal(held, answer("req-0000000a", { decision: "deny", reason: "no", rule: "Bash(npm:*)" })), /only with an allow/);
		assert.match(refusal(held, answer("req-0000000a", { decision: "allow", reason: "ok", rule: "Edit(src/**)" })), /`Bash`/);
		assert.match(refusal(held, answer("req-0000000a", { decision: "allow", reason: "ok", rule: "Bash(" })), /`Bash\(npm test:\*\)`/);
		assert.match(refusal(held, answer("req-0000000a", { answers: { x: "y" } })), /AskUserQuestion/);
	});

	it("refuses a request no hook holds, naming the ones that are held", () => {
		assert.match(refusal(held, answer("req-ffffffff", { decision: "allow", reason: "ok" })), /`req-0000000a`/);
		assert.match(refusal(started, answer("req-ffffffff", { decision: "allow", reason: "ok" })), /no request is held/);
	});

	it("wakes the Lead with an AskUserQuestion's questions and their options, one or any", () => {
		const text = wake(run(started, asked(1, "req-0000000b", "AskUserQuestion", QUESTIONS)));

		assert.match(text, /`dev-1` asks on Task `rename` \(`req-0000000b`\)/);
		assert.match(text, /"Which store should the renamed key live in\?" \(one of `Redis`, `Memory`\)/);
		assert.match(text, /"Which callers should move now\?" \(any of `api`, `worker`\)/);
		assert.match(text, /answers/);
	});

	it("answers an AskUserQuestion as an allow with every original field unchanged plus answers keyed by the exact question text", () => {
		const question = applied(started, asked(1, "req-0000000b", "AskUserQuestion", QUESTIONS));
		const answers = { "Which store should the renamed key live in?": "Redis", "Which callers should move now?": ["api", "worker"] };

		assert.deepEqual(decision(run(question, answer("req-0000000b", { answers }))), { behavior: "allow", updatedInput: { ...QUESTIONS, answers } });
	});

	it("refuses answers that miss a question, name one it didn't ask, or give one label where it allows many and back", () => {
		const question = applied(started, asked(1, "req-0000000b", "AskUserQuestion", QUESTIONS));
		const store = "Which store should the renamed key live in?";
		const callers = "Which callers should move now?";

		assert.match(refusal(question, answer("req-0000000b", { answers: { [store]: "Redis" } })), /Which callers should move now\?/);
		assert.match(refusal(question, answer("req-0000000b", { answers: { [store]: "Redis", [callers]: ["api"], "Which store?": "Redis" } })), /"Which store\?"/);
		assert.match(refusal(question, answer("req-0000000b", { answers: { [store]: "Redis", [callers]: "api" } })), /list of labels/);
		assert.match(refusal(question, answer("req-0000000b", { answers: { [store]: ["Redis"], [callers]: ["api"] } })), /one label/);
		assert.match(refusal(question, answer("req-0000000b", { decision: "allow", reason: "ok" })), /answers/);
	});

	it("refuses a second answer: the first answer wins", () => {
		const answered = applied(held, answer("req-0000000a", { decision: "allow", reason: "a dry run publishes nothing" }));

		assert.match(refusal(answered, answer("req-0000000a", { decision: "deny", reason: "changed my mind" })), /already answered: you answered it/);
	});

	it("drops the Lead's pending decision when a PostToolUse shows the request was answered in the terminal, by tool call id or by tool and input", () => {
		const byId = applied(started, line(1, "PermissionRequest", { request: "req-0000000a" } as Partial<JournalLine>, { tool_name: "Bash", tool_input: BASH, tool_use_id: "toolu_01" }));
		const settledById = run(byId, line(2, "PostToolUse", {}, { tool_name: "Bash", tool_input: BASH, tool_use_id: "toolu_01", tool_response: {} }));
		const settledByInput = run(held, line(2, "PostToolUse", {}, { tool_name: "Bash", tool_input: BASH, tool_response: {} }));

		for (const [lines, result] of [
			[byId, settledById],
			[held, settledByInput],
		] as const) {
			assert.ok(result.ok, result.ok ? "" : result.refusal);
			assert.deepEqual(result.actions, []);
			assert.match(refusal([...lines, ...result.append], answer("req-0000000a", { decision: "allow", reason: "ok" })), /already answered: the human answered it in dev-1's terminal/);
		}
	});

	it("ignores a PostToolUse for a call no request held, and one after the Lead's own answer", () => {
		const other = run(held, line(2, "PostToolUse", {}, { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: {} }));
		const answered = applied(held, answer("req-0000000a", { decision: "allow", reason: "ok" }));
		const after = run(answered, line(2, "PostToolUse", {}, { tool_name: "Bash", tool_input: BASH, tool_response: {} }));

		assert.ok(other.ok && after.ok);
		assert.deepEqual([other.append, after.append], [[], []]);
		assert.match(refusal([...answered, ...after.append], answer("req-0000000a", { decision: "deny", reason: "no" })), /you answered it/);
	});

	it("records a held hook killed by the terminal as denied in the terminal, refusing the Lead's answer after it", () => {
		const denied = applied(held, line(2, "denied-in-terminal", { request: "req-0000000a" } as Partial<JournalLine>));

		assert.match(refusal(denied, answer("req-0000000a", { decision: "allow", reason: "ok" })), /already answered: the human denied it in dev-1's terminal/);
	});

	it("takes a PostToolUse after the kill as the human's allow in the terminal", () => {
		const denied = applied(held, line(2, "denied-in-terminal", { request: "req-0000000a" } as Partial<JournalLine>));
		const ran = applied(denied, line(3, "PostToolUse", {}, { tool_name: "Bash", tool_input: BASH, tool_response: {} }));

		assert.match(refusal(ran, answer("req-0000000a", { decision: "deny", reason: "no" })), /already answered: the human answered it in dev-1's terminal/);
	});

	describe("one whose hook gave up holding it", () => {
		const expired = applied(held, line(2, "hold-expired", { request: "req-0000000a" } as Partial<JournalLine>));

		it("waits on the human as an 'answer in dev-1's terminal' item, until the Teammate goes on", () => {
			assert.deepEqual(
				waitingInTerminal(fold(expired)).map((each) => [each.request, each.teammate, each.tool]),
				[["req-0000000a", "dev-1", "Bash"]],
			);
			assert.match(refusal(expired, answer("req-0000000a", { decision: "allow", reason: "ok" })), /only the human can answer it now, in dev-1's terminal/);

			const answered = applied(expired, line(3, "PostToolUse", {}, { tool_name: "Bash", tool_input: BASH, tool_response: {} }));
			const stopped = applied(expired, line(3, "Stop", {}, { last_assistant_message: "I stopped." }));
			assert.deepEqual([waitingInTerminal(fold(answered)), waitingInTerminal(fold(stopped))], [[], []]);
		});

		it("shows in a Report's Waiting on you, with the attach command", () => {
			const result = run(expired, { kind: "report", headline: "On track.", criteria: ["AC1"], modes: [], at: "2026-11-02T12:00:00.000Z" });

			assert.ok(result.ok, result.ok ? "" : result.refusal);
			const action = result.actions.find((each) => each.kind === "write-report");
			assert.ok(action?.kind === "write-report");
			assert.deepEqual(action.report.sections.find((each) => each.title === "Waiting on you")?.lines, [
				"`req-0000000a`: answer dev-1's `Bash` prompt in dev-1's terminal (`/team attach dev-1`)",
			]);
		});
	});

	it("logs every answer, rule and grant with its Task for the next Report's Decided for you", () => {
		const question = applied(held, asked(2, "req-0000000b", "AskUserQuestion", QUESTIONS));
		const answered = applied(
			applied(question, answer("req-0000000a", { decision: "allow", reason: "the Brief asks for a dry run", rule: "Bash(npm publish --dry-run:*)", grant: "publish-dry-run" })),
			answer("req-0000000b", { answers: { "Which store should the renamed key live in?": "Redis", "Which callers should move now?": ["api", "worker"] } }),
		);

		const result = run(answered, { kind: "report", headline: "On track.", criteria: ["AC1"], modes: [], at: "2026-11-02T12:00:00.000Z" });

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		const action = result.actions.find((each) => each.kind === "write-report");
		assert.ok(action?.kind === "write-report");
		assert.deepEqual(action.report.sections.find((each) => each.title === "Decided for you")?.lines, [
			"11:50 allowed dev-1's `Bash` `npm publish --dry-run`: the Brief asks for a dry run (Task `rename`)",
			"11:50 added session rule `Bash(npm publish --dry-run:*)` for dev-1 (Task `rename`)",
			"11:50 used grant `publish-dry-run` for dev-1's `Bash` (Task `rename`)",
			'11:50 answered dev-1\'s "Which store should the renamed key live in?": Redis; "Which callers should move now?": api, worker (Task `rename`)',
		]);
	});

	describe("escalated to the human", () => {
		const INBOX = { socket: "/tmp/cc-socks/4242.sock", token: "inbox-token" };
		const session = applied(started, line(1, "SessionStart", { inbox: INBOX }, { source: "startup" }));
		const prompt = applied(session, asked(2, "req-0000000a"));
		const question = applied(session, asked(2, "req-0000000b", "AskUserQuestion", QUESTIONS));
		const stoppedShort = applied(session, line(2, "Stop", {}, { last_assistant_message: "Should the old key keep working for a release?" }));
		const STORE = "Which store should the renamed key live in?";
		const CALLERS = "Which callers should move now?";

		function escalate(extra: Partial<Extract<EffortInput, { kind: "escalate" }>>): Extract<EffortInput, { kind: "escalate" }> {
			return { kind: "escalate", summary: "Publishing is outside the Brief.", at: "2026-11-02T11:48:00.000Z", ...extra };
		}

		function human(id: string, extra: Partial<Extract<EffortInput, { kind: "answer-escalation" }>>): Extract<EffortInput, { kind: "answer-escalation" }> {
			return { kind: "answer-escalation", id, at: "2026-11-02T11:55:00.000Z", ...extra };
		}

		function actionOf<K extends EffortAction["kind"]>(result: Step, kind: K): Extract<EffortAction, { kind: K }> | undefined {
			assert.ok(result.ok, result.ok ? "" : result.refusal);
			return result.actions.find((each): each is Extract<EffortAction, { kind: K }> => each.kind === kind);
		}

		function reported(lines: EffortLine[], title: string): string[] | undefined {
			const result = run(lines, { kind: "report", headline: "On track.", criteria: ["AC1"], modes: [], at: "2026-11-02T12:00:00.000Z" });
			const action = actionOf(result, "write-report");
			return action?.report.sections.find((each) => each.title === title)?.lines;
		}

		it("moves a held permission request to the human's pending items with the Lead's summary, so only that Task waits", () => {
			const result = run(prompt, escalate({ request: "req-0000000a" }));

			assert.ok(result.ok, result.ok ? "" : result.refusal);
			assert.deepEqual(result.actions, []);
			assert.match(result.reply ?? "", /`req-0000000a`.*`\/team pending`/);
			assert.match(result.reply ?? "", /Only Task `rename` waits/);
			assert.deepEqual(
				openEscalations(result.state).map((each) => [each.id, each.teammate, each.task, each.kind, each.summary]),
				[["req-0000000a", "dev-1", "rename", "permission", "Publishing is outside the Brief."]],
			);
		});

		it("refuses a request no hook holds, one already escalated, and an escalation without a summary", () => {
			assert.match(refusal(prompt, escalate({ request: "req-ffffffff" })), /`req-0000000a`/);
			const answered = applied(prompt, answer("req-0000000a", { decision: "deny", reason: "no" }));
			assert.match(refusal(answered, escalate({ request: "req-0000000a" })), /already answered/);
			const escalated = applied(prompt, escalate({ request: "req-0000000a" }));
			assert.match(refusal(escalated, escalate({ request: "req-0000000a" })), /already escalated/);
			assert.match(refusal(prompt, escalate({ request: "req-0000000a", summary: " " })), /summary/);
			assert.match(refusal(prompt, escalate({})), /request.*teammate/);
		});

		it("takes only the human's answer to an escalated permission: the Lead's is refused, the human's reaches the hook and wakes the Lead", () => {
			const escalated = applied(prompt, escalate({ request: "req-0000000a" }));

			assert.match(refusal(escalated, answer("req-0000000a", { decision: "allow", reason: "the human said so in chat" })), /only the human.*`\/team pending`/);
			const result = run(escalated, human("req-0000000a", { decision: "deny", reason: "Not this release." }));

			assert.deepEqual(decision(result), { behavior: "deny", message: "Not this release." });
			assert.match(wake(result), /The human denied `req-0000000a`.*Not this release\./s);
			assert.equal(actionOf(result, "append-clarification"), undefined, "a permission is no question for clarifications.md");
			assert.ok(result.ok);
			assert.deepEqual(openEscalations(result.state), []);
			assert.deepEqual(result.state.decided, [], "the human decided it, so nothing is decided for them");
			assert.match(refusal([...escalated, ...result.append], human("req-0000000a", { decision: "allow", reason: "ok" })), /already answered/);
		});

		it("appends the human's answer to an escalated AskUserQuestion to clarifications.md with who asked, the Task and what the Brief said", () => {
			const escalated = applied(question, escalate({ request: "req-0000000b", summary: "The Brief names no store.", brief: "AC1 only says the key is renamed." }));
			const answers = { [STORE]: "Redis", [CALLERS]: ["api"] };

			const result = run(escalated, human("req-0000000b", { answers }));

			assert.deepEqual(decision(result), { behavior: "allow", updatedInput: { ...QUESTIONS, answers } });
			assert.deepEqual(actionOf(result, "append-clarification")?.entry, {
				id: "req-0000000b",
				teammate: "dev-1",
				task: "rename",
				question: `"${STORE}" (one of \`Redis\`, \`Memory\`); "${CALLERS}" (any of \`api\`, \`worker\`)`,
				summary: "The Brief names no store.",
				brief: "AC1 only says the key is renamed.",
				answer: `"${STORE}": Redis; "${CALLERS}": api`,
				via: "pending",
				at: "2026-11-02T11:55:00.000Z",
			});
			assert.match(wake(result), /The human answered `req-0000000b`/);
		});

		it("takes the human's answer to an escalated question relayed from chat through team_answer, as theirs and with no wake", () => {
			const escalated = applied(question, escalate({ request: "req-0000000b" }));

			const result = run(escalated, answer("req-0000000b", { answers: { [STORE]: "Memory", [CALLERS]: ["worker"] } }));

			assert.equal(actionOf(result, "append-clarification")?.entry.via, "lead");
			assert.equal(actionOf(result, "wake-lead"), undefined);
			assert.ok(result.ok);
			assert.deepEqual(result.state.decided, []);
			assert.match(result.reply ?? "", /clarifications\.md/);
		});

		it("refuses an answer the escalated question can't take, as team_answer does", () => {
			const escalated = applied(question, escalate({ request: "req-0000000b" }));

			assert.match(refusal(escalated, human("req-0000000b", { answers: { [STORE]: "Redis" } })), /Which callers should move now\?/);
			assert.match(refusal(escalated, human("req-ffffffff", { answers: {} })), /No escalated item `req-ffffffff`/);
		});

		it("escalates a prose question from a Teammate that stopped short, answered as free text sent to it and kept in clarifications.md", () => {
			const result = run(stoppedShort, escalate({ teammate: "dev-1", question: "Should the old key keep working for a release?", summary: "Deprecation isn't in the Brief." }));
			assert.ok(result.ok, result.ok ? "" : result.refusal);
			assert.deepEqual(
				openEscalations(result.state).map((each) => [each.id, each.kind, each.question]),
				[["q1", "prose", "Should the old key keep working for a release?"]],
			);
			const escalated = [...stoppedShort, ...result.append];

			assert.match(refusal(escalated, human("q1", { text: " " })), /answer/);
			const answered = run(escalated, human("q1", { text: "Yes, for one release." }));

			const sent = actionOf(answered, "send-message");
			assert.deepEqual([sent?.teammate, sent?.inbox], ["dev-1", INBOX]);
			assert.match(sent?.message ?? "", /Yes, for one release\./);
			assert.match(sent?.message ?? "", /clarifications\.md/);
			assert.equal(actionOf(answered, "append-clarification")?.entry.answer, "Yes, for one release.");
			assert.match(wake(answered), /The human answered `q1`/);
			assert.ok(answered.ok);
			assert.deepEqual(openEscalations(answered.state), []);
		});

		it("takes a prose answer relayed from chat through team_answer's text", () => {
			const escalated = applied(stoppedShort, escalate({ teammate: "dev-1", question: "Keep the old key?" }));

			const result = run(escalated, answer("q1", { text: "Keep it for a release." }));

			assert.equal(actionOf(result, "send-message")?.teammate, "dev-1");
			assert.equal(actionOf(result, "append-clarification")?.entry.via, "lead");
		});

		it("refuses a prose question from a Teammate it doesn't know or that hasn't stopped short, and a second one while the first is open", () => {
			assert.match(refusal(stoppedShort, escalate({ teammate: "qa-1", question: "?" })), /no Teammate `qa-1`/);
			assert.match(refusal(session, escalate({ teammate: "dev-1", question: "Keep the old key?" })), /stopped short/);
			assert.match(refusal(stoppedShort, escalate({ teammate: "dev-1" })), /question/);
			const escalated = applied(stoppedShort, escalate({ teammate: "dev-1", question: "Keep the old key?" }));
			assert.match(refusal(escalated, escalate({ teammate: "dev-1", question: "And the docs?" })), /`q1`/);
		});

		it("takes the human's allow of an escalated floor action, which the Lead could not allow", () => {
			const force = applied(session, asked(2, "req-0000000c", "Bash", { command: "git push --force origin HEAD" }));
			assert.match(refusal(force, answer("req-0000000c", { decision: "allow", reason: "ok" })), /team_escalate/);
			const escalated = applied(force, escalate({ request: "req-0000000c", summary: "A force push rewrites history." }));

			const result = run(escalated, human("req-0000000c", { decision: "allow", reason: "Rewriting it is fine this once." }));

			assert.deepEqual(decision(result), { behavior: "allow" });
			assert.match(wake(result), /The human allowed `req-0000000c`/);
		});

		it("lets an escalated prompt go once the Teammate's turn ends or its hook gives up, so nothing counts twice", () => {
			const escalated = applied(prompt, escalate({ request: "req-0000000a" }));
			const expired = applied(escalated, line(3, "hold-expired", { request: "req-0000000a" } as Partial<JournalLine>));
			const ended = applied(escalated, line(3, "Stop", {}, { last_assistant_message: "I stopped." }));

			assert.deepEqual([openEscalations(fold(expired)), waitingInTerminal(fold(expired)).length], [[], 1]);
			assert.deepEqual(openEscalations(fold(ended)), []);
			assert.match(refusal(expired, human("req-0000000a", { decision: "allow", reason: "ok" })), /only the human can answer it now, in dev-1's terminal/);
		});

		it("tells the next Report what was escalated and answered, and what still waits on the human", () => {
			const one = applied(prompt, escalate({ request: "req-0000000a" }));
			const two = applied(applied(one, asked(3, "req-0000000b", "AskUserQuestion", QUESTIONS)), escalate({ request: "req-0000000b", summary: "The Brief names no store." }));
			const answered = applied(two, human("req-0000000b", { answers: { [STORE]: "Redis", [CALLERS]: ["api", "worker"] } }));

			assert.deepEqual(reported(answered, "Waiting on you"), ["`req-0000000a`: dev-1's `Bash` prompt on Task `rename`, escalated: Publishing is outside the Brief. Answer it in `/team pending`"]);
			const since = reported(answered, "Since the last Report") ?? [];
			assert.ok(since.includes("11:48 escalated dev-1's `Bash` prompt (`req-0000000a`) to you: Publishing is outside the Brief."), since.join("\n"));
			assert.ok(since.includes(`11:55 you answered \`req-0000000b\`: "${STORE}": Redis; "${CALLERS}": api, worker`), since.join("\n"));
		});
	});

	describe("team_send", () => {
		const INBOX = { socket: "/tmp/cc-socks/4242.sock", token: "inbox-token" };
		const session = applied(started, line(1, "SessionStart", { inbox: INBOX }, { source: "startup" }));

		function send(teammate: string, message: string): Extract<EffortInput, { kind: "send" }> {
			return { kind: "send", teammate, message, at: "2026-11-02T11:50:00.000Z" };
		}

		it("sends a prose message to a Teammate's inbox, on record", () => {
			const result = run(session, send("dev-1", "Rename it in docs/config.md too."));

			assert.ok(result.ok, result.ok ? "" : result.refusal);
			assert.deepEqual(result.actions, [{ kind: "send-message", teammate: "dev-1", inbox: INBOX, message: "Rename it in docs/config.md too." }]);
			assert.deepEqual(result.append.map((each) => each.type), ["message-sent"]);
		});

		it("refuses a Teammate it doesn't know, one with no session yet, one that ended, and an empty or long message", () => {
			assert.match(refusal(session, send("qa-1", "hi")), /no Teammate `qa-1`.*`dev-1`/);
			assert.match(refusal(started, send("dev-1", "hi")), /no session yet/);
			const crashed = applied(session, line(2, "SessionEnd", {}, { reason: "other" }));
			assert.match(refusal(crashed, send("dev-1", "hi")), /ended/);
			assert.match(refusal(session, send("dev-1", "  ")), /empty/);
			assert.match(refusal(session, send("dev-1", "x".repeat(2001))), /2000/);
		});
	});

	describe("the floor guard", () => {
		const TERMS = {
			workspace: "/work/app-ws",
			grants: [
				{ id: "push-effort-branch", allow: "Push the Effort's branch to origin.", from: "Playbook" as const },
				{ id: "open-pr", allow: "Open the PR the Delivery asks for.", from: "Brief" as const },
			],
			delivery: "One PR against main.",
			escalate: [{ id: "history-rewrite", ask: ["Bash(git rebase:*)", "Bash(git push --force:*)"] }],
		};
		const bash = (cursor: number, request: string, command: string) => applied(started, asked(cursor, request, "Bash", { command }));
		const pushing = bash(1, "req-0000000c", "git -C . push origin HEAD");

		function logged(result: Step): string[] {
			assert.ok(result.ok, result.ok ? "" : result.refusal);
			return result.append.flatMap((each) => (each.type === "decided-for-you" ? [each.what] : []));
		}

		it("refuses an uncited allow of a floor action, naming its kind and what the Lead may cite instead", () => {
			const text = refusal(pushing, answer("req-0000000c", { decision: "allow", reason: "the Brief wants a PR", terms: TERMS }));

			assert.match(text, /floor push/);
			assert.match(text, /`git -C \. push origin HEAD`/);
			assert.match(text, /`push-effort-branch`/);
			assert.match(text, /`open-pr`/);
			assert.match(text, /`delivery`/);
			assert.match(text, /team_escalate/);
		});

		it("refuses a grant neither the Playbook nor the Brief has, and the Delivery when the Brief has none", () => {
			assert.match(refusal(pushing, answer("req-0000000c", { decision: "allow", reason: "ok", grant: "push-anything", terms: TERMS })), /no grant `push-anything`/);
			assert.match(refusal(pushing, answer("req-0000000c", { decision: "allow", reason: "ok", grant: "delivery", terms: { ...TERMS, delivery: undefined } })), /no grant `delivery`/);
		});

		it("takes an allow citing a Playbook grant, a Brief override grant or the Brief's Delivery, and logs what it relied on", () => {
			assert.deepEqual(logged(run(pushing, answer("req-0000000c", { decision: "allow", reason: "the Effort's branch", grant: "push-effort-branch", terms: TERMS }))), [
				"allowed dev-1's `Bash` `git -C . push origin HEAD`: the Effort's branch",
				"used grant `push-effort-branch` (Playbook: Push the Effort's branch to origin.) for dev-1's floor push `git -C . push origin HEAD`",
			]);
			assert.deepEqual(logged(run(pushing, answer("req-0000000c", { decision: "allow", reason: "the PR", grant: "open-pr", terms: TERMS })))[1], "used grant `open-pr` (Brief override: Open the PR the Delivery asks for.) for dev-1's floor push `git -C . push origin HEAD`");
			assert.deepEqual(logged(run(pushing, answer("req-0000000c", { decision: "allow", reason: "the PR", grant: "delivery", terms: TERMS })))[1], "used the Brief's Delivery (One PR against main.) for dev-1's floor push `git -C . push origin HEAD`");
			assert.deepEqual(decision(run(pushing, answer("req-0000000c", { decision: "allow", reason: "the PR", grant: "delivery", terms: TERMS }))), { behavior: "allow" });
		});

		it("adds no session rule for a floor action, so each one comes back to be answered", () => {
			assert.match(refusal(pushing, answer("req-0000000c", { decision: "allow", reason: "ok", grant: "push-effort-branch", rule: "Bash(git push:*)", terms: TERMS })), /no session `rule`/);
		});

		it("lets a deny through uncited, and fails closed without the Brief's terms", () => {
			assert.deepEqual(decision(run(pushing, answer("req-0000000c", { decision: "deny", reason: "not yet" }))), { behavior: "deny", message: "not yet" });
			assert.match(refusal(pushing, answer("req-0000000c", { decision: "allow", reason: "ok", grant: "push-effort-branch" })), /no grant `push-effort-branch`/);
		});

		it("judges a delete against the folder the Teammate works in", () => {
			assert.deepEqual(decision(run(bash(1, "req-0000000d", "rm -rf build"), answer("req-0000000d", { decision: "allow", reason: "a build folder", terms: TERMS }))), { behavior: "allow" });
			assert.match(refusal(bash(1, "req-0000000d", "rm -rf /work/app"), answer("req-0000000d", { decision: "allow", reason: "ok", terms: TERMS })), /floor delete/);
			const inSub = (command: string) => applied(started, line(1, "PermissionRequest", { request: "req-0000000d" } as Partial<JournalLine>, { tool_name: "Bash", tool_input: { command }, cwd: "/work/app-ws/sub" }));
			assert.deepEqual(decision(run(inSub("rm -rf ../build"), answer("req-0000000d", { decision: "allow", reason: "a build folder", terms: TERMS }))), { behavior: "allow" });
			assert.match(refusal(inSub("rm -rf ../../app"), answer("req-0000000d", { decision: "allow", reason: "ok", terms: TERMS })), /floor delete/);
		});

		it("keeps a request an escalate entry asks about from the Lead's allow, cited or not, sending it to team_escalate", () => {
			const rebasing = bash(1, "req-0000000e", "git rebase main");
			const text = refusal(rebasing, answer("req-0000000e", { decision: "allow", reason: "a tidy history", grant: "push-effort-branch", terms: TERMS }));
			assert.match(text, /`history-rewrite`/);
			assert.match(text, /team_escalate/);
			assert.match(refusal(bash(1, "req-0000000f", "sh -c 'git push --force origin HEAD'"), answer("req-0000000f", { decision: "allow", reason: "ok", grant: "push-effort-branch", terms: TERMS })), /`history-rewrite`/);
			assert.deepEqual(decision(run(rebasing, answer("req-0000000e", { decision: "deny", reason: "the human decides history" }))), { behavior: "deny", message: "the human decides history" });
		});
	});
});

describe("reporting", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const planned = applied(approved, {
		kind: "plan",
		tasks: [
			{ slug: "design", role: "architect", goal: "Design the rename.", criteria: ["AC2"] },
			{ slug: "rename", role: "dev", goal: "Rename the key.", dependsOn: ["design"], criteria: ["AC1"] },
		],
		criteria: ["AC1", "AC2"],
		roles: ["architect", "dev"],
		at: "2026-11-02T11:10:00.000Z",
	});
	const MODES = [
		{ role: "architect", mode: "auto" },
		{ role: "dev", mode: "acceptEdits" },
	];

	function report(at: string, extra: Partial<Extract<EffortInput, { kind: "report" }>> = {}): Extract<EffortInput, { kind: "report" }> {
		return { kind: "report", headline: "On track.", criteria: ["AC1", "AC2"], modes: MODES, at, ...extra };
	}

	/** The Report a successful step asks the shell to write. */
	function written(result: Step) {
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		const action = result.actions.find((each) => each.kind === "write-report");
		assert.ok(action?.kind === "write-report", "expected a write-report action");
		return action.report;
	}

	function section(result: Step, title: string): string[] | undefined {
		return written(result).sections.find((each) => each.title === title)?.lines;
	}

	it("numbers Reports consecutively, keeping the last number in effort.jsonl", () => {
		const first = run(planned, report("2026-11-02T11:15:00.000Z"));
		assert.equal(written(first).n, 1);
		assert.ok(first.ok);
		assert.deepEqual(first.append, [{ type: "report-written", n: 1, at: "2026-11-02T11:15:00.000Z" }]);
		assert.equal(first.state.reports, 1);

		const second = run([...planned, ...first.append], report("2026-11-02T12:00:00.000Z"));
		assert.equal(written(second).n, 2);
		assert.equal(fold([...planned, ...first.append, ...(second.ok ? second.append : [])]).reports, 2);
	});

	it("covers only what happened since the last Report", () => {
		const first = applied(planned, report("2026-11-02T11:15:00.000Z"));
		const handed = applied(first, { kind: "handoff", slug: "design", at: "2026-11-02T11:30:00.000Z", mode: "auto" });

		const firstSince = section(run(planned, report("2026-11-02T11:15:00.000Z")), "Since the last Report");
		assert.ok(firstSince?.some((line) => /approved the Brief/.test(line)));
		assert.ok(firstSince?.some((line) => /planned 2 Tasks/.test(line)));

		const since = section(run(handed, report("2026-11-02T12:00:00.000Z")), "Since the last Report");
		assert.deepEqual(since, ["11:30 handed Task `design` to architect-1"]);
	});

	it("tells of a Task queued at the cap and of a Teammate stopped to make room, but not of a clear asked for", () => {
		const first = applied(planned, report("2026-11-02T11:15:00.000Z"));
		const queued = applied(applied(first, { kind: "handoff", slug: "design", at: "2026-11-02T11:30:00.000Z", maxTeammates: 1 }), {
			kind: "handoff",
			slug: "rename",
			at: "2026-11-02T11:31:00.000Z",
			maxTeammates: 1,
		});
		const retired: EffortLine[] = [...queued, { type: "clear-requested", teammate: "architect-1", slug: "design", at: "2026-11-02T11:40:00.000Z" }, { type: "teammate-retired", teammate: "architect-1", at: "2026-11-02T11:45:00.000Z" }];

		const since = section(run(retired, report("2026-11-02T12:00:00.000Z")), "Since the last Report");

		assert.deepEqual(since, [
			"11:30 handed Task `design` to architect-1",
			"11:31 queued Task `rename`: cap 1 reached; waits for 001",
			"11:45 stopped idle architect-1 to make room",
		]);
	});

	it("refuses a Report before the Brief is approved, and coverage of a criterion the Brief doesn't have", () => {
		assert.match(refusal([OPENED], report("2026-11-02T10:30:00.000Z")), /plan Report/);
		assert.match(refusal(planned, report("2026-11-02T11:15:00.000Z", { coverage: [{ criterion: "AC9", note: "done" }] })), /`AC9`.*`AC1`, `AC2`/);
		assert.match(refusal(planned, report("2026-11-02T11:15:00.000Z", { headline: "  " })), /headline/);
	});

	it("gives the plan Report the plan, the Role modes and what waits on the human, and later Reports only the sections with something new", () => {
		const first = run(planned, report("2026-11-02T11:15:00.000Z", { coverage: [{ criterion: "AC1", note: "planned in `rename`" }] }));
		assert.deepEqual(written(first).coverage, [{ criterion: "AC1", note: "planned in `rename`" }]);
		assert.deepEqual(section(first, "Plan"), ["`design` (architect): planned", "`rename` (dev): planned"]);
		assert.deepEqual(section(first, "Teammate modes"), ["architect: auto", "dev: acceptEdits"]);
		assert.equal(section(first, "Waiting on you"), undefined);
		assert.equal(section(first, "Decided for you"), undefined);
		assert.equal(section(first, "Found work"), undefined);

		const reported = [...planned, ...(first.ok ? first.append : [])];
		const quiet = run(reported, report("2026-11-02T11:20:00.000Z"));
		assert.deepEqual(
			written(quiet).sections.map((each) => each.title),
			[],
		);
	});

	it("shows re-plan reasons and plan statuses once the plan changes", () => {
		const first = applied(planned, report("2026-11-02T11:15:00.000Z"));
		const replanned = applied(first, {
			kind: "plan",
			tasks: [{ slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1", "AC2"] }],
			criteria: ["AC1", "AC2"],
			roles: ["architect", "dev"],
			reason: "The design is a one-liner.",
			at: "2026-11-02T11:20:00.000Z",
		});

		const result = run(replanned, report("2026-11-02T11:25:00.000Z"));
		assert.deepEqual(section(result, "Since the last Report"), ["11:20 re-planned 1 Task"]);
		assert.deepEqual(section(result, "Plan"), ["`rename` (dev): planned", "re-planned at 11:20: The design is a one-liner."]);
		assert.equal(section(result, "Teammate modes"), undefined);
	});

	it("lists what was decided for the human since the last Report, and mode drift only on change", () => {
		const first = applied(planned, report("2026-11-02T11:15:00.000Z"));
		const handed = applied(first, { kind: "handoff", slug: "design", at: "2026-11-02T11:30:00.000Z", mode: "auto" });
		const logged: EffortLine[] = [
			...handed,
			{ type: "decided-for-you", what: "allowed `npm test` for architect-1", task: "design", at: "2026-11-02T11:35:00.000Z" },
			{ type: "teammate-mode", teammate: "architect-1", cursor: 1, mode: "manual", at: "2026-11-02T11:36:00.000Z" },
		];

		const result = run(logged, report("2026-11-02T12:00:00.000Z"));
		assert.deepEqual(section(result, "Decided for you"), ["11:35 allowed `npm test` for architect-1 (Task `design`)"]);
		assert.deepEqual(section(result, "Teammate modes"), ["architect-1: manual, launched in auto (11:36)"]);

		const next = run(applied(logged, report("2026-11-02T12:00:00.000Z")), report("2026-11-02T12:30:00.000Z"));
		assert.equal(section(next, "Decided for you"), undefined);
		assert.equal(section(next, "Teammate modes"), undefined);
	});

	it("keeps found work in the core's log, showing a running count and the new items", () => {
		const first = applied(planned, report("2026-11-02T11:15:00.000Z", { found: ["The cache key is also misspelt in docs."] }));
		assert.deepEqual(fold(first).found, [{ what: "The cache key is also misspelt in docs.", at: "2026-11-02T11:15:00.000Z" }]);

		const second = run(first, report("2026-11-02T12:00:00.000Z", { found: ["`old-config` has no tests."] }));
		assert.deepEqual(section(second, "Found work"), [
			"2 found so far outside the Brief, kept as suggestions for the final Report; new since the last Report:",
			"`old-config` has no tests.",
		]);

		const third = run(applied(first, report("2026-11-02T12:00:00.000Z", { found: ["`old-config` has no tests."] })), report("2026-11-02T12:30:00.000Z"));
		assert.deepEqual(section(third, "Found work"), ["2 found so far outside the Brief, kept as suggestions for the final Report; none new since the last Report."], "the running count stays in a Report with nothing new");
	});

	it("tells the Lead which found work is already on record, so it isn't reported again (#123)", () => {
		const none = run(planned, report("2026-11-02T11:15:00.000Z"));
		assert.ok(none.ok);
		assert.doesNotMatch(none.reply ?? "", /on record/, "nothing to list before anything is found");

		const first = run(planned, report("2026-11-02T11:15:00.000Z", { found: ["The cache key is also misspelt in docs."] }));
		assert.ok(first.ok);
		assert.match(first.reply ?? "", /Found work already on record \(1\), don't report these again, not even reworded:\n- The cache key is also misspelt in docs\./);

		const second = run(applied(planned, report("2026-11-02T11:15:00.000Z", { found: ["The cache key is also misspelt in docs."] })), report("2026-11-02T12:00:00.000Z", { found: ["`old-config` has no tests."] }));
		assert.ok(second.ok);
		assert.match(second.reply ?? "", /on record \(2\)[^]*\n- The cache key is also misspelt in docs\.\n- `old-config` has no tests\./);
	});

	it("logs found work once when the same text comes again, ignoring case and spacing (#123)", () => {
		const first = applied(planned, report("2026-11-02T11:15:00.000Z", { found: ["Docs misspell the key.", "  docs misspell the KEY.  "] }));
		assert.equal(fold(first).found.length, 1, "twice in one Report is one item");
		const second = run(first, report("2026-11-02T12:00:00.000Z", { found: [" DOCS MISSPELL THE KEY. "] }));
		assert.ok(second.ok);
		assert.equal(second.state.found.length, 1);
		assert.deepEqual(section(second, "Found work"), ["1 found so far outside the Brief, kept as suggestions for the final Report; none new since the last Report."]);
	});

	it("lists what waits on the human whenever something does", () => {
		const asked = applied([OPENED], request("b".repeat(64)));
		const approved2 = applied(asked, { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
		const waiting: EffortLine[] = [...approved2, { type: "approval-requested", id: "r2", checkpoint: "brief", path: DRAFT, sha256: "c".repeat(64), snapshot: "x", at: "2026-11-02T11:05:00.000Z" }];

		assert.deepEqual(section(run(waiting, report("2026-11-02T11:15:00.000Z")), "Waiting on you"), [
			`\`r2\`: approve the Brief, ${DRAFT} (sha256 ${"c".repeat(64)}), in \`/team pending\``,
		]);
	});
});

describe("attaching to a Teammate", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const started = applied(
		applied(approved, {
			kind: "plan",
			tasks: [{ slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1"] }],
			criteria: ["AC1"],
			roles: ["dev"],
			at: "2026-11-02T11:10:00.000Z",
		}),
		{ kind: "handoff", slug: "rename", at: "2026-11-02T11:30:00.000Z" },
	);
	const opened = applied(started, {
		kind: "journal",
		teammate: "dev-1",
		cursor: 1,
		line: { from: "hook", at: "2026-11-02T11:31:00.000Z", event: "SessionStart", payload: { session_id: "8f3c2a1b-0000-4000-8000-000000000001", source: "startup" } },
		result: { path: "", written: false },
	});
	/** A fresh session's `SessionStart` with a new short id, as a relaunch (#112) records it. */
	const fresh: EffortLine = { type: "teammate-session", teammate: "dev-1", cursor: 2, source: "startup", sessionId: "k3l4m5n6-0000", shortId: "k3l4m5n6", at: "2026-11-02T12:00:00.000Z" };

	it("records the short id last attached through pi, once per change", () => {
		const result = run(opened, { kind: "attach", teammate: "dev-1", at: "2026-11-02T11:40:00.000Z" });

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append, [{ type: "teammate-attached", teammate: "dev-1", shortId: "8f3c2a1b", at: "2026-11-02T11:40:00.000Z" }]);
		assert.deepEqual(result.actions, []);
		assert.equal(result.state.teammates[0].attached, "8f3c2a1b");

		const again = run([...opened, ...result.append], { kind: "attach", teammate: "dev-1", at: "2026-11-02T11:50:00.000Z" });
		assert.ok(again.ok);
		assert.deepEqual(again.append, []);
	});

	it("marks a short id new when a Teammate's session gets another, until the human attaches through pi", () => {
		assert.equal(fold(opened).teammates[0].newShortId, undefined);

		const relaunched = [...opened, fresh];
		assert.equal(fold(relaunched).teammates[0].shortId, "k3l4m5n6");
		assert.equal(fold(relaunched).teammates[0].newShortId, true);

		const attached = run(relaunched, { kind: "attach", teammate: "dev-1", at: "2026-11-02T12:10:00.000Z" });
		assert.ok(attached.ok);
		assert.deepEqual(attached.append, [{ type: "teammate-attached", teammate: "dev-1", shortId: "k3l4m5n6", at: "2026-11-02T12:10:00.000Z" }]);
		assert.equal(attached.state.teammates[0].newShortId, undefined);
		assert.equal(attached.state.teammates[0].cursor, 2, "attaching reads no journal line");
	});

	it("refuses a Teammate it doesn't know, or one with no short id to attach to yet", () => {
		assert.match(refusal(opened, { kind: "attach", teammate: "qa-1", at: "2026-11-02T11:40:00.000Z" }), /no Teammate `qa-1`/);
		assert.match(refusal(started, { kind: "attach", teammate: "dev-1", at: "2026-11-02T11:40:00.000Z" }), /`dev-1` has no short id yet/);
	});
});

describe("pauses", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const planned = applied(approved, {
		kind: "plan",
		tasks: [
			{ slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1"] },
			{ slug: "docs", role: "dev", goal: "Document it.", criteria: ["AC1"] },
			{ slug: "tests", role: "qa", goal: "Test it.", criteria: ["AC1"] },
		],
		criteria: ["AC1"],
		roles: ["dev", "qa"],
		at: "2026-11-02T11:10:00.000Z",
	});
	const T1 = "2026-11-02T12:00:00.000Z";
	const T2 = "2026-11-02T12:30:00.000Z";
	const USAGE: EffortLine = { type: "paused", by: "usage", reason: "session limit", at: "2026-11-02T12:10:00.000Z" };

	function pause(by: "human" | "lead", reason?: string, at = T1): EffortInput {
		return { kind: "pause", by, at, ...(reason === undefined ? {} : { reason }) };
	}

	function resume(by: "human" | "lead", at = T2): EffortInput {
		return { kind: "resume", by, at };
	}

	function setters(lines: EffortLine[]): string[] {
		return heldPauses(fold(lines)).map((each) => each.by);
	}

	it("keeps the human's, the Lead's and the usage pause apart: lifting one never lifts another, and the Effort runs only when none holds", () => {
		assert.deepEqual(setters(planned), []);
		const all = [...applied(applied(planned, pause("human")), pause("lead", "waiting on the API decision")), USAGE];
		assert.deepEqual(heldPauses(fold(all)), [
			{ by: "human", at: T1 },
			{ by: "lead", reason: "waiting on the API decision", at: T1 },
			{ by: "usage", reason: "session limit", at: "2026-11-02T12:10:00.000Z" },
		]);

		const leadLifted = applied(all, resume("lead"));
		assert.deepEqual(setters(leadLifted), ["human", "usage"]);
		const humanLifted = applied(leadLifted, resume("human"));
		assert.deepEqual(setters(humanLifted), ["usage"]);
		const usageLifted: EffortLine[] = [...humanLifted, { type: "resumed", by: "usage", at: "2026-11-02T13:00:00.000Z" }];
		assert.deepEqual(setters(usageLifted), []);
	});

	it("lifts a pause only for whoever set it: the Lead can't lift the human's, nor the human the Lead's", () => {
		assert.match(refusal(applied(planned, pause("human", "lunch")), resume("lead")), /isn't paused by you.*paused by the human.*only the human lifts it, with `\/team resume`/s);
		assert.match(refusal(applied(planned, pause("lead", "checking the API")), resume("human")), /isn't paused by you.*paused by the Lead since 12:00 UTC: checking the API; only the Lead lifts it, with `team_resume`/s);
		assert.match(refusal([...planned, USAGE], resume("lead")), /usage.*lifts at its reset/s);
		assert.match(refusal(planned, resume("human")), /isn't paused by you, so there is nothing to resume/);
	});

	it("refuses a pause its setter already holds, and a Lead pause without a reason", () => {
		assert.match(refusal(applied(planned, pause("human")), pause("human")), /already paused by you since 12:00 UTC/);
		assert.match(refusal(planned, pause("lead")), /reason/);
		assert.match(refusal(planned, pause("lead", "  ")), /reason/);
	});

	it("says on resume whether the Effort runs again or which pause still holds", () => {
		const both = applied(applied(planned, pause("human")), pause("lead", "checking the API"));
		const still = run(both, resume("human"));
		assert.ok(still.ok, still.ok ? "" : still.refusal);
		assert.deepEqual(still.append, [{ type: "resumed", by: "human", at: T2 }]);
		assert.deepEqual(still.actions, []);
		assert.match(still.reply ?? "", /still paused by the Lead since 12:00 UTC: checking the API, so nothing new starts/);

		const free = run(applied(planned, pause("human")), resume("human"));
		assert.ok(free.ok, free.ok ? "" : free.refusal);
		assert.match(free.reply ?? "", /runs again/);
	});

	it("while paused, a handoff queues with `paused` as the reason even under the cap, and a running Teammate is neither stopped nor kept from finishing", () => {
		const running = applied(planned, { kind: "handoff", slug: "rename", at: "2026-11-02T11:30:00.000Z" });
		const paused = run(running, pause("human", "lunch"));
		assert.ok(paused.ok, paused.ok ? "" : paused.refusal);
		assert.deepEqual(paused.append, [{ type: "paused", by: "human", reason: "lunch", at: T1 }]);
		assert.deepEqual(paused.actions, []);

		const queued = run([...running, ...paused.append], { kind: "handoff", slug: "tests", at: "2026-11-02T12:05:00.000Z" });
		assert.ok(queued.ok, queued.ok ? "" : queued.refusal);
		assert.deepEqual(queued.append, [{ type: "task-queued", slug: "tests", folder: "002-qa-tests", role: "qa", why: "paused", at: "2026-11-02T12:05:00.000Z" }]);
		assert.deepEqual(queued.actions, [{ kind: "write-task", slug: "tests", folder: "002-qa-tests" }, { kind: "write-plan" }]);
		assert.match(queued.reply ?? "", /^queued Task `tests` \(tasks\/002-qa-tests\/task\.md\): paused by the human since 12:00 UTC: lunch\. It starts by itself once every pause is lifted/);

		const lines = [...running, ...paused.append, ...queued.append];
		const session = applied(lines, {
			kind: "journal",
			teammate: "dev-1",
			cursor: 1,
			line: { from: "hook", at: "2026-11-02T12:06:00.000Z", event: "SessionStart", payload: { session_id: "dev-1000-0000-4000-8000-000000000001", source: "startup" }, inbox: { socket: "/tmp/dev-1.sock", token: "t" } },
			result: { path: "/r/result-1.md", written: false },
		});
		const done = run(session, {
			kind: "journal",
			teammate: "dev-1",
			cursor: 2,
			line: { from: "hook", at: "2026-11-02T12:07:00.000Z", event: "Stop", payload: { last_assistant_message: "Done." } },
			result: { path: "/r/result-1.md", written: true },
		});
		assert.ok(done.ok, done.ok ? "" : done.refusal);
		assert.equal(taskStatus(done.state, "rename"), "in review");
		assert.ok(!done.actions.some((action) => action.kind === "stop-teammate"));
	});

	it("starts nothing on a drain while paused; once the last pause lifts, a drain starts queued Tasks through the ladder and gives the rest their real reason", () => {
		const paused = applied(planned, pause("human"));
		const queued = applied(applied(paused, { kind: "handoff", slug: "rename", at: "2026-11-02T12:01:00.000Z", maxTeammates: 1 }), {
			kind: "handoff",
			slug: "tests",
			at: "2026-11-02T12:02:00.000Z",
			maxTeammates: 1,
		});
		assert.deepEqual(fold(queued).queue.map((each) => each.why), ["paused", "paused"]);

		const stalled = run(queued, { kind: "drain", at: "2026-11-02T12:03:00.000Z", maxTeammates: 1 });
		assert.ok(stalled.ok, stalled.ok ? "" : stalled.refusal);
		assert.deepEqual([stalled.append, stalled.actions, stalled.reply], [[], [], undefined]);

		const resumed = applied(queued, resume("human"));
		const first = run(resumed, { kind: "drain", at: "2026-11-02T12:31:00.000Z", maxTeammates: 1 });
		assert.ok(first.ok, first.ok ? "" : first.refusal);
		assert.match(first.reply ?? "", /^Queued Task `rename` started dev-1/);
		assert.deepEqual(first.actions.map((action) => action.kind), ["launch-teammate", "write-plan"]);

		const second = run([...resumed, ...first.append], { kind: "drain", at: "2026-11-02T12:31:01.000Z", maxTeammates: 1 });
		assert.ok(second.ok, second.ok ? "" : second.refusal);
		assert.equal(second.reply, undefined);
		assert.deepEqual(second.actions, []);
		assert.deepEqual(second.append, [{ type: "task-requeued", slug: "tests", why: "cap 1 reached; waits for 001", at: "2026-11-02T12:31:01.000Z" }]);
		assert.deepEqual(second.state.queue.map((each) => [each.slug, each.why]), [["tests", "cap 1 reached; waits for 001"]]);
	});

	it("tells the next Report who paused and resumed, and why", () => {
		const lines = applied(applied(applied(planned, pause("lead", "checking the API")), pause("human", "lunch", "2026-11-02T12:05:00.000Z")), resume("lead"));
		const result = run(lines, { kind: "report", headline: "Held.", criteria: ["AC1"], modes: [], at: "2026-11-02T13:00:00.000Z" });
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		const action = result.actions.find((each) => each.kind === "write-report");
		const since = action?.kind === "write-report" ? action.report.sections.find((each) => each.title === "Since the last Report")?.lines : undefined;
		assert.deepEqual(since?.slice(-3), ["12:00 the Lead paused the Effort: checking the API", "12:05 you paused the Effort: lunch", "12:30 the Lead lifted its pause"]);
	});
});

describe("a Teammate's lifecycle", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const RENAME = { slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1"] };
	const DOCS = { slug: "docs", role: "dev", goal: "Document it.", criteria: ["AC1"] };

	function plan(tasks: Extract<EffortInput, { kind: "plan" }>["tasks"], at = "2026-11-02T12:30:00.000Z"): Extract<EffortInput, { kind: "plan" }> {
		return { kind: "plan", tasks, criteria: ["AC1"], roles: ["dev", "qa"], at };
	}

	const handed = applied(applied(approved, plan([RENAME, DOCS], "2026-11-02T11:10:00.000Z")), { kind: "handoff", slug: "rename", at: "2026-11-02T11:30:00.000Z" });
	const INBOX = { socket: "/tmp/cc-socks/4242.sock", token: "inbox-token" };
	const DIR = "/agent/team/efforts/software-2026-11-02/tasks/001-dev-rename";

	function journal(lines: EffortLine[], cursor: number, event: string, payload: Record<string, unknown> = {}, written = false): Step {
		return run(lines, {
			kind: "journal",
			teammate: "dev-1",
			cursor,
			line: {
				from: "hook",
				at: `2026-11-02T12:0${cursor}:00.000Z`,
				event,
				payload: { session_id: "8f3c2a1b-0000-4000-8000-000000000001", source: "startup", ...payload },
				...(event === "SessionStart" ? { inbox: INBOX } : {}),
			},
			result: { path: `${DIR}/result-1.md`, written },
		});
	}

	function journalled(lines: EffortLine[], cursor: number, event: string, payload: Record<string, unknown> = {}, written = false): EffortLine[] {
		const result = journal(lines, cursor, event, payload, written);
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		return [...lines, ...result.append];
	}

	const running = journalled(handed, 1, "SessionStart");

	it("drops a running Task left out of a re-plan, and stops its Teammate with `claude stop`, keeping its conversation", () => {
		const result = run(running, plan([DOCS]));

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append.slice(1), [
			{ type: "task-dropped", slug: "rename", at: "2026-11-02T12:30:00.000Z" },
			{ type: "teammate-ended", teammate: "dev-1", how: "stopped", at: "2026-11-02T12:30:00.000Z" },
		]);
		assert.deepEqual(result.actions, [{ kind: "stop-teammate", teammate: "dev-1", shortId: "8f3c2a1b" }, { kind: "write-plan" }]);
		assert.equal(taskStatus(result.state, "rename"), "dropped");
		assert.match(result.reply ?? "", /[Dd]ropped Task `rename`.*stopped `dev-1`/);
	});

	it("gives a re-Roled Task to a new Teammate of its new Role, in a new folder", () => {
		const reroled = applied(running, plan([{ ...RENAME, role: "qa" }, DOCS]));
		const docs = run(reroled, { kind: "handoff", slug: "docs", at: "2026-11-02T12:40:00.000Z" });
		assert.ok(docs.ok, docs.ok ? "" : docs.refusal);
		const again = run([...reroled, ...docs.append], { kind: "handoff", slug: "rename", at: "2026-11-02T12:41:00.000Z" });

		assert.ok(again.ok, again.ok ? "" : again.refusal);
		assert.equal(again.state.tasks.docs.folder, "002-dev-docs");
		assert.deepEqual(
			{ folder: again.state.tasks.rename.folder, teammate: again.state.tasks.rename.teammate },
			{ folder: "003-qa-rename", teammate: "qa-1" },
		);
		assert.equal(taskStatus(again.state, "rename"), "running");
		assert.deepEqual(again.state.teammates.find((each) => each.id === "dev-1")?.ended, { how: "stopped", at: "2026-11-02T12:30:00.000Z" });
	});

	it("keeps an accepted Task in the plan, in its Role", () => {
		const done = journalled(running, 2, "Stop", {}, true);
		const accepted = applied(done, {
			kind: "review",
			slug: "rename",
			verdict: "accept",
			result: { path: `${DIR}/result-1.md`, written: true },
			sendBackLimit: 2,
			at: "2026-11-02T12:20:00.000Z",
		});

		assert.match(refusal(accepted, plan([DOCS])), /`rename` is accepted, so it stays in the plan/);
		assert.match(refusal(accepted, plan([{ ...RENAME, role: "qa" }, DOCS])), /`rename` is accepted in Role `dev`, so it keeps that Role/);
	});

	it("wakes the Lead once when a Teammate's session ends by itself, and ends that Teammate", () => {
		const crash = journal(running, 2, "SessionEnd", { reason: "other" });

		assert.ok(crash.ok, crash.ok ? "" : crash.refusal);
		assert.deepEqual(crash.append, [{ type: "teammate-crashed", teammate: "dev-1", cursor: 2, reason: "other", at: "2026-11-02T12:02:00.000Z" }]);
		assert.deepEqual(crash.actions.map((action) => action.kind), ["wake-lead", "start-queued"], "the crash frees room under the cap, so the queue drains");
		assert.match(crash.actions[0].kind === "wake-lead" ? crash.actions[0].text : "", /`dev-1`'s session ended \(other\).*Task `rename`.*send-back/s);
		assert.deepEqual(crash.state.teammates[0].ended, { how: "crashed", at: "2026-11-02T12:02:00.000Z" });

		const replayed = run([...running, ...crash.append], {
			kind: "journal",
			teammate: "dev-1",
			cursor: 2,
			line: { from: "hook", at: "2026-11-02T12:02:00.000Z", event: "SessionEnd", payload: { reason: "other" } },
			result: { path: `${DIR}/result-1.md`, written: false },
		});
		assert.ok(replayed.ok);
		assert.deepEqual(replayed.append, [], "the cursor keeps a replayed journal line from waking the Lead again");
	});

	it("doesn't count a clear, a resume or its own `claude stop` as a crash", () => {
		for (const reason of ["clear", "resume"]) {
			const ended = journal(running, 2, "SessionEnd", { reason });
			assert.ok(ended.ok);
			assert.deepEqual(ended.actions, [], reason);
		}
		const stopped = applied(running, plan([DOCS]));
		const after = journal(stopped, 2, "SessionEnd", { reason: "other" });
		assert.ok(after.ok);
		assert.deepEqual(after.actions, []);
	});

	it("sends a Task back to a new Teammate of its Role when its own has ended, in the same folder", () => {
		const done = journalled(running, 2, "Stop", {}, true);
		const crashed = journalled(done, 3, "SessionEnd", { reason: "other" });
		const result = run(crashed, {
			kind: "review",
			slug: "rename",
			verdict: "send_back",
			feedback: "The loader still reads `colour`.",
			result: { path: `${DIR}/result-1.md`, written: true },
			sendBackLimit: 2,
			mode: "auto",
			at: "2026-11-02T13:00:00.000Z",
		});

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append, [
			{ type: "task-sent-back", slug: "rename", round: 1, at: "2026-11-02T13:00:00.000Z" },
			{ type: "teammate-started", id: "dev-2", role: "dev", name: "team-software-2026-11-02-dev-2", task: "rename", startedAt: "2026-11-02T13:00:00.000Z", mode: "auto" },
			{ type: "task-reassigned", slug: "rename", teammate: "dev-2", at: "2026-11-02T13:00:00.000Z" },
		]);
		assert.deepEqual(result.actions, [
			{ kind: "write-feedback", folder: "001-dev-rename", round: 1, feedback: "The loader still reads `colour`." },
			{
				kind: "launch-teammate",
				teammate: { id: "dev-2", role: "dev", name: "team-software-2026-11-02-dev-2" },
				task: { slug: "rename", folder: "001-dev-rename" },
				at: "2026-11-02T13:00:00.000Z",
			},
			{ kind: "write-plan" },
		]);
		assert.deepEqual({ teammate: result.state.tasks.rename.teammate, round: result.state.tasks.rename.round }, { teammate: "dev-2", round: 2 });
		assert.equal(taskStatus(result.state, "rename"), "sent back");
		assert.match(result.reply ?? "", /`dev-1` has ended.*started `dev-2`.*result-2\.md/);
	});
});


describe("the final Report and sign-off", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const planned = applied(approved, {
		kind: "plan",
		tasks: [
			{ slug: "design", role: "architect", goal: "Design the rename.", criteria: ["AC2"] },
			{ slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1"] },
		],
		criteria: ["AC1", "AC2"],
		roles: ["architect", "dev"],
		at: "2026-11-02T11:10:00.000Z",
	});
	const plannedReport = applied(planned, { kind: "report", headline: "Planned.", criteria: ["AC1", "AC2"], modes: [], found: ["The docs misspell the key too."], at: "2026-11-02T11:15:00.000Z" });
	const handed = applied(applied(plannedReport, { kind: "handoff", slug: "design", at: "2026-11-02T11:20:00.000Z" }), { kind: "handoff", slug: "rename", at: "2026-11-02T11:21:00.000Z" });
	// architect-1's session started and gave it a short id; dev-1's hasn't yet.
	const running: EffortLine[] = [...handed, { type: "teammate-session", teammate: "architect-1", cursor: 1, source: "startup", sessionId: "s-1", shortId: "abc123", at: "2026-11-02T11:22:00.000Z" }];
	const CHANGE = { id: "qa-first", summary: "QA reviews the design before devs start.", oldText: "design-first", newText: "design-and-qa-first" };
	const WORKTREES = [
		{ path: "/work/app/.claude/worktrees/team-software-2026-11-02", branch: "team/software-2026-11-02", dirty: false },
		{ path: "/work/app/.claude/worktrees/team-software-2026-11-02-task-002", branch: "team/software-2026-11-02-task-002", dirty: true },
	];
	const EVIDENCE = [
		{ criterion: "AC1", note: "renamed in `config.ts`, tests in `config.test.ts` pass" },
		{ criterion: "AC2", note: "design accepted in `001-architect-design/result-1.md`" },
	];

	function finalReport(at: string, extra: Partial<Extract<EffortInput, { kind: "report" }>> = {}): Extract<EffortInput, { kind: "report" }> {
		return {
			kind: "report",
			headline: "Done: the key is renamed.",
			coverage: EVIDENCE,
			criteria: ["AC1", "AC2"],
			modes: [],
			final: { checkpoints: ["design-review"], changes: [CHANGE], worktrees: WORKTREES },
			at,
			...extra,
		};
	}

	function written(result: Step) {
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		const action = result.actions.find((each) => each.kind === "write-report");
		assert.ok(action?.kind === "write-report", "expected a write-report action");
		return action.report;
	}

	function signOffRequest(at = "2026-11-02T12:01:00.000Z"): Extract<EffortInput, { kind: "request-sign-off" }> {
		return { kind: "request-sign-off", path: "/agent/team/efforts/software-2026-11-02/reports/002.md", sha256: "d".repeat(64), snapshot: "# Final Report 2", changes: [{ change: CHANGE, sha256: "e".repeat(64) }], at };
	}

	const reported = applied(running, finalReport("2026-11-02T12:00:00.000Z"));
	const asked = applied(reported, signOffRequest());

	it("refuses a final Report that leaves a criterion without evidence, or proposes a change twice", () => {
		assert.match(refusal(running, finalReport("2026-11-02T12:00:00.000Z", { coverage: [EVIDENCE[0]] })), /`AC2`/);
		assert.match(refusal(running, finalReport("2026-11-02T12:00:00.000Z", { coverage: [EVIDENCE[0], { criterion: "AC2", note: " " }] })), /`AC2`/);
		const twice = finalReport("2026-11-02T12:00:00.000Z", { final: { checkpoints: [], changes: [CHANGE, CHANGE], worktrees: [] } });
		assert.match(refusal(running, twice), /`qa-first`.*once/);
		const unkebab = finalReport("2026-11-02T12:00:00.000Z", { final: { checkpoints: [], changes: [{ ...CHANGE, id: "QA First" }], worktrees: [] } });
		assert.match(refusal(running, unkebab), /kebab-case/);
	});

	it("maps every criterion to evidence and lists every checkpoint, all found work, each proposed change and the worktrees", () => {
		const report = written(run(running, finalReport("2026-11-02T12:00:00.000Z")));
		assert.equal(report.final, true);
		assert.deepEqual(report.coverage, EVIDENCE);
		const section = (title: string) => report.sections.find((each) => each.title === title)?.lines;
		assert.deepEqual(section("Checkpoints"), [
			`Playbook: adopted before the Effort opened (sha256 ${"a".repeat(64)})`,
			`Brief: \`r1\` approved at 11:00 UTC (sha256 ${"b".repeat(64)})`,
			"`design-review`: never asked",
		]);
		assert.deepEqual(section("Found work"), ["The docs misspell the key too."]);
		assert.deepEqual(section("Proposed Playbook changes"), [
			"`qa-first`: QA reviews the design before devs start.",
			"Each is adopted or declined on its own in `/team pending`. An adopted one is the Playbook of the next Effort; this Effort keeps its snapshot.",
		]);
		assert.deepEqual(section("Worktrees"), [
			"/work/app/.claude/worktrees/team-software-2026-11-02 (`team/software-2026-11-02`): clean, removed at sign-off; the branch is kept",
			"/work/app/.claude/worktrees/team-software-2026-11-02-task-002 (`team/software-2026-11-02-task-002`): has uncommitted changes, so it is kept; the branch is kept",
		]);
	});

	it("orders the final Report's sections as the spec lists them, found work before usage, the sign-off's own after the logged ones", () => {
		const report = written(run(running, finalReport("2026-11-02T12:00:00.000Z", { leadCostUsd: 1.5 })));
		const titles = report.sections.map((each) => each.title);
		assert.deepEqual(titles.slice(titles.indexOf("Checkpoints")), ["Checkpoints", "Found work", "Proposed Playbook changes", "Worktrees", "Usage"]);
	});

	it("asks for sign-off and for each proposed Playbook change separately", () => {
		const state = fold(asked);
		assert.deepEqual(
			state.pending.map((item) => [item.id, item.checkpoint, item.change?.id]),
			[
				["r2", "sign-off", undefined],
				["r3", "playbook-change", "qa-first"],
			],
		);
		assert.match(refusal(running, signOffRequest()), /final Report/);
		assert.match(refusal(running, request("c".repeat(64))), /already approved/);
		assert.match(refusal(reported, { ...request("c".repeat(64)), checkpoint: "sign-off" }), /final Report.*`final: true`/);
	});

	it("refuses sign-off while a proposed Playbook change is unanswered", () => {
		assert.match(refusal(asked, { kind: "answer", id: "r2", answer: "approved", at: "2026-11-02T12:10:00.000Z" }), /`r3`/);
	});

	it("adopts or declines a Playbook change without waking the Lead", () => {
		const adopted = run(asked, { kind: "answer", id: "r3", answer: "approved", at: "2026-11-02T12:05:00.000Z" });
		assert.ok(adopted.ok);
		assert.deepEqual(
			adopted.actions.map((action) => action.kind),
			["adopt-playbook-change"],
		);
		const declined = run(asked, { kind: "answer", id: "r3", answer: "declined", at: "2026-11-02T12:05:00.000Z" });
		assert.ok(declined.ok);
		assert.deepEqual(declined.actions, []);
		assert.deepEqual(declined.state.pending.map((item) => item.id), ["r2"]);
		assert.match(refusal(asked, { kind: "answer", id: "r3", answer: "sent-back", note: "no", at: "2026-11-02T12:05:00.000Z" }), /adopted or declined/);
		assert.match(refusal(asked, { kind: "answer", id: "r2", answer: "declined", at: "2026-11-02T12:05:00.000Z" }), /Playbook change/);
	});

	it("signing off records the act, stops every live Teammate and ends the Effort", () => {
		const changed = applied(asked, { kind: "answer", id: "r3", answer: "declined", at: "2026-11-02T12:05:00.000Z" });
		const result = run(changed, { kind: "answer", id: "r2", answer: "approved", at: "2026-11-02T12:10:00.000Z" });
		assert.ok(result.ok);
		assert.deepEqual(result.actions, [
			{ kind: "record-sign-off", approval: fold(changed).pending[0], at: "2026-11-02T12:10:00.000Z" },
			{ kind: "stop-teammate", teammate: "architect-1", shortId: "abc123" },
			{ kind: "stop-teammate", teammate: "dev-1", shortId: "team-software-2026-11-02-dev-1" },
			{ kind: "end-effort", how: "signed-off" },
		]);
		assert.deepEqual(result.state.ended, { how: "signed-off", at: "2026-11-02T12:10:00.000Z" });
		assert.ok(result.state.teammates.every((teammate) => teammate.ended?.how === "stopped"));
		assert.deepEqual(result.state.pending, []);
	});

	it("a sign-off and a Playbook change `approvals.jsonl` records but the log doesn't are finished after a restart, without recording or adopting again", () => {
		const recorded = [
			{ request: "r3", sha256: "e".repeat(64) },
			{ request: "r2", sha256: "d".repeat(64) },
		];
		const result = run(asked, { kind: "recover", recorded, at: "2026-11-02T15:00:00.000Z" });
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(
			result.actions.map((action) => action.kind),
			["wake-lead", "stop-teammate", "stop-teammate", "end-effort", "wake-lead"],
		);
		assert.deepEqual(result.state.ended, { how: "signed-off", at: "2026-11-02T15:00:00.000Z" });
		assert.deepEqual(result.state.pending, []);
		assert.equal(fold([...asked, ...result.append]).ended?.how, "signed-off");

		for (const stale of [[{ request: "r2", sha256: "f".repeat(64) }], [{ request: "r9", sha256: "d".repeat(64) }], []]) {
			const none = run(asked, { kind: "recover", recorded: stale, at: "2026-11-02T15:00:00.000Z" });
			assert.ok(none.ok);
			assert.deepEqual([none.append, none.actions, none.state.pending.length], [[], [], 2]);
		}
	});

	it("a send-back at sign-off wakes the Lead with the note, keeps the Teammates and drops the proposed changes", () => {
		const result = run(asked, { kind: "answer", id: "r2", answer: "sent-back", note: "AC1 has no test for the old key.", at: "2026-11-02T12:10:00.000Z" });
		assert.ok(result.ok);
		assert.equal(result.actions.length, 1);
		const [wake] = result.actions;
		assert.ok(wake?.kind === "wake-lead");
		assert.match(wake.text, /AC1 has no test for the old key\./);
		assert.match(wake.text, /`final: true`/);
		assert.equal(result.state.ended, undefined);
		assert.ok(result.state.teammates.every((teammate) => teammate.ended === undefined));
		assert.deepEqual(result.state.pending, []);

		const next = run([...asked, ...result.append], { kind: "report", headline: "Re-planning.", criteria: ["AC1", "AC2"], modes: [], at: "2026-11-02T12:20:00.000Z" });
		assert.deepEqual(written(next).sections.find((each) => each.title === "Since the last Report")?.lines, [
			"12:01 asked for your sign-off (`r2`)",
			"12:01 proposed Playbook change `qa-first` (`r3`)",
			"12:10 you sent back the final Report (`r2`): AC1 has no test for the old key.",
		]);
	});

	it("cancelling stops every live Teammate and ends the Effort without sign-off", () => {
		const result = run(asked, { kind: "cancel", at: "2026-11-02T12:30:00.000Z" });
		assert.ok(result.ok);
		assert.deepEqual(
			result.actions.map((action) => action.kind),
			["stop-teammate", "stop-teammate", "end-effort"],
		);
		assert.deepEqual(result.state.ended, { how: "cancelled", at: "2026-11-02T12:30:00.000Z" });
		assert.deepEqual(result.state.pending, []);
	});

	it("takes nothing more once the Effort has ended", () => {
		const ended = applied(asked, { kind: "cancel", at: "2026-11-02T12:30:00.000Z" });
		assert.match(refusal(ended, { kind: "cancel", at: "2026-11-02T12:31:00.000Z" }), /ended.*cancelled/);
		assert.match(refusal(ended, finalReport("2026-11-02T12:31:00.000Z")), /ended/);
		assert.match(refusal(ended, { kind: "handoff", slug: "rename", at: "2026-11-02T12:31:00.000Z" }), /ended/);
	});
});

describe("usage readings", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const planned = applied(approved, {
		kind: "plan",
		tasks: [
			{ slug: "design", role: "architect", goal: "Design the rename.", criteria: ["AC2"] },
			{ slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1"] },
			{ slug: "docs", role: "dev", goal: "Document the key.", criteria: ["AC1"] },
		],
		criteria: ["AC1", "AC2"],
		roles: ["architect", "dev"],
		at: "2026-11-02T11:10:00.000Z",
	});
	const staffed = ["design", "rename", "docs"].reduce((lines, slug) => applied(lines, { kind: "handoff", slug, at: "2026-11-02T11:20:00.000Z" }), planned);

	function statusLine(teammate: string, at: string, extra: Partial<UsageReading> = {}): EffortInput {
		return { kind: "usage", reading: { source: "status-line", at, teammate, sessionId: `${teammate}-a`, rateLimits: true, ...extra } };
	}

	function report(lines: EffortLine[], at: string, extra: Partial<Extract<EffortInput, { kind: "report" }>> = {}): string[] | undefined {
		const result = run(lines, { kind: "report", headline: "On track.", criteria: ["AC1", "AC2"], modes: [], at, ...extra });
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		const action = result.actions.find((each) => each.kind === "write-report");
		assert.ok(action?.kind === "write-report");
		return action.report.sections.find((each) => each.title === "Usage")?.lines;
	}

	it("keeps a status line reading once, as the last reading with its source and time, and its Teammate's context", () => {
		const reading = statusLine("dev-1", "2026-11-02T11:30:00.000Z", { sevenDay: { percent: 73, resetsAt: "2026-11-06T09:00:00.000Z" }, ctx: 21 });
		const read = applied(staffed, reading);

		assert.deepEqual(read.slice(staffed.length), [{ type: "usage-read", ...(reading as Extract<EffortInput, { kind: "usage" }>).reading }]);
		assert.equal(fold(read).usage?.latest.source, "status-line");
		assert.equal(fold(read).usage?.latest.at, "2026-11-02T11:30:00.000Z");
		assert.equal(fold(read).usage?.statusLines["dev-1"]?.ctx, 21);
		// The same file read again, or an older one, adds nothing.
		const again = run(read, reading);
		assert.ok(again.ok);
		assert.deepEqual(again.append, []);
		const older = run(read, statusLine("dev-1", "2026-11-02T11:29:00.000Z"));
		assert.ok(older.ok);
		assert.deepEqual(older.append, []);
	});

	it("leaves usage out of the Report until there is a reading, and out of what happened since the last Report", () => {
		assert.equal(report(staffed, "2026-11-02T11:40:00.000Z"), undefined);
		const read = applied(staffed, statusLine("dev-1", "2026-11-02T11:30:00.000Z", { sevenDay: { percent: 70 } }));
		assert.ok(report(read, "2026-11-02T11:40:00.000Z"));
		const result = run(read, { kind: "report", headline: "On track.", criteria: ["AC1", "AC2"], modes: [], at: "2026-11-02T11:40:00.000Z" });
		assert.ok(result.ok);
		const action = result.actions.find((each) => each.kind === "write-report");
		assert.ok(action?.kind === "write-report");
		assert.equal(action.report.sections.find((each) => each.title === "Since the last Report")?.lines.some((line) => line.includes("usage")), false);
	});

	it("gives the freshest account reading and its change since the Effort began, which includes the human's own use", () => {
		const lines = [
			statusLine("dev-1", "2026-11-02T11:30:00.000Z", { fiveHour: { percent: 10, resetsAt: "2026-11-02T14:00:00.000Z" }, sevenDay: { percent: 66, resetsAt: "2026-11-06T09:00:00.000Z" } }),
			statusLine("architect-1", "2026-11-02T12:10:00.000Z", { fiveHour: { percent: 31, resetsAt: "2026-11-02T14:00:00.000Z" }, sevenDay: { percent: 73, resetsAt: "2026-11-06T09:00:00.000Z" } }),
			// Older than the reading above, so not the freshest, though read later.
			statusLine("dev-2", "2026-11-02T12:00:00.000Z", { fiveHour: { percent: 29, resetsAt: "2026-11-02T14:00:00.000Z" }, sevenDay: { percent: 72, resetsAt: "2026-11-06T09:00:00.000Z" } }),
		].reduce(applied, staffed);

		assert.deepEqual(report(lines, "2026-11-02T12:15:00.000Z")?.[0], "Account, from architect-1's status line at 12:10 UTC: 5h 31% (+21 since the Effort began) · week 73% (+7 since the Effort began). It includes your own use outside the Team.");
	});

	it("says n/a for a window no reading gives, and that a window reset rather than a change across its reset", () => {
		const lines = [
			statusLine("dev-1", "2026-11-02T11:30:00.000Z", { fiveHour: { percent: 80, resetsAt: "2026-11-02T12:00:00.000Z" } }),
			{ kind: "usage", reading: { source: "get-usage", at: "2026-11-02T12:30:00.000Z", rateLimits: true, fiveHour: { percent: 4, resetsAt: "2026-11-02T17:00:00.000Z" } } } as EffortInput,
		].reduce(applied, staffed);

		assert.equal(report(lines, "2026-11-02T12:35:00.000Z")?.[0], "Account, from get_usage at 12:30 UTC: 5h 4% (reset since the Effort began) · week n/a. It includes your own use outside the Team.");
	});

	it("sums each Role's tokens and estimate across session ids, a value that drops counting as a reset, labelled as not the bill", () => {
		const lines = [
			statusLine("dev-1", "2026-11-02T11:30:00.000Z", { tokens: 40_000, costUsd: 0.5 }),
			statusLine("dev-1", "2026-11-02T11:40:00.000Z", { tokens: 60_000, costUsd: 0.7 }),
			// A clear: a new session id, counted from its own start.
			statusLine("dev-1", "2026-11-02T11:50:00.000Z", { sessionId: "dev-1-b", tokens: 10_000, costUsd: 0.1 }),
			// The first session's figure dropped: it reset, so what it had counts too.
			statusLine("dev-1", "2026-11-02T12:00:00.000Z", { tokens: 5_000, costUsd: 0.05 }),
			statusLine("dev-2", "2026-11-02T12:00:00.000Z", { tokens: 21_000, costUsd: 0.25 }),
			statusLine("architect-1", "2026-11-02T12:00:00.000Z", { tokens: 412_000, costUsd: 3.1 }),
		].reduce(applied, staffed);

		assert.deepEqual(report(lines, "2026-11-02T12:05:00.000Z")?.slice(1), ["By Role: architect 412k tokens ≈ $3.10 · dev 96k tokens ≈ $1.10. *API-price equivalent, not your bill.*"]);
	});

	it("says the estimate is the nearest thing to a charge when no reading has rate_limits, as with an API key", () => {
		const lines = [statusLine("dev-1", "2026-11-02T11:30:00.000Z", { rateLimits: false, tokens: 96_000, costUsd: 1.1 })].reduce(applied, staffed);

		assert.deepEqual(report(lines, "2026-11-02T11:35:00.000Z"), [
			"Account, from dev-1's status line at 11:30 UTC: 5h n/a · week n/a. It includes your own use outside the Team.",
			"By Role: dev 96k tokens ≈ $1.10. No reading has `rate_limits`, as with an API key, so the estimate is the nearest thing to a charge.",
		]);
	});

	it("gives the Lead's own cost as pi reports it", () => {
		assert.deepEqual(report(staffed, "2026-11-02T11:35:00.000Z", { leadCostUsd: 0.4321 }), ["The Lead: $0.43, as pi reports it."]);
		assert.equal(report(staffed, "2026-11-02T11:35:00.000Z", { leadCostUsd: 0 }), undefined);
	});

	it("tells whether a status line is under a minute old", () => {
		const read = fold(applied(staffed, statusLine("dev-1", "2026-11-02T11:30:00.000Z")));

		assert.equal(freshStatusLine(fold(staffed), Date.parse("2026-11-02T11:30:00.000Z")), false);
		assert.equal(freshStatusLine(read, Date.parse("2026-11-02T11:30:59.000Z")), true);
		assert.equal(freshStatusLine(read, Date.parse("2026-11-02T11:31:00.000Z")), false);
	});
});

describe("an isolated Task", () => {
	const WORKSPACE = { kind: "git-worktree", path: "/work/app/.claude/worktrees/team-software-2026-11-02", branch: "team/software-2026-11-02", base: "c".repeat(40), from: "main" } as const;
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", workspace: WORKSPACE, at: "2026-11-02T11:00:00.000Z" });
	const planned = applied(approved, {
		kind: "plan",
		tasks: [
			{ slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1"] },
			{ slug: "docs", role: "dev", goal: "Document it.", criteria: ["AC1"] },
		],
		criteria: ["AC1"],
		roles: ["dev"],
		at: "2026-11-02T11:10:00.000Z",
	});
	const T0 = "2026-11-02T11:30:00.000Z";
	const TASKS = "/agent/team/efforts/software-2026-11-02/tasks";
	const INBOX = { socket: "/tmp/cc-socks/dev-1.sock", token: "token-dev-1" };

	/** Play `id`'s round to a Stop with its result written, its SessionStart first. */
	function done(lines: EffortLine[], id: string): EffortLine[] {
		const due = currentResult(fold(lines), id);
		const result = { path: `${TASKS}/${due?.folder}/result-${due?.round}.md`, written: true };
		const started = applied(lines, {
			kind: "journal",
			teammate: id,
			cursor: 1,
			line: { from: "hook", at: T0, event: "SessionStart", payload: { session_id: `${id.padEnd(8, "0")}-0000-4000-8000-000000000001`, source: "startup" }, inbox: INBOX },
			result,
		});
		return applied(started, { kind: "journal", teammate: id, cursor: 2, line: { from: "hook", at: T0, event: "Stop", payload: {} }, result });
	}

	function review(lines: EffortLine[], slug: string, at = "2026-11-02T13:00:00.000Z"): Extract<EffortInput, { kind: "review" }> {
		const task = fold(lines).tasks[slug];
		return { kind: "review", slug, verdict: "accept", result: { path: `${TASKS}/${task?.folder}/result-${task?.round}.md`, written: true }, sendBackLimit: 2, at };
	}

	it("gets a worktree and branch of its own beside the Workspace, cut from the Effort branch, before its Teammate launches there", () => {
		const result = run(planned, { kind: "handoff", slug: "rename", isolated: true, at: T0 });

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		const worktree = { path: "/work/app/.claude/worktrees/team-software-2026-11-02-task-001", branch: "team/software-2026-11-02-task-001" };
		assert.deepEqual(result.append[1], { type: "task-handed-off", slug: "rename", folder: "001-dev-rename", role: "dev", teammate: "dev-1", at: T0, round: 1, worktree });
		assert.deepEqual(
			result.actions.map((action) => action.kind),
			["write-task", "add-task-workspace", "launch-teammate", "write-plan"],
		);
		assert.deepEqual(result.actions[1], { kind: "add-task-workspace", slug: "rename", ...worktree, from: "team/software-2026-11-02" });
		assert.equal(workdir(result.state, "dev-1"), worktree.path);
		assert.match(result.reply ?? "", /team\/software-2026-11-02-task-001/);
	});

	it("never goes to a reused Teammate, whose working directory is elsewhere", () => {
		const renamed = done(applied(planned, { kind: "handoff", slug: "rename", at: T0 }), "dev-1");
		const accepted = applied(renamed, review(renamed, "rename"));

		const result = run(accepted, { kind: "handoff", slug: "docs", isolated: true, at: "2026-11-02T14:00:00.000Z" });

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.equal(result.state.tasks.docs.teammate, "dev-2");
		assert.equal(workdir(result.state, "dev-1"), WORKSPACE.path);
		assert.equal(workdir(result.state, "dev-2"), "/work/app/.claude/worktrees/team-software-2026-11-02-task-002");
	});

	it("records the merge as a write-ahead intent on accept, and accepts only once the merge is in, ending its Teammate and its worktree", () => {
		const inReview = done(applied(planned, { kind: "handoff", slug: "rename", isolated: true, at: T0 }), "dev-1");

		const intent = run(inReview, review(inReview, "rename"));

		assert.ok(intent.ok, intent.ok ? "" : intent.refusal);
		assert.deepEqual(intent.append, [
			{ type: "merge-intended", slug: "rename", branch: "team/software-2026-11-02-task-001", into: "team/software-2026-11-02", at: "2026-11-02T13:00:00.000Z" },
		]);
		assert.deepEqual(intent.actions, [
			{ kind: "merge", slug: "rename", folder: "001-dev-rename", path: "/work/app/.claude/worktrees/team-software-2026-11-02-task-001", branch: "team/software-2026-11-02-task-001", into: WORKSPACE.path },
		]);
		assert.equal(taskStatus(intent.state, "rename"), "in review");
		assert.deepEqual(openMerges(intent.state), [{ slug: "rename", branch: "team/software-2026-11-02-task-001", into: "team/software-2026-11-02" }]);
		const merging = [...inReview, ...intent.append];
		assert.match(refusal(merging, review(merging, "rename")), /merge .*under way/);

		const merged = run(merging, { kind: "merge-result", slug: "rename", commit: "d".repeat(40), at: "2026-11-02T13:00:01.000Z" });

		assert.ok(merged.ok, merged.ok ? "" : merged.refusal);
		assert.deepEqual(merged.append, [
			{ type: "task-accepted", slug: "rename", round: 1, merge: "d".repeat(40), at: "2026-11-02T13:00:01.000Z" },
			{ type: "teammate-ended", teammate: "dev-1", how: "stopped", at: "2026-11-02T13:00:01.000Z" },
		]);
		assert.deepEqual(merged.actions, [
			{ kind: "stop-teammate", teammate: "dev-1", shortId: "dev-1000" },
			{ kind: "remove-task-workspace", slug: "rename", path: "/work/app/.claude/worktrees/team-software-2026-11-02-task-001", branch: "team/software-2026-11-02-task-001" },
			{ kind: "write-plan" },
		]);
		assert.equal(taskStatus(merged.state, "rename"), "accepted");
		assert.deepEqual(openMerges(merged.state), []);
		assert.match(merged.reply ?? "", /^Accepted Task `rename`.*merged `team\/software-2026-11-02-task-001` into `team\/software-2026-11-02`/);
	});

	it("leaves the Task in review when the merge fails, closing the intent so the Lead can decide again", () => {
		const inReview = done(applied(planned, { kind: "handoff", slug: "rename", isolated: true, at: T0 }), "dev-1");
		const merging = applied(inReview, review(inReview, "rename"));

		const failed = run(merging, { kind: "merge-result", slug: "rename", error: "conflict in config.ts", at: "2026-11-02T13:00:01.000Z" });

		assert.ok(failed.ok, failed.ok ? "" : failed.refusal);
		assert.deepEqual(failed.append, [{ type: "merge-failed", slug: "rename", reason: "conflict in config.ts", at: "2026-11-02T13:00:01.000Z" }]);
		assert.deepEqual(failed.actions, []);
		assert.equal(taskStatus(failed.state, "rename"), "in review");
		assert.deepEqual(openMerges(failed.state), []);
		const after = [...merging, ...failed.append];
		assert.equal(run(after, review(after, "rename", "2026-11-02T13:10:00.000Z")).ok, true);
	});
});

describe("usage limits", () => {
	const approved = applied(applied([OPENED], request("b".repeat(64))), { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" });
	const planned = applied(approved, {
		kind: "plan",
		tasks: [
			{ slug: "design", role: "architect", goal: "Design the rename.", criteria: ["AC1"] },
			{ slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1"] },
			{ slug: "docs", role: "dev", goal: "Document it.", criteria: ["AC1"] },
			{ slug: "tests", role: "qa", goal: "Test it.", criteria: ["AC1"] },
			{ slug: "review", role: "architect", goal: "Review it.", criteria: ["AC1"] },
		],
		criteria: ["AC1"],
		roles: ["architect", "dev", "qa"],
		at: "2026-11-02T11:10:00.000Z",
	});
	const MODELS = { architect: "opus", dev: "sonnet", qa: "claude-sonnet-4-5" };
	const T0 = "2026-11-02T11:30:00.000Z";
	const FAILED = "2026-11-02T12:10:00.000Z";
	const RESET = "2026-11-02T15:45:00.000Z";
	const SESSION = "You've hit your session limit · resets 3:45pm";

	/** Hand Task `slug` off and play its Teammate's SessionStart, so it has an inbox to be continued through. */
	function running(lines: EffortLine[], slug: string, at = T0): EffortLine[] {
		const handed = applied(lines, { kind: "handoff", slug, at });
		const id = fold(handed).tasks[slug]?.teammate ?? "";
		return journal(handed, id, { from: "hook", at, event: "SessionStart", payload: { session_id: `${id.padEnd(8, "0")}-0000-4000-8000-000000000001`, source: "startup" }, inbox: { socket: `/tmp/${id}.sock`, token: `token-${id}` } });
	}

	function journalStep(lines: EffortLine[], id: string, line: JournalLine, written = false): Step {
		const cursor = (fold(lines).teammates.find((each) => each.id === id)?.cursor ?? 0) + 1;
		return run(lines, { kind: "journal", teammate: id, cursor, line, result: { path: "/r/result-1.md", written }, tz: 0, models: MODELS });
	}

	function journal(lines: EffortLine[], id: string, line: JournalLine, written = false): EffortLine[] {
		const result = journalStep(lines, id, line, written);
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		return [...lines, ...result.append];
	}

	function failure(id: string, message: string, at = FAILED, error = "rate_limit"): JournalLine {
		return { from: "hook", at, event: "StopFailure", payload: { error, last_assistant_message: message } };
	}

	function notification(type: string, at: string): JournalLine {
		return { from: "hook", at, event: "Notification", payload: { notification_type: type, message: "" } };
	}

	function prompt(at: string): JournalLine {
		return { from: "hook", at, event: "UserPromptSubmit", payload: { prompt: "continue" } };
	}

	function tick(lines: EffortLine[], at: string): Extract<Step, { ok: true }> {
		const result = run(lines, { kind: "tick", at });
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		return result;
	}

	function continued(result: Step): string[] {
		return result.ok ? result.actions.flatMap((action) => (action.kind === "send-continue" ? [action.teammate] : [])) : [];
	}

	it("sets the usage pause on a session or weekly limit, with its kind and reset: new Tasks queue, running Teammates finish, and the Report logs it", () => {
		const dev = running(running(planned, "rename"), "tests");
		const limited = journalStep(dev, "dev-1", failure("dev-1", SESSION));
		assert.ok(limited.ok, limited.ok ? "" : limited.refusal);
		assert.deepEqual(heldPauses(limited.state), [{ by: "usage", kind: "session", reason: "session limit", reset: RESET, at: FAILED }]);
		assert.deepEqual(limited.state.teammates.find((each) => each.id === "dev-1")?.limit, { kind: "session", reset: RESET, at: FAILED });
		assert.equal(limited.state.teammates.find((each) => each.id === "dev-1")?.activity, "idle");
		// Nothing wakes the Lead, nor is stopped: the limit is the account's, and the Lead's turns spend it too.
		assert.deepEqual(limited.actions, []);
		const lines = [...dev, ...limited.append];

		const queued = run(lines, { kind: "handoff", slug: "docs", at: "2026-11-02T12:15:00.000Z" });
		assert.ok(queued.ok, queued.ok ? "" : queued.refusal);
		assert.equal(queued.state.queue[0]?.why, "paused");
		assert.match(queued.reply ?? "", /paused by a usage limit since 12:10 UTC: session limit, until 15:45 UTC.*it lifts at its reset/);

		const finished = journalStep(lines, "qa-1", { from: "hook", at: "2026-11-02T12:20:00.000Z", event: "Stop", payload: { last_assistant_message: "Done." } }, true);
		assert.ok(finished.ok, finished.ok ? "" : finished.refusal);
		assert.equal(taskStatus(finished.state, "tests"), "in review");

		// The same limit hit again by another Teammate changes nothing about the pause.
		const again = journalStep(lines, "qa-1", failure("qa-1", SESSION, "2026-11-02T12:11:00.000Z"));
		assert.ok(again.ok, again.ok ? "" : again.refusal);
		assert.deepEqual(again.append.map((line) => line.type), ["teammate-limited"]);

		const weekly = journalStep(lines, "qa-1", failure("qa-1", "You've hit your weekly limit · resets Tue 9am", "2026-11-02T12:11:00.000Z"));
		assert.ok(weekly.ok, weekly.ok ? "" : weekly.refusal);
		assert.deepEqual(heldPauses(weekly.state), [{ by: "usage", kind: "weekly", reason: "weekly limit", reset: "2026-11-03T09:00:00.000Z", at: "2026-11-02T12:11:00.000Z" }]);

		const reported = run(lines, { kind: "report", headline: "Held.", criteria: ["AC1"], modes: [], at: "2026-11-02T13:00:00.000Z" });
		const written = reported.ok ? reported.actions.find((each) => each.kind === "write-report") : undefined;
		const decided = written?.kind === "write-report" ? written.report.sections.find((each) => each.title === "Decided for you")?.lines : undefined;
		assert.deepEqual(decided, ["12:10 paused the Effort on dev-1's session limit, until 15:45 UTC (Task `rename`)"]);
	});

	it("holds only the Roles on an Opus or Sonnet limit's family: their new Tasks queue, other Roles start, and it lifts at the reset", () => {
		const architect = running(planned, "design");
		const limited = journalStep(architect, "architect-1", failure("architect-1", "You've hit your Opus limit · resets 3:45pm"));
		assert.ok(limited.ok, limited.ok ? "" : limited.refusal);
		assert.deepEqual(heldPauses(limited.state), []);
		assert.deepEqual(limited.state.holds, { opus: { family: "opus", kind: "opus", roles: ["architect"], reset: RESET, at: FAILED } });
		const lines = [...architect, ...limited.append];

		const other = run(lines, { kind: "handoff", slug: "rename", at: "2026-11-02T12:15:00.000Z" });
		assert.ok(other.ok, other.ok ? "" : other.refusal);
		assert.match(other.reply ?? "", /^started dev-1/);

		const held = run(lines, { kind: "handoff", slug: "review", at: "2026-11-02T12:15:00.000Z" });
		assert.ok(held.ok, held.ok ? "" : held.refusal);
		assert.equal(held.state.queue[0]?.why, "held: Opus limit until 15:45 UTC");
		assert.match(held.reply ?? "", /^queued Task `review`.*Role `architect` is held by an Opus limit until 15:45 UTC/);
		const queued = [...lines, ...held.append];
		const stalled = run(queued, { kind: "drain", at: "2026-11-02T12:16:00.000Z" });
		assert.deepEqual(stalled.ok && [stalled.append, stalled.actions], [[], []]);

		const lifted = tick(queued, RESET);
		assert.deepEqual(lifted.append.map((line) => line.type), ["model-released"]);
		assert.deepEqual(lifted.ok && lifted.state.holds, {});
		assert.ok(lifted.ok && lifted.actions.some((action) => action.kind === "start-queued"), "the lifted hold drains the queue");
		const drained = run([...queued, ...lifted.append], { kind: "drain", at: RESET });
		assert.match(drained.ok ? (drained.reply ?? "") : "", /^Queued Task `review` started architect-2/);
	});

	it("retries a burst throttle, an overload or a server error at 1, 2 and 5 min on the clock, then asks the human: retry again or leave it to the Lead", () => {
		let lines = running(planned, "rename");
		const failures = [
			["You've hit a burst: API Error: Server is temporarily limiting requests (not your usage limit)", "rate_limit"],
			["Repeated 529 Overloaded errors", "overloaded"],
			["API Error: 500 Internal server error", "server_error"],
		];
		let at = Date.parse(FAILED);
		const sent: string[] = [];
		for (const [i, wait] of [60_000, 120_000, 300_000].entries()) {
			const [message, error] = failures[i] ?? [];
			lines = journal(lines, "dev-1", failure("dev-1", message ?? "", new Date(at).toISOString(), error));
			// Nothing goes a moment before the retry is due.
			assert.deepEqual(continued(tick(lines, new Date(at + wait - 1000).toISOString())), []);
			const retried = tick(lines, new Date(at + wait).toISOString());
			assert.deepEqual(continued(retried), ["dev-1"]);
			sent.push(new Date(at + wait).toISOString());
			lines = [...lines, ...retried.append];
			// Sent once: the next tick sends nothing until the retry lands and fails again.
			assert.deepEqual(continued(tick(lines, new Date(at + wait + 60_000).toISOString())), []);
			at += wait + 30_000;
			lines = journal(lines, "dev-1", prompt(new Date(at).toISOString()));
		}
		assert.deepEqual(sent, ["2026-11-02T12:11:00.000Z", "2026-11-02T12:13:30.000Z", "2026-11-02T12:19:00.000Z"]);

		const ranOut = journalStep(lines, "dev-1", failure("dev-1", "Repeated 529 Overloaded errors", new Date(at).toISOString(), "overloaded"));
		assert.ok(ranOut.ok, ranOut.ok ? "" : ranOut.refusal);
		assert.deepEqual(ranOut.actions, []);
		assert.deepEqual(ranOut.state.usageItems, [{ id: "u1", why: "retries", kind: "overloaded", teammate: "dev-1", at: new Date(at).toISOString() }]);
		lines = [...lines, ...ranOut.append];
		assert.deepEqual(continued(tick(lines, "2026-11-02T14:00:00.000Z")), []);

		const retry = run(lines, { kind: "answer-usage", id: "u1", choice: "retry", at: "2026-11-02T14:00:00.000Z" });
		assert.ok(retry.ok, retry.ok ? "" : retry.refusal);
		assert.deepEqual(continued(retry), ["dev-1"]);
		assert.deepEqual(retry.state.usageItems, []);
		// The ladder starts over: the next failure waits a minute again.
		const again = journal(journal([...lines, ...retry.append], "dev-1", prompt("2026-11-02T14:00:05.000Z")), "dev-1", failure("dev-1", "Repeated 529 Overloaded errors", "2026-11-02T14:01:00.000Z", "overloaded"));
		assert.deepEqual(continued(tick(again, "2026-11-02T14:02:00.000Z")), ["dev-1"]);

		const leave = run(lines, { kind: "answer-usage", id: "u1", choice: "leave", at: "2026-11-02T14:00:00.000Z" });
		assert.ok(leave.ok, leave.ok ? "" : leave.refusal);
		const woken = leave.actions.find((action) => action.kind === "wake-lead");
		assert.match(woken?.kind === "wake-lead" ? woken.text : "", /dev-1.*overloaded after 3 retries on Task `rename`.*Never change its model/s);
		assert.equal(run(lines, { kind: "answer-usage", id: "u1", choice: "stay", at: "2026-11-02T14:00:00.000Z" }).ok, false);
		assert.equal(run(lines, { kind: "answer-usage", id: "u9", choice: "retry", at: "2026-11-02T14:00:00.000Z" }).ok, false);

		const reported = run(lines, { kind: "report", headline: "Retried.", criteria: ["AC1"], modes: [], at: "2026-11-02T14:00:00.000Z" });
		const written = reported.ok ? reported.actions.find((each) => each.kind === "write-report") : undefined;
		const decided = written?.kind === "write-report" ? written.report.sections.find((each) => each.title === "Decided for you")?.lines : undefined;
		assert.deepEqual(decided, [
			"12:11 retried dev-1 after throttle (1 of 3) (Task `rename`)",
			"12:13 retried dev-1 after overloaded (2 of 3) (Task `rename`)",
			"12:19 retried dev-1 after server error (3 of 3) (Task `rename`)",
		]);
	});

	it("asks the human about a reset more than a day away: staying keeps the pause, cancelling stops every Teammate and has the Lead report", () => {
		const lines = running(running(planned, "rename"), "tests");
		const limited = journalStep(lines, "dev-1", failure("dev-1", "You've hit your weekly limit · resets Mon 12:00am"));
		assert.ok(limited.ok, limited.ok ? "" : limited.refusal);
		assert.deepEqual(limited.state.usageItems, [{ id: "u1", why: "far-reset", kind: "weekly", teammate: "dev-1", reset: "2026-11-09T00:00:00.000Z", at: FAILED }]);
		const asked = [...lines, ...limited.append];
		const waiting = run(asked, { kind: "report", headline: "Held.", criteria: ["AC1"], modes: [], at: "2026-11-02T13:00:00.000Z" });
		const written = waiting.ok ? waiting.actions.find((each) => each.kind === "write-report") : undefined;
		const section = written?.kind === "write-report" ? written.report.sections.find((each) => each.title === "Waiting on you")?.lines : undefined;
		assert.deepEqual(section, ["`u1`: the usage pause on a weekly limit lifts at 2026-11-09 00:00 UTC, more than a day away: stay paused, or cancel the Effort, in `/team pending`"]);

		const stay = run(asked, { kind: "answer-usage", id: "u1", choice: "stay", at: "2026-11-02T13:00:00.000Z" });
		assert.ok(stay.ok, stay.ok ? "" : stay.refusal);
		assert.deepEqual(stay.state.usageItems, []);
		assert.equal(heldPauses(stay.state)[0]?.kind, "weekly");
		assert.deepEqual(stay.actions, []);

		const cancel = run(asked, { kind: "answer-usage", id: "u1", choice: "cancel", at: "2026-11-02T13:00:00.000Z" });
		assert.ok(cancel.ok, cancel.ok ? "" : cancel.refusal);
		assert.deepEqual(
			cancel.actions.flatMap((action) => (action.kind === "stop-teammate" ? [action.teammate] : [])),
			["dev-1", "qa-1"],
		);
		assert.deepEqual(cancel.state.teammates.map((each) => each.ended?.how), ["stopped", "stopped"]);
		// It is `/team cancel`: the Effort ends without sign-off.
		assert.equal(cancel.state.ended?.how, "cancelled");
		assert.ok(cancel.actions.some((action) => action.kind === "end-effort" && action.how === "cancelled"));
		assert.deepEqual(cancel.state.usageItems, []);

	});

	it("waits out a limit Claude Code gave no reset for, and asks the human to stay or cancel only once the pause has held a day", () => {
		const lines = running(running(planned, "rename"), "tests");
		const unsaid = journalStep(lines, "dev-1", failure("dev-1", "You've hit your session limit"));
		assert.ok(unsaid.ok, unsaid.ok ? "" : unsaid.refusal);
		assert.equal(heldPauses(unsaid.state)[0]?.kind, "session");
		assert.deepEqual(unsaid.state.usageItems ?? [], [], "the reset may be minutes away, so nothing asks to cancel yet");
		const paused = [...lines, ...unsaid.append];

		assert.deepEqual(tick(paused, "2026-11-03T12:09:00.000Z").append, [], "a day hasn't passed");
		const dayOn = tick(paused, "2026-11-03T12:11:00.000Z");
		assert.deepEqual(dayOn.ok && dayOn.state.usageItems?.map((item) => [item.why, item.reset]), [["far-reset", undefined]]);
		assert.match(dayOn.ok ? usageText(dayOn.state.usageItems?.[0] as UsageItem) : "", /held for more than a day, and Claude Code didn't say when it lifts: stay paused, or cancel the Effort/);

		const stay = run([...paused, ...dayOn.append], { kind: "answer-usage", id: "u1", choice: "stay", at: "2026-11-03T12:12:00.000Z" });
		assert.ok(stay.ok);
		assert.deepEqual(tick([...paused, ...dayOn.append, ...stay.append], "2026-11-03T13:00:00.000Z").append, [], "staying asks no more");
	});

	it("lifts the usage pause at its reset and sends continue ~2 min later to each still-idle limited Teammate, never while its auto-wait is armed", () => {
		let lines = running(running(running(planned, "rename"), "tests"), "design");
		lines = journal(lines, "dev-1", failure("dev-1", SESSION));
		lines = journal(lines, "qa-1", failure("qa-1", `${SESSION}\nContinuing automatically at 3:45pm · Esc to cancel`, "2026-11-02T12:11:00.000Z"));
		lines = journal(lines, "architect-1", failure("architect-1", SESSION, "2026-11-02T12:12:00.000Z"));
		// The human typed to architect-1 meanwhile: it is busy, so it isn't continued.
		lines = journal(lines, "architect-1", prompt("2026-11-02T13:00:00.000Z"));

		const atReset = tick(lines, RESET);
		assert.deepEqual(atReset.append.map((line) => line.type), ["resumed"]);
		assert.deepEqual(heldPauses(atReset.state), []);
		lines = [...lines, ...atReset.append];
		assert.deepEqual(continued(tick(lines, "2026-11-02T15:46:59.000Z")), []);
		const grace = tick(lines, "2026-11-02T15:47:00.000Z");
		assert.deepEqual(continued(grace), ["dev-1"]);
		lines = [...lines, ...grace.append];
		assert.deepEqual(continued(tick(lines, "2026-11-02T15:48:00.000Z")), []);

		// The armed auto-wait goes stale: it is disarmed, and the next tick continues qa-1.
		lines = journal(lines, "qa-1", notification("quota_auto_resume_stale", "2026-11-02T15:50:00.000Z"));
		assert.deepEqual(continued(tick(lines, "2026-11-02T15:51:00.000Z")), ["qa-1"]);
	});

	it("continues the other idle Teammates on the same limit at once when Claude Code's auto-resume fires for one", () => {
		let lines = running(running(running(planned, "rename"), "tests"), "design");
		lines = journal(lines, "dev-1", failure("dev-1", `${SESSION}\nContinuing automatically at 3:45pm · Esc to cancel`));
		lines = journal(lines, "qa-1", failure("qa-1", SESSION, "2026-11-02T12:11:00.000Z"));
		lines = journal(lines, "architect-1", failure("architect-1", "You've hit your Opus limit · resets 3:45pm", "2026-11-02T12:12:00.000Z"));
		// Armed, dev-1 is sent nothing, even well past the reset's grace.
		assert.deepEqual(continued(tick(lines, "2026-11-02T15:40:00.000Z")), []);

		const fired = journalStep(lines, "dev-1", notification("quota_auto_resume_fired", "2026-11-02T15:45:10.000Z"));
		assert.ok(fired.ok, fired.ok ? "" : fired.refusal);
		assert.deepEqual(continued(fired), ["qa-1"]);
		assert.deepEqual(heldPauses(fired.state), []);
		// The Opus hold is another limit: it waits for its own reset.
		assert.deepEqual(Object.keys(fired.state.holds ?? {}), ["opus"]);
		lines = [...lines, ...fired.append];
		assert.deepEqual(continued(tick(lines, "2026-11-02T15:46:00.000Z")), []);
		const opus = tick(lines, "2026-11-02T15:47:00.000Z");
		assert.deepEqual(continued(opus), ["architect-1"]);
		// Replayed, the notification appends nothing more.
		const replayed = run([...lines, ...opus.append], { kind: "journal", teammate: "dev-1", cursor: fold(lines).teammates.find((each) => each.id === "dev-1")?.cursor ?? 0, line: notification("quota_auto_resume_fired", "2026-11-02T15:45:10.000Z"), result: { path: "/r/result-1.md", written: false } });
		assert.deepEqual(replayed.ok && replayed.append, []);
	});

	it("holds the Fable Roles on a usage-credit confirm nobody answered, and hands it to the human through the Lead, who never confirms it", () => {
		const lines = running(planned, "rename");
		const consent = journalStep(lines, "dev-1", failure("dev-1", "Your limit is reached and the prompt to confirm usage credits went unanswered — nothing was sent", FAILED, "billing_error"));
		assert.ok(consent.ok, consent.ok ? "" : consent.refusal);
		assert.deepEqual(consent.state.holds, { fable: { family: "fable", kind: "consent", roles: ["dev"], teammate: "dev-1", at: FAILED } });
		const woken = consent.actions.find((action) => action.kind === "wake-lead");
		assert.match(woken?.kind === "wake-lead" ? woken.text : "", /Only the human confirms usage credits.*Never confirm them yourself/s);
		const held = [...lines, ...consent.append];
		const reported = run(held, { kind: "report", headline: "Held.", criteria: ["AC1"], modes: [], at: "2026-11-02T12:14:00.000Z" });
		const written = reported.ok ? reported.actions.find((each) => each.kind === "write-report") : undefined;
		assert.deepEqual(written?.kind === "write-report" ? written.report.sections.find((each) => each.title === "Waiting on you")?.lines : undefined, [
			"`dev-1`: a usage-credit confirm waits in its terminal, which only you answer: attach to it from `/team pending` or `/team`",
		]);
		const docs = run(held, { kind: "handoff", slug: "docs", at: "2026-11-02T12:15:00.000Z" });
		assert.equal(docs.ok && docs.state.queue[0]?.why, "held: usage-credit confirm");
		// The human answered it in dev-1's terminal: its turn goes on, and the hold lifts.
		const answered = journalStep(held, "dev-1", prompt("2026-11-02T12:20:00.000Z"));
		assert.deepEqual(answered.ok && answered.state.holds, {});
	});

	it("hands a failure it doesn't recognise to the Lead with the Teammate's last message", () => {
		const lines = running(planned, "rename");
		const failed = journalStep(lines, "dev-1", failure("dev-1", "Your credit balance is too low", FAILED, "billing_error"));
		assert.ok(failed.ok, failed.ok ? "" : failed.refusal);
		assert.deepEqual(heldPauses(failed.state), []);
		const woken = failed.actions.find((action) => action.kind === "wake-lead");
		assert.match(woken?.kind === "wake-lead" ? woken.text : "", /dev-1.*Task `rename` failed \(billing_error\).*Your credit balance is too low/s);
		// Applied once: a replay wakes nobody again.
		const cursor = fold([...lines, ...failed.append]).teammates.find((each) => each.id === "dev-1")?.cursor ?? 0;
		const replayed = run([...lines, ...failed.append], { kind: "journal", teammate: "dev-1", cursor, line: failure("dev-1", "Your credit balance is too low", FAILED, "billing_error"), result: { path: "/r/result-1.md", written: false } });
		assert.deepEqual(replayed.ok && replayed.actions, []);
	});
});

describe("recovering after a restart", () => {
	const WORKSPACE = { kind: "git-worktree", path: "/work/app/.claude/worktrees/team-software-2026-11-02", branch: "team/software-2026-11-02", base: "c".repeat(40), from: "main" } as const;
	const asked = applied([OPENED], request("b".repeat(64)));
	const approved = applied(asked, { kind: "answer", id: "r1", answer: "approved", workspace: WORKSPACE, at: "2026-11-02T11:00:00.000Z" });
	const planned = applied(approved, {
		kind: "plan",
		tasks: [
			{ slug: "rename", role: "dev", goal: "Rename the key.", criteria: ["AC1"] },
			{ slug: "docs", role: "dev", goal: "Document it.", criteria: ["AC1"] },
		],
		criteria: ["AC1"],
		roles: ["dev"],
		at: "2026-11-02T11:10:00.000Z",
	});
	const T0 = "2026-11-02T11:30:00.000Z";
	const BACK = "2026-11-02T15:00:00.000Z";
	const NAME = "team-software-2026-11-02-dev-1";
	const TASKS = "/agent/team/efforts/software-2026-11-02/tasks";
	const INBOX = { socket: "/tmp/cc-socks/dev-1.sock", token: "token-dev-1" };
	const SESSION = "dev-1000-0000-4000-8000-000000000001";

	function recover(lines: EffortLine[], evidence: Omit<Extract<EffortInput, { kind: "recover" }>, "kind" | "at">): Extract<Step, { ok: true }> {
		const result = run(lines, { kind: "recover", at: BACK, ...evidence });
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		return result;
	}

	const wakes = (result: Extract<Step, { ok: true }>) => result.actions.filter((action) => action.kind === "wake-lead");

	/** A journal line of `id` at `cursor`. */
	function hook(id: string, cursor: number, event: string, payload: Record<string, unknown>, written = false): Extract<EffortInput, { kind: "journal" }> {
		return {
			kind: "journal",
			teammate: id,
			cursor,
			line: { from: "hook", at: `2026-11-02T12:0${cursor}:00.000Z`, event, payload, ...(event === "SessionStart" ? { inbox: INBOX } : {}) },
			result: { path: `${TASKS}/001-dev-rename/result-1.md`, written },
		};
	}

	/** The handoff's step, and the lines it would have had on record had pi not stopped between writing the launch's intent and launching. */
	function launching(isolated = false): { step: Extract<Step, { ok: true }>; lines: EffortLine[] } {
		const handoff = run(planned, { kind: "handoff", slug: "rename", at: T0, ...(isolated ? { isolated: true } : {}) });
		assert.ok(handoff.ok, handoff.ok ? "" : handoff.refusal);
		return { step: handoff, lines: [...planned, { type: "launch-intended", teammate: "dev-1", name: NAME, lines: handoff.append, at: T0 }] };
	}

	describe("a launch", () => {
		it("is finished from `--name` in `claude agents --json`: its lines go on record once, and nobody is woken", () => {
			const { step: handoff, lines } = launching();

			const result = recover(lines, { agents: [NAME] });

			assert.deepEqual(result.append, handoff.append);
			assert.deepEqual(result.actions, [{ kind: "write-plan" }]);
			assert.equal(taskStatus(result.state, "rename"), "running");
			assert.deepEqual(result.state.teammates.map((teammate) => teammate.id), ["dev-1"]);
			// Recovered again, it finds nothing open: no second Teammate.
			const again = recover([...lines, ...result.append], { agents: [NAME] });
			assert.deepEqual(again.append, []);
			assert.deepEqual(again.actions, []);
		});

		it("is finished from the Teammate's own journal when `claude agents --json` can't be read, or no longer lists it", () => {
			const { step: handoff, lines } = launching();

			for (const agents of [undefined, []]) {
				const result = recover(lines, { agents, journaled: ["dev-1"] });

				assert.deepEqual(result.append, handoff.append);
				assert.deepEqual(wakes(result), []);
			}
		});

		it("that never happened is abandoned: the Task is still planned, its worktree goes, and the Lead hears it", () => {
			const { lines } = launching(true);

			const result = recover(lines, { agents: [] });

			assert.deepEqual(result.append, [{ type: "launch-abandoned", teammate: "dev-1", reason: "`claude agents --json` doesn't list it and it never wrote to its journal", at: BACK }]);
			assert.equal(taskStatus(result.state, "rename"), "planned");
			assert.deepEqual(result.state.teammates, []);
			assert.deepEqual(result.actions.slice(0, 1), [{ kind: "remove-task-workspace", slug: "rename", path: "/work/app/.claude/worktrees/team-software-2026-11-02-task-001", branch: "team/software-2026-11-02-task-001" }]);
			const [wake] = wakes(result);
			assert.match(wake?.kind === "wake-lead" ? wake.text : "", /`dev-1` didn't start .*Task `rename` is still planned.*`team_handoff`/);
			assert.deepEqual(recover([...lines, ...result.append], { agents: [] }).append, []);
		});

		it("is left open, and the Lead told, when there is no evidence either way", () => {
			const { lines } = launching();

			const result = recover(lines, {});

			assert.deepEqual(result.append, []);
			assert.equal(Object.keys(result.state.launching ?? {}).length, 1);
			const [wake] = wakes(result);
			assert.match(wake?.kind === "wake-lead" ? wake.text : "", /`claude agents --json` couldn't be read/);
		});

		it("is closed by its own lines when the launch went through before pi stopped", () => {
			const { step: handoff, lines } = launching();

			const state = fold([...lines, ...handoff.append]);

			assert.equal(state.launching, undefined);
			assert.deepEqual(recover([...lines, ...handoff.append], {}).actions, []);
		});

		it("of a send-back to a new Teammate, abandoned, takes back the feedback written for it", () => {
			const crashed = applied(applied(applied(applied(planned, { kind: "handoff", slug: "rename", at: T0 }), hook("dev-1", 1, "SessionStart", { session_id: SESSION, source: "startup" })), hook("dev-1", 2, "Stop", {}, true)), hook("dev-1", 3, "SessionEnd", { reason: "other" }));
			const restaff = run(crashed, { kind: "review", slug: "rename", verdict: "send_back", feedback: "Still reads `colour`.", result: { path: `${TASKS}/001-dev-rename/result-1.md`, written: true }, sendBackLimit: 2, at: "2026-11-02T13:00:00.000Z" });
			assert.ok(restaff.ok, restaff.ok ? "" : restaff.refusal);
			const lines: EffortLine[] = [...crashed, { type: "launch-intended", teammate: "dev-2", name: "team-software-2026-11-02-dev-2", lines: restaff.append, at: "2026-11-02T13:00:00.000Z" }];

			const result = recover(lines, { agents: [] });

			assert.deepEqual(result.actions.slice(0, 1), [{ kind: "discard-feedback", slug: "rename", folder: "001-dev-rename", round: 1 }]);
			assert.equal(result.state.tasks.rename?.round, 1);
			assert.equal(result.state.tasks.rename?.teammate, "dev-1");
		});
	});

	describe("a merge", () => {
		const handed = applied(planned, { kind: "handoff", slug: "rename", isolated: true, at: T0 });
		const done = applied(applied(handed, hook("dev-1", 1, "SessionStart", { session_id: SESSION, source: "startup" })), hook("dev-1", 2, "Stop", {}, true));
		const accept = run(done, { kind: "review", slug: "rename", verdict: "accept", result: { path: `${TASKS}/001-dev-rename/result-1.md`, written: true }, sendBackLimit: 2, at: "2026-11-02T13:00:00.000Z" });
		assert.ok(accept.ok);
		const merging = [...done, ...accept.append];
		const TASK_WORKTREE = { path: "/work/app/.claude/worktrees/team-software-2026-11-02-task-001", branch: "team/software-2026-11-02-task-001" };

		it("already in the Effort branch is recorded as accepted with its merge commit, and never merged again", () => {
			const result = recover(merging, { merges: { rename: { state: "merged", commit: "d".repeat(40) } } });

			assert.deepEqual(result.append[0], { type: "task-accepted", slug: "rename", round: 1, merge: "d".repeat(40), at: BACK });
			assert.ok(!result.actions.some((action) => action.kind === "merge"));
			assert.deepEqual(
				result.actions.filter((action) => action.kind !== "wake-lead").map((action) => action.kind),
				["stop-teammate", "remove-task-workspace", "write-plan"],
			);
			assert.equal(wakes(result).length, 1);
			assert.deepEqual(openMerges(result.state), []);
			assert.deepEqual(recover([...merging, ...result.append], { merges: { rename: { state: "merged", commit: "d".repeat(40) } } }).actions, []);
		});

		it("cut short with `MERGE_HEAD` left behind is aborted and merged again; one not begun is merged", () => {
			const half = recover(merging, { merges: { rename: { state: "half-done" } } });
			const none = recover(merging, { merges: { rename: { state: "not-started" } } });

			const merge = { kind: "merge", slug: "rename", folder: "001-dev-rename", into: WORKSPACE.path, ...TASK_WORKTREE };
			assert.deepEqual(half.actions, [{ ...merge, abort: true }]);
			assert.deepEqual(none.actions, [merge]);
			assert.deepEqual(half.append, []);
			assert.deepEqual(none.append, []);
		});

		it("is left open, and the Lead told, when git can't say where it stands", () => {
			const result = recover(merging, {});

			assert.deepEqual(result.append, []);
			assert.ok(!result.actions.some((action) => action.kind === "merge"));
			assert.equal(openMerges(result.state).length, 1);
			const [wake] = wakes(result);
			assert.match(wake?.kind === "wake-lead" ? wake.text : "", /Task `rename`.*team\/software-2026-11-02-task-001/);
		});
	});

	describe("a promotion", () => {
		const record = { request: "r1", brief: "b".repeat(64), workspace: WORKSPACE };

		it("found in `approvals.jsonl` with the approved sha records the answer it promoted, and doesn't promote again", () => {
			const result = recover(asked, { promoted: [record] });

			assert.deepEqual(result.append, [{ type: "approval-answered", id: "r1", answer: "approved", workspace: WORKSPACE, at: BACK }]);
			assert.equal(result.state.brief?.sha256, "b".repeat(64));
			assert.deepEqual(result.state.workspace, WORKSPACE);
			assert.ok(!result.actions.some((action) => action.kind === "promote-brief"));
			assert.equal(wakes(result).length, 1);
		});

		it("is nothing to finish when no record matches the pending request and its sha", () => {
			for (const promoted of [[], [{ ...record, brief: "e".repeat(64) }], [{ ...record, request: "r2" }]]) {
				const result = recover(asked, { promoted });

				assert.deepEqual(result.append, []);
				assert.deepEqual(result.actions, []);
				assert.equal(result.state.pending.length, 1);
			}
		});
	});

	describe("a relaunch", () => {
		// dev-1 did `rename`; an approved Brief change then altered its Role's launch options, so `docs` starts it afresh.
		const running = applied(applied(planned, { kind: "handoff", slug: "rename", at: T0 }), hook("dev-1", 1, "SessionStart", { session_id: SESSION, source: "startup" }));
		const done = applied(running, hook("dev-1", 2, "Stop", { session_id: SESSION }, true));
		const asked = applied(done, { kind: "request-approval", checkpoint: "brief-change", path: "/agent/team/efforts/software-2026-11-02/brief.draft.md", sha256: "c".repeat(64), snapshot: "---\n---\n", affects: [], at: "2026-11-02T12:10:00.000Z" });
		const changed = applied(asked, { kind: "answer", id: "r2", answer: "approved", refresh: ["dev"], at: "2026-11-02T12:11:00.000Z" });
		const accepted = applied(changed, { kind: "review", slug: "rename", verdict: "accept", result: { path: `${TASKS}/001-dev-rename/result-1.md`, written: true }, sendBackLimit: 2, at: "2026-11-02T13:00:00.000Z" });
		const handoff = run(accepted, { kind: "handoff", slug: "docs", at: "2026-11-02T14:00:00.000Z" });
		assert.ok(handoff.ok, handoff.ok ? "" : handoff.refusal);
		const intended: EffortLine[] = [...accepted, { type: "launch-intended", teammate: "dev-1", name: NAME, lines: handoff.append, at: "2026-11-02T14:00:00.000Z" }];

		it("a Brief change `approvals.jsonl` records but the log doesn't is answered after a restart, with its refresh, and not promoted again", () => {
			const result = recover(asked, { recorded: [{ request: "r2", sha256: "c".repeat(64), refresh: ["dev"] }] });

			assert.deepEqual(result.append, [{ type: "approval-answered", id: "r2", answer: "approved", refresh: ["dev"], at: BACK }]);
			assert.ok(!result.actions.some((action) => action.kind === "promote-brief-change"));
			assert.match(wakes(result)[0]?.text ?? "", /approved the Brief change.*`dev-1` starts in a fresh session/);
			assert.deepEqual(recover([...asked, ...result.append], { recorded: [{ request: "r2", sha256: "c".repeat(64), refresh: ["dev"] }] }).append, []);
		});

		it("that went in closes on its `teammate-relaunched` line, so a restart after it recovers nothing", () => {
			const result = recover([...intended, ...handoff.append], { agents: [NAME], journaled: ["dev-1"] });

			assert.deepEqual([result.append, result.actions], [[], []]);
		});

		it("is in once its new session journals, whatever `claude agents --json` says: the `--name` it lists is the old session's too", () => {
			const listed = recover(intended, { agents: [NAME], journaled: [] });
			const journaled = recover(intended, { agents: [], journaled: ["dev-1"] });

			assert.deepEqual(listed.append.map((line) => line.type), ["launch-abandoned"]);
			assert.equal(taskStatus(listed.state, "docs"), "planned");
			const [kept] = listed.state.teammates;
			assert.deepEqual({ freshDue: kept.freshDue, relaunching: kept.relaunching }, { freshDue: true, relaunching: undefined });
			assert.match(wakes(listed)[0]?.text ?? "", /^`dev-1` wasn't started afresh before pi stopped: its new session never wrote to its journal.*still due a fresh start.*Task `docs` is still planned; hand it off again with `team_handoff`\.$/);
			assert.deepEqual(journaled.append, handoff.append);
			assert.equal(journaled.state.teammates[0].relaunching, true);
		});

		it("whose new session never started wakes the Lead once the journals are replayed, and waits while `claude agents --json` lists it", () => {
			const relaunched = [...intended, ...handoff.append];
			const missing = run(relaunched, { kind: "reconcile", agents: [], at: BACK });
			const starting = run(relaunched, { kind: "reconcile", agents: [NAME], at: BACK });
			const unread = run(relaunched, { kind: "reconcile", at: BACK });

			assert.ok(missing.ok && starting.ok && unread.ok);
			assert.match(missing.reply ?? "", /^`dev-1` was started afresh on Task `docs` before pi stopped, but its new session never started.*Stop and tell the human\.$/);
			assert.deepEqual([starting.actions, starting.reply, unread.actions, unread.reply], [[], undefined, [], undefined]);
		});
	});

	describe("reconciling after the journals are replayed", () => {
		const running = applied(applied(planned, { kind: "handoff", slug: "rename", at: T0 }), hook("dev-1", 1, "SessionStart", { session_id: SESSION, source: "startup" }));
		const done = applied(running, hook("dev-1", 2, "Stop", {}, true));
		const sendBack = { kind: "review", slug: "rename", verdict: "send_back", feedback: "Still reads `colour`.", result: { path: `${TASKS}/001-dev-rename/result-1.md`, written: true }, sendBackLimit: 2, at: "2026-11-02T13:00:00.000Z" } as const;
		const sentBack = applied(done, sendBack);
		const accepted = applied(done, { ...sendBack, verdict: "accept" });
		const cleared = applied(accepted, { kind: "handoff", slug: "docs", at: "2026-11-02T14:00:00.000Z" });

		function reconcile(lines: EffortLine[], sent?: string[]): Extract<Step, { ok: true }> {
			const result = run(lines, { kind: "reconcile", at: BACK, ...(sent === undefined ? {} : { sent }) });
			assert.ok(result.ok, result.ok ? "" : result.refusal);
			return result;
		}

		it("sends again a send-back pointer that never landed, and nothing once its UserPromptSubmit is read", () => {
			const landed = applied(sentBack, hook("dev-1", 3, "UserPromptSubmit", { prompt: `Round 1 of Task \`rename\` was sent back: read ${TASKS}/001-dev-rename/feedback-1.md and do what it asks. When it is done, write your result to ${TASKS}/001-dev-rename/result-2.md.` }));

			assert.deepEqual(reconcile(sentBack).actions, [{ kind: "redeliver", teammate: "dev-1", slug: "rename", folder: "001-dev-rename", round: 2 }]);
			assert.deepEqual(reconcile(landed).actions, []);
		});

		it("clears again a reused Teammate whose `SessionStart clear` never came, and sends the pointer the clear's has not reached", () => {
			const afterClear = applied(cleared, hook("dev-1", 3, "SessionStart", { session_id: "dev-1000-0000-4000-8000-000000000002", source: "clear" }));
			const landed = applied(afterClear, hook("dev-1", 4, "UserPromptSubmit", { prompt: `New Task \`docs\`: read ${TASKS}/002-dev-docs/task.md and do what it asks. When it is done, write your result to ${TASKS}/002-dev-docs/result-1.md.` }));

			assert.deepEqual(reconcile(cleared).actions, [{ kind: "clear-then-send", teammate: "dev-1", inbox: INBOX, slug: "docs", folder: "002-dev-docs" }]);
			assert.deepEqual(reconcile(afterClear).actions, [{ kind: "redeliver", teammate: "dev-1", slug: "docs", folder: "002-dev-docs", round: 1 }]);
			// The replay sent it already, when it read the clear.
			assert.deepEqual(reconcile(afterClear, ["docs"]).actions, []);
			assert.deepEqual(reconcile(landed).actions, []);
		});

		it("rebuilds each `takeover` marker from the Takeover lines, and sends nothing again to a Teammate the human holds", () => {
			const taken: EffortLine = { type: "takeover-started", teammate: "dev-1", cursor: 3, trigger: { kind: "prompt" }, at: "2026-11-02T13:10:00.000Z" };
			const held = [...sentBack, taken];
			const back = [...held, { type: "takeover-ended", teammate: "dev-1", cursor: 4, by: "terminal", at: "2026-11-02T13:20:00.000Z" } as const];

			assert.deepEqual(reconcile(held).actions, [], "its owed pointer waits for the hand-back; with no markers read, none is touched");
			const missing = run(held, { kind: "reconcile", marked: [], at: BACK });
			const stale = run(back, { kind: "reconcile", marked: ["dev-1"], at: BACK });
			const kept = run(held, { kind: "reconcile", marked: ["dev-1"], at: BACK });

			assert.ok(missing.ok && stale.ok && kept.ok);
			assert.deepEqual(missing.actions, [{ kind: "mark-takeover", teammate: "dev-1", on: true }]);
			assert.deepEqual(stale.actions, [{ kind: "mark-takeover", teammate: "dev-1", on: false }, { kind: "redeliver", teammate: "dev-1", slug: "rename", folder: "001-dev-rename", round: 2 }]);
			assert.deepEqual(kept.actions, []);
		});

		it("tells a crashed Teammate from an idle-stopped one, and wakes neither", () => {
			const two = applied(applied(running, { kind: "handoff", slug: "docs", at: "2026-11-02T12:30:00.000Z" }), hook("dev-2", 1, "SessionStart", { session_id: "dev-2000-0000-4000-8000-000000000001", source: "startup" }));
			const crash = applied(two, hook("dev-2", 2, "SessionEnd", { reason: "other" }));

			const result = reconcile(crash);

			assert.deepEqual(result.append, []);
			assert.deepEqual(result.actions, []);
			assert.equal(result.state.teammates.find((teammate) => teammate.id === "dev-2")?.ended?.how, "crashed");
			assert.equal(result.state.teammates.find((teammate) => teammate.id === "dev-1")?.ended, undefined);
		});
	});

	describe("the one message after a restart", () => {
		it("is none when nothing needs the Lead", () => {
			assert.equal(awayText(fold(planned), []), undefined);
			assert.equal(awayText(fold(planned), [], ["/agent/team/efforts/software-2026-11-02"]), undefined);
		});

		it("gathers everything that needs the Lead into one message, with the records after an adoption or fork", () => {
			const text = awayText(fold(planned), ["`dev-1` wrote result-1.md.", "`dev-2`'s session ended."], ["/agent/team/efforts/software-2026-11-02", "/agent/team/efforts/software-2026-11-02/plan.md"]) ?? "";

			assert.match(text, /^While you were away, Effort `software-2026-11-02`:/);
			assert.ok(text.includes("`dev-1` wrote result-1.md.") && text.includes("`dev-2`'s session ended."), text);
			assert.match(text, /\/agent\/team\/efforts\/software-2026-11-02\/plan\.md/);
			assert.ok(!(awayText(fold(planned), ["x"]) ?? "").includes("/agent/"));
		});
	});
});
