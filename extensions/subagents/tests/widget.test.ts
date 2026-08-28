/**
 * The Runs widget: Supervisor state in, the lines above the editor out.
 *
 * Nothing here builds a TUI. The renderer is a pure function, so what a reader
 * sees is asserted as the exact strings pi is handed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Run } from "../supervisor.ts";
import { renderRuns } from "../widget.ts";

/** A Run as the Supervisor holds one, with only the fields the widget reads. */
function run(name: string, state: Run["state"], secondsAgo: number, activity?: string): Run {
	return { name, agent: name, task: "look around", state, askedAt: -secondsAgo * 1000, activity };
}

/** The widget's lines at time zero, so a Run's age is what `run` says it is. */
function render(runs: Run[]): string[] | undefined {
	return renderRuns(runs, 0);
}

describe("the Runs widget", () => {
	it("renders nothing when no Runs are active", () => {
		assert.equal(render([]), undefined);
	});

	it("gives each Run a line: elapsed, name, state, and what its child is doing", () => {
		const lines = render([
			run("scout", "running", 72, "read auth.ts"),
			run("scout-2", "waiting", 47),
			run("worker", "running", 9, "bash"),
		]);

		assert.deepEqual(lines, [
			"╭─ Runs ────────────────────── 3 active ─╮",
			"│ 01:12  scout    running · read auth.ts │",
			"│ 00:47  scout-2  waiting                │",
			"│ 00:09  worker   running · bash         │",
			"╰────────────────────────────────────────╯",
		]);
	});

	it("clips a long name and a long activity rather than letting either break the frame", () => {
		const lines = render([run("a-very-long-run-name-indeed", "running", 5, `read ${"deeply/nested/".repeat(20)}file.ts`)]) ?? [];

		assert.equal(lines.length, 3);
		assert.deepEqual(
			lines.map((line) => [...line].length),
			[72, 72, 72],
		);
		assert.match(lines[1], /^│ 00:05  a-very-long-run-nam…  running · read deeply\/nested\/deeply\/ne… │$/);
	});

	it("counts the hours once a Run has been going for one, rather than reading 61:00 as a minute", () => {
		const lines = render([run("worker", "running", 3 * 3600 + 4 * 60 + 5)]) ?? [];

		assert.match(lines[1], /^│ 3:04:05  worker  running/);
	});

	it("shows a queued Run, which is work the parent asked for and has not got", () => {
		const lines = render([run("scout", "queued", 3)]) ?? [];

		assert.match(lines[0], /1 active/);
		assert.match(lines[1], /^│ 00:03  scout  queued /);
	});

	it("keeps the frame square when the Runs are narrower than the header itself", () => {
		const lines = render([run("s", "queued", 1)]) ?? [];

		assert.equal(new Set(lines.map((line) => [...line].length)).size, 1, `expected one width, got ${JSON.stringify(lines)}`);
	});

	it("measures a wide character as the two columns it takes, so a CJK path does not push the border out", () => {
		const lines = render([run("スカウト", "running", 1, `read ${"日本語のファイル名.ts".repeat(6)}`)]) ?? [];

		const widths = new Set(lines.map(visibleWidth));
		assert.deepEqual([...widths], [72], `expected one 72-column frame, got ${JSON.stringify(lines)}`);
	});

	it("keeps a line-broken name or activity on one line, so the frame stays a frame", () => {
		const lines = render([run("scout", "running", 1, "grep foo\nbar\tbaz")]) ?? [];

		assert.ok(
			lines.every((line) => !/[\n\r\t]/.test(line)),
			`expected one line per Run, got ${JSON.stringify(lines)}`,
		);
		assert.match(lines[1], /running · grep foo bar baz /);
	});

	it("emits plain text, so nothing downstream of a terminal is handed escape codes", () => {
		const lines = render([run("スカウト", "running", 1, "read 日本語.ts"), run("worker", "queued", 2)]) ?? [];

		assert.ok(
			lines.every((line) => !line.includes("\u001b")),
			`expected no escape codes, got ${JSON.stringify(lines)}`,
		);
	});

	it("never shows a Waiting Run's question, which is being delivered into the conversation instead", () => {
		const waiting = { ...run("scout", "waiting", 3), question: "Should I edit the generated file?" };

		const lines = render([waiting]) ?? [];

		assert.ok(
			lines.every((line) => !line.includes("generated")),
			`expected no question text, got ${JSON.stringify(lines)}`,
		);
	});
});
