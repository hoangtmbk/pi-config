/**
 * A Takeover, through the Effort core: the human's input the bundled mod
 * journals starts one, only a hand-back ends it, and while it lasts the Lead
 * backs off from that Teammate. Every step is checked to fold back to the
 * state it returned, as in core.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type EffortInput, type EffortLine, fold, openEffort, type Step, step } from "../core.ts";

const OPENED = openEffort({ effortId: "software-2026-11-02", team: "software", repo: "/work/app", playbook: "a".repeat(64), at: "2026-11-02T10:00:00.000Z" });

function run(lines: EffortLine[], input: EffortInput): Step {
	const result = step(fold(lines), input);
	if (result.ok) assert.deepEqual(fold([...lines, ...result.append]), result.state, "the appended lines fold to a different state than the step returned");
	return result;
}

function applied(lines: EffortLine[], input: EffortInput): EffortLine[] {
	const result = run(lines, input);
	assert.ok(result.ok, result.ok ? "" : result.refusal);
	return [...lines, ...result.append];
}

function refusal(lines: EffortLine[], input: EffortInput): string {
	const result = run(lines, input);
	assert.equal(result.ok, false, "expected the core to refuse");
	return result.ok ? "" : result.refusal;
}

/** The texts the Lead is woken with. */
function wakes(result: Step): string[] {
	assert.ok(result.ok, result.ok ? "" : result.refusal);
	return result.actions.flatMap((action) => (action.kind === "wake-lead" ? [action.text] : []));
}

const DIR = "/agent/team/efforts/software-2026-11-02/tasks/001-dev-rename";
const RESULT = `${DIR}/result-1.md`;
const INBOX = { socket: "/tmp/cc-socks/4242.sock", token: "inbox-token" };
const SESSION = "8f3c2a1b-0000-4000-8000-000000000001";
const LAUNCH = `New Task \`rename\`: read ${DIR}/task.md and do what it asks.\nWhen it is done, write your result to ${RESULT}.`;

const approved = applied(
	applied([OPENED], { kind: "request-approval", checkpoint: "brief", path: "/b.md", sha256: "b".repeat(64), snapshot: "brief", at: "2026-11-02T10:05:00.000Z" }),
	{ kind: "answer", id: "r1", answer: "approved", at: "2026-11-02T11:00:00.000Z" },
);
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

/** Line `cursor` of dev-1's journal, from the hook or the mod. */
function line(cursor: number, from: "hook" | "mod", event: string, payload: Record<string, unknown> = {}, extra: { written?: boolean; request?: string } = {}): Extract<EffortInput, { kind: "journal" }> {
	const minute = String(cursor).padStart(2, "0");
	return {
		kind: "journal",
		teammate: "dev-1",
		cursor,
		line: {
			from,
			at: `2026-11-02T12:${minute}:00.000Z`,
			event,
			payload: from === "hook" ? { session_id: SESSION, hook_event_name: event, ...payload } : payload,
			...(event === "SessionStart" ? { inbox: INBOX } : {}),
			...(extra.request === undefined ? {} : { request: extra.request }),
		},
		result: { path: RESULT, written: extra.written ?? false },
		sent: [LAUNCH, "continue"],
	};
}

const hook = (cursor: number, event: string, payload?: Record<string, unknown>, extra?: { written?: boolean; request?: string }) => line(cursor, "hook", event, payload, extra);
const mod = (cursor: number, event: string, payload?: Record<string, unknown>) => line(cursor, "mod", event, payload);

const running = applied(applied(planned, { kind: "handoff", slug: "rename", at: "2026-11-02T11:30:00.000Z" }), hook(1, "SessionStart", { source: "startup" }));

