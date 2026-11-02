/**
 * The Team block: the data `team_status` returns in, the lines above the
 * editor out. The renderer is pure, so what the human sees is asserted as the
 * exact strings pi is handed, in the style of the subagents widget's tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderTeamBlock, type TeamBlockData, type TeammateRow, teamStatus } from "../block.ts";
import { type EffortInput, type EffortLine, fold, type JournalLine, openEffort, step } from "../core.ts";

const NOW = Date.parse("2026-11-02T10:00:00.000Z");

/** A block's data with nothing in it but the Effort, each field overridable. */
function data(overrides: Partial<TeamBlockData> = {}): TeamBlockData {
	return {
		effortId: "flaky-cache",
		team: "software",
		phase: "working",
		tasks: { accepted: 1, planned: 4 },
		teammates: [],
		queued: [],
		waitingOnYou: 0,
		reports: 0,
		...overrides,
	};
}

function mate(id: string, overrides: Partial<TeammateRow> = {}): TeammateRow {
	return { id, role: id.replace(/-\d+$/, ""), shortId: "a1b2c3d4", activity: "idle", task: `001-${id}-design`, ...overrides };
}

function render(block: TeamBlockData, maxTeammates = 3): string[] {
	return renderTeamBlock(block, NOW, { maxTeammates });
}

