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
	/** A hung provider: nothing streams, ever, until the call is aborted. */
	stall?: boolean;
	/**
	 * A slow provider: it streams `start` and then waits on the test, which
	 * streams a chunk with `chunk()` and the rest of the reply with `finish()`.
	 */
	paced?: boolean;
}

/** A test clock: timers fire only as `advance` moves time past them. */
export function fakeClock() {
	let now = 0;
	let next = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	return {
		now: () => now,
		setTimeout(callback: () => void, ms: number): unknown {
			const id = ++next;
			timers.set(id, { at: now + ms, callback });
			return id;
		},
		clearTimeout(handle: unknown): void {
			timers.delete(handle as number);
		},
		/** Move time on by `ms`, firing every timer that falls due, earliest first. */
		advance(ms: number): void {
			const until = now + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort(([, a], [, b]) => a.at - b.at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = due[1].at;
				due[1].callback();
			}
			now = until;
		},
	};
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
		const finish = () => {
			if (stopReason === "error" || stopReason === "aborted") out.push({ type: "error", reason: stopReason, error: message });
			else out.push({ type: "done", reason: stopReason as "stop" | "length" | "toolUse", message });
			out.end();
		};
		if (reply.stall || reply.paced) {
			// Held open. Only an abort ends a stall; a paced reply goes on as the test says.
			let open = true;
			const close = (end: () => void) => {
				if (!open) return;
				open = false;
				paced = undefined;
				end();
			};
			options?.signal?.addEventListener("abort", () =>
				close(() => {
					out.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
					out.end();
				}),
			);
			if (reply.paced) {
				queueMicrotask(() => out.push({ type: "start", partial: message }));
				paced = {
					chunk: () => out.push({ type: "text_delta", contentIndex: 0, delta: "…", partial: message }),
					finish: () => close(finish),
				};
			}
			return out;
		}
		// Streamed on the next tick, as a provider's would be: never before the caller is listening.
		queueMicrotask(() => {
			out.push({ type: "start", partial: message });
			finish();
		});
		return out;
	}

	/** The paced reply streaming now, if one is. */
	let paced: { chunk(): void; finish(): void } | undefined;

	return {
		stream,
		calls,
		/** Stream one chunk of the paced reply in progress. */
		chunk(): void {
			if (!paced) throw new Error("scripted model: no paced reply is streaming");
			paced.chunk();
		},
		/** End the paced reply in progress, as scripted. */
		finish(): void {
			if (!paced) throw new Error("scripted model: no paced reply is streaming");
			paced.finish();
		},
		/**
		 * The text of the instruction a writer was sent on call `n` (0-based): the
		 * last user message, which is the only one serialized mode and pi's
		 * summarizer send, and the forked call's trailing one.
		 */
		prompt(n = 0): string {
			const message = calls[n]?.context.messages.filter((m) => m.role === "user").at(-1);
			if (!message) return "";
			return typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		},
	};
}
