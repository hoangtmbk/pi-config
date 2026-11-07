/**
 * Attaching to a Teammate from pi: the `/team` picker and the menu after it.
 *
 * Attaching only ever views a Teammate's session: it is never a Takeover, and
 * tmux is only a viewer, never a host (ADR-0006). The menu is a table, so the
 * Takeover's "Hand back" is one more row, shown only while the human
 * holds the Teammate; it isn't an attach, so it records none.
 */

import { execFile } from "node:child_process";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TeammateRow } from "./block.ts";
import { attachCommand, attachHere } from "./claude.ts";

/** The Teammate the human picked, and how to reach its session. */
export interface AttachTarget {
	teammate: string;
	shortId: string;
	claudePath: string;
	/** `claude attach <short id>`, as the human would type it. */
	command: string;
	/** The human holds it in a Takeover, so the menu offers to hand it back. */
	takenOver?: boolean;
}

/** What a menu entry can reach. */
export interface AttachSurface {
	mode: ExtensionContext["mode"];
	ui: ExtensionUIContext;
	/** The environment `$TMUX` is read from. */
	env: Record<string, string | undefined>;
	tmuxPath: string;
	copy(text: string): Promise<void>;
	/** `/team handback` on the Teammate: its confirm, then the hand-back. */
	handBack?(teammate: string): Promise<void>;
}

/** One entry of the menu, shown only when {@link shows} says so. */
interface MenuEntry {
	label: string;
	shows(surface: AttachSurface, target: AttachTarget): boolean;
	run(target: AttachTarget, surface: AttachSurface): Promise<void>;
	/** False for an entry that doesn't reach the session, so no attach is recorded. */
	attaches?: false;
}

const MENU: MenuEntry[] = [
	{
		label: "Attach here",
		shows: (surface) => surface.mode === "tui",
		run: attachInPi,
	},
	{
		label: "Open in a tmux window",
		shows: (surface) => Boolean(surface.env.TMUX),
		async run(target, surface) {
			const failed = await tmuxWindow(surface.tmuxPath, target.teammate, target.command);
			if (failed) surface.ui.notify(`Couldn't open a tmux window on \`${target.teammate}\`: ${failed.error}`, "warning");
			else surface.ui.notify(`Opened \`${target.teammate}\` in a new tmux window.`, "info");
		},
	},
	{
		label: "Copy the command",
		shows: () => true,
		async run(target, surface) {
			try {
				await surface.copy(target.command);
				surface.ui.notify(`Copied \`${target.command}\`.`, "info");
			} catch (error) {
				surface.ui.notify(`Couldn't copy the command: ${(error as Error).message}. It is \`${target.command}\`.`, "warning");
			}
		},
	},
	{
		label: "Hand back",
		shows: (surface, target) => target.takenOver === true && surface.handBack !== undefined,
		run: (target, surface) => surface.handBack?.(target.teammate) ?? Promise.resolve(),
		attaches: false,
	},
];

/** The target for a picked Teammate row; undefined for one with no session yet. */
export function attachTarget(row: TeammateRow, claudePath: string): AttachTarget | undefined {
	if (row.shortId === undefined) return undefined;
	return { teammate: row.id, shortId: row.shortId, claudePath, command: attachCommand(claudePath, row.shortId), ...(row.takeover === undefined ? {} : { takenOver: true }) };
}

/** A Teammate's line in the picker: id, short id, what it is doing and its Task. */
export function pickerLabel(row: TeammateRow): string {
	return [row.id, `${row.shortId ?? "—"}${row.newShortId ? " (new)" : ""}`, row.activity, row.task].join("  ");
}

/**
 * Ask the human what to do with the picked Teammate, then do it. Resolves
 * with the run and whether it is an attach, or undefined when the human backs
 * out. Outside the TUI there is no menu to show: the command is shown instead.
 */
export async function chooseAttach(target: AttachTarget, surface: AttachSurface): Promise<{ run: () => Promise<void>; attaches: boolean } | undefined> {
	if (surface.mode !== "tui") {
		return { run: async () => surface.ui.notify(`Attach to \`${target.teammate}\` from a terminal: ${target.command}`, "info"), attaches: true };
	}
	const entries = MENU.filter((entry) => entry.shows(surface, target));
	const label = await surface.ui.select(`${target.teammate} (${target.shortId})`, entries.map((entry) => entry.label));
	const entry = entries.find((candidate) => candidate.label === label);
	return entry ? { run: () => entry.run(target, surface), attaches: entry.attaches !== false } : undefined;
}

/**
 * Hand pi's terminal to `claude attach` and take it back: the TUI stops, the
 * hint is printed, `claude attach` runs on the inherited stdio until the
 * human leaves it, then the TUI restarts with a full redraw and a toast.
 */
async function attachInPi(target: AttachTarget, surface: AttachSurface): Promise<void> {
	const ran = await surface.ui.custom<{ code: number | null } | { error: string }>(async (tui, _theme, _keybindings, done) => {
		tui.stop();
		tui.terminal.write(`\nAttaching to ${target.teammate} (${target.shortId}). Ctrl+Z returns to pi.\n\n`);
		let result: { code: number | null } | { error: string };
		try {
			result = await attachHere(target.claudePath, target.shortId);
		} finally {
			tui.start();
			tui.requestRender(true);
		}
		// Settled before the component is returned, so pi never shows it.
		done(result);
		return { render: () => [], invalidate() {} };
	});
	if ("error" in ran) surface.ui.notify(`Couldn't run \`claude attach ${target.shortId}\`: ${ran.error}`, "error");
	else if (ran.code === 0) surface.ui.notify(`Back in pi from \`${target.teammate}\` (${target.shortId}).`, "info");
	else surface.ui.notify(`\`claude attach ${target.shortId}\` exited with code ${ran.code ?? "none"}; back in pi.`, "warning");
}

/** Open a tmux window named after the Teammate, running the attach command. */
function tmuxWindow(tmuxPath: string, name: string, command: string): Promise<{ error: string } | undefined> {
	return new Promise((resolve) => {
		execFile(tmuxPath, ["new-window", "-n", name, command], { encoding: "utf8" }, (error, _stdout, stderr) => {
			resolve(error ? { error: (stderr.trim() || error.message).split("\n")[0] } : undefined);
		});
	});
}
