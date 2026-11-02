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
import type { EffortState, Teammate } from "./core.ts";

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
}

/** A planned Task waiting for a Teammate, and why. */
export interface QueuedTask {
	task: string;
	role: string;
	why: string;
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
 * The Effort's status, as the block shows it and `team_status` returns it.
 * Nothing yet queues a Task or writes a Report, so those are empty and 0
 * until the tickets that add them fill them in here.
 */
export function teamStatus(state: EffortState, extras: StatusExtras): TeamBlockData {
	const handed = Object.keys(state.tasks).length > 0;
	return {
		effortId: state.effortId,
		team: state.team,
		phase: !state.brief ? "intake" : handed ? "working" : "planning",
		tasks: { accepted: Object.values(state.tasks).filter((task) => task.accepted !== undefined).length, planned: state.plan?.length ?? 0 },
		teammates: state.teammates.map((teammate) => teammateRow(state, teammate)),
		queued: [],
		waitingOnYou: state.pending.length + extras.adoptionsPending,
		reports: state.reports,
	};
}

function teammateRow(state: EffortState, teammate: Teammate): TeammateRow {
	const mode = teammate.observedMode ?? teammate.mode;
	const drifted = teammate.observedMode !== undefined && teammate.mode !== undefined && teammate.observedMode !== teammate.mode;
	return {
		id: teammate.id,
		role: teammate.role,
		...(teammate.shortId === undefined ? {} : { shortId: teammate.shortId }),
		activity: teammate.activity ?? "starting",
		task: state.tasks[teammate.task]?.folder ?? teammate.task,
		...(teammate.activity === "idle" && teammate.doing !== undefined ? { doing: teammate.doing } : {}),
		...(mode === undefined ? {} : { mode }),
		...(drifted ? { launchMode: teammate.mode } : {}),
	};
}

/** One part of the block: zero or more unframed lines, each at most `width` columns. */
type Section = (data: TeamBlockData, now: number, options: BlockOptions, width: number) => string[];

/** The block's body, top to bottom. */
const SECTIONS: Section[] = [statusLine, teammateRows, queuedLines, footerLine];

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
	return [`● running  ·  ${oneLine(data.phase)}${tasks}`];
}

/**
 * A row per Teammate, its cells in columns lined up across the rows; the Task
 * cell is the one that gives. At most `maxTeammates` lines, so the block's
 * height has a bound: past it, the last line counts the Teammates not shown.
 */
function teammateRows(data: TeamBlockData, _now: number, options: BlockOptions, width: number): string[] {
	const cap = Math.max(1, options.maxTeammates);
	const rows = data.teammates.length > cap ? data.teammates.slice(0, cap - 1) : data.teammates;
	const hidden = data.teammates.length - rows.length;
	const ids = column(rows.map((row) => clip(oneLine(row.id), MAX_ID)));
	const shorts = column(rows.map((row) => oneLine(row.shortId ?? "—")));
	const activities = column(rows.map((row) => row.activity));
	const ctxs = column(rows.map((row) => (row.ctx === undefined ? "ctx —" : `ctx ${Math.round(row.ctx)}%`)));
	const modes = rows.map((row) => oneLine(row.launchMode === undefined || row.launchMode === row.mode ? (row.mode ?? "") : `${row.mode ?? "?"}≠${row.launchMode}`));
	const left = rows.map((_, index) => [ids[index], shorts[index], activities[index]].join(GAP));
	const right = rows.map((_, index) => [ctxs[index], modes[index]].filter(Boolean).join(GAP));
	const room = width - Math.max(0, ...left.map(visibleWidth)) - Math.max(0, ...right.map(visibleWidth)) - 2 * GAP.length;
	const tasks = column(rows.map((row) => clip(oneLine(row.doing ? `${row.task} · ${row.doing}` : row.task), room)));
	const lines = rows.map((_, index) => [left[index], tasks[index], right[index]].join(GAP).trimEnd());
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
	return [`${waiting}   ${reports}`];
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

/** `text` filled out to `width` columns. */
function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** `text` with every run of whitespace, newlines included, flattened to one space. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
