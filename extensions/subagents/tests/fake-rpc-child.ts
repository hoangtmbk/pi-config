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
 *
 * Not a `.test.ts` file, so `npm test` never runs it directly.
 */

import { writeFileSync } from "node:fs";

const argvOut = process.env.FAKE_RPC_ARGV_OUT;
if (argvOut) writeFileSync(argvOut, JSON.stringify(process.argv.slice(2)), "utf-8");

const envOut = process.env.FAKE_RPC_ENV_OUT;
if (envOut) {
	const piEnv = Object.entries(process.env).filter(([name]) => name.startsWith("PI_"));
	writeFileSync(envOut, JSON.stringify(Object.fromEntries(piEnv)), "utf-8");
}

const stderrLine = process.env.FAKE_RPC_STDERR;
if (stderrLine) process.stderr.write(`${stderrLine}\n`);

const turns: unknown[][] | undefined = process.env.FAKE_RPC_TURNS ? JSON.parse(process.env.FAKE_RPC_TURNS) : undefined;

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

function handle(line: string): void {
	if (!line.trim()) return;
	const command = JSON.parse(line) as { id?: string; type: string; message?: string };

	// Every command gets a response; `RpcClient.send` waits for one before its
	// promise resolves, prompts included.
	emit({ id: command.id, type: "response", command: command.type, success: true });

	if (command.type !== "prompt") return;
	const turn = turns?.[promptCount++];
	for (const event of turn ?? defaultEvents(command.message ?? "")) emit(event);
	if (exitCode !== undefined && promptCount >= exitAfter) die(exitCode);
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
