#!/usr/bin/env node
/**
 * A stand-in for the `claude` executable, so no test ever runs the real one.
 *
 * Driven by environment variables the test sets through `fakeClaude()`:
 *
 * - `FAKE_CLAUDE_VERSION`: what `claude --version` prints, as the real one
 *   does (`2.1.316 (Claude Code)`). Unset prints the pinned version.
 * - `FAKE_CLAUDE_ARGV_OUT`: a file each invocation appends its argv to, one
 *   JSON array per line, so a test can see exactly how it was called.
 * - `FAKE_CLAUDE_LAUNCH_OUT`: a file each `--bg` launch appends one JSON line
 *   to: its argv, the folder it ran in, whether
 *   `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` was set, and the contents
 *   of the files its `--settings`, `--append-system-prompt-file` and
 *   `--mcp-config` named, read at launch as the real one reads them.
 * - `FAKE_CLAUDE_BG_EXIT`: the exit code of a `--bg` launch, `0` when unset;
 *   any other code prints a failure to stderr first.
 * - `FAKE_CLAUDE_HOOKS`: a JSON file of steps a started `--bg` session plays
 *   before the launch returns, in order: `{ event, payload? }` runs every hook
 *   command its `--settings` file gives for that event, as Claude Code does,
 *   with the payload on stdin and the inbox socket and token in the
 *   environment; `{ write: "result" }` writes the result its handoff pointer
 *   asks for. Each session gets a session id of its own unless a payload
 *   names one.
 * - `FAKE_CLAUDE_SOCKETS`: a short folder a session with hooks opens its inbox
 *   socket in. The socket is real: a small server process outlives the
 *   launch, as the real session does, and stops once the test process
 *   (`FAKE_CLAUDE_OWNER`) is gone. Every connection must open with the auth
 *   line `{"type":"auth","token":…}` carrying the session's token.
 * - `FAKE_CLAUDE_INBOX_OUT`: a file the inbox appends one JSON line to per
 *   connection: the socket, whether its auth line held the session's token,
 *   and every line it received, verbatim.
 * - `FAKE_CLAUDE_REPLIES`: a JSON file of steps, as in `FAKE_CLAUDE_HOOKS`, a
 *   session plays each time an authorized user message lands in its inbox,
 *   with that message as its pointer. A `UserPromptSubmit` without a payload
 *   reports the message as its prompt.
 * - `FAKE_CLAUDE_ATTACH_OUT`: a file each `attach` appends one JSON line to:
 *   its argv and the device and inode its stdin, stdout and stderr are open
 *   on, so a test can tell whether it was handed the terminal pi runs on.
 * - `FAKE_CLAUDE_ATTACH_EXIT`: the exit code of an `attach`, `0` when unset.
 *   It prints nothing, since the terminal it inherits is the test runner's.
 * - `FAKE_CLAUDE_AGENTS`: a folder that holds one JSON file per started
 *   session, `<session id>.json` ({@link Agent}), as Claude Code's own
 *   registry of background sessions. `agents --json` prints the live ones as
 *   a JSON array; `stop <short id>` ends one, keeping its record, as the real
 *   one keeps the conversation; `--bg --resume <session id> <message>` wakes one
 *   with a new socket, plays `SessionStart` with `source:
 *   "resume"`, then plays `FAKE_CLAUDE_REPLIES` with the message as its
 *   pointer. A session idle-stops when its record says `live: false` and its
 *   socket is gone (the harness's `idleStop`), and a played `SessionEnd`
 *   step ends it, as a crash does.
 *
 * Anything else it is asked to do exits 1 with a message saying so, so a test
 * that reaches further than the fake goes is loud about it.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, fstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const argv = process.argv.slice(2);

/** What a session's inbox server needs to know, handed over as one JSON argument. */
interface Session {
	id: string;
	cwd: string;
	socket: string;
	token: string;
	settings: string | undefined;
}

/** A session in `FAKE_CLAUDE_AGENTS`: what resuming it needs, and what `agents --json` says of it. */
interface Agent extends Session {
	name: string | undefined;
	live: boolean;
	status: string;
	state: string;
	waitingFor?: string;
}

if (argv[0] === "--fake-inbox") {
	serveInbox(JSON.parse(argv[1] ?? "{}") as Session);
} else {
	await main();
}

