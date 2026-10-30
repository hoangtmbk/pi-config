/**
 * `/subagents`: the picker, and the Inspector it opens on one Run.
 *
 * The widget says *that* a Run is busy; this shows *what* it is doing, and lets
 * a person talk to it. The picker lists every Run this session in the widget's
 * columns; choosing one opens the Inspector — that Run's live transcript, drawn
 * by pi's own message components and pi's own renderers for the built-in tools,
 * with an editor along the bottom for steering it.
 *
 * Split the way the rest of the extension is. What a reader sees and what a key
 * does are decided by small pure functions at the top of this file — the order
 * Runs are listed in, the reason an editor is locked, which action a keypress
 * is, where a scrolled view sits — so they are asserted by calling them rather
 * than by driving a terminal. Below them is the glue that hands those decisions
 * to pi's TUI, kept as thin as pi's components allow.
 *
 * Nothing here reaches a child or the Supervisor. The transcript comes from
 * `transcript.ts`, which is fed by `index.ts`; a steer and a kill go out through
 * the `RunControl` that `index.ts` builds, which decides what a message means
 * by the Run's state at the moment it is sent. This file only decides what to
 * say about the answer.
 *
 * Overlays get every key, pi's own bindings included, so the keys here are all
 * this file's: Escape is not "abort" but "back", and Enter in the Inspector is
 * the editor's. The one thing that has to be won from the editor is PgUp/PgDn,
 * which it would otherwise spend scrolling its own few lines — so they are
 * routed before it sees anything.
 */

