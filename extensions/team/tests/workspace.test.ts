/**
 * The git evidence a restart reads to finish a merge that was under way when
 * pi stopped, in real git repos under a temp root.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addTaskWorkspace, addWorkspace, mergeEvidence, mergeTaskWorkspace } from "../workspace.ts";
import { commit, git, gitRepo, tempRoots } from "./harness.ts";

/** A repo with an Effort Workspace and one isolated Task's worktree off it, the Task's commit on its branch. */
function effortWithTask(change = "colour → color\n") {
	const roots = tempRoots();
	const repo = gitRepo(roots);
	const added = addWorkspace("git-worktree", repo, "software-2026-11-02");
	assert.ok(!("error" in added), "error" in added ? added.error : "");
	const workspace = added.workspace;
	const task = { path: `${workspace.path}-task-001`, branch: `${workspace.branch}-task-001` };
	const cut = addTaskWorkspace(repo, { ...task, from: workspace.branch });
	assert.ok(!("error" in cut), "error" in cut ? cut.error : "");
	commit(task.path, { "NOTES.md": change }, "Rename the key");
	return { repo, workspace, task, merge: { into: workspace.path, ...task, slug: "rename", folder: "001-dev-rename" } };
}

describe("where a merge cut short by a restart stands", () => {
	it("is not started while the Task's branch isn't in the Effort branch", () => {
		const { workspace, task } = effortWithTask();

		assert.deepEqual(mergeEvidence(workspace.path, task.branch), { state: "not-started" });
	});

	it("is merged, by its merge commit, once the branch is in", () => {
		const { workspace, task, merge } = effortWithTask();
		const merged = mergeTaskWorkspace(merge);
		assert.ok(!("error" in merged) && merged.commit !== undefined);

		assert.deepEqual(mergeEvidence(workspace.path, task.branch), { state: "merged", commit: merged.commit });
	});

	it("is merged with no commit when the branch had nothing new", () => {
		const { workspace, task } = effortWithTask();
		git(task.path, "reset", "-q", "--hard", "HEAD~1");

		assert.deepEqual(mergeEvidence(workspace.path, task.branch), { state: "merged" });
	});

	it("is half-done while `MERGE_HEAD` is left behind, and merging again with `abort` clears it first", () => {
		const { workspace, task, merge } = effortWithTask();
		commit(workspace.path, { "NOTES.md": "colour stays\n" }, "Meanwhile on the Effort branch");
		assert.throws(() => git(workspace.path, "merge", "--no-ff", "--no-edit", task.branch));

		assert.deepEqual(mergeEvidence(workspace.path, task.branch), { state: "half-done" });
		const again = mergeTaskWorkspace({ ...merge, abort: true });
		assert.ok("error" in again && again.error.includes("NOTES.md"), JSON.stringify(again));
		assert.deepEqual(mergeEvidence(workspace.path, task.branch), { state: "not-started" });
	});

	it("can't be told when the branch is gone", () => {
		const { workspace } = effortWithTask();

		assert.equal(mergeEvidence(workspace.path, "team/software-2026-11-02-task-009"), undefined);
		assert.equal(mergeEvidence(join(workspace.path, "missing"), "main"), undefined);
	});
});
