/**
 * The Claude adapter's version check, against the fake `claude`.
 */

import assert from "node:assert/strict";
import { lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MIN_CLAUDE_VERSION, trustFolder, versionWarning } from "../claude.ts";
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