describe("the Team block", () => {
	it("frames the Effort with its Team and live count, the phase line, a row per Teammate and what waits on the human", () => {
		const lines = render(
			data({
				teammates: [
					mate("architect-1", { task: "001-architect-design", doing: "round 1 done", ctx: 18, mode: "auto" }),
					mate("dev-1", { shortId: "d4e5f6a7", activity: "busy", task: "002-dev-ttl", mode: "acceptEdits", launchMode: "auto" }),
				],
				waitingOnYou: 1,
				reports: 2,
			}),
		);

		assert.deepEqual(lines, [
			"╭─ Team · software · flaky-cache ──────────────────────────────────────────────────── 2 live ─╮",
			"│ ● running  ·  working · 1/4 Tasks accepted                                                  │",
			"│ architect-1  a1b2c3d4  idle  001-architect-design · round 1 done  ctx 18%  auto             │",
			"│ dev-1        d4e5f6a7  busy  002-dev-ttl                          ctx —    acceptEdits≠auto │",
			"│ ▲ 1 waiting on you  /team pending   reports 2  /team reports   attach  /team                │",
			"╰─────────────────────────────────────────────────────────────────────────────────────────────╯",
		]);
	});

	it("shows the first queued Task with its Role and why, collapsing the rest of the queue into a count", () => {
		const lines = render(
			data({
				phase: "intake",
				tasks: { accepted: 0, planned: 0 },
				queued: [
					{ task: "004-qa-cache", role: "qa", why: "cap 3 reached; waits for 002 and 003" },
					{ task: "005-dev-docs", role: "dev", why: "cap 3 reached" },
					{ task: "006-dev-ci", role: "dev", why: "cap 3 reached" },
				],
			}),
		);

		assert.deepEqual(lines, [
			"╭─ Team · software · flaky-cache ──────────────────────── 0 live ─╮",
			"│ ● running  ·  intake                                            │",
			"│ queued  004-qa-cache (qa): cap 3 reached; waits for 002 and 003 │",
			"│         +2 more queued                                          │",
			"│ nothing waiting on you   reports 0                              │",
			"╰─────────────────────────────────────────────────────────────────╯",
		]);
	});

	it("bounds its height by maxTeammates, folding the Teammates past the cap into a count, and marks one not yet started", () => {
		const lines = render(
			data({
				tasks: { accepted: 0, planned: 3 },
				teammates: [mate("dev-1"), mate("dev-2"), mate("dev-3", { shortId: undefined, activity: "starting", task: "003-dev-3-design" })],
			}),
			2,
		);

		assert.deepEqual(lines, [
			"╭─ Team · software · flaky-cache ─────────── 3 live ─╮",
			"│ ● running  ·  working · 0/3 Tasks accepted         │",
			"│ dev-1  a1b2c3d4  idle  001-dev-1-design  ctx —     │",
			"│ +2 more Teammates                                  │",
			"│ nothing waiting on you   reports 0   attach  /team │",
			"╰────────────────────────────────────────────────────╯",
		]);
		assert.deepEqual(render(data({ teammates: [mate("dev-3", { shortId: undefined, activity: "starting", task: "003-dev-3-design" })] }))[2], "│ dev-3  —  starting  003-dev-3-design  ctx — │");
	});

	it("marks a short id the human hasn't attached to through pi `(new)`, and says how to attach once a Teammate has one", () => {
		const lines = render(data({ teammates: [mate("dev-1"), mate("dev-2", { shortId: "k3l4m5n6", newShortId: true, activity: "busy", task: "003-dev-ttl" })] }));

		assert.deepEqual(lines, [
			"╭─ Team · software · flaky-cache ───────────── 2 live ─╮",
			"│ ● running  ·  working · 1/4 Tasks accepted           │",
			"│ dev-1  a1b2c3d4        idle  001-dev-1-design  ctx — │",
			"│ dev-2  k3l4m5n6 (new)  busy  003-dev-ttl       ctx — │",
			"│ nothing waiting on you   reports 0   attach  /team   │",
			"╰──────────────────────────────────────────────────────╯",
		]);
	});

	it("never gets wider than 96 columns, clipping every cell and flattening newlines, wide characters included, in plain lines RPC can take", () => {
		const long = "deeply/nested/".repeat(12);
		const lines = render(
			data({
				effortId: `effort-${"x".repeat(120)}`,
				teammates: [
					mate("architect-with-a-very-long-id", { task: `001-${long}`, doing: "stopped short\nsaying more", mode: "acceptEdits", launchMode: "auto" }),
					mate("dev-1", { task: "002-キャッシュの有効期限を直す".repeat(4) }),
				],
				queued: [{ task: `004-${long}`, role: "qa", why: "waits\nfor 002" }],
			}),
		);

		for (const line of lines) assert.equal(visibleWidth(line), 96, line);
		assert.ok(lines.every((line) => !line.includes("\n") && !line.includes("\u001b")));
		assert.match(lines[0], /^╭─ Team · software · effort-x+… ─+ 2 live ─╮$/);
		assert.match(lines[2], /^│ architect-with-…  a1b2c3d4  idle  001-deeply\/nested\/.*…  ctx —  acceptEdits≠auto │$/);
		assert.match(lines[3], /^│ dev-1 +a1b2c3d4  idle  002-キャッシュ.*… +ctx — +│$/);
		assert.match(lines[4], /^│ queued  004-deeply\/nested\/.*… │$/);
	});
});

/** Effort lines built through the core, as `effort.jsonl` holds them. */
function through(inputs: EffortInput[]): EffortLine[] {
	let lines: EffortLine[] = [openEffort({ effortId: "software-2026-11-02", team: "software", repo: "/work/app", playbook: "a".repeat(64), at: "2026-11-02T10:00:00.000Z" })];
	for (const input of inputs) {
		const result = step(fold(lines), input);
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		lines = [...lines, ...result.append];
	}
	return lines;
}

