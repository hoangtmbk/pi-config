/**
 * Registration and the round trip: the `subagent` tool pi is handed, and what
 * happens between calling it and a result landing in the parent conversation.
 *
 * The Run is a real subprocess — the scripted fake RPC child — so spawn,
 * framing, settling and Delivery are all exercised end to end without a pi
 * binary or an API key.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Agent, Roster } from "../agents.ts";
import type { RunChild } from "../child.ts";
import { spawnRun } from "../child.ts";
import { registerSubagents } from "../index.ts";
import { ASK_QUESTION_TOOL, type QuestionDetails } from "../supervisor.ts";
import { AGENT_END, AGENT_START, asked, SETTLED } from "./child-events.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CHILD = join(TESTS_DIR, "fake-rpc-child.ts");
const REPO_ROOT = join(TESTS_DIR, "..", "..", "..");

function agent(name: string, description: string, extra: Partial<Agent> = {}): Agent {
	return {
		name,
		description,
		tools: ["read"],
		systemPrompt: `${name}'s instructions.`,
		source: "bundled",
		filePath: `/fixture/${name}.md`,
		...extra,
	};
}

const ROSTER: Roster = {
	agents: [agent("scout", "Read-only recon"), agent("worker", "Edits code and runs commands")],
	problems: [],
};

interface SubagentParams {
	agent: string;
	task: string;
	name?: string;
	model?: string;
}

interface AskQuestionParams {
	question: string;
}

interface SubagentAnswerParams {
	name: string;
	answer: string;
}

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	parameters: { properties: Record<string, unknown>; required?: string[] };
	execute: (
		toolCallId: string,
		params: SubagentParams | AskQuestionParams | SubagentAnswerParams,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
}

interface SentMessage {
	content: string;
	customType: string;
	triggerTurn?: boolean;
}

const started: RunChild[] = [];
after(async () => {
	await Promise.all(started.map((child) => child.stop()));
});

function requireTool(tools: RegisteredTool[], name: string): RegisteredTool {
	const tool = tools.find((candidate) => candidate.name === name);
	assert.ok(tool, `expected a ${name} tool, got ${tools.map((registered) => registered.name).join(", ") || "none"}`);
	return tool;
}

/** A parent session that records what the extension does to it. */
function fakeSession(roster: Roster = ROSTER, env?: Record<string, string>) {
	const tools: RegisteredTool[] = [];
	const sent: SentMessage[] = [];

	const pi = {
		registerTool(tool: unknown) {
			tools.push(tool as RegisteredTool);
		},
		sendMessage(message: { customType: string; content: string }, options?: { triggerTurn?: boolean }) {
			sent.push({ customType: message.customType, content: message.content, triggerTurn: options?.triggerTurn });
		},
	};

	registerSubagents(pi as unknown as ExtensionAPI, {
		roster,
		async spawn(options) {
			const child = await spawnRun({ ...options, cliPath: FAKE_CHILD, env });
			started.push(child);
			return child;
		},
	});

	return { subagent: requireTool(tools, "subagent"), subagentAnswer: requireTool(tools, "subagent_answer"), tools, sent };
}

const CTX = {} as ExtensionContext;

/** A parent session whose Runs are stubs: no process, and events pushed by hand. */
function stubbedSession() {
	const tools: RegisteredTool[] = [];
	const sent: SentMessage[] = [];
	const spawned: { name: string; emit: (event: JsonAgentSessionEvent) => void; prompts: string[]; stops: number }[] = [];

	const pi = {
		registerTool(tool: unknown) {
			tools.push(tool as RegisteredTool);
		},
		sendMessage(message: { customType: string; content: string }, options?: { triggerTurn?: boolean }) {
			sent.push({ customType: message.customType, content: message.content, triggerTurn: options?.triggerTurn });
		},
	};

	registerSubagents(pi as unknown as ExtensionAPI, {
		roster: ROSTER,
		async spawn(options) {
			const child = { name: options.name, emit: options.onEvent, prompts: [] as string[], stops: 0 };
			spawned.push(child);
			return {
				prompt: async (message: string) => {
					child.prompts.push(message);
				},
				stop: async () => {
					child.stops++;
				},
			};
		},
	});

	return { subagent: requireTool(tools, "subagent"), subagentAnswer: requireTool(tools, "subagent_answer"), sent, spawned };
}

