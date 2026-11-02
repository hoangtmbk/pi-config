/**
 * Shared test scaffolding for the team extension: temp path roots, Teams
 * written to real folders, and the fake `claude`.
 *
 * Nothing here is a test of its own; `npm test` only runs `*.test.ts`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The path roots a test points the extension at, every one a fresh temp folder. */
export interface TempRoots {
	/** Stands in for `~/.pi/agent`. */
	agentDir: string;
	/** Stands in for `~/.claude.json`. Not created. */
	claudeConfigPath: string;
	/** A scratch folder for anything else the test needs on disk. */
	scratch: string;
}

export function tempRoots(): TempRoots {
	const home = mkdtempSync(join(tmpdir(), "team-test-"));
	const agentDir = join(home, ".pi", "agent");
	const scratch = join(home, "scratch");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(scratch, { recursive: true });
	return { agentDir, claudeConfigPath: join(home, ".claude.json"), scratch };
}

/**
 * A git repo under the scratch folder, by its real path, as `git` reports a
 * repo's root: branch `main` with one commit holding a `README.md`, unless
 * `empty` asks for a repo with no commits at all.
 */
export function gitRepo(roots: TempRoots, name = "repo", options: { empty?: boolean } = {}): string {
	const dir = join(roots.scratch, name);
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main", dir]);
	const root = realpathSync(dir);
	// The repo's own identity, and no signing, so the human's global git config never changes what a test does.
	git(root, "config", "user.name", "Test");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "commit.gpgsign", "false");
	// Nor the human's global excludes: whether `.claude/` is ignored is the test's to say.
	git(root, "config", "core.excludesFile", join(roots.scratch, "no-global-excludes"));
	if (!options.empty) commit(root, { "README.md": "# repo\n" }, "first commit");
	return root;
}

/** Run `git` in `dir`, returning what it printed, trimmed. */
export function git(dir: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Write `files` in the repo at `dir` and commit them on the branch checked out, returning the new commit. */
export function commit(dir: string, files: TeamFiles, message: string): string {
	writeFiles(dir, files);
	git(dir, "add", "--", ...Object.keys(files));
	git(dir, "commit", "-q", "-m", message);
	return git(dir, "rev-parse", "HEAD");
}

/** A Team folder's files, by path relative to the folder. */
export type TeamFiles = Record<string, string>;

/** Write each file under `dir`, creating folders on the way. */
export function writeFiles(dir: string, files: TeamFiles): string {
	for (const [relative, content] of Object.entries(files)) {
		const path = join(dir, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return dir;
}

/** A user Team under the agent root, `<agentDir>/teams/<name>/`. */
export function writeUserTeam(roots: TempRoots, name: string, files: TeamFiles): string {
	return writeFiles(join(roots.agentDir, "teams", name), files);
}

/** A markdown file with YAML frontmatter, written the way a Team author would. */
export function markdown(frontmatter: string, body = ""): string {
	return `---\n${frontmatter.trim()}\n---\n\n${body}\n`;
}

/** A `team.md` that passes, with any line swapped or added by the caller. */
export function teamMd(name: string, extra = "", description = `The ${name} Team's own work.`): string {
	return markdown(`name: ${name}\ndescription: ${description}\nworkspace: git-worktree\n${extra}`, `What the ${name} Team covers.`);
}

/** A Role file that passes, with any frontmatter lines added by the caller. */
export function roleMd(name: string, extra = ""): string {
	return markdown(`name: ${name}\ndescription: The ${name} on this Team.\n${extra}`, `You are the ${name}.`);
}

/** A minimal good Team: `team.md` plus one Role. */
export function goodTeam(name: string, extra: TeamFiles = {}): TeamFiles {
	return { "team.md": teamMd(name), "roles/worker.md": roleMd("worker"), ...extra };
}

/** How a test wants the fake `claude` to behave. */
export interface FakeClaudeOptions {
	/** What `--version` prints. */
	version?: string;
	/** The exit code of a `--bg` launch; 0 when unset. */
	bgExit?: number;
	/** What each started `--bg` session does before its launch returns; nothing when unset. */
	hooks?: FakeHookStep[];
}

/**
 * One step a fake background session plays: fire a hook event through the
 * hook commands of its `--settings` (the payload gets the session id, folder
 * and event name filled in), or write the result its handoff pointer asks for.
 */
export type FakeHookStep = { event: string; payload?: Record<string, unknown> } | { write: "result" };

/** One `claude --bg` launch, as the fake saw it. */
export interface FakeLaunch {
	argv: string[];
	/** The folder it ran in. */
	cwd: string;
	/** `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` as it was set, absent when unset. */
	additionalDirectoriesClaudeMd?: string;
	/** The contents of the `--settings` file, read at launch. */
	settings?: string;
	/** The contents of the `--append-system-prompt-file`, read at launch. */
	prompt?: string;
	/** The contents of the `--mcp-config` file, read at launch. */
	mcpConfig?: string;
}

/** A fake `claude` on disk, and what it recorded. */
export interface FakeClaude {
	/** The executable to inject as the extension's `claudePath`. */
	path: string;
	/** Every invocation's argv, oldest first. */
	calls(): string[][];
	/** Every `--bg` launch, oldest first. */
	launches(): FakeLaunch[];
}

const FAKE_CLAUDE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");

/**
 * Write an executable that runs `fake-claude.ts` with this test's settings.
 *
 * The settings travel as exported variables in a small `sh` wrapper rather than
 * the extension's own environment, because the extension is what runs it and
 * must not need to know it is talking to a fake.
 */
export function fakeClaude(roots: TempRoots, options: FakeClaudeOptions = {}): FakeClaude {
	const dir = mkdtempSync(join(roots.scratch, "fake-claude-"));
	const argvOut = join(dir, "argv.jsonl");
	const launchOut = join(dir, "launches.jsonl");
	const hooks = join(dir, "hooks.json");
	if (options.hooks) writeFileSync(hooks, JSON.stringify(options.hooks));
	const env: Record<string, string | undefined> = {
		FAKE_CLAUDE_ARGV_OUT: argvOut,
		FAKE_CLAUDE_LAUNCH_OUT: launchOut,
		FAKE_CLAUDE_VERSION: options.version,
		FAKE_CLAUDE_BG_EXIT: options.bgExit === undefined ? undefined : String(options.bgExit),
		FAKE_CLAUDE_HOOKS: options.hooks ? hooks : undefined,
	};
	const exports = Object.entries(env)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([name, value]) => `export ${name}=${shellQuote(value)}`);
	const path = join(dir, "claude");
	writeFileSync(path, ["#!/bin/sh", ...exports, `exec ${shellQuote(process.execPath)} ${shellQuote(FAKE_CLAUDE_SCRIPT)} "$@"`, ""].join("\n"), { mode: 0o755 });
	return { path, calls: () => jsonLines<string[]>(argvOut), launches: () => jsonLines<FakeLaunch>(launchOut) };
}

function jsonLines<T>(file: string): T[] {
	return existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as T)
		: [];
}

function shellQuote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}
