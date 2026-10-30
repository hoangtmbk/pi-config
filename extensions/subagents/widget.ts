/**
 * The Runs widget: Supervisor state → the block of lines above the editor.
 *
 * Pure, like `supervisor.ts` and for the same reason: what a reader sees is
 * decided here, so it can be asserted as exact strings rather than by driving a
 * terminal. Nothing in this file knows pi has a UI at all — `index.ts` is what
 * hands the lines over, and what decides whether there is anywhere to put them.
 *
 * Deliberately colourless. The lines go to a TUI and, in RPC mode, down a wire
 * to something that may not be a terminal at all, and plain text is the only
 * form that is right in both.
 *
 * Widths are terminal columns, measured and cut with pi's own `visibleWidth` and
 * `sliceByColumn` rather than with `String.length`: a CJK path or an emoji in a
 * Run's name takes two columns per character, and counting code units would push
 * the right-hand border out on exactly the input the clipping exists to survive.
 * Both are pure string functions — nothing here needs a TUI. pi's
 * `truncateToWidth` would do the cut in one call and is deliberately not used:
 * it wraps its ellipsis in ANSI resets, and these lines must stay plain.
 *
 * The rows, and the small pieces they are cut and timed with, are exported for
 * the `/subagents` picker, which lists the same Runs in the same columns: one
 * layout for a Run wherever it is listed, kept in one place.
 */

import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { Run } from "./supervisor.ts";

/**
 * The widest the whole frame may get, borders included.
 *
 * A widget above the editor that wraps is worse than one that clips: the frame
 * breaks and the block stops reading as a block. 72 leaves room in the 80
 * columns a narrow terminal still gets.
 */
const MAX_WIDTH = 72;

/** The widest a Run's name column may get, however long the names are. */
const MAX_NAME = 20;

/** What the borders and their padding take from a line: `│ ` on the left, ` │` on the right. */
const CHROME = 4;

/** Between two columns. */
const GAP = "  ";

/** `MM:SS` is the shortest an elapsed reading gets, and every one is right-aligned to it. */
const MIN_TIME_WIDTH = 5;

/** What a clipped column ends in. One column wide, so it costs what it replaces. */
const ELLIPSIS = "…";

/** The frame's top-left, up to where the fill starts. */
const TITLE = "╭─ Runs ";

/**
 * The Runs block, or nothing at all when there is nothing to show.
 *
 * `runs` is the active set — the Runs a reader can still do something about.
 * Nothing filters it here: a Supervisor that has finished everything it was
 * given hands over an empty list, and an empty list is what makes the widget
 * disappear rather than sit there saying "0 active". That is the whole of what
 * keeps it free in an ordinary session.
 *
 * A Question's text is never among the lines. It is already being delivered into
 * the conversation, and a fixed-height widget would only truncate it.
 */
export function renderRuns(runs: Run[], now: number): string[] | undefined {
	if (runs.length === 0) return undefined;

	const rows = runRows(runs, now, MAX_WIDTH - CHROME);
	// The header has a width of its own, and a session of one short-named Run is
	// narrower than it. Taking the wider of the two — the header needing at least
	// one fill dash — is what keeps the frame square either way, rather than a top
	// edge overhanging the box under it.
	const tally = ` ${runs.length} active ─╮`;
	const bodyWidth = Math.max(visibleWidth(TITLE) + visibleWidth(tally) + 1 - CHROME, ...rows.map(visibleWidth));

	return [header(tally, bodyWidth), ...rows.map((row) => `│ ${pad(row, bodyWidth)} │`), footer(bodyWidth)];
}

/**
 * One line per Run — elapsed, name, and what it is doing — in columns lined up
 * across the whole set, each line at most `width` columns.
 *
 * The widget's rows and the `/subagents` picker's are the same rows on purpose:
 * a Run a reader has just seen above the editor should be recognisable at a
 * glance in the list they open to look at it, not re-read in a second layout.
 * The lines are left unpadded; whoever frames them pads them to their frame.
 */
