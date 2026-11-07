/**
 * An Effort's end: what becomes of its worktrees, and what the Lead is told.
 * The full sign-off and cancel flows, with real worktrees, are in
 * index.test.ts.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { endedLeadText, endEffortWorktrees, type WorktreesEnded } from "../ending.ts";
import { gitRepo, tempRoots } from "./harness.ts";

const AT = "2026-11-02T10:00:00.000Z";
const NONE = async () => [];

describe("endEffortWorktrees", () => {
	it("records a git failure as the line's error rather than throwing", async () => {
		const { scratch } = tempRoots();
		const ended = await endEffortWorktrees(join(scratch, "not-a-repo"), "software-2026-11-02", [], NONE, AT);
		assert.equal(ended.type, "worktrees-ended");
		assert.deepEqual([ended.removed, ended.kept, ended.at], [[], [], AT]);
		assert.equal(typeof ended.error, "string");
	});

	it("removes nothing while a Teammate didn't stop", async () => {
		const repo = gitRepo(tempRoots());
		const ended = await endEffortWorktrees(repo, "software-2026-11-02", ["`dev-1` (no such session)"], NONE, AT);
		assert.deepEqual(ended, { type: "worktrees-ended", removed: [], kept: [], at: AT });
	});
});

describe("endedLeadText", () => {
	const line = (over: Partial<WorktreesEnded>): WorktreesEnded => ({ type: "worktrees-ended", removed: [], kept: [], at: AT, ...over });

	it("says the session holds no Effort now", () => {
		assert.equal(endedLeadText("Signed off.", [], line({})), "Signed off. This session holds no Effort now, so the Team tools are off.");
	});

	it("warns off a removed worktree", () => {
		const text = endedLeadText("Signed off.", ["Removed the clean worktrees /w."], line({ removed: [{ path: "/w", branch: "team/x", running: [] }] }));
		assert.match(text, /^Signed off\. Removed the clean worktrees \/w\. A removed worktree is gone: don't `cd` into it/);
		assert.doesNotMatch(text, /Never stop a process/);
	});

	it("tells the Lead never to stop a process still running in a worktree itself", () => {
		const text = endedLeadText("Cancelled.", [], line({ kept: [{ path: "/w", branch: "team/x", running: [{ pid: 42, command: "node serve.js" }], why: "it has uncommitted changes" }] }));
		assert.match(text, /Never stop a process named here yourself: tell the human, who decides\./);
	});
});