const REQUEST: EffortInput = { kind: "request-approval", checkpoint: "brief", path: "/e/brief.draft.md", sha256: "b".repeat(64), snapshot: "brief", at: "2026-11-02T10:05:00.000Z" };
const APPROVE: EffortInput = { kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T10:10:00.000Z" };
const PLAN: EffortInput = {
	kind: "plan",
	tasks: [
		{ slug: "design", role: "architect", goal: "Design.", criteria: ["AC1"] },
		{ slug: "ttl", role: "dev", goal: "Add the TTL.", dependsOn: ["design"], criteria: ["AC1"] },
	],
	criteria: ["AC1"],
	roles: ["architect", "dev"],
	at: "2026-11-02T10:20:00.000Z",
};

function handoff(slug: string): EffortInput {
	return { kind: "handoff", slug, at: "2026-11-02T10:30:00.000Z", mode: "auto" };
}

function hook(teammate: string, cursor: number, event: string, payload: Record<string, unknown> = {}, written = false): EffortInput {
	const line: JournalLine = { from: "hook", at: `2026-11-02T10:4${cursor}:00.000Z`, event, payload: { session_id: `${teammate === "dev-1" ? "d4e5f6a7" : "a1b2c3d4"}-0000`, hook_event_name: event, ...payload } };
	return { kind: "journal", teammate, cursor, line, result: { path: "/e/result-1.md", written } };
}

describe("team_status data", () => {
	it("is the intake phase with nothing planned until the Brief is approved, counting the Brief and adoptions waiting on the human", () => {
		assert.deepEqual(teamStatus(fold(through([REQUEST])), { adoptionsPending: 1 }), {
			effortId: "software-2026-11-02",
			team: "software",
			phase: "intake",
			tasks: { accepted: 0, planned: 0 },
			teammates: [],
			queued: [],
			waitingOnYou: 2,
			reports: 0,
		});
		assert.equal(teamStatus(fold(through([REQUEST, APPROVE, PLAN])), { adoptionsPending: 0 }).phase, "planning");
	});

	it("rows each Teammate from its journal: starting, busy once a prompt lands, idle with the round done, and the mode it got against the one it launched in", () => {
		const handedOff = [REQUEST, APPROVE, PLAN, handoff("design"), handoff("ttl")];
		const status = teamStatus(fold(through(handedOff)), { adoptionsPending: 0 });

		assert.equal(status.phase, "working");
		assert.deepEqual(status.tasks, { accepted: 0, planned: 2 });
		assert.deepEqual(status.teammates, [
			{ id: "architect-1", role: "architect", activity: "starting", task: "001-architect-design", mode: "auto" },
			{ id: "dev-1", role: "dev", activity: "starting", task: "002-dev-ttl", mode: "auto" },
		]);

		const state = fold(
			through([
				...handedOff,
				hook("architect-1", 1, "SessionStart", { source: "startup", permission_mode: "auto" }),
				hook("architect-1", 2, "UserPromptSubmit", { prompt: "go", permission_mode: "auto" }),
				hook("architect-1", 3, "Stop", { permission_mode: "auto" }, true),
				// Claude Code calls manual `default`; then the human switched it with shift+tab.
				hook("dev-1", 1, "SessionStart", { source: "startup", permission_mode: "default" }),
				hook("dev-1", 2, "UserPromptSubmit", { prompt: "go", permission_mode: "acceptEdits" }),
			]),
		);

		assert.deepEqual(teamStatus(state, { adoptionsPending: 0 }).teammates, [
			{ id: "architect-1", role: "architect", shortId: "a1b2c3d4", activity: "idle", task: "001-architect-design", doing: "round 1 done", mode: "auto" },
			{ id: "dev-1", role: "dev", shortId: "d4e5f6a7", activity: "busy", task: "002-dev-ttl", mode: "acceptEdits", launchMode: "auto" },
		]);
	});

	it("counts the Tasks the Lead has accepted", () => {
		const accept: EffortInput = { kind: "review", slug: "design", verdict: "accept", result: { path: "/e/result-1.md", written: true }, sendBackLimit: 2, at: "2026-11-02T10:50:00.000Z" };
		const state = fold(
			through([
				REQUEST,
				APPROVE,
				PLAN,
				handoff("design"),
				hook("architect-1", 1, "SessionStart", { source: "startup", permission_mode: "auto" }),
				hook("architect-1", 2, "UserPromptSubmit", { prompt: "go", permission_mode: "auto" }),
				hook("architect-1", 3, "Stop", { permission_mode: "auto" }, true),
				accept,
			]),
		);

		assert.deepEqual(teamStatus(state, { adoptionsPending: 0 }).tasks, { accepted: 1, planned: 2 });
	});

	it("lists the queued Tasks with their Role and why, and drops a Teammate stopped to make room", () => {
		const capped = (input: EffortInput): EffortInput => ({ ...input, maxTeammates: 1 }) as EffortInput;
		const queued = through([REQUEST, APPROVE, PLAN, capped(handoff("design")), capped(handoff("ttl"))]);
		const waiting = teamStatus(fold(queued), { adoptionsPending: 0 });

		assert.deepEqual(waiting.queued, [{ task: "002-dev-ttl", role: "dev", why: "cap 1 reached; waits for 001" }]);
		assert.deepEqual(
			waiting.teammates.map((row) => row.id),
			["architect-1"],
		);

		const swapped = fold(
			through([
				...[REQUEST, APPROVE, PLAN, capped(handoff("design")), capped(handoff("ttl"))],
				hook("architect-1", 1, "SessionStart", { source: "startup", permission_mode: "auto" }),
				hook("architect-1", 2, "Stop", { permission_mode: "auto" }, true),
				{ kind: "review", slug: "design", verdict: "accept", result: { path: "/e/result-1.md", written: true }, sendBackLimit: 2, at: "2026-11-02T10:50:00.000Z" },
				{ kind: "drain", at: "2026-11-02T10:50:00.000Z", maxTeammates: 1 },
			]),
		);
		const status = teamStatus(swapped, { adoptionsPending: 0 });

		assert.deepEqual(status.queued, []);
		assert.deepEqual(
			status.teammates.map((row) => [row.id, row.task]),
			[["dev-1", "002-dev-ttl"]],
		);
	});

	it("is working once a Task is queued, though none has started", () => {
		const capped = through([REQUEST, APPROVE, PLAN, { ...handoff("design"), maxTeammates: 0 } as EffortInput]);

		assert.equal(teamStatus(fold(capped), { adoptionsPending: 0 }).phase, "working");
	});

	it("counts the Reports written", () => {
		const report = (at: string): EffortInput => ({ kind: "report", headline: "On track.", criteria: ["AC1"], modes: [], at });

		assert.equal(teamStatus(fold(through([REQUEST, APPROVE, PLAN])), { adoptionsPending: 0 }).reports, 0);
		assert.equal(teamStatus(fold(through([REQUEST, APPROVE, PLAN, report("2026-11-02T10:20:00.000Z"), report("2026-11-02T10:25:00.000Z")])), { adoptionsPending: 0 }).reports, 2);
	});

	it("rows a Teammate whose new session gave it a new short id as new, until the human attaches to it through pi", () => {
		const opened = through([REQUEST, APPROVE, PLAN, handoff("design"), hook("architect-1", 1, "SessionStart", { source: "startup", permission_mode: "auto" })]);
		const relaunched: EffortLine[] = [
			...opened,
			{ type: "teammate-session", teammate: "architect-1", cursor: 2, source: "startup", sessionId: "k3l4m5n6-0000", shortId: "k3l4m5n6", at: "2026-11-02T11:00:00.000Z" },
		];

		assert.deepEqual(teamStatus(fold(relaunched), { adoptionsPending: 0 }).teammates[0], {
			id: "architect-1",
			role: "architect",
			shortId: "k3l4m5n6",
			newShortId: true,
			activity: "starting",
			task: "001-architect-design",
			mode: "auto",
		});
		const attached = step(fold(relaunched), { kind: "attach", teammate: "architect-1", at: "2026-11-02T11:10:00.000Z" });
		assert.ok(attached.ok);
		assert.equal(teamStatus(attached.state, { adoptionsPending: 0 }).teammates[0].newShortId, undefined);
	});
});
