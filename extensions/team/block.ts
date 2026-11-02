/**
 * The Team block: an Effort's status → the framed lines above pi's editor.
 *
 * Two pure steps. {@link teamStatus} turns the folded Effort state (plus what
 * the shell alone knows, such as Playbook adoptions waiting in `/team
 * pending`) into {@link TeamBlockData}, which is also exactly what the Lead's
 * `team_status` tool returns. {@link renderTeamBlock} turns that data and the
 * time into lines. Neither knows pi has a UI; `index.ts` hands the lines to
 * `setWidget`.
 *
 * Colourless, like the subagents widget and for the same reason: the lines go
 * to a TUI and, in RPC mode, down a wire as plain text, and plain text is the
 * one form right in both.
 *
 * Widths are terminal columns, measured and cut with pi-tui's `visibleWidth`
 * and `sliceByColumn`, never `String.length`, so a CJK Task slug or an emoji
 * in a Teammate's last message can't push the right border out. Every cell
 * comes from outside this file, so every cell is flattened to one line and
 * clipped.
 *
 * The block is a list of {@link SECTIONS}, each a function from the data to
 * zero or more lines. A later part of the block (pauses, usage, a Takeover
 * row) is a new field on the data and a new section or cell, without
 * reworking the ones here.
 */

import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { type EffortState, heldPauses, openEscalations, type PauseSetter, type TakeoverTrigger, type Teammate, type UsageWindow, usageSource, waitingInTerminal } from "./core.ts";

/** The widest the frame may get, borders included. */
export const MAX_WIDTH = 96;

/** What the borders and their padding take from a line: `│ ` and ` │`. */
const CHROME = 4;

/** Between two cells. */
const GAP = "  ";

const ELLIPSIS = "…";

/** The widest a Teammate id may get before it is clipped. */
const MAX_ID = 16;

/** A Teammate as the block shows it. */
export interface TeammateRow {
	id: string;
	role: string;
	/** The id `claude attach` takes; absent until its first `SessionStart`. */
	shortId?: string;
	/** Set while {@link shortId} is one a new session gave it and the human hasn't attached to through pi: shown `(new)`. */
	newShortId?: boolean;
	/** `starting` until a prompt first lands, then `busy` or `idle`. */
	activity: "starting" | "busy" | "idle";
	/** The Task in its context: its folder once handed off. */
	task: string;
	/** What it is doing or last did on the Task, when the block knows. */
	doing?: string;
	/** How full its context is, in percent, once its status line reports it. */
	ctx?: number;
	/** The mode it runs in: the one last seen on its hooks, else the one it was launched in. */
	mode?: string;
	/** The mode it was launched in, when it differs from {@link mode}: that is drift. */
	launchMode?: string;
	/** Set while the human holds it: since when, and what started the Takeover as the human reads it. */
	takeover?: { since: string; trigger: string };
}

/** A planned Task waiting for a Teammate, and why. */
export interface QueuedTask {
	task: string;
	role: string;
	why: string;
}

/** A pause that holds: who set it, the only one who lifts it, and why. */
export interface PauseRow {
	by: PauseSetter;
	reason?: string;
	/** For the usage pause: the limit that set it. */
	kind?: "session" | "weekly";
	/** For the usage pause: when it lifts, as an ISO time, when Claude Code said. */
	reset?: string;
	/** When it started, as an ISO time. */
	since: string;
}

/** A model family's limit, or a usage-credit confirm, holding the Roles on that family while other Roles go on. */
export interface HoldRow {
	kind: "opus" | "sonnet" | "consent";
	roles: string[];
	/** When it lifts, as an ISO time; absent for a usage-credit confirm. */
	reset?: string;
	/** For a usage-credit confirm: the Teammate whose terminal it waits in. */
	teammate?: string;
}

