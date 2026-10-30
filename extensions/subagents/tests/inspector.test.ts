/**
 * `/subagents`: the picker and the Inspector.
 *
 * Most of what a reader sees and what a key does is decided by pure functions,
 * asserted here by calling them. The overlays themselves are then built against
 * a TUI that is nothing but a terminal height and a render counter, fed a
 * transcript written down event by event, and read back as the lines they draw
 * — pi's own message components included, so "drawn the way pi's chat draws"
 * is checked against pi's chat code rather than a stand-in for it.
 *
 * No child, no Supervisor and no terminal: the control plane is a recorder, and
 * nothing here spawns anything.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { RunControl, SendOutcome } from "../control.ts";
import {
	type Chrome,
	InspectorView,
	inspectorHeader,
	inspectorHints,
	inspectorKey,
	isKillable,
	lockReason,
	moveSelection,
	packHints,
	pageOf,
	pickerKey,
	pickerOrder,
	pickerRows,
	pickerTally,
	PickerView,
	scrolled,
	sendHint,
	sentLine,
	viewTop,
} from "../inspector.ts";
import type { Run } from "../supervisor.ts";
import { Transcripts } from "../transcript.ts";

// pi's message components draw with pi's global theme, which pi itself sets up
// before any extension runs. Here nothing has, so it is set up once, by hand.
initTheme("dark");

/** A Run as the Supervisor holds one, `secondsAgo` old at time zero. */
function run(name: string, state: Run["state"], secondsAgo = 0, extra: Partial<Run> = {}): Run {
	return { name, agent: "scout", task: "look around", state, askedAt: -secondsAgo * 1000, ...extra };
}

/** Raw key sequences, as a terminal without the Kitty protocol sends them. */
const KEY = {
	enter: "\r",
	escape: "\x1b",
	up: "\x1b[A",
	down: "\x1b[B",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	ctrlO: "\x0f",
	ctrlT: "\x14",
	ctrlX: "\x18",
	/** Shift+Enter as the Kitty protocol sends it: the one encoding that is unambiguously that key. */
	shiftEnter: "\x1b[13;2u",
};

describe("the picker's order", () => {
	it("lists the active Runs first, in the order they were asked for", () => {
		const runs = [run("a", "done", 0, { stoppedAt: 0 }), run("b", "running"), run("c", "queued"), run("d", "waiting")];

		assert.deepEqual(
			pickerOrder(runs).map((candidate) => candidate.name),
			["b", "c", "d", "a"],
		);
	});

	it("lists the finished Runs after them, the one that finished last first", () => {
		const runs = [run("a", "done", 0, { stoppedAt: 1000 }), run("b", "failed", 0, { stoppedAt: 3000 }), run("c", "done", 0, { stoppedAt: 2000 })];

		assert.deepEqual(
			pickerOrder(runs).map((candidate) => candidate.name),
			["b", "c", "a"],
		);
	});

	it("puts the Run asked for last first among Runs that stopped together, as a shutdown stops them", () => {
		const runs = ["a", "b", "c"].map((name) => run(name, "failed", 0, { stoppedAt: 5000 }));

		assert.deepEqual(
			pickerOrder(runs).map((candidate) => candidate.name),
			["c", "b", "a"],
		);
	});
});

describe("the picker's rows", () => {
	it("are the widget's columns, a finished Run's clock stopped where it stopped", () => {
		const rows = pickerRows(
			[run("scout", "running", 72, { activity: "read auth.ts" }), run("worker", "done", 90, { stoppedAt: -30_000 })],
			0,
			40,
		);

		assert.deepEqual(rows, [
			{ name: "scout", text: "01:12  scout   running · read auth.ts" },
			{ name: "worker", text: "01:00  worker  done" },
		]);
	});

	it("tally what is still going and what has finished", () => {
		assert.equal(pickerTally([run("a", "running"), run("b", "queued"), run("c", "failed")]), "2 active · 1 finished");
	});
});

