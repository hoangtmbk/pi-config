/**
 * The Effort core, fed by hand: `effort.jsonl` lines and new inputs in, the
 * folded state, the lines to append and the mechanical actions out. Every step
 * is also checked to fold back to the state it returned, because the lines are
 * all a restart has.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { currentResult, type EffortInput, type EffortLine, type EffortState, fold, type JournalLine, openEffort, type Step, step, taskStatus } from "../core.ts";

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

	it("refuses a re-plan that drops a handed-off Task or gives it another Role", () => {
		const designed = applied(planned, handoff("design"));
		const replan = (tasks: Extract<EffortInput, { kind: "plan" }>["tasks"]) => ({
			kind: "plan" as const,
			tasks,
			criteria: ["AC1", "AC2"],
			roles: ["architect", "dev", "qa"],
			at: "2026-11-02T11:40:00.000Z",
		});

		assert.match(refusal(designed, replan([{ slug: "rename", role: "dev", goal: "Rename.", criteria: ["AC1", "AC2"] }])), /`design`.*handed off/);
		assert.match(
			refusal(designed, replan([{ slug: "design", role: "dev", goal: "Design.", criteria: ["AC1", "AC2"] }])),
			/`design`.*`architect`/,
		);
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
