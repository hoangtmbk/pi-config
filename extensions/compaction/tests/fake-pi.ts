/**
 * A recording fake pi: the one seam every compaction test drives.
 *
 * It stands in for `ExtensionAPI` and the `ctx` each handler is handed, and it
 * does only what pi does at the boundary the extension sees — fire the events
 * the extension subscribed to, run `turn_end` handlers the way pi chains them,
 * and record everything the extension says back: steers, footer statuses,
 * toasts, working-row text and handler errors. Nothing here reaches into the
 * extension; a test sets pi's side of the world (the Context pressure pi would
 * report, the settings, the model, an Escape) and reads what came back.
 *
 * The session is a real in-memory `SessionManager`, so entry ids, `getBranch()`
 * and the projection are pi's own rather than a guess at them.
 *
 * Grown as the extension grows, always by mirroring what pi does: a model call
 * is scripted through `registerCompaction`'s options (pass a `register`), a
 * boundary's drafts land in `boundaries` for committing to `session`, a tool
 * is in `tools` to execute, and an event whose result pi reads —
 * `session_before_compact` — wants its own firing beside `fire`, which, like
 * pi's plain events, ignores what handlers return.
 *
 * Not a `.test.ts` file, so `npm test` does not run it on its own.
 */

import {
	type ContextUsage,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBoundaryDraft,
	SessionManager,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model, StopReason, ToolCall, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { registerCompaction } from "../index.ts";

/** Where a sent message landed, given whether pi was streaming when it was sent. */
export type Landing = "steer" | "followUp" | "nextTurn" | "turn" | "transcript";

export interface SendOptions {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
}

/** One `pi.sendMessage`, as pi was handed it. */
export interface SentMessage {
	customType: string;
	content: unknown;
	display?: boolean;
	details?: unknown;
	triggerTurn?: boolean;
	deliverAs?: string;
	landed: Landing;
}

/**
 * pi's own routing rule, mirrored from `AgentSession.sendCustomMessage` (1.4.0).
 *
 * "transcript" is two of pi's paths — appended at once when idle, held to the
 * end of the turn when streaming — and either way nothing is woken.
 */
export function landing(options: SendOptions | undefined, streaming: boolean): Landing {
	if (options?.deliverAs === "nextTurn") return "nextTurn";
	if (streaming && options?.triggerTurn !== false) return options?.deliverAs === "followUp" ? "followUp" : "steer";
	return options?.triggerTurn ? "turn" : "transcript";
}

/** A pi event handler, as the extension hands it over. */
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** A tool, as the extension registers it. */
export interface RegisteredTool {
	name: string;
	execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
}

/** What one turn looks like from where `turn_end` stands. */
export interface Turn {
	/**
	 * The Context pressure pi reports at this boundary. A number, `null` (pi
	 * after a compaction, before the next response) or `undefined` (pi with no
	 * model, or a model with no window). Leave it out to keep the last reading.
	 */
	tokens?: number | null;
	/** The turn's assistant message. Defaults to one that called a tool, so the run goes on. */
	message?: AssistantMessage;
	/** The turn's tool results. Defaults to one plain result per tool call in `message`. */
	toolResults?: ToolResultMessage[];
	/** Drafts an earlier extension's `turn_end` handler already proposed. */
	entries?: SessionBoundaryDraft[];
}

export interface FakeSetup {
	/** pi's merged settings, as `pi.getSettings()` returns them. */
	settings?: Record<string, unknown>;
	model?: Model<any>;
	/** Defaults to "tui". A Run is "rpc". */
	mode?: ExtensionContext["mode"];
}

/** A model with a 200K window, which the built-in Pressure levels sit well inside. */
export const MODEL = {
	id: "fable-5",
	name: "Fable 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
} as unknown as Model<any>;

const NO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let calls = 0;

/** An assistant message, as pi persists it at the end of a turn. */
export function assistant(content: AssistantMessage["content"], stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: NO_USAGE,
		stopReason,
		timestamp: Date.now(),
	};
}

