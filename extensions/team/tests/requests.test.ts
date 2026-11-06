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

describe("what the floor read, in the wake and the refusal (#145)", () => {
	const JOB = "/home/u/.claude/jobs/510ce9d9";
	const FOLDERS = { workspace: "/work/app-ws", jobDir: JOB, roots: [`${JOB}/tmp`, "/tmp/claude/scratchpad"] };
	const OWN = "(its Workspace, job temp folder and scratchpad)";
	function bash(command: string): HeldRequest {
		return { ...held("Bash", { command }), cwd: "/work/app-ws", scratchpad: "/tmp/claude/scratchpad" };
	}
	/** As in the dogfood Effort: a delete through a name the floor can't read, here one set from a command's output. */
	const UNREAD = `cd /work/app-ws\nQ=$(cat qa.path)\nrm -f $Q/merge.json $Q/merged.out\nK(){ node bin/kv.js --file "$Q/merge.json" "$@"; }\nK set extra 1`;

	it("names the Teammate's own folders, each with its path, in the wake about a floor delete", () => {
		const text = askText(bash("rm -rf /etc/app"), FOLDERS);
		assert.match(text, /The floor reads it as a delete outside dev-1's own folders \(`rm -rf \/etc\/app`\)/);
		assert.ok(text.includes("its Workspace `/work/app-ws`, its job temp folder `/home/u/.claude/jobs/510ce9d9/tmp` and its scratchpad `/tmp/claude/scratchpad`"), text);
		assert.doesNotMatch(text, /can't read/);
	});

	it("says the floor couldn't read the target of a delete through a name, rather than calling the folder outside", () => {
		const text = askText(bash(UNREAD), FOLDERS);
		assert.match(text, /The floor reads it as a delete whose target it can't read \(`rm -f \$Q\/merge\.json \$Q\/merged\.out`\)/);
		assert.match(text, /not because the folder is outside/);
		assert.match(text, /write the path out/);
		assert.ok(text.includes("its job temp folder `/home/u/.claude/jobs/510ce9d9/tmp`"), text);
	});

	it("reads a delete of a whole top-level folder as outside, not as a target it can't read", () => {
		assert.doesNotMatch(askText(bash("rm -rf /tmp"), FOLDERS), /can't read/);
	});

	it("says nothing of the floor for a delete it reads inside the Teammate's own folders, or for no floor action", () => {
		for (const command of [`rm -f ${JOB}/tmp/qa/merge.json`, "rm -rf build", "rm -rf /tmp/claude/scratchpad/clone", "npm test"]) {
			assert.doesNotMatch(askText(bash(command), FOLDERS), /The floor reads/, command);
		}
	});

	it("names another floor kind and the command it read", () => {
		assert.match(askText(bash("npm test && git push origin HEAD"), FOLDERS), /The floor reads it as a push \(`git push origin HEAD`\)/);
	});

	it("names a job temp folder it doesn't know by `$CLAUDE_JOB_DIR/tmp`, and a scratchpad the request didn't name as none", () => {
		const text = askText({ ...bash("rm -rf /etc/app"), scratchpad: undefined }, { workspace: "/work/app-ws" });
		assert.ok(text.includes("its Workspace `/work/app-ws`, its job temp folder `$CLAUDE_JOB_DIR/tmp` and its scratchpad (none named in this request)"), text);
	});

	it("refuses an uncited allow of a floor delete as outside the Teammate's own folders, saying when it can't read the target", () => {
		const terms = { ...FOLDERS, grants: [], escalate: [] };
		const outside = takeAnswer(bash("rm -rf /etc/app"), { request: "req-00000001", decision: "allow", reason: "scratch", terms });
		assert.equal(typeof outside, "string");
		assert.ok(String(outside).includes(`a delete outside dev-1's own folders ${OWN}`), String(outside));
		const unread = takeAnswer(bash(UNREAD), { request: "req-00000001", decision: "allow", reason: "scratch", terms });
		assert.match(String(unread), /floor delete/);
		assert.ok(String(unread).includes(`can't read, so it counts as outside dev-1's own folders ${OWN}`), String(unread));
	});
});
