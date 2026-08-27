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
import { AGENT_END, AGENT_START, asked, said, SETTLED } from "./child-events.ts";

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

interface SubagentWaitParams {
	names?: string[];
}

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	parameters: { properties: Record<string, unknown>; required?: string[] };
	execute: (
		toolCallId: string,
		params: SubagentParams | AskQuestionParams | SubagentAnswerParams | SubagentWaitParams,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
}

/** Where pi puts a custom message once it has read the options it was given. */
type Landing = "turn" | "steer" | "followUp" | "nextTurn" | "transcript";

interface SendOptions {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
}

interface SentMessage {
	content: string;
	customType: string;
	triggerTurn?: boolean;
	deliverAs?: string;
	/** Where it landed, given whether the parent was streaming when it was sent. */
	landed: Landing;
}

/**
 * pi's own routing rule, mirrored from `AgentSession.sendCustomMessage` (0.84.3).
 *
 * Which of idle-wake and streaming-steer happens is pi's decision, not this
 * extension's — so the only thing the extension can get right is handing pi the
 * options that make both halves of ADR-0002's Delivery policy come out right.
 * Writing the rule down here is what lets a test see both halves.
 */
function landing(options: SendOptions | undefined, streaming: boolean): Landing {
	if (options?.deliverAs === "nextTurn") return "nextTurn";
	if (streaming && options?.triggerTurn !== false) return options?.deliverAs === "followUp" ? "followUp" : "steer";
	return options?.triggerTurn ? "turn" : "transcript";
}

/** The parent session's own state, as far as Delivery cares: streaming, or idle. */
interface Parent {
	streaming: boolean;
}

/** Records everything the extension says to the parent, and how it lands. */
function recorder(parent: Parent, tools: RegisteredTool[], sent: SentMessage[]) {
	return {
		registerTool(tool: unknown) {
			tools.push(tool as RegisteredTool);
		},
		sendMessage(message: { customType: string; content: string }, options?: SendOptions) {
			sent.push({
				customType: message.customType,
				content: message.content,
				triggerTurn: options?.triggerTurn,
				deliverAs: options?.deliverAs,
				landed: landing(options, parent.streaming),
			});
		},
	};
}

const started: RunChild[] = [];
after(async () => {
	await Promise.all(started.map((child) => child.stop()));
});

/** The tool a test is about, named so a missing registration fails loudly. */
function requireTool(tools: RegisteredTool[], name: string): RegisteredTool {
	const tool = tools.find((candidate) => candidate.name === name);
	assert.ok(tool, `expected a ${name} tool, got ${tools.map((registered) => registered.name).join(", ") || "none"}`);
	return tool;
}

/** A parent session that records what the extension does to it. */
function fakeSession(roster: Roster = ROSTER, env?: Record<string, string>) {
	const tools: RegisteredTool[] = [];
	const sent: SentMessage[] = [];
	const parent: Parent = { streaming: false };
	const pi = recorder(parent, tools, sent);

	registerSubagents(pi as unknown as ExtensionAPI, {
		roster,
		async spawn(options) {
			const child = await spawnRun({ ...options, cliPath: FAKE_CHILD, env });
			started.push(child);
			return child;
		},
	});

	return {
		subagent: requireTool(tools, "subagent"),
		subagentWait: requireTool(tools, "subagent_wait"),
		subagentAnswer: requireTool(tools, "subagent_answer"),
		tools,
		sent,
		parent,
	};
}

const CTX = {} as ExtensionContext;

/** A parent session whose Runs are stubs: no process, and events pushed by hand. */
function stubbedSession() {
	const tools: RegisteredTool[] = [];
	const sent: SentMessage[] = [];
	const spawned: { name: string; emit: (event: JsonAgentSessionEvent) => void; prompts: string[]; stops: number }[] = [];
	const parent: Parent = { streaming: false };
	const pi = recorder(parent, tools, sent);

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

	return {
		subagent: requireTool(tools, "subagent"),
		subagentWait: requireTool(tools, "subagent_wait"),
		subagentAnswer: requireTool(tools, "subagent_answer"),
		sent,
		spawned,
		parent,
	};
}

/** Call a registered tool the way pi would, and read its text back. */
async function call(tool: RegisteredTool, params: SubagentParams | SubagentAnswerParams | SubagentWaitParams): Promise<string> {
	const result = await tool.execute("call-1", params, undefined, undefined, CTX);
	return result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}

