/**
 * The git evidence a restart reads to finish a merge that was under way when
 * pi stopped, and the processes found still running in a worktree as it is
 * removed, in real git repos under a temp root.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { addTaskWorkspace, addWorkspace, endWorktrees, mergeEvidence, mergeTaskWorkspace, removeTaskWorkspace, runningIn } from "../workspace.ts";
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

/**
 * Start `sleep 300` detached in `cwd`, as a Teammate's `&` leaves a server
 * behind, and kill it when the test ends.
 */
function leaveRunning(t: TestContext, cwd: string): number {
	const child = spawn("sleep", ["300"], { cwd, detached: true, stdio: "ignore" });
	child.unref();
	const pid = child.pid;
	assert.ok(pid !== undefined, "sleep didn't start");
	t.after(() => {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Gone already.
		}
	});
	return pid;
}

describe("processes still running in a worktree when it is removed", () => {
	it("names, by pid and command, a detached process left running in the Effort's Workspace as sign-off removes it, and doesn't stop it", (t) => {
		const { repo, workspace } = effortWithTask();
		const pid = leaveRunning(t, workspace.path);

		const { removed } = endWorktrees(repo, "software-2026-11-02");

		const ended = removed.find((each) => each.path === workspace.path);
		assert.deepEqual(ended?.running, [{ pid, command: "sleep 300" }]);
		assert.equal(existsSync(workspace.path), false, "the worktree is removed all the same");
		assert.doesNotThrow(() => process.kill(pid, 0), "the process is left running");
	});

	it("names one left running in an isolated Task's worktree as an accept or a drop removes it, and doesn't stop it", (t) => {
		const { workspace, task, merge } = effortWithTask();
		assert.ok(!("error" in mergeTaskWorkspace(merge)));
		const pid = leaveRunning(t, join(task.path, ".."));
		const inside = leaveRunning(t, task.path);

		const removed = removeTaskWorkspace(workspace.path, task);

		assert.deepEqual(removed, { running: [{ pid: inside, command: "sleep 300" }] });
		assert.equal(existsSync(task.path), false, "the worktree is removed all the same");
		assert.doesNotThrow(() => process.kill(inside, 0), "the process is left running");
		assert.doesNotThrow(() => process.kill(pid, 0));
	});
});

describe("which processes count as running in a worktree", () => {
	it("is none for a worktree nothing runs in", () => {
		const { repo, workspace, task } = effortWithTask();

		const { removed } = endWorktrees(repo, "software-2026-11-02");

		assert.deepEqual(
			removed.map((each) => [each.path, each.running]),
			[
				[workspace.path, []],
				[task.path, []],
			],
		);
	});

	it("matches a folder spelled through a symlink (`/var` for `/private/var` on macOS) and one inside it, but not a sibling that shares its name's start", (t) => {
		const roots = tempRoots();
		const dir = join(roots.scratch, "wt");
		mkdirSync(join(dir, "src"), { recursive: true });
		mkdirSync(join(roots.scratch, "wt2"));
		const alias = join(roots.scratch, "alias");
		symlinkSync(dir, alias);
		const deep = leaveRunning(t, join(dir, "src"));
		leaveRunning(t, join(roots.scratch, "wt2"));

		assert.deepEqual(runningIn(alias), [{ pid: deep, command: "sleep 300" }]);
		assert.deepEqual(runningIn(`${dir}/`), [{ pid: deep, command: "sleep 300" }]);
	});

	it("is none, without failing, when `lsof` can't run", (t) => {
		const { workspace } = effortWithTask();
		leaveRunning(t, workspace.path);

		assert.deepEqual(runningIn(workspace.path, join(workspace.path, "no-such-lsof")), []);
	});
});
