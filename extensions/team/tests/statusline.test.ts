/**
 * The status line wrapper, run as Claude Code runs a `statusLine` command: a
 * real `node` process with the status line JSON on stdin, against a temp
 * Effort dir, with a stand-in for the human's own status line command.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { STATUSLINE_SCRIPT } from "../claude.ts";
import { tempRoots } from "./harness.ts";

/** Run the wrapper for `teammate` with `input` on stdin; resolves with its exit code and stdout. */
function runWrapper(effortDir: string, teammate: string, input: string, human?: string): Promise<{ code: number | null; stdout: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [STATUSLINE_SCRIPT, effortDir, teammate, ...(human === undefined ? [] : [human])]);
		let stdout = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout }));
		child.stdin.end(input);
	});
}

function effortDir(): string {
	const dir = join(tempRoots().scratch, "effort");
	mkdirSync(dir, { recursive: true });
	return dir;
}

const STATUS = JSON.stringify({
	session_id: "sess-1",
	context_window: { total_input_tokens: 41_000, total_output_tokens: 900, used_percentage: 21 },
	rate_limits: { seven_day: { used_percentage: 73, resets_at: 1_793_955_600 } },
	cost: { total_cost_usd: 0.42 },
});

describe("the status line wrapper", () => {
	it("prints the human's status line output unchanged and writes statusline.json with the JSON it received", async () => {
		const dir = effortDir();
		const scratch = tempRoots().scratch;
		const human = join(scratch, "human-status.sh");
		// The human's command echoes back what it read, after a fixed, multi-line, unterminated banner.
		writeFileSync(human, `printf '\\033[32mmain\\033[0m  ✓\\nsecond line  '; cat > '${join(scratch, "human-saw.json")}'`);
		const result = await runWrapper(dir, "dev-1", STATUS, `sh '${human}'`);
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "\u001b[32mmain\u001b[0m  ✓\nsecond line  ");
		assert.equal(readFileSync(join(scratch, "human-saw.json"), "utf8"), STATUS);
		assert.equal(readFileSync(join(dir, "teammates", "dev-1", "statusline.json"), "utf8"), STATUS);
	});

	it("writes statusline.json and prints nothing when the human has no status line command", async () => {
		const dir = effortDir();
		const result = await runWrapper(dir, "dev-2", STATUS);
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "");
		assert.equal(readFileSync(join(dir, "teammates", "dev-2", "statusline.json"), "utf8"), STATUS);
	});

	it("still writes statusline.json when the human's command fails", async () => {
		const dir = effortDir();
		const result = await runWrapper(dir, "dev-1", STATUS, "echo partial; exit 3");
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "partial\n");
		assert.equal(readFileSync(join(dir, "teammates", "dev-1", "statusline.json"), "utf8"), STATUS);
	});
});
