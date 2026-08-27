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
 * `failed` arrives with the ticket that introduces it; today a Run runs, may
 * wait on an unanswered Question, and finishes.
 */
export type RunState = "running" | "waiting" | "done";

/**
 * The child-only tool a Run escalates with, and the whole of what tells a
 * settling turn apart.
 *
 * `agent_settled` fires for a Run that is finished and for one that has just
 * asked a Question, because a Question ends the turn. The Supervisor tells them
 * apart by whether the settling turn ran this tool — nothing else in the event
 * stream distinguishes them.
 */
export const ASK_QUESTION_TOOL = "ask_question";

/** What `ask_question` puts in its tool result for the Supervisor to read. */
export interface QuestionDetails {
	question: string;
}

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
	/**
	 * What the Run asked, while it is Waiting. Absent otherwise, and absent when
	 * a Run started Waiting without saying what it wanted to know.
	 */
	question?: string;
}

/** A settled Run's result, ready to re-enter the parent conversation. */
export interface Delivery {
	kind: "delivery";
	run: Run;
	/** The message body the parent session receives. */
	text: string;
}

/** A Waiting Run's unanswered Question, ready to re-enter the parent conversation. */
export interface Question {
	kind: "question";
	run: Run;
	/** The message body the parent session receives. */
	text: string;
}

/**
 * What an observed event asks the parent session to say, when it asks anything.
 *
 * A Question and a Delivery both land in the conversation the same way and
 * differ in one thing that matters upstream: a Delivery ends the Run, a Question
 * leaves its child alive and waiting to be answered.
 */
export type ParentMessage = Delivery | Question;

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
	 * Feed one event from a Run's child. Returns a Question on the event that
	 * moves the Run to Waiting, a Delivery on the event that finishes it, and
	 * nothing on every other event.
	 *
	 * The done-signal is `agent_settled`, **not** `agent_end`: `agent_end` can be
	 * followed by an automatic retry or a compaction, so a Run that ended on it
	 * would deliver a half-finished answer and then keep working. A settling turn
	 * that ran `ask_question` moves the Run to Waiting instead of finishing it —
	 * see `ASK_QUESTION_TOOL`.
	 */
	observe(name: string, event: JsonAgentSessionEvent): ParentMessage | undefined {
		const record = this.byName.get(name);
		if (!record || record.run.state === "done") return undefined;

		if (event.type === "agent_start") {
			// A Waiting Run whose child has started another turn has been answered,
			// so its Question is spent. Sending that answer is another ticket's job.
			record.run.state = "running";
			record.run.question = undefined;
			return undefined;
		}

		if (event.type === "message_end") {
			if (isResultBearing(event.message)) record.lastAssistant = event.message;
			return undefined;
		}

		if (event.type === "tool_execution_end") {
			// An `ask_question` that failed never reached the parent, so the child is
			// still working and this turn settles like any other. A second Question in
			// one turn replaces the first: only the last one is still unanswered.
			if (event.toolName === ASK_QUESTION_TOOL && !event.isError) record.asked = { question: questionText(event.result) };
			return undefined;
		}

		if (event.type !== "agent_settled") return undefined;

		const asked = record.asked;
		if (asked) {
			record.asked = undefined;
			// The question turn's own message is an appeal for help, not a result;
			// leaving it behind would let it be delivered as one later.
			record.lastAssistant = undefined;
			record.run.state = "waiting";
			record.run.question = asked.question;
			return { kind: "question", run: record.run, text: questionMessageText(record.run) };
		}

		record.run.state = "done";
		record.run.result = record.lastAssistant && assistantText(record.lastAssistant);
		return { kind: "delivery", run: record.run, text: deliveryText(record.run) };
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
	/**
	 * The Question this turn ran `ask_question` with, if it did. Present means the
	 * turn moves the Run to Waiting rather than finishing it; the `question`
	 * inside can still be absent, for a child that asked without saying what it
	 * wanted to know.
	 */
	asked?: { question?: string };
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
 * What the child passed to `ask_question`, read back out of its tool result.
 *
 * `unknown` rather than `QuestionDetails`, because this is the far side of a
 * process boundary: the shape is what the child sent, not what this file hopes.
 */
function questionText(result: unknown): string | undefined {
	const asked = (result as { details?: { question?: unknown } } | undefined)?.details?.question;
	return typeof asked === "string" && asked.trim() ? asked.trim() : undefined;
}

/**
 * The message body a Question arrives in.
 *
 * Named after the Run rather than the Agent's persona: the parent answers a Run,
 * and the Run's name is what addresses it.
 */
function questionMessageText(run: Run): string {
	const header = `Run \`${run.name}\` (agent \`${run.agent}\`) has a question and is waiting for an answer.`;
	return run.question ? `${header}\n\n${run.question}` : `${header}\n\nIt did not say what it wanted to know.`;
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
