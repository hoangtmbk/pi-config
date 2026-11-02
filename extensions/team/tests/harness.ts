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

/** An empty git repo under the scratch folder, by its real path, as `git` reports a repo's root. */
export function gitRepo(roots: TempRoots, name = "repo"): string {
	const dir = join(roots.scratch, name);
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "-q", dir]);
	return realpathSync(dir);
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
}

/** A fake `claude` on disk, and what it recorded. */
export interface FakeClaude {
	/** The executable to inject as the extension's `claudePath`. */
	path: string;
	/** Every invocation's argv, oldest first. */
	calls(): string[][];
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
	const env: Record<string, string | undefined> = { FAKE_CLAUDE_ARGV_OUT: argvOut, FAKE_CLAUDE_VERSION: options.version };
	const exports = Object.entries(env)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([name, value]) => `export ${name}=${shellQuote(value)}`);
	const path = join(dir, "claude");
	writeFileSync(path, ["#!/bin/sh", ...exports, `exec ${shellQuote(process.execPath)} ${shellQuote(FAKE_CLAUDE_SCRIPT)} "$@"`, ""].join("\n"), { mode: 0o755 });
	return {
		path,
		calls: () =>
			existsSync(argvOut)
				? readFileSync(argvOut, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as string[])
				: [],
	};
}

function shellQuote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}