describe("the picker's selection", () => {
	const names = ["a", "b", "c"];

	it("moves by name, so it stays on a Run that moves in the list", () => {
		assert.equal(moveSelection(["b", "c", "a"], "a", -1), "c");
	});

	it("stays inside the list at either end", () => {
		assert.equal(moveSelection(names, "a", -1), "a");
		assert.equal(moveSelection(names, "c", 1), "c");
	});

	it("starts from the first row, which is the row drawn as selected before anything is", () => {
		assert.equal(moveSelection(names, undefined, 0), "a");
		assert.equal(moveSelection(names, undefined, 1), "b");
		assert.equal(moveSelection(names, "gone", 1), "b");
	});

	it("is nothing in an empty list", () => {
		assert.equal(moveSelection([], undefined, 1), undefined);
	});
});

describe("the picker's keys", () => {
	it("are Up and Down to move, Enter to open and Escape to close", () => {
		assert.deepEqual([KEY.up, KEY.down, KEY.enter, KEY.escape].map(pickerKey), ["up", "down", "open", "close"]);
	});

	it("leave every other key alone", () => {
		assert.deepEqual(["a", KEY.pageUp, KEY.ctrlX].map(pickerKey), [undefined, undefined, undefined]);
	});
});

describe("the Inspector's keys", () => {
	const open = { confirming: false, editable: true };
	const locked = { confirming: false, editable: false };
	const confirming = { confirming: true, editable: true };

	it("take PgUp and PgDn for the transcript, before the editor can spend them on itself", () => {
		assert.equal(inspectorKey(KEY.pageUp, open), "scroll-up");
		assert.equal(inspectorKey(KEY.pageDown, open), "scroll-down");
	});

	it("take Escape as going back, which the editor has no use for", () => {
		assert.equal(inspectorKey(KEY.escape, open), "back");
	});

	it("take ctrl+o, ctrl+t and ctrl+x for tools, thinking and a kill", () => {
		assert.deepEqual(
			[KEY.ctrlO, KEY.ctrlT, KEY.ctrlX].map((key) => inspectorKey(key, open)),
			["toggle-tools", "toggle-thinking", "kill"],
		);
	});

	it("hand typing — Enter and Shift+Enter included — to the editor while it is open", () => {
		assert.deepEqual(
			["a", KEY.enter, KEY.shiftEnter, KEY.up].map((key) => inspectorKey(key, open)),
			["edit", "edit", "edit", "edit"],
		);
	});

	it("drop typing while the editor is locked, keeping every key that is not the editor's", () => {
		assert.equal(inspectorKey("a", locked), "ignore");
		assert.equal(inspectorKey(KEY.enter, locked), "ignore");
		assert.equal(inspectorKey(KEY.pageUp, locked), "scroll-up");
		assert.equal(inspectorKey(KEY.escape, locked), "back");
	});

	it("take only y or n while a kill waits on its answer, so a stray key neither kills nor types", () => {
		assert.equal(inspectorKey("y", confirming), "confirm-kill");
		assert.equal(inspectorKey("Y", confirming), "confirm-kill");
		assert.equal(inspectorKey("n", confirming), "cancel-kill");
		assert.equal(inspectorKey(KEY.escape, confirming), "cancel-kill", "Escape answers no rather than leaving with the question open");
		assert.deepEqual(
			["a", KEY.enter, KEY.ctrlX, KEY.pageUp].map((key) => inspectorKey(key, confirming)),
			["ignore", "ignore", "ignore", "ignore"],
		);
	});

	it("read a y the way the Kitty protocol encodes it", () => {
		assert.equal(inspectorKey("\x1b[121u", confirming), "confirm-kill");
	});
});

