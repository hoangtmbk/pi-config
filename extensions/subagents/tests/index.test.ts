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
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Agent, Roster } from "../agents.ts";
import type { RunChild } from "../child.ts";
import { spawnRun } from "../child.ts";
import { registerSubagents } from "../index.ts";

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

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	parameters: { properties: Record<string, unknown>; required?: string[] };
	execute: (
		toolCallId: string,
		params: SubagentParams,
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

	const subagent = tools.find((tool) => tool.name === "subagent");
	assert.ok(subagent, `expected a subagent tool, got ${tools.map((t) => t.name).join(", ") || "none"}`);
	return { subagent, tools, sent };
}

const CTX = {} as ExtensionContext;

async function run(tool: RegisteredTool, params: SubagentParams): Promise<string> {
	const result = await tool.execute("call-1", params, undefined, undefined, CTX);
	return result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
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
	it("registers one tool taking an agent, a task and optional name and model", () => {
		const { subagent, tools } = fakeSession();

		assert.deepEqual(
			tools.map((tool) => tool.name),
			["subagent"],
		);
		assert.deepEqual(Object.keys(subagent.parameters.properties).sort(), ["agent", "model", "name", "task"]);
		assert.deepEqual(subagent.parameters.required?.slice().sort(), ["agent", "task"]);
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
