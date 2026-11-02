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
 *   asks for; `{ edit: <file>, commit?: <message> }` writes `<file>` in the
 *   session's working directory, `{task}` in its name standing for the Task
 *   folder the pointer names, and commits just that file when a message is
 *   given. Each session gets a session id of its own unless a payload names
 *   one. A step with `hold: true` starts each hook command without
 *   waiting for it, as Claude Code waits on a held `PermissionRequest` while
 *   its prompt stays live: the step after it plays at once, standing for
 *   whatever the human does in the terminal meanwhile. A step with `when` plays
 *   only for a pointer that includes that text, so one Task's Teammate can do
 *   what another's doesn't. A `PreToolUse` hook that prints
 *   `permissionDecision: "ask"` makes the call prompt, as in Claude Code: a
 *   held `PermissionRequest` for the same tool call plays next, through the
 *   settings' hooks.
 * - `FAKE_CLAUDE_HELD_OUT`: a file each held hook command appends one JSON
 *   line to: its process group, the event, and the files its stdout and exit
 *   code land in once it exits. Killing the group with SIGTERM is what Claude
 *   Code does when the human answers the prompt in the terminal.
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
 * - Each `--plugin-dir` a session was launched with is loaded as Claude Code
 *   loads a mod: the `modules` its `hooks/hooks.json` names are imported and
 *   their `register` called. Every user message in the inbox goes through the
 *   `session.receive` handlers first, and one a handler consumes plays no
 *   replies. A handler's `$.command.run({ command: "clear" })` clears as
 *   `/clear` does: `SessionEnd` with reason `clear`, a new session id, then
 *   `SessionStart` with source `clear`, through the settings' hook commands;
 *   its `FAKE_CLAUDE_AGENTS` record takes the new session id and keeps its
 *   short id.
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
 * - `FAKE_CLAUDE_USAGE`: a JSON file of what the `get_usage` control request
 *   answers. `-p --input-format stream-json` reads control requests from
 *   stdin until it ends and answers each `get_usage` with the file's contents,
 *   or with an error response when there is no file. It is sent no prompt,
 *   so it plays nothing else.
 * - A `{ statusLine: payload }` step runs the `statusLine.command` of the
 *   session's `--settings`, as Claude Code does on each update, with the
 *   payload (the session id and folder filled in) as JSON on stdin.
 *
 * Anything else it is asked to do exits 1 with a message saying so, so a test
 * that reaches further than the fake goes is loud about it.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);

/** What a session's inbox server needs to know, handed over as one JSON argument. */
interface Session {
	id: string;
	cwd: string;
	socket: string;
	token: string;
	settings: string | undefined;
	/** The `--plugin-dir` folders, loaded as mods. */
	plugins: string[];
}