export function runRows(runs: Run[], now: number, width: number): string[] {
	const times = runs.map((run) => age(run, now));
	// Digits and colons only, so this column is the one place a character is
	// reliably one column and `padStart` can be trusted.
	const timeWidth = Math.max(MIN_TIME_WIDTH, ...times.map((time) => time.length));
	const names = runs.map((run) => clip(oneLine(run.name), MAX_NAME));
	const nameWidth = Math.max(0, ...names.map(visibleWidth));
	// Whatever the line has left once the fixed columns have been paid for. What
	// a Run is doing is the one column with no natural length, so it is the one
	// that gives: a child reading a path 200 characters long still gets one line.
	const doingWidth = width - timeWidth - GAP.length - nameWidth - GAP.length;

	return runs.map((run, index) =>
		[times[index].padStart(timeWidth), pad(names[index], nameWidth), clip(oneLine(doing(run)), doingWidth)].join(GAP),
	);
}

/**
 * How long a Run has been going, or went on for, as the widget writes a time.
 *
 * A finished Run's clock stops when it did: its age is how long it took, and
 * one that went on counting would read as a Run still working.
 */
export function age(run: Run, now: number): string {
	return elapsed((run.stoppedAt ?? now) - run.askedAt);
}

/**
 * The frame's top: what this block is, and how much of it there is.
 *
 * The count is on the right rather than in the title so that it lands in the
 * same place whatever the runs are called, which is what makes it readable at a
 * glance instead of something to go looking for.
 */
function header(tally: string, bodyWidth: number): string {
	return `${TITLE}${"─".repeat(bodyWidth + CHROME - visibleWidth(TITLE) - visibleWidth(tally))}${tally}`;
}

function footer(bodyWidth: number): string {
	return `╰${"─".repeat(bodyWidth + 2)}╯`;
}

/**
 * What a Run is doing, in the words the widget has room for: its state, and the
 * tool its child is inside.
 *
 * A Waiting Run says only that it is waiting. What it asked is on its way into
 * the conversation, where there is room for it.
 *
 * A finished Run is doing nothing, so it says how it ended instead — the tool
 * it last started is history, and "done · bash" would read as a Run still in
 * one. Only the picker ever shows one: the widget's Runs are all active.
 */
function doing(run: Run): string {
	if (run.state === "done") return "done";
	if (run.state === "failed") return `failed · ${failedHow(run.failure)}`;
	return run.activity ? `${run.state} · ${run.activity}` : run.state;
}

/**
 * Why a Run failed, in the two or three words a row has room for.
 *
 * Shorter than the Delivery's account of it, which the parent reads in full:
 * this is the line that tells a crash from a kill at a glance, not the place to
 * read the stderr.
 */
function failedHow(failure: Run["failure"]): string {
	if (!failure) return "stopped";
	if (failure.kind === "spawn") return "could not start";
	if (failure.kind === "stopped") return failure.reason;
	if (failure.signal) return `killed by ${failure.signal}`;
	if (failure.exitCode !== undefined && failure.exitCode !== 0) return `exited ${failure.exitCode}`;
	return "child exited early";
}

/**
 * How long a Run has been going, as `MM:SS` — or `H:MM:SS` once it has been an
 * hour, which no cap can rule out and which `61:00` would misread as a minute.
 *
 * A clock that has not started yet reads as zero rather than going negative: a
 * Run registered in the same millisecond the widget renders is a Run that has
 * just started, not one that started in the future.
 */
export function elapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60) % 60;
	const seconds = total % 60;
	const clock = `${twoDigits(minutes)}:${twoDigits(seconds)}`;
	const hours = Math.floor(total / 3600);
	return hours > 0 ? `${hours}:${clock}` : clock;
}

function twoDigits(value: number): string {
	return String(value).padStart(2, "0");
}

/**
 * At most `width` columns of `text`, the overflow marked with an ellipsis.
 *
 * Every string the widget shows comes from outside it — a name the parent chose,
 * a path the child read — so clipping is what keeps the frame a frame. The cut
 * is strict, so a two-column character that would straddle the boundary is
 * dropped whole rather than half-drawn.
 */
export function clip(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	// The ellipsis takes the last column, so the text gets one fewer.
	return `${sliceByColumn(text, 0, width - 1, true)}${ELLIPSIS}`;
}

/**
 * `text` filled out to `width` columns.
 *
 * `padEnd` counts code units, so it under-fills any line with a wide character
 * in it — which is the frame going ragged one line at a time.
 */
export function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/**
 * `text` with every run of whitespace flattened to a single space.
 *
 * A Run's name and its child's tool arguments both come from outside this file,
 * and one newline in either would split a row in half and leave the frame open.
 * Flattening is what makes "one line per Run" true rather than intended.
 */
export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