import {
	AssistantMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	CustomMessageComponent,
	type ExtensionCommandContext,
	getMarkdownTheme,
	getSelectListTheme,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Editor,
	type Focusable,
	Key,
	matchesKey,
	type OverlayOptions,
	Spacer,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { RunControl, SendOutcome } from "./control.ts";
import type { Run } from "./supervisor.ts";
import type { AgentMessage, AssistantMessage, ToolExecution, Transcripts, TranscriptSnapshot } from "./transcript.ts";
import { age, clip, oneLine, runRows } from "./widget.ts";

/** What the picker and the Inspector read, and act through. */
export interface InspectorSession {
	/** Every Run this session has started, in the order they were asked for. */
	runs(): Run[];
	/** Every Run's transcript, recorded from the moment it was asked for. */
	transcripts: Transcripts;
	/** What a human can do to a Run directly. */
	control: RunControl;
	/**
	 * What time it is, in milliseconds, for the ages the overlays show. Defaults
	 * to the wall clock; injected by tests, so an age can be asserted exactly.
	 */
	now?: () => number;
}

/**
 * How much of the terminal the Inspector takes, as a percentage either way.
 *
 * Most of it — a transcript is long and wide, and this is the one place a person
 * has asked to read one — but not all of it, so the conversation the Run belongs
 * to still shows around the edges and the overlay reads as on top of something.
 */
const INSPECTOR_SIZE = 90;

const INSPECTOR_OVERLAY: OverlayOptions = {
	width: `${INSPECTOR_SIZE}%`,
	maxHeight: `${INSPECTOR_SIZE}%`,
	anchor: "center",
};

/**
 * How much of the terminal's height the picker may take at most, as a
 * percentage. It is only as tall as its Runs need, up to this.
 */
const PICKER_SIZE = 80;

const PICKER_OVERLAY: OverlayOptions = {
	width: "70%",
	minWidth: 50,
	maxHeight: `${PICKER_SIZE}%`,
	anchor: "center",
};

/**
 * The fewest rows the Inspector is drawn in, however short the terminal.
 *
 * A frame, a line of transcript, the editor's three and the lines under it.
 * Below that there is no Inspector worth drawing, and pi clips what overflows.
 */
const MIN_INSPECTOR_HEIGHT = 9;

/**
 * How often the open overlays redraw on their own.
 *
 * The transcript redraws the Inspector the moment it changes, so this exists
 * for what nothing announces: the elapsed readings, and a Run's state moving on
 * a settle that changed nothing in its transcript. The widget ticks at the same
 * rate for the same reason.
 */
const TICK_MS = 1000;

/** Between the parts of the Inspector's header. */
const DOT = " · ";

/** What marks the picker's current row, and the blank that lines the others up with it. */
const POINTER = "› ";
const NO_POINTER = "  ";

/** Whether a Run has stopped for good: done or failed, its child gone. */
function isFinished(run: Run): boolean {
	return run.state === "done" || run.state === "failed";
}

/**
 * The Runs in the order the picker lists them: the active ones first, in the
 * order they were asked for, then the finished ones, the most recently finished
 * first.
 *
 * Active first because those are the ones a person can still do something to,
 * and in the widget's order so a Run seen above the editor is in the same place
 * here. Finished newest-first because the Run that has just come back is the
 * one most likely to be looked at, and a session's oldest Runs are the ones
 * least likely to be. Runs that stopped in the same instant — a shutdown ends
 * them all at once — keep newest-first by when they were asked for.
 */
export function pickerOrder(runs: readonly Run[]): Run[] {
	const active = runs.filter((run) => !isFinished(run));
	// Reversed before sorting, so the stable sort leaves a tie newest-asked first.
	const finished = runs
		.filter(isFinished)
		.reverse()
		.sort((a, b) => (b.stoppedAt ?? 0) - (a.stoppedAt ?? 0));
	return [...active, ...finished];
}

/** One row of the picker: the Run it opens, and what it says. */
export interface PickerRow {
	name: string;
	text: string;
}

/**
 * The picker's rows, in order, each at most `width` columns: the widget's own
 * columns, so a Run reads the same in both.
 */
export function pickerRows(runs: readonly Run[], now: number, width: number): PickerRow[] {
	const ordered = pickerOrder(runs);
	const texts = runRows(ordered, now, width);
	return ordered.map((run, index) => ({ name: run.name, text: texts[index] }));
}

/**
 * The picker's tally: how many Runs are still going and how many have
 * finished, said in that order because the first number is the one that can
 * still change.
 */
export function pickerTally(runs: readonly Run[]): string {
	const finished = runs.filter(isFinished).length;
	return `${runs.length - finished} active · ${finished} finished`;
}

/**
 * The Run the selection lands on after moving `by` rows from `selected`, kept
 * inside the list.
 *
 * By name rather than by index, because the list moves under it: a Run that
 * finishes jumps from the active group to the top of the finished one, and a
 * selection held as an index would silently move to whichever Run took its
 * place. A name the list no longer holds — or none yet — counts as the first
 * row, which is the row drawn as selected in that case.
 */
export function moveSelection(names: readonly string[], selected: string | undefined, by: number): string | undefined {
	if (names.length === 0) return undefined;
	const from = Math.max(0, selected === undefined ? 0 : names.indexOf(selected));
	return names[Math.max(0, Math.min(names.length - 1, from + by))];
}

/** What a key does in the picker. */
export type PickerKey = "up" | "down" | "open" | "close";

/** The picker's whole key map. Anything else does nothing. */
export function pickerKey(data: string): PickerKey | undefined {
	if (matchesKey(data, Key.up)) return "up";
	if (matchesKey(data, Key.down)) return "down";
	if (matchesKey(data, Key.enter)) return "open";
	if (matchesKey(data, Key.escape)) return "close";
	return undefined;
}

/**
 * Why a Run cannot be written to right now, in one line — or nothing, for a Run
 * that can.
 *
 * Only a running Run and a Waiting one have a child that will read anything.
 * The line says so in terms of the Run rather than the editor, because "why can
 * I not type here" is answered by what the Run is, not by what the box is.
 */
export function lockReason(run: Run): string | undefined {
	switch (run.state) {
		case "running":
		case "waiting":
			return undefined;
		case "queued":
			return `${run.name} is queued for a run slot: it has no child to talk to until it starts.`;
		case "done":
			return `${run.name} is done. A finished run is read-only: its child is already gone.`;
		case "failed":
			return `${run.name} failed. A finished run is read-only: its child is already gone.`;
	}
}

/**
 * What sending would do to a Run that can be written to, said before anything
 * is sent — the line the status shows while there is nothing else to say.
 *
 * Said up front because the same Enter means two different things: a running
 * Run takes the message as a steer, and a Waiting one takes it as the answer to
 * its Question, in place of the parent.
 */
export function sendHint(run: Run): string | undefined {
	if (run.state === "running") return `Enter sends ${run.name} a steer, which it takes at its next turn boundary.`;
	if (run.state === "waiting") return `${run.name} is waiting on its question: Enter answers it, in place of the parent.`;
	return undefined;
}

/** What became of a message the Inspector sent, in the line the status shows. */
export function sentLine(name: string, outcome: SendOutcome): string {
	if (!outcome.ok) return outcome.reason;
	if (outcome.as === "answer") return `Answered ${name}'s question; it has resumed. The parent has been told.`;
	return `Sent to ${name}, which takes it at its next turn boundary. The parent has been told.`;
}

/** Whether a Run still has something a kill would end: a child, or a place in the queue. */
export function isKillable(run: Run): boolean {
	return run.state === "queued" || run.state === "running" || run.state === "waiting";
}

/** What a key does in the Inspector. */
export type InspectorKey =
	| "back"
	| "scroll-up"
	| "scroll-down"
	| "toggle-tools"
	| "toggle-thinking"
	| "kill"
	| "confirm-kill"
	| "cancel-kill"
	| "edit"
	| "ignore";

/**
 * The Inspector's whole key map: which action a keypress is, given whether a
 * kill is waiting on its y/n and whether the editor is open.
 *
 * The order is the point. A pending confirmation takes every key first, so a
 * stray keystroke can neither kill a Run nor leak into the editor; anything but
 * y or n leaves the question standing. Then the Inspector's own keys, ahead of
 * the editor, which would otherwise spend PgUp/PgDn on its own few lines. What
 * is left is typing, and goes to the editor — Enter to send and Shift+Enter for
 * a new line are the editor's own — or nowhere, when it is locked.
 */
export function inspectorKey(data: string, mode: { confirming: boolean; editable: boolean }): InspectorKey {
	if (mode.confirming) {
		// Matched as keys rather than compared as characters, so the answer is
		// read the same whichever way the terminal encodes a letter.
		if (matchesKey(data, "y") || matchesKey(data, "shift+y")) return "confirm-kill";
		if (matchesKey(data, "n") || matchesKey(data, "shift+n") || matchesKey(data, Key.escape)) return "cancel-kill";
		return "ignore";
	}
	if (matchesKey(data, Key.escape)) return "back";
	if (matchesKey(data, Key.pageUp)) return "scroll-up";
	if (matchesKey(data, Key.pageDown)) return "scroll-down";
	if (matchesKey(data, Key.ctrl("o"))) return "toggle-tools";
	if (matchesKey(data, Key.ctrl("t"))) return "toggle-thinking";
	if (matchesKey(data, Key.ctrl("x"))) return "kill";
	return mode.editable ? "edit" : "ignore";
}

/**
 * The keys the Inspector offers for a Run, in the order the line along its
 * bottom lists them.
 *
 * Only the keys that would do something: a locked editor has nothing to send,
 * and a finished Run has nothing to kill.
 */
export function inspectorHints(run: Run): string[] {
	const hints = lockReason(run) ? [] : ["enter send", "shift+enter newline"];
	hints.push("pgup/pgdn scroll", "ctrl+o tools", "ctrl+t thinking");
	if (isKillable(run)) hints.push("ctrl+x kill");
	hints.push("esc back");
	return hints;
}

/**
 * Hints packed into as few lines of at most `width` columns as they fit in,
 * never splitting one.
 *
 * Wrapped rather than clipped, because the key a clipped line loses is the last
 * one — and the last one is how to get out.
 */
export function packHints(hints: readonly string[], width: number): string[] {
	const lines: string[] = [];
	for (const hint of hints) {
		const last = lines.length - 1;
		const joined = last >= 0 ? `${lines[last]}${DOT}${hint}` : hint;
		if (last >= 0 && visibleWidth(joined) <= width) lines[last] = joined;
		else lines.push(hint);
	}
	return lines;
}

/** The Inspector's header: which Run, of which Agent, where it is, and for how long. */
export function inspectorHeader(run: Run, now: number): string {
	return [oneLine(run.name), run.agent, run.state, age(run, now)].join(DOT);
}

/**
 * Where a scrolled transcript sits: the first line in view, and whether it is
 * following the tail.
 *
 * Following is a mode, not a position: a view at the bottom stays at the bottom
 * as the transcript grows under it, and a view scrolled up stays where it was
 * put, so a person reading back is not dragged down by every token the Run
 * streams. Scrolling back to the bottom is what turns following on again.
 */
export interface Scroll {
	top: number;
	follow: boolean;
}

/** The first line in view, for a transcript `total` lines long in a view `height` lines tall. */
export function viewTop(scroll: Scroll, total: number, height: number): number {
	const bottom = Math.max(0, total - height);
	return scroll.follow ? bottom : Math.max(0, Math.min(scroll.top, bottom));
}

/**
 * The view after scrolling `by` lines — up for negative — kept inside the
 * transcript, following again once it is back at the bottom.
 */
export function scrolled(scroll: Scroll, by: number, total: number, height: number): Scroll {
	const bottom = Math.max(0, total - height);
	const top = Math.max(0, Math.min(bottom, viewTop(scroll, total, height) + by));
	return { top, follow: top >= bottom };
}

/** How far PgUp/PgDn move a view `height` lines tall: a page, less a line kept for context. */
export function pageOf(height: number): number {
	return Math.max(1, height - 1);
}

/** How pi draws a tool: a definition with renderers, or nothing for its generic view. */
type ToolRenderer = ConstructorParameters<typeof ToolExecutionComponent>[4];

/**
 * The TUI an overlay is handed, typed as pi's own components want it.
 *
 * Read off pi's API rather than imported from pi-tui, because a checkout can
 * hold two copies of pi-tui — the one this package resolves as a peer, and the
 * one pi itself depends on — and pi's components are typed against the second.
 * At runtime there is only one: pi hands an extension its own pi-tui.
 */
type OverlayTui = ConstructorParameters<typeof ToolExecutionComponent>[5];

/**
 * pi's built-in tools, each with the definition its own chat draws it from.
 *
 * Only these. Any other tool a Run uses — `ask_question`, or whatever an Agent
 * is allowed — has no renderer here and gets pi's generic view: its name, its
 * arguments and its output, which is everything there is to know about it.
 */
const BUILT_IN_TOOLS = new Map<string, (cwd: string) => ToolRenderer>([
	["read", createReadToolDefinition],
	["bash", createBashToolDefinition],
	["edit", createEditToolDefinition],
	["write", createWriteToolDefinition],
	["grep", createGrepToolDefinition],
	["find", createFindToolDefinition],
	["ls", createLsToolDefinition],
]);

/**
 * pi's OSC 133 marks, which its message components wrap themselves in.
 *
 * They tell a terminal where a prompt starts and ends in its scrollback, which
 * is what lets it jump between them. An overlay is not scrollback, and marks
 * drawn into one would hand the terminal prompts that are not there.
 */
const ZONE_MARK = /\x1b\]133;[A-Z]\x07/g;