/** The account's usage, from the freshest reading. */
export interface UsageRow {
	/** The 5-hour window; absent when the reading doesn't give it. */
	fiveHour?: UsageWindow;
	/** The weekly window; absent when the reading doesn't give it. */
	sevenDay?: UsageWindow;
	/** Where the reading came from: a Teammate's status line, or `get_usage`. */
	source: string;
	/** When it was taken, ISO. */
	at: string;
}

/** What the Team block shows, and what `team_status` returns. */
export interface TeamBlockData {
	effortId: string;
	team: string;
	/** Where the Effort is: `intake` until the Brief is approved, `planning` until a Task is handed off, then `working`. */
	phase: string;
	/** Tasks accepted out of those planned. */
	tasks: { accepted: number; planned: number };
	/** Every live Teammate, oldest first. */
	teammates: TeammateRow[];
	/** Planned Tasks waiting for a Teammate, first in line first. */
	queued: QueuedTask[];
	/** Items in `/team pending`. */
	waitingOnYou: number;
	/** Reports written for the human. */
	reports: number;
	/** The pauses that hold, the human's first; absent while the Effort runs. No new Task starts while any holds. */
	pauses?: PauseRow[];
	/** The account's usage; absent until a first reading. */
	usage?: UsageRow;
	/** The model-family holds; absent while none holds. A held Role's Tasks queue until it lifts. */
	holds?: HoldRow[];
}

/** How the block is drawn. */
export interface BlockOptions {
	/** The cap on live Teammates, which bounds the block's height. */
	maxTeammates: number;
	/** The columns there are; the frame never gets wider than {@link MAX_WIDTH}. */
	width?: number;
}

/** What the block knows beyond the Effort's state: the shell holds Playbook adoptions. */
export interface StatusExtras {
	/** Playbook adoptions waiting in `/team pending`. */
	adoptionsPending: number;
}

/**
 * The Effort's status, as the block shows it and `team_status` returns it:
 * live Teammates only, since one stopped to make room under the cap is gone,
 * and the queued Tasks by folder. Nothing yet writes a Report, so that is 0
 * until the ticket that adds them fills it in here.
 */
export function teamStatus(state: EffortState, extras: StatusExtras): TeamBlockData {
	const handed = Object.keys(state.tasks).length > 0 || state.queue.length > 0;
	const teammates = state.teammates.filter((teammate) => teammate.retiredAt === undefined && teammate.ended === undefined).map((teammate) => teammateRow(state, teammate));
	return {
		effortId: state.effortId,
		team: state.team,
		phase: !state.brief ? "intake" : handed ? "working" : "planning",
		tasks: { accepted: Object.values(state.tasks).filter((task) => task.accepted !== undefined).length, planned: state.plan?.length ?? 0 },
		// A Teammate stopped to make room, or that ended (stopped with its dropped Task, or crashed), is gone for this Effort.
		teammates,
		queued: state.queue.map((queued) => ({ task: queued.folder, role: queued.role, why: queued.why })),
		waitingOnYou: state.pending.length + waitingInTerminal(state).length + openEscalations(state).length + extras.adoptionsPending + (state.usageItems?.length ?? 0),
		reports: state.reports,
		...pauseRows(state),
		...usageRow(state, teammates.length),
		...holdRows(state),
	};
}

/** The freshest reading; one `get_usage` took while no Teammate is live says so. */
function usageRow(state: EffortState, live: number): { usage?: UsageRow } {
	const reading = state.usage?.latest;
	if (!reading) return {};
	const source = reading.source === "get-usage" && live === 0 ? `${usageSource(reading)} (no Teammate live)` : usageSource(reading);
	return { usage: { ...(reading.fiveHour ? { fiveHour: reading.fiveHour } : {}), ...(reading.sevenDay ? { sevenDay: reading.sevenDay } : {}), source, at: reading.at } };
}

