/**
 * The overlay `/team reports` opens one Report in: its Markdown as written,
 * wrapped to the overlay's width and scrolled with the arrow and page keys.
 * Escape or `q` closes it.
 */

import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** The part of pi's theme the overlay draws its chrome with. */
export interface ReportChrome {
	fg(color: "border" | "accent" | "dim", text: string): string;
	bold(text: string): string;
}

/** What the overlay needs of pi's TUI: its height, and a way to ask for a redraw. */
export interface ReportTui {
	terminal: { rows: number };
	requestRender(): void;
}

/** How much of the terminal the overlay may take, as pi's overlay options say it. */
export const REPORT_OVERLAY = { width: "80%", maxHeight: "80%", anchor: "center" } as const;

export class ReportView {
	private scroll = 0;
	private lastBody = 1;
	private lastTotal = 0;

	constructor(
		private readonly tui: ReportTui,
		private readonly chrome: ReportChrome,
		private readonly title: string,
		private readonly markdown: string,
		private readonly done: () => void,
	) {}

	render(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const wrapped = this.markdown
			.trimEnd()
			.split("\n")
			.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, inner)));
		// 80% of the terminal, less the two edges.
		const body = Math.max(1, Math.floor(this.tui.terminal.rows * 0.8) - 2);
		this.lastBody = body;
		this.lastTotal = wrapped.length;
		this.scroll = Math.max(0, Math.min(this.scroll, wrapped.length - body));
		const shown = wrapped.slice(this.scroll, this.scroll + body);
		const border = (text: string) => this.chrome.fg("border", text);
		const label = truncateToWidth(` ${this.title} `, Math.max(0, width - 4), "…");
		const hint = wrapped.length > body ? " ↑↓ PgUp PgDn · esc " : " esc ";
		const top = `${border("╭─")}${this.chrome.bold(label)}${border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(label)))}╮`)}`;
		const bottom = `${border("╰")}${border("─".repeat(Math.max(0, width - 2 - visibleWidth(hint))))}${this.chrome.fg("dim", hint)}${border("╯")}`;
		const rows = shown.map((line) => `${border("│")} ${truncateToWidth(line, inner, "", true)} ${border("│")}`);
		return [top, ...rows, bottom];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") return this.done();
		const page = Math.max(1, this.lastBody - 1);
		const by = matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1 : matchesKey(data, Key.pageUp) ? -page : matchesKey(data, Key.pageDown) ? page : 0;
		if (by === 0) return;
		this.scroll = Math.max(0, Math.min(this.scroll + by, this.lastTotal - this.lastBody));
		this.tui.requestRender();
	}

	invalidate(): void {}
}

