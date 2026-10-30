/**
 * Transcripts: each Run's child conversation, rebuilt from its event stream so
 * the Inspector can draw it the way the main chat draws the parent's.
 *
 * Pure, like `supervisor.ts` and for the same reason: it is fed the very events
 * the Supervisor is fed and does nothing but remember them, so what a reader
 * would see is asserted by writing down an event sequence rather than by
 * driving a child or a terminal. Nothing here renders; `inspector.ts` does.
 *
 * What the stream is, as pi 0.85 sends it over RPC — each part checked against
 * pi's source rather than assumed:
 *
 * - Every message the child's conversation gains arrives as a `message_start`
 *   and a `message_end` carrying it — the task, a later prompt, a steer the
 *   child took at a turn boundary, an extension's custom message, the
 *   assistant's replies and every tool result. So the transcript shows the
 *   human's words without anyone writing them down beside it: they come back
 *   from the child like everything else, at the point the child took them.
 * - An assistant message streams in between the two as `message_update`s, and
 *   over RPC those carry only the delta — the cumulative `message` an
 *   in-process subscriber gets is stripped on the wire, to keep a long reply
 *   from being re-sent whole on every token. So the streaming message is built
 *   here, from the `message_start` snapshot plus each delta at its
 *   `contentIndex`, and `message_end`'s message replaces it as the word on what
 *   was said.
 * - Tool calls stream their arguments as raw JSON fragments. They are not
 *   assembled: a call shows with empty arguments until `toolcall_end` hands over
 *   the finished call, which costs a moment of a bare tool name and saves
 *   re-parsing a growing string on every fragment of a large `write`.
 * - A tool's execution is its own trio of events keyed by `toolCallId`, and an
 *   update's `partialResult` is everything so far rather than the newest piece,
 *   so it replaces the last one instead of being appended to it.
 * - A compaction is not a message the child settles, so it arrives as one of
 *   two other events, depending on who started it. One drafted at a turn
 *   boundary — the compaction extension's forced level and Self-compaction — is
 *   an `entry_appended` carrying the compaction entry, which the same event
 *   sends for every other entry committed there, Pruning's edits included. One
 *   on pi's hook paths is a `compaction_end` with its result, and nothing else.
 *   Either way it is folded in as the `compactionSummary` message pi's chat
 *   draws its compaction card from, at the point it landed; what came before it
 *   stays, since a reader wants to see what the Run carried forward from.
 *
 * The shapes chosen, which the contract left open:
 *
 * - `messages` holds every settled message whatever its role, in the order the
 *   child settled them, `toolResult` included. What to draw of each is the
 *   renderer's call; pi's own chat draws a tool from `tools` and skips the
 *   result message, and that stays possible here.
 * - `tools` has an entry only once a tool has started executing. A call that is
 *   in an assistant message and has no entry has not run yet, or never will.
 * - A snapshot is live rather than a copy: `get` hands back the same object for
 *   a Run every time, changed in place as events arrive. Copying it per event
 *   would cost a whole conversation per token. `version` is what to keep and
 *   compare, not the snapshot.
 *
 * Memory is one snapshot per Run, for the rest of the session — finished Runs
 * stay inspectable. No raw event is kept: each one is folded into the snapshot
 * and dropped, and a tool's output is held once rather than in both its
 * execution and its result message.
 */

