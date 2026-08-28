/**
 * The spawn seam: what a Run's child process is started with, and what comes
 * back out of it.
 *
 * Every test drives the scripted fake RPC child, so the real `RpcClient`, the
 * real strict-JSONL framing and a real subprocess are all exercised — offline,
 * key-free and without a pi binary.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Agent } from "../agents.ts";
import { type ChildExit, type RunChild, RUN_NAME_ENV, runPreamble, spawnRun } from "../child.ts";
import { ASK_QUESTION_TOOL } from "../supervisor.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CHILD = join(TESTS_DIR, "fake-rpc-child.ts");
const EXTENSION = join(TESTS_DIR, "..", "index.ts");

const SCOUT: Agent = {
	name: "scout",
	description: "Read-only recon",
	tools: ["read", "grep"],
	systemPrompt: "Report what you find and nothing else.",
	source: "bundled",
	filePath: join(TESTS_DIR, "..", "agents", "scout.md"),
};

const started: RunChild[] = [];
after(async () => {
	await Promise.all(started.map((child) => child.stop()));
});

/** A Run against the fake child, collecting its events. */
async function spawnFake(
	options: { agent?: Agent; name?: string; task?: string; model?: string; env?: Record<string, string> } = {},
) {
	const events: JsonAgentSessionEvent[] = [];
	let settled: () => void = () => {};
	const settledOnce = new Promise<void>((resolve) => {
		settled = resolve;
	});
	let died: (exit: ChildExit) => void = () => {};
	const exited = new Promise<ChildExit>((resolve) => {
		died = resolve;
	});

	const child = await spawnRun({
		agent: options.agent ?? SCOUT,
		name: options.name ?? "scout",
		task: options.task ?? "look around",
		model: options.model,
		cliPath: FAKE_CHILD,
		env: options.env,
		onEvent(event) {
			events.push(event);
			if (event.type === "agent_settled") settled();
		},
		onExit: died,
	});
	started.push(child);

	return { child, events, exited, settledOnce };
}

/** The arguments the fake child records for itself when it starts. */
async function spawnAndReadArgv(options: Parameters<typeof spawnFake>[0] = {}): Promise<string[]> {
	const argvPath = join(mkdtempSync(join(tmpdir(), "subagents-argv-")), "argv.json");
	await spawnFake({ ...options, env: { ...options.env, FAKE_RPC_ARGV_OUT: argvPath } });
	return JSON.parse(readFileSync(argvPath, "utf-8")) as string[];
}

/** The value the child was given for `flag`. */
function flagValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}

describe("spawnRun", () => {
	it("starts the child in RPC mode with sessions and extensions off", async () => {
		const argv = await spawnAndReadArgv();

		assert.deepEqual(argv.slice(0, 2), ["--mode", "rpc"]);
		assert.ok(argv.includes("--no-session"), `expected --no-session in ${argv.join(" ")}`);
		assert.ok(argv.includes("--no-extensions"), `expected --no-extensions in ${argv.join(" ")}`);
	});

	it("re-adds this extension explicitly, so the child still has its subagent tools", async () => {
		const argv = await spawnAndReadArgv();

		assert.equal(flagValue(argv, "-e"), EXTENSION);
		assert.ok(argv.indexOf("--no-extensions") < argv.indexOf("-e"), "the -e must come after --no-extensions");
	});

	it("passes the Agent's exact tool allowlist, plus the one tool every Run has", async () => {
		const argv = await spawnAndReadArgv();

		assert.equal(flagValue(argv, "--tools"), `read,grep,${ASK_QUESTION_TOOL}`);
	});

	it("lists ask_question once, however the Agent spelled its own allowlist", async () => {
		const argv = await spawnAndReadArgv({ agent: { ...SCOUT, tools: ["read", ASK_QUESTION_TOOL] } });

		assert.equal(flagValue(argv, "--tools"), `read,${ASK_QUESTION_TOOL}`);
	});

	it("tells the child which Run it is, which is how the child knows to register ask_question", async () => {
		const envPath = join(mkdtempSync(join(tmpdir(), "subagents-env-")), "env.json");
		await spawnFake({ name: "scout-2", env: { FAKE_RPC_ENV_OUT: envPath } });

		const env = JSON.parse(readFileSync(envPath, "utf-8")) as Record<string, string>;
		assert.equal(env[RUN_NAME_ENV], "scout-2");
	});

	it("passes a model only when there is one, preferring the caller's over the Agent's", async () => {
		assert.equal(flagValue(await spawnAndReadArgv(), "--model"), undefined);
		assert.equal(flagValue(await spawnAndReadArgv({ agent: { ...SCOUT, model: "agent/model" } }), "--model"), "agent/model");
		assert.equal(
			flagValue(await spawnAndReadArgv({ agent: { ...SCOUT, model: "agent/model" }, model: "caller/model" }), "--model"),
			"caller/model",
		);
	});

	it("appends the run preamble and the Agent body as a system prompt, via a temp file", async () => {
		const argv = await spawnAndReadArgv({ name: "scout-2" });

		const promptPath = flagValue(argv, "--append-system-prompt");
		assert.ok(promptPath, `expected --append-system-prompt in ${argv.join(" ")}`);
		assert.notEqual(promptPath, SCOUT.systemPrompt, "the prompt is passed as a file, not as inline text");

		const prompt = readFileSync(promptPath, "utf-8");
		assert.ok(prompt.startsWith(runPreamble("scout-2")), `expected the preamble to open the prompt, got:\n${prompt}`);
		assert.ok(prompt.includes(SCOUT.systemPrompt), `expected the Agent body in the prompt, got:\n${prompt}`);
	});

	it("reports a child that dies mid-turn, with its exit code and its last stderr", async () => {
		const { exited } = await spawnFake({
			env: {
				FAKE_RPC_TURNS: JSON.stringify([[{ type: "agent_start" }]]),
				FAKE_RPC_EXIT_AFTER: "1",
				FAKE_RPC_EXIT_CODE: "3",
				FAKE_RPC_STDERR: "pi: out of tokens",
			},
		});

		const exit = await exited;

		assert.equal(exit.exitCode, 3);
		assert.match(exit.stderr ?? "", /out of tokens/);
	});

	it("says nothing about a child it was asked to stop, because a deliberate stop is not a failure", async () => {
		const exits: ChildExit[] = [];
		const child = await spawnRun({
			agent: SCOUT,
			name: "scout",
			task: "look around",
			cliPath: FAKE_CHILD,
			onEvent() {},
			onExit: (exit) => exits.push(exit),
		});

		await child.stop();

		assert.deepEqual(exits, []);
	});

	it("hands the child its task and streams the events back", async () => {
		const { events, settledOnce } = await spawnFake({ task: "count the call sites" });

		await settledOnce;

		assert.deepEqual(
			events.map((event) => event.type),
			["agent_start", "message_end", "agent_end", "agent_settled"],
		);
		const answered = events.find((event) => event.type === "message_end");
		assert.match(JSON.stringify(answered), /count the call sites/);
	});
});