/** Wait until `sent` has an `index`th message, or give up loudly. */
async function messageAt(sent: SentMessage[], index = 0): Promise<SentMessage> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (sent.length > index) return sent[index];
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`no message ${index + 1} arrived within 2s; got ${sent.length}`);
}

describe("subagent registration", () => {
	it("registers a tool to delegate with, one to wait on and one to answer with", () => {
		const { subagent, subagentWait, subagentAnswer, tools } = fakeSession();

		assert.deepEqual(
			tools.map((tool) => tool.name),
			["subagent", "subagent_wait", "subagent_answer"],
		);
		assert.deepEqual(Object.keys(subagent.parameters.properties).sort(), ["agent", "model", "name", "task"]);
		assert.deepEqual(subagent.parameters.required?.slice().sort(), ["agent", "task"]);
		assert.deepEqual(Object.keys(subagentWait.parameters.properties), ["names"]);
		assert.deepEqual(subagentWait.parameters.required ?? [], [], "waiting for everything in play takes no arguments");
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

	it("points at the join, so waiting is not mistaken for polling", () => {
		const { subagent } = fakeSession();

		assert.match(subagent.description, /subagent_wait/);
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

		const result = await call(subagent, { agent: "scout", task: "look around" });

		assert.match(result, /scout/);
		assert.deepEqual(sent, [], "the parent turn continues; nothing has been delivered yet");
	});

	it("auto-suffixes the second Run of the same agent", async () => {
		const { subagent } = fakeSession();

		await call(subagent, { agent: "scout", task: "one" });
		const second = await call(subagent, { agent: "scout", task: "two" });

		assert.match(second, /scout-2/);
	});

	it("delivers the child's last assistant message into the parent conversation, waking it", async () => {
		const { subagent, sent } = fakeSession();

		await call(subagent, { agent: "scout", task: "count the call sites" });
		const delivered = await messageAt(sent);

		assert.match(delivered.content, /Run `scout`/);
		assert.match(delivered.content, /Result for: count the call sites/);
		assert.equal(delivered.triggerTurn, true);
	});

	it("rejects an unknown agent with the names that would have worked", async () => {
		const { subagent } = fakeSession();

		await assert.rejects(call(subagent, { agent: "nobody", task: "anything" }), (error: Error) => {
			assert.match(error.message, /nobody/);
			assert.match(error.message, /scout/);
			assert.match(error.message, /worker/);
			return true;
		});
	});
});

describe("Delivery", () => {
	it("wakes an idle parent, so a result nobody asked for is not left unread", async () => {
		const { subagent, sent, spawned, parent } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		parent.streaming = false;
		spawned[0].emit(said("Found three call sites."));
		spawned[0].emit(SETTLED);

		assert.equal(sent[0].landed, "turn");
	});

	it("queues as a steer while the parent is streaming, so it never lands mid-tool-call", async () => {
		const { subagent, sent, spawned, parent } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		parent.streaming = true;
		spawned[0].emit(said("Found three call sites."));
		spawned[0].emit(SETTLED);

		assert.equal(sent[0].landed, "steer");
		assert.equal(sent[0].deliverAs, "steer");
	});

	it("delivers both Runs when two settle in the same tick, losing neither", async () => {
		const { subagent, sent, spawned, parent } = stubbedSession();
		await call(subagent, { agent: "scout", task: "one" });
		await call(subagent, { agent: "scout", task: "two" });

		parent.streaming = true;
		spawned[0].emit(said("first result"));
		spawned[1].emit(said("second result"));
		spawned[0].emit(SETTLED);
		spawned[1].emit(SETTLED);

		assert.equal(sent.length, 2);
		assert.match(sent[0].content, /Run `scout`.*first result/s);
		assert.match(sent[1].content, /Run `scout-2`.*second result/s);
		assert.deepEqual(sent.map((message) => message.landed), ["steer", "steer"]);
	});

	it("queues a Question as a steer too, so an answerable Run is not announced mid-tool-call", async () => {
		const { subagent, sent, spawned, parent } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		parent.streaming = true;
		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);

		assert.equal(sent[0].customType, "subagent-question");
		assert.equal(sent[0].landed, "steer");
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

		assert.deepEqual(parentTools.map((tool) => tool.name), ["subagent", "subagent_wait", "subagent_answer"]);
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
		await call(subagent, { agent: "scout", task: "look around" });

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
		await call(subagent, { agent: "scout", task: "look around" });

		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);
		assert.equal(spawned[0].stops, 0, "a Waiting Run's child is neither killed nor reaped");

		spawned[0].emit(AGENT_START);
		spawned[0].emit(SETTLED);
		assert.equal(spawned[0].stops, 1);
	});

	it("carries a real child's Question all the way through the RPC stream", async () => {
		const events = [AGENT_START, asked("Which auth module do you mean?"), AGENT_END, SETTLED];
		const { subagent, sent } = fakeSession(ROSTER, { FAKE_RPC_TURNS: JSON.stringify([events]) });

		await call(subagent, { agent: "scout", task: "look around" });
		const question = await messageAt(sent);

		assert.equal(question.customType, "subagent-question");
		assert.match(question.content, /Which auth module do you mean\?/);
	});
});

