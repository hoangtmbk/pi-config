/**
 * Recorded sessions for the replay runner's offline tests: small session files
 * written for the purpose, in pi's own JSONL format — never real transcripts.
 *
 * A test describes a session turn by turn and gets back the text of its file,
 * built through a real in-memory `SessionManager`, so the ids, parent links and
 * entry shapes are pi's own. Text can be padded to a size, so that a test can
 * say how many tokens (at pi's four characters to one) sit between two cuts.
 *
 * Not a `.test.ts` file, so `npm test` does not run it on its own.
 */

import type { AssistantMessage, Model, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MODEL } from "./fake-pi.ts";

const NO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** `text`, padded with filler to about `tokens` tokens (four characters each). */
export function padded(text: string, tokens = 0): string {
	const short = tokens * 4 - text.length;
	return short > 0 ? `${text} ${"·".repeat(short - 1)}` : text;
}

/** One tool call of a recorded turn, and the result recorded for it. */
export interface RecordedCall {
	name: string;
	arguments: Record<string, unknown>;
	result?: string;
	isError?: boolean;
}

let ids = 0;

/** Something to record a session with: each method appends one turn or message, as pi would have. */
export function recorder(cwd = "/work", model: Model<any> = MODEL) {
	const session = SessionManager.inMemory(cwd);

	function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], on: Model<any>): AssistantMessage {
		return { role: "assistant", content, api: on.api, provider: on.provider, model: on.id, usage: NO_USAGE, stopReason, timestamp: Date.now() };
	}

	const r = {
		session,
		/** The system prompt and the tools, as pi records them at the start of a session. */
		system(prompt = "You are a coding agent.") {
			session.appendMessage({
				role: "system",
				content: prompt,
				toolsAdded: ["read", "write", "edit", "bash", "self_compact"].map((name) => ({
					name,
					description: `The ${name} tool.`,
					parameters: { type: "object", properties: {} },
				})),
				timestamp: Date.now(),
			} as never);
			return r;
		},
		user(text: string, tokens = 0) {
			session.appendMessage({ role: "user", content: padded(text, tokens), timestamp: Date.now() });
			return r;
		},
		/** A turn that called tools, each with its recorded result: the run goes on after it. */
		turn(calls: RecordedCall[], options: { text?: string; tokens?: number; model?: Model<any> } = {}) {
			const toolCalls: ToolCall[] = calls.map((call) => ({
				type: "toolCall",
				id: `rec-${++ids}`,
				name: call.name,
				arguments: call.arguments as ToolCall["arguments"],
			}));
			const content: AssistantMessage["content"] = [];
			if (options.text !== undefined || options.tokens) content.push({ type: "text", text: padded(options.text ?? "Working.", options.tokens) });
			content.push(...toolCalls);
			session.appendMessage(assistant(content, "toolUse", options.model ?? model));
			calls.forEach((call, i) => {
				const result: ToolResultMessage = {
					role: "toolResult",
					toolCallId: toolCalls[i]!.id,
					toolName: call.name,
					content: [{ type: "text", text: call.result ?? "ok" }],
					isError: call.isError ?? false,
					timestamp: Date.now(),
				};
				session.appendMessage(result);
			});
			return r;
		},
		/** A turn that answered in text and called nothing: the end of a run. */
		say(text: string, tokens = 0, on: Model<any> = model) {
			session.appendMessage(assistant([{ type: "text", text: padded(text, tokens) }], "stop", on));
			return r;
		},
		/** A compaction pi recorded, keeping everything from the entry `back` entries before it. */
		compaction(summary: string, back = 1) {
			const branch = session.getBranch();
			const kept = branch[Math.max(0, branch.length - back)]!;
			session.appendCompaction(summary, kept.id, 1_000, undefined, false);
			return r;
		},
		/** The session file's text: its header, then every entry, one JSON object a line. */
		text(): string {
			return [session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n");
		},
	};
	return r;
}
