/**
 * The forked call: the Handoff writer that is the agent itself, reading its
 * own context (ADR-0004).
 *
 * A side request on the session's own model and thinking level that sends
 * the live conversation exactly as the agent's next turn would — the same
 * messages, the system prompt and tools carried by their system messages, the
 * same session id and request options — plus one trailing user message with
 * the instruction. So it reads the warm prompt cache, and it knows the plan
 * as well as the agent does, reasoning included. It is never persisted.
 *
 * Nothing is checked before it is sent: an extension that rewrites requests
 * makes it miss the cache without warning. A miss costs money, not quality, so
 * it is only noticed afterwards, from the usage, and logged.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, Model, ThinkingBudgets, ToolCall, ToolResultMessage, TranscriptContext, Transport, Usage } from "@earendil-works/pi-ai";
import { forkInstruction, parseReply } from "./instruction.ts";
import { type Clock, guardStall, type StreamFn, type Writer } from "./writers.ts";

export interface ForkDeps {
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	sessionId: string;
	stream: StreamFn;
	clock: Clock;
	/** pi's `transport` and `thinkingBudgets` settings, which the agent's own requests carry. */
	transport: Transport | undefined;
	thinkingBudgets: ThinkingBudgets | undefined;
	/** The live conversation, as the next request would send it. */
	transcript: readonly Message[];
	/** About how much of the newest conversation the compaction keeps. */
	keptTokens: number;
	/** The tool Self-compaction is, whose own call is pending while it writes. */
	selfCompactTool: string;
}

/** What a call still pending is answered with, so that the request is whole: every call has its result. */
const PLACEHOLDER = {
	self: "Writing the Handoff; see the next message.",
	other: "(This result isn't available to the Handoff writer. It stays in the kept tail.)",
};

/**
 * One result for each call in the last assistant message that has none yet,
 * in the order called. On Self-compaction that is the `self_compact` call
 * writing this, and any call beside it that hasn't run: their real results
 * come after the cut, in the kept tail.
 */
function placeholders(transcript: readonly Message[], selfCompactTool: string): ToolResultMessage[] {
	let at = transcript.length - 1;
	while (at >= 0 && transcript[at]!.role !== "assistant") at--;
	const last = transcript[at];
	if (last?.role !== "assistant") return [];
	const answered = new Set(transcript.slice(at + 1).flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])));
	return last.content
		.filter((part) => part.type === "toolCall" && !answered.has(part.id))
		.map((call) => {
			const { id, name } = call as ToolCall;
			const text = name === selfCompactTool ? PLACEHOLDER.self : PLACEHOLDER.other;
			return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
		});
}

/** A miss at or under this many tokens is the cache's breakpoint granularity, not a miss: pi's own floor. */
const CACHE_NOISE_TOKENS = 1_024;

const thousands = new Intl.NumberFormat("en-US");

/** What a request sent, as its usage says: paid in full, read from the cache, or written to it. */
function promptTokens(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/**
 * The cache miss to log, if the fork had one: how much of the last real
 * request's prompt — which the fork's starts with — it did not read from the
 * cache. Mirrors pi's own miss detector: past 1,024 tokens of noise, and on a
 * provider that never reported caching a read of nothing means nothing.
 */
function cacheMiss(transcript: readonly Message[], fork: Usage): string | undefined {
	const replies = transcript.flatMap((message) => (message.role === "assistant" && promptTokens(message.usage) > 0 ? [message.usage] : []));
	const last = replies.at(-1);
	if (!last || promptTokens(fork) <= 0) return undefined;
	const reportedCache = [...replies, fork].some((usage) => usage.cacheRead + usage.cacheWrite > 0);
	if (!reportedCache) return undefined;
	const missed = Math.min(promptTokens(last), promptTokens(fork)) - fork.cacheRead;
	if (missed <= CACHE_NOISE_TOKENS) return undefined;
	return `fork: missed the cache by ${thousands.format(missed)} tokens (read ${thousands.format(fork.cacheRead)} of the last request's ${thousands.format(promptTokens(last))})`;
}

/**
 * Codex, where the fork is kept from calling tools with `tool_choice: "none"`.
 * On Anthropic changing `tool_choice` voids the cached conversation, so there
 * "don't call tools" is only the instruction's; every other API is left as the
 * agent sends it.
 */
const CODEX_API = "openai-codex-responses";

/**
 * The forked-call writer. It fails — so serialized mode runs — on a provider
 * error, a reply cut off at the token cap or by a stall, and any reply
 * `parseReply` can't use, exactly as serialized mode does. A tool call beside
 * a usable reply is ignored, never run.
 *
 * The options are the agent's own: no `maxTokens` and no `cacheRetention`,
 * which would change the request, and the thinking level as the agent sends
 * it, left out at "off".
 */
export function forkWriter(deps: ForkDeps): Writer {
	return {
		name: "fork",
		async write(job) {
			const model = deps.model;
			if (!model) throw new Error("no model to write with");
			const instruction = forkInstruction({
				hasPrevious: job.previousHandoff !== undefined,
				focus: job.focus,
				note: job.note,
				keptTokens: deps.keptTokens,
			});
			const messages: Message[] = [
				...deps.transcript,
				...placeholders(deps.transcript, deps.selfCompactTool),
				{ role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() },
			];
			const reply = await guardStall(deps.stream, deps.clock, async (stream) => {
				const events = await stream(model, { messages } as unknown as TranscriptContext, {
					signal: job.signal,
					sessionId: deps.sessionId,
					...(deps.thinkingLevel && deps.thinkingLevel !== "off" ? { reasoning: deps.thinkingLevel } : {}),
					...(deps.transport === undefined ? {} : { transport: deps.transport }),
					...(deps.thinkingBudgets === undefined ? {} : { thinkingBudgets: deps.thinkingBudgets }),
					...(model.api === CODEX_API ? { toolChoice: "none" as const } : {}),
				});
				return events.result();
			});
			const parsed = parseReply(reply);
			if (!parsed.ok) throw new Error(parsed.reason);
			const miss = cacheMiss(deps.transcript, reply.usage);
			return { judgment: parsed.sections, usage: reply.usage, ledger: parsed.ledger, ...(miss ? { log: [miss] } : {}) };
		},
	};
}