async function main(): Promise<void> {
	const argvOut = process.env.FAKE_CLAUDE_ARGV_OUT;
	if (argvOut) appendFileSync(argvOut, `${JSON.stringify(argv)}\n`);

	if (argv[0] === "--version") {
		process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.316 (Claude Code)"}\n`);
		process.exit(0);
	}

	if (argv[0] === "agents" && argv[1] === "--json") {
		const agents = registry().filter((agent) => agent.live);
		process.stdout.write(`${JSON.stringify(agents.map((agent) => ({ id: agent.id.slice(0, 8), sessionId: agent.id, name: agent.name, status: agent.status, state: agent.state, ...(agent.waitingFor === undefined ? {} : { waitingFor: agent.waitingFor }) })))}\n`);
		process.exit(0);
	}

	if (argv[0] === "stop" && argv[1] !== undefined) {
		const agent = registry().find((each) => each.live && each.id.startsWith(argv[1] ?? ""));
		if (!agent) {
			process.stderr.write(`fake claude: no running session ${argv[1]}\n`);
			process.exit(1);
		}
		end(agent);
		process.exit(0);
	}

	if (argv[0] === "--bg" && argv[1] === "--resume") {
		const agent = registry().find((each) => each.id === argv[2]);
		if (!agent) {
			process.stderr.write(`fake claude: no session ${argv[2]} to resume\n`);
			process.exit(1);
		}
		rmSync(agent.socket, { force: true });
		const sockets = process.env.FAKE_CLAUDE_SOCKETS;
		const session: Session = { ...agent, socket: sockets ? join(sockets, `${randomBytes(4).toString("hex")}.sock`) : agent.socket, token: `inbox-${randomBytes(4).toString("hex")}` };
		record({ ...agent, ...session, live: true, status: "running", state: "idle" });
		if (sockets) await openInbox(session);
		play(undefined, session, "", [{ event: "SessionStart", payload: { source: "resume" } }]);
		play(process.env.FAKE_CLAUDE_REPLIES, session, argv[3] ?? "");
		process.stdout.write("fake claude: background session resumed\n");
		process.exit(0);
	}

	if (argv[0] === "--bg") {
		const launchOut = process.env.FAKE_CLAUDE_LAUNCH_OUT;
		const launch = {
			argv,
			cwd: process.cwd(),
			additionalDirectoriesClaudeMd: process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD,
			settings: fileOf("--settings"),
			prompt: fileOf("--append-system-prompt-file"),
			mcpConfig: fileOf("--mcp-config"),
		};
		if (launchOut) appendFileSync(launchOut, `${JSON.stringify(launch)}\n`);
		const exit = Number(process.env.FAKE_CLAUDE_BG_EXIT ?? "0");
		if (exit !== 0) process.stderr.write("fake claude: the background session could not start\n");
		else {
			const id = randomUUID();
			const sockets = process.env.FAKE_CLAUDE_SOCKETS;
			const session: Session = {
				id,
				cwd: process.cwd(),
				socket: sockets ? join(sockets, `${randomBytes(4).toString("hex")}.sock`) : `/tmp/cc-socks/${process.pid}.sock`,
				token: `inbox-${id.slice(0, 8)}`,
				settings: launch.settings,
			};
			const name = argv.indexOf("--name") === -1 ? undefined : argv[argv.indexOf("--name") + 1];
			record({ ...session, name, live: true, status: "running", state: "idle" });
			if (process.env.FAKE_CLAUDE_HOOKS && sockets) await openInbox(session);
			play(process.env.FAKE_CLAUDE_HOOKS, session, argv.at(-1) ?? "");
			process.stdout.write("fake claude: background session started\n");
		}
		process.exit(exit);
	}

	if (argv[0] === "attach") {
		const attachOut = process.env.FAKE_CLAUDE_ATTACH_OUT;
		const stdio = [0, 1, 2].map((fd) => {
			const stat = fstatSync(fd);
			return `${stat.dev}:${stat.ino}`;
		});
		if (attachOut) appendFileSync(attachOut, `${JSON.stringify({ argv, stdio })}\n`);
		process.exit(Number(process.env.FAKE_CLAUDE_ATTACH_EXIT ?? "0"));
	}

	process.stderr.write(`fake claude: no scripted behaviour for ${JSON.stringify(argv)}\n`);
	process.exit(1);
}

/** Every session `FAKE_CLAUDE_AGENTS` holds, live or not. */
function registry(): Agent[] {
	const dir = process.env.FAKE_CLAUDE_AGENTS;
	if (!dir || !existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Agent);
}

function record(agent: Agent): void {
	const dir = process.env.FAKE_CLAUDE_AGENTS;
	if (dir) writeFileSync(join(dir, `${agent.id}.json`), JSON.stringify(agent));
}

