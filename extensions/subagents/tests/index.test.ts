/**
 * Registration and the round trip: the `subagent` tool pi is handed, and what
 * happens between calling it and a result landing in the parent conversation.
 *
 * The Run is a real subprocess — the scripted fake RPC child — so spawn,
 * framing, settling and Delivery are all exercised end to end without a pi
 * binary or an API key.
 */

import assert from "node:assert/strict";
import { existsSync, globSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	initTheme,
	type JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { Agent, Roster } from "../agents.ts";
import type { ChildExit, RunChild } from "../child.ts";
import type { SendOutcome } from "../control.ts";
import { spawnRun } from "../child.ts";
import { registerSubagents } from "../index.ts";
import { ASK_QUESTION_TOOL, type QuestionDetails, RUN_SLOTS } from "../supervisor.ts";
// `started` is aliased: this file already has a `started` of its own, the children it must reap.
import {
	AGENT_END,
	AGENT_START,
	asked,
	compacted,
	compactionEnded,
	heard,
	nudged,
	pruned,
	queued,
	said,
	SETTLED,
	status,
	started as toolStarted,
	toast,
} from "./child-events.ts";
import { pidFrom, reaped } from "./processes.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CHILD = join(TESTS_DIR, "fake-rpc-child.ts");
const REPO_ROOT = join(TESTS_DIR, "..", "..", "..");

/** The manual runner, relative to the repo root — the one file here that needs a real pi. */
const LIVE_RUNNER = "extensions/subagents/test.ts";

/** The package manifest: what pi loads, and what the scripts run. */
function manifest(): { pi: { extensions: string[] }; scripts: Record<string, string> } {
	return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
}

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
	projectAgents: [],
	problems: [],
};

/** The same session, in a checkout that carries an Agent of its own. */
const PROJECT_ROSTER: Roster = {
	...ROSTER,
	projectAgents: [agent("prospector", "This repository's own agent", { source: "project", filePath: "/repo/.pi/agents/prospector.md" })],
	projectAgentsDir: "/repo/.pi/agents",
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
	details?: unknown;
	triggerTurn?: boolean;
	deliverAs?: string;
	/** Where it landed, given whether the parent was streaming when it was sent. */
	landed: Landing;
}

