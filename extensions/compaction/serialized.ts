/**
 * Serialized mode: the Handoff writer that reads the conversation as a
 * transcript rather than as its own context.
 *
 * It is the writer for when the live context can't be sent, and the one after
 * the forked call when that fails. It asks for the same judgment part with the
 * same instruction, over a one-message transcript: the previous Handoff, the
 * removed span and the kept tail, each in its own tag, with a system prompt
 * that says all of it is data. Only what the agent and the user said and what
 * tools returned goes in. Thinking is left out, and so are custom messages —
 * our steers and the subagents extension's notes among them.
 *
 * Tool results are what make a transcript large, so each is cut to its head
 * and tail. When the request still doesn't fit the model's window, the cut
 * halves, down to a floor; past that, the attempt fails.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import { instructionBody, parseReply, SERIALIZED_SYSTEM_PROMPT } from "./instruction.ts";
import { type Clock, guardStall, type StreamFn, type Writer, type WriterJob } from "./writers.ts";

/** Each tool result keeps this much of its start… */
const CUT_HEAD = 1_200;
/** …and this much of its end. */
const CUT_TAIL = 800;
/** The smallest cut the halving goes to. */
const CUT_FLOOR = 200;

const thousands = new Intl.NumberFormat("en-US");

/** pi's own estimate: four characters to a token. */
function tokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** A tool result cut to `budget` characters: its head and its tail, in the 1,200 : 800 ratio, with a marker between. */
function cutResult(text: string, budget: number): string {
	if (text.length <= budget) return text;
	const head = Math.round((budget * CUT_HEAD) / (CUT_HEAD + CUT_TAIL));
	const tail = budget - head;
	return `${text.slice(0, head)}\n[… ${thousands.format(text.length - budget)} characters cut …]\n${text.slice(text.length - tail)}`;
}

type Part = { type: string; text?: string };

/** The words in a message's content. An image is named, not described. */
function textOf(content: string | readonly Part[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text" || part.type === "image")
		.map((part) => (part.type === "text" ? part.text : "[image]"))
		.join("\n");
}

/** One message as a transcript line, or `undefined` for what a transcript leaves out. */
function line(message: AgentMessage, budget: number): string | undefined {
	switch (message.role) {
		case "user":
			return `[User]: ${textOf(message.content)}`;
		case "assistant": {
			const said = textOf(message.content.filter((part) => part.type === "text"));
			const calls = message.content
				.filter((part) => part.type === "toolCall")
				.map((call) => `${call.name}(${Object.entries(call.arguments ?? {}).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")})`);
			const parts = [said && `[Assistant]: ${said}`, calls.length > 0 && `[Assistant tool calls]: ${calls.join("; ")}`].filter(Boolean);
			return parts.length ? parts.join("\n\n") : undefined;
		}
		case "toolResult":
			return `[Tool result]: ${cutResult(textOf(message.content), budget)}`;
		default:
			return undefined;
	}
}

function transcript(messages: readonly AgentMessage[], budget: number): string {
	return messages
		.map((message) => line(message, budget))
		.filter((text) => text !== undefined)
		.join("\n\n");
}

/** The cuts tried, largest first: halving from head + tail down to the floor, the floor itself last. */
function budgets(): number[] {
	const out: number[] = [];
	for (let budget = CUT_HEAD + CUT_TAIL; budget > CUT_FLOOR; budget = Math.floor(budget / 2)) out.push(budget);
	return [...out, CUT_FLOOR];
}

/**
 * The one user message serialized mode sends, at the largest cut that fits
 * `room` tokens with the system prompt — or why none does.
 */
function request(job: WriterJob, room: number | undefined): { ok: true; text: string } | { ok: false; reason: string } {
	const instruction = instructionBody({ hasPrevious: job.previousHandoff !== undefined, focus: job.focus, note: job.note });
	for (const budget of budgets()) {
		const parts = [
			...(job.previousHandoff === undefined ? [] : [`<previous-handoff>\n${job.previousHandoff}\n</previous-handoff>`]),
			`<conversation>\n${transcript(job.span, budget)}\n</conversation>`,
			`<kept-tail>\n${transcript(job.tail, budget)}\n</kept-tail>`,
			instruction,
		];
		const text = parts.join("\n\n");
		if (room === undefined || tokens(SERIALIZED_SYSTEM_PROMPT) + tokens(text) <= room) return { ok: true, text };
	}
	return { ok: false, reason: `the transcript doesn't fit the model's window, even with each tool result cut to ${CUT_FLOOR} characters` };
}

export interface SerializedDeps {
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	sessionId: string;
	stream: StreamFn;
	clock: Clock;
	/**
	 * How many tokens the request may take: the model's window less what pi
	 * keeps back for a reply. `undefined` for a model that reports no window.
	 */
	room: number | undefined;
}

/**
 * The serialized-mode writer. It fails — so the next writer runs — on a
 * request that doesn't fit, a provider error, a reply cut off at the token cap
 * or by a stall, and any reply `parseReply` can't use.
 *
 * Like pi's summarizer, it runs at the session's thinking level and writes no
 * cache: the request shares no prefix with anything sent before or after.
 */
export function serializedWriter(deps: SerializedDeps): Writer {
	return {
		name: "serialized",
		async write(job) {
			const model = deps.model;
			if (!model) throw new Error("no model to write with");
			const built = request(job, deps.room);
			if (!built.ok) throw new Error(built.reason);
			const reply = await guardStall(deps.stream, deps.clock, async (stream) => {
				const events = await stream(
					model,
					// As pi-ai's `normalizeContext` folds a system prompt in: one leading system message.
					{
						messages: [
							{ role: "system", content: SERIALIZED_SYSTEM_PROMPT, timestamp: 0 },
							{ role: "user", content: [{ type: "text", text: built.text }], timestamp: Date.now() },
						],
					} as unknown as TranscriptContext,
					{
						signal: job.signal,
						sessionId: deps.sessionId,
						cacheRetention: "none",
						...(model.reasoning && deps.thinkingLevel && deps.thinkingLevel !== "off" ? { reasoning: deps.thinkingLevel } : {}),
					},
				);
				return events.result();
			});
			const parsed = parseReply(reply);
			if (!parsed.ok) throw new Error(parsed.reason);
			return { judgment: parsed.sections, usage: reply.usage, ledger: parsed.ledger };
		},
	};
}
