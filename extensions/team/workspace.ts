/**
 * The Workspace: where an Effort's Teammates work, apart from the human's own
 * checkout. This is the one module that changes the human's repo through git.
 *
 * The kind comes from `team.md`'s `workspace`, and `git-worktree` is the only
 * kind: branch `team/<effort-id>` cut from the local default branch's tip,
 * checked out as a worktree at `<repo>/.claude/worktrees/team-<effort-id>/`,
 * where Claude Code keeps its own worktrees. Nothing here checks out, stages or
 * writes anything in the human's working tree, beyond the local exclude entry
 * that keeps the worktrees folder out of their `git status`.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { MergeEvidence, Workspace } from "./core.ts";
import type { WorkspaceKind } from "./definitions.ts";

/** The folder the worktrees go in, relative to the repo root, as a gitignore pattern for that folder. */
const WORKTREES = ".claude/worktrees/";

/** The file listing what Claude Code copies into each new worktree, at the repo root. */
const WORKTREE_INCLUDE = ".worktreeinclude";

/** A git failure, carrying git's own first line of complaint. */
class GitError extends Error {}

function git(cwd: string, args: string[], input?: string): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		const reason = stderr || (error instanceof Error ? error.message : String(error));
		throw new GitError(`\`git ${args.join(" ")}\` failed: ${reason.split("\n")[0]}`);
	}
}

/** Whether `git` succeeds, for the questions git answers with its exit code. */
function gitSucceeds(cwd: string, args: string[]): boolean {
	try {
		git(cwd, args);
		return true;
	} catch {
		return false;
	}
}

function hasBranch(repo: string, branch: string): boolean {
	return gitSucceeds(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

/**
 * The repo's default branch, as a local branch. `origin/HEAD` names it when
 * the repo has a remote; otherwise git's `init.defaultBranch`, then `main`,
 * then `master`. The human's current branch is never the answer by default,
 * since the Effort starts from what the repo ships, not from their work in
 * progress.
 */
function defaultBranch(repo: string): string {
	let remote: string | undefined;
	try {
		remote = git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).trim();
	} catch {
		remote = undefined;
	}
	if (remote) {
		const name = remote.replace(/^origin\//, "");
		if (hasBranch(repo, name)) return name;
		throw new GitError(
			`the repo's default branch is \`${name}\` (from \`origin/HEAD\`), but there is no local branch \`${name}\` to cut the Effort's branch from; create it with \`git branch ${name} ${remote}\``,
		);
	}
	let configured: string | undefined;
	try {
		configured = git(repo, ["config", "init.defaultBranch"]).trim() || undefined;
	} catch {
		configured = undefined;
	}
	const candidates = [...new Set([configured, "main", "master"].filter((name): name is string => name !== undefined))];
	const found = candidates.find((name) => hasBranch(repo, name));
	if (found) return found;
	throw new GitError(
		`can't tell the repo's default branch: there is no \`origin/HEAD\` and no local branch ${candidates.map((name) => `\`${name}\``).join(", ")}${gitSucceeds(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]) ? "" : " (the repo has no commits yet)"}; commit to the default branch first, or point \`origin/HEAD\` at it with \`git remote set-head origin <branch>\``,
	);
}

/** Add `.claude/worktrees/` to the repo's local exclude, unless git already ignores it. */
function excludeWorktrees(repo: string): void {
	if (gitSucceeds(repo, ["check-ignore", "--quiet", "--", WORKTREES])) return;
	const printed = git(repo, ["rev-parse", "--git-path", "info/exclude"]).trim();
	const exclude = isAbsolute(printed) ? printed : join(repo, printed);
	mkdirSync(dirname(exclude), { recursive: true });
	const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
	appendFileSync(exclude, `${before === "" || before.endsWith("\n") ? "" : "\n"}${WORKTREES}\n`);
}

/**
 * Copy what `.worktreeinclude` lists into the new worktree, as Claude Code
 * does: the file uses gitignore syntax, and only files that match it and are
 * also ignored by git are copied, so a tracked file is never duplicated and an
 * untracked file the human hasn't ignored is never carried along.
 */
