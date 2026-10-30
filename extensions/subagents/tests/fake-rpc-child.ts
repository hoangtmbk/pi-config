/**
 * A scripted stand-in for a child pi process, speaking the RPC JSONL protocol.
 *
 * `RpcClient` spawns `node <cliPath> --mode rpc …`, so pointing `cliPath` here
 * gives the whole spawn path — arguments, framing, event delivery — a real
 * subprocess to run against without a pi binary, an API key or a network.
 *
 * It is driven by the environment, because the CLI arguments belong to the code
 * under test:
 *
 *  - `FAKE_RPC_ARGV_OUT` — a path to write the arguments it was spawned with, as
 *    a JSON array, so a test can assert on them.
 *  - `FAKE_RPC_TURNS` — a JSON array of event arrays, one per prompt in order,
 *    in place of the default settle-with-one-answer sequence. One entry scripts
 *    a Run that settles on its first turn; several script a Run that asks a
 *    question and carries on with the answer. Prompts past the end fall back to
 *    the default.
 *  - `FAKE_RPC_ENV_OUT` — a path to write its own `PI_*` environment to, as a
 *    JSON object, so a test can assert on what the child was told.
 *  - `FAKE_RPC_STDERR` — a line to write to stderr on startup, to stand in for
 *    whatever a real child would have complained about before dying.
 *  - `FAKE_RPC_EXIT_CODE` and `FAKE_RPC_EXIT_AFTER` — die with that code once
 *    that many prompts have been served (default 0: die before the parent's
 *    first prompt, which is what a child that cannot start looks like).
 *  - `FAKE_RPC_PID_OUT` — a path to write its own pid to, so a test can ask the
 *    operating system whether the process is really gone.
 *  - `FAKE_RPC_IGNORE_SIGTERM` — swallow SIGTERM, standing in for a child too
 *    wedged to take the polite way out. Only SIGKILL ends it.
 *  - `FAKE_RPC_SILENT` — never answer a prompt, not even to acknowledge it, so
 *    the spawn that sent it never finishes. A child that is up and unreachable.
 *
 * A `steer` is taken the way pi takes one. It is queued and announced in a
 * `queue_update`, and then it waits: nothing reads it until a turn reaches a
 * boundary, which for a child that has already settled means not until its next
 * prompt. A turn script can hold a turn open for one with the marker event
 * `{ "type": "fake:await_steer" }` — the turn stops there, and the next steer
 * is read (a `queue_update` emptying the queue, then the steer as a user
 * message) before the rest of the turn is played out. That is a Run that is
 * still working when it is steered; without the marker, every steer lands on a
 * child that has already settled, which is the race a steer can lose.
 *
 * Not a `.test.ts` file, so `npm test` never runs it directly.
 */

import { writeFileSync } from "node:fs";

const argvOut = process.env.FAKE_RPC_ARGV_OUT;
if (argvOut) writeFileSync(argvOut, JSON.stringify(process.argv.slice(2)), "utf-8");

const pidOut = process.env.FAKE_RPC_PID_OUT;
if (pidOut) writeFileSync(pidOut, String(process.pid), "utf-8");

// An empty handler is how a Node process refuses SIGTERM: it replaces the
// default terminate-on-signal behaviour with doing nothing at all.
if (process.env.FAKE_RPC_IGNORE_SIGTERM) process.on("SIGTERM", () => {});

const envOut = process.env.FAKE_RPC_ENV_OUT;
if (envOut) {
	const piEnv = Object.entries(process.env).filter(([name]) => name.startsWith("PI_"));
	writeFileSync(envOut, JSON.stringify(Object.fromEntries(piEnv)), "utf-8");
}

const stderrLine = process.env.FAKE_RPC_STDERR;
if (stderrLine) process.stderr.write(`${stderrLine}\n`);

const turns: unknown[][] | undefined = process.env.FAKE_RPC_TURNS ? JSON.parse(process.env.FAKE_RPC_TURNS) : undefined;

const silent = Boolean(process.env.FAKE_RPC_SILENT);

/**
 * The marker a turn script holds a turn open with, until a steer arrives.
 *
 * Not a pi event, and never emitted: it is consumed here.
 */
const AWAIT_STEER = "fake:await_steer";

