/**
 * The Claude adapter's version check, against the fake `claude`.
 */

import assert from "node:assert/strict";
import { lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { agentsList, launchBackground, MIN_CLAUDE_VERSION, stopBackground, trustFolder, versionWarning } from "../claude.ts";
import { fakeClaude, tempRoots } from "./harness.ts";

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