describe("what the Inspector says about a Run", () => {
	it("opens the editor for a running Run and a Waiting one, and nothing else", () => {
		assert.equal(lockReason(run("scout", "running")), undefined);
		assert.equal(lockReason(run("scout", "waiting")), undefined);
		assert.match(lockReason(run("scout", "queued")) ?? "", /^scout is queued for a run slot: it has no child to talk to until it starts\.$/);
		assert.match(lockReason(run("scout", "done")) ?? "", /^scout is done\. A finished run is read-only: its child is already gone\.$/);
		assert.match(lockReason(run("scout", "failed")) ?? "", /^scout failed\. A finished run is read-only/);
	});

	it("says up front what Enter would do, which is a steer or an answer depending on the state", () => {
		assert.match(sendHint(run("scout", "running")) ?? "", /a steer, which it takes at its next turn boundary/);
		assert.match(sendHint(run("scout", "waiting")) ?? "", /waiting on its question: Enter answers it, in place of the parent/);
		assert.equal(sendHint(run("scout", "done")), undefined);
	});

	it("reports a refusal in the control plane's own words, verbatim", () => {
		assert.equal(sentLine("scout", { ok: false, reason: "too late — scout already finished" }), "too late — scout already finished");
	});

	it("says which of the two things a message that went through was taken as", () => {
		assert.match(sentLine("scout", { ok: true, as: "steer" }), /^Sent to scout, which takes it at its next turn boundary\./);
		assert.match(sentLine("scout", { ok: true, as: "answer" }), /^Answered scout's question; it has resumed\./);
	});

	it("offers a kill for a Run that has a child or a place in the queue, and not for a finished one", () => {
		assert.deepEqual(
			(["queued", "running", "waiting", "done", "failed"] as const).map((state) => isKillable(run("scout", state))),
			[true, true, true, false, false],
		);
	});

	it("offers only the keys that would do something", () => {
		assert.deepEqual(inspectorHints(run("scout", "running")), [
			"enter send",
			"shift+enter newline",
			"pgup/pgdn scroll",
			"ctrl+o tools",
			"ctrl+t thinking",
			"ctrl+x kill",
			"esc back",
		]);
		assert.deepEqual(inspectorHints(run("scout", "queued")), ["pgup/pgdn scroll", "ctrl+o tools", "ctrl+t thinking", "ctrl+x kill", "esc back"]);
		assert.deepEqual(inspectorHints(run("scout", "done")), ["pgup/pgdn scroll", "ctrl+o tools", "ctrl+t thinking", "esc back"]);
	});

	it("wraps the hints rather than clipping them, so the way out is never the part cut off", () => {
		assert.deepEqual(packHints(["enter send", "pgup/pgdn scroll", "esc back"], 30), ["enter send · pgup/pgdn scroll", "esc back"]);
	});

	it("heads the Inspector with the Run's name, Agent, state and age", () => {
		assert.equal(inspectorHeader(run("scout-2", "running", 75, { agent: "scout" }), 0), "scout-2 · scout · running · 01:15");
	});

	it("ends the header with the Run's Pressure level from notice up, and with compacting while one runs", () => {
		const warned = run("scout-2", "running", 75, { pressure: { level: "warning", tokens: 152_000 } });
		const compacting = run("scout-2", "running", 75, { pressure: "compacting" });

		assert.equal(inspectorHeader(warned, 0), "scout-2 · scout · running · 01:15 · warning 152k");
		assert.equal(inspectorHeader(compacting, 0), "scout-2 · scout · running · 01:15 · compacting");
	});
});

describe("scrolling the transcript", () => {
	const following = { top: 0, follow: true };

	it("shows the tail while following, however long the transcript grows", () => {
		assert.equal(viewTop(following, 100, 20), 80);
		assert.equal(viewTop(following, 150, 20), 130);
	});

	it("stops following once scrolled up, and stays where it was put as the transcript grows", () => {
		const up = scrolled(following, -pageOf(20), 100, 20);

		assert.deepEqual(up, { top: 61, follow: false });
		assert.equal(viewTop(up, 150, 20), 61);
	});

	it("follows again once scrolled back to the bottom", () => {
		const up = scrolled(following, -10, 100, 20);

		assert.deepEqual(scrolled(up, 50, 100, 20), { top: 80, follow: true });
	});

	it("keeps following a transcript shorter than the view, which has nowhere to scroll to", () => {
		assert.deepEqual(scrolled(following, -19, 5, 20), { top: 0, follow: true });
	});

	it("moves a page at a time, keeping a line of the last page for context", () => {
		assert.equal(pageOf(20), 19);
		assert.equal(pageOf(1), 1);
	});
});

/** The TUI an overlay is handed, as far as these overlays use one. */
function fakeTui(rows = 40) {
	const tui = {
		terminal: { rows, columns: 120 },
		renders: 0,
		requestRender() {
			tui.renders++;
		},
	};
	return tui;
}

type OverlayTui = ConstructorParameters<typeof InspectorView>[0];

/** pi's theme with its colours taken out, so the overlays' own chrome reads as plain text. */
const PLAIN: Chrome = { fg: (_color, text) => text, bold: (text) => text };

/** A control plane that answers the way it is told to, and remembers what it was asked. */
function recordingControl(outcome: SendOutcome = { ok: true, as: "steer" }) {
	const sent: { name: string; text: string }[] = [];
	const killed: string[] = [];
	const control: RunControl = {
		async send(name, text) {
			sent.push({ name, text });
			return outcome;
		},
		async kill(name) {
			killed.push(name);
			return true;
		},
	};
	return { control, sent, killed };
}

/** An Inspector open on `scout`, whose transcript a test writes event by event. */
function inspecting(subject: Run = run("scout", "running", 65), options: { rows?: number; outcome?: SendOutcome } = {}) {
	const transcripts = new Transcripts();
	transcripts.start(subject.name);
	const { control, sent, killed } = recordingControl(options.outcome);
	const tui = fakeTui(options.rows);
	let closed = 0;
	const session = { runs: () => [subject], transcripts, control, now: () => 0 };
	const view = new InspectorView(tui as unknown as OverlayTui, PLAIN, session, subject.name, process.cwd(), () => {
		closed++;
	});
	return {
		view,
		tui,
		sent,
		killed,
		transcripts,
		/** Feed the child's events, the way `index.ts` does as they arrive. */
		emit: (...events: JsonAgentSessionEvent[]) => {
			for (const event of events) transcripts.observe(subject.name, event);
		},
		/** What the Inspector draws, with pi's colours stripped and trailing blanks trimmed. */
		screen: (width = 100) => view.render(width).map((line) => stripTerminalSequences(line).trimEnd()),
		/** Press keys, one after another. */
		press: (...keys: string[]) => {
			for (const key of keys) view.handleInput(key);
		},
		closed: () => closed,
	};
}

/** Every line of a screen as one string, to search. */
function text(lines: string[]): string {
	return lines.join("\n");
}

/** How many times `needle` appears in `haystack`. */
function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/** A message settling in the child: the `message_start` and `message_end` pi sends for every one. */
function settled(message: unknown): JsonAgentSessionEvent[] {
	return [
		{ type: "message_start", message } as unknown as JsonAgentSessionEvent,
		{ type: "message_end", message } as unknown as JsonAgentSessionEvent,
	];
}

function user(text: string): unknown {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function assistant(content: unknown[], stopReason = "stop"): unknown {
	return { role: "assistant", content, api: "anthropic", provider: "", model: "", usage: {}, stopReason, timestamp: 0 };
}

function toolCall(id: string, name: string, args: unknown): unknown {
	return { type: "toolCall", id, name, arguments: args };
}

/** A tool running to completion in the child: its start, its end, and the result message it settles. */
function ran(id: string, name: string, args: unknown, output: string): JsonAgentSessionEvent[] {
	const result = { content: [{ type: "text", text: output }], details: {} };
	return [
		{ type: "tool_execution_start", toolCallId: id, toolName: name, args } as unknown as JsonAgentSessionEvent,
		{ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError: false } as unknown as JsonAgentSessionEvent,
		...settled({ role: "toolResult", toolCallId: id, toolName: name, ...result, isError: false, timestamp: 0 }),
	];
}

/**
 * A tool that has started in the child and is still going, having reported
 * `output` so far: its call settled, its start, and one partial update.
 */
function running(id: string, name: string, args: unknown, output: string): JsonAgentSessionEvent[] {
	return [
		...settled(assistant([toolCall(id, name, args)], "toolUse")),
		{ type: "tool_execution_start", toolCallId: id, toolName: name, args } as unknown as JsonAgentSessionEvent,
		{
			type: "tool_execution_update",
			toolCallId: id,
			toolName: name,
			args,
			partialResult: { content: [{ type: "text", text: output }], details: {} },
		} as unknown as JsonAgentSessionEvent,
	];
}

/** One delta of a streaming reply, as it arrives over RPC. */
function delta(assistantMessageEvent: Record<string, unknown>): JsonAgentSessionEvent {
	return { type: "message_update", assistantMessageEvent } as unknown as JsonAgentSessionEvent;
}

/** Let a send or a kill that has already been answered come back. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the Inspector, drawn", () => {
	it("draws the transcript the way pi's chat does: the task, the replies, and each tool call with its output", () => {
		const { view, emit, screen } = inspecting(undefined, { rows: 60 });
		emit(
			...settled(user("Find the auth module.")),
			...settled(assistant([{ type: "text", text: "Looking." }, toolCall("t1", "bash", { command: "ls src" })], "toolUse")),
			...ran("t1", "bash", { command: "ls src" }, "auth.ts\nindex.ts"),
			...settled(assistant([{ type: "text", text: "It is src/auth.ts." }])),
		);

		const lines = screen();
		const drawn = text(lines);
		view.dispose();

		assert.match(lines[0], /^╭─ scout · scout · running · 01:05 ─+╮$/);
		assert.match(drawn, /Find the auth module\./);
		assert.match(drawn, /Looking\./);
		assert.match(drawn, /\$ ls src/, "bash is drawn by pi's own bash renderer");
		assert.match(drawn, /It is src\/auth\.ts\./);
		assert.equal(count(drawn, "index.ts"), 1, "a tool's output is drawn inside its call, not again as a result message");
		assert.ok(
			lines.every((line) => [...line].length <= 100),
			"no line is wider than the overlay",
		);
	});

	it("draws a tool pi has no renderer for in pi's generic view: its name, arguments and output", () => {
		const { view, emit, screen } = inspecting();
		emit(
			...settled(assistant([toolCall("q1", "ask_question", { question: "Which auth module?" })], "toolUse")),
			...ran("q1", "ask_question", { question: "Which auth module?" }, "Your question is on its way."),
		);

		const drawn = text(screen());
		view.dispose();

		assert.match(drawn, /ask_question/);
		assert.match(drawn, /"question": "Which auth module\?"/);
		assert.match(drawn, /Your question is on its way\./);
	});

	it("streams a reply into one component and settles it there, rather than drawing it twice", () => {
		const { view, emit, screen } = inspecting();
		const streaming = assistant([]);
		emit({ type: "message_start", message: streaming } as unknown as JsonAgentSessionEvent);
		emit(delta({ type: "text_start", contentIndex: 0 }), delta({ type: "text_delta", contentIndex: 0, delta: "Half a th" }));

		assert.match(text(screen()), /Half a th/);

		emit(delta({ type: "text_delta", contentIndex: 0, delta: "ought." }));
		emit({ type: "message_end", message: assistant([{ type: "text", text: "Half a thought." }]) } as unknown as JsonAgentSessionEvent);
		const drawn = text(screen());
		view.dispose();

		assert.equal(count(drawn, "Half a thought."), 1);
	});

	it("shows a reply its Run stopped in the middle of as cut off, not as still streaming", () => {
		const { view, emit, screen, transcripts } = inspecting(run("scout", "failed", 5, { stoppedAt: 0 }));
		emit({ type: "message_start", message: assistant([]) } as unknown as JsonAgentSessionEvent);
		emit(delta({ type: "text_start", contentIndex: 0 }), delta({ type: "text_delta", contentIndex: 0, delta: "I was about to" }));
		transcripts.end("scout");

		const drawn = text(screen());
		view.dispose();

		assert.match(drawn, /I was about to/);
		assert.match(drawn, /Operation aborted/);
	});

	it("says there is nothing yet for a Run whose child has not said anything", () => {
		const { view, screen } = inspecting(run("scout", "queued"));

		const drawn = text(screen());
		view.dispose();

		assert.match(drawn, /Nothing yet: scout is waiting for a run slot\./);
	});

	it("follows the tail while at the bottom, and stays where it was put once scrolled up", () => {
		const { view, emit, screen, press } = inspecting(undefined, { rows: 30 });
		for (let index = 1; index <= 30; index++) emit(...settled(user(`message ${index}`)));

		assert.match(text(screen()), /message 30/);
		assert.doesNotMatch(text(screen()), /message 1\b/);

		press(KEY.pageUp);
		emit(...settled(user("message 31")));
		const scrolledUp = screen();
		assert.doesNotMatch(text(scrolledUp), /message 31/, "a person reading back is not dragged down by new output");
		assert.match(scrolledUp.at(-1) ?? "", /↓ \d+ more · pgdn/);

		press(KEY.pageDown, KEY.pageDown, KEY.pageDown);
		emit(...settled(user("message 32")));
		const following = screen();
		view.dispose();

		assert.match(text(following), /message 32/, "back at the bottom, it follows again");
		assert.doesNotMatch(following.at(-1) ?? "", /more/);
	});

	it("is drawn at its share of the terminal, whatever the transcript's length", () => {
		const { view, screen } = inspecting(undefined, { rows: 40 });

		const lines = screen();
		view.dispose();

		assert.equal(lines.length, 36);
	});

	it("hides thinking and expands tool output on their keys", () => {
		const { view, emit, screen, press } = inspecting(undefined, { rows: 70 });
		const output = Array.from({ length: 30 }, (_, index) => `row ${index + 1}`).join("\n");
		emit(
			...settled(assistant([{ type: "thinking", thinking: "Pondering deeply." }, toolCall("t1", "bash", { command: "seq 30" })], "toolUse")),
			...ran("t1", "bash", { command: "seq 30" }, output),
		);

		const before = text(screen());
		press(KEY.ctrlT, KEY.ctrlO);
		const after = text(screen());
		view.dispose();

		assert.match(before, /Pondering deeply\./, "thinking is shown by default, as in pi's chat");
		assert.doesNotMatch(before, /row 1\n/, "tool output is collapsed by default");
		assert.doesNotMatch(after, /Pondering deeply\./);
		assert.match(after, /row 1\b/);
		assert.match(after, /row 30/);
	});
});

describe("the Inspector's editor", () => {
	it("sends what is typed on Enter, and says what became of it", async () => {
		const { view, sent, screen, press } = inspecting();

		press("h", "i", KEY.enter);
		await flush();
		const drawn = text(screen());
		view.dispose();

		assert.deepEqual(sent, [{ name: "scout", text: "hi" }]);
		assert.match(drawn, /Sent to scout, which takes it at its next turn boundary\./);
	});

	it("takes Shift+Enter as a new line rather than a send", () => {
		const { view, sent, screen, press } = inspecting();

		press("a", KEY.shiftEnter, "b");
		const drawn = screen();
		view.dispose();

		assert.deepEqual(sent, []);
		assert.ok(drawn.some((line) => /^│ a\s*│$/.test(line)) && drawn.some((line) => /^│ b\s*│$/.test(line)), text(drawn));
	});

	it("shows a refusal verbatim, and puts the message back for another try", async () => {
		const { view, screen, press } = inspecting(undefined, { outcome: { ok: false, reason: "could not reach scout: rpc: stream closed" } });

		press("h", "i", KEY.enter);
		await flush();
		const drawn = screen();
		view.dispose();

		assert.match(text(drawn), /could not reach scout: rpc: stream closed/);
		assert.ok(
			drawn.some((line) => /^│ hi\s*│$/.test(line)),
			`expected the message back in the editor, got ${text(drawn)}`,
		);
	});

	it("is locked for a finished Run, says why, and sends nothing typed at it", () => {
		const { view, sent, screen, press } = inspecting(run("scout", "done", 5, { stoppedAt: 0 }));

		press("h", "i", KEY.enter);
		const drawn = text(screen());
		view.dispose();

		assert.deepEqual(sent, []);
		assert.match(drawn, /scout is done\. A finished run is read-only: its child is already gone\./);
		assert.doesNotMatch(drawn, /enter send/);
		assert.doesNotMatch(drawn, /ctrl\+x kill/);
	});

	it("is locked for a queued Run, which has no child to talk to yet", () => {
		const { view, screen } = inspecting(run("scout", "queued"));

		const drawn = text(screen());
		view.dispose();

		assert.match(drawn, /scout is queued for a run slot/);
	});

	it("says up front that Enter answers a Waiting Run's question", () => {
		const { view, screen } = inspecting(run("scout", "waiting"));

		const drawn = text(screen());
		view.dispose();

		assert.match(drawn, /scout is waiting on its question: Enter answers it, in place of the parent\./);
	});
});

describe("killing from the Inspector", () => {
	it("asks first, and kills only on y", async () => {
		const { view, killed, screen, press } = inspecting();

		press(KEY.ctrlX);
		assert.match(text(screen()), /Kill scout\? .* y to kill, n to keep it\./);
		press("a", "n");
		assert.deepEqual(killed, [], "a stray key leaves the question standing, and n keeps the Run");
		assert.match(text(screen()), /Kept scout\./);

		press(KEY.ctrlX, "y");
		await flush();
		const drawn = text(screen());
		view.dispose();

		assert.deepEqual(killed, ["scout"]);
		assert.match(drawn, /Killed scout\./);
	});

	it("types nothing into the editor while the question is standing", () => {
		const { view, screen, press } = inspecting();

		press(KEY.ctrlX, "a", KEY.escape);
		const drawn = screen();
		view.dispose();

		assert.ok(!drawn.some((line) => /^│ a\s*│$/.test(line)), text(drawn));
	});

	it("has nothing to kill on a finished Run, and says so instead of asking", () => {
		const { view, killed, screen, press } = inspecting(run("scout", "done", 5, { stoppedAt: 0 }));

		press(KEY.ctrlX, "y");
		const drawn = text(screen());
		view.dispose();

		assert.deepEqual(killed, []);
		assert.match(drawn, /Nothing to kill: scout has already finished\./);
	});
});

describe("a tool's clock in the Inspector", () => {
	it("times a command it watched start, as pi's chat does", () => {
		const { view, emit, screen } = inspecting();
		screen();

		emit(...running("t1", "bash", { command: "sleep 5" }, "partial"));
		const whileRunning = text(screen());
		emit({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		} as unknown as JsonAgentSessionEvent);
		const ended = text(screen());
		view.dispose();

		assert.match(whileRunning, /Elapsed \d+\.\ds/);
		assert.match(ended, /Took \d+\.\ds/);
	});

	it("draws no time for a command that had already ended when it was first drawn, as pi's history does", () => {
		const { view, emit, screen } = inspecting();
		emit(
			...settled(assistant([toolCall("t1", "bash", { command: "sleep 5" })], "toolUse")),
			...ran("t1", "bash", { command: "sleep 5" }, "done"),
		);

		const drawn = text(screen());
		view.dispose();

		assert.match(drawn, /\$ sleep 5/);
		assert.doesNotMatch(drawn, /Took|Elapsed/, "a duration stamped at the moment it was looked at is one it never had");
	});

	it("draws no clock for a command already running when the Inspector opened, rather than one counting from then", () => {
		const { view, emit, screen } = inspecting();
		emit(...running("t1", "bash", { command: "sleep 100" }, "partial"));

		const drawn = text(screen());
		view.dispose();

		assert.match(drawn, /partial/);
		assert.doesNotMatch(drawn, /Took|Elapsed/);
	});
});

describe("the Inspector's lifecycle", () => {
	it("goes back on Escape", () => {
		const { view, press, closed } = inspecting();

		press(KEY.escape);
		view.dispose();

		assert.equal(closed(), 1);
	});

	it("redraws when its own Run's transcript changes, and not for another Run's", () => {
		const { view, tui, emit, transcripts } = inspecting();
		transcripts.start("worker");
		const before = tui.renders;

		transcripts.observe("worker", settled(user("elsewhere"))[1]);
		assert.equal(tui.renders, before);
		emit(...settled(user("here")));
		view.dispose();

		assert.equal(tui.renders, before + 1);
	});

	it("stops redrawing once it is closed", () => {
		const { view, tui, emit } = inspecting();
		view.dispose();
		const before = tui.renders;

		emit(...settled(user("after closing")));

		assert.equal(tui.renders, before);
	});

	it("leaves no clock ticking behind for a command still running when it closed", (context) => {
		// pi's bash renderer ticks a running command's elapsed time on an interval
		// of its own, which only a final result stops.
		context.mock.timers.enable({ apis: ["setInterval"] });
		const { view, tui, emit, screen } = inspecting();
		screen();
		emit(...running("t1", "bash", { command: "sleep 100" }, "partial"));
		screen();
		const opened = tui.renders;
		context.mock.timers.tick(3000);
		assert.ok(tui.renders > opened, "the clock was ticking while the Inspector was open");

		view.dispose();
		const before = tui.renders;
		context.mock.timers.tick(10_000);

		assert.equal(tui.renders, before, "nothing asks for a redraw of a view that has gone");
	});
});

describe("the picker, drawn", () => {
	/** A picker over `runs`, recording what it closed with. */
	function picking(runs: Run[], initial?: string) {
		const transcripts = new Transcripts();
		const tui = fakeTui();
		const chosen: (string | undefined)[] = [];
		const session = { runs: () => runs, transcripts, control: recordingControl().control, now: () => 0 };
		const view = new PickerView(tui as unknown as OverlayTui, PLAIN, session, initial, (name) => {
			chosen.push(name);
		});
		return { view, chosen, screen: () => view.render(70).map((line) => stripTerminalSequences(line)) };
	}

	it("lists every Run in a frame, the selected one marked", () => {
		const { view, screen } = picking([run("scout", "running", 5), run("worker", "done", 9, { stoppedAt: 0 })]);

		const lines = screen();
		view.dispose();

		assert.match(lines[0], /^╭─ Subagent runs ─+ 1 active · 1 finished ─╮$/);
		assert.match(lines[1], /^│ › 00:05  scout   running\s+│$/);
		assert.match(lines[2], /^│   00:09  worker  done\s+│$/);
		assert.match(lines[3], /^╰─ ↑↓ move · enter inspect · esc close ─+╯$/);
		assert.ok(
			lines.every((line) => [...line].length === 70),
			"the frame is square",
		);
	});

	it("moves with Up and Down, and opens the selected Run on Enter", () => {
		const { view, chosen } = picking([run("scout", "running"), run("worker", "running"), run("fixer", "running")]);

		view.handleInput(KEY.down);
		view.handleInput(KEY.down);
		view.handleInput(KEY.up);
		view.handleInput(KEY.enter);
		view.dispose();

		assert.deepEqual(chosen, ["worker"]);
	});

	it("starts on the Run that was last open, so going back lands where it left", () => {
		const { view, screen } = picking([run("scout", "running"), run("worker", "running")], "worker");

		const lines = screen();
		view.dispose();

		assert.match(lines[2], /^│ › /);
	});

	it("closes on Escape with nothing chosen", () => {
		const { view, chosen } = picking([run("scout", "running")]);

		view.handleInput(KEY.escape);
		view.dispose();

		assert.deepEqual(chosen, [undefined]);
	});
});
