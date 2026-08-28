/**
 * Registration and the round trip: the `subagent` tool pi is handed, and what
 * happens between calling it and a result landing in the parent conversation.
 *
 * The Run is a real subprocess — the scripted fake RPC child — so spawn,
 * framing, settling and Delivery are all exercised end to end without a pi
 * binary or an API key.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Agent, Roster } from "../agents.ts";
import type { ChildExit, RunChild } from "../child.ts";
import { spawnRun } from "../child.ts";
import { registerSubagents } from "../index.ts";
import { ASK_QUESTION_TOOL, type QuestionDetails, RUN_SLOTS } from "../supervisor.ts";
// `started` is aliased: this file already has a `started` of its own, the children it must reap.
import { AGENT_END, AGENT_START, asked, said, SETTLED, started as toolStarted } from "./child-events.ts";
import { pidFrom, reaped } from "./processes.ts";

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

/** A pi event handler, as the extension hands it over. */
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** Records everything the extension says to the parent, and how it lands. */
function recorder(parent: Parent, tools: RegisteredTool[], sent: SentMessage[], handlers: Map<string, Handler[]>) {
	return {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
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

/** One thing the extension put above the editor, as pi was told it. */
interface WidgetCall {
	key: string;
	lines: string[] | undefined;
	placement?: string;
}

/**
 * The parent session's own lifecycle, as far as this extension sees it: a turn
 * that can be aborted, a session that can be started and shut down, and the
 * widget surface a started session hands over.
 *
 * All of it is pi's, not the extension's, so a test drives it by firing the
 * events the extension subscribed to — the same way pi would.
 */
function lifecycle(handlers: Map<string, Handler[]>) {
	const aborting = new AbortController();
	const widgets: WidgetCall[] = [];
	const ui = {
		setWidget(key: string, content: string[] | undefined, options?: { placement?: string }) {
			widgets.push({ key, lines: content, placement: options?.placement });
		},
	} as unknown as ExtensionContext["ui"];
	const ctx = { signal: aborting.signal, hasUI: true, ui } as ExtensionContext;
	// Print and JSON modes: the same session, with nowhere to put a widget.
	const headless = { ...ctx, hasUI: false } as ExtensionContext;

	async function fire(event: string, payload: Record<string, unknown>, using = ctx): Promise<void> {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, using);
	}

	return {
		/** The turn every tool call in a test runs inside. */
		aborting,
		/** Everything the extension has put above the editor, oldest first. */
		widgets,
		/** Start the session, the way pi does before anything else happens. */
		startSession: (hasUI = true) => fire("session_start", { reason: "startup" }, hasUI ? ctx : headless),
		/** Start a turn and abort it, the way a parent session that is interrupted does. */
		async abortTurn(): Promise<void> {
			await fire("agent_start", {});
			aborting.abort();
			// The reap is started by the abort listener and not awaited by it, so
			// let it get as far as stopping the children before the test looks.
			await flush();
		},
		/** Shut the session down, the way quitting or `/reload` does. */
		shutdown: (reason = "quit") => fire("session_shutdown", { reason }),
	};
}

const started: RunChild[] = [];
after(async () => {
	await Promise.all(started.map((child) => child.stop()));
});

/** The bare pi a registration test needs: it collects tools and ignores the rest. */
function bareSession(tools: RegisteredTool[]) {
	return recorder({ streaming: false }, tools, [], new Map());
}

/** The tool a test is about, named so a missing registration fails loudly. */
function requireTool(tools: RegisteredTool[], name: string): RegisteredTool {
	const tool = tools.find((candidate) => candidate.name === name);
	assert.ok(tool, `expected a ${name} tool, got ${tools.map((registered) => registered.name).join(", ") || "none"}`);
	return tool;
}

/** A parent session that records what the extension does to it. */
function fakeSession(roster: Roster = ROSTER, env?: Record<string, string>, cliPath: string = FAKE_CHILD) {
	const tools: RegisteredTool[] = [];
	const sent: SentMessage[] = [];
	const handlers = new Map<string, Handler[]>();
	const parent: Parent = { streaming: false };
	const pi = recorder(parent, tools, sent, handlers);

	registerSubagents(pi as unknown as ExtensionAPI, {
		roster,
		async spawn(options) {
			const child = await spawnRun({ ...options, cliPath, env });
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
		...lifecycle(handlers),
	};
}

const CTX = {} as ExtensionContext;

/**
 * A parent session whose Runs are stubs: no process, and events pushed by hand.
 *
 * `refuseSpawnAfter` is how many spawns succeed before `refuseSpawn` starts
 * being thrown, so a test can fail the one spawn that happens without a
 * `subagent` call in flight to report it — a Run admitted from the queue.
 */
function stubbedSession(refuseSpawn?: Error, refusePrompt?: Error, refuseSpawnAfter = 0) {
	const tools: RegisteredTool[] = [];
	const sent: SentMessage[] = [];
	const spawned: {
		name: string;
		agent: string;
		task: string;
		model?: string;
		emit: (event: JsonAgentSessionEvent) => void;
		/** Kill this Run's child out from under it, the way a crash would. */
		die: (exit: ChildExit) => void;
		prompts: string[];
		stops: number;
	}[] = [];
	const handlers = new Map<string, Handler[]>();
	const parent: Parent = { streaming: false };
	const pi = recorder(parent, tools, sent, handlers);

	registerSubagents(pi as unknown as ExtensionAPI, {
		roster: ROSTER,
		async spawn(options) {
			if (refuseSpawn && spawned.length >= refuseSpawnAfter) throw refuseSpawn;
			const child = {
				name: options.name,
				agent: options.agent.name,
				task: options.task,
				model: options.model,
				emit: options.onEvent,
				die: (exit: ChildExit) => options.onExit?.(exit),
				prompts: [] as string[],
				stops: 0,
			};
			spawned.push(child);
			return {
				prompt: async (message: string) => {
					if (refusePrompt) throw refusePrompt;
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
		...lifecycle(handlers),
	};
}

/**
 * A parent session whose spawn hangs until a test lets the child arrive.
 *
 * The window a Run is at its most orphanable in: its process is starting, so
 * there is nothing yet for anything to stop.
 */
function spawningSession() {
	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, Handler[]>();
	let cameUp = () => {};
	let arrive = () => {};
	let stops = 0;

	registerSubagents(recorder({ streaming: false }, tools, [], handlers) as unknown as ExtensionAPI, {
		roster: ROSTER,
		spawn: (options) =>
			new Promise<RunChild>((resolve) => {
				const child: RunChild = { prompt: async () => {}, stop: async () => void stops++ };
				cameUp = () => options.onStarted?.(child);
				arrive = () => resolve(child);
			}),
	});

	return {
		...lifecycle(handlers),
		/** Start a Run, and leave it starting. */
		async start(): Promise<void> {
			void call(requireTool(tools, "subagent"), { agent: "scout", task: "look around" });
			await flush();
		},
		/** Bring the child's process up, the way `spawnRun` does before sending the task. */
		up: () => cameUp(),
		/** Let the spawn finish, the way the child taking its first prompt does. */
		arrive: () => arrive(),
		/** How many times the child has been stopped. */
		stops: () => stops,
	};
}

/** Call a registered tool the way pi would, and read its text back. */
async function call(
	tool: RegisteredTool,
	params: SubagentParams | SubagentAnswerParams | SubagentWaitParams,
	signal?: AbortSignal,
): Promise<string> {
	const result = await tool.execute("call-1", params, signal, undefined, CTX);
	return result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}

/** A tool call in flight, so a test can ask whether it has come back yet. */
function watch(pending: Promise<string>): { text?: string } {
	const state: { text?: string } = {};
	pending.then((text) => {
		state.text = text;
	});
	return state;
}

/** Let everything already queued run, so a join that could have resolved has. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
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
		// A child scripted to say nothing on its first prompt, so "nothing has been
		// delivered yet" is a fact rather than a race against a fast subprocess.
		const { subagent, sent } = fakeSession(ROSTER, { FAKE_RPC_TURNS: JSON.stringify([[]]) });

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

describe("a Run that dies", () => {
	it("delivers a failed result carrying the exit code and the child's last stderr", async () => {
		const { subagent, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		spawned[0].emit(AGENT_START);
		spawned[0].die({ exitCode: 3, stderr: "pi: out of tokens" });

		assert.equal(sent.length, 1);
		assert.equal(sent[0].customType, "subagent-delivery");
		assert.match(sent[0].content, /Run `scout` \(agent `scout`\) failed/);
		assert.match(sent[0].content, /code 3/);
		assert.match(sent[0].content, /pi: out of tokens/);
		assert.equal(sent[0].landed, "turn", "a failure wakes an idle parent like any other Delivery");
	});

	it("delivers a failure rather than an empty success when the child says nothing before dying", async () => {
		const { subagent, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		spawned[0].die({ signal: "SIGKILL" });

		assert.equal(sent.length, 1);
		assert.match(sent[0].content, /failed/);
		assert.match(sent[0].content, /SIGKILL/);
		assert.doesNotMatch(sent[0].content, /is done/);
	});

	it("fails a Waiting Run whose child dies, rather than leaving an unanswerable question open", async () => {
		const { subagent, subagentAnswer, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);

		spawned[0].die({ exitCode: 1 });

		assert.deepEqual(sent.map((message) => message.customType), ["subagent-question", "subagent-delivery"]);
		await assert.rejects(call(subagentAnswer, { name: "scout", answer: "The one in src/auth.ts." }), (error: Error) => {
			assert.match(error.message, /failed/);
			return true;
		});
	});

	it("leaves a Run that has already delivered alone when its child exits afterwards", async () => {
		const { subagent, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		spawned[0].emit(said("Found three call sites."));
		spawned[0].emit(SETTLED);
		spawned[0].die({ exitCode: 3 });

		assert.equal(sent.length, 1, "a finished Run's child exiting is how it ends, not a failure");
		assert.match(sent[0].content, /Found three call sites\./);
	});

	it("carries a real child's crash all the way through the RPC stream", async () => {
		const { subagent, sent } = fakeSession(ROSTER, {
			FAKE_RPC_TURNS: JSON.stringify([[AGENT_START]]),
			FAKE_RPC_EXIT_AFTER: "1",
			FAKE_RPC_EXIT_CODE: "3",
			FAKE_RPC_STDERR: "pi: out of tokens",
		});

		await call(subagent, { agent: "scout", task: "count the call sites" });
		const delivered = await messageAt(sent);

		assert.equal(delivered.customType, "subagent-delivery");
		assert.match(delivered.content, /Run `scout`.*failed/s);
		assert.match(delivered.content, /code 3/);
		assert.match(delivered.content, /out of tokens/);
	});
});

describe("a Run that cannot start", () => {
	it("comes back as a failed result rather than a thrown tool error, so the Run is not lost", async () => {
		const { subagent, sent } = stubbedSession(new Error("pi: unknown tool `telepathy`"));

		const result = await call(subagent, { agent: "scout", task: "look around" });

		assert.match(result, /Run `scout` \(agent `scout`\) failed/);
		assert.match(result, /could not be started/);
		assert.match(result, /unknown tool `telepathy`/);
		assert.deepEqual(sent, [], "the failure is this tool call's own result, so it is not also delivered");
	});

	it("leaves the Run listed and out of the active set, so nothing waits on it forever", async () => {
		const { subagent, subagentWait, subagentAnswer } = stubbedSession(new Error("pi: unknown tool `telepathy`"));
		await call(subagent, { agent: "scout", task: "look around" });

		assert.match(await call(subagentWait, {}), /nothing to wait for/);
		assert.match(await call(subagentWait, { names: ["scout"] }), /Run `scout`.*failed/s);
		await assert.rejects(call(subagentAnswer, { name: "scout", answer: "hello" }), (error: Error) => {
			assert.match(error.message, /failed/);
			return true;
		});
	});

	it("keeps taking work after a Run that could not start", async () => {
		const { subagent } = stubbedSession(new Error("boom"));

		await call(subagent, { agent: "scout", task: "one" });
		const second = await call(subagent, { agent: "scout", task: "two" });

		assert.match(second, /scout-2/, "a Run that failed to start still owns its name");
	});

	it("reports a pi that is not there as a failed Run, over the real spawn path", async () => {
		const { subagent, sent } = fakeSession(ROSTER, undefined, join(TESTS_DIR, "no-such-pi.ts"));

		const result = await call(subagent, { agent: "scout", task: "look around" });

		assert.match(result, /failed/);
		assert.match(result, /could not be started/);
		assert.deepEqual(sent, []);
	});
});

/** The name the `index`th Run of a `scout` fan-out gets, given the auto-suffixing. */
function scout(index: number): string {
	return index === 0 ? "scout" : `scout-${index + 1}`;
}

/** Fan out `count` Runs through the tool, and hand back what each call said. */
async function fanOut(subagent: RegisteredTool, count: number): Promise<string[]> {
	const results: string[] = [];
	for (let index = 0; index < count; index++) results.push(await call(subagent, { agent: "scout", task: `task ${index}` }));
	return results;
}

describe("subagent concurrency", () => {
	it("queues a Run past the cap, and still hands its name back straight away", async () => {
		const { subagent, subagentAnswer, spawned } = stubbedSession();

		const results = await fanOut(subagent, RUN_SLOTS + 1);

		assert.equal(spawned.length, RUN_SLOTS, "nothing past the cap has a child yet");
		assert.match(results[RUN_SLOTS], new RegExp(`\`${scout(RUN_SLOTS)}\``), "the fan-out gets its name back either way");
		assert.match(results[RUN_SLOTS], /queued/i);
		assert.match(results[RUN_SLOTS], /slot/i, "and is told why it has not started");
		// The state the Run reads as, said back to the parent that addresses it.
		await assert.rejects(call(subagentAnswer, { name: scout(RUN_SLOTS), answer: "hello" }), (error: Error) => {
			assert.match(error.message, /is queued/);
			return true;
		});
	});

	it("starts a queued Run over the real spawn path, once a slot frees", async () => {
		// Every child asks before it answers, so the cap is reached by Runs that
		// stay put: the fifth is queued because four slots are held, not because a
		// subprocess happened to be slow.
		const turns = [
			[AGENT_START, asked("Which auth module do you mean?"), AGENT_END, SETTLED],
			[AGENT_START, said("Three call sites in src/auth.ts."), AGENT_END, SETTLED],
		];
		const { subagent, subagentAnswer, sent } = fakeSession(ROSTER, { FAKE_RPC_TURNS: JSON.stringify(turns) });

		const results = await fanOut(subagent, RUN_SLOTS + 1);
		await messageAt(sent, RUN_SLOTS - 1);
		assert.match(results[RUN_SLOTS], /queued/i, "four Waiting Runs hold the four slots");

		// Answering one lets it finish, which is the only thing that frees a slot.
		await call(subagentAnswer, { name: "scout", answer: "The one in src/auth.ts." });
		await messageAt(sent, RUN_SLOTS + 1);

		const queued = sent.find((message) => message.content.includes(`\`${scout(RUN_SLOTS)}\``));
		assert.match(queued?.content ?? "", /Which auth module do you mean\?/, "the queued Run started in a child of its own");
	});

	it("starts the Run that has been queued longest when a slot frees", async () => {
		const { subagent, spawned } = stubbedSession();
		await fanOut(subagent, RUN_SLOTS + 2);

		spawned[0].emit(said("Found three call sites."));
		spawned[0].emit(SETTLED);
		await flush();

		assert.deepEqual(spawned.map((child) => child.name), [...Array.from({ length: RUN_SLOTS }, (_, index) => scout(index)), scout(RUN_SLOTS)]);
	});

	it("starts a queued Run on a slot freed by a crash, not only by a result", async () => {
		const { subagent, spawned } = stubbedSession();
		await fanOut(subagent, RUN_SLOTS + 1);

		spawned[0].die({ exitCode: 3, stderr: "pi: out of tokens" });
		await flush();

		assert.equal(spawned.length, RUN_SLOTS + 1, "a slot lost to every crash would leave a session unable to start anything");
		assert.equal(spawned[RUN_SLOTS].name, scout(RUN_SLOTS));
	});

	it("starts a queued Run on the Agent and task its own call asked for", async () => {
		const { subagent, spawned } = stubbedSession();
		await fanOut(subagent, RUN_SLOTS);
		await call(subagent, { agent: "worker", task: "rewrite the parser", model: "a-bigger-model" });

		spawned[0].emit(SETTLED);
		await flush();

		assert.equal(spawned[RUN_SLOTS].name, "worker");
		assert.equal(spawned[RUN_SLOTS].task, "rewrite the parser");
		assert.equal(spawned[RUN_SLOTS].agent, "worker");
		assert.equal(spawned[RUN_SLOTS].model, "a-bigger-model", "the model override outlives the call that queued the Run");
	});

	it("ends a queued Run with the session, though there is no child to reap", async () => {
		const { subagent, sent, spawned, shutdown } = stubbedSession();
		await fanOut(subagent, RUN_SLOTS + 1);

		await shutdown();

		assert.equal(spawned.length, RUN_SLOTS, "a Run ended before its slot came free never starts one");
		const ended = sent.find((message) => message.content.includes(`\`${scout(RUN_SLOTS)}\``));
		assert.match(ended?.content ?? "", /failed/);
		assert.match(ended?.content ?? "", /shutting down/);
	});

	it("delivers a queued Run that could not start, whose own tool call is long gone", async () => {
		const { subagent, sent, spawned } = stubbedSession(new Error("pi: unknown tool `telepathy`"), undefined, RUN_SLOTS);
		await fanOut(subagent, RUN_SLOTS + 1);

		spawned[0].emit(SETTLED);
		await flush();

		const failed = sent.find((message) => message.content.includes(`\`${scout(RUN_SLOTS)}\``));
		assert.match(failed?.content ?? "", /could not be started/);
		assert.match(failed?.content ?? "", /unknown tool `telepathy`/);
	});
});

describe("ask_question", () => {
	it("exists in a Run's own session and nowhere else", () => {
		const parentTools: RegisteredTool[] = [];
		const childTools: RegisteredTool[] = [];
		const collect = (into: RegisteredTool[]) => bareSession(into);

		registerSubagents(collect(parentTools) as unknown as ExtensionAPI, { roster: ROSTER });
		registerSubagents(collect(childTools) as unknown as ExtensionAPI, { roster: ROSTER, runName: "scout" });

		assert.deepEqual(parentTools.map((tool) => tool.name), ["subagent", "subagent_wait", "subagent_answer"]);
		assert.deepEqual(childTools.map((tool) => tool.name), [ASK_QUESTION_TOOL]);
	});

	it("returns straight away, carrying the Question for the Supervisor to read", async () => {
		const tools: RegisteredTool[] = [];
		const pi = bareSession(tools);
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
		const pi = bareSession(tools);
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
		const { subagent, subagentAnswer, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);
		assert.equal(spawned[0].stops, 0, "a Waiting Run's child is neither killed nor reaped");

		await call(subagentAnswer, { name: "scout", answer: "The one in src/auth.ts." });
		spawned[0].emit(AGENT_START);
		spawned[0].emit(SETTLED);
		// The reap goes through the child's spawn, which may still be in flight when
		// a Run settles, so stopping one is always a tick behind settling.
		await flush();

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

	it("refuses a second answer to a Run the first one already resumed", async () => {
		const { subagent, subagentAnswer, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);

		await call(subagentAnswer, { name: "scout", answer: "The one in src/auth.ts." });

		await assert.rejects(call(subagentAnswer, { name: "scout", answer: "and the tests too" }), (error: Error) => {
			assert.match(error.message, /running/);
			return true;
		});
		assert.deepEqual(spawned[0].prompts, ["The one in src/auth.ts."], "one answer, one turn");
	});

	it("leaves the Run waiting on its Question when the answer cannot be sent, rather than stranding it", async () => {
		const { subagent, subagentWait, subagentAnswer, spawned } = stubbedSession(undefined, new Error("rpc: stream closed"));
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);

		await assert.rejects(call(subagentAnswer, { name: "scout", answer: "The one in src/auth.ts." }), /stream closed/);

		// Still Waiting, so a join comes back with the Question rather than hanging
		// on a Run whose resumed turn never started.
		const collected = await call(subagentWait, {});
		assert.match(collected, /Which auth module do you mean\?/);
		// And still answerable: the second attempt gets as far as the send again,
		// rather than being refused for being in the wrong state.
		await assert.rejects(call(subagentAnswer, { name: "scout", answer: "The one in src/auth.ts." }), /stream closed/);
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

	it("returns a Run that finished before the join was placed, without waiting for anything", async () => {
		const { subagent, subagentWait, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(said("Found three call sites."));
		spawned[0].emit(SETTLED);

		const collected = await call(subagentWait, { names: ["scout"] });

		assert.match(collected, /Run `scout`/);
		assert.match(collected, /is done/);
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

	it("rejects a blank name rather than quietly waiting for everything instead", async () => {
		const { subagent, subagentWait } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		await assert.rejects(call(subagentWait, { names: ["   "] }), (error: Error) => {
			assert.match(error.message, /Unknown run/);
			return true;
		});
	});

	it("says so plainly when no Run is active, rather than waiting on nothing", async () => {
		const { subagent, subagentWait, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(SETTLED);

		assert.match(await call(subagentWait, {}), /nothing to wait for/);
	});

	it("waits on every Run that has not finished when it is given no names", async () => {
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

		// No hand-fed `agent_start`: answering is what takes the Run out of Waiting,
		// so a join placed straight after has something to sequence against.
		await call(subagentAnswer, { name: "scout", answer: "The one in src/auth.ts." });
		const rejoined = watch(call(subagentWait, { names: ["scout"] }));
		await flush();
		assert.equal(rejoined.text, undefined, "the answered Run is working again, so the join waits for it");

		spawned[0].emit(AGENT_START);
		spawned[0].emit(said("Three call sites."));
		spawned[0].emit(SETTLED);
		await flush();

		assert.match(rejoined.text ?? "", /Three call sites\./);
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

	it("collects a failed Run the same way it collects a finished one", async () => {
		const { subagent, subagentWait, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		const joined = call(subagentWait, { names: ["scout"] });
		spawned[0].die({ exitCode: 3, stderr: "pi: out of tokens" });
		const collected = await joined;

		assert.match(collected, /Run `scout`.*failed/s);
		assert.match(collected, /pi: out of tokens/);
		assert.deepEqual(sent, [], "a joined failure re-enters the conversation once, as the join's own result");
	});

	it("stops waiting on a Run that has failed, so a join on everything comes back", async () => {
		const { subagent, subagentWait, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "one" });
		await call(subagent, { agent: "worker", task: "two" });

		const joined = call(subagentWait, {});
		spawned[0].die({ exitCode: 3 });
		spawned[1].emit(said("second result"));
		spawned[1].emit(SETTLED);
		const collected = await joined;

		assert.match(collected, /Run `scout`.*failed/s);
		assert.match(collected, /Run `worker`.*second result/s);
	});

	it("collects a real child's result over the RPC stream", async () => {
		const { subagent, subagentWait } = fakeSession();
		await call(subagent, { agent: "scout", task: "count the call sites" });

		const collected = await call(subagentWait, { names: ["scout"] });

		assert.match(collected, /Run `scout`/);
		assert.match(collected, /Result for: count the call sites/);
	});
});

describe("no double delivery", () => {
	it("does not repeat a result that already reached the conversation on its own", async () => {
		const { subagent, subagentWait, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(said("Found three call sites."));
		spawned[0].emit(SETTLED);
		assert.equal(sent.length, 1, "no join was pending, so it was delivered on its own");

		const collected = await call(subagentWait, { names: ["scout"] });

		assert.match(collected, /already delivered/);
		assert.doesNotMatch(collected, /Found three call sites\./);
		assert.equal(sent.length, 1, "and the join said nothing more into the conversation");
	});

	it("hands a result to the first join that collects it and to no second one", async () => {
		const { subagent, subagentWait, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		const joined = call(subagentWait, { names: ["scout"] });
		spawned[0].emit(said("Found three call sites."));
		spawned[0].emit(SETTLED);
		assert.match(await joined, /Found three call sites\./);

		const again = await call(subagentWait, { names: ["scout"] });

		assert.match(again, /already delivered/);
		assert.doesNotMatch(again, /Found three call sites\./);
		assert.deepEqual(sent, [], "the result re-entered the conversation once, as the first join's result");
	});

	it("waits for the Run still in flight without repeating the one that already came back", async () => {
		const { subagent, subagentWait, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "one" });
		await call(subagent, { agent: "worker", task: "two" });
		spawned[0].emit(said("first result"));
		spawned[0].emit(SETTLED);

		const joined = call(subagentWait, { names: ["scout", "worker"] });
		spawned[1].emit(said("second result"));
		spawned[1].emit(SETTLED);
		const collected = await joined;

		assert.match(collected, /Run `scout`.*already delivered/s);
		assert.doesNotMatch(collected, /first result/);
		assert.match(collected, /second result/);
	});

	it("still repeats an outstanding Question, which is not a result the parent already holds", async () => {
		const { subagent, subagentWait, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);
		assert.equal(sent.length, 1);

		const collected = await call(subagentWait, { names: ["scout"] });
		const again = await call(subagentWait, { names: ["scout"] });

		assert.match(collected, /Which auth module do you mean\?/);
		assert.match(again, /Which auth module do you mean\?/);
	});

	it("does not repeat a failure that already reached the conversation on its own", async () => {
		const { subagent, subagentWait, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].die({ exitCode: 3, stderr: "pi: out of tokens" });
		assert.equal(sent.length, 1);

		const collected = await call(subagentWait, { names: ["scout"] });

		assert.match(collected, /Run `scout`.*failed/s);
		assert.match(collected, /already delivered/);
		assert.doesNotMatch(collected, /out of tokens/);
	});

	it("does not repeat a Run that could not start, whose failure was this tool call's own result", async () => {
		const { subagent, subagentWait } = stubbedSession(new Error("pi: unknown tool `telepathy`"));
		const started = await call(subagent, { agent: "scout", task: "look around" });

		const collected = await call(subagentWait, { names: ["scout"] });

		assert.match(started, /unknown tool `telepathy`/);
		assert.match(collected, /Run `scout`.*failed/s);
		assert.doesNotMatch(collected, /telepathy/);
	});
});

describe("a session that ends", () => {
	it("stops every Run's child when the session shuts down", async () => {
		const { subagent, spawned, shutdown } = stubbedSession();
		await call(subagent, { agent: "scout", task: "one" });
		await call(subagent, { agent: "worker", task: "two" });

		await shutdown();

		assert.deepEqual(spawned.map((child) => child.stops), [1, 1]);
	});

	it("stops a Waiting Run's child too, which nothing else would ever reap", async () => {
		const { subagent, spawned, shutdown } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);

		await shutdown();

		assert.equal(spawned[0].stops, 1);
	});

	it("stops every Run's child when the parent turn is aborted", async () => {
		const { subagent, spawned, abortTurn } = stubbedSession();
		await call(subagent, { agent: "scout", task: "one" });
		await call(subagent, { agent: "worker", task: "two" });

		await abortTurn();

		assert.deepEqual(spawned.map((child) => child.stops), [1, 1]);
	});

	it("stops a child that was still being spawned when the session ended", async () => {
		const session = spawningSession();
		await session.start();

		const shutting = session.shutdown();
		session.arrive();
		await shutting;

		assert.equal(session.stops(), 1, "the child arrived mid-reap, and was stopped as soon as it existed");
	});

	it("stops a child whose process is up but whose first prompt never comes back", async () => {
		const session = spawningSession();
		await session.start();
		session.up();
		await flush();

		await session.shutdown();

		assert.equal(session.stops(), 1, "the spawn never finished, and the reap did not wait for it to");
	});

	it("stops a child that comes up after the session has already gone", async () => {
		const session = spawningSession();
		await session.start();
		await session.shutdown();

		session.up();
		await flush();

		assert.equal(session.stops(), 1, "nothing was left to reap it, so it stops itself on arrival");
	});

	it("finishes shutting down while a child is still starting, rather than hanging on it", async () => {
		const session = spawningSession();
		await session.start();

		// The process never even comes up, so there is nothing to signal and
		// nothing to wait for. The session still has to end.
		await session.shutdown();
	});

	it("reports every Run it ended, without waking the session it just stopped", async () => {
		const { subagent, sent, abortTurn } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		await abortTurn();

		assert.equal(sent.length, 1);
		assert.equal(sent[0].customType, "subagent-delivery");
		assert.match(sent[0].content, /Run `scout` \(agent `scout`\) failed/);
		assert.match(sent[0].content, /the parent turn was aborted/);
		assert.equal(sent[0].landed, "transcript", "the parent asked for everything to stop; saying so must not start a turn");
	});

	it("says nothing more about a Run that had already delivered", async () => {
		const { subagent, sent, spawned, shutdown } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(said("Found three call sites."));
		spawned[0].emit(SETTLED);

		await shutdown();

		assert.equal(sent.length, 1, "a finished Run is not failed on the way out");
		assert.match(sent[0].content, /Found three call sites\./);
	});

	it("ends a wait in flight when its turn is aborted, and delivers its Runs elsewhere", async () => {
		const { subagent, subagentWait, sent, aborting, abortTurn } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		const joined = assert.rejects(
			call(subagentWait, {}, aborting.signal),
			"a join whose result nobody will read has to end, not resolve",
		);

		await abortTurn();

		await joined;
		assert.equal(sent.length, 1);
		assert.match(sent[0].content, /Run `scout`.*failed/s);
		assert.match(sent[0].content, /the parent turn was aborted/);
	});

	it("keeps working after a shutdown it has already handled", async () => {
		const { subagent, spawned, shutdown } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		await shutdown();
		await shutdown();

		assert.equal(spawned[0].stops, 1, "the second shutdown has nothing left to stop");
	});

	it("leaves no pi process behind, even one that ignores the SIGTERM", async () => {
		const pidPath = join(mkdtempSync(join(tmpdir(), "subagents-shutdown-")), "pid");
		const { subagent, shutdown } = fakeSession(ROSTER, {
			FAKE_RPC_PID_OUT: pidPath,
			FAKE_RPC_IGNORE_SIGTERM: "1",
			FAKE_RPC_TURNS: JSON.stringify([[]]),
		});
		await call(subagent, { agent: "scout", task: "look around" });
		const pid = Number(readFileSync(pidPath, "utf-8"));

		await shutdown();

		assert.ok(await reaped(pid), `pid ${pid} was still alive after the session shut down`);
	});

	it("leaves no pi process behind when the session ends before the Run took its task", async () => {
		const pidPath = join(mkdtempSync(join(tmpdir(), "subagents-starting-")), "pid");
		const { subagent, shutdown } = fakeSession(ROSTER, { FAKE_RPC_PID_OUT: pidPath, FAKE_RPC_SILENT: "1" });
		// The child never acknowledges its first prompt, so this call is still
		// inside `spawn` — the window where the Run has a process and no handle.
		const starting = call(subagent, { agent: "scout", task: "look around" });
		const pid = await pidFrom(pidPath);

		await shutdown();

		assert.ok(await reaped(pid), `pid ${pid} outlived the session that was still starting it`);
		assert.match(await starting, /Run `scout`.*did not start/s, "the Run that never started is named, not lost");
	});
});

describe("subagents widget", () => {
	it("shows the Runs in flight above the editor, and nothing at all when there are none", async () => {
		const session = stubbedSession();
		await session.startSession();
		// Snapshotted rather than asserted in place: `deepEqual` narrows what it is
		// given, and the rest of this test still needs `widgets` to hold widgets.
		assert.deepEqual([...session.widgets], [], "a session with no Runs costs no widget");

		await call(session.subagent, { agent: "scout", task: "look around" });

		const shown = session.widgets.at(-1);
		assert.equal(shown?.key, "subagents");
		assert.equal(shown?.placement, "aboveEditor");
		assert.match(shown?.lines?.[0] ?? "", /1 active/);
		assert.match(shown?.lines?.[1] ?? "", /scout\s+running/);

		session.spawned[0].emit(SETTLED);

		assert.equal(session.widgets.at(-1)?.lines, undefined, "the widget goes away with the last Run");
	});

	it("says what a Run's child is doing, from the tool it started", async () => {
		const session = stubbedSession();
		await session.startSession();
		await call(session.subagent, { agent: "scout", task: "look around" });

		session.spawned[0].emit(toolStarted("read", { path: "src/auth.ts" }));

		assert.match(session.widgets.at(-1)?.lines?.[1] ?? "", /running · read src\/auth\.ts/);
		session.spawned[0].emit(SETTLED);
	});

	it("never puts a Question's text in the widget, which is a status surface", async () => {
		const session = stubbedSession();
		await session.startSession();
		await call(session.subagent, { agent: "scout", task: "look around" });

		session.spawned[0].emit(asked("Which auth module do you mean?"));
		session.spawned[0].emit(SETTLED);

		const lines = session.widgets.at(-1)?.lines ?? [];
		assert.match(lines[1] ?? "", /scout\s+waiting/);
		assert.ok(
			lines.every((line) => !line.includes("auth module")),
			`expected no question text above the editor, got ${JSON.stringify(lines)}`,
		);
		await session.shutdown();
	});

	it("puts no widget anywhere in a session that has no UI to put one in", async () => {
		const session = stubbedSession();
		await session.startSession(false);

		await call(session.subagent, { agent: "scout", task: "look around" });
		session.spawned[0].emit(toolStarted("read", { path: "src/auth.ts" }));
		session.spawned[0].emit(SETTLED);

		assert.deepEqual(session.widgets, [], "a headless session is told nothing about widgets");
	});
});
