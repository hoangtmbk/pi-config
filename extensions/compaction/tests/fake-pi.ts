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
 * the extension registers is in `tools`, and run when a turn calls it, and `session_before_compact`, whose result pi
 * reads, has its own firing in `compact` — beside `fire`, which, like pi's
 * plain events, ignores what handlers return.
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
import type { AssistantMessage, Model, StopReason, ToolCall, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
// pi's own preparation for `/compact` and its backstop. Not exported from the
// package root, so it is reached by path: the fake prepares exactly what pi would.
import {
	type CompactionPreparation,
	estimateProjectedContextTokens,
	prepareCompaction,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
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
	/**
	 * The turn's tool results. Defaults to what pi would record: a call to a
	 * tool the extension registered is executed, as pi executes it, and any
	 * other call gets one plain result.
	 */
	toolResults?: ToolResultMessage[];
	/** Drafts an earlier extension's `turn_end` handler already proposed. */
	entries?: SessionBoundaryDraft[];
	/**
	 * Reshapes the context preview pi hands the handlers, for a test whose
	 * preview must disagree with the session behind it. Leave it out for pi's
	 * own: the session's projection.
	 */
	preview?: (context: TurnEndEvent["context"]) => TurnEndEvent["context"];
}

export interface FakeSetup {
	/** pi's merged settings, as `pi.getSettings()` returns them. */
	settings?: Record<string, unknown>;
	model?: Model<any>;
	/** Defaults to "tui". A Run is "rpc". */
	mode?: ExtensionContext["mode"];
	/** Defaults to an in-memory one, as a `--no-session` Run has. Pass one with a session file to have a session dir. */
	session?: SessionManager;
	/** Defaults to "medium". */
	thinkingLevel?: ExtensionContext["thinkingLevel"];
}

/** How a compaction reaches `session_before_compact`: `/compact`, or pi's own backstop. */
export interface Compaction {
	/** Defaults to "manual", which is `/compact`. */
	reason?: "manual" | "threshold" | "overflow";
	/** What followed `/compact`. */
	customInstructions?: string;
}

/** What one `session_before_compact` came to, after the whole chain. */
export interface Compacted {
	/** What the chain returned, as pi's runner composes it: the last truthy result wins. */
	result:
		| { cancel?: boolean; compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown; usage?: Usage } }
		| undefined;
	/** What pi prepared and handed the hook. */
	preparation: CompactionPreparation;
	/** The id of the compaction entry pi appended from the result, if it took one. */
	entryId?: string;
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

/** A message the user typed. */
export function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
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

	const session = setup.session ?? SessionManager.inMemory("/work");
	const state = {
		settings: setup.settings ?? {},
		model: setup.model ?? MODEL,
		mode: setup.mode ?? "tui",
		/** What `ctx.getContextUsage()` returns next. */
		usage: undefined as ContextUsage | undefined,
		/** The run in progress: its signal is `ctx.signal`, and Escape aborts it. */
		run: new AbortController(),
		/** The hook compaction in progress: its signal is `session_before_compact`'s, and Escape aborts it. */
		compacting: undefined as AbortController | undefined,
		thinkingLevel: setup.thinkingLevel ?? "medium",
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
			thinkingLevel: state.thinkingLevel,
			// Only what the extension resolves models through. The model call itself
			// is never real: a test scripts it through `registerCompaction`'s options.
			modelRegistry: {
				find: (provider: string, id: string) => (state.model?.provider === provider && state.model.id === id ? state.model : undefined),
				streamSimple: () => {
					throw new Error("fake pi: no model call scripted (pass one through registerCompaction's options)");
				},
			},
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
	 * One tool call, run the way pi's agent loop runs it: while the run streams,
	 * with the run's signal, a throw recorded as an errored result.
	 */
	async function execute(call: ToolCall): Promise<ToolResultMessage> {
		const tool = tools.find((t) => t.name === call.name);
		if (!tool) return result(call);
		state.streaming = true;
		try {
			const done = await tool.execute(call.id, call.arguments, state.run.signal, undefined, ctx());
			const text = done.content.map((part) => part.text ?? "").join("");
			return { ...result(call, text, done.isError ?? false), content: done.content as ToolResultMessage["content"] };
		} catch (error) {
			return result(call, error instanceof Error ? error.message : String(error), true);
		} finally {
			state.streaming = false;
		}
	}

	/**
	 * One `turn_end`, chained the way pi's `ExtensionRunner.emitBoundary` chains it.
	 *
	 * The turn's messages are persisted first, as pi does before the boundary.
	 * Each handler sees the drafts so far, and an `entries` it returns replaces
	 * them. The outcome comes from the message's `stopReason`, exactly as pi
	 * derives it. Returns the drafts pi would commit.
	 *
	 * Drafts are recorded, not yet committed to the session: `commit` does that.
	 */
	async function turnEnd(turn: Turn = {}): Promise<SessionBoundaryDraft[]> {
		if ("tokens" in turn) setTokens(turn.tokens);
		const message = turn.message ?? calling();
		const messageEntryId = session.appendMessage(message);
		const toolResultEntryIds: string[] = [];
		let toolResults = turn.toolResults;
		if (toolResults) toolResultEntryIds.push(...toolResults.map((r) => session.appendMessage(r)));
		else {
			// Each result is persisted as its tool finishes, so a later call sees the earlier ones on the branch.
			toolResults = [];
			for (const call of toolCalls(message)) {
				const done = await execute(call);
				toolResults.push(done);
				toolResultEntryIds.push(session.appendMessage(done));
			}
		}
		const outcome = message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";

		const projection = session.buildSessionProjection();
		const own = {
			contextEntries: projection.entries,
			contextMessages: projection.messages,
			llmMessages: convertToLlm(projection.messages),
			pendingMessages: [],
			canContinue: true,
		};
		const context = turn.preview ? turn.preview(own) : own;
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

	/**
	 * Commit a boundary's drafts to the session, the way pi's
	 * `AgentSession._applyBoundaryDrafts` does once the chain is done (1.4.0):
	 * in order, each a real entry. A compaction draft carries no size; pi
	 * measures the context as the drafts before it left it, and appends it
	 * marked as an extension's. Throws where pi's replay would.
	 */
	function commit(drafts: readonly SessionBoundaryDraft[]): void {
		for (const draft of drafts) {
			if (draft.type === "custom") session.appendCustomEntry(draft.customType, draft.data);
			else if (draft.type === "custom_message") session.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
			else if (draft.type === "context_edit") session.appendContextEdit(draft.targetId, draft.replacement);
			else {
				const tokensBefore = estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch()).tokens;
				session.appendCompaction(draft.summary, draft.firstKeptEntryId, tokensBefore, draft.details, true, draft.usage);
			}
		}
	}

	/**
	 * One compaction through the hook, the way pi's `AgentSession.compact()` and
	 * its backstop run it (1.4.0): pi's own preparation of the branch, then
	 * `session_before_compact` through every handler, the last truthy result
	 * winning and a `cancel` ending the chain there. A compaction in the result
	 * is appended to the session as pi appends it, marked as an extension's.
	 *
	 * Returns `undefined` where pi refuses before the hook: "Already compacted",
	 * or nothing to compact.
	 */
	async function compact(how: Compaction = {}): Promise<Compacted | undefined> {
		const settings = (state.settings.compaction ?? {}) as { keepRecentTokens?: number; reserveTokens?: number };
		const preparation = prepareCompaction(session.getBranch(), {
			enabled: true,
			reserveTokens: settings.reserveTokens ?? 16_384,
			keepRecentTokens: settings.keepRecentTokens ?? 20_000,
		});
		if (!preparation) return undefined;
		const reason = how.reason ?? "manual";
		// `/compact` aborts the run before the hook; the backstop runs between turns.
		if (reason === "manual") state.run.abort();
		state.compacting = new AbortController();
		const event = {
			type: "session_before_compact",
			preparation,
			branchEntries: session.getBranch(),
			customInstructions: how.customInstructions,
			reason,
			willRetry: reason === "overflow",
			signal: state.compacting.signal,
		};
		let result: Compacted["result"];
		try {
			for (const handler of handlers.get("session_before_compact") ?? []) {
				try {
					const answer = (await handler(event, ctx())) as Compacted["result"];
					if (answer) result = answer;
					if (answer?.cancel) break;
				} catch (error) {
					errors.push({ event: "session_before_compact", error: String(error) });
				}
			}
		} finally {
			state.compacting = undefined;
		}
		const taken = result?.cancel ? undefined : result?.compaction;
		const entryId = taken
			? session.appendCompaction(taken.summary, taken.firstKeptEntryId, taken.tokensBefore, taken.details, true, taken.usage)
			: undefined;
		// pi has no reading after a compaction until the next response.
		if (taken) setTokens(null);
		return { result, preparation, entryId };
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
		commit,
		compact,
		/** Escape while a hook compaction runs: abort the signal pi handed `session_before_compact`. */
		escapeCompaction(): void {
			state.compacting?.abort();
		},
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