describe("what starts a Takeover", () => {
	const starts: [string, Extract<EffortInput, { kind: "journal" }>, RegExp][] = [
		["a prompt the human typed", mod(2, "prompt.submit", { text: "use the other store" }), /typed a prompt/],
		["a command not on the read-only list", mod(2, "command.run", { command: "model", args: "sonnet" }), /ran `\/model`/],
		["Esc during a turn", mod(2, "turn.complete", { aborted: true }), /interrupted/],
	];

	for (const [what, input, told] of starts) {
		it(`starts one on ${what}, waking the Lead once with what started it`, () => {
			const result = run(running, input);

			assert.ok(result.ok, result.ok ? "" : result.refusal);
			assert.deepEqual(
				result.append.map((each) => each.type),
				["takeover-started"],
			);
			const [text] = wakes(result);
			assert.equal(wakes(result).length, 1);
			assert.match(text ?? "", /The human took over `dev-1`/);
			assert.match(text ?? "", told);
			assert.match(text ?? "", /held/);
			assert.ok(result.state.teammates[0]?.takeover, "expected dev-1 to be under a Takeover");
			assert.deepEqual(result.actions.filter((action) => action.kind === "mark-takeover"), [{ kind: "mark-takeover", teammate: "dev-1", on: true }]);
		});
	}

	it("keeps the prompt or command that started it, for the hand-back summary", () => {
		const prompted = run(running, mod(2, "prompt.submit", { text: "use the other store" }));
		const commanded = run(running, mod(2, "command.run", { command: "model", args: "sonnet" }));

		assert.deepEqual(prompted.ok && prompted.state.teammates[0]?.takeover?.inputs, ["use the other store"]);
		assert.deepEqual(commanded.ok && commanded.state.teammates[0]?.takeover?.inputs, ["/model sonnet"]);
	});

	it("records the human's later input without waking the Lead again", () => {
		const taken = applied(running, mod(2, "prompt.submit", { text: "use the other store" }));
		const more = run(taken, mod(3, "command.run", { command: "compact", args: "" }));
		const interrupted = run(taken, mod(3, "turn.complete", { aborted: true }));

		assert.deepEqual(wakes(more), []);
		assert.deepEqual(more.ok && more.append.map((each) => each.type), ["takeover-input"]);
		assert.deepEqual(more.ok && more.state.teammates[0]?.takeover?.inputs, ["use the other store", "/compact"]);
		assert.deepEqual(wakes(interrupted), []);
	});

	it("starts one on a card the human answered No or Esc to, once nothing says the call ran", () => {
		const held = applied(running, hook(2, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf dist" } }, { request: "req-0000000a" }));
		const denied = applied(held, hook(3, "denied-in-terminal", {}, { request: "req-0000000a" }));
		assert.equal(fold(denied).teammates[0]?.takeover, undefined, "a killed hook may still be a Yes");

		// The turn ended without the call running: it was a No.
		const stopped = run(denied, hook(4, "Stop", {}));
		assert.ok(stopped.ok && stopped.state.teammates[0]?.takeover);
		assert.match(wakes(stopped).join("\n"), /said No/);
		assert.equal(wakes(stopped).length, 1);
		// What the human typed after the No starts it too, and is kept.
		const typed = run(denied, mod(4, "prompt.submit", { text: "do it with git clean instead" }));
		assert.deepEqual(typed.ok && typed.state.teammates[0]?.takeover?.inputs, ["do it with git clean instead"]);
		assert.match(wakes(typed).join("\n"), /said No/);
	});
});

describe("what never starts a Takeover", () => {
	const never: [string, Extract<EffortInput, { kind: "journal" }>][] = [
		["the launch prompt, matched by its text", mod(2, "prompt.submit", { text: LAUNCH })],
		["`continue` the Effort sent", mod(2, "prompt.submit", { text: "continue" })],
		...["context", "cost", "usage", "status", "help"].map((command): [string, Extract<EffortInput, { kind: "journal" }>] => [`/${command}`, mod(2, "command.run", { command, args: "" })]),
		["a turn that ended by itself", mod(2, "turn.complete", { aborted: false })],
		["a prompt landing, which is how every send lands", hook(2, "UserPromptSubmit", { prompt: "use the other store" })],
		["a mode drift", hook(2, "Notification", { permission_mode: "acceptEdits", notification_type: "idle_prompt" })],
	];

	for (const [what, input] of never) {
		it(`ignores ${what}`, () => {
			const result = run(running, input);

			assert.ok(result.ok, result.ok ? "" : result.refusal);
			assert.equal(result.state.teammates[0]?.takeover, undefined);
			assert.ok(!result.append.some((each) => each.type === "takeover-started"));
		});
	}

	it("ignores attaching, and a card the human answered Yes to", () => {
		const attached = run(running, { kind: "attach", teammate: "dev-1", at: "2026-11-02T12:02:00.000Z" });
		const held = applied(running, hook(2, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "npm test" } }, { request: "req-0000000a" }));
		const killed = applied(held, hook(3, "denied-in-terminal", {}, { request: "req-0000000a" }));
		const yes = applied(killed, hook(4, "PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } }));
		const after = run(yes, hook(5, "Stop", {}));

		assert.equal(attached.ok && attached.state.teammates[0]?.takeover, undefined);
		assert.equal(after.ok && after.state.teammates[0]?.takeover, undefined);
	});

	it("ignores input on a Teammate that has ended", () => {
		const crashed = applied(running, hook(2, "SessionEnd", { reason: "other" }));
		const result = run(crashed, mod(3, "prompt.submit", { text: "hello?" }));

		assert.ok(result.ok && !result.append.some((each) => each.type === "takeover-started"));
	});
});

const AT = "2026-11-02T12:30:00.000Z";
const taken = applied(running, mod(2, "prompt.submit", { text: "use the other store" }));
const accept = (slug: string, written = true): EffortInput => ({ kind: "review", slug, verdict: "accept", result: { path: RESULT, written }, sendBackLimit: 2, at: AT });
const handback = (note?: string, written = false): EffortInput => ({ kind: "handback", teammate: "dev-1", ...(note === undefined ? {} : { note }), result: { path: RESULT, written }, at: "2026-11-02T12:45:00.000Z" });
/** dev-1 done with `rename`, accepted, and idle: free for the next Task. */
const freed = applied(applied(running, hook(2, "Stop", {}, { written: true })), accept("rename"));

describe("while a Takeover lasts", () => {
	it("holds the Lead's sends to the Teammate instead of sending them", () => {
		const result = run(taken, { kind: "send", teammate: "dev-1", message: "try the cache flag", at: AT });

		assert.ok(result.ok, result.ok ? "" : result.refusal);
		assert.deepEqual(result.append.map((each) => each.type), ["send-held"]);
		assert.deepEqual(result.actions, []);
		assert.match(result.reply ?? "", /held/);
		assert.deepEqual(result.state.teammates[0]?.takeover?.held.map((each) => each.message), ["try the cache flag"]);
	});

	it("takes nothing the Teammate writes as done, and wakes nobody when its turn ends", () => {
		const result = run(taken, hook(3, "Stop", {}, { written: true }));

		assert.deepEqual(result.ok && result.append.map((each) => each.type), ["takeover-turn"]);
		assert.deepEqual(wakes(result), []);
		assert.equal(result.ok && result.state.tasks.rename?.reported, undefined);
		assert.match(refusal(applied(taken, hook(3, "Stop", {}, { written: true })), accept("rename")), /dev-1/);
	});

	it("leaves its permission prompts to the human", () => {
		const held = applied(running, hook(2, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "npm publish" } }, { request: "req-0000000b" }));
		const holding = applied(held, mod(3, "command.run", { command: "model", args: "opus" }));

		assert.match(refusal(holding, { kind: "answer-request", request: "req-0000000b", decision: "allow", at: AT }), /dev-1/);
	});

	it("never clears it for a new Task: the Task goes to another Teammate, or waits", () => {
		const holding = applied(freed, mod(3, "prompt.submit", { text: "now tidy the README" }));
		const rerouted = run(holding, { kind: "handoff", slug: "docs", at: AT });
		const queued = run(holding, { kind: "handoff", slug: "docs", at: AT, maxTeammates: 1 });

		assert.ok(rerouted.ok && !rerouted.actions.some((action) => action.kind === "clear-then-send"));
		assert.ok(rerouted.ok && rerouted.actions.some((action) => action.kind === "launch-teammate"));
		assert.deepEqual(queued.ok && queued.append.map((each) => each.type), ["task-queued"]);
	});

	it("holds a Task's pointer when the clear asked for before the Takeover lands during it", () => {
		const clearing = applied(freed, { kind: "handoff", slug: "docs", at: AT });
		const holding = applied(clearing, mod(3, "prompt.submit", { text: "wait, one more thing" }));
		const cleared = run(holding, hook(4, "SessionStart", { source: "clear", session_id: "8f3c2a1b-0000-4000-8000-000000000002" }));

		assert.deepEqual(cleared.ok && cleared.append.map((each) => each.type), ["teammate-session", "send-held"]);
		assert.ok(cleared.ok && !cleared.actions.some((action) => action.kind === "send-pointer"));
	});
});

