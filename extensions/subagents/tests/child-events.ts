/**
 * The events a Run's child emits, written by hand.
 *
 * The Supervisor is pure, so its whole contract is an event sequence — and the
 * one event the lifecycle turns on, a completed `ask_question`, has a shape that
 * both the child half of the extension and the Supervisor have to agree about.
 * Building it in one place is what keeps the two sides of that agreement from
 * drifting apart in the tests alone.
 *
 * Not a `.test.ts` file, so `npm test` never runs it directly.
 */

import type { JsonAgentSessionEvent, RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { STATUS_KEY } from "../../compaction/status.ts";
import { ASK_QUESTION_TOOL, type QuestionDetails } from "../supervisor.ts";

/** An assistant `message_end`, the event a result is read from. */
export function said(text: string): JsonAgentSessionEvent {
	return {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }], api: "anthropic", provider: "", model: "", usage: {} },
	} as unknown as JsonAgentSessionEvent;
}

/**
 * A message from the user the child has read — a steer, taken at a turn
 * boundary and put into the conversation as a user `message_end`.
 */
export function heard(text: string): JsonAgentSessionEvent {
	return {
		type: "message_end",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
	} as unknown as JsonAgentSessionEvent;
}

/** A completed `ask_question` execution — the event a Question is read from. */
export function asked(question: string): JsonAgentSessionEvent {
	const details: QuestionDetails = { question };
	return toolExecutionEnd(ASK_QUESTION_TOOL, { content: [{ type: "text", text: "Sent." }], details }, false);
}

/** A tool the child has just started — the event a Run's current activity is read from. */
export function started(toolName: string, args: unknown = {}): JsonAgentSessionEvent {
	return { type: "tool_execution_start", toolCallId: `call-${toolName}`, toolName, args } as unknown as JsonAgentSessionEvent;
}

/** Any other tool running in the child, which must leave no Run Waiting. */
export function ran(toolName: string): JsonAgentSessionEvent {
	return toolExecutionEnd(toolName, { content: [{ type: "text", text: "ok" }] }, false);
}

/** A tool that ended in an error, which is not an execution the parent heard about. */
export function failed(toolName: string, message: string): JsonAgentSessionEvent {
	return toolExecutionEnd(toolName, { content: [{ type: "text", text: message }] }, true);
}

/**
 * The child saying what it has queued and not yet read — pi's `queue_update`,
 * written on every change to its steering queue. Empty is a queue just read.
 */
export function queued(...steering: string[]): JsonAgentSessionEvent {
	return { type: "queue_update", steering, followUp: [] } as JsonAgentSessionEvent;
}

/**
 * The child's compaction extension setting its footer status, as pi in RPC mode
 * forwards it: an `extension_ui_request`, which is not one of the events
 * `JsonAgentSessionEvent` lists but arrives on the same stream all the same.
 * `undefined` is a cleared status: Context pressure back under notice.
 *
 * `key` is for a status some other extension of the child's set.
 */
export function status(text: string | undefined, key: string = STATUS_KEY): JsonAgentSessionEvent {
	const request: RpcExtensionUIRequest = { type: "extension_ui_request", id: `status-${text}`, method: "setStatus", statusKey: key, statusText: text };
	return request as unknown as JsonAgentSessionEvent;
}

/** The child's extension raising a toast, which pi in RPC mode forwards the same way. */
export function toast(message: string, type: "info" | "warning" | "error" = "warning"): JsonAgentSessionEvent {
	const request: RpcExtensionUIRequest = { type: "extension_ui_request", id: `notify-${message}`, method: "notify", message, notifyType: type };
	return request as unknown as JsonAgentSessionEvent;
}

function toolExecutionEnd(toolName: string, result: unknown, isError: boolean): JsonAgentSessionEvent {
	return { type: "tool_execution_end", toolCallId: `call-${toolName}`, toolName, result, isError } as unknown as JsonAgentSessionEvent;
}

export const AGENT_START = { type: "agent_start" } as unknown as JsonAgentSessionEvent;
export const AGENT_END = { type: "agent_end", messages: [], willRetry: false } as unknown as JsonAgentSessionEvent;
export const RETRYING = { type: "agent_end", messages: [], willRetry: true } as unknown as JsonAgentSessionEvent;
export const SETTLED = { type: "agent_settled" } as JsonAgentSessionEvent;
