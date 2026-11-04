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
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { MergeEvidence, RunningProcess, Workspace } from "./core.ts";
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
 * `force` to undo one whose Teammate never launched. `error` is what git said
 * when either is left, and `running` the processes still running in the
 * worktree it removed, which are never stopped, the sessions in `spare` and
 * their descendants aside (see {@link runningIn}).
 */
export function removeTaskWorkspace(repo: string, task: { path: string; branch: string }, force = false, spare: readonly number[] = []): { error?: string; running: RunningProcess[] } {
	let running: RunningProcess[] = [];
	try {
		if (existsSync(task.path)) {
			const found = runningIn(task.path, { spare });
			git(repo, ["worktree", "remove", ...(force ? ["--force"] : []), task.path]);
			running = found;
		}
		if (hasBranch(repo, task.branch)) git(repo, ["branch", force ? "-D" : "-d", task.branch]);
		return { running };
	} catch (error) {
		if (error instanceof GitError) return { error: error.message, running };
		throw error;
	}
}

/**
 * The processes whose working directory is `dir` or a folder inside it, such
 * as a server a Teammate started with `&`: `claude stop` never reaches them,
 * and removing the worktree leaves them running in a folder that is gone.
 * `dir` is matched in its own spelling and its real path, since `lsof` gives
 * real paths (`/private/tmp`, not `/tmp`), and only on a folder boundary, so
 * `/a/wt` doesn't match `/a/wt2`. pi's own process is never one of them, nor
 * is a process in `spare`, a Teammate's session that sign-off stops, or one
 * descended from it, such as its Bash tool's shell. lsof's escapes in a name
 * are undone before it is matched (see {@link unescaped}). None when `lsof` is
 * missing, fails or hangs past {@link LIST_TIMEOUT_MS}: what removes a
 * worktree goes ahead all the same.
 */
export function runningIn(dir: string, options: { spare?: readonly number[]; lsof?: string } = {}): RunningProcess[] {
	const roots = new Set([caretted(dir.replace(/(.)\/+$/, "$1"))]);
	try {
		roots.add(caretted(realpathSync(dir)));
	} catch {
		// Gone already: only its own spelling can match.
	}
	const inside = (path: string) => [...roots].some((root) => path === root || path.startsWith(`${root}/`));
	const found = new Map<number, string>();
	let pid: number | undefined;
	let name = "";
	// `-b` keeps lsof off the kernel calls that can block, as on a stale network mount; a UTF-8 locale keeps it from escaping non-ASCII names.
	for (const line of output(options.lsof ?? "lsof", ["-b", "-a", "-d", "cwd", "-Fpcn", "-w"], { LC_ALL: "en_US.UTF-8" }).split("\n")) {
		if (line.startsWith("p")) [pid, name] = [Number(line.slice(1)), ""];
		else if (line.startsWith("c")) name = line.slice(1);
		else if (line.startsWith("n") && pid !== undefined && pid !== process.pid && inside(unescaped(line.slice(1)))) found.set(pid, name);
	}
	if (found.size > 0 && options.spare !== undefined && options.spare.length > 0) {
		for (const each of descendants(options.spare)) found.delete(each);
	}
	if (found.size === 0) return [];
	const commands = new Map<number, string>();
	for (const line of output("ps", ["-o", "pid=,command=", "-p", [...found.keys()].join(",")]).split("\n")) {
		const match = /^\s*(\d+)\s+(.+)$/.exec(line);
		if (match) commands.set(Number(match[1]), match[2].trim());
	}
	return [...found].map(([each, named]) => ({ pid: each, command: commands.get(each) ?? named }));
}

/** The C escapes `lsof` writes a name's control characters with. */
const LSOF_ESCAPES: Record<string, number> = { b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, "\\": 0x5c };

/**
 * A name as `lsof` prints it, its escapes undone: `\xNN` is a byte, so a
 * name is read as UTF-8 once they are, and `\t`, `\n`, `\r`, `\b`, `\f` and
 * `\\` are what C means by them. A control character it prints as `^X` stays
 * so, since a literal `^` is printed as itself: {@link caretted} spells a
 * worktree's path the same way to match it.
 */
