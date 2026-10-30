/**
 * The replay check's continuation: does the agent carry on from a Handoff the
 * way the recorded agent really did?
 *
 * Open-loop. The agent is handed the context as it stands after the
 * compaction — the Handoff and the kept tail, plus whatever the recording has
 * before its next action, such as the user's next message — and proposes one
 * action. Nothing is ever executed. While its action matches the recorded one,
 * the recorded result is fed back as that action's own, and it proposes the
 * next; at most three actions are proposed. The first that differs is the one
 * the judge looks at: a re-ask, redone work or a broken rule shows there.
 *
 * Plain functions but for the model call they are handed.
 */

import { resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model, ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import { convertToLlm, type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "./writers.ts";

/** How many actions a continuation proposes at most. */
export const MAX_ACTIONS = 3;

/** One thing the recorded agent did, and what came back before it acted again. */
export interface RecordedStep {
	action: AssistantMessage;
	/** Its tool results, then anything else recorded before the next action: a user's message, an extension's. */
	results: AgentMessage[];
}

/** What really happened after a cut. */
export interface RecordedFuture {
	/** What the recording has before the agent's next action: at a cut before a user message, that message. */
	lead: AgentMessage[];
	steps: RecordedStep[];
}

/** The recording after the entry at `end`, as the model saw it, in actions. */
export function futureAfter(branch: readonly SessionEntry[], end: number): RecordedFuture {
	const lead: AgentMessage[] = [];
	const steps: RecordedStep[] = [];
	for (const entry of branch.slice(end + 1)) {
		for (const message of sessionEntryToContextMessages(entry)) {
			if (message.role === "assistant") steps.push({ action: message, results: [] });
			else if (message.role !== "system") (steps.at(-1)?.results ?? lead).push(message);
		}
	}
	return { lead, steps };
}

/** Whitespace in a string argument doesn't make it a different action. */
function normalized(value: unknown): unknown {
	if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
	if (Array.isArray(value)) return value.map(normalized);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, normalized((value as Record<string, unknown>)[key])]),
		);
	}
	return value;
}

/** What a tool call does, as a key: its tool and its arguments, with a path read from the session's folder. */
function callKey(call: ToolCall, cwd: string): string {
	const args: Record<string, unknown> = { ...call.arguments };
	if (typeof args.path === "string") args.path = resolve(cwd, args.path);
	return `${call.name} ${JSON.stringify(normalized(args))}`;
}

function callsOf(message: AssistantMessage): ToolCall[] {
	return message.content.filter((part): part is ToolCall => part.type === "toolCall");
}

/**
 * The proposed calls paired with the recorded ones they match, or `undefined`
 * if the two actions differ. Same calls, in any order: the same tools on the
 * same arguments. An action in words alone never matches, since there is no
 * recorded result to feed back for it.
 */
function pairCalls(proposed: AssistantMessage, recorded: AssistantMessage, cwd: string): Map<string, ToolCall> | undefined {
	const mine = callsOf(proposed);
	const theirs = callsOf(recorded);
	if (mine.length === 0 || mine.length !== theirs.length) return undefined;
	const left = [...theirs];
	const pairs = new Map<string, ToolCall>();
	for (const call of mine) {
		const at = left.findIndex((other) => callKey(other, cwd) === callKey(call, cwd));
		if (at < 0) return undefined;
		pairs.set(left[at]!.id, call);
		left.splice(at, 1);
	}
	return pairs;
}

/** A recorded step's results, answering the proposed calls that matched it under their own ids. */
function fedBack(results: readonly AgentMessage[], pairs: Map<string, ToolCall>): AgentMessage[] {
	return results.map((message) => {
		if (message.role !== "toolResult") return message;
		const call = pairs.get(message.toolCallId);
		return call ? { ...message, toolCallId: call.id, toolName: call.name } : message;
	});
}

/** One action proposed from the context so far. */
export type Propose = (context: readonly AgentMessage[]) => Promise<AssistantMessage>;

export interface ProposerOptions {
	/** The recorded session's id and thinking level, which its own requests carried. */
	sessionId: string;
	thinkingLevel: ThinkingLevel | undefined;
}

/**
 * Proposing on the session's recorded model, as its own next request would: the
 * context converted as pi converts it, its tools carried by its system
 * messages, at the session's thinking level. A provider error fails the
 * continuation rather than standing as an action.
 */
export function proposer(stream: StreamFn, model: Model<any>, options: ProposerOptions): Propose {
	return async (context) => {
		const events = await stream(model, { messages: convertToLlm([...context]) as Message[] } as unknown as TranscriptContext, {
			sessionId: options.sessionId,
			...(options.thinkingLevel && options.thinkingLevel !== "off" ? { reasoning: options.thinkingLevel } : {}),
		});
		const reply = await events.result();
		if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(`the continuation's call failed: ${reply.errorMessage ?? reply.stopReason}`);
		return reply;
	};
}

export interface Continuation {
	/** The actions that matched the recording, in order; each was fed back its recorded result. */
	matched: AssistantMessage[];
	/** The first action that differed, beside the recorded one; none when every action proposed matched. */
	differed?: { proposed: AssistantMessage; recorded: AssistantMessage | undefined };
}

/** Carry on from `context` against the recorded `future`, matching and feeding back (see the module's comment). */
export async function continueFrom(context: readonly AgentMessage[], future: RecordedFuture, propose: Propose, cwd: string): Promise<Continuation> {
	const sent: AgentMessage[] = [...context, ...future.lead];
	const matched: AssistantMessage[] = [];
	for (let k = 0; k < MAX_ACTIONS; k++) {
		const proposed = await propose(sent);
		const recorded = future.steps[k];
		const pairs = recorded ? pairCalls(proposed, recorded.action, cwd) : undefined;
		if (!recorded || !pairs) return { matched, differed: { proposed, recorded: recorded?.action } };
		matched.push(proposed);
		sent.push(proposed, ...fedBack(recorded.results, pairs));
	}
	return { matched };
}