describe("subagent_answer", () => {
	it("resumes a Waiting Run by sending the answer to its child as a fresh prompt", async () => {
		const { subagent, subagentAnswer, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);

		const acknowledged = await call(subagentAnswer, { name: "scout", answer: "The one in src/auth.ts." });

		assert.deepEqual(spawned[0].prompts, ["The one in src/auth.ts."]);
		assert.match(acknowledged, /scout/);
	});

	it("carries a Run all the way from a Question to a Delivery, over a real RPC child", async () => {
		const turns = [
			[AGENT_START, asked("Which auth module do you mean?"), AGENT_END, SETTLED],
			[AGENT_START, said("Three call sites in src/auth.ts."), AGENT_END, SETTLED],
		];
		const { subagent, subagentAnswer, sent } = fakeSession(ROSTER, { FAKE_RPC_TURNS: JSON.stringify(turns) });
		await call(subagent, { agent: "scout", task: "count the call sites" });

		const question = await messageAt(sent);
		await call(subagentAnswer, { name: "scout", answer: "The one in src/auth.ts." });
		const delivered = await messageAt(sent, 1);

		assert.equal(question.customType, "subagent-question");
		assert.equal(delivered.customType, "subagent-delivery");
		assert.match(delivered.content, /Run `scout`/);
		assert.match(delivered.content, /Three call sites in src\/auth\.ts\./);
	});

	it("goes around the loop as often as the Run needs to", async () => {
		const turns = [
			[AGENT_START, asked("Which auth module do you mean?"), AGENT_END, SETTLED],
			[AGENT_START, asked("Should I include the tests?"), AGENT_END, SETTLED],
			[AGENT_START, said("Three call sites, tests included."), AGENT_END, SETTLED],
		];
		const { subagent, subagentAnswer, sent } = fakeSession(ROSTER, { FAKE_RPC_TURNS: JSON.stringify(turns) });
		await call(subagent, { agent: "scout", task: "count the call sites" });

		await messageAt(sent);
		await call(subagentAnswer, { name: "scout", answer: "The one in src/auth.ts." });
		const second = await messageAt(sent, 1);
		await call(subagentAnswer, { name: "scout", answer: "Yes, include the tests." });
		const delivered = await messageAt(sent, 2);

		assert.deepEqual(sent.map((message) => message.customType), [
			"subagent-question",
			"subagent-question",
			"subagent-delivery",
		]);
		assert.match(second.content, /Should I include the tests\?/);
		assert.match(delivered.content, /Three call sites, tests included\./);
	});

	it("refuses a Run that has already finished, saying which state it is in", async () => {
		const { subagent, subagentAnswer, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(SETTLED);

		await assert.rejects(call(subagentAnswer, { name: "scout", answer: "too late" }), (error: Error) => {
			assert.match(error.message, /scout/);
			assert.match(error.message, /done/);
			return true;
		});
		assert.deepEqual(spawned[0].prompts, []);
	});

	it("refuses a Run that is still working, saying which state it is in", async () => {
		const { subagent, subagentAnswer, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		await assert.rejects(call(subagentAnswer, { name: "scout", answer: "unasked for" }), (error: Error) => {
			assert.match(error.message, /running/);
			return true;
		});
		assert.deepEqual(spawned[0].prompts, []);
	});

	it("rejects an unknown name with the Runs that would have worked", async () => {
		const { subagent, subagentAnswer, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);

		await assert.rejects(call(subagentAnswer, { name: "nobody", answer: "hello" }), (error: Error) => {
			assert.match(error.message, /nobody/);
			assert.match(error.message, /scout/);
			assert.match(error.message, /waiting/);
			return true;
		});
	});

	it("says so plainly when nothing has been started to answer", async () => {
		const { subagentAnswer } = stubbedSession();

		await assert.rejects(call(subagentAnswer, { name: "scout", answer: "hello" }), (error: Error) => {
			assert.match(error.message, /no runs/i);
			return true;
		});
	});

	it("refuses an empty answer, leaving the Run waiting rather than resuming it on nothing", async () => {
		const { subagent, subagentAnswer, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);

		await assert.rejects(call(subagentAnswer, { name: "scout", answer: "   " }));
		assert.deepEqual(spawned[0].prompts, []);
	});
});

describe("subagent_wait", () => {
	it("returns a named Run's result once it settles, and lets nothing else deliver it", async () => {
		const { subagent, subagentWait, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		const joined = call(subagentWait, { names: ["scout"] });
		spawned[0].emit(said("Found three call sites."));
		spawned[0].emit(SETTLED);
		const collected = await joined;

		assert.match(collected, /Run `scout`/);
		assert.match(collected, /Found three call sites\./);
		assert.deepEqual(sent, [], "a joined result re-enters the conversation once, as the join's own result");
	});

	it("returns a Run that finished before the join was placed, straight from the mailbox", async () => {
		const { subagent, subagentWait, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(said("Found three call sites."));
		spawned[0].emit(SETTLED);

		const collected = await call(subagentWait, { names: ["scout"] });

		assert.match(collected, /Found three call sites\./);
	});

	it("rejects an unknown name with the Runs that would have worked, waiting for nothing", async () => {
		const { subagent, subagentWait } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		await assert.rejects(call(subagentWait, { names: ["scout", "nobody"] }), (error: Error) => {
			assert.match(error.message, /nobody/);
			assert.match(error.message, /scout/);
			assert.match(error.message, /running/);
			return true;
		});
	});

	it("says so plainly when nothing is in play, rather than waiting on nothing", async () => {
		const { subagent, subagentWait, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(SETTLED);

		assert.match(await call(subagentWait, {}), /nothing to wait for/);
	});

	it("waits on every Run in play when it is given no names", async () => {
		const { subagent, subagentWait, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "one" });
		await call(subagent, { agent: "worker", task: "two" });

		const joined = call(subagentWait, {});
		spawned[0].emit(said("first result"));
		spawned[0].emit(SETTLED);
		spawned[1].emit(said("second result"));
		spawned[1].emit(SETTLED);
		const collected = await joined;

		assert.match(collected, /Run `scout`.*first result/s);
		assert.match(collected, /Run `worker`.*second result/s);
		assert.deepEqual(sent, [], "both results are the join's own, so neither is delivered again");
	});

	it("ends on a Waiting Run with its Question, which can be answered and waited on again", async () => {
		const { subagent, subagentWait, subagentAnswer, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		const joined = call(subagentWait, { names: ["scout"] });
		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);

		assert.match(await joined, /Which auth module do you mean\?/);

		await call(subagentAnswer, { name: "scout", answer: "The one in src/auth.ts." });
		spawned[0].emit(AGENT_START);
		const rejoined = call(subagentWait, { names: ["scout"] });
		spawned[0].emit(said("Three call sites."));
		spawned[0].emit(SETTLED);

		assert.match(await rejoined, /Three call sites\./);
	});

	it("says a Run named twice once, so one join collects one result per Run", async () => {
		const { subagent, subagentWait, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		const joined = call(subagentWait, { names: ["scout", "scout"] });
		spawned[0].emit(said("Found three call sites."));
		spawned[0].emit(SETTLED);
		const collected = await joined;

		assert.equal(collected.match(/Found three call sites\./g)?.length, 1);
	});

	it("collects a real child's result over the RPC stream", async () => {
		const { subagent, subagentWait } = fakeSession();
		await call(subagent, { agent: "scout", task: "count the call sites" });

		const collected = await call(subagentWait, { names: ["scout"] });

		assert.match(collected, /Run `scout`/);
		assert.match(collected, /Result for: count the call sites/);
	});
});
