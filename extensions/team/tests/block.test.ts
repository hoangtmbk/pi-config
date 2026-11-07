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
			"│ 5h n/a · week n/a  · no reading yet                                                         │",
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
			"│ 5h n/a · week n/a  · no reading yet                             │",
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
			"│ 5h n/a · week n/a  · no reading yet                │",
			"│ dev-1  a1b2c3d4  idle  001-dev-1-design  ctx —     │",
			"│ +2 more Teammates                                  │",
			"│ nothing waiting on you   reports 0   attach  /team │",
			"╰────────────────────────────────────────────────────╯",
		]);
		assert.deepEqual(render(data({ teammates: [mate("dev-3", { shortId: undefined, activity: "starting", task: "003-dev-3-design" })] }))[3], "│ dev-3  —  starting  003-dev-3-design  ctx — │");
	});

	it("marks a short id the human hasn't attached to through pi `(new)`, and says how to attach once a Teammate has one", () => {
		const lines = render(data({ teammates: [mate("dev-1"), mate("dev-2", { shortId: "k3l4m5n6", newShortId: true, activity: "busy", task: "003-dev-ttl" })] }));

		assert.deepEqual(lines, [
			"╭─ Team · software · flaky-cache ───────────── 2 live ─╮",
			"│ ● running  ·  working · 1/4 Tasks accepted           │",
			"│ 5h n/a · week n/a  · no reading yet                  │",
			"│ dev-1  a1b2c3d4        idle  001-dev-1-design  ctx — │",
			"│ dev-2  k3l4m5n6 (new)  busy  003-dev-ttl       ctx — │",
			"│ nothing waiting on you   reports 0   attach  /team   │",
			"╰──────────────────────────────────────────────────────╯",
		]);
	});

	it("marks with `?` a short id nothing has confirmed since pi came back, the row drawn from saved state alone", () => {
		const lines = render(data({ teammates: [mate("dev-1", { unconfirmed: true }), mate("dev-2", { shortId: "k3l4m5n6", activity: "busy", task: "003-dev-ttl" })] }));

		assert.deepEqual(lines.slice(3, 5), ["│ dev-1  a1b2c3d4?  idle  001-dev-1-design  ctx —    │", "│ dev-2  k3l4m5n6   busy  003-dev-ttl       ctx —    │"]);
	});

	it("shows each pause that holds on a line of its own, with who set it, since when and why, and how the human lifts theirs", () => {
		const lines = render(
			data({
				pauses: [
					{ by: "human", reason: "lunch", since: "2026-11-02T12:00:00.000Z" },
					{ by: "lead", reason: "checking the API", since: "2026-11-02T12:05:00.000Z" },
					{ by: "usage", since: "2026-11-02T12:10:00.000Z" },
				],
				queued: [{ task: "002-qa-tests", role: "qa", why: "paused" }],
			}),
		);

		assert.deepEqual(lines, [
			"╭─ Team · software · flaky-cache ──────── 0 live ─╮",
			"│ ⏸ paused  ·  working · 1/4 Tasks accepted       │",
			"│   by you since 12:00 UTC: lunch   /team resume  │",
			"│   by the Lead since 12:05 UTC: checking the API │",
			"│   by a usage limit since 12:10 UTC              │",
			"│ 5h n/a · week n/a  · no reading yet             │",
			"│ queued  002-qa-tests (qa): paused               │",
			"│ nothing waiting on you   reports 0              │",
			"╰─────────────────────────────────────────────────╯",
		]);
	});

	it("shows the usage pause's limit and reset, and a line per model hold with the Roles it holds and until when", () => {
		const lines = render(
			data({
				pauses: [{ by: "usage", kind: "weekly", reason: "weekly limit", reset: "2026-11-09T00:00:00.000Z", since: "2026-11-02T12:10:00.000Z" }],
				holds: [
					{ kind: "opus", roles: ["architect", "reviewer"], reset: "2026-11-02T15:45:00.000Z" },
					{ kind: "consent", roles: ["dev"], teammate: "dev-1" },
				],
				waitingOnYou: 1,
			}),
		);

		assert.deepEqual(lines, [
			"╭─ Team · software · flaky-cache ────────────────────────────────────── 0 live ─╮",
			"│ ⏸ paused  ·  working · 1/4 Tasks accepted                                     │",
			"│   by a usage limit since 12:10 UTC: weekly limit, resets 2026-11-09 00:00 UTC │",
			"│ held  architect, reviewer on an Opus limit until 15:45 UTC                    │",
			"│ held  dev on a usage-credit confirm in dev-1's terminal                       │",
			"│ 5h n/a · week n/a  · no reading yet                                           │",
			"│ ▲ 1 waiting on you  /team pending   reports 0                                 │",
			"╰───────────────────────────────────────────────────────────────────────────────╯",
		]);
	});

	it("shows the account's usage under the status line: each window or n/a, when it resets, where the reading came from and how old it is", () => {
		const lines = render(
			data({
				teammates: [mate("dev-1", { ctx: 21 })],
				usage: { sevenDay: { percent: 73, resetsAt: "2026-11-05T09:00:00.000Z" }, source: "dev-1's status line", at: "2026-11-02T09:59:48.000Z" },
			}),
		);

		assert.deepEqual(lines.slice(1, 3), [
			"│ ● running  ·  working · 1/4 Tasks accepted                   │",
			"│ 5h n/a · week 73% ↻Thu 09:00  · dev-1's status line, 12s ago │",
		]);
		assert.match(lines[3], /ctx 21%/);
	});

	it("shows the usage with no Teammate live, a reset later today as a bare time, and an old reading's age in minutes and hours", () => {
		const today = render(
			data({
				usage: { fiveHour: { percent: 41.6, resetsAt: "2026-11-02T13:00:00.000Z" }, sevenDay: { percent: 100 }, source: "get_usage (no Teammate live)", at: "2026-11-02T09:57:00.000Z" },
			}),
		);
		assert.equal(today[2], "│ 5h 42% ↻13:00 · week 100%  · get_usage (no Teammate live), 3m ago │");

		const stale = render(data({ usage: { source: "get_usage", at: "2026-11-02T07:45:00.000Z" } }));
		assert.match(stale[2], /^│ 5h n\/a · week n\/a  · get_usage, 2h 15m ago +│$/);
	});

	it("shows the usage line before the first reading, with each window n/a and no reading yet", () => {
		const lines = render(data({}));
		assert.match(lines[2], /^│ 5h n\/a · week n\/a  · no reading yet +│$/);
	});

	it("shows a Teammate the human holds as ✋ YOURS with its age, what started the Takeover and how to hand it back", () => {
		const lines = render(
			data({
				teammates: [
					mate("architect-1", { task: "001-architect-design", ctx: 18, mode: "auto" }),
					mate("dev-1", { shortId: "d4e5f6a7", task: "002-dev-ttl", ctx: 40, mode: "auto", takeover: { since: "2026-11-02T09:37:00.000Z", trigger: "you typed a prompt" } }),
				],
			}),
		);

		assert.deepEqual(lines.slice(3, 5), [
			"│ architect-1  a1b2c3d4  idle          001-architect-design  ctx 18%  auto       │",
			"│ dev-1        d4e5f6a7  ✋ YOURS 23m  you typed a prompt · /team handback dev-1 │",
		]);
		const narrow = renderTeamBlock(data({ teammates: [mate("dev-1", { takeover: { since: "2026-11-02T09:37:00.000Z", trigger: "you typed a prompt" } })] }), NOW, { maxTeammates: 3, width: 56 });
		assert.equal(narrow[3], "│ dev-1  a1b2c3d4  ✋ YOURS 23m  …/team handback dev-1 │");
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
		assert.match(lines[3], /^│ architect-with-…  a1b2c3d4  idle  001-deeply\/nested\/.*…  ctx —  acceptEdits≠auto │$/);
		assert.match(lines[4], /^│ dev-1 +a1b2c3d4  idle  002-キャッシュ.*… +ctx — +│$/);
		assert.match(lines[5], /^│ queued  004-deeply\/nested\/.*… │$/);
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

	it("rows a Teammate unconfirmed when the shell names which ones it has heard from since a restart, and none when it names none", () => {
		const state = fold(
			through([REQUEST, APPROVE, PLAN, handoff("design"), handoff("ttl"), hook("architect-1", 1, "SessionStart", { source: "startup" }), hook("dev-1", 1, "SessionStart", { source: "startup" })]),
		);

		assert.deepEqual(
			teamStatus(state, { adoptionsPending: 0, confirmed: new Set(["dev-1"]) }).teammates.map((row) => [row.id, row.unconfirmed ?? false]),
			[
				["architect-1", true],
				["dev-1", false],
			],
		);
		assert.ok(teamStatus(state, { adoptionsPending: 0 }).teammates.every((row) => row.unconfirmed === undefined));
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

	it("reads a queued Task's cap reason against the cap in force, never naming one a raised cap no longer holds (#148)", () => {
		const capped = (input: EffortInput): EffortInput => ({ ...input, maxTeammates: 1 }) as EffortInput;
		const state = fold(through([REQUEST, APPROVE, PLAN, capped(handoff("design")), capped(handoff("ttl"))]));
		const why = (maxTeammates?: number) => teamStatus(state, { adoptionsPending: 0, ...(maxTeammates === undefined ? {} : { maxTeammates }) }).queued.map((queued) => queued.why);

		assert.deepEqual(why(1), ["cap 1 reached; waits for 001"]);
		assert.deepEqual(why(2), ["cap 2 has room now; it starts by itself"]);
		assert.deepEqual(why(), ["cap 1 reached; waits for 001"], "with no cap given, the reason on record");
	});

	it("is working once a Task is queued, though none has started", () => {
		const capped = through([REQUEST, APPROVE, PLAN, { ...handoff("design"), maxTeammates: 0 } as EffortInput]);

		assert.equal(teamStatus(fold(capped), { adoptionsPending: 0 }).phase, "working");
	});

	it("lists the pauses that hold, the human's first, and none while the Effort runs", () => {
		const pause = (by: "human" | "lead", at: string, reason?: string): EffortInput => ({ kind: "pause", by, at, ...(reason === undefined ? {} : { reason }) });
		const paused = through([REQUEST, APPROVE, pause("lead", "2026-11-02T10:20:00.000Z", "checking the API"), pause("human", "2026-11-02T10:25:00.000Z")]);

		assert.deepEqual(teamStatus(fold(paused), { adoptionsPending: 0 }).pauses, [
			{ by: "human", since: "2026-11-02T10:25:00.000Z" },
			{ by: "lead", reason: "checking the API", since: "2026-11-02T10:20:00.000Z" },
		]);
		const resumed = through([REQUEST, APPROVE, pause("human", "2026-11-02T10:25:00.000Z"), { kind: "resume", by: "human", at: "2026-11-02T10:30:00.000Z" }]);
		assert.equal(teamStatus(fold(resumed), { adoptionsPending: 0 }).pauses, undefined);
	});

	it("counts the Reports written", () => {
		const report = (at: string): EffortInput => ({ kind: "report", headline: "On track.", criteria: ["AC1"], modes: [], at });

		assert.equal(teamStatus(fold(through([REQUEST, APPROVE, PLAN])), { adoptionsPending: 0 }).reports, 0);
		assert.equal(teamStatus(fold(through([REQUEST, APPROVE, PLAN, report("2026-11-02T10:20:00.000Z"), report("2026-11-02T10:25:00.000Z")])), { adoptionsPending: 0 }).reports, 2);
	});

	it("gives the freshest usage reading with where it came from, and each Teammate's context from its status line", () => {
		const usage = (reading: Record<string, unknown>): EffortInput => ({ kind: "usage", reading: { rateLimits: true, ...reading } }) as EffortInput;
		const handedOff = [REQUEST, APPROVE, PLAN, handoff("design"), handoff("ttl")];
		const read = fold(
			through([
				...handedOff,
				usage({ source: "status-line", teammate: "dev-1", sessionId: "d4e5f6a7-0000", at: "2026-11-02T10:45:00.000Z", sevenDay: { percent: 73, resetsAt: "2026-11-05T09:00:00.000Z" }, ctx: 21 }),
				usage({ source: "status-line", teammate: "architect-1", sessionId: "a1b2c3d4-0000", at: "2026-11-02T10:44:00.000Z", sevenDay: { percent: 72 } }),
			]),
		);
		const status = teamStatus(read, { adoptionsPending: 0 });

		assert.deepEqual(status.usage, { sevenDay: { percent: 73, resetsAt: "2026-11-05T09:00:00.000Z" }, source: "dev-1's status line", at: "2026-11-02T10:45:00.000Z" });
		assert.deepEqual(
			status.teammates.map((row) => [row.id, row.ctx]),
			[
				["architect-1", undefined],
				["dev-1", 21],
			],
		);
		assert.equal(teamStatus(fold(through(handedOff)), { adoptionsPending: 0 }).usage, undefined);
		assert.ok(!("ctx" in status.teammates[0]));
	});

	it("says a get_usage reading was taken with no Teammate live, once none is", () => {
		const reading: EffortInput = { kind: "usage", reading: { source: "get-usage", rateLimits: true, at: "2026-11-02T10:15:00.000Z", fiveHour: { percent: 10 } } };

		assert.equal(teamStatus(fold(through([REQUEST, APPROVE, reading])), { adoptionsPending: 0 }).usage?.source, "get_usage (no Teammate live)");
		assert.equal(teamStatus(fold(through([REQUEST, APPROVE, PLAN, handoff("design"), { ...reading, reading: { ...reading.reading, at: "2026-11-02T10:35:00.000Z" } } as EffortInput])), { adoptionsPending: 0 }).usage?.source, "get_usage");
	});

	it("counts a request only the human can answer now, in a Teammate's terminal, as waiting on the human", () => {
		const asked = (cursor: number, event: string, payload?: Record<string, unknown>): EffortInput => {
			const base = hook("architect-1", cursor, event, payload);
			return base.kind === "journal" ? { ...base, line: { ...base.line, request: "req-0000000a" } } : base;
		};
		const held = [REQUEST, APPROVE, PLAN, handoff("design"), asked(1, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "npm publish" } })];

		assert.equal(teamStatus(fold(through(held)), { adoptionsPending: 0 }).waitingOnYou, 0);
		assert.equal(teamStatus(fold(through([...held, asked(2, "hold-expired")])), { adoptionsPending: 0 }).waitingOnYou, 1);
	});

	it("counts a request the Lead escalated as waiting on the human, until the human answers it", () => {
		const asked = (cursor: number, event: string, payload?: Record<string, unknown>): EffortInput => {
			const base = hook("architect-1", cursor, event, payload);
			return base.kind === "journal" ? { ...base, line: { ...base.line, request: "req-0000000a" } } : base;
		};
		const held = [REQUEST, APPROVE, PLAN, handoff("design"), asked(1, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "npm publish" } })];
		const escalated = [...held, { kind: "escalate", request: "req-0000000a", summary: "Publishing is outside the Brief.", at: "2026-11-02T10:30:00.000Z" } as EffortInput];

		assert.equal(teamStatus(fold(through(escalated)), { adoptionsPending: 0 }).waitingOnYou, 1);
		const answered = [...escalated, { kind: "answer-escalation", id: "req-0000000a", decision: "deny", reason: "Not now.", at: "2026-11-02T10:35:00.000Z" } as EffortInput];
		assert.equal(teamStatus(fold(through(answered)), { adoptionsPending: 0 }).waitingOnYou, 0);
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

	it("rows a Teammate under a Takeover with when it started and what started it, as the human reads it", () => {
		const opened = through([REQUEST, APPROVE, PLAN, handoff("design"), hook("architect-1", 1, "SessionStart", { source: "startup", permission_mode: "auto" })]);
		const trigger = (kind: string, more: Record<string, unknown> = {}): EffortLine[] => [
			...opened,
			{ type: "takeover-started", teammate: "architect-1", cursor: 2, trigger: { kind, ...more }, at: "2026-11-02T10:50:00.000Z" } as EffortLine,
		];

		assert.deepEqual(teamStatus(fold(trigger("prompt")), { adoptionsPending: 0 }).teammates[0].takeover, { since: "2026-11-02T10:50:00.000Z", trigger: "you typed a prompt" });
		assert.deepEqual(
			[trigger("command", { command: "/compact" }), trigger("interrupt"), trigger("deny", { request: "req-1" })].map((lines) => teamStatus(fold(lines), { adoptionsPending: 0 }).teammates[0].takeover?.trigger),
			["you ran /compact", "you interrupted a turn", "you said No to its prompt"],
		);
		assert.equal(teamStatus(fold(opened), { adoptionsPending: 0 }).teammates[0].takeover, undefined);
	});

	it("carries the usage pause's limit and reset and the model holds, and counts the usage items waiting on the human", () => {
		const opened = through([REQUEST, APPROVE, PLAN]);
		const limited: EffortLine[] = [
			...opened,
			{ type: "paused", by: "usage", kind: "session", reason: "session limit", reset: "2026-11-02T15:45:00.000Z", at: "2026-11-02T12:10:00.000Z" },
			{ type: "model-held", family: "opus", kind: "opus", roles: ["architect"], reset: "2026-11-02T16:00:00.000Z", at: "2026-11-02T12:11:00.000Z" },
			{ type: "usage-escalated", id: "u1", why: "retries", kind: "overloaded", teammate: "dev-1", at: "2026-11-02T12:12:00.000Z" },
		];
		const status = teamStatus(fold(limited), { adoptionsPending: 0 });

		assert.deepEqual(status.pauses, [{ by: "usage", kind: "session", reason: "session limit", reset: "2026-11-02T15:45:00.000Z", since: "2026-11-02T12:10:00.000Z" }]);
		assert.deepEqual(status.holds, [{ kind: "opus", roles: ["architect"], reset: "2026-11-02T16:00:00.000Z" }]);
		assert.equal(status.waitingOnYou, 1);
		assert.equal(teamStatus(fold(opened), { adoptionsPending: 0 }).holds, undefined);
	});

	it("counts a usage-credit confirm waiting in a Teammate's terminal as waiting on the human, until it is answered", () => {
		const opened = through([REQUEST, APPROVE, PLAN]);
		const consent: EffortLine[] = [...opened, { type: "model-held", family: "fable", kind: "consent", roles: ["dev"], teammate: "dev-1", at: "2026-11-02T12:11:00.000Z" }];

		assert.equal(teamStatus(fold(consent), { adoptionsPending: 0 }).waitingOnYou, 1);
		assert.equal(teamStatus(fold([...consent, { type: "model-released", family: "fable", at: "2026-11-02T12:20:00.000Z" }]), { adoptionsPending: 0 }).waitingOnYou, 0);
	});
});
