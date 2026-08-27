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

import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ASK_QUESTION_TOOL, type QuestionDetails } from "../supervisor.ts";

/** An assistant `message_end`, the event a result is read from. */
export function said(text: string): JsonAgentSessionEvent {
	return {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }], api: "anthropic", provider: "", model: "", usage: {} },
	} as unknown as JsonAgentSessionEvent;
}

/** A completed `ask_question` execution — the event a Question is read from. */
export function asked(question: string): JsonAgentSessionEvent {
	const details: QuestionDetails = { question };
	return toolExecutionEnd(ASK_QUESTION_TOOL, { content: [{ type: "text", text: "Sent." }], details }, false);
}

/** Any other tool running in the child, which must leave no Run Waiting. */
export function ran(toolName: string): JsonAgentSessionEvent {
	return toolExecutionEnd(toolName, { content: [{ type: "text", text: "ok" }] }, false);
}

/** A tool that ended in an error, which is not an execution the parent heard about. */
export function failed(toolName: string, message: string): JsonAgentSessionEvent {
	return toolExecutionEnd(toolName, { content: [{ type: "text", text: message }] }, true);
}

function toolExecutionEnd(toolName: string, result: unknown, isError: boolean): JsonAgentSessionEvent {
	return { type: "tool_execution_end", toolCallId: `call-${toolName}`, toolName, result, isError } as unknown as JsonAgentSessionEvent;
}

export const AGENT_START = { type: "agent_start" } as unknown as JsonAgentSessionEvent;
export const AGENT_END = { type: "agent_end", messages: [], willRetry: false } as unknown as JsonAgentSessionEvent;
export const RETRYING = { type: "agent_end", messages: [], willRetry: true } as unknown as JsonAgentSessionEvent;
export const SETTLED = { type: "agent_settled" } as JsonAgentSessionEvent;