describe("handing a Teammate back", () => {
	it("is refused in pi when nobody holds the Teammate", () => {
		assert.match(refusal(running, handback()), /isn't taken over/);
	});

	for (const [where, end] of [
		["in pi with `/team handback`", (lines: EffortLine[]) => run(lines, handback("kept the old store, see notes.md", true))],
		["in its terminal with `/handback`", (lines: EffortLine[]) => run(lines, { ...mod(6, "handback", { note: "kept the old store, see notes.md" }), result: { path: RESULT, written: true } })],
	] as const) {
		it(`ends it ${where}, waking the Lead once with what the human did and dropping the held sends`, () => {
			const typed = applied(taken, mod(3, "command.run", { command: "compact", args: "" }));
			const sent = applied(typed, { kind: "send", teammate: "dev-1", message: "try the cache flag", at: AT });
			const stopped = applied(sent, hook(4, "Stop", {}, { written: true }));
			const result = end(stopped);

			assert.ok(result.ok, result.ok ? "" : result.refusal);
			assert.deepEqual(result.append.map((each) => each.type), ["takeover-ended", "task-done"]);
			assert.equal(result.state.teammates[0]?.takeover, undefined);
			assert.equal(result.state.tasks.rename?.reported, 1);
			assert.deepEqual(result.actions.filter((action) => action.kind === "mark-takeover"), [{ kind: "mark-takeover", teammate: "dev-1", on: false }]);
			assert.ok(!result.actions.some((action) => action.kind === "send-message"));
			const [summary = ""] = wakes(result);
			assert.equal(wakes(result).length, 1);
			for (const told of [/typed a prompt/, /"use the other store"/, /"\/compact"/, new RegExp(RESULT), /idle/, /"try the cache flag"/, /dropped/, /kept the old store, see notes\.md/, /never amends the Brief/]) {
				assert.match(summary, told);
			}
		});
	}

	it("ignores a `/handback` in a terminal nobody took over", () => {
		const result = run(running, mod(2, "handback", {}));

		assert.deepEqual(result.ok && [result.append, result.actions], [[], []]);
	});

	it("gives the human's context back to the Lead: the next new Task clears the Teammate first", () => {
		const holding = applied(freed, mod(3, "prompt.submit", { text: "now tidy the README" }));
		const queued = applied(holding, { kind: "handoff", slug: "docs", at: AT, maxTeammates: 1 });
		const back = applied(queued, handback());
		const drained = run(back, { kind: "drain", at: "2026-11-02T12:46:00.000Z", maxTeammates: 1 });

		assert.ok(drained.ok && drained.actions.some((action) => action.kind === "clear-then-send" && action.slug === "docs"));
	});

	it("sends a held Task's pointer after a fresh clear", () => {
		const clearing = applied(freed, { kind: "handoff", slug: "docs", at: AT });
		const holding = applied(clearing, mod(3, "prompt.submit", { text: "wait, one more thing" }));
		const cleared = applied(holding, hook(4, "SessionStart", { source: "clear", session_id: "8f3c2a1b-0000-4000-8000-000000000002" }));
		const result = run(cleared, handback());

		assert.ok(result.ok && result.actions.some((action) => action.kind === "clear-then-send" && action.slug === "docs"));
		assert.match(wakes(result).join("\n"), /Task `docs`'s pointer after a clear/);
	});

	it("ends with a crash, which wakes the Lead with the crash alone", () => {
		const result = run(taken, hook(3, "SessionEnd", { reason: "other" }));

		assert.deepEqual(result.ok && result.append.map((each) => each.type), ["teammate-crashed", "takeover-ended"]);
		assert.equal(result.ok && result.state.teammates[0]?.takeover, undefined);
		assert.equal(wakes(result).length, 1);
		assert.match(wakes(result)[0] ?? "", /session ended/);
		assert.ok(result.ok && result.actions.some((action) => action.kind === "mark-takeover" && !action.on));
	});
});

describe("a Takeover and a fresh session an approved Brief change asks for (#112)", () => {
	/** `state` with dev-1 due a fresh session at its next Task, as an approved Brief change that alters its Role's launch options leaves it. */
	const freshDue = (state: ReturnType<typeof fold>) => ({ ...state, teammates: state.teammates.map((teammate) => ({ ...teammate, freshDue: true as const })) });
	const ok = (result: Step) => {
		assert.ok(result.ok, result.ok ? "" : result.refusal);
		return result;
	};

	it("never starts a Teammate the human holds afresh; its next Task after the hand-back does", () => {
		const holding = freshDue(fold(applied(freed, mod(3, "prompt.submit", { text: "now tidy the README" }))));
		const queued = ok(step(holding, { kind: "handoff", slug: "docs", at: AT, maxTeammates: 1 }));
		assert.deepEqual(queued.append.map((each) => each.type), ["task-queued"]);

		const back = ok(step(queued.state, handback()));
		const drained = ok(step(back.state, { kind: "drain", at: "2026-11-02T12:46:00.000Z", maxTeammates: 1 }));

		assert.ok(drained.append.some((each) => each.type === "teammate-relaunched" && each.teammate === "dev-1"));
		assert.ok(!drained.actions.some((action) => action.kind === "clear-then-send"));
	});

	/** dev-1, free, with a card its old session's terminal killed the hook of, started afresh on `docs`: its new session hasn't started yet. */
	const relaunched = (() => {
		const held = applied(freed, hook(3, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf dist" } }, { request: "req-0000000a" }));
		const denied = applied(held, hook(4, "denied-in-terminal", {}, { request: "req-0000000a" }));
		const folder = fold(denied).tasks.docs?.folder ?? "002-dev-docs";
		return [
			...denied,
			{ type: "task-handed-off", slug: "docs", folder, role: "dev", teammate: "dev-1", at: AT, round: 1 },
			{ type: "teammate-relaunched", teammate: "dev-1", task: "docs", at: AT },
		] satisfies EffortLine[];
	})();

	it("takes no input from the old session of a Teammate being started afresh as a Takeover", () => {
		const typed = run(relaunched, mod(5, "prompt.submit", { text: "one more thing" }));

		assert.deepEqual(typed.ok && typed.append, []);
		assert.equal(typed.ok && typed.state.teammates[0]?.takeover, undefined);
	});

	it("leaves the old session's unanswered card behind: the new session going on is no No", () => {
		const started = applied(relaunched, hook(5, "SessionStart", { source: "startup", session_id: "9a9a9a9a-0000-4000-8000-000000000003" }));
		const stopped = run(started, hook(6, "Stop", { session_id: "9a9a9a9a-0000-4000-8000-000000000003" }));

		assert.equal(stopped.ok && stopped.state.teammates[0]?.takeover, undefined);
		assert.ok(stopped.ok && !stopped.append.some((each) => each.type === "takeover-started"));
		// The human typing in the new session does take it over.
		const typed = run(started, mod(6, "prompt.submit", { text: "use the other store" }));
		assert.ok(typed.ok && typed.state.teammates[0]?.takeover);
	});
});
