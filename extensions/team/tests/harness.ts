/**
 * Shared test scaffolding for the team extension: temp path roots, Teams
 * written to real folders, and the fake `claude`.
 *
 * Nothing here is a test of its own; `npm test` only runs `*.test.ts`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The path roots a test points the extension at, every one a fresh temp folder. */
export interface TempRoots {
	/** Stands in for `~/.pi/agent`. */
	agentDir: string;
	/** Stands in for `~/.claude.json`. Not created. */
	claudeConfigPath: string;
	/** Stands in for `~/.claude`, where the human's own settings.json lives. Not created. */
	claudeDir: string;
	/** A scratch folder for anything else the test needs on disk. */
	scratch: string;
}

export function tempRoots(): TempRoots {
	const home = mkdtempSync(join(tmpdir(), "team-test-"));
	const agentDir = join(home, ".pi", "agent");
	const scratch = join(home, "scratch");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(scratch, { recursive: true });
	return { agentDir, claudeConfigPath: join(home, ".claude.json"), claudeDir: join(home, ".claude"), scratch };
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
	/**
	 * What each started `--bg` session does before its launch returns; nothing
	 * when unset. A session with hooks also opens a real inbox socket.
	 */
	hooks?: FakeHookStep[];
	/** What a session does each time an authorized user message lands in its inbox, that message being its pointer. */
	replies?: FakeHookStep[];
	/** The exit code of a `claude attach`; 0 when unset. */
	attachExit?: number;
	/** What the `get_usage` control request answers; an error response when unset. */
	usage?: Record<string, unknown>;
	/** How long a held hook holds before giving the prompt back to the terminal, `TEAM_HOOK_HOLD_MS`; the hook's own when unset. */
	holdMs?: number;
}

/**
 * One step a fake background session plays: fire a hook event through the
 * hook commands of its `--settings` (the payload gets the session id, folder
 * and event name filled in), write the result its handoff pointer asks for,
 * edit a file in its working directory, committing it when a message is given,
 * or update its status line, which runs the `statusLine.command` of its
 * `--settings` with the payload (the session id and folder filled in).
 */
export type FakeHookStep = { event: string; payload?: Record<string, unknown>; hold?: boolean } | { write: "result" } | { edit: string; commit?: string } | { statusLine: Record<string, unknown> };

/**
 * A hook command a fake session started without waiting on, as Claude Code
 * holds a `PermissionRequest` while its prompt is live in the terminal.
 */
export interface FakeHeldHook {
	event: string;
	/** What it printed, once it exited; undefined while it holds. */
	output(): string | undefined;
	/** Its exit code once it exited by itself; undefined while it holds, or once killed. */
	exitCode(): number | undefined;
	/** SIGTERM its process group, as Claude Code does when the human answers the prompt in the terminal. */
	terminate(): void;
}

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
	/** Every connection to a session's inbox socket, oldest first. */
	inbox(): FakeInboxConnection[];
	/** Every `claude attach`, oldest first. */
	attaches(): FakeAttach[];
	/** Every hook command a session holds or held, oldest first. */
	held(): FakeHeldHook[];
	/** SIGTERM every held hook still running, so none outlives the test. */
	release(): void;
	/** Every session it started, live or not, as its registry holds it. */
	agents(): FakeAgent[];
	/** Idle-stop the session named `name`, as Claude Code does after about an hour: gone from `agents --json`, its socket closed, no hook. */
	idleStop(name: string): void;
	/** Close the socket of the session named `name` but leave it in `agents --json`, so a send to it is refused. */
	refuseSends(name: string): void;
	/** Forget the session named `name` altogether, as if Claude Code had cleaned it up: no record, no socket, nothing to resume. */
	forget(name: string): void;
	/** Set what `agents --json` says of the session named `name`. */
	setAgent(name: string, change: Partial<Pick<FakeAgent, "status" | "state" | "waitingFor">>): void;
	/** Set what `get_usage` answers from now on; undefined makes it answer with an error. */
	setUsage(usage: Record<string, unknown> | undefined): void;
	/** How many times `get_usage` was asked for: each is one `claude -p`. */
	usageCalls(): number;
}

/** A session in the fake's registry. */
export interface FakeAgent {
	id: string;
	name?: string;
	socket: string;
	live: boolean;
	status: string;
	state: string;
	waitingFor?: string;
}

/** One connection to a fake session's inbox socket. */
export interface FakeInboxConnection {
	/** The session's socket. */
	socket: string;
	/** Whether the first line was `{"type":"auth","token":…}` with the session's token. */
	authorized: boolean;
	/** Every line received, verbatim, the auth line first. */
	lines: string[];
}

/** One `claude attach`, as the fake saw it. */
export interface FakeAttach {
	argv: string[];
	/** The `<device>:<inode>` of its stdin, stdout and stderr: the same as the test process's when inherited. */
	stdio: string[];
}