/** One tool call as drawn, and how far its component has been brought up to date. */
interface DrawnTool {
	component: ToolExecutionComponent;
	/** The arguments the component was last handed. */
	args: unknown;
	/** Whether its call has been settled: told the arguments are final, or that it never ran. */
	settled: boolean;
	/**
	 * Whether this tool's execution has been seen: the first sight of it is what
	 * decides whether the component is told it started. See `TranscriptView.execute`.
	 */
	started: boolean;
	/** The execution's result as the component last saw it, and what it said about it. */
	result?: ToolExecution["result"];
	running?: boolean;
	isError?: boolean;
}

/**
 * A Run's transcript as a tree of pi's chat components, brought up to date from
 * its snapshot.
 *
 * Incremental, the way pi's own chat is: a snapshot only ever grows, so a
 * message drawn once is never drawn again, and a streaming reply keeps its one
 * component from first token to last rather than being rebuilt per token. What
 * is drawn follows pi's chat exactly — a user message, an assistant message
 * followed by a component per tool call, a tool's result shown inside its call
 * rather than as a message of its own.
 */
class TranscriptView {
	readonly root = new Container();
	private snapshot?: TranscriptSnapshot;
	private version = -1;
	/** How many of the snapshot's settled messages have been drawn. */
	private drawn = 0;
	private streaming?: AssistantMessageComponent;
	private readonly assistants: AssistantMessageComponent[] = [];
	private readonly customs: CustomMessageComponent[] = [];
	private readonly tools = new Map<string, DrawnTool>();
	private readonly renderers = new Map<string, ToolRenderer>();
	private expanded = false;
	private hideThinking = false;