function pauseRows(state: EffortState): { pauses?: PauseRow[] } {
	const held = heldPauses(state);
	if (held.length === 0) return {};
	return {
		pauses: held.map((pause) => ({
			by: pause.by,
			...(pause.reason === undefined ? {} : { reason: pause.reason }),
			...(pause.kind === undefined ? {} : { kind: pause.kind }),
			...(pause.reset === undefined ? {} : { reset: pause.reset }),
			since: pause.at,
		})),
	};
}

function holdRows(state: EffortState): { holds?: HoldRow[] } {
	const holds = Object.values(state.holds ?? {}).filter((hold) => hold !== undefined);
	if (holds.length === 0) return {};
	return {
		holds: holds.map((hold) => ({
			kind: hold.kind,
			roles: hold.roles,
			...(hold.reset === undefined ? {} : { reset: hold.reset }),
			...(hold.teammate === undefined ? {} : { teammate: hold.teammate }),
		})),
	};
}

function teammateRow(state: EffortState, teammate: Teammate): TeammateRow {
	const mode = teammate.observedMode ?? teammate.mode;
	const drifted = teammate.observedMode !== undefined && teammate.mode !== undefined && teammate.observedMode !== teammate.mode;
	const ctx = state.usage?.statusLines[teammate.id]?.ctx;
	return {
		id: teammate.id,
		role: teammate.role,
		...(teammate.shortId === undefined ? {} : { shortId: teammate.shortId }),
		...(teammate.newShortId ? { newShortId: true } : {}),
		activity: teammate.activity ?? "starting",
		task: state.tasks[teammate.task]?.folder ?? teammate.task,
		...(teammate.activity === "idle" && teammate.doing !== undefined ? { doing: teammate.doing } : {}),
		...(ctx === undefined ? {} : { ctx }),
		...(mode === undefined ? {} : { mode }),
		...(drifted ? { launchMode: teammate.mode } : {}),
		...(teammate.takeover === undefined ? {} : { takeover: { since: teammate.takeover.since, trigger: triggerText(teammate.takeover.trigger) } }),
	};
}

/** What started a Takeover, said to the human who did it. */
function triggerText(trigger: TakeoverTrigger): string {
	switch (trigger.kind) {
		case "prompt":
			return "you typed a prompt";
		case "command":
			return `you ran ${trigger.command}`;
		case "interrupt":
			return "you interrupted a turn";
		case "deny":
			return "you said No to its prompt";
	}
}

/** One part of the block: zero or more unframed lines, each at most `width` columns. */
type Section = (data: TeamBlockData, now: number, options: BlockOptions, width: number) => string[];

/** The block's body, top to bottom. */
const SECTIONS: Section[] = [statusLine, pauseLines, holdLines, usageLine, teammateRows, queuedLines, footerLine];

/** The framed Team block. */
export function renderTeamBlock(data: TeamBlockData, now: number, options: BlockOptions): string[] {
	const frame = Math.min(MAX_WIDTH, options.width ?? MAX_WIDTH);
	const inner = frame - CHROME;
	const body = SECTIONS.flatMap((section) => section(data, now, options, inner)).map((line) => clip(line, inner));
	const tally = ` ${data.teammates.length} live ─╮`;
	const title = `╭─ ${clip(oneLine(`Team · ${data.team} · ${data.effortId}`), frame - visibleWidth(tally) - 5)} `;
	// The frame is as wide as its widest line, and the header needs at least one fill dash.
	const width = Math.min(inner, Math.max(visibleWidth(title) + visibleWidth(tally) + 1 - CHROME, ...body.map(visibleWidth)));
	return [
		`${title}${"─".repeat(width + CHROME - visibleWidth(title) - visibleWidth(tally))}${tally}`,
		...body.map((line) => `│ ${pad(line, width)} │`),
		`╰${"─".repeat(width + 2)}╯`,
	];
}

function statusLine(data: TeamBlockData): string[] {
	const tasks = data.tasks.planned > 0 ? ` · ${data.tasks.accepted}/${data.tasks.planned} Tasks accepted` : "";
	const state = data.pauses?.length ? "⏸ paused" : "● running";
	return [`${state}  ·  ${oneLine(data.phase)}${tasks}`];
}