/** A turn that called a tool: the run goes on after its boundary. */
export function calling(name = "bash", args: Record<string, unknown> = { command: "ls" }): AssistantMessage {
	const call: ToolCall = { type: "toolCall", id: `call-${++calls}`, name, arguments: args as ToolCall["arguments"] };
	return assistant([call], "toolUse");
}

/** A turn that answered in text and called nothing: the boundary that ends the run. */
export function said(text = "Done."): AssistantMessage {
	return assistant([{ type: "text", text }], "stop");
}

/** A turn the user cut short with Escape while the model was still streaming. */
export function aborted(): AssistantMessage {
	return assistant([], "aborted");
}

/** A turn the provider failed. */
export function failed(): AssistantMessage {
	return { ...assistant([], "error"), errorMessage: "overloaded" };
}

/** The result pi records for a tool call — or for the first one a turn made. */
export function result(call: ToolCall | AssistantMessage, text = "ok", isError = false): ToolResultMessage {
	const of = "role" in call ? toolCalls(call)[0] : call;
	if (!of) throw new Error("result: that turn called no tool");
	return { role: "toolResult", toolCallId: of.id, toolName: of.name, content: [{ type: "text", text }], isError, timestamp: Date.now() };
}

function toolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((part): part is ToolCall => part.type === "toolCall");
}

/**
 * A fresh pi with the compaction extension registered on it.
 *
 * `register` defaults to the real entry point with no options; a test that
 * needs to inject something passes its own.
 */