/** End a session: gone from `agents --json`, its inbox closed with its socket, its record kept for a resume. */
function end(agent: Agent): void {
	record({ ...agent, live: false });
	rmSync(agent.socket, { force: true });
}

/** The contents of the file a flag names, or undefined when the flag or the file is absent. */
function fileOf(flag: string): string | undefined {
	const index = argv.indexOf(flag);
	const path = index === -1 ? undefined : argv[index + 1];
	return path !== undefined && existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** One scripted step of a started session. */
type HookStep = { event: string; payload?: Record<string, unknown> } | { write: "result" };

/** Start the session's inbox server, detached so it outlives this launch, and wait until it listens. */
async function openInbox(session: Session): Promise<void> {
	const server = spawn(process.execPath, [process.argv[1] ?? "", "--fake-inbox", JSON.stringify(session)], {
		detached: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	await new Promise<void>((resolve, reject) => {
		server.stdout.once("data", () => resolve());
		server.once("exit", (code) => reject(new Error(`fake claude: the inbox server exited (${code}) before it listened`)));
	});
	server.stdout.destroy();
	server.unref();
}

/**
 * Be a session's inbox: record each connection, and play `FAKE_CLAUDE_REPLIES`
 * for each user message that arrives after a good auth line.
 */
function serveInbox(session: Session): void {
	const server = createServer((connection) => {
		let buffered = "";
		connection.setEncoding("utf8");
		connection.on("data", (chunk: string) => {
			buffered += chunk;
		});
		connection.on("end", () => {
			const lines = buffered.split("\n").filter(Boolean);
			const auth = parsed(lines[0]);
			const authorized = auth?.type === "auth" && auth.token === session.token;
			const out = process.env.FAKE_CLAUDE_INBOX_OUT;
			if (out) appendFileSync(out, `${JSON.stringify({ socket: session.socket, authorized, lines })}\n`);
			connection.end();
			if (!authorized) return;
			for (const line of lines.slice(1)) {
				const message = parsed(line) as { type?: string; message?: { content?: unknown } } | undefined;
				if (message?.type === "user" && typeof message.message?.content === "string") {
					play(process.env.FAKE_CLAUDE_REPLIES, session, message.message.content);
				}
			}
		});
	});
	server.listen(session.socket, () => process.stdout.write("listening\n"));
	const owner = Number(process.env.FAKE_CLAUDE_OWNER);
	setInterval(() => {
		if (!existsSync(session.socket) || !alive(owner)) process.exit(0);
	}, 200);
}

function parsed(line: string | undefined): Record<string, unknown> | undefined {
	try {
		return line === undefined ? undefined : (JSON.parse(line) as Record<string, unknown>);
	} catch {
		return undefined;
	}
}

function alive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Play a script of steps against the session's settings and pointer. */
function play(script: string | undefined, session: Session, pointer: string, given?: HookStep[]): void {
	if (!script && !given) return;
	const steps = given ?? (JSON.parse(readFileSync(script ?? "", "utf8")) as HookStep[]);
	const settings = JSON.parse(session.settings ?? "{}") as { hooks?: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
	const inbox = { CLAUDE_CODE_MESSAGING_SOCKET: session.socket, CLAUDE_CODE_MESSAGING_TOKEN: session.token };
	for (const step of steps) {
		if ("write" in step) {
			const result = /write your result to (\S+\.md)\./.exec(pointer)?.[1];
			if (result === undefined) throw new Error(`fake claude: the pointer names no result to write: ${pointer}`);
			writeFileSync(result, "# Result\n\nDone.\n");
			continue;
		}
		const prompt = step.event === "UserPromptSubmit" && step.payload === undefined ? { prompt: pointer } : {};
		const payload: Record<string, unknown> = { session_id: session.id, cwd: session.cwd, hook_event_name: step.event, ...prompt, ...step.payload };
		for (const group of settings.hooks?.[step.event] ?? []) {
			if (group.matcher !== undefined && group.matcher !== payload.tool_name) continue;
			for (const hook of group.hooks) {
				execFileSync("sh", ["-c", hook.command], { cwd: session.cwd, input: JSON.stringify(payload), env: { ...process.env, ...inbox }, stdio: ["pipe", "ignore", "inherit"] });
			}
		}
		if (step.event === "SessionEnd" && payload.reason !== "clear" && payload.reason !== "resume") {
			const agent = registry().find((each) => each.id === session.id);
			if (agent) end(agent);
		}
	}
}
