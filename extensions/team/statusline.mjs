#!/usr/bin/env node
/**
 * Every Teammate's `statusLine` command:
 * `node statusline.mjs <effort dir> <teammate id> [<human's status line command>]`,
 * with Claude Code's status line JSON on stdin.
 *
 * A `statusLine` in `--settings` replaces the human's own, so this wrapper
 * chains it: it runs the human's command, when there is one, with the same
 * JSON on stdin and prints what it prints, unchanged. Then it writes the JSON
 * it received as `teammates/<id>/statusline.json`, whole and in one rename, so
 * a reader never sees half of it. The file's modification time is when the
 * reading was taken. It writes the file even when the human has no command,
 * or theirs fails.
 *
 * Claude Code runs it with plain Node, outside pi, so it is JavaScript with no
 * dependencies. It exits 0.
 */

import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [effortDir, teammate, human] = process.argv.slice(2);

function readStdin() {
	return new Promise((resolve) => {
		let text = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => (text += chunk));
		process.stdin.on("end", () => resolve(text));
		process.stdin.on("error", () => resolve(text));
	});
}

/** Run the human's command with `input` on stdin, its output passed straight through. */
function runHuman(command, input) {
	return new Promise((resolve) => {
		const child = spawn("sh", ["-c", command], { stdio: ["pipe", "inherit", "inherit"] });
		child.on("error", () => resolve());
		child.on("close", () => resolve());
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

const input = await readStdin();
if (human) await runHuman(human, input);
if (effortDir && teammate) {
	try {
		const dir = join(effortDir, "teammates", teammate);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "statusline.json");
		const partial = `${file}.${process.pid}.tmp`;
		writeFileSync(partial, input);
		renameSync(partial, file);
	} catch {
		// A status line never fails Claude Code's footer.
	}
}