export function fakePi(setup: FakeSetup = {}, register: (pi: ExtensionAPI) => void = (pi) => registerCompaction(pi)) {
	const handlers = new Map<string, Handler[]>();
	const tools: RegisteredTool[] = [];
	const sent: SentMessage[] = [];
	/** Every `ui.setStatus`, oldest first. */
	const statuses: { key: string; text: string | undefined }[] = [];
	/** Every `ui.notify`, oldest first. */
	const notifications: { message: string; type?: string }[] = [];
	/** Every `ui.setWorkingMessage`, oldest first. */
	const working: (string | undefined)[] = [];
	/** Every handler that threw, the way pi's runner reports it and carries on. */
	const errors: { event: string; error: string }[] = [];
	/** What each `turn_end` came back with after the whole chain, oldest first. */
	const boundaries: SessionBoundaryDraft[][] = [];

	const session = SessionManager.inMemory("/work");
	const state = {
		settings: setup.settings ?? {},
		model: setup.model ?? MODEL,
		mode: setup.mode ?? "tui",
		/** What `ctx.getContextUsage()` returns next. */
		usage: undefined as ContextUsage | undefined,
		/** The run in progress: its signal is `ctx.signal`, and Escape aborts it. */
		run: new AbortController(),
		streaming: false,
		turnIndex: 0,
	};

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
		},
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		sendMessage(message: { customType: string; content: unknown; display?: boolean; details?: unknown }, options?: SendOptions) {
			sent.push({
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				triggerTurn: options?.triggerTurn,
				deliverAs: options?.deliverAs,
				landed: landing(options, state.streaming),
			});
		},
		getSettings: () => state.settings,
	};

	// Colours are tagged rather than drawn, so a test can say which one without
	// reading ANSI. pi's real theme throws until it is initialised anyway.
	const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => text };
	const ui = {
		theme,
		setStatus(key: string, text: string | undefined) {
			statuses.push({ key, text });
		},
		notify(message: string, type?: string) {
			notifications.push({ message, type });
		},
		setWorkingMessage(message?: string) {
			working.push(message);
		},
	};

	/** A fresh ctx per event, so whatever a test changed in between is what it reads. */
	function ctx(): ExtensionContext {
		return {
			ui,
			mode: state.mode,
			hasUI: state.mode === "tui" || state.mode === "rpc",
			cwd: "/work",
			sessionManager: session,
			model: state.model,
			signal: state.streaming ? state.run.signal : undefined,
			getContextUsage: () => state.usage,
			isIdle: () => !state.streaming,
			hasPendingMessages: () => false,
			getSystemPrompt: () => "",
		} as unknown as ExtensionContext;
	}

	/** pi's `runner.emit` for plain events: every handler, in order, a throw reported and skipped. */
	async function fire(event: string, payload: Record<string, unknown> = {}): Promise<void> {
		for (const handler of handlers.get(event) ?? []) {
			try {
				await handler({ type: event, ...payload }, ctx());
			} catch (error) {
				errors.push({ event, error: String(error) });
			}
		}
	}

	function setTokens(tokens: number | null | undefined): void {
		const window = state.model?.contextWindow ?? 0;
		state.usage =
			tokens === undefined || window <= 0
				? undefined
				: { tokens, contextWindow: window, percent: tokens === null ? null : (tokens / window) * 100 };
	}

	/**
	 * One `turn_end`, chained the way pi's `ExtensionRunner.emitBoundary` chains it.
	 *
	 * The turn's messages are persisted first, as pi does before the boundary.
	 * Each handler sees the drafts so far, and an `entries` it returns replaces
	 * them. The outcome comes from the message's `stopReason`, exactly as pi
	 * derives it. Returns the drafts pi would commit.
	 *
	 * Drafts are recorded, not yet committed to the session.
	 */
	async function turnEnd(turn: Turn = {}): Promise<SessionBoundaryDraft[]> {
		if ("tokens" in turn) setTokens(turn.tokens);
		const message = turn.message ?? calling();
		const toolResults = turn.toolResults ?? toolCalls(message).map((call) => result(call));
		const messageEntryId = session.appendMessage(message);
		const toolResultEntryIds = toolResults.map((r) => session.appendMessage(r));
		const outcome = message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";

		const projection = session.buildSessionProjection();
		const context = {
			contextEntries: projection.entries,
			contextMessages: projection.messages,
			llmMessages: convertToLlm(projection.messages),
			pendingMessages: [],
			canContinue: true,
		};
		let entries = [...(turn.entries ?? [])];
		let carryOn = false;
		state.streaming = true;
		try {
			for (const handler of handlers.get("turn_end") ?? []) {
				const event: TurnEndEvent = {
					type: "turn_end",
					turnIndex: state.turnIndex,
					message,
					toolResults,
					messageEntryId,
					toolResultEntryIds,
					entries,
					continue: carryOn,
					context,
					outcome,
				};
				try {
					const answer = (await handler(event, ctx())) as { entries?: SessionBoundaryDraft[]; continue?: boolean } | undefined;
					if (answer?.entries !== undefined) entries = answer.entries;
					if (answer?.continue !== undefined) carryOn = answer.continue;
				} catch (error) {
					errors.push({ event: "turn_end", error: String(error) });
				}
			}
		} finally {
			state.streaming = false;
			state.turnIndex++;
		}
		boundaries.push(entries);
		return entries;
	}

	register(pi as unknown as ExtensionAPI);

	return {
		pi,
		session,
		tools,
		sent,
		statuses,
		notifications,
		working,
		errors,
		boundaries,
		fire,
		turnEnd,
		/** Set what pi will report as Context pressure from now on. */
		pressure: setTokens,
		/** Escape: abort the run in progress. Its next boundary is an aborted one. */
		escape(): void {
			state.run.abort();
		},
		/** Start a new run, with a signal of its own, the way a new prompt does. */
		async startRun(): Promise<void> {
			state.run = new AbortController();
			state.turnIndex = 0;
			await fire("agent_start");
		},
		get settings() {
			return state.settings;
		},
		set settings(value: Record<string, unknown>) {
			state.settings = value;
		},
		get model() {
			return state.model;
		},
		set model(value: Model<any>) {
			state.model = value;
		},
		/** The footer status the extension last set, or `undefined` if it is clear. */
		status(key = "compaction"): string | undefined {
			return statuses.filter((s) => s.key === key).at(-1)?.text;
		},
	};
}

export type FakePi = ReturnType<typeof fakePi>;
