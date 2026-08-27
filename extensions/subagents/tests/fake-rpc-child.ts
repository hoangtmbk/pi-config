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
 *  - `FAKE_RPC_EVENTS` — a JSON array of events to emit on every prompt, in
 *    place of the default settle-with-one-answer sequence.
 *  - `FAKE_RPC_ENV_OUT` — a path to write its own `PI_*` environment to, as a
 *    JSON object, so a test can assert on what the child was told.
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

const scripted: unknown[] | undefined = process.env.FAKE_RPC_EVENTS ? JSON.parse(process.env.FAKE_RPC_EVENTS) : undefined;

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
	for (const event of scripted ?? defaultEvents(command.message ?? "")) emit(event);
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