import type { AgentToolResult, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * One message of a child's conversation, as pi's `AgentMessage`.
 *
 * Read off the event type rather than imported: pi re-exports the event stream
 * but not the message types it is made of, and those live in packages this one
 * does not depend on directly.
 */
export type AgentMessage = Extract<JsonAgentSessionEvent, { type: "message_end" }>["message"];

/** An assistant message, the one kind that streams. */
export type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

/** One tool execution in a child, as far as its events have got. */
export interface ToolExecution {
	toolCallId: string;
	toolName: string;
	/** The arguments the tool was started with. */
	args: unknown;
	/**
	 * What the tool has produced: everything so far while it runs, the final
	 * result once it has ended. Absent for a tool that has not reported anything.
	 */
	result?: AgentToolResult<unknown>;
	/** Whether the tool ended in an error. Always false while it runs. */
	isError: boolean;
	/** Whether the tool is still executing. */
	running: boolean;
}

export interface TranscriptSnapshot {
	/** Settled messages in the order the child settled them: user, assistant, toolResult, custom, compactionSummary. */
	messages: AgentMessage[];
	/** The assistant message currently streaming, if any — built from `message_start` and each delta. */
	streaming?: AssistantMessage;
	/** Tool executions by `toolCallId`. */
	tools: ReadonlyMap<string, ToolExecution>;
	/** Bumped on every change: a cheap "did anything change" for a renderer to compare. */
	version: number;
}

/** A Run's snapshot, with the map it hands out read-only kept writable here. */
interface Transcript extends TranscriptSnapshot {
	tools: Map<string, ToolExecution>;
}

/** A piece of an assistant message's content. */
type Part = AssistantMessage["content"][number];

export class Transcripts {
	private readonly byName = new Map<string, Transcript>();
	private readonly listeners = new Set<(name: string) => void>();

	/**
	 * Begin a Run's transcript.
	 *
	 * Called at spawn, before the child's first event, so that the task the Run
	 * was given — the first message its child settles — is in it. Starting a name
	 * again starts it over; a name never addresses two Runs in one session, so
	 * that is a restart, not a collision.
	 */
	start(name: string): void {
		this.byName.set(name, { messages: [], tools: new Map(), version: 0 });
		this.changed(name);
	}

	/**
	 * Feed one event from a Run's child — the same stream `Supervisor.observe`
	 * gets. Events for a Run that was never started are dropped, and so is every
	 * event that changes nothing a reader sees.
	 */
	observe(name: string, event: JsonAgentSessionEvent): void {
		const transcript = this.byName.get(name);
		if (!transcript || !apply(transcript, event)) return;
		transcript.version++;
		this.changed(name);
	}

	/**
	 * Mark a Run's child as gone: nothing that was in flight in it will finish.
	 *
	 * Not in the stream, because a child that is killed or dies says nothing
	 * about it — its streaming message and running tools would otherwise read as
	 * live for the rest of the session. A half-streamed message is kept as an
	 * aborted one, the way pi keeps a reply cut off by Escape, and a running tool
	 * is ended in an error with whatever output it had got to. Call it once the
	 * Run has stopped for good; ending a Run that finished cleanly changes nothing.
	 */
	end(name: string): void {
		const transcript = this.byName.get(name);
		if (!transcript) return;
		let changed = false;
		if (transcript.streaming) {
			transcript.messages.push({ ...transcript.streaming, stopReason: "aborted" });
			transcript.streaming = undefined;
			changed = true;
		}
		for (const tool of transcript.tools.values()) {
			if (!tool.running) continue;
			tool.running = false;
			tool.isError = true;
			changed = true;
		}
		if (!changed) return;
		transcript.version++;
		this.changed(name);
	}

	/** A Run's snapshot, or undefined for a Run never started. Live — see the top of this file. */
	get(name: string): TranscriptSnapshot | undefined {
		return this.byName.get(name);
	}

	/** Called with a Run's name whenever its transcript changed. Returns the unsubscribe. */
	onChange(listener: (name: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(name: string): void {
		for (const listener of this.listeners) listener(name);
	}
}

/** Fold one event into a transcript. Returns whether anything a reader sees changed. */
function apply(transcript: Transcript, event: JsonAgentSessionEvent): boolean {
	switch (event.type) {
		case "message_start": {
			// Only an assistant message has anything between its start and its end.
			// Every other kind starts and ends with the same message back to back,
			// so it is taken once, at the end.
			if (event.message.role !== "assistant") return false;
			const message = event.message as AssistantMessage;
			transcript.streaming = { ...message, content: [...message.content] };
			return true;
		}
		case "message_update":
			return transcript.streaming !== undefined && applyDelta(transcript.streaming, event.assistantMessageEvent);
		case "message_end": {
			const message = event.message;
			if (message.role === "assistant") transcript.streaming = undefined;
			if (message.role === "toolResult") shareResult(transcript, message);
			transcript.messages.push(message);
			return true;
		}
		case "tool_execution_start":
			transcript.tools.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				isError: false,
				running: true,
			});
			return true;
		case "tool_execution_update": {
			const tool = toolFor(transcript, event.toolCallId, event.toolName, event.args);
			tool.result = event.partialResult as AgentToolResult<unknown>;
			return true;
		}
		case "tool_execution_end": {
			const tool = toolFor(transcript, event.toolCallId, event.toolName, undefined);
			tool.result = event.result as AgentToolResult<unknown>;
			tool.isError = event.isError;
			tool.running = false;
			return true;
		}
		case "entry_appended": {
			// The boundary path. Only a compaction is drawn: the same event carries
			// every other entry pi commits there, Pruning's edits among them, and
			// those are not shown.
			const entry = event.entry;
			if (entry.type !== "compaction") return false;
			transcript.messages.push(compactionCard(entry.summary, entry.tokensBefore, Date.parse(entry.timestamp)));
			return true;
		}
		case "compaction_end":
			// The hook paths — `/compact`, pi's threshold, its overflow recovery —
			// append the entry with no `entry_appended`, so this is the only word of
			// it, and a boundary compaction sends no `compaction_end`: never both.
			// One that was cancelled or failed has no result and left nothing. The
			// event has no time of its own, so it is stamped on arrival, as pi's chat
			// stamps it.
			if (!event.result) return false;
			transcript.messages.push(compactionCard(event.result.summary, event.result.tokensBefore, Date.now()));
			return true;
		default:
			return false;
	}
}

/**
 * The message a compaction is drawn from, as pi's chat builds it: a
 * `compactionSummary` carrying the Handoff and the size it was compacted from.
 */
function compactionCard(summary: string, tokensBefore: number, timestamp: number): AgentMessage {
	return { role: "compactionSummary", summary, tokensBefore, timestamp };
}

/** One delta of a streaming assistant message. */
type Delta = Extract<JsonAgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"];

/**
 * Fold one delta into the streaming message, at the content index it names.
 *
 * Each `_end` carries the finished block, and it is taken over whatever the
 * deltas built: they should agree, and where they don't, the end is the one
 * pi stands behind. Returns whether anything changed.
 */
function applyDelta(message: AssistantMessage, delta: Delta): boolean {
	const content = message.content as Part[];
	switch (delta.type) {
		case "text_start":
			content[delta.contentIndex] = { type: "text", text: "" };
			return true;
		case "text_delta": {
			const part = content[delta.contentIndex];
			content[delta.contentIndex] = { type: "text", text: (part?.type === "text" ? part.text : "") + delta.delta };
			return true;
		}
		case "text_end":
			content[delta.contentIndex] = { type: "text", text: delta.content };
			return true;
		case "thinking_start":
			content[delta.contentIndex] = { type: "thinking", thinking: "" };
			return true;
		case "thinking_delta": {
			const part = content[delta.contentIndex];
			content[delta.contentIndex] = {
				type: "thinking",
				thinking: (part?.type === "thinking" ? part.thinking : "") + delta.delta,
			};
			return true;
		}
		case "thinking_end":
			content[delta.contentIndex] = { type: "thinking", thinking: delta.content };
			return true;
		case "toolcall_start":
			content[delta.contentIndex] = { type: "toolCall", id: delta.id, name: delta.toolName, arguments: {} };
			return true;
		case "toolcall_end":
			content[delta.contentIndex] = delta.toolCall;
			return true;
		default:
			// `toolcall_delta` is a fragment of JSON not worth assembling (see the top
			// of this file); `start`, `done` and `error` are not sent as updates at all.
			return false;
	}
}

/**
 * The execution an update or end belongs to, made up from the event when its
 * start was never seen — a transcript started late, or a stream that skipped
 * one. Better a tool shown from its first sign of life than not at all.
 */
function toolFor(transcript: Transcript, toolCallId: string, toolName: string, args: unknown): ToolExecution {
	let tool = transcript.tools.get(toolCallId);
	if (!tool) {
		tool = { toolCallId, toolName, args, isError: false, running: true };
		transcript.tools.set(toolCallId, tool);
	}
	return tool;
}

/**
 * Point a tool's execution at its result message's output, so the transcript
 * holds that output once.
 *
 * The two are the same output parsed twice — `tool_execution_end` and the
 * `toolResult` message are separate lines on the wire — and a `read` of a large
 * file would otherwise sit in memory twice for the rest of the session.
 */
function shareResult(transcript: Transcript, message: Extract<AgentMessage, { role: "toolResult" }>): void {
	const tool = transcript.tools.get(message.toolCallId);
	if (!tool || tool.running) return;
	tool.result = { content: message.content, details: message.details };
}