async function run(tool: RegisteredTool, params: SubagentParams): Promise<string> {
	const result = await tool.execute("call-1", params, undefined, undefined, CTX);
	return result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}

async function answer(tool: RegisteredTool, params: SubagentAnswerParams): Promise<string> {
	const result = await tool.execute("call-1", params, undefined, undefined, CTX);
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Wait until `sent` has a message, or give up loudly. */
async function nextMessage(sent: SentMessage[]): Promise<SentMessage> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (sent.length > 0) return sent[0];
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("no Delivery arrived within 2s");
}

describe("subagent registration", () => {
	it("registers a tool to delegate with and a tool to answer with", () => {
		const { subagent, subagentAnswer, tools } = fakeSession();

		assert.deepEqual(
			tools.map((tool) => tool.name),
			["subagent", "subagent_answer"],
		);
		assert.deepEqual(Object.keys(subagent.parameters.properties).sort(), ["agent", "model", "name", "task"]);
		assert.deepEqual(subagent.parameters.required?.slice().sort(), ["agent", "task"]);
		assert.deepEqual(Object.keys(subagentAnswer.parameters.properties).sort(), ["answer", "name"]);
		assert.deepEqual(subagentAnswer.parameters.required?.slice().sort(), ["answer", "name"]);
	});

	it("embeds the roster in its description, so there is no list-the-agents round trip", () => {
		const { subagent } = fakeSession();

		assert.match(subagent.description, /scout/);
		assert.match(subagent.description, /Read-only recon/);
		assert.match(subagent.description, /worker/);
		assert.match(subagent.description, /Edits code and runs commands/);
	});

	it("says so plainly when no agents were discovered", () => {
		const { subagent } = fakeSession({ agents: [], problems: [] });

		assert.match(subagent.description, /no agents/i);
	});

	it("is listed in the package manifest, so a fresh session loads it", () => {
		const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
			pi: { extensions: string[] };
		};
		assert.ok(manifest.pi.extensions.includes("./extensions/subagents/index.ts"), manifest.pi.extensions.join(", "));
	});
});

describe("subagent", () => {
	it("returns a Run's name immediately, without waiting for its result", async () => {
		const { subagent, sent } = fakeSession();

		const result = await run(subagent, { agent: "scout", task: "look around" });

		assert.match(result, /scout/);
		assert.deepEqual(sent, [], "the parent turn continues; nothing has been delivered yet");
	});

	it("auto-suffixes the second Run of the same agent", async () => {
		const { subagent } = fakeSession();

		await run(subagent, { agent: "scout", task: "one" });
		const second = await run(subagent, { agent: "scout", task: "two" });

		assert.match(second, /scout-2/);
	});

	it("delivers the child's last assistant message into the parent conversation, waking it", async () => {
		const { subagent, sent } = fakeSession();

		await run(subagent, { agent: "scout", task: "count the call sites" });
		const delivered = await nextMessage(sent);

		assert.match(delivered.content, /Run `scout`/);
		assert.match(delivered.content, /Result for: count the call sites/);
		assert.equal(delivered.triggerTurn, true);
	});

	it("rejects an unknown agent with the names that would have worked", async () => {
		const { subagent } = fakeSession();

		await assert.rejects(run(subagent, { agent: "nobody", task: "anything" }), (error: Error) => {
			assert.match(error.message, /nobody/);
			assert.match(error.message, /scout/);
			assert.match(error.message, /worker/);
			return true;
		});
	});
});

