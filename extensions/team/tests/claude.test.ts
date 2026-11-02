/**
 * The Claude adapter's version check, against the fake `claude`.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MIN_CLAUDE_VERSION, versionWarning } from "../claude.ts";
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