function copyIncluded(repo: string, worktree: string): string[] {
	const include = join(repo, WORKTREE_INCLUDE);
	if (!existsSync(include)) return [];
	const matching = git(repo, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${include}`]);
	if (matching === "") return [];
	let ignored: string;
	try {
		ignored = git(repo, ["check-ignore", "-z", "--stdin"], matching);
	} catch {
		// check-ignore exits 1 when none of the paths is ignored.
		return [];
	}
	const copied = ignored.split("\0").filter(Boolean);
	for (const path of copied) {
		mkdirSync(dirname(join(worktree, path)), { recursive: true });
		cpSync(join(repo, path), join(worktree, path));
	}
	return copied;
}

/** Where a git-worktree Workspace for `effortId` goes in `repo`, and its branch. */
export function workspaceFor(repo: string, effortId: string): { path: string; branch: string } {
	return { path: join(repo, ".claude", "worktrees", `team-${effortId}`), branch: `team/${effortId}` };
}

/**
 * Add the Workspace of kind `kind` for Effort `effortId` in `repo`, or say why
 * it can't be added. Nothing is left behind on a refusal that git reports
 * before the branch is cut.
 */
export function addWorkspace(kind: WorkspaceKind, repo: string, effortId: string): { workspace: Workspace; copied: string[] } | { error: string } {
	switch (kind) {
		case "git-worktree":
			return addWorktree(repo, effortId);
	}
}

function addWorktree(repo: string, effortId: string): { workspace: Workspace; copied: string[] } | { error: string } {
	const { path, branch } = workspaceFor(repo, effortId);
	try {
		const from = defaultBranch(repo);
		if (hasBranch(repo, branch)) {
			throw new GitError(`branch \`${branch}\` already exists; an Effort's branch is its own, so delete it (\`git branch -D ${branch}\`) only if nothing on it is wanted`);
		}
		if (existsSync(path)) throw new GitError(`${path} already exists; move it away (or \`git worktree remove\` it) first`);
		const base = git(repo, ["rev-parse", "--verify", `refs/heads/${from}^{commit}`]).trim();
		excludeWorktrees(repo);
		git(repo, ["worktree", "add", "--quiet", "-b", branch, path, base]);
		const copied = copyIncluded(repo, path);
		return { workspace: { kind: "git-worktree", path, branch, base, from }, copied };
	} catch (error) {
		if (error instanceof GitError) return { error: error.message };
		throw error;
	}
}

/**
 * Add an isolated Task's worktree at `path` on new branch `branch`, cut from
 * the Effort branch `from`'s tip, beside the Workspace rather than in it, and
 * copy what the repo's `.worktreeinclude` lists into it, as for the Workspace.
 */
export function addTaskWorkspace(repo: string, task: { path: string; branch: string; from: string }): { copied: string[] } | { error: string } {
	try {
		if (hasBranch(repo, task.branch)) throw new GitError(`branch \`${task.branch}\` already exists`);
		if (existsSync(task.path)) throw new GitError(`${task.path} already exists`);
		git(repo, ["worktree", "add", "--quiet", "-b", task.branch, task.path, task.from]);
		return { copied: copyIncluded(repo, task.path) };
	} catch (error) {
		if (error instanceof GitError) return { error: error.message };
		throw error;
	}
}

/**
 * Merge an isolated Task's branch into the Effort's Workspace at `into` with
 * `--no-ff`: the merge commit, or undefined when the branch is in already.
 * Refused, with nothing merged, while either worktree has uncommitted changes
 * (the Workspace's would mix into the merge; the Task's would be left out of
 * it) and on a conflict, which is aborted so no half-merge stays behind.
 * With `abort`, a half-merge a restart left behind is aborted first.
 */
export function mergeTaskWorkspace(merge: { into: string; path: string; branch: string; slug: string; folder: string; abort?: boolean }): { commit?: string } | { error: string } {
	try {
		// A merge a restart cut short left MERGE_HEAD behind: it is undone first, then done again.
		if (merge.abort && gitSucceeds(merge.into, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])) git(merge.into, ["merge", "--abort"]);
		const dirty = changed(merge.into);
		if (dirty.length > 0) return { error: `the Effort's Workspace ${merge.into} has uncommitted changes (${listed(dirty)}); commit or remove them first` };
		const left = changed(merge.path);
		if (left.length > 0) {
			return { error: `${merge.path} has uncommitted changes (${listed(left)}), and only committed work merges; send it back so its Teammate commits them` };
		}
		if (gitSucceeds(merge.into, ["merge-base", "--is-ancestor", merge.branch, "HEAD"])) return {};
		try {
			git(merge.into, ["merge", "--no-ff", "--no-edit", "-m", `Merge Task ${merge.folder.slice(0, 3)} ${merge.slug} (${merge.branch})`, merge.branch]);
		} catch (error) {
			if (!(error instanceof GitError)) throw error;
			const conflicted = gitSucceeds(merge.into, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]) ? git(merge.into, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean) : [];
			if (gitSucceeds(merge.into, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])) git(merge.into, ["merge", "--abort"]);
			return { error: conflicted.length > 0 ? `merging it would conflict in ${listed(conflicted)}, so the merge was aborted` : error.message };
		}
		return { commit: git(merge.into, ["rev-parse", "HEAD"]).trim() };
	} catch (error) {
		if (error instanceof GitError) return { error: error.message };
		throw error;
	}
}

