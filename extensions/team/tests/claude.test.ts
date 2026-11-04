/**
 * The Claude adapter's version check, against the fake `claude`.
 */

import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { agentPids, agentsList, BUNDLED_MOD, CLEAR_MARKER, getUsage, humanStatusLine, installMod, launchBackground, MIN_CLAUDE_VERSION, statusLineReading, stopBackground, trustFolder, versionWarning } from "../claude.ts";
import { fakeClaude, tempRoots, writeFiles } from "./harness.ts";

describe("the claude version check", () => {
	it("says nothing about the pinned version or a newer one", async () => {
		const roots = tempRoots();

		assert.equal(await versionWarning(fakeClaude(roots, { version: `${MIN_CLAUDE_VERSION} (Claude Code)` }).path), undefined);
		assert.equal(await versionWarning(fakeClaude(roots, { version: "2.10.0 (Claude Code)" }).path), undefined);
		assert.equal(await versionWarning(fakeClaude(roots, { version: "3.0.0 (Claude Code)" }).path), undefined);
	});

	it("warns about an older claude, naming both versions", async () => {
		const claude = fakeClaude(tempRoots(), { version: "2.1.99 (Claude Code)" });

		const warning = await versionWarning(claude.path);

		assert.match(warning ?? "", /claude 2\.1\.99 is older than 2\.1\.316/);
		assert.deepEqual(claude.calls(), [["--version"]]);
	});

	it("warns, naming the path, when there is no claude to run", async () => {
		const missing = join(tempRoots().scratch, "no-such-claude");

		const warning = await versionWarning(missing);

		assert.match(warning ?? "", new RegExp(`could not run \`${missing}\` --version`));
	});

	it("warns when what --version printed has no version in it", async () => {
		const warning = await versionWarning(fakeClaude(tempRoots(), { version: "Claude Code" }).path);

		assert.match(warning ?? "", /could not read a version from `.*` --version: "Claude Code"/);
	});
});

describe("folder trust in Claude Code's config", () => {
	it("leaves the file byte for byte as it was when the repo is already trusted", () => {
		const roots = tempRoots();
		const text = '{"projects":{"/repo":{"hasTrustDialogAccepted":true}},  "theme":"dark"}';
		writeFileSync(roots.claudeConfigPath, text);

		assert.equal(trustFolder(roots.claudeConfigPath, "/repo"), undefined);

		assert.equal(readFileSync(roots.claudeConfigPath, "utf8"), text);
	});

	it("writes through a symlinked config, keeping the link and the file's permissions", () => {
		const roots = tempRoots();
		const real = join(roots.scratch, "claude.json");
		writeFileSync(real, '{"theme":"dark"}', { mode: 0o600 });
		symlinkSync(real, roots.claudeConfigPath);

		assert.equal(trustFolder(roots.claudeConfigPath, "/repo"), undefined);

		assert.equal(lstatSync(roots.claudeConfigPath).isSymbolicLink(), true);
		assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { theme: "dark", projects: { "/repo": { hasTrustDialogAccepted: true } } });
		assert.equal(statSync(real).mode & 0o777, 0o600);
	});

	it("refuses a config whose `projects` isn't an object, changing nothing", () => {
		const roots = tempRoots();
		writeFileSync(roots.claudeConfigPath, '{"projects":[]}');

		assert.match(trustFolder(roots.claudeConfigPath, "/repo")?.error ?? "", /`projects`/);
		assert.equal(readFileSync(roots.claudeConfigPath, "utf8"), '{"projects":[]}');
	});
});

