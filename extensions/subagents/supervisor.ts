/**
 * The Supervisor: the parent session's registry of Runs and the state machine
 * that decides when one is done.
 *
 * Pure by construction — it never spawns, reads or writes anything. It is fed
 * the child's event stream and hands back the Delivery when a Run settles. That
 * separation is load-bearing: it is what makes the lifecycle testable by writing
 * down an event sequence, rather than by mocking a subprocess.
 */

import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Where a Run is in its lifecycle.
 *
 * `waiting` (a Run suspended on an unanswered Question) and `failed` arrive with
 * the tickets that introduce them; today a Run only ever runs and finishes.
 */
export type RunState = "running" | "done";

export interface Run {
	/** Unique within the session, and how every tool addresses this Run. */
	name: string;
	/** The Agent this Run is an execution of. */
	agent: string;
	task: string;
	state: RunState;
	/**
	 * The child's last assistant message, once the Run is done. Absent when the
	 * child settled without saying anything.
	 */
	result?: string;
}

/** A settled Run's result, ready to re-enter the parent conversation. */
export interface Delivery {
	run: Run;
	/** The message body the parent session receives. */
	text: string;
}

export class Supervisor {
	private readonly byName = new Map<string, RunRecord>();

	/**
	 * Take on a new Run: reserve a name for it and record it as running.
	 *
	 * Called before anything is spawned, because the name is what the caller
	 * needs back and what the child is told it is.
	 */
	register(agent: string, task: string, requestedName?: string): Run {
		const name = this.reserveName(requestedName?.trim() || agent);
		const record: RunRecord = { run: { name, agent, task, state: "running" } };
		this.byName.set(name, record);
		return record.run;
	}

	/** Every Run this session has started, in the order they were registered. */
	list(): Run[] {
		return [...this.byName.values()].map((record) => record.run);
	}

	get(name: string): Run | undefined {
		return this.byName.get(name)?.run;
	}

	/**
	 * Feed one event from a Run's child. Returns a Delivery on the event that
	 * finishes the Run, and nothing on every other event.
	 *
	 * The done-signal is `agent_settled`, **not** `agent_end`: `agent_end` can be
	 * followed by an automatic retry or a compaction, so a Run that ended on it
	 * would deliver a half-finished answer and then keep working.
	 */
	observe(name: string, event: JsonAgentSessionEvent): Delivery | undefined {
		const record = this.byName.get(name);
		if (!record || record.run.state === "done") return undefined;

		if (event.type === "message_end") {
			if (isResultBearing(event.message)) record.lastAssistant = event.message;
			return undefined;
		}

		if (event.type !== "agent_settled") return undefined;

		record.run.state = "done";
		record.run.result = record.lastAssistant && assistantText(record.lastAssistant);
		return { run: record.run, text: deliveryText(record.run) };
	}

	/**
	 * A free name based on `base`, suffixed from 2 up: `scout`, `scout-2`.
	 *
	 * A finished Run keeps its name for the rest of the session, so a name never
	 * addresses two different Runs. Names are session-scoped: nothing is written
	 * down, and a restart starts the numbering over.
	 */
	private reserveName(base: string): string {
		if (!this.byName.has(base)) return base;
		let suffix = 2;
		while (this.byName.has(`${base}-${suffix}`)) suffix++;
		return `${base}-${suffix}`;
	}
}

interface RunRecord {
	run: Run;
	/** The newest assistant message seen, which becomes the result on settling. */
	lastAssistant?: AssistantMessage;
}

/** The parts of an assistant message a result is read from. */
interface AssistantMessage {
	role: "assistant";
	content: { type: string; text?: string }[];
	stopReason?: string;
}

/** Whether a `message_end` event's message is one a result can be read from. */
function isResultBearing(message: { role: string }): message is AssistantMessage {
	if (message.role !== "assistant") return false;
	const assistant = message as AssistantMessage;
	// An aborted message with nothing in it is a turn that never happened; pi's
	// own `getLastAssistantText` skips it, and so does this.
	return !(assistant.stopReason === "aborted" && assistant.content.length === 0);
}

function assistantText(message: AssistantMessage): string | undefined {
	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
	return text.trim() || undefined;
}

/**
 * The Delivery body.
 *
 * Deliberately thin: the result's shape is whatever the Agent's markdown asked
 * for, so this only says which Run is speaking and gets out of the way.
 */
function deliveryText(run: Run): string {
	const header = `Run \`${run.name}\` (agent \`${run.agent}\`) is done.`;
	return run.result ? `${header}\n\n${run.result}` : `${header}\n\nIt finished without producing a result.`;
}