/**
 * pi's own routing rule, mirrored from `AgentSession.sendCustomMessage` (1.4.0).
 *
 * Which of idle-wake and streaming-steer happens is pi's decision, not this
 * extension's — so the only thing the extension can get right is handing pi the
 * options that make both halves of ADR-0002's Delivery policy come out right.
 * Writing the rule down here is what lets a test see both halves.
 *
 * "transcript" is two of pi's paths: appended at once when the parent is idle,
 * and held to the end of the turn when it is streaming. Either way it is on the
 * record without waking anything, which is all a test here asks of it.
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

/** A slash command, as the extension registers it. */
interface RegisteredCommand {
	name: string;
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

/** Records everything the extension says to the parent, and how it lands. */
function recorder(parent: Parent, tools: RegisteredTool[], sent: SentMessage[], handlers: Map<string, Handler[]>, commands: RegisteredCommand[] = []) {
	return {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: unknown) {
			tools.push(tool as RegisteredTool);
		},
		registerCommand(name: string, command: Omit<RegisteredCommand, "name">) {
			commands.push({ name, ...command });
		},
		sendMessage(message: { customType: string; content: string; details?: unknown }, options?: SendOptions) {
			sent.push({
				customType: message.customType,
				content: message.content,
				details: message.details,
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
	const notifications: { message: string; type?: string }[] = [];
	const ui = {
		setWidget(key: string, content: string[] | undefined, options?: { placement?: string }) {
			widgets.push({ key, lines: content, placement: options?.placement });
		},
		notify(message: string, type?: string) {
			notifications.push({ message, type });
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
		/** Everything the extension has told the user in a toast, oldest first. */
		notifications,
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
	const commands: RegisteredCommand[] = [];
	const parent: Parent = { streaming: false };
	const pi = recorder(parent, tools, sent, handlers, commands);

	const control = registerSubagents(pi as unknown as ExtensionAPI, {
		roster,
		async spawn(options) {
			const child = await spawnRun({ ...options, cliPath, env });
			started.push(child);
			return child;
		},
	});
	assert.ok(control, "a parent session hands back its control plane");

	return {
		subagent: requireTool(tools, "subagent"),
		subagentWait: requireTool(tools, "subagent_wait"),
		subagentAnswer: requireTool(tools, "subagent_answer"),
		control,
		commands,
		tools,
		sent,
		parent,
		...lifecycle(handlers),
	};
}

const CTX = {} as ExtensionContext;

/**
 * A tool call's context, as far as the trust confirmation cares: whether pi
 * already trusts this project, whether there is anybody to ask, and what they
 * say when asked.
 */
function trusting(options: { trusted?: boolean; hasUI?: boolean; approve?: boolean } = {}) {
	const confirmations: { title: string; message: string }[] = [];
	const ctx = {
		cwd: "/repo",
		hasUI: options.hasUI ?? true,
		isProjectTrusted: () => options.trusted ?? false,
		ui: {
			async confirm(title: string, message: string) {
				confirmations.push({ title, message });
				return options.approve ?? false;
			},
		},
	} as unknown as ExtensionContext;

	return { ctx, confirmations };
}

/**
 * A parent session whose Runs are stubs: no process, and events pushed by hand.
 *
 * `refuseSpawnAfter` is how many spawns succeed before `refuseSpawn` starts
 * being thrown, so a test can fail the one spawn that happens without a
 * `subagent` call in flight to report it — a Run admitted from the queue.
 */
function stubbedSession(refuseSpawn?: Error, refusePrompt?: Error, refuseSpawnAfter = 0, roster: Roster = ROSTER) {
	const tools: RegisteredTool[] = [];
	const sent: SentMessage[] = [];
	const spawned: {
		name: string;
		agent: string;
		task: string;
		model?: string;
		parentModel?: string;
		emit: (event: JsonAgentSessionEvent) => void;
		/** Kill this Run's child out from under it, the way a crash would. */
		die: (exit: ChildExit) => void;
		prompts: string[];
		/** Every steer the child acknowledged, in order. */
		steers: string[];
		/**
		 * What the child does with a steer before acknowledging it — the events it
		 * writes ahead of its response. Throwing refuses the steer, and a promise
		 * holds the acknowledgement until it settles, for a send still in flight.
		 */
		onSteer?: (text: string) => void | Promise<void>;
		stops: number;
	}[] = [];
	const handlers = new Map<string, Handler[]>();
	const commands: RegisteredCommand[] = [];
	const parent: Parent = { streaming: false };
	const pi = recorder(parent, tools, sent, handlers, commands);

	const control = registerSubagents(pi as unknown as ExtensionAPI, {
		roster,
		async spawn(options) {
			if (refuseSpawn && spawned.length >= refuseSpawnAfter) throw refuseSpawn;
			const child = {
				name: options.name,
				agent: options.agent.name,
				task: options.task,
				model: options.model,
				parentModel: options.parentModel,
				emit: options.onEvent,
				die: (exit: ChildExit) => options.onExit?.(exit),
				prompts: [] as string[],
				steers: [] as string[],
				onSteer: undefined as ((text: string) => void | Promise<void>) | undefined,
				stops: 0,
			};
			spawned.push(child);
			return {
				prompt: async (message: string) => {
					if (refusePrompt) throw refusePrompt;
					child.prompts.push(message);
				},
				steer: async (message: string) => {
					await child.onSteer?.(message);
					child.steers.push(message);
				},
				stop: async () => {
					child.stops++;
				},
			};
		},
	});

	assert.ok(control, "a parent session hands back its control plane");

	return {
		subagent: requireTool(tools, "subagent"),
		subagentWait: requireTool(tools, "subagent_wait"),
		subagentAnswer: requireTool(tools, "subagent_answer"),
		control,
		commands,
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
				const child: RunChild = { prompt: async () => {}, steer: async () => {}, stop: async () => void stops++ };
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
	ctx: ExtensionContext = CTX,
): Promise<string> {
	const result = await tool.execute("call-1", params, signal, undefined, ctx);
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
		const { subagent } = fakeSession({ agents: [], projectAgents: [], problems: [] });

		assert.match(subagent.description, /no agents/i);
	});

	it("is listed in the package manifest, so a fresh session loads it", () => {
		const { pi } = manifest();

		assert.ok(pi.extensions.includes("./extensions/subagents/index.ts"), pi.extensions.join(", "));
	});

	it("has a manual runner against real pi that `npm test` cannot reach", () => {
		const { scripts } = manifest();

		assert.ok(existsSync(join(REPO_ROOT, LIVE_RUNNER)), `expected the manual runner at ${LIVE_RUNNER}`);
		const live = scripts["live:subagents"] ?? "";
		assert.ok(live.includes(LIVE_RUNNER), `\`live:subagents\` is how the runner is reached, but it runs: ${live || "nothing"}`);

		// The whole point of the exclusion, checked rather than assumed: every glob
		// `npm test` runs is expanded here, and the runner is among what none of them
		// picks up. A suite that spawned real pi would be slow, key-dependent and
		// flaky — which is what the reference repo's real-pi-in-tmux tests were.
		const globs = scripts.test.split(/\s+/).filter((argument) => argument.includes("*"));
		assert.ok(globs.length > 0, `no glob in the test script: ${scripts.test}`);
		const suite = globs.flatMap((glob) => globSync(glob, { cwd: REPO_ROOT }));
		assert.ok(suite.length > 0, `the test script's globs (${globs.join(", ")}) match nothing at all`);
		assert.ok(!suite.includes(LIVE_RUNNER), `${LIVE_RUNNER} is in what \`npm test\` runs: ${suite.join(", ")}`);
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

	it("hands the child the parent's current model, provider and all, for it to fall back to", async () => {
		const { subagent, spawned } = stubbedSession();
		const ctx = { model: { provider: "openai-codex", id: "gpt-6-luna" } } as unknown as ExtensionContext;

		await call(subagent, { agent: "scout", task: "look around" }, undefined, ctx);

		assert.equal(spawned[0].parentModel, "openai-codex/gpt-6-luna");
		assert.equal(spawned[0].model, undefined, "the parent's model is the fallback, not an override of the Agent's");
	});

	it("hands the child no parent model when the parent has none", async () => {
		const { subagent, spawned } = stubbedSession();

		await call(subagent, { agent: "scout", task: "look around" });

		assert.equal(spawned[0].parentModel, undefined);
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

/**
 * The project scope: Agents the checkout defines rather than the user.
 *
 * A project Agent file is repo-controlled prompt injection with a tool allowlist
 * attached, so nothing here may run one on the strength of it existing. The
 * roster it is listed apart from, and the trust confirmation, are the whole of
 * what stands between a checkout and a session it can steer.
 */
describe("a project agent", () => {
	/** A parent session working in a checkout that carries an Agent of its own. */
	function projectSession() {
		return stubbedSession(undefined, undefined, 0, PROJECT_ROSTER);
	}

	it("is listed apart from the roster, as something that asks before it runs", () => {
		const { subagent } = fakeSession(PROJECT_ROSTER);

		assert.match(subagent.description, /prospector: This repository's own agent/);
		assert.match(subagent.description, /confirm/i, "the model is told the run is gated, not simply available");
		assert.match(subagent.description, /\/repo\/\.pi\/agents/, "and where the definitions come from");
	});

	it("asks before spawning a Run in a project pi does not trust", async () => {
		const { subagent, spawned } = projectSession();
		const { ctx, confirmations } = trusting({ trusted: false, approve: true });

		await call(subagent, { agent: "prospector", task: "survey the repo" }, undefined, ctx);

		assert.equal(confirmations.length, 1);
		assert.match(confirmations[0].title, /prospector/);
		assert.match(confirmations[0].message, /\/repo\/\.pi\/agents\/prospector\.md/, "the confirmation names the file being trusted");
		assert.match(confirmations[0].message, /read/, "and the tools it would run with");
		assert.deepEqual(
			spawned.map((child) => child.agent),
			["prospector"],
			"an approved run spawns like any other",
		);
	});

	it("asks nothing for a user or bundled agent, however untrusted the project", async () => {
		const { subagent, spawned } = projectSession();
		const { ctx, confirmations } = trusting({ trusted: false, approve: false });

		await call(subagent, { agent: "scout", task: "look around" }, undefined, ctx);

		assert.deepEqual(confirmations, [], "the user's own agents are not the checkout's to define");
		assert.equal(spawned.length, 1);
	});

	it("asks nothing in a project pi already trusts", async () => {
		const { subagent, spawned } = projectSession();
		const { ctx, confirmations } = trusting({ trusted: true });

		await call(subagent, { agent: "prospector", task: "survey the repo" }, undefined, ctx);

		assert.deepEqual(confirmations, [], "the trust decision has already been taken, once, by the user");
		assert.equal(spawned.length, 1);
	});

	it("refuses when there is nobody to ask, rather than running unconfirmed", async () => {
		const { subagent, spawned } = projectSession();
		const { ctx, confirmations } = trusting({ trusted: false, hasUI: false });

		await assert.rejects(call(subagent, { agent: "prospector", task: "survey the repo" }, undefined, ctx), (error: Error) => {
			assert.match(error.message, /prospector/);
			assert.match(error.message, /trust/i);
			return true;
		});
		assert.deepEqual(confirmations, []);
		assert.deepEqual(spawned, [], "a headless session is not a session that says yes");
	});

	describe("declining", () => {
		it("starts nothing and leaves no Run behind", async () => {
			const { subagent, subagentWait, spawned, sent } = projectSession();
			const { ctx } = trusting({ trusted: false, approve: false });

			await assert.rejects(call(subagent, { agent: "prospector", task: "survey the repo" }, undefined, ctx), (error: Error) => {
				assert.match(error.message, /prospector/);
				return true;
			});

			assert.deepEqual(spawned, []);
			assert.deepEqual(sent, [], "nothing was started, so nothing is delivered");
			assert.match(await call(subagentWait, {}), /nothing to wait for/i, "and no Run is left for a join to hang on");
		});

		it("leaves the rest of the roster fully usable", async () => {
			const { subagent, spawned, sent } = projectSession();
			const { ctx } = trusting({ trusted: false, approve: false });
			await assert.rejects(call(subagent, { agent: "prospector", task: "survey the repo" }, undefined, ctx));

			const started = await call(subagent, { agent: "scout", task: "look around" }, undefined, ctx);

			assert.match(started, /Started run `scout`/);
			spawned[0].emit(said("Found three call sites."));
			spawned[0].emit(SETTLED);
			assert.match(sent[0].content, /Found three call sites\./);
		});

		it("asks again next time, so declining once is not a decision about every run", async () => {
			const { subagent } = projectSession();
			const declining = trusting({ trusted: false, approve: false });
			await assert.rejects(call(subagent, { agent: "prospector", task: "survey the repo" }, undefined, declining.ctx));

			const approving = trusting({ trusted: false, approve: true });
			await call(subagent, { agent: "prospector", task: "survey the repo" }, undefined, approving.ctx);

			assert.equal(declining.confirmations.length, 1);
			assert.equal(approving.confirmations.length, 1);
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

	it("starts a queued Run on the parent's model as it was when the Run was asked for", async () => {
		const { subagent, spawned } = stubbedSession();
		const ctx = { model: { provider: "anthropic", id: "claude-sonnet-5-5" } } as unknown as ExtensionContext;
		await fanOut(subagent, RUN_SLOTS);
		await call(subagent, { agent: "worker", task: "rewrite the parser" }, undefined, ctx);

		// The user switches models while the Run waits for a slot.
		(ctx as { model: unknown }).model = { provider: "openai-codex", id: "gpt-6-luna" };
		spawned[0].emit(SETTLED);
		await flush();

		assert.equal(spawned[RUN_SLOTS].parentModel, "anthropic/claude-sonnet-5-5");
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
		assert.match(
			await starting,
			/Run `scout`.*was stopped while it was starting: the session is shutting down\./s,
			"the Run that never started is named, not lost, and said to have been stopped rather than to have failed",
		);
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

describe("a Run's Pressure level", () => {
	/** A session with one running Run whose child is inside `bash`, and the widget's line for it. */
	async function busyRun() {
		const session = stubbedSession();
		await session.startSession();
		await call(session.subagent, { agent: "scout", task: "look around" });
		session.spawned[0].emit(toolStarted("bash"));
		return { ...session, row: () => session.widgets.at(-1)?.lines?.[1] ?? "" };
	}

	it("starts the Run's row with its level and count once its child reports notice", async () => {
		const { spawned, row } = await busyRun();

		spawned[0].emit(status("ctx notice · 131k"));

		assert.match(row(), /scout {2}notice 131k · running · bash/);
	});

	it("reads compacting while the child compacts, and goes back to its level after", async () => {
		const { spawned, row } = await busyRun();
		spawned[0].emit(status("ctx warning · 152k"));
		assert.match(row(), /scout {2}warning 152k · running · bash/);

		spawned[0].emit(status("ctx compacting"));
		assert.match(row(), /scout {2}compacting │$/);

		spawned[0].emit(status("ctx notice · 124k"));
		assert.match(row(), /scout {2}notice 124k · running · bash/);
	});

	it("drops the level once the child clears its status, back below notice", async () => {
		const { spawned, row } = await busyRun();
		spawned[0].emit(status("ctx notice · 131k"));

		spawned[0].emit(status(undefined));

		assert.match(row(), /scout {2}running · bash │$/);
	});

	it("reads the status through the colour a child in RPC mode sends it in", async () => {
		const { spawned, row } = await busyRun();

		spawned[0].emit(status("\x1b[38;5;178mctx warning · 152k\x1b[39m"));

		assert.match(row(), /scout {2}warning 152k · running · bash/);
	});

	it("ignores a status another of the child's extensions sets", async () => {
		const { spawned, row } = await busyRun();
		spawned[0].emit(status("ctx notice · 131k"));

		spawned[0].emit(status(undefined, "git"));
		spawned[0].emit(status("ctx warning · 152k", "git"));

		assert.match(row(), /scout {2}notice 131k · running · bash/);
	});

	it("keeps a Waiting Run's level, whose child is still holding that context", async () => {
		const { spawned, row } = await busyRun();
		spawned[0].emit(status("ctx notice · 131k"));

		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);

		assert.match(row(), /scout {2}notice 131k · waiting/);
	});

	it("raises no toast for a Run's crossings, whatever its child tries to say", async () => {
		const { spawned, notifications } = await busyRun();

		spawned[0].emit(status("ctx notice · 131k"));
		spawned[0].emit(status("ctx warning · 152k"));
		spawned[0].emit(toast("Context at 152k (warning). The agent has been told it's a good time to compact; forced at 170k."));
		spawned[0].emit(status("ctx compacting"));
		spawned[0].emit(toast("Compaction used pi's default summary; the Handoff may be thinner."));
		spawned[0].emit(status(undefined));

		assert.deepEqual(notifications, []);
	});

	it("never tells the parent agent: not in a Delivery, a Question, or what a join returns", async () => {
		const { subagent, subagentWait, subagentAnswer, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		await call(subagent, { agent: "worker", task: "fix it" });
		spawned[0].emit(status("ctx warning · 152k"));
		spawned[1].emit(status("ctx notice · 131k"));
		spawned[1].emit(asked("Which auth module do you mean?"));
		spawned[1].emit(SETTLED);
		const answered = await call(subagentAnswer, { name: "worker", answer: "src/auth.ts" });
		spawned[1].emit(status("ctx compacting"));

		const joining = call(subagentWait, { names: ["scout", "worker"] });
		spawned[0].emit(said("Found three call sites."));
		spawned[0].emit(SETTLED);
		spawned[1].emit(said("Fixed."));
		spawned[1].emit(SETTLED);
		const joined = await joining;

		const told = [...sent.map((message) => message.content), answered, joined];
		assert.ok(told.length >= 3, `expected the Question, the answer and the join, got ${JSON.stringify(told)}`);
		assert.match(joined, /Found three call sites/);
		for (const text of told) assert.doesNotMatch(text, /notice|warning|compacting|1[35][12]k/);
		// Nor in what a message carries along with its text.
		assert.doesNotMatch(JSON.stringify(sent.map((message) => message.details)), /pressure|notice|warning|compacting/);
	});

	it("carries a real child's status all the way through the RPC stream", async () => {
		const events = [
			AGENT_START,
			status("ctx notice · 131k"),
			asked("Which auth module do you mean?"),
			AGENT_END,
			SETTLED,
		];
		const session = fakeSession(ROSTER, { FAKE_RPC_TURNS: JSON.stringify([events]) });
		await session.startSession();

		await call(session.subagent, { agent: "scout", task: "look around" });
		await messageAt(session.sent);

		assert.match(session.widgets.at(-1)?.lines?.[1] ?? "", /scout {2}notice 131k · waiting/);
		await session.shutdown();
	});
});

/** A turn held open until the child is steered — a Run still working when the user types. */
const AWAIT_STEER = { type: "fake:await_steer" } as unknown as JsonAgentSessionEvent;

describe("steering a running Run", () => {
	it("hands the message to the Run's child as a steer, not as a fresh prompt", async () => {
		const { subagent, control, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		const outcome = await control.send("scout", "Only the auth module, please.");

		assert.deepEqual(outcome, { ok: true, as: "steer" });
		assert.deepEqual(spawned[0].steers, ["Only the auth module, please."]);
		assert.deepEqual(spawned[0].prompts, [], "a prompt would start a turn of its own; a steer joins the one in flight");
	});

	it("tells the parent, without waking it and without landing mid-tool-call", async () => {
		const { subagent, control, sent, parent } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		parent.streaming = true;
		await control.send("scout", "Only the auth module, please.");
		parent.streaming = false;
		await control.send("scout", "And skip the tests.");

		assert.deepEqual(sent.map((message) => message.customType), ["subagent-steer", "subagent-steer"]);
		// `triggerTurn: false` and no `deliverAs` is the one combination pi holds to
		// the end of a streaming turn and appends straight away to an idle one.
		assert.deepEqual(sent.map((message) => [message.triggerTurn, message.deliverAs]), [[false, undefined], [false, undefined]]);
		assert.deepEqual(sent.map((message) => message.landed), ["transcript", "transcript"]);
		assert.match(sent[0].content, /Run `scout`|run `scout`/);
		assert.match(sent[0].content, /Only the auth module, please\./);
		assert.deepEqual(sent[0].details, { run: "scout", agent: "scout", task: "look around", as: "steer" });
	});

	it("comes back too late for a Run that settled before the steer reached its child", async () => {
		const { subagent, control, sent, spawned, notifications } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		await flush();
		// The child settles, and only then takes the steer — queued into an idle
		// child that will never read it.
		spawned[0].onSteer = (text) => {
			spawned[0].emit(said("Found three call sites."));
			spawned[0].emit(SETTLED);
			spawned[0].emit(queued(text));
		};

		const outcome = await control.send("scout", "Only the auth module, please.");

		assert.deepEqual(outcome, { ok: false, reason: "too late — scout already finished" });
		assert.deepEqual(sent.map((message) => message.customType), ["subagent-delivery"], "the parent is told nothing about a steer that never landed");
		assert.deepEqual(notifications, [], "said once, by the send itself");
	});

	it("counts a steer the child read just before settling, though its acknowledgement came after", async () => {
		const { subagent, control, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		await flush();
		// One stdout chunk: the steer queued, read, the turn settling — and the
		// sender only resumed once all of it has been seen.
		spawned[0].onSteer = (text) => {
			spawned[0].emit(queued(text));
			spawned[0].emit(queued());
			spawned[0].emit(said("Only the auth module: three call sites."));
			spawned[0].emit(SETTLED);
		};

		const outcome = await control.send("scout", "Only the auth module, please.");

		assert.deepEqual(outcome, { ok: true, as: "steer" });
		assert.deepEqual(sent.map((message) => message.customType), ["subagent-delivery", "subagent-steer"]);
	});

	it("comes back too late for a steer still queued when the Run settled, and says so once", async () => {
		const { subagent, control, sent, spawned, notifications } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		await flush();
		spawned[0].onSteer = (text) => {
			spawned[0].emit(queued(text));
			spawned[0].emit(said("Found three call sites."));
			spawned[0].emit(SETTLED);
		};

		const outcome = await control.send("scout", "Only the auth module, please.");

		assert.deepEqual(outcome, { ok: false, reason: "too late — scout already finished" });
		assert.deepEqual(notifications, [], "the send says it; the settle must not say it again");
		assert.deepEqual(sent.map((message) => message.customType), ["subagent-delivery"]);
	});

	it("tells the user and the parent when a steer it took was never read before the Run finished", async () => {
		const { subagent, control, sent, spawned, notifications, startSession } = stubbedSession();
		await startSession();
		await call(subagent, { agent: "scout", task: "look around" });
		await flush();
		spawned[0].onSteer = (text) => spawned[0].emit(queued(text));

		const outcome = await control.send("scout", "Only the auth module, please.");
		// Acknowledged while it was working, then the turn boundary that would
		// have read it had already passed.
		spawned[0].emit(said("Found three call sites."));
		spawned[0].emit(SETTLED);

		assert.deepEqual(outcome, { ok: true, as: "steer" });
		assert.equal(notifications.length, 1);
		assert.match(notifications[0].message, /^Too late — scout finished before reading your message/);
		assert.equal(notifications[0].type, "warning");
		// The correction lands before the Delivery, so the turn the Delivery wakes
		// already knows the result ignores the steer.
		assert.deepEqual(sent.map((message) => message.customType), ["subagent-steer", "subagent-steer", "subagent-delivery"]);
		assert.match(sent[1].content, /never reached it/);
		assert.equal(sent[1].triggerTurn, false);
	});

	it("says nothing more about a steer the child read before it finished", async () => {
		const { subagent, control, spawned, notifications, startSession } = stubbedSession();
		await startSession();
		await call(subagent, { agent: "scout", task: "look around" });
		await flush();
		spawned[0].onSteer = (text) => spawned[0].emit(queued(text));

		await control.send("scout", "Only the auth module, please.");
		spawned[0].emit(queued());
		spawned[0].emit(said("Only the auth module: three call sites."));
		spawned[0].emit(SETTLED);

		assert.deepEqual(notifications, []);
	});

	it("never takes the compaction extension's own steers for a human Steer the Run did not read", async () => {
		const { subagent, control, sent, spawned, notifications, startSession } = stubbedSession();
		await startSession();
		await call(subagent, { agent: "scout", task: "one" });
		await call(subagent, { agent: "worker", task: "two" });
		await flush();
		spawned[0].onSteer = (text) => spawned[0].emit(queued(text));

		// One Run steered by the user and nudged towards Self-compaction around
		// it; the other only nudged. Both compact and finish.
		await control.send("scout", "Only the auth module, please.");
		spawned[0].emit(nudged("notice"));
		spawned[0].emit(queued());
		spawned[0].emit(heard("Only the auth module, please."));
		spawned[0].emit(nudged("warning"));
		spawned[0].emit(compacted("## Plan\nFix auth.", 172_000));
		spawned[0].emit(said("Only the auth module: three call sites."));
		spawned[0].emit(SETTLED);
		spawned[1].emit(nudged("notice"));
		spawned[1].emit(nudged("warning"));
		spawned[1].emit(compactionEnded("## Plan\nFix it.", 98_000));
		spawned[1].emit(said("Fixed."));
		spawned[1].emit(SETTLED);

		assert.deepEqual(notifications, []);
		assert.deepEqual(sent.map((message) => message.customType), ["subagent-steer", "subagent-delivery", "subagent-delivery"]);
		for (const message of sent) assert.doesNotMatch(message.content, /never reached it|Self-compact/);
	});

	it("says why it could not reach a child that refused the steer, and tells the parent nothing", async () => {
		const { subagent, control, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		await flush();
		spawned[0].onSteer = () => {
			throw new Error("rpc: stream closed");
		};

		const outcome = await control.send("scout", "Only the auth module, please.");

		assert.deepEqual(outcome, { ok: false, reason: "could not reach scout: rpc: stream closed" });
		assert.deepEqual(sent, []);
	});

	describe("sent after it asked a Question, before the Question settled", () => {
		/**
		 * A Run whose child has run `ask_question` and is still in the closing turn
		 * it takes afterwards — the Question already in its transcript for the user
		 * to read, and not yet said to the parent.
		 */
		async function asking() {
			const session = stubbedSession();
			await session.startSession();
			await call(session.subagent, { agent: "scout", task: "look around" });
			await flush();
			session.spawned[0].emit(asked("Which auth module do you mean?"));
			session.spawned[0].onSteer = (text) => session.spawned[0].emit(queued(text));
			return session;
		}

		/** The child reading the steer at its turn boundary, and finishing on it. */
		function readAndFinish(child: { emit: (event: JsonAgentSessionEvent) => void }, steer: string): void {
			child.emit(queued());
			child.emit(heard(steer));
			child.emit(said("Three call sites in src/auth.ts."));
			child.emit(AGENT_END);
			child.emit(SETTLED);
		}

		it("delivers the result the steer led to, rather than parking the Run on the Question it answered", async () => {
			const { control, sent, spawned, subagentWait } = await asking();

			const outcome = await control.send("scout", "The one in src/auth.ts.");
			readAndFinish(spawned[0], "The one in src/auth.ts.");

			assert.deepEqual(outcome, { ok: true, as: "steer" });
			assert.deepEqual(sent.map((message) => message.customType), ["subagent-steer", "subagent-delivery"]);
			assert.match(sent[1].content, /Three call sites in src\/auth\.ts\./);
			assert.match(await call(subagentWait, { names: ["scout"] }), /already delivered/, "done, not Waiting");
		});

		it("tells the parent the user answered a question it was never asked, so it has nothing to answer", async () => {
			const { control, sent, spawned } = await asking();

			await control.send("scout", "The one in src/auth.ts.");
			readAndFinish(spawned[0], "The one in src/auth.ts.");

			const note = sent[0];
			assert.equal(note.triggerTurn, false);
			assert.match(note.content, /just after it asked a question/);
			assert.match(note.content, /nothing for you to answer/);
			assert.match(note.content, /Which auth module do you mean\?/);
			assert.match(note.content, /The one in src\/auth\.ts\./);
			assert.deepEqual(note.details, {
				run: "scout",
				agent: "scout",
				task: "look around",
				as: "steer",
				question: "Which auth module do you mean?",
			});
		});

		it("refuses the parent's answer to that Question afterwards, as already answered by the user", async () => {
			const { control, spawned, subagentAnswer } = await asking();

			await control.send("scout", "The one in src/auth.ts.");
			readAndFinish(spawned[0], "The one in src/auth.ts.");

			await assert.rejects(call(subagentAnswer, { name: "scout", answer: "src/legacy/auth.ts" }), (error: Error) => {
				assert.match(error.message, /already answered by the user/);
				return true;
			});
			assert.deepEqual(spawned[0].prompts, [], "no second, stale prompt");
		});

		it("still notes a plain steer for a Run that settled on its Question before reading it", async () => {
			const { control, sent, spawned } = await asking();
			spawned[0].onSteer = (text) => {
				spawned[0].emit(SETTLED);
				spawned[0].emit(queued(text));
			};

			const outcome = await control.send("scout", "The one in src/auth.ts.");

			assert.deepEqual(outcome, { ok: true, as: "steer" });
			assert.deepEqual(sent.map((message) => message.customType), ["subagent-question", "subagent-steer"]);
			assert.doesNotMatch(sent[1].content, /nothing for you to answer/, "the parent has that Question, and still has to answer it");
		});

		it("carries the Run from the Question to its result over a real RPC child", async () => {
			const turns = [[AGENT_START, asked("Which auth module do you mean?"), AWAIT_STEER, said("Three call sites in src/auth.ts."), AGENT_END, SETTLED]];
			const { subagent, control, sent } = fakeSession(ROSTER, { FAKE_RPC_TURNS: JSON.stringify(turns) });
			// The fake child plays its turn as far as the marker the moment it takes
			// its task, so the Question is in the stream ahead of anything the steer
			// makes it write.
			await call(subagent, { agent: "scout", task: "count the call sites" });

			const outcome = await control.send("scout", "The one in src/auth.ts.");
			await messageAt(sent, 1);

			assert.deepEqual(outcome, { ok: true, as: "steer" });
			assert.deepEqual(sent.map((message) => message.customType).sort(), ["subagent-delivery", "subagent-steer"]);
			assert.match(sent.find((message) => message.customType === "subagent-delivery")?.content ?? "", /Three call sites in src\/auth\.ts\./);
		});
	});

	describe("sent twice with the same words", () => {
		/**
		 * A Run with two identical steers on their way to its child, neither
		 * acknowledged yet, and a way to let both acknowledgements back.
		 */
		async function twoInFlight() {
			const session = stubbedSession();
			await session.startSession();
			await call(session.subagent, { agent: "scout", task: "look around" });
			await flush();
			const acknowledge: (() => void)[] = [];
			session.spawned[0].onSteer = () => new Promise<void>((resolve) => acknowledge.push(resolve));
			const first = session.control.send("scout", "Only the auth module, please.");
			const second = session.control.send("scout", "Only the auth module, please.");
			await flush();
			return {
				...session,
				/** Let both acknowledgements back, and say what each send came to. */
				async outcomes(): Promise<SendOutcome[]> {
					for (const resolve of acknowledge) resolve();
					return Promise.all([first, second]);
				},
			};
		}

		it("does not count the second as arrived because the first, already read, had the same words", async () => {
			const { spawned, sent, outcomes } = await twoInFlight();
			const steer = "Only the auth module, please.";

			// The first arrives and is read; the Run finishes before the second
			// arrives, which then lands on an idle child that never reads it.
			spawned[0].emit(queued(steer));
			spawned[0].emit(queued());
			spawned[0].emit(heard(steer));
			spawned[0].emit(said("Only the auth module: three call sites."));
			spawned[0].emit(SETTLED);
			spawned[0].emit(queued(steer));

			assert.deepEqual(await outcomes(), [
				{ ok: true, as: "steer" },
				{ ok: false, reason: "too late — scout already finished" },
			]);
			assert.deepEqual(sent.map((message) => message.customType), ["subagent-delivery", "subagent-steer"], "one note, for the one that was read");
		});

		it("calls the one left unread the last one sent, as pi reads its queue oldest first", async () => {
			const { spawned, notifications, outcomes } = await twoInFlight();
			const steer = "Only the auth module, please.";

			spawned[0].emit(queued(steer));
			spawned[0].emit(queued(steer, steer));
			spawned[0].emit(queued(steer));
			spawned[0].emit(heard(steer));
			spawned[0].emit(said("Only the auth module: three call sites."));
			spawned[0].emit(SETTLED);

			assert.deepEqual(await outcomes(), [
				{ ok: true, as: "steer" },
				{ ok: false, reason: "too late — scout already finished" },
			]);
			assert.deepEqual(notifications, [], "both were judged by their own sends, so the settle reports neither");
		});
	});

	it("keeps nothing of a finished Run's queue, though a steer lands on its idle child afterwards", async (context) => {
		const { subagent, control, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		await flush();
		// What a Run's child has queued is kept in a map private to the
		// registration and read by nothing a test can reach, so what is watched is
		// whether anything is written under the finished Run's name at all.
		let kept: unknown[] = [];
		spawned[0].onSteer = (text) => {
			spawned[0].emit(said("Found three call sites."));
			spawned[0].emit(SETTLED);
			// pi takes the steer into the settled child and says it has queued it.
			const writes = context.mock.method(Map.prototype, "set");
			spawned[0].emit(queued(text));
			kept = writes.mock.calls.filter((write) => write.arguments[0] === "scout").map((write) => write.arguments[1]);
			writes.mock.restore();
		};

		assert.deepEqual(await control.send("scout", "Only the auth module, please."), { ok: false, reason: "too late — scout already finished" });
		assert.deepEqual(kept, [], "a queue nothing will ever judge or clear again");
	});

	it("carries a steer into a real child's turn, over the RPC stream", async () => {
		const turns = [[AGENT_START, AWAIT_STEER, said("Only the auth module: three call sites."), AGENT_END, SETTLED]];
		const { subagent, control, sent } = fakeSession(ROSTER, { FAKE_RPC_TURNS: JSON.stringify(turns) });
		await call(subagent, { agent: "scout", task: "count the call sites" });

		const outcome = await control.send("scout", "Only the auth module, please.");
		await messageAt(sent, 1);

		assert.deepEqual(outcome, { ok: true, as: "steer" });
		// Either order: the fake child reads the steer and finishes with no model
		// call in between, so under load its Delivery can share the acknowledgement's
		// stdout chunk — the residue `steerRun` describes, which a real pi turn is
		// too slow to hit.
		assert.deepEqual(sent.map((message) => message.customType).sort(), ["subagent-delivery", "subagent-steer"]);
		const result = sent.find((message) => message.customType === "subagent-delivery");
		assert.match(result?.content ?? "", /Only the auth module: three call sites\./);
	});
});

describe("answering a Waiting Run as the user", () => {
	async function waiting() {
		const session = stubbedSession();
		await call(session.subagent, { agent: "scout", task: "look around" });
		session.spawned[0].emit(asked("Which auth module do you mean?"));
		session.spawned[0].emit(SETTLED);
		return session;
	}

	it("answers it with a fresh prompt into its child, exactly as subagent_answer would", async () => {
		const { control, spawned, subagentWait } = await waiting();

		const outcome = await control.send("scout", "The one in src/auth.ts.");

		assert.deepEqual(outcome, { ok: true, as: "answer" });
		assert.deepEqual(spawned[0].prompts, ["The one in src/auth.ts."]);
		assert.deepEqual(spawned[0].steers, [], "a steer into an idle child would sit there unread");
		// It is running again, so a join waits for it rather than collecting the
		// Question that was just answered.
		const join = watch(call(subagentWait, {}));
		await flush();
		assert.equal(join.text, undefined);
		spawned[0].emit(said("Three call sites."));
		spawned[0].emit(SETTLED);
		await flush();
		assert.match(join.text ?? "", /Three call sites\./);
	});

	it("tells the parent before the child can deliver, so the note never trails the result", async () => {
		const { control, sent, spawned } = await waiting();
		const answering = control.send("scout", "The one in src/auth.ts.");
		// The child's turn comes back before the prompt's acknowledgement does.
		spawned[0].emit(said("Three call sites."));
		spawned[0].emit(SETTLED);
		await answering;

		assert.deepEqual(sent.map((message) => message.customType), ["subagent-question", "subagent-steer", "subagent-delivery"]);
	});

	it("tells the parent its Question is answered, without waking it", async () => {
		const { control, sent } = await waiting();

		await control.send("scout", "The one in src/auth.ts.");

		const note = sent[1];
		assert.equal(note.customType, "subagent-steer");
		assert.equal(note.triggerTurn, false);
		assert.equal(note.landed, "transcript");
		assert.match(note.content, /answered/);
		assert.match(note.content, /Which auth module do you mean\?/);
		assert.match(note.content, /The one in src\/auth\.ts\./);
		assert.deepEqual(note.details, {
			run: "scout",
			agent: "scout",
			task: "look around",
			as: "answer",
			question: "Which auth module do you mean?",
		});
	});

	it("refuses the parent's own answer to that Question afterwards, as already answered by the user", async () => {
		const { control, spawned, subagentAnswer } = await waiting();
		await control.send("scout", "The one in src/auth.ts.");

		await assert.rejects(call(subagentAnswer, { name: "scout", answer: "src/legacy/auth.ts" }), (error: Error) => {
			assert.match(error.message, /already answered by the user/);
			return true;
		});
		assert.deepEqual(spawned[0].prompts, ["The one in src/auth.ts."], "one answer, one turn");
	});

	it("still says the user answered it once the Run has finished", async () => {
		const { control, spawned, subagentAnswer } = await waiting();
		await control.send("scout", "The one in src/auth.ts.");
		spawned[0].emit(said("Three call sites."));
		spawned[0].emit(SETTLED);

		await assert.rejects(call(subagentAnswer, { name: "scout", answer: "src/legacy/auth.ts" }), (error: Error) => {
			assert.match(error.message, /already answered by the user/);
			assert.match(error.message, /done/);
			return true;
		});
	});

	it("lets the parent answer the Run's next Question, which nobody has answered yet", async () => {
		const { control, spawned, subagentAnswer } = await waiting();
		await control.send("scout", "The one in src/auth.ts.");
		spawned[0].emit(asked("Should I include the tests?"));
		spawned[0].emit(SETTLED);

		await call(subagentAnswer, { name: "scout", answer: "Yes." });

		assert.deepEqual(spawned[0].prompts, ["The one in src/auth.ts.", "Yes."]);
	});

	it("leaves the Run waiting, and answerable by the parent, when the answer cannot be sent", async () => {
		const { subagent, control, sent, spawned, subagentWait } = stubbedSession(undefined, new Error("rpc: stream closed"));
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);

		const outcome = await control.send("scout", "The one in src/auth.ts.");

		assert.deepEqual(outcome, { ok: false, reason: "could not reach scout: rpc: stream closed" });
		// Noted before it was sent, so the note is taken back rather than left standing.
		assert.deepEqual(sent.map((message) => message.customType), ["subagent-question", "subagent-steer", "subagent-steer"]);
		assert.match(sent[2].content, /never reached it/);
		assert.match(sent[2].content, /still needs an answer/);
		assert.match(await call(subagentWait, {}), /Which auth module do you mean\?/);
	});

	it("carries a Run from a Question to a Delivery over a real RPC child", async () => {
		const turns = [
			[AGENT_START, asked("Which auth module do you mean?"), AGENT_END, SETTLED],
			[AGENT_START, said("Three call sites in src/auth.ts."), AGENT_END, SETTLED],
		];
		const { subagent, control, sent } = fakeSession(ROSTER, { FAKE_RPC_TURNS: JSON.stringify(turns) });
		await call(subagent, { agent: "scout", task: "count the call sites" });
		await messageAt(sent);

		const outcome = await control.send("scout", "The one in src/auth.ts.");
		const delivered = await messageAt(sent, 2);

		assert.deepEqual(outcome, { ok: true, as: "answer" });
		assert.deepEqual(sent.map((message) => message.customType), ["subagent-question", "subagent-steer", "subagent-delivery"]);
		assert.match(delivered.content, /Three call sites in src\/auth\.ts\./);
	});
});

describe("a human message the Run cannot take", () => {
	it("is refused for a queued Run, which has no child to take it yet", async () => {
		const { subagent, control, sent } = stubbedSession();
		await fanOut(subagent, RUN_SLOTS + 1);

		const outcome = await control.send(scout(RUN_SLOTS), "Only the auth module, please.");

		assert.equal(outcome.ok, false);
		assert.match(outcome.ok ? "" : outcome.reason, /queued/);
		assert.deepEqual(sent, []);
	});

	it("is too late for a Run that has finished, whichever way it finished", async () => {
		const { subagent, control, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "one" });
		await call(subagent, { agent: "scout", task: "two" });
		spawned[0].emit(SETTLED);
		spawned[1].die({ exitCode: 3 });

		assert.deepEqual(await control.send("scout", "hello"), { ok: false, reason: "too late — scout already finished" });
		assert.deepEqual(await control.send("scout-2", "hello"), { ok: false, reason: "too late — scout-2 already finished" });
		assert.deepEqual(spawned.map((child) => child.steers), [[], []]);
	});

	it("is refused for a name this session never started, and for an empty message", async () => {
		const { subagent, control, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });

		assert.equal((await control.send("ghost", "hello")).ok, false);
		assert.equal((await control.send("scout", "   ")).ok, false);
		assert.deepEqual(spawned[0].steers, []);
	});
});

describe("killing a Run", () => {
	it("fails it as killed by the user, delivers that like any failure, and reaps its child", async () => {
		const { subagent, control, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		await flush();

		assert.equal(await control.kill("scout"), true);

		assert.equal(sent.length, 1);
		assert.equal(sent[0].customType, "subagent-delivery");
		assert.match(sent[0].content, /Run `scout` \(agent `scout`\) failed/);
		assert.match(sent[0].content, /killed by the user/);
		assert.equal(sent[0].triggerTurn, true, "woken like any other Delivery");
		assert.equal(spawned[0].stops, 1);
	});

	it("kills a Waiting Run too, whose child is otherwise kept up for its answer", async () => {
		const { subagent, control, spawned, subagentAnswer } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(asked("Which auth module do you mean?"));
		spawned[0].emit(SETTLED);

		assert.equal(await control.kill("scout"), true);

		assert.equal(spawned[0].stops, 1);
		await assert.rejects(call(subagentAnswer, { name: "scout", answer: "too late" }), /failed/);
	});

	it("takes a queued Run out of the queue for good, and starts the next one in its place", async () => {
		const { subagent, control, sent, spawned } = stubbedSession();
		await fanOut(subagent, RUN_SLOTS + 2);

		assert.equal(await control.kill(scout(RUN_SLOTS)), true);
		assert.equal(spawned.length, RUN_SLOTS, "killing a Run that held no slot frees none");
		assert.match(sent[0].content, new RegExp(`Run \`${scout(RUN_SLOTS)}\`.*killed by the user`, "s"));

		spawned[0].emit(SETTLED);
		await flush();

		assert.deepEqual(
			spawned.map((child) => child.name).slice(RUN_SLOTS),
			[scout(RUN_SLOTS + 1)],
			"the killed Run never starts; the one queued behind it takes the slot",
		);
	});

	it("frees a running Run's slot for the queue, as any other failure does", async () => {
		const { subagent, control, spawned } = stubbedSession();
		await fanOut(subagent, RUN_SLOTS + 1);

		await control.kill("scout");
		await flush();

		assert.equal(spawned.length, RUN_SLOTS + 1);
		assert.equal(spawned[RUN_SLOTS].name, scout(RUN_SLOTS));
	});

	it("hands the failure to a join that is waiting on the Run, rather than saying it twice", async () => {
		const { subagent, subagentWait, control, sent } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		const join = watch(call(subagentWait, { names: ["scout"] }));
		await flush();

		await control.kill("scout");
		await flush();

		assert.match(join.text ?? "", /killed by the user/);
		assert.deepEqual(sent, []);
	});

	it("comes back false for a Run that has already stopped, or never existed, and says nothing", async () => {
		const { subagent, control, sent, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(SETTLED);

		assert.equal(await control.kill("scout"), false);
		assert.equal(await control.kill("ghost"), false);
		assert.equal(sent.length, 1, "only the Run's own Delivery");
	});

	it("tells the subagent call still starting the Run that it was killed, not what killing it broke", async () => {
		const tools: RegisteredTool[] = [];
		const sent: SentMessage[] = [];
		let cameUp = () => {};
		const control = registerSubagents(recorder({ streaming: false }, tools, sent, new Map()) as unknown as ExtensionAPI, {
			roster: ROSTER,
			// A child whose process is up and whose first prompt has not come back:
			// stopping it is what makes the spawn fail, the way the RPC client fails
			// a prompt to a process that has exited.
			spawn: (options) =>
				new Promise<RunChild>((_resolve, reject) => {
					const child: RunChild = {
						prompt: async () => {},
						steer: async () => {},
						stop: async () => reject(new Error("Agent process exited with code null")),
					};
					cameUp = () => options.onStarted?.(child);
				}),
		});
		assert.ok(control);
		const starting = call(requireTool(tools, "subagent"), { agent: "scout", task: "look around" });
		await flush();
		cameUp();

		assert.equal(await control.kill("scout"), true);
		const returned = await starting;

		assert.match(returned, /Run `scout` \(agent `scout`\) was stopped while it was starting: killed by the user\./);
		assert.doesNotMatch(returned, /did not start|exited/, "the kill's own error is not a second fault");
		assert.deepEqual(sent.map((message) => message.customType), ["subagent-delivery"], "the kill is delivered once, as any failure is");
	});

	it("leaves no pi process behind", async () => {
		const pidPath = join(mkdtempSync(join(tmpdir(), "subagents-kill-")), "pid");
		const { subagent, control, sent } = fakeSession(ROSTER, { FAKE_RPC_PID_OUT: pidPath, FAKE_RPC_TURNS: JSON.stringify([[]]) });
		await call(subagent, { agent: "scout", task: "look around" });
		const pid = Number(readFileSync(pidPath, "utf-8"));

		assert.equal(await control.kill("scout"), true);

		assert.ok(await reaped(pid), `pid ${pid} outlived the Run the user killed`);
		assert.match(sent[0]?.content ?? "", /killed by the user/);
	});
});

describe("the /subagents command", () => {
	// The Inspector draws with pi's own message components, which draw with pi's
	// global theme — set up by pi before any extension runs, and here by hand.
	initTheme("dark");

	/** One overlay as the command opens it: drawn, and handed keys. */
	interface Overlay {
		render(width: number): string[];
		handleInput(data: string): void;
		dispose?(): void;
	}

	/**
	 * pi's terminal UI, as far as `/subagents` uses it: toasts, and overlays
	 * opened one at a time, each kept for the test to draw and press keys on the
	 * way a person would. `mode` is pi's run mode, which is what says whether
	 * there is a terminal at all.
	 */
	function terminal(mode: ExtensionCommandContext["mode"] = "tui") {
		const notifications: { message: string; type?: string }[] = [];
		const opened: { overlay: Overlay; options: unknown }[] = [];
		const tui = { terminal: { rows: 40, columns: 120 }, requestRender() {} };
		const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const ui = {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => Overlay, options: unknown) {
				return new Promise((resolve) => {
					const overlay = factory(tui, plain, undefined, (value) => {
						// pi disposes an overlay as it closes it.
						overlay.dispose?.();
						resolve(value);
					});
					opened.push({ overlay, options });
				});
			},
		};
		const ctx = { mode, hasUI: mode !== "print" && mode !== "json", cwd: process.cwd(), ui } as unknown as ExtensionCommandContext;

		return {
			ctx,
			notifications,
			opened,
			/** The `index`th overlay the command opened, once it has. */
			async overlay(index: number): Promise<Overlay> {
				for (let attempt = 0; attempt < 200 && opened.length <= index; attempt++) await flush();
				assert.ok(opened.length > index, `expected overlay ${index + 1} to open; ${opened.length} did`);
				return opened[index].overlay;
			},
		};
	}

	/** What an overlay draws, colours stripped, as one string to search. */
	function drawn(overlay: Overlay, width = 100): string {
		return overlay
			.render(width)
			.map((line) => stripTerminalSequences(line))
			.join("\n");
	}

	/** The command a test is about, named so a missing registration fails loudly. */
	function requireCommand(commands: RegisteredCommand[], name: string): RegisteredCommand {
		const command = commands.find((candidate) => candidate.name === name);
		assert.ok(command, `expected a /${name} command, got ${commands.map((registered) => registered.name).join(", ") || "none"}`);
		return command;
	}

	/** A message settling in the child: the `message_start` and `message_end` pi sends for every one. */
	function settled(message: unknown): JsonAgentSessionEvent[] {
		return [
			{ type: "message_start", message } as unknown as JsonAgentSessionEvent,
			{ type: "message_end", message } as unknown as JsonAgentSessionEvent,
		];
	}

	/** The task, as a Run's child settles it first thing: a user message. */
	function task(text: string): JsonAgentSessionEvent[] {
		return settled({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
	}

	/** A reply the child has started streaming and not finished. */
	function streaming(text: string): JsonAgentSessionEvent[] {
		const message = { role: "assistant", content: [], api: "anthropic", provider: "", model: "", usage: {}, stopReason: "stop", timestamp: 0 };
		return [
			{ type: "message_start", message } as unknown as JsonAgentSessionEvent,
			{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } } as unknown as JsonAgentSessionEvent,
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } } as unknown as JsonAgentSessionEvent,
		];
	}

	/** Leave the Inspector and close the picker behind it, and let the command finish. */
	async function closeAll(screen: ReturnType<typeof terminal>, inspectorIndex: number, running: Promise<void>): Promise<void> {
		(await screen.overlay(inspectorIndex)).handleInput("\x1b");
		(await screen.overlay(inspectorIndex + 1)).handleInput("\x1b");
		await running;
	}

	it("is registered in the parent session, and not in a Run's own", () => {
		const { commands } = stubbedSession();
		const childCommands: RegisteredCommand[] = [];
		registerSubagents(recorder({ streaming: false }, [], [], new Map(), childCommands) as unknown as ExtensionAPI, { runName: "scout" });

		assert.match(requireCommand(commands, "subagents").description ?? "", /transcript/);
		assert.deepEqual(childCommands, [], "a Run has no Runs of its own to watch");
	});

	it("refuses outside pi's terminal UI, and opens nothing", async () => {
		const { subagent, commands } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		const screen = terminal("rpc");

		await requireCommand(commands, "subagents").handler("", screen.ctx);

		assert.equal(screen.opened.length, 0);
		assert.equal(screen.notifications[0]?.type, "error");
		assert.match(screen.notifications[0]?.message ?? "", /needs pi's interactive terminal/);
	});

	it("says so when no Run has been started, and opens nothing", async () => {
		const { commands } = stubbedSession();
		const screen = terminal();

		await requireCommand(commands, "subagents").handler("", screen.ctx);

		assert.equal(screen.opened.length, 0);
		assert.deepEqual(screen.notifications, [{ message: "No subagent runs in this session.", type: "info" }]);
	});

	it("lists the session's Runs, and opens the Inspector on the one chosen, showing what its child said since it spawned", async () => {
		const { subagent, commands, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		for (const event of task("look around")) spawned[0].emit(event);
		spawned[0].emit(said("Found three call sites."));
		const screen = terminal();

		const running = requireCommand(commands, "subagents").handler("", screen.ctx);
		const picker = await screen.overlay(0);
		assert.match(drawn(picker, 80), /› \d\d:\d\d {2}scout {2}running/);
		picker.handleInput("\r");
		const inspector = drawn(await screen.overlay(1));
		await closeAll(screen, 1, running);

		assert.match(inspector, /scout · scout · running/);
		assert.match(inspector, /look around/);
		assert.match(inspector, /Found three call sites\./);
		assert.equal(screen.opened.length, 3, "picker, Inspector, and the picker again on the way out");
		assert.ok(
			screen.opened.every(({ options }) => (options as { overlay?: boolean }).overlay === true),
			"every one of them an overlay",
		);
	});

	it("steers the Run from the Inspector, and tells the parent", async () => {
		const { subagent, commands, spawned, sent } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		const screen = terminal();

		const running = requireCommand(commands, "subagents").handler("", screen.ctx);
		(await screen.overlay(0)).handleInput("\r");
		const inspector = await screen.overlay(1);
		for (const key of [..."Only src/", "\r"]) inspector.handleInput(key);
		await flush();
		const after = drawn(inspector);
		await closeAll(screen, 1, running);

		assert.deepEqual(spawned[0].steers, ["Only src/"]);
		assert.equal(sent.at(-1)?.customType, "subagent-steer");
		assert.match(after, /Sent to scout/);
	});

	it("kills the Run from the Inspector after a y, delivering the failure like any other", async () => {
		const { subagent, commands, sent } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		const screen = terminal();

		const running = requireCommand(commands, "subagents").handler("", screen.ctx);
		(await screen.overlay(0)).handleInput("\r");
		const inspector = await screen.overlay(1);
		inspector.handleInput("\x18");
		inspector.handleInput("y");
		for (let attempt = 0; attempt < 200 && sent.length === 0; attempt++) await flush();
		await flush();
		const after = drawn(inspector);
		await closeAll(screen, 1, running);

		assert.equal(sent[0]?.customType, "subagent-delivery");
		assert.match(sent[0]?.content ?? "", /killed by the user/);
		assert.match(after, /scout · scout · failed/);
		assert.match(after, /A finished run is read-only/);
	});

	it("heads the Inspector with the Run's Pressure level, and with compacting while its child compacts", async () => {
		const { subagent, commands, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		spawned[0].emit(status("ctx warning · 152k"));
		const screen = terminal();

		const running = requireCommand(commands, "subagents").handler("", screen.ctx);
		(await screen.overlay(0)).handleInput("\r");
		const inspector = await screen.overlay(1);
		const warned = drawn(inspector);
		spawned[0].emit(status("ctx compacting"));
		const compacting = drawn(inspector);
		await closeAll(screen, 1, running);

		assert.match(warned, /scout · scout · running · \d\d:\d\d · warning 152k/);
		assert.match(compacting, /scout · scout · running · \d\d:\d\d · compacting/);
	});

	it("shows no level for a Run that is done or failed, whatever its child last said", async () => {
		const { subagent, commands, spawned, control } = stubbedSession();
		await call(subagent, { agent: "scout", task: "one" });
		await call(subagent, { agent: "worker", task: "two" });
		spawned[0].emit(status("ctx notice · 131k"));
		spawned[1].emit(status("ctx warning · 152k"));
		spawned[0].emit(said("Found it."));
		spawned[0].emit(SETTLED);
		await control.kill("worker");
		// A stopped Run's child going on talking changes nothing about it.
		spawned[0].emit(status("ctx notice · 140k"));
		const screen = terminal();

		const running = requireCommand(commands, "subagents").handler("", screen.ctx);
		const picker = await screen.overlay(0);
		const listed = drawn(picker, 80);
		picker.handleInput("\r");
		const inspector = drawn(await screen.overlay(1));
		await closeAll(screen, 1, running);

		assert.match(listed, /worker\s+failed · killed by the user/);
		assert.match(listed, /scout\s+done/);
		assert.doesNotMatch(listed, /notice|warning|1\d\dk/);
		assert.doesNotMatch(inspector.split("\n")[0] ?? "", /notice|warning|1\d\dk/);
	});

	it("draws pi's compaction card wherever a real child compacted, collapsed, with what came before kept", async () => {
		const events = [
			AGENT_START,
			...task("look around"),
			said("Read the whole tree."),
			nudged("warning"),
			pruned("e3", "[pruned: 400 lines of output]"),
			compacted("## Plan\nFix the token refresh.", 172_000),
			said("Carrying on with the refresh."),
			compactionEnded("## Plan\nShip the fix.", 98_000),
			said("Found three call sites."),
			AGENT_END,
			SETTLED,
		];
		const session = fakeSession(ROSTER, { FAKE_RPC_TURNS: JSON.stringify([events]) });
		await call(session.subagent, { agent: "scout", task: "look around" });
		await messageAt(session.sent);
		const screen = terminal();

		const running = requireCommand(session.commands, "subagents").handler("", screen.ctx);
		(await screen.overlay(0)).handleInput("\r");
		const inspector = drawn(await screen.overlay(1));
		await closeAll(screen, 1, running);
		await session.shutdown();

		assert.match(
			inspector,
			/look around[\s\S]*Read the whole tree\.[\s\S]*\[compaction\][\s\S]*Compacted from 172,000 tokens[\s\S]*Carrying on with the refresh\.[\s\S]*\[compaction\][\s\S]*Compacted from 98,000 tokens[\s\S]*Found three call sites\./,
		);
		assert.doesNotMatch(inspector, /Fix the token refresh|Ship the fix/, "each Handoff is behind expand");
		assert.doesNotMatch(inspector, /pruned|Self-compact/, "neither Pruning nor the extension's steer is drawn");
	});

	it("keeps a stopped Run's transcript as it stopped: a reply cut off shows as cut off, and later words are not recorded", async () => {
		const { subagent, commands, control, spawned } = stubbedSession();
		await call(subagent, { agent: "scout", task: "look around" });
		for (const event of task("look around")) spawned[0].emit(event);
		for (const event of streaming("I was about to say")) spawned[0].emit(event);
		await control.kill("scout");
		// A dying child's last words, arriving after its Run was already failed.
		spawned[0].emit(said("Too late to matter."));
		const screen = terminal();

		const running = requireCommand(commands, "subagents").handler("", screen.ctx);
		const picker = await screen.overlay(0);
		assert.match(drawn(picker, 80), /scout\s+failed · killed by the user/);
		picker.handleInput("\r");
		const inspector = drawn(await screen.overlay(1));
		await closeAll(screen, 1, running);

		assert.match(inspector, /I was about to say/);
		assert.match(inspector, /Operation aborted/);
		assert.doesNotMatch(inspector, /Too late to matter/);
	});
});
