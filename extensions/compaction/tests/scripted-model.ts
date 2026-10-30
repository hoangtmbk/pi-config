/**
 * A scripted model call: what `registerCompaction`'s `stream` option is
 * handed in tests, in place of `ctx.modelRegistry.streamSimple`.
 *
 * Each call takes the next reply off the script and streams it back the way a
 * provider would — a real `AssistantMessageEventStream`, ending in `done` or
 * `error` — and records what it was asked, so a test can read the request a
 * writer made. A call past the end of the script fails the test loudly rather
 * than guessing at a reply.
 *
 * Not a `.test.ts` file, so `npm test` does not run it on its own.
 */

import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type Usage,
} from "@earendil-works/pi-ai";

/** One scripted reply. */
export interface Reply {
	/** The reply's text. */
	text?: string;
	/** Defaults to "stop", or "error" when `errorMessage` is set. */
	stopReason?: StopReason;
	errorMessage?: string;
	/** A tool the reply calls, beside or instead of its text. */
	toolCall?: { name: string; arguments?: Record<string, unknown> };
	usage?: Partial<Usage>;
	/** Runs as the call starts, before anything streams: a test's way to press Escape mid-write. */
	during?: () => void;
}

/** One call the script answered: what a writer sent. */
export interface ModelCall {
	model: Model<any>;
	context: Context;
	options: SimpleStreamOptions | undefined;
}

const USAGE: Usage = {
	input: 1_000,
	output: 500,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1_500,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A model call that answers with `replies`, in order. */
export function scriptModel(...replies: Reply[]) {
	const calls: ModelCall[] = [];
	const queue = [...replies];

	function stream(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		calls.push({ model, context, options });
		const reply = queue.shift();
		if (!reply) throw new Error(`scripted model: no reply left for call ${calls.length}`);
		reply.during?.();
		const out = createAssistantMessageEventStream();
		const stopReason: StopReason = options?.signal?.aborted ? "aborted" : (reply.stopReason ?? (reply.errorMessage ? "error" : "stop"));
		const content: AssistantMessage["content"] = [];
		if (reply.text !== undefined) content.push({ type: "text", text: reply.text });
		if (reply.toolCall) {
			content.push({ type: "toolCall", id: `scripted-${calls.length}`, name: reply.toolCall.name, arguments: (reply.toolCall.arguments ?? {}) as never });
		}
		const message: AssistantMessage = {
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...USAGE, ...reply.usage },
			stopReason,
			...(reply.errorMessage ? { errorMessage: reply.errorMessage } : {}),
			timestamp: Date.now(),
		};
		// Streamed on the next tick, as a provider's would be: never before the caller is listening.
		queueMicrotask(() => {
			out.push({ type: "start", partial: message });
			if (stopReason === "error" || stopReason === "aborted") out.push({ type: "error", reason: stopReason, error: message });
			else out.push({ type: "done", reason: stopReason as "stop" | "length" | "toolUse", message });
			out.end();
		});
		return out;
	}

	return {
		stream,
		calls,
		/** The text of the one user message a summarizer was sent on call `n` (0-based). */
		prompt(n = 0): string {
			const message = calls[n]?.context.messages.find((m) => m.role === "user");
			if (!message) return "";
			return typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		},
	};
}
