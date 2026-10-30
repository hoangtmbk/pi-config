/**
 * Transcripts: a Run's child conversation, rebuilt from the events it sends.
 *
 * Every test here feeds an event sequence in by hand, shaped the way pi sends
 * it over RPC — in particular, `message_update`s that carry only a delta and no
 * cumulative message. Nothing spawns anything, and nothing renders.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type AgentMessage, type AssistantMessage, Transcripts } from "../transcript.ts";
import { AGENT_END, AGENT_START, ran, said, SETTLED, started } from "./child-events.ts";

/** A transcript for one Run, `scout`, with `events` already fed to it. */
function transcriptOf(events: JsonAgentSessionEvent[]): Transcripts {
	const transcripts = new Transcripts();
	transcripts.start("scout");
	for (const event of events) transcripts.observe("scout", event);
	return transcripts;
}

/** A message settling in the child: the `message_start` and `message_end` pi sends for every one. */
function settled(message: unknown): JsonAgentSessionEvent[] {
	return [
		{ type: "message_start", message } as unknown as JsonAgentSessionEvent,
		{ type: "message_end", message } as unknown as JsonAgentSessionEvent,
	];
}

/** A user message — the task, a later prompt, or a steer the child took. */
function user(text: string): unknown {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

/** An assistant message with the given content, as `message_start` and `message_end` carry it. */
function assistant(content: unknown[], stopReason = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic",
		provider: "",
		model: "",
		usage: {},
		stopReason,
		timestamp: 0,
	} as unknown as AssistantMessage;
}

function messageStart(message: AssistantMessage): JsonAgentSessionEvent {
	return { type: "message_start", message } as unknown as JsonAgentSessionEvent;
}

function messageEnd(message: AssistantMessage): JsonAgentSessionEvent {
	return { type: "message_end", message } as unknown as JsonAgentSessionEvent;
}

/** One delta, as it arrives over RPC: no `message`, no `partial`. */
function update(assistantMessageEvent: Record<string, unknown>): JsonAgentSessionEvent {
	return { type: "message_update", usage: {}, assistantMessageEvent } as unknown as JsonAgentSessionEvent;
}

function toolUpdate(toolCallId: string, text: string): JsonAgentSessionEvent {
	return {
		type: "tool_execution_update",
		toolCallId,
		toolName: "bash",
		args: { command: "ls" },
		partialResult: { content: [{ type: "text", text }], details: {} },
	} as unknown as JsonAgentSessionEvent;
}

function toolEnd(toolCallId: string, text: string, isError = false): JsonAgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "bash",
		result: { content: [{ type: "text", text }], details: { exitCode: 0 } },
		isError,
	} as unknown as JsonAgentSessionEvent;
}

function toolResult(toolCallId: string, text: string): unknown {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		details: { exitCode: 0 },
		isError: false,
		timestamp: 0,
	};
}

/** The role of each of a snapshot's settled messages, in order. */
function roles(messages: AgentMessage[]): string[] {
	return messages.map((message) => message.role);
}