describe("ask_question", () => {
	it("exists in a Run's own session and nowhere else", () => {
		const parentTools: RegisteredTool[] = [];
		const childTools: RegisteredTool[] = [];
		const collect = (into: RegisteredTool[]) => ({
			registerTool: (tool: unknown) => into.push(tool as RegisteredTool),
			sendMessage: () => {},
		});

		registerSubagents(collect(parentTools) as unknown as ExtensionAPI, { roster: ROSTER });
		registerSubagents(collect(childTools) as unknown as ExtensionAPI, { roster: ROSTER, runName: "scout" });

		assert.deepEqual(parentTools.map((tool) => tool.name), ["subagent", "subagent_answer"]);
		assert.deepEqual(childTools.map((tool) => tool.name), [ASK_QUESTION_TOOL]);
	});

	it("returns straight away, carrying the Question for the Supervisor to read", async () => {
		const tools: RegisteredTool[] = [];
		const pi = { registerTool: (tool: unknown) => tools.push(tool as RegisteredTool), sendMessage: () => {} };
		registerSubagents(pi as unknown as ExtensionAPI, { roster: ROSTER, runName: "scout" });
		const askQuestion = tools[0];

		const result = await askQuestion.execute(
			"call-1",
			{ question: "Which auth module do you mean?" },
			undefined,
			undefined,
			CTX,
		);

		assert.deepEqual(result.details, { question: "Which auth module do you mean?" } satisfies QuestionDetails);
		assert.equal(Object.keys(askQuestion.parameters.properties).join(), "question");
	});

	it("refuses an empty question, so the Run keeps working rather than waiting on nothing", async () => {
		const tools: RegisteredTool[] = [];
		const pi = { registerTool: (tool: unknown) => tools.push(tool as RegisteredTool), sendMessage: () => {} };
		registerSubagents(pi as unknown as ExtensionAPI, { roster: ROSTER, runName: "scout" });

		await assert.rejects(
			tools[0].execute("call-1", { question: "   " }, undefined, undefined, CTX),
		);
	});
});

describe("a Run that asks", () => {
	it("delivers the Question into the parent conversation, attributed to the Run", async () => {
		const { subagent, sent, spawned } = stubbedSession();
		await run(subagent, { agent: "scout", task: "look around" });

		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);

		assert.equal(sent.length, 1);
		assert.equal(sent[0].customType, "subagent-question");
		assert.match(sent[0].content, /Run `scout`/);
		assert.match(sent[0].content, /Which auth module do you mean\?/);
		assert.equal(sent[0].triggerTurn, true);
	});

	it("leaves its child alive while it waits, and stops it only once it is done", async () => {
		const { subagent, spawned } = stubbedSession();
		await run(subagent, { agent: "scout", task: "look around" });

		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);
		assert.equal(spawned[0].stops, 0, "a Waiting Run's child is neither killed nor reaped");

		spawned[0].emit(AGENT_START);
		spawned[0].emit(SETTLED);
		assert.equal(spawned[0].stops, 1);
	});

	it("carries a real child's Question all the way through the RPC stream", async () => {
		const events = [AGENT_START, asked("Which auth module do you mean?"), AGENT_END, SETTLED];
		const { subagent, sent } = fakeSession(ROSTER, { FAKE_RPC_EVENTS: JSON.stringify(events) });

		await run(subagent, { agent: "scout", task: "look around" });
		const question = await nextMessage(sent);

		assert.equal(question.customType, "subagent-question");
		assert.match(question.content, /Which auth module do you mean\?/);
	});
});

describe("subagent_answer", () => {
	it("resumes a Waiting Run by sending the answer to its child as a fresh prompt", async () => {
		const { subagent, subagentAnswer, spawned } = stubbedSession();
		await run(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);

		const acknowledged = await answer(subagentAnswer, { name: "scout", answer: "The one in src/auth.ts." });

		assert.deepEqual(spawned[0].prompts, ["The one in src/auth.ts."]);
		assert.match(acknowledged, /scout/);
	});
});
