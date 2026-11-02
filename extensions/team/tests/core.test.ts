/**
 * The Effort core, fed by hand: `effort.jsonl` lines and new inputs in, the
 * folded state, the lines to append and the mechanical actions out. Every step
 * is also checked to fold back to the state it returned, because the lines are
 * all a restart has.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { currentResult, type EffortInput, type EffortLine, type EffortState, fold, heldPauses, type JournalLine, openEffort, openMerges, type Step, step, taskStatus, waitingInTerminal, workdir } from "../core.ts";

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
		assert.equal(crash.actions.length, 1);
		assert.equal(crash.actions[0].kind, "wake-lead");
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
			{ type: "teammate-started", id: "dev-2", role: "dev", name: "team-software-2026-11-02-dev-2", task: "rename", startedAt: "2026-11-02T13:00:00.000Z", mode: "auto" },
			{ type: "task-sent-back", slug: "rename", round: 1, at: "2026-11-02T13:00:00.000Z" },
			{ type: "task-reassigned", slug: "rename", teammate: "dev-2", at: "2026-11-02T13:00:00.000Z" },
		]);
		assert.deepEqual(result.actions, [
			{
				kind: "restaff-teammate",
				teammate: { id: "dev-2", role: "dev", name: "team-software-2026-11-02-dev-2" },
				slug: "rename",
				folder: "001-dev-rename",
				round: 1,
				feedback: "The loader still reads `colour`.",
			},
			{ kind: "write-plan" },
		]);
		assert.deepEqual({ teammate: result.state.tasks.rename.teammate, round: result.state.tasks.rename.round }, { teammate: "dev-2", round: 2 });
		assert.equal(taskStatus(result.state, "rename"), "sent back");
		assert.match(result.reply ?? "", /`dev-1` has ended.*started `dev-2`.*result-2\.md/);
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