	constructor(
		private readonly tui: OverlayTui,
		private readonly cwd: string,
	) {}

	/** Whether there is nothing drawn yet — a Run whose child has said nothing so far. */
	isEmpty(): boolean {
		return this.root.children.length === 0;
	}

	/**
	 * Bring the drawing up to date with a snapshot. Cheap when nothing changed:
	 * the snapshot's version is compared before anything else is looked at.
	 */
	sync(snapshot: TranscriptSnapshot | undefined): void {
		if (!snapshot) return;
		// A Run started over has a new snapshot, and nothing drawn from the old one
		// belongs in front of it.
		if (snapshot !== this.snapshot) this.reset(snapshot);
		if (snapshot.version === this.version) return;
		// The first drawing of a snapshot is of things that happened before anyone
		// was looking, and a tool already under way in it started at a moment this
		// view never saw.
		const opening = this.version === -1;
		this.version = snapshot.version;

		while (this.drawn < snapshot.messages.length) this.settle(snapshot.messages[this.drawn++], snapshot);
		if (snapshot.streaming) this.stream(snapshot.streaming, snapshot);
		for (const [toolCallId, tool] of this.tools) this.execute(tool, snapshot.tools.get(toolCallId), opening);
	}

	/**
	 * Tell every tool still drawn as running that it has ended, for a view that
	 * is going away.
	 *
	 * Not cosmetic. pi's bash renderer keeps a one-second interval going for as
	 * long as its result is partial, to tick the elapsed time, and clears it only
	 * when it is handed a final one — so a view closed on a running command would
	 * otherwise leave that interval behind, waking the TUI every second for the
	 * rest of the session over a component nothing will ever draw again. A final
	 * result is the one thing the renderer stops it for, so that is what it is
	 * handed: what the tool had produced so far, not an error, since nothing about
	 * the tool itself went wrong.
	 */
	dispose(): void {
		for (const tool of this.tools.values()) {
			if (!tool.running) continue;
			tool.running = false;
			tool.component.updateResult({ ...(tool.result ?? { content: [] }), isError: false }, false);
		}
	}

