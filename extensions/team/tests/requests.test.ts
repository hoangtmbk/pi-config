/**
 * A Teammate's held requests as the Lead and the Report read them: how a call
 * is shown in a line (`gist`), and the full input the Lead is prompted with.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askedText, askText, type HeldRequest, matchesRule, takeAnswer } from "../requests.ts";

function held(tool: string, input: Record<string, unknown>): HeldRequest {
	return { request: "req-00000001", teammate: "dev-1", tool, input, at: "2026-11-02T11:40:00.000Z", state: "held" };
}

/** A 30-line script, as a Teammate might ask to run it. */
const SCRIPT = ["set -euo pipefail", ...Array.from({ length: 28 }, (_, index) => `echo "step ${index + 1}"`), "echo done-for-real"].join("\n");

describe("a held request's command in a line", () => {
	it("keeps only the first line of a multi-line command, marked as cut", () => {
		assert.equal(askedText(held("Bash", { command: SCRIPT })), "`Bash` `set -euo pipefail…`");
	});

	it("cuts a long single-line command to about 100 characters, ending in an ellipsis", () => {
		const command = `node tools/check.mjs ${"--flag value ".repeat(20)}--last`;
		const shown = askedText(held("Bash", { command }));
		const line = shown.slice("`Bash` `".length, -"`".length);
		assert.ok(line.length <= 100, `${line.length} characters`);
		assert.ok(line.endsWith("…"), line);
		assert.ok(command.startsWith(line.slice(0, -1)), "the kept part is the start of the command");
		assert.ok(!line.endsWith("……"), "one ellipsis, not two");
	});

	it("leaves a short single-line command unchanged", () => {
		assert.equal(askedText(held("Bash", { command: "npm test" })), "`Bash` `npm test`");
	});

	it("cuts the JSON fallback of an input with no command, file or URL to 80 characters", () => {
		const shown = askedText(held("Custom", { payload: "x".repeat(200) }));
		const json = shown.slice("`Custom` `".length, -"`".length);
		assert.equal(json.length, 80);
		assert.ok(json.endsWith("…"), json);
	});

	it("keeps the logged decision short for a multi-line command", () => {
		const taken = takeAnswer(held("Bash", { command: SCRIPT }), { request: "req-00000001", decision: "allow", reason: "the Brief covers it" });
		assert.equal(typeof taken, "object");
		if (typeof taken === "string") return;
		assert.equal(taken.logged[0], "allowed dev-1's `Bash` `set -euo pipefail…`: the Brief covers it");
	});
});

describe("a held request's full input to the Lead", () => {
	it("prompts the Lead with the whole command, not the first line", () => {
		const prompt = askText(held("Bash", { command: SCRIPT, description: "Run the script" }));
		assert.ok(prompt.includes(JSON.stringify({ command: SCRIPT, description: "Run the script" }, null, 2)), prompt);
		assert.ok(prompt.includes("step 28"), "the middle of the script is missing");
		assert.ok(prompt.includes("echo done-for-real"), "the last line of the script is missing");
	});
});

describe("rule matching reads the full value", () => {
	it("matches a prefix rule against a command past the displayed length", () => {
		const command = `custom-tool run ${"arg ".repeat(60)}`;
		assert.equal(matchesRule("Custom(custom-tool run:*)", "Custom", { command }), true);
	});
});