describe("Transcripts", () => {
	it("knows nothing of a Run it was never told to start", () => {
		const transcripts = new Transcripts();
		transcripts.observe("scout", said("hello"));

		assert.equal(transcripts.get("scout"), undefined);
	});

	it("starts a Run empty", () => {
		const snapshot = transcriptOf([]).get("scout");

		assert.deepEqual(snapshot?.messages, []);
		assert.equal(snapshot?.streaming, undefined);
		assert.equal(snapshot?.tools.size, 0);
	});

	it("records the task and every later user message from the stream, where the child took them", () => {
		const snapshot = transcriptOf([
			AGENT_START,
			...settled(user("look around")),
			said("Looking."),
			...settled(user("only the auth module, please")),
			said("Narrowed it."),
			AGENT_END,
			SETTLED,
		]).get("scout");

		assert.deepEqual(roles(snapshot?.messages ?? []), ["user", "assistant", "user", "assistant"]);
		assert.deepEqual(snapshot?.messages[2], user("only the auth module, please"));
	});

	it("builds the streaming assistant message from deltas alone", () => {
		const transcripts = transcriptOf([
			messageStart(assistant([])),
			update({ type: "thinking_start", contentIndex: 0 }),
			update({ type: "thinking_delta", contentIndex: 0, delta: "Where is " }),
			update({ type: "thinking_delta", contentIndex: 0, delta: "auth?" }),
			update({ type: "text_start", contentIndex: 1 }),
			update({ type: "text_delta", contentIndex: 1, delta: "Reading " }),
			update({ type: "text_delta", contentIndex: 1, delta: "it now." }),
		]);

		assert.deepEqual(transcripts.get("scout")?.streaming?.content, [
			{ type: "thinking", thinking: "Where is auth?" },
			{ type: "text", text: "Reading it now." },
		]);
	});

	it("takes a block's end over what its deltas built", () => {
		const transcripts = transcriptOf([
			messageStart(assistant([])),
			update({ type: "text_start", contentIndex: 0 }),
			update({ type: "text_delta", contentIndex: 0, delta: "Rea" }),
			update({ type: "text_end", contentIndex: 0, content: "Reading it now." }),
		]);

		assert.deepEqual(transcripts.get("scout")?.streaming?.content, [{ type: "text", text: "Reading it now." }]);
	});

	it("shows a streaming tool call by name first, and with its arguments once the call is complete", () => {
		const transcripts = transcriptOf([
			messageStart(assistant([])),
			update({ type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" }),
			update({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"au' }),
		]);
		assert.deepEqual(transcripts.get("scout")?.streaming?.content, [
			{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
		]);

		const toolCall = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "auth.ts" } };
		transcripts.observe("scout", update({ type: "toolcall_end", contentIndex: 0, toolCall }));
		assert.deepEqual(transcripts.get("scout")?.streaming?.content, [toolCall]);
	});

	it("replaces the streaming message with message_end's, which is the one that counts", () => {
		const final = assistant([{ type: "text", text: "Found three call sites." }]);
		const snapshot = transcriptOf([
			messageStart(assistant([])),
			update({ type: "text_start", contentIndex: 0 }),
			update({ type: "text_delta", contentIndex: 0, delta: "Found thr" }),
			messageEnd(final),
		]).get("scout");

		assert.equal(snapshot?.streaming, undefined);
		assert.deepEqual(snapshot?.messages, [final]);
	});

	it("does not change the message_start it was handed while streaming into it", () => {
		const first = assistant([]);
		transcriptOf([messageStart(first), update({ type: "text_start", contentIndex: 0 })]);

		assert.deepEqual(first.content, []);
	});

	it("follows a tool from start to end, its partial output replaced rather than appended", () => {
		const transcripts = transcriptOf([started("bash", { command: "ls" })]);
		const tool = () => transcripts.get("scout")?.tools.get("call-bash");

		assert.deepEqual(tool(), { toolCallId: "call-bash", toolName: "bash", args: { command: "ls" }, isError: false, running: true });

		transcripts.observe("scout", toolUpdate("call-bash", "a"));
		transcripts.observe("scout", toolUpdate("call-bash", "a\nb"));
		assert.deepEqual(tool()?.result?.content, [{ type: "text", text: "a\nb" }]);
		assert.equal(tool()?.running, true);

		transcripts.observe("scout", toolEnd("call-bash", "a\nb\nc"));
		assert.deepEqual(tool()?.result, { content: [{ type: "text", text: "a\nb\nc" }], details: { exitCode: 0 } });
		assert.equal(tool()?.running, false);
		assert.equal(tool()?.isError, false);
	});

	it("records a tool that ended in an error", () => {
		const tool = transcriptOf([started("bash"), toolEnd("call-bash", "command not found", true)])
			.get("scout")
			?.tools.get("call-bash");

		assert.equal(tool?.isError, true);
		assert.equal(tool?.running, false);
	});

	it("keeps a tool whose start it never saw", () => {
		const tool = transcriptOf([ran("grep")]).get("scout")?.tools.get("call-grep");

		assert.equal(tool?.toolName, "grep");
		assert.equal(tool?.running, false);
	});

	it("keeps the tool result message, and holds the output once between it and the execution", () => {
		const message = toolResult("call-bash", "a\nb\nc");
		const snapshot = transcriptOf([started("bash"), toolEnd("call-bash", "a\nb\nc"), ...settled(message)]).get("scout");

		assert.deepEqual(roles(snapshot?.messages ?? []), ["toolResult"]);
		const settledResult = snapshot?.messages[0] as { content: unknown; details: unknown };
		assert.equal(snapshot?.tools.get("call-bash")?.result?.content, settledResult.content);
		assert.equal(snapshot?.tools.get("call-bash")?.result?.details, settledResult.details);
	});

	it("bumps the version and tells listeners on every change, and on nothing else", () => {
		const transcripts = transcriptOf([]);
		const heard: string[] = [];
		transcripts.onChange((name) => heard.push(name));
		const before = transcripts.get("scout")?.version ?? 0;

		transcripts.observe("scout", AGENT_START);
		transcripts.observe("scout", { type: "turn_start" } as JsonAgentSessionEvent);
		transcripts.observe("scout", update({ type: "text_delta", contentIndex: 0, delta: "nothing is streaming" }));
		assert.equal(transcripts.get("scout")?.version, before);
		assert.deepEqual(heard, []);

		transcripts.observe("scout", said("Done."));
		assert.equal(transcripts.get("scout")?.version, before + 1);
		assert.deepEqual(heard, ["scout"]);
	});

	it("stops telling a listener once it unsubscribes", () => {
		const transcripts = transcriptOf([]);
		const heard: string[] = [];
		const unsubscribe = transcripts.onChange((name) => heard.push(name));

		unsubscribe();
		transcripts.observe("scout", said("Done."));

		assert.deepEqual(heard, []);
	});

	it("keeps each Run's transcript to itself", () => {
		const transcripts = new Transcripts();
		transcripts.start("scout");
		transcripts.start("worker");

		transcripts.observe("worker", said("Built it."));

		assert.equal(transcripts.get("scout")?.messages.length, 0);
		assert.equal(transcripts.get("worker")?.messages.length, 1);
	});

	it("keeps a finished Run's transcript", () => {
		const transcripts = transcriptOf([...settled(user("look around")), said("Done."), AGENT_END, SETTLED]);

		assert.deepEqual(roles(transcripts.get("scout")?.messages ?? []), ["user", "assistant"]);
	});
});

describe("Transcripts.end", () => {
	it("keeps a half-streamed message as an aborted one, the way pi keeps a reply cut off", () => {
		const transcripts = transcriptOf([
			messageStart(assistant([])),
			update({ type: "text_start", contentIndex: 0 }),
			update({ type: "text_delta", contentIndex: 0, delta: "Half a" }),
		]);

		transcripts.end("scout");

		const snapshot = transcripts.get("scout");
		assert.equal(snapshot?.streaming, undefined);
		assert.equal(snapshot?.messages.length, 1);
		const kept = snapshot?.messages[0] as AssistantMessage;
		assert.equal(kept.stopReason, "aborted");
		assert.deepEqual(kept.content, [{ type: "text", text: "Half a" }]);
	});

	it("ends a tool that was still running in an error, keeping the output it had got to", () => {
		const transcripts = transcriptOf([started("bash"), toolUpdate("call-bash", "partial")]);

		transcripts.end("scout");

		const tool = transcripts.get("scout")?.tools.get("call-bash");
		assert.equal(tool?.running, false);
		assert.equal(tool?.isError, true);
		assert.deepEqual(tool?.result?.content, [{ type: "text", text: "partial" }]);
	});

	it("changes nothing for a Run that finished cleanly", () => {
		const transcripts = transcriptOf([started("bash"), toolEnd("call-bash", "ok"), said("Done."), AGENT_END, SETTLED]);
		const heard: string[] = [];
		transcripts.onChange((name) => heard.push(name));
		const before = transcripts.get("scout")?.version;

		transcripts.end("scout");

		assert.equal(transcripts.get("scout")?.version, before);
		assert.deepEqual(heard, []);
	});
});