	/** Expand or collapse every tool's output, and every one drawn from here on. */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const tool of this.tools.values()) tool.component.setExpanded(expanded);
		for (const custom of this.customs) custom.setExpanded(expanded);
	}

	/** Hide or show every thinking block, and every one drawn from here on. */
	setHideThinking(hide: boolean): void {
		this.hideThinking = hide;
		for (const assistant of this.assistants) assistant.setHideThinkingBlock(hide);
	}

	private reset(snapshot: TranscriptSnapshot): void {
		this.root.clear();
		this.snapshot = snapshot;
		this.version = -1;
		this.drawn = 0;
		this.streaming = undefined;
		this.assistants.length = 0;
		this.customs.length = 0;
		this.tools.clear();
	}

	/** Draw one settled message. */
	private settle(message: AgentMessage, snapshot: TranscriptSnapshot): void {
		switch (message.role) {
			case "user": {
				const text = userText(message);
				if (!text) return;
				if (!this.isEmpty()) this.root.addChild(new Spacer(1));
				this.root.addChild(new UserMessageComponent(text, getMarkdownTheme()));
				return;
			}
			case "assistant": {
				// The reply that was streaming is this one, settled: the same component
				// takes its final form, rather than a second copy appearing under it.
				const component = this.streaming ?? this.assistant();
				this.streaming = undefined;
				component.updateContent(message, false);
				this.calls(message, false, snapshot);
				return;
			}
			case "custom": {
				if (!message.display) return;
				const component = new CustomMessageComponent(message, undefined, getMarkdownTheme());
				component.setExpanded(this.expanded);
				this.customs.push(component);
				this.root.addChild(component);
				return;
			}
			default:
				// A tool result is drawn inside its call, from `tools`, the way pi's own
				// chat draws it. The other kinds are pi's bookkeeping around a
				// conversation — a `!` command, a summary — rather than anything a Run's
				// child is asked or says.
				return;
		}
	}

	/** Draw the reply that is still streaming, as far as it has got. */
	private stream(message: AssistantMessage, snapshot: TranscriptSnapshot): void {
		this.streaming ??= this.assistant();
		this.streaming.updateContent(message, true);
		this.calls(message, true, snapshot);
	}

	private assistant(): AssistantMessageComponent {
		const component = new AssistantMessageComponent(undefined, this.hideThinking, getMarkdownTheme());
		this.assistants.push(component);
		this.root.addChild(component);
		return component;
	}

	/**
	 * Draw an assistant message's tool calls, each under the message, the way pi
	 * does: a call shows from the moment it starts streaming, its arguments filled
	 * in as they arrive.
	 */
	private calls(message: AssistantMessage, streaming: boolean, snapshot: TranscriptSnapshot): void {
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			let tool = this.tools.get(part.id);
			if (!tool) {
				const component = new ToolExecutionComponent(
					part.name,
					part.id,
					part.arguments,
					// Images are drawn by escape sequences placed at an absolute position
					// on screen, which an overlay composited over the chat cannot promise.
					{ showImages: false },
					this.renderer(part.name),
					this.tui,
					this.cwd,
				);
				component.setExpanded(this.expanded);
				tool = { component, args: part.arguments, settled: false, started: false };
				this.tools.set(part.id, tool);
				this.root.addChild(component);
			} else if (tool.args !== part.arguments) {
				tool.args = part.arguments;
				tool.component.updateArgs(part.arguments);
			}

			if (streaming || tool.settled) continue;
			tool.settled = true;
			// A reply cut off before its tool calls ran says so on each of them, as
			// pi's chat does; one whose call did run is drawn from its execution.
			if ((message.stopReason === "aborted" || message.stopReason === "error") && !snapshot.tools.has(part.id)) {
				const why = message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error");
				tool.component.updateResult({ content: [{ type: "text", text: why }], isError: true });
			} else {
				tool.component.setArgsComplete();
			}
		}
	}

	/**
	 * Bring a drawn tool up to date with its execution, if it has one yet.
	 *
	 * Telling the component its execution started is what starts the clock pi's
	 * bash renderer draws under a command — "Elapsed" while it runs, "Took" once
	 * it ends — and the renderer reads that clock off the moment it is told. So it
	 * is told only for an execution this view saw start, give or take a frame:
	 * one that is running on its first sight and was not already there when the
	 * view opened. The other two are left untold, which draws no time at all.
	 *
	 * A tool that had already ended is drawn the way pi's chat draws its history
	 * on a resumed session, which never tells one: a "Took 0.0s" stamped at the
	 * moment it was looked at would be a duration it never had. A tool already
	 * running when the view opened is the case pi gives no good answer to. Its
	 * real start is a moment the renderer cannot be handed — the clock lives in
	 * its private state — so the choice is between no clock and one counting from
	 * when the Inspector opened, which would say a command an hour in had just
	 * started. No clock is the one that says nothing false.
	 */
	private execute(tool: DrawnTool, execution: ToolExecution | undefined, opening: boolean): void {
		if (!execution) return;
		if (!tool.started) {
			tool.started = true;
			if (execution.running && !opening) tool.component.markExecutionStarted();
		}
		if (execution.result === tool.result && execution.running === tool.running && execution.isError === tool.isError) return;
		tool.result = execution.result;
		tool.running = execution.running;
		tool.isError = execution.isError;
		if (execution.result) {
			tool.component.updateResult({ ...execution.result, isError: execution.isError }, execution.running);
		} else if (!execution.running) {
			// Ended without reporting anything — a child that died mid-tool. Drawn as
			// ended rather than left looking like it is still running.
			const text = execution.isError ? "The run stopped before this finished." : "";
			tool.component.updateResult({ content: text ? [{ type: "text", text }] : [], isError: execution.isError });
		}
	}

	private renderer(toolName: string): ToolRenderer {
		const make = BUILT_IN_TOOLS.get(toolName);
		if (!make) return undefined;
		let renderer = this.renderers.get(toolName);
		if (!renderer) {
			renderer = make(this.cwd);
			this.renderers.set(toolName, renderer);
		}
		return renderer;
	}
}

