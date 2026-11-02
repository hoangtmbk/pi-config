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
import type { Workspace } from "./core.ts";
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