describe("background sessions in `claude agents --json`", () => {
	it("lists each live session by its `--name`, with its status, state and what it waits for", async () => {
		const roots = tempRoots();
		const claude = fakeClaude(roots);
		assert.equal(await launchBackground(claude.path, roots.scratch, ["--bg", "--name", "team-e-dev-1", "go"]), undefined);
		claude.setAgent("team-e-dev-1", { state: "waiting", waitingFor: "permission" });

		const listed = await agentsList(claude.path);
		assert.ok(!("error" in listed), "error" in listed ? listed.error : "");
		assert.deepEqual(listed.get("team-e-dev-1"), { status: "running", state: "waiting", waitingFor: "permission" });

		claude.idleStop("team-e-dev-1");
		const after = await agentsList(claude.path);
		assert.ok(!("error" in after));
		assert.equal(after.get("team-e-dev-1"), undefined, "an idle-stopped session is missing");
	});

	it("gives the pid of each live session's own process by its `--name`, and none once it is gone or the list can't be read", async () => {
		const roots = tempRoots();
		const claude = fakeClaude(roots, { hooks: [] });
		assert.equal(await launchBackground(claude.path, roots.scratch, ["--bg", "--name", "team-e-dev-1", "go"]), undefined);
		const [agent] = claude.agents();

		assert.ok(agent.pid !== undefined);
		assert.deepEqual(await agentPids(claude.path), new Map([["team-e-dev-1", agent.pid]]));
		claude.idleStop("team-e-dev-1");
		assert.deepEqual(await agentPids(claude.path), new Map());
		assert.deepEqual(await agentPids(join(roots.scratch, "no-such-claude")), new Map());
	});

	it("stops a session by its short id with `claude stop`", async () => {
		const roots = tempRoots();
		const claude = fakeClaude(roots);
		await launchBackground(claude.path, roots.scratch, ["--bg", "--name", "team-e-dev-1", "go"]);
		const [agent] = claude.agents();

		assert.equal(await stopBackground(claude.path, agent.id.slice(0, 8)), undefined);
		assert.deepEqual(claude.calls().at(-1), ["stop", agent.id.slice(0, 8)]);
		assert.equal(claude.agents()[0].live, false);
		assert.match((await stopBackground(claude.path, "00000000"))?.error ?? "", /no running session/);
	});
});

describe("the Team's mod, loaded from a per-user copy", () => {
	const MOD = { ".claude-plugin/plugin.json": '{ "name": "team" }\n', "hooks/hooks.json": '{ "modules": ["./register.ts"] }\n', "hooks/register.ts": "// one\n" };

	it("copies the bundled mod to `<agentDir>/team/mod`, which is what `--plugin-dir` names", () => {
		const roots = tempRoots();
		const bundled = writeFiles(join(roots.scratch, "bundled"), MOD);

		const dir = installMod(roots.agentDir, bundled);

		assert.equal(dir, join(roots.agentDir, "team", "mod"));
		for (const [path, content] of Object.entries(MOD)) assert.equal(readFileSync(join(dir, path), "utf8"), content);
	});

	it("leaves the copy as it is while the bundled content is unchanged, whatever tsconfig.json loading it wrote", () => {
		const roots = tempRoots();
		const bundled = writeFiles(join(roots.scratch, "bundled"), MOD);
		const dir = installMod(roots.agentDir, bundled);
		writeFileSync(join(dir, "tsconfig.json"), "{}\n");
		writeFileSync(join(bundled, "tsconfig.json"), '{ "strict": true }\n');

		installMod(roots.agentDir, bundled);

		assert.equal(readFileSync(join(dir, "tsconfig.json"), "utf8"), "{}\n");
	});

	it("refreshes the copy once the bundled content changes, dropping files the bundle no longer has", () => {
		const roots = tempRoots();
		const bundled = writeFiles(join(roots.scratch, "bundled"), { ...MOD, "hooks/old.ts": "// old\n" });
		const dir = installMod(roots.agentDir, bundled);
		unlinkSync(join(bundled, "hooks", "old.ts"));
		writeFileSync(join(bundled, "hooks", "register.ts"), "// two\n");

		installMod(roots.agentDir, bundled);

		assert.equal(readFileSync(join(dir, "hooks", "register.ts"), "utf8"), "// two\n");
		assert.equal(existsSync(join(dir, "hooks", "old.ts")), false);
	});

	it("bundles a mod whose hooks module turns the clear marker into a `/clear`", () => {
		const register = readFileSync(join(BUNDLED_MOD, "hooks", "register.ts"), "utf8");

		assert.ok(register.includes(CLEAR_MARKER), register);
		assert.deepEqual(JSON.parse(readFileSync(join(BUNDLED_MOD, "hooks", "hooks.json"), "utf8")), { modules: ["./register.ts"] });
	});
});