/** A user message's text, the way pi's chat reads it: every text part, images left out. */
function userText(message: Extract<AgentMessage, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The part of pi's theme the overlays' own chrome is drawn with. */
export type Chrome = Pick<Theme, "fg" | "bold">;

/** A line inside a frame `width` columns wide, borders included. */
function framed(chrome: Chrome, line: string, width: number): string {
	const inner = Math.max(0, width - 2);
	return `${chrome.fg("border", "│")}${truncateToWidth(line, inner, "", true)}${chrome.fg("border", "│")}`;
}

/** A frame's top or bottom edge, with a label set into it on the left and one on the right. */
function edge(chrome: Chrome, corners: [string, string], width: number, left: string, right = ""): string {
	const inner = Math.max(0, width - 2);
	// Clipped as plain text, before any colour goes on, so the count is of what shows.
	const leftLabel = left ? ` ${clip(left, Math.max(0, inner - 3))} ` : "";
	const rightLabel = right && visibleWidth(leftLabel) + visibleWidth(right) + 4 <= inner ? ` ${right} ` : "";
	const fill = Math.max(0, inner - 1 - visibleWidth(leftLabel) - visibleWidth(rightLabel) - (rightLabel ? 1 : 0));
	return [
		chrome.fg("border", `${corners[0]}─`),
		chrome.fg("accent", leftLabel),
		chrome.fg("border", "─".repeat(fill)),
		chrome.fg("dim", rightLabel),
		chrome.fg("border", `${rightLabel ? "─" : ""}${corners[1]}`),
	].join("");
}

/**
 * The picker: one row per Run this session, live, and Enter to open one.
 *
 * Its own small list rather than pi's `SelectList`, which takes its items once:
 * the rows here move while they are on screen — a Run starts, settles, picks up
 * a tool — and the list is rebuilt from the Runs on every draw instead.
 */
export class PickerView implements Component {
	private selected?: string;
	/** The first row in view, for a session with more Runs than fit. */
	private offset = 0;
	private readonly ticking: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: OverlayTui,
		private readonly chrome: Chrome,
		private readonly session: InspectorSession,
		initial: string | undefined,
		private readonly done: (name: string | undefined) => void,
	) {
		this.selected = initial;
		this.ticking = setInterval(() => this.tui.requestRender(), TICK_MS);
		// An overlay's clock is never a reason for a process to stay up.
		this.ticking.unref();
	}

	render(width: number): string[] {
		const runs = this.session.runs();
		const inner = Math.max(1, width - 2);
		const rows = pickerRows(runs, (this.session.now ?? Date.now)(), Math.max(1, inner - 2 - POINTER.length));
		const maxRows = Math.max(1, Math.floor((this.tui.terminal.rows * PICKER_SIZE) / 100) - 2);
		const visible = Math.min(rows.length, maxRows);

		const index = Math.max(0, rows.findIndex((row) => row.name === this.selected));
		if (index < this.offset) this.offset = index;
		if (index >= this.offset + visible) this.offset = index - visible + 1;
		this.offset = Math.max(0, Math.min(this.offset, rows.length - visible));

		const lines = [edge(this.chrome, ["╭", "╮"], width, "Subagent runs", pickerTally(runs))];
		for (let row = this.offset; row < this.offset + visible; row++) {
			const current = row === index;
			const text = `${current ? POINTER : NO_POINTER}${rows[row].text}`;
			lines.push(framed(this.chrome, ` ${current ? this.chrome.fg("accent", this.chrome.bold(text)) : text}`, width));
		}
		const more = rows.length > visible ? `${index + 1}/${rows.length}` : "";
		lines.push(edge(this.chrome, ["╰", "╯"], width, "↑↓ move · enter inspect · esc close", more));
		return lines;
	}

	handleInput(data: string): void {
		const key = pickerKey(data);
		if (!key) return;
		const names = pickerOrder(this.session.runs()).map((run) => run.name);
		if (key === "close") return this.done(undefined);
		if (key === "open") return this.done(moveSelection(names, this.selected, 0));
		this.selected = moveSelection(names, this.selected, key === "up" ? -1 : 1);
		this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.ticking);
	}
}