/** A session in `FAKE_CLAUDE_AGENTS`: what resuming it needs, and what `agents --json` says of it. */
interface Agent extends Session {
	/** The session id since its last `/clear`; `id` stays the first, as its short id does. */
	sessionId?: string;
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
		process.stdout.write(`${JSON.stringify(agents.map((agent) => ({ id: agent.id.slice(0, 8), sessionId: agent.sessionId ?? agent.id, name: agent.name, status: agent.status, state: agent.state, ...(agent.waitingFor === undefined ? {} : { waitingFor: agent.waitingFor }) })))}\n`);
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
		const agent = registry().find((each) => (each.sessionId ?? each.id) === argv[2]);
		if (!agent) {
			process.stderr.write(`fake claude: no session ${argv[2]} to resume\n`);
			process.exit(1);
		}
		rmSync(agent.socket, { force: true });
		const sockets = process.env.FAKE_CLAUDE_SOCKETS;
		const session: Session = { ...agent, id: agent.sessionId ?? agent.id, socket: sockets ? join(sockets, `${randomBytes(4).toString("hex")}.sock`) : agent.socket, token: `inbox-${randomBytes(4).toString("hex")}` };
		record({ ...agent, socket: session.socket, token: session.token, live: true, status: "running", state: "idle" });
		if (sockets) await openInbox(session);
		playSteps([{ event: "SessionStart", payload: { source: "resume" } }], session, "");
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
				plugins: argv.flatMap((arg, index) => (arg === "--plugin-dir" && argv[index + 1] !== undefined ? [argv[index + 1]] : [])),
			};
			const name = argv.indexOf("--name") === -1 ? undefined : argv[argv.indexOf("--name") + 1];
			record({ ...session, name, live: true, status: "running", state: "idle" });
			if (process.env.FAKE_CLAUDE_HOOKS && sockets) await openInbox(session);
			play(process.env.FAKE_CLAUDE_HOOKS, session, argv.at(-1) ?? "");
			process.stdout.write("fake claude: background session started\n");
		}
		process.exit(exit);
	}

	if (argv[0] === "-p" && argv.includes("--input-format") && argv[argv.indexOf("--input-format") + 1] === "stream-json") {
		await answerControlRequests();
		process.exit(0);
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

/** Answer each `get_usage` control request on stdin from `FAKE_CLAUDE_USAGE`, until stdin ends. */
async function answerControlRequests(): Promise<void> {
	const file = process.env.FAKE_CLAUDE_USAGE;
	let buffered = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		buffered += chunk as string;
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			const message = parsed(line) as { type?: string; request_id?: string; request?: { subtype?: string } } | undefined;
			if (message?.type !== "control_request" || message.request?.subtype !== "get_usage") continue;
			const response =
				file && existsSync(file)
					? { subtype: "success", request_id: message.request_id, response: JSON.parse(readFileSync(file, "utf8")) as unknown }
					: { subtype: "error", request_id: message.request_id, error: "fake claude: no get_usage scripted" };
			process.stdout.write(`${JSON.stringify({ type: "control_response", response })}\n`);
		}
	}
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
type HookStep = ({ event: string; payload?: Record<string, unknown>; hold?: boolean } | { write: "result" } | { edit: string; commit?: string } | { statusLine: Record<string, unknown> }) & { when?: string };

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
		connection.on("end", async () => {
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
					const content = message.message.content;
					if (!(await consumed(session, content))) play(process.env.FAKE_CLAUDE_REPLIES, session, content);
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

/** A mod's `session.receive` handler, as Claude Code calls it. */
type Receive = ($: unknown, event: { text: string }, next: (event: { text: string }) => unknown) => unknown;

/** Run the message through the session's mods; true when one consumed it. */
async function consumed(session: Session, text: string): Promise<boolean> {
	const handlers: Receive[] = [];
	for (const plugin of session.plugins) {
		const hooks = join(plugin, "hooks", "hooks.json");
		if (!existsSync(hooks)) continue;
		for (const module of (JSON.parse(readFileSync(hooks, "utf8")) as { modules?: string[] }).modules ?? []) {
			const loaded = (await import(join(plugin, "hooks", module))) as { register?: (on: (event: string, handler: Receive) => void) => void };
			loaded.register?.((event, handler) => {
				if (event === "session.receive") handlers.push(handler);
			});
		}
	}
	const $ = {
		command: {
			async run({ command }: { command: string }): Promise<void> {
				if (command !== "clear") throw new Error(`fake claude: no scripted command /${command}`);
				playSteps([{ event: "SessionEnd", payload: { reason: "clear" } }], session, "");
				const before = registry().find((each) => (each.sessionId ?? each.id) === session.id);
				session.id = randomUUID();
				if (before) record({ ...before, sessionId: session.id });
				playSteps([{ event: "SessionStart", payload: { source: "clear" } }], session, "");
			},
		},
	};
	const through = (index: number, event: { text: string }): unknown => {
		const handler = handlers[index];
		return handler === undefined ? undefined : handler($, event, (next) => through(index + 1, next));
	};
	const result = (await through(0, { text })) as { consumed?: unknown } | undefined;
	return result?.consumed !== undefined;
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
function play(script: string | undefined, session: Session, pointer: string): void {
	if (script) playSteps(JSON.parse(readFileSync(script, "utf8")) as HookStep[], session, pointer);
}

/** Play steps against the session's settings and pointer. */
function playSteps(steps: HookStep[], session: Session, pointer: string): void {
	const settings = JSON.parse(session.settings ?? "{}") as { hooks?: Record<string, { matcher?: string; hooks: { command: string }[] }[]>; statusLine?: { command?: string } };
	const inbox = { CLAUDE_CODE_MESSAGING_SOCKET: session.socket, CLAUDE_CODE_MESSAGING_TOKEN: session.token };
	for (const step of steps) {
		if (step.when !== undefined && !pointer.includes(step.when)) continue;
		if ("statusLine" in step) {
			const command = settings.statusLine?.command;
			if (command === undefined) throw new Error("fake claude: the session's settings have no status line command");
			execFileSync("sh", ["-c", command], { cwd: session.cwd, input: JSON.stringify({ session_id: session.id, cwd: session.cwd, ...step.statusLine }), stdio: ["pipe", "ignore", "inherit"] });
			continue;
		}
		if ("edit" in step) {
			const task = /write your result to (\S+)\/result-\d+\.md\./.exec(pointer)?.[1]?.split("/").at(-1) ?? "task";
			const file = step.edit.replaceAll("{task}", task);
			writeFileSync(join(session.cwd, file), `edited for ${task}\n`);
			if (step.commit !== undefined) {
				execFileSync("git", ["add", "--", file], { cwd: session.cwd, stdio: "ignore" });
				execFileSync("git", ["commit", "-q", "--allow-empty", "-m", step.commit], { cwd: session.cwd, stdio: "ignore" });
			}
			continue;
		}
		if ("write" in step) {
			const result = /write your result to (\S+\.md)\./.exec(pointer)?.[1];
			if (result === undefined) throw new Error(`fake claude: the pointer names no result to write: ${pointer}`);
			writeFileSync(result, "# Result\n\nDone.\n");
			continue;
		}
		const prompt = step.event === "UserPromptSubmit" && step.payload === undefined ? { prompt: pointer } : {};
		const payload: Record<string, unknown> = { session_id: session.id, cwd: session.cwd, hook_event_name: step.event, ...prompt, ...step.payload };
		let ask = false;
		for (const group of settings.hooks?.[step.event] ?? []) {
			if (group.matcher !== undefined && group.matcher !== payload.tool_name) continue;
			for (const hook of group.hooks) {
				if (step.hold) {
					holdHook(hook.command, payload, session.cwd, { ...process.env, ...inbox });
					continue;
				}
				const out = execFileSync("sh", ["-c", hook.command], { cwd: session.cwd, input: JSON.stringify(payload), env: { ...process.env, ...inbox }, stdio: ["pipe", "pipe", "inherit"], encoding: "utf8" });
				const decided = parsed(out.trim())?.hookSpecificOutput as { permissionDecision?: unknown } | undefined;
				if (step.event === "PreToolUse" && decided?.permissionDecision === "ask") ask = true;
			}
		}
		if (ask) {
			const call = { tool_name: payload.tool_name, tool_input: payload.tool_input, ...(payload.tool_use_id === undefined ? {} : { tool_use_id: payload.tool_use_id }) };
			playSteps([{ event: "PermissionRequest", payload: { session_id: payload.session_id, ...call }, hold: true }], session, pointer);
		}
		if (step.event === "SessionEnd" && payload.reason !== "clear" && payload.reason !== "resume") {
			const agent = registry().find((each) => (each.sessionId ?? each.id) === session.id);
			if (agent) end(agent);
		}
	}
}

/**
 * Start a hook command in a process group of its own and leave it running,
 * its stdout and exit code going to files `FAKE_CLAUDE_HELD_OUT` names.
 */
function holdHook(command: string, payload: Record<string, unknown>, cwd: string, env: NodeJS.ProcessEnv): void {
	const heldOut = process.env.FAKE_CLAUDE_HELD_OUT;
	if (heldOut === undefined) throw new Error("fake claude: a held hook needs FAKE_CLAUDE_HELD_OUT");
	const dir = mkdtempSync(join(dirname(heldOut), "held-"));
	const input = join(dir, "payload.json");
	const out = join(dir, "stdout");
	const exit = join(dir, "exit");
	writeFileSync(input, JSON.stringify(payload));
	const stdin = openSync(input, "r");
	const stdout = openSync(out, "w");
	const child = spawn("sh", ["-c", 'sh -c "$1"; echo $? > "$2"', "sh", command, exit], { cwd, env, detached: true, stdio: [stdin, stdout, "ignore"] });
	closeSync(stdin);
	closeSync(stdout);
	child.unref();
	appendFileSync(heldOut, `${JSON.stringify({ pid: child.pid, event: payload.hook_event_name, out, exit })}\n`);
}