/** Who set each pause, as the human reads it. */
const SETTERS: Record<PauseSetter, string> = { human: "you", lead: "the Lead", usage: "a usage limit" };

/** A line per pause under the status line: who set it, since when and why; the human's says how to lift it. */
function pauseLines(data: TeamBlockData, now: number): string[] {
	return (data.pauses ?? []).map((pause) => {
		const resets = pause.reset === undefined ? "" : `, resets ${clockAt(pause.reset, now)}`;
		const why = pause.reason === undefined ? "" : `: ${oneLine(pause.reason)}${resets}`;
		const lift = pause.by === "human" ? "   /team resume" : "";
		// The block repaints on events, not on a timer, so it shows a clock time rather than an age.
		return `  by ${SETTERS[pause.by]} since ${pause.since.slice(11, 16)} UTC${why}${lift}`;
	});
}

/** What holds each model family's Roles, as the human reads it. */
const HOLDS: Record<HoldRow["kind"], string> = { opus: "an Opus limit", sonnet: "a Sonnet limit", consent: "a usage-credit confirm" };

/** A line per model hold: the Roles it holds, on what, and until when, or where the confirm waits. */
function holdLines(data: TeamBlockData, now: number): string[] {
	return (data.holds ?? []).map((hold) => {
		const until = hold.reset === undefined ? "" : ` until ${clockAt(hold.reset, now)}`;
		const where = hold.teammate === undefined ? "" : ` in ${oneLine(hold.teammate)}'s terminal`;
		return `held  ${oneLine(hold.roles.join(", "))} on ${HOLDS[hold.kind]}${until}${where}`;
	});
}

/** A time as the block shows it: the UTC clock time, with its date when that is not today's. */
function clockAt(at: string, now: number): string {
	const day = at.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? "" : `${at.slice(0, 10)} `;
	return `${day}${at.slice(11, 16)} UTC`;
}

/**
 * The account's usage, shown whether or not a Teammate is live: each window,
 * or `n/a` when the reading doesn't give it, and when it resets, as a time
 * today or a weekday and time otherwise, in UTC like the pause lines; then
 * where the reading came from and how old it is.
 */
function usageLine(data: TeamBlockData, now: number): string[] {
	const usage = data.usage;
	if (!usage) return [];
	const windows = [usageWindow("5h", usage.fiveHour, now), usageWindow("week", usage.sevenDay, now)].join(" · ");
	return [`${windows}  · ${oneLine(usage.source)}, ${age(now - Date.parse(usage.at))} ago`];
}