const exitCode = process.env.FAKE_RPC_EXIT_CODE ? Number(process.env.FAKE_RPC_EXIT_CODE) : undefined;
const exitAfter = Number(process.env.FAKE_RPC_EXIT_AFTER ?? 0);

/**
 * Die, once everything already written has reached the parent.
 *
 * `process.exit` would truncate the turn's events on their way down the pipe,
 * so this drops the one handle holding the loop open and lets the exit code
 * carry the process out on its own.
 */
function die(code: number): void {
	process.exitCode = code;
	process.stdin.destroy();
}

if (exitCode !== undefined && exitAfter === 0) die(exitCode);

/** How many prompts have arrived, which is what picks this turn's script. */
let promptCount = 0;

/** Steers queued and not yet read, oldest first — pi's own steering queue. */
const steering: string[] = [];

/** What is left of a turn held open on `AWAIT_STEER`, waiting to be played out. */
let held: unknown[] | undefined;

/** Strict JSONL: one record, LF-terminated, never anything else on stdout. */
function emit(record: unknown): void {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

function assistantMessage(text: string): unknown {
	return { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** One turn that answers the prompt and settles — the uneventful happy path. */
function defaultEvents(prompt: string): unknown[] {
	return [
		{ type: "agent_start" },
		assistantMessage(`Result for: ${prompt}`),
		{ type: "agent_end", messages: [], willRetry: false },
		{ type: "agent_settled" },
	];
}

/** Say what the steering queue holds now, the way pi does on every change to it. */
function queueUpdate(): void {
	emit({ type: "queue_update", steering: [...steering], followUp: [] });
}

/**
 * Read every queued steer into the turn, as pi does at a turn boundary: the
 * queue empties, then each steer goes into the conversation as a user message.
 */
function readSteers(): void {
	if (steering.length === 0) return;
	const read = steering.splice(0);
	queueUpdate();
	for (const text of read) {
		const message = { role: "user", content: [{ type: "text", text }], timestamp: 0 };
		emit({ type: "message_start", message });
		emit({ type: "message_end", message });
	}
}

/** Emit a turn's events, stopping at an `AWAIT_STEER` and keeping the rest for it. */
function play(events: unknown[]): void {
	for (let index = 0; index < events.length; index++) {
		if ((events[index] as { type?: string }).type === AWAIT_STEER) {
			held = events.slice(index + 1);
			return;
		}
		emit(events[index]);
	}
	if (exitCode !== undefined && promptCount >= exitAfter) die(exitCode);
}

function handle(line: string): void {
	if (!line.trim()) return;
	const command = JSON.parse(line) as { id?: string; type: string; message?: string };

	// A silent child leaves the prompt unacknowledged, so whoever sent it waits
	// for good. It stays up and answering nothing, which is what a wedged pi
	// looks like from the outside.
	if (silent && command.type === "prompt") return;

	// Queued, and said to be, before the response — the order pi writes them in.
	if (command.type === "steer") {
		steering.push(command.message ?? "");
		queueUpdate();
	}

	// Every command gets a response; `RpcClient.send` waits for one before its
	// promise resolves, prompts included. A prompt or steer also says what pi did
	// with it, and `RpcClient` reads that whether or not anybody wants it: a
	// steer is queued, and a prompt into this child always starts a run.
	const disposition = command.type === "steer" ? "queued" : command.type === "prompt" ? "started" : undefined;
	emit({ id: command.id, type: "response", command: command.type, success: true, ...(disposition && { data: { disposition } }) });

	if (command.type === "steer") {
		// A turn held open for a steer reads it now. A settled child holds it,
		// unread, until its next prompt — which is what pi does, too.
		if (!held) return;
		const rest = held;
		held = undefined;
		readSteers();
		play(rest);
		return;
	}

	if (command.type !== "prompt") return;
	const turn = turns?.[promptCount++];
	// A new run reads whatever was steered into the child while it sat idle.
	readSteers();
	play(turn ?? defaultEvents(command.message ?? ""));
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
	buffer += chunk.toString("utf-8");
	for (;;) {
		const lineEnd = buffer.indexOf("\n");
		if (lineEnd === -1) break;
		const line = buffer.slice(0, lineEnd);
		buffer = buffer.slice(lineEnd + 1);
		handle(line);
	}
});
process.stdin.on("end", () => process.exit(0));
