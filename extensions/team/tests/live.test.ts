/**
 * The live runner's pure parts, and its harness against the fake `claude`.
 * The runner itself (`../test.ts`, `npm run live:team`) drives the real one and
 * is never reached from here.
 */

import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Case, CASES, hookLines, journalLines, LiveEffort, MANUAL, parseArgs, runCases } from "../test.ts";
import { fakeClaude, tempRoots } from "./harness.ts";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const LIVE_RUNNER = "extensions/team/test.ts";

describe("the live runner's arguments", () => {
	it("defaults to every case on the claude on the PATH", () => {
		assert.deepEqual(parseArgs([], {}), { claude: "claude", only: [], list: false });
	});

	it("takes the executable from CLAUDE_PATH, and cases and a model from flags", () => {
		assert.deepEqual(parseArgs(["--only", "inbox,clear", "--model", "haiku"], { CLAUDE_PATH: "/opt/claude" }), { claude: "/opt/claude", only: ["inbox", "clear"], model: "haiku", list: false });
		assert.equal((parseArgs(["--list"], {}) as { list: boolean }).list, true);
	});

	it("refuses an unknown flag or a flag without its value", () => {
		assert.match((parseArgs(["--bogus"], {}) as { error: string }).error, /unknown argument `--bogus`/);
		assert.match((parseArgs(["--only"], {}) as { error: string }).error, /`--only` needs a value/);
		assert.match((parseArgs(["--model", "--list"], {}) as { error: string }).error, /`--model` needs a value/);
	});
});

describe("the live runner's cases", () => {
	it("covers the cases the spec lists, each named once", () => {
		const names = CASES.map((each) => each.name);
		assert.equal(new Set(names).size, names.length);
		for (const wanted of ["inbox", "clear", "ask", "floor", "statusline", "wake", "fragile"]) assert.ok(names.includes(wanted), `no ${wanted} case`);
		assert.ok(MANUAL.length > 0);
	});

	it("reads a journal leniently and picks hook lines by event", () => {
		const lines = journalLines('{"from":"hook","event":"Stop"}\n{"from":"mod","event":"Stop"}\nnot json\n{"from":"hook","ev');

		assert.equal(lines.length, 2);
		assert.equal(hookLines(lines, "Stop").length, 1);
	});

	it("is not reachable from `npm test`, and `live:team` runs it", () => {
		const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

		assert.ok(existsSync(join(REPO_ROOT, LIVE_RUNNER)));
		assert.ok((manifest.scripts["live:team"] ?? "").includes(LIVE_RUNNER));
		const globs = manifest.scripts.test.split(/\s+/).filter((argument) => argument.includes("*"));
		const suite = globs.flatMap((glob) => globSync(glob, { cwd: REPO_ROOT }));
		assert.ok(suite.length > 0);
		assert.ok(!suite.includes(LIVE_RUNNER), "the runner is in what `npm test` runs");
	});
});

describe("running cases against the fake claude", () => {
	function effort(options: Parameters<typeof fakeClaude>[1] = {}) {
		const roots = tempRoots();
		const claude = fakeClaude(roots, options);
		return { claude, live: new LiveEffort(claude.path, undefined, roots.claudeConfigPath, roots.claudeDir, join(roots.scratch, "live")) };
	}

	it("prints ok or FAIL per case and stops every session it launched, even when a case fails", async () => {
		const { claude, live } = effort({ hooks: [{ event: "SessionStart" }] });
		await live.open();
		const failing: Case = {
			name: "failing",
			about: "launches, then fails",
			async run(each) {
				const teammate = await each.launch("go");
				await teammate.started();
				throw new Error("deliberate");
			},
		};
		const passing: Case = { name: "passing", about: "does nothing", async run() {} };
		const printed: string[] = [];

		const failures = await runCases([failing, passing], live, (line) => printed.push(line));
		live.finish();

		assert.equal(failures, 1);
		assert.match(printed[0], /^FAIL {2}failing: deliberate/);
		assert.match(printed[1], /^ok {4}passing/);
		assert.ok(claude.calls().some((call) => call[0] === "stop"), `no claude stop in ${JSON.stringify(claude.calls())}`);
	});

	it("runs the fragile-dependency case: version and get_usage", async () => {
		const { live } = effort({ usage: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 12, resets_at: "2030-01-01T00:00:00Z" } } } });
		const printed: string[] = [];

		const failures = await runCases(CASES.filter((each) => each.name === "fragile"), live, (line) => printed.push(line));
		live.finish();

		assert.equal(failures, 0, printed.join("\n"));
	});
});