function unescaped(name: string): string {
	const bytes: number[] = [];
	for (let at = 0; at < name.length; at++) {
		const hex = name[at] === "\\" && name[at + 1] === "x" ? /^[0-9a-fA-F]{2}/.exec(name.slice(at + 2)) : null;
		const escape = name[at] === "\\" ? LSOF_ESCAPES[name[at + 1] ?? ""] : undefined;
		if (hex) {
			bytes.push(Number.parseInt(hex[0], 16));
			at += 3;
		} else if (escape !== undefined) {
			bytes.push(escape);
			at += 1;
		} else {
			const point = name.codePointAt(at) ?? 0;
			bytes.push(...Buffer.from(String.fromCodePoint(point), "utf8"));
			if (point > 0xffff) at += 1;
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

/** `path` with each control character `lsof` prints as `^X` (all but those it escapes in C's way) spelled so, to match {@link unescaped} names. */
function caretted(path: string): string {
	return path.replace(/[\x00-\x07\x0b\x0e-\x1f\x7f]/g, (char) => (char === "\x7f" ? "^?" : `^${String.fromCharCode(char.charCodeAt(0) + 0x40)}`));
}

/** The processes in `roots` and every process descended from them, by the parent pids `ps` lists. */
function descendants(roots: readonly number[]): Set<number> {
	const children = new Map<number, number[]>();
	for (const line of output("ps", ["-A", "-o", "pid=,ppid="]).split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (match) children.set(Number(match[2]), [...(children.get(Number(match[2])) ?? []), Number(match[1])]);
	}
	const found = new Set<number>(roots);
	const queue = [...roots];
	for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
		for (const child of children.get(next) ?? []) {
			if (found.has(child)) continue;
			found.add(child);
			queue.push(child);
		}
	}
	return found;
}

/** How long `lsof` or `ps` may take before the check gives up on it and finds nothing. */
export const LIST_TIMEOUT_MS = 3000;

/**
 * What `file` prints to stdout, even when it exits non-zero (`lsof` and `ps`
 * do when a process is gone or unreadable); empty when it can't run, or is
 * killed for taking longer than {@link LIST_TIMEOUT_MS}: with SIGKILL, since
 * one that hangs may ignore SIGTERM. `env` is set over pi's own environment.
 */
function output(file: string, args: string[], env: Record<string, string> = {}): string {
	try {
		return execFileSync(file, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 64 * 1024 * 1024,
			timeout: LIST_TIMEOUT_MS,
			killSignal: "SIGKILL",
			env: { ...process.env, ...env },
		});
	} catch (error) {
		const { stdout, signal } = error as { stdout?: unknown; signal?: unknown };
		return typeof stdout === "string" && !signal ? stdout : "";
	}
}

/**
 * One of an Effort's worktrees: its Workspace or an isolated Task's, with
 * whether it has uncommitted changes and the processes still running in it.
 */
export interface EffortWorktree {
	path: string;
	branch: string;
	dirty: boolean;
	running: RunningProcess[];
}

/**
 * The worktrees Effort `effortId` has in `repo` now, as `git worktree list`
 * knows them: the one on its branch `team/<effort-id>` and each on a Task
 * branch `team/<effort-id>-task-<nnn>`. What runs in each leaves out the
 * sessions in `spare` and their descendants (see {@link runningIn}).
 */
export function effortWorktrees(repo: string, effortId: string, spare: readonly number[] = []): EffortWorktree[] {
	const { branch: own } = workspaceFor(repo, effortId);
	const found: EffortWorktree[] = [];
	for (const entry of git(repo, ["worktree", "list", "--porcelain", "-z"]).split("\0\0")) {
		const fields = entry.split("\0");
		const path = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
		const branch = fields.find((field) => field.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
		if (path === undefined || branch === undefined || (branch !== own && !branch.startsWith(`${own}-task-`))) continue;
		found.push({ path, branch, dirty: existsSync(path) && changed(path).length > 0, running: existsSync(path) ? runningIn(path, { spare }) : [] });
	}
	return found;
}

/**
 * Remove Effort `effortId`'s clean worktrees at its end, sign-off or cancel,
 * and keep every branch: the work stays in git for the human to merge or
 * delete. A worktree with uncommitted changes is kept, never forced, and so is
 * one git refuses to remove, with git's reason. Each one's `running` is
 * what still runs in it as it goes, found then rather than at the final
 * Report, since a process can start in between, the sessions in `spare`
 * aside; none of it is stopped.
 */
export function endWorktrees(repo: string, effortId: string, spare: readonly number[] = []): { removed: EffortWorktree[]; kept: (EffortWorktree & { why: string })[] } {
	const removed: EffortWorktree[] = [];
	const kept: (EffortWorktree & { why: string })[] = [];
	for (const worktree of effortWorktrees(repo, effortId, spare)) {
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