/**
 * Where the merge of `branch` into the Workspace at `into` stands, for a
 * restart to finish it: half-done while `MERGE_HEAD` is left behind; merged
 * once the branch is in, by the merge commit whose second parent is its tip
 * (none when it had nothing new); else not started. Undefined when git
 * can't tell, the branch or the Workspace being gone.
 */
export function mergeEvidence(into: string, branch: string): MergeEvidence | undefined {
	if (!existsSync(into)) return undefined;
	try {
		if (gitSucceeds(into, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])) return { state: "half-done" };
		if (!gitSucceeds(into, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`])) return undefined;
		if (!gitSucceeds(into, ["merge-base", "--is-ancestor", branch, "HEAD"])) return { state: "not-started" };
		const tip = git(into, ["rev-parse", branch]).trim();
		const merge = git(into, ["log", "--merges", "--format=%H %P", `${tip}..HEAD`])
			.split("\n")
			.map((line) => line.split(" "))
			.find((shas) => shas[2] === tip)?.[0];
		return merge === undefined ? { state: "merged" } : { state: "merged", commit: merge };
	} catch (error) {
		if (error instanceof GitError) return undefined;
		throw error;
	}
}

/**
 * Remove an isolated Task's worktree and its branch: once merged, or with
 * `force` to undo one whose Teammate never launched. Undefined when both are
 * gone, else what git said.
 */
export function removeTaskWorkspace(repo: string, task: { path: string; branch: string }, force = false): string | undefined {
	try {
		if (existsSync(task.path)) git(repo, ["worktree", "remove", ...(force ? ["--force"] : []), task.path]);
		if (hasBranch(repo, task.branch)) git(repo, ["branch", force ? "-D" : "-d", task.branch]);
		return undefined;
	} catch (error) {
		if (error instanceof GitError) return error.message;
		throw error;
	}
}

/** One of an Effort's worktrees: its Workspace or an isolated Task's, with whether it has uncommitted changes. */
export interface EffortWorktree {
	path: string;
	branch: string;
	dirty: boolean;
}

/**
 * The worktrees Effort `effortId` has in `repo` now, as `git worktree list`
 * knows them: the one on its branch `team/<effort-id>` and each on a Task
 * branch `team/<effort-id>-task-<nnn>`.
 */
export function effortWorktrees(repo: string, effortId: string): EffortWorktree[] {
	const { branch: own } = workspaceFor(repo, effortId);
	const found: EffortWorktree[] = [];
	for (const entry of git(repo, ["worktree", "list", "--porcelain", "-z"]).split("\0\0")) {
		const fields = entry.split("\0");
		const path = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
		const branch = fields.find((field) => field.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
		if (path === undefined || branch === undefined || (branch !== own && !branch.startsWith(`${own}-task-`))) continue;
		found.push({ path, branch, dirty: existsSync(path) && changed(path).length > 0 });
	}
	return found;
}

/**
 * Remove Effort `effortId`'s clean worktrees at its end, sign-off or cancel,
 * and keep every branch: the work stays in git for the human to merge or
 * delete. A worktree with uncommitted changes is kept, never forced, and so is
 * one git refuses to remove, with git's reason.
 */
export function endWorktrees(repo: string, effortId: string): { removed: EffortWorktree[]; kept: (EffortWorktree & { why: string })[] } {
	const removed: EffortWorktree[] = [];
	const kept: (EffortWorktree & { why: string })[] = [];
	for (const worktree of effortWorktrees(repo, effortId)) {
		if (worktree.dirty) {
			kept.push({ ...worktree, why: `it has uncommitted changes (${listed(changed(worktree.path))})` });
			continue;
		}
		try {
			git(repo, ["worktree", "remove", worktree.path]);
			removed.push(worktree);
		} catch (error) {
			if (!(error instanceof GitError)) throw error;
			kept.push({ ...worktree, why: error.message });
		}
	}
	return { removed, kept };
}

/** The paths `git status` shows as changed or untracked in the worktree at `dir`. */
function changed(dir: string): string[] {
	return git(dir, ["status", "--porcelain", "-z"])
		.split("\0")
		.filter(Boolean)
		.map((entry) => entry.slice(3));
}

function listed(paths: string[]): string {
	const shown = paths.slice(0, 5).map((path) => `\`${path}\``);
	return paths.length > 5 ? `${shown.join(", ")} and ${paths.length - 5} more` : shown.join(", ");
}