/** The `<device>:<inode>` of this process's stdin, stdout and stderr, to compare a fake's against. */
export function ownStdio(): string[] {
	return [0, 1, 2].map((fd) => {
		const stat = fstatSync(fd);
		return `${stat.dev}:${stat.ino}`;
	});
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
	const inboxOut = join(dir, "inbox.jsonl");
	const attachOut = join(dir, "attaches.jsonl");
	const heldOut = join(dir, "held.jsonl");
	const hooks = join(dir, "hooks.json");
	const replies = join(dir, "replies.json");
	if (options.hooks) writeFileSync(hooks, JSON.stringify(options.hooks));
	if (options.replies) writeFileSync(replies, JSON.stringify(options.replies));
	const usage = join(dir, "usage.json");
	if (options.usage) writeFileSync(usage, JSON.stringify(options.usage));
	// Its own short folder: a Unix socket path can't be much longer than 100 bytes.
	const sockets = mkdtempSync(join(tmpdir(), "fcs-"));
	const agents = join(dir, "agents");
	mkdirSync(agents);
	const agentFile = (name: string): string => {
		const file = readdirSync(agents).find((each) => (JSON.parse(readFileSync(join(agents, each), "utf8")) as FakeAgent).name === name);
		if (file === undefined) throw new Error(`the fake claude started no session named ${name}`);
		return join(agents, file);
	};
	const change = (name: string, edit: (agent: FakeAgent) => FakeAgent): void => {
		const file = agentFile(name);
		const agent = edit(JSON.parse(readFileSync(file, "utf8")) as FakeAgent);
		writeFileSync(file, JSON.stringify(agent));
	};
	const env: Record<string, string | undefined> = {
		FAKE_CLAUDE_ARGV_OUT: argvOut,
		FAKE_CLAUDE_LAUNCH_OUT: launchOut,
		FAKE_CLAUDE_VERSION: options.version,
		FAKE_CLAUDE_BG_EXIT: options.bgExit === undefined ? undefined : String(options.bgExit),
		FAKE_CLAUDE_HOOKS: options.hooks ? hooks : undefined,
		FAKE_CLAUDE_REPLIES: options.replies ? replies : undefined,
		FAKE_CLAUDE_SOCKETS: sockets,
		FAKE_CLAUDE_INBOX_OUT: inboxOut,
		FAKE_CLAUDE_OWNER: String(process.pid),
		FAKE_CLAUDE_ATTACH_OUT: attachOut,
		FAKE_CLAUDE_AGENTS: agents,
		FAKE_CLAUDE_ATTACH_EXIT: options.attachExit === undefined ? undefined : String(options.attachExit),
		FAKE_CLAUDE_USAGE: usage,
		FAKE_CLAUDE_HELD_OUT: heldOut,
		TEAM_HOOK_HOLD_MS: options.holdMs === undefined ? undefined : String(options.holdMs),
	};
	const exports = Object.entries(env)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([name, value]) => `export ${name}=${shellQuote(value)}`);
	const path = join(dir, "claude");
	writeFileSync(path, ["#!/bin/sh", ...exports, `exec ${shellQuote(process.execPath)} ${shellQuote(FAKE_CLAUDE_SCRIPT)} "$@"`, ""].join("\n"), { mode: 0o755 });
	return {
		path,
		calls: () => jsonLines<string[]>(argvOut),
		launches: () => jsonLines<FakeLaunch>(launchOut),
		inbox: () => jsonLines<FakeInboxConnection>(inboxOut),
		attaches: () => jsonLines<FakeAttach>(attachOut),
		held: () => jsonLines<{ pid: number; event: string; out: string; exit: string }>(heldOut).map(heldHook),
		release() {
			for (const { pid, exit } of jsonLines<{ pid: number; exit: string }>(heldOut)) if (!existsSync(exit)) kill(pid);
		},
		agents: () => readdirSync(agents).map((file) => JSON.parse(readFileSync(join(agents, file), "utf8")) as FakeAgent),
		idleStop: (name) =>
			change(name, (agent) => {
				rmSync(agent.socket, { force: true });
				return { ...agent, live: false };
			}),
		refuseSends: (name) =>
			change(name, (agent) => {
				rmSync(agent.socket, { force: true });
				return agent;
			}),
		forget: (name) => {
			const file = agentFile(name);
			rmSync((JSON.parse(readFileSync(file, "utf8")) as FakeAgent).socket, { force: true });
			rmSync(file);
		},
		setAgent: (name, edit) => change(name, (agent) => ({ ...agent, ...edit })),
		setUsage: (next) => (next === undefined ? rmSync(usage, { force: true }) : writeFileSync(usage, JSON.stringify(next))),
		usageCalls: () => jsonLines<string[]>(argvOut).filter((args) => args[0] === "-p").length,
	};
}

function heldHook({ pid, event, out, exit }: { pid: number; event: string; out: string; exit: string }): FakeHeldHook {
	const exited = () => existsSync(exit) && readFileSync(exit, "utf8").trim() !== "";
	return {
		event,
		output: () => (exited() ? readFileSync(out, "utf8") : undefined),
		exitCode: () => (exited() ? Number(readFileSync(exit, "utf8").trim()) : undefined),
		terminate: () => kill(pid),
	};
}

/** SIGTERM a process group, which may be gone already. */
function kill(group: number): void {
	try {
		process.kill(-group, "SIGTERM");
	} catch {
		// Gone already.
	}
}

/** A fake `tmux` on disk, and the argv of every call to it. */
export interface FakeTmux {
	path: string;
	calls(): string[][];
}

/** Write an executable standing in for `tmux`, which records its argv and exits with `exit` (0 unless set). */
export function fakeTmux(roots: TempRoots, exit = 0): FakeTmux {
	const dir = mkdtempSync(join(roots.scratch, "fake-tmux-"));
	const argvOut = join(dir, "argv.jsonl");
	const record = `require("node:fs").appendFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(1)) + "\\n")`;
	const path = join(dir, "tmux");
	writeFileSync(path, ["#!/bin/sh", `${shellQuote(process.execPath)} -e ${shellQuote(record)} -- "$@"`, `exit ${exit}`, ""].join("\n"), { mode: 0o755 });
	return { path, calls: () => jsonLines<string[]>(argvOut) };
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