/** A line under the editor, and the colour it is said in. */
interface Status {
	text: string;
	tone: "dim" | "success" | "warning";
}

/**
 * The Inspector: one Run's live transcript, an editor to steer it with, and a
 * key to kill it.
 *
 * Drawn to a fixed height — its share of the terminal — because the transcript
 * scrolls inside it rather than growing it: an overlay that grew with every
 * token would jump about the screen until it hit pi's clip.
 *
 * Focusable for the editor's sake. pi puts the terminal's cursor where a
 * focused component draws its marker, which is what an input method places its
 * candidate window by, and the editor only draws one while it is told it has
 * focus — so being told is passed straight on to it.
 */
export class InspectorView implements Component, Focusable {
	private readonly editor: Editor;
	private readonly transcript: TranscriptView;
	private scroll: Scroll = { top: 0, follow: true };
	/** The transcript's length and the view's height as last drawn, for a key to scroll against. */
	private lastTotal = 0;
	private lastHeight = 1;
	private confirming = false;
	private status?: Status;
	private expanded = false;
	private hideThinking = false;
	private closed = false;
	private hasFocus = false;
	private readonly unsubscribe: () => void;
	private readonly ticking: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: OverlayTui,
		private readonly chrome: Chrome,
		private readonly session: InspectorSession,
		private readonly name: string,
		cwd: string,
		private readonly done: () => void,
	) {
		this.transcript = new TranscriptView(tui, cwd);
		this.editor = new Editor(tui, { borderColor: (text) => chrome.fg("borderMuted", text), selectList: getSelectListTheme() }, { paddingX: 1 });
		this.editor.onSubmit = (text) => this.send(text);
		// Redrawn on the next frame rather than here: a streaming reply changes its
		// transcript per token, and drawing is what folds a burst of them into one.
		this.unsubscribe = session.transcripts.onChange((changed) => {
			if (changed === this.name) this.tui.requestRender();
		});
		this.ticking = setInterval(() => this.tui.requestRender(), TICK_MS);
		this.ticking.unref();
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(value: boolean) {
		this.hasFocus = value;
		this.editor.focused = value;
	}

	render(width: number): string[] {
		const run = this.run();
		const inner = Math.max(1, width - 2);
		const height = Math.max(MIN_INSPECTOR_HEIGHT, Math.floor((this.tui.terminal.rows * INSPECTOR_SIZE) / 100));

		const lock = run ? lockReason(run) : `There is no run named ${this.name} in this session.`;
		const bottom = lock ? [this.chrome.fg("borderMuted", "─".repeat(inner)), ` ${this.chrome.fg("muted", lock)}`] : this.editor.render(inner);
		const status = this.statusLine(run);
		const hints = packHints(run ? inspectorHints(run) : ["esc back"], Math.max(1, inner - 2)).map((line) => ` ${this.chrome.fg("dim", line)}`);
		const bodyHeight = Math.max(1, height - 2 - bottom.length - 1 - hints.length);

		this.transcript.sync(this.session.transcripts.get(this.name));
		const body = this.transcript.isEmpty()
			? ["", ` ${this.chrome.fg("dim", run?.state === "queued" ? `Nothing yet: ${this.name} is waiting for a run slot.` : "Nothing yet.")}`]
			: this.transcript.root.render(inner).map((line) => line.replace(ZONE_MARK, ""));
		this.lastTotal = body.length;
		this.lastHeight = bodyHeight;
		const top = viewTop(this.scroll, body.length, bodyHeight);
		const view = body.slice(top, top + bodyHeight);
		while (view.length < bodyHeight) view.push("");
		const below = body.length - top - view.length;

		return [
			edge(this.chrome, ["╭", "╮"], width, run ? inspectorHeader(run, (this.session.now ?? Date.now)()) : this.name),
			...view.map((line) => framed(this.chrome, line, width)),
			...bottom.map((line) => framed(this.chrome, line, width)),
			framed(this.chrome, status, width),
			...hints.map((line) => framed(this.chrome, line, width)),
			edge(this.chrome, ["╰", "╯"], width, "", below > 0 ? `↓ ${below} more · pgdn` : ""),
		];
	}

	handleInput(data: string): void {
		const run = this.run();
		const action = inspectorKey(data, { confirming: this.confirming, editable: run !== undefined && lockReason(run) === undefined });
		switch (action) {
			case "ignore":
				return;
			case "back":
				return this.done();
			case "scroll-up":
			case "scroll-down": {
				const page = pageOf(this.lastHeight);
				this.scroll = scrolled(this.scroll, action === "scroll-up" ? -page : page, this.lastTotal, this.lastHeight);
				break;
			}
			case "toggle-tools":
				this.expanded = !this.expanded;
				this.transcript.setExpanded(this.expanded);
				this.status = { text: `Tool output ${this.expanded ? "expanded" : "collapsed"}.`, tone: "dim" };
				break;
			case "toggle-thinking":
				this.hideThinking = !this.hideThinking;
				this.transcript.setHideThinking(this.hideThinking);
				this.status = { text: `Thinking blocks ${this.hideThinking ? "hidden" : "shown"}.`, tone: "dim" };
				break;
			case "kill":
				if (run && isKillable(run)) this.confirming = true;
				else this.status = { text: `Nothing to kill: ${this.name} has already finished.`, tone: "dim" };
				break;
			case "confirm-kill":
				this.confirming = false;
				this.kill();
				break;
			case "cancel-kill":
				this.confirming = false;
				this.status = { text: `Kept ${this.name}.`, tone: "dim" };
				break;
			case "edit":
				this.editor.handleInput(data);
				break;
		}
		this.tui.requestRender();
	}

	invalidate(): void {
		this.transcript.root.invalidate();
		this.editor.invalidate();
	}

	dispose(): void {
		this.closed = true;
		clearInterval(this.ticking);
		this.unsubscribe();
		// pi's renderers keep timers of their own for a tool that is still running.
		this.transcript.dispose();
	}

	private run(): Run | undefined {
		return this.session.runs().find((candidate) => candidate.name === this.name);
	}

	/** The line under the editor: a kill waiting on its answer, the last outcome, or what Enter would do. */
	private statusLine(run: Run | undefined): string {
		if (this.confirming) {
			return ` ${this.chrome.fg("warning", `Kill ${this.name}? It fails as stopped, and the parent is told. y to kill, n to keep it.`)}`;
		}
		if (this.status) return ` ${this.chrome.fg(this.status.tone, this.status.text)}`;
		const hint = run && sendHint(run);
		return hint ? ` ${this.chrome.fg("dim", hint)}` : "";
	}

	/**
	 * Send what was typed, and say what became of it.
	 *
	 * What it means is the control plane's decision, made from the Run's state
	 * when it arrives rather than when Enter was pressed; this only reports it.
	 * A message that did not go is put back in the editor, if the Run can still
	 * be written to and nothing new has been typed since, so a transient failure
	 * costs a keypress rather than the message.
	 */
	private send(text: string): void {
		if (!text.trim()) return;
		this.editor.addToHistory(text);
		this.status = { text: `Sending to ${this.name}…`, tone: "dim" };
		void this.session.control
			.send(this.name, text)
			.catch((error: unknown): SendOutcome => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
			.then((outcome) => {
				if (this.closed) return;
				this.status = { text: sentLine(this.name, outcome), tone: outcome.ok ? "success" : "warning" };
				const run = this.run();
				if (!outcome.ok && run && !lockReason(run) && this.editor.getText() === "") this.editor.setText(text);
				this.tui.requestRender();
			});
	}

	private kill(): void {
		this.status = { text: `Killing ${this.name}…`, tone: "dim" };
		void this.session.control
			.kill(this.name)
			.catch(() => false)
			.then((killed) => {
				if (this.closed) return;
				this.status = killed
					? { text: `Killed ${this.name}. Its failure is on its way to the parent.`, tone: "warning" }
					: { text: `Nothing to kill: ${this.name} had already stopped.`, tone: "dim" };
				this.tui.requestRender();
			});
	}
}

/**
 * The `/subagents` command: the picker, and the Inspector on whichever Run is
 * chosen from it, until the picker is closed.
 *
 * Two overlays, one after the other, rather than one that changes what it
 * shows. pi disposes an overlay when it closes and expects a fresh one to be
 * shown in its place, and the two want different sizes: a short list, then
 * most of the screen. Going back is showing the picker again, on the Run that
 * was just open.
 *
 * Only in pi's terminal UI. Elsewhere there is nowhere to draw an overlay, and
 * RPC mode's dialogs are not a transcript viewer.
 */
export async function openSubagents(ctx: ExtensionCommandContext, session: InspectorSession): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents needs pi's interactive terminal: it opens an overlay, and this session has nowhere to draw one.", "error");
		return;
	}
	if (session.runs().length === 0) {
		ctx.ui.notify("No subagent runs in this session.", "info");
		return;
	}

	let last: string | undefined;
	for (;;) {
		const initial = last;
		const chosen = await ctx.ui.custom<string | undefined>(
			(tui, theme, _keybindings, done) => new PickerView(tui, theme, session, initial, done),
			{ overlay: true, overlayOptions: PICKER_OVERLAY },
		);
		if (chosen === undefined) return;
		last = chosen;
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new InspectorView(tui, theme, session, chosen, ctx.cwd, () => done()), {
			overlay: true,
			overlayOptions: INSPECTOR_OVERLAY,
		});
	}
}
