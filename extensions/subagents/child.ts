/**
 * The spawn seam: the only file that knows a Run is a subprocess.
 *
 * A Run is a `pi --mode rpc` child driven by pi's exported `RpcClient`
 * (ADR-0001). The client is used rather than a hand-rolled reader on purpose:
 * the RPC stream is strict LF-only JSONL, and Node's `readline` also splits on
 * U+2028 and U+2029, which are legal inside JSON strings.
 *
 * Everything above this file talks to `RunChild`, so the Supervisor and the
 * tools never touch a process — which is what lets the lifecycle be tested by
 * writing down an event sequence.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type JsonAgentSessionEvent, RpcClient } from "@earendil-works/pi-coding-agent";
import type { Agent } from "./agents.ts";

/** This extension, re-added to the child so its subagent tools exist there. */
const EXTENSION_PATH = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

/** A Run's child process, seen from the parent. */
export interface RunChild {
	/** Send a new prompt, starting a fresh turn in the child. */
	prompt(message: string): Promise<void>;
	/** Terminate the child and clean up after it. Safe to call twice. */
	stop(): Promise<void>;
}

export interface SpawnOptions {
	agent: Agent;
	/** The Run's name — the child is told what it is. */
	name: string;
	task: string;
	/** The caller's model override, which beats the Agent's own. */
	model?: string;
	/** Where the child works. Defaults to the parent session's directory. */
	cwd?: string;
	/**
	 * Every event the child emits, in order. Subscribed before the task is sent,
	 * so nothing can be missed.
	 */
	onEvent: (event: JsonAgentSessionEvent) => void;
	/**
	 * The pi CLI to run. Defaults to the script this session was started from —
	 * a child must be the same pi as its parent. Tests point it at a fake.
	 */
	cliPath?: string;
	/** Extra environment for the child. */
	env?: Record<string, string>;
}

/**
 * What the child is told about being a Run, ahead of its Agent's own body.
 *
 * The last assistant message is the result, so the child has to know that: a
 * child that trails off after its final tool call delivers nothing.
 */
export function runPreamble(name: string): string {
	return [
		`You are \`${name}\`, one run of a subagent: a child session carrying out a single task delegated by a parent pi session.`,
		"You cannot delegate further; there is no subagent tool here.",
		"Your last assistant message is the whole of what the parent session receives, so end by stating your result in full, in the shape your instructions below ask for. Nothing else you do is visible there.",
	].join("\n\n");
}

/**
 * The arguments a Run's child is spawned with, after `--mode rpc`.
 *
 * Tool access is a strict allowlist with no default, and `--no-extensions`
 * before `-e` is what makes this extension the one deliberate exception to it.
 */
function childArgs(spec: { tools: string[]; model?: string; systemPromptPath: string }): string[] {
	const args = ["--no-session", "--no-extensions", "-e", EXTENSION_PATH, "--tools", spec.tools.join(",")];
	if (spec.model) args.push("--model", spec.model);
	args.push("--append-system-prompt", spec.systemPromptPath);
	return args;
}

/**
 * The pi this session is running from.
 *
 * A Run must be the same pi as its parent, and `RpcClient` runs `node <path>`,
 * so the entry script is the honest answer.
 */
function defaultCliPath(): string {
	const script = process.argv[1];
	if (!script) throw new Error("Cannot spawn a run: this pi session has no entry script to spawn a child from.");
	return script;
}

/**
 * Start a Run: spawn its child, subscribe to it, and hand it the task.
 *
 * Resolves once the child is up and the task is sent — not when the Run
 * finishes. The Run's completion arrives through `onEvent` (ADR-0002).
 */
export async function spawnRun(options: SpawnOptions): Promise<RunChild> {
	const promptDir = await mkdtemp(join(tmpdir(), "pi-subagent-"));
	const systemPromptPath = join(promptDir, `${options.name.replace(/[^\w.-]+/g, "_")}.md`);
	const systemPrompt = `${runPreamble(options.name)}\n\n${options.agent.systemPrompt}`;
	await writeFile(systemPromptPath, systemPrompt, { encoding: "utf-8", mode: 0o600 });

	const client = new RpcClient({
		cliPath: options.cliPath ?? defaultCliPath(),
		cwd: options.cwd,
		env: options.env,
		args: childArgs({
			tools: options.agent.tools,
			model: options.model ?? options.agent.model,
			systemPromptPath,
		}),
	});
	client.onEvent(options.onEvent);

	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await client.stop();
		await rm(promptDir, { recursive: true, force: true });
	};

	try {
		await client.start();
		await client.prompt(options.task);
	} catch (error) {
		await stop();
		throw error;
	}

	return { prompt: (message) => client.prompt(message), stop };
}