describe("the human's own status line command", () => {
	const statusLine = (command: string) => JSON.stringify({ statusLine: { type: "command", command, padding: 0 } });

	it("is the one Claude Code would run in the Workspace: local settings over project settings over the human's own", () => {
		const roots = tempRoots();
		const workspace = join(roots.scratch, "workspace");
		writeFiles(roots.claudeDir, { "settings.json": statusLine("~/bin/user-status") });
		assert.equal(humanStatusLine(workspace, roots.claudeDir), "~/bin/user-status");

		writeFiles(workspace, { ".claude/settings.json": statusLine("./project-status.sh") });
		assert.equal(humanStatusLine(workspace, roots.claudeDir), "./project-status.sh");

		writeFiles(workspace, { ".claude/settings.local.json": statusLine("./local-status.sh") });
		assert.equal(humanStatusLine(workspace, roots.claudeDir), "./local-status.sh");
	});

	it("is none when no settings file has a status line command, skipping files that aren't JSON", () => {
		const roots = tempRoots();
		const workspace = join(roots.scratch, "workspace");
		assert.equal(humanStatusLine(workspace, roots.claudeDir), undefined);

		writeFiles(workspace, { ".claude/settings.local.json": "{ not json", ".claude/settings.json": JSON.stringify({ statusLine: { type: "static" } }) });
		writeFiles(roots.claudeDir, { "settings.json": JSON.stringify({ model: "opus" }) });
		assert.equal(humanStatusLine(workspace, roots.claudeDir), undefined);
	});
});

describe("usage readings", () => {
	const AT = "2026-11-02T10:00:00.000Z";

	it("reads a status line's JSON: the account's windows, the session's tokens, estimate and context", () => {
		const json = JSON.stringify({
			session_id: "sess-1",
			context_window: { total_input_tokens: 41_000, total_output_tokens: 900, used_percentage: 21 },
			rate_limits: { five_hour: { used_percentage: 12.4, resets_at: 1_793_617_200 }, seven_day: { used_percentage: 73, resets_at: 1_793_955_600 } },
			cost: { total_cost_usd: 0.42 },
		});

		assert.deepEqual(statusLineReading(json, "dev-1", AT), {
			source: "status-line",
			at: AT,
			teammate: "dev-1",
			sessionId: "sess-1",
			rateLimits: true,
			fiveHour: { percent: 12.4, resetsAt: "2026-11-02T11:00:00.000Z" },
			sevenDay: { percent: 73, resetsAt: "2026-11-06T09:00:00.000Z" },
			tokens: 41_900,
			costUsd: 0.42,
			ctx: 21,
		});
	});

	it("reads a status line without rate_limits, as an API key's, and leaves out what it doesn't say", () => {
		const json = JSON.stringify({ session_id: "sess-2", context_window: { total_input_tokens: 10, total_output_tokens: 5, used_percentage: null }, cost: { total_cost_usd: 1.5 } });

		assert.deepEqual(statusLineReading(json, "dev-2", AT), { source: "status-line", at: AT, teammate: "dev-2", sessionId: "sess-2", rateLimits: false, tokens: 15, costUsd: 1.5 });
		assert.equal(statusLineReading("{ half", "dev-2", AT), undefined);
		assert.equal(statusLineReading("[]", "dev-2", AT), undefined);
	});

	it("asks claude -p for get_usage over stream-json, with no prompt, and reads the account's windows", async () => {
		const claude = fakeClaude(tempRoots(), {
			usage: {
				subscription_type: "max",
				rate_limits_available: true,
				rate_limits: { five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 73, resets_at: "2026-11-06T09:00:00.000Z" } },
				session: { total_cost_usd: 0 },
			},
		});

		assert.deepEqual(await getUsage(claude.path, AT), { source: "get-usage", at: AT, rateLimits: true, sevenDay: { percent: 73, resetsAt: "2026-11-06T09:00:00.000Z" } });
		assert.deepEqual(claude.calls(), [["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]]);
	});

	it("reads no windows from an API key's get_usage, and an error from a failed or unanswered one", async () => {
		const roots = tempRoots();
		const apiKey = fakeClaude(roots, { usage: { subscription_type: null, rate_limits_available: false, rate_limits: null, session: { total_cost_usd: 0 } } });
		assert.deepEqual(await getUsage(apiKey.path, AT), { source: "get-usage", at: AT, rateLimits: false });

		const unscripted = await getUsage(fakeClaude(roots).path, AT);
		assert.match("error" in unscripted ? unscripted.error : "", /get_usage/);

		const missing = await getUsage(join(roots.scratch, "no-such-claude"), AT);
		assert.match("error" in missing ? missing.error : "", /get_usage/);
	});
});