function usageWindow(label: string, window: UsageWindow | undefined, now: number): string {
	if (!window) return `${label} n/a`;
	const resets = window.resetsAt === undefined ? "" : ` ↻${resetClock(Date.parse(window.resetsAt), now)}`;
	return `${label} ${Math.round(window.percent)}%${resets}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `HH:MM` UTC for a time today, `Ddd HH:MM` for another day. */
function resetClock(at: number, now: number): string {
	const date = new Date(at);
	const time = date.toISOString().slice(11, 16);
	return date.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? time : `${WEEKDAYS[date.getUTCDay()]} ${time}`;
}

/** An age: seconds under a minute, minutes under an hour, then hours and minutes. */
function age(ms: number): string {
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}

/**
 * A row per Teammate, its cells in columns lined up across the rows; the Task
 * cell is the one that gives. At most `maxTeammates` lines, so the block's
 * height has a bound: past it, the last line counts the Teammates not shown.
 */
function teammateRows(data: TeamBlockData, now: number, options: BlockOptions, width: number): string[] {
	const cap = Math.max(1, options.maxTeammates);
	const rows = data.teammates.length > cap ? data.teammates.slice(0, cap - 1) : data.teammates;
	const hidden = data.teammates.length - rows.length;
	const ids = column(rows.map((row) => clip(oneLine(row.id), MAX_ID)));
	const shorts = column(rows.map((row) => oneLine(row.shortId === undefined ? "—" : row.newShortId ? `${row.shortId} (new)` : row.shortId)));
	// A Teammate the human holds shows whose it is and for how long in place of its activity, and in
	// place of its Task, context and mode, what started the Takeover and how to hand it back.
	const activities = column(rows.map((row) => (row.takeover === undefined ? row.activity : `✋ YOURS ${age(now - Date.parse(row.takeover.since))}`)));
	const left = rows.map((_, index) => [ids[index], shorts[index], activities[index]].join(GAP));
	const leftWidth = Math.max(0, ...left.map(visibleWidth));
	const working = rows.flatMap((row, index) => (row.takeover === undefined ? [{ row, index }] : []));
	const ctxs = column(working.map(({ row }) => (row.ctx === undefined ? "ctx —" : `ctx ${Math.round(row.ctx)}%`)));
	const modes = working.map(({ row }) => oneLine(row.launchMode === undefined || row.launchMode === row.mode ? (row.mode ?? "") : `${row.mode ?? "?"}≠${row.launchMode}`));
	const right = working.map((_, at) => [ctxs[at], modes[at]].filter(Boolean).join(GAP));
	const room = width - leftWidth - Math.max(0, ...right.map(visibleWidth)) - 2 * GAP.length;
	const tasks = column(working.map(({ row }) => clip(oneLine(row.doing ? `${row.task} · ${row.doing}` : row.task), room)));
	const lines = rows.map((row, index) => {
		if (row.takeover !== undefined) return [left[index], clipHead(`${oneLine(row.takeover.trigger)} · `, `/team handback ${oneLine(row.id)}`, width - leftWidth - GAP.length)].join(GAP);
		const at = working.findIndex((each) => each.index === index);
		return [left[index], tasks[at], right[at]].join(GAP).trimEnd();
	});
	return hidden > 0 ? [...lines, `+${hidden} more Teammate${hidden === 1 ? "" : "s"}`] : lines;
}

/** The Task first in the queue, and how many more wait behind it: a long queue never grows the block. */
function queuedLines(data: TeamBlockData): string[] {
	const [first, ...rest] = data.queued;
	if (!first) return [];
	const lines = [`queued  ${oneLine(first.task)} (${oneLine(first.role)}): ${oneLine(first.why)}`];
	if (rest.length > 0) lines.push(`        +${rest.length} more queued`);
	return lines;
}

function footerLine(data: TeamBlockData): string[] {
	const waiting = data.waitingOnYou > 0 ? `▲ ${data.waitingOnYou} waiting on you  /team pending` : "nothing waiting on you";
	// Where to read them, once there are any.
	const reports = data.reports > 0 ? `reports ${data.reports}  /team reports` : `reports ${data.reports}`;
	// Attaching needs a short id, so the hint shows once a Teammate's session has started.
	const attach = data.teammates.some((row) => row.shortId !== undefined) ? "   attach  /team" : "";
	return [`${waiting}   ${reports}${attach}`];
}

/** Each cell padded to the widest in the column. */
function column(cells: string[]): string[] {
	const width = Math.max(0, ...cells.map(visibleWidth));
	return cells.map((cell) => pad(cell, width));
}

/** At most `width` columns of `text`, the overflow marked with an ellipsis. */
export function clip(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	return `${sliceByColumn(text, 0, width - 1, true)}${ELLIPSIS}`;
}

/** `head` then `tail` in at most `width` columns, clipping `head` first so the tail stays whole while it fits. */
function clipHead(head: string, tail: string, width: number): string {
	const room = width - visibleWidth(tail);
	return room <= 0 ? clip(tail, width) : `${clip(head, room)}${tail}`;
}

/** `text` filled out to `width` columns. */
function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** `text` with every run of whitespace, newlines included, flattened to one space. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
