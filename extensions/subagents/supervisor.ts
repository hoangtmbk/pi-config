/**
 * The Supervisor: the parent session's registry of Runs and the state machine
 * that decides when one is done.
 *
 * Pure by construction — it never spawns, reads or writes anything. It is fed
 * the child's event stream and hands back the Delivery when a Run settles. That
 * separation is load-bearing: it is what makes the lifecycle testable by writing
 * down an event sequence, rather than by mocking a subprocess.
 *
 * The one reading it does is the clock, for stamping how long a Run has been
 * outstanding, and even that arrives through `SupervisorOptions.now` so a test
 * can hand it a clock of its own. Nothing else here touches the world.
 */

import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Where a Run is in its lifecycle.
 *
 * A Run may queue for a free slot, then runs, may wait on an unanswered
 * Question, and then either finishes or fails. `done` and `failed` are both
 * final and both deliver: the difference is whether the Run has a result to hand
 * over or a reason it has none.
 */
export type RunState = "queued" | "running" | "waiting" | "done" | "failed";

/**
 * How many Runs may be working at once. Everything past that queues.
 *
 * ADR-0002's cap. Small and fixed rather than derived from the machine, because
 * the binding constraint is the provider's rate limit and not this computer:
 * four children hammering one API key is already where a wide fan-out starts
 * costing more in retries than it saves in wall-clock.
 */
export const RUN_SLOTS = 4;

/**
 * Why a Run stopped without finishing.
 *
 * Deliberately the two causes that exist, rather than one message string: a
 * child that never started and a child that died are different things for the
 * parent to decide about, and only the second has an exit code to report.
 *
 * The `exit` arm mirrors `child.ts`'s `ChildExit` field for field, and the two
 * have to move together. It is spelled out twice rather than imported, because
 * this file stays pure and `child.ts` already imports from here.
 */
export type RunFailure =
	| { kind: "spawn"; message: string }
	| {
			kind: "exit";
			/** The child's exit code, when it exited on its own. */
			exitCode?: number;
			/** The signal that killed the child, when one did. */
			signal?: string;
			/** The tail of what the child wrote to stderr — usually the whole of why. */
			stderr?: string;
	  }
	| {
			/**
			 * The session ended the Run on purpose — an abort, or a shutdown.
			 *
			 * A third arm rather than an `exit` with `signal: "SIGTERM"`, because
			 * that would read as a Run something killed out from under it. This one
			 * says who did it, which is the difference between a fault to look into
			 * and the parent getting what it asked for.
			 */
			kind: "stopped";
			/** Why the session ended it, as the clause a Delivery says it in. */
			reason: string;
	  };

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
	 * When the session took this Run on, as a millisecond clock reading.
	 *
	 * The moment it was asked for rather than the moment its child came up: a
	 * queued Run is outstanding work from the instant the parent asked for it,
	 * and a clock that only started once a slot freed would report a fan-out of
	 * eight as if half of it had not been asked for yet.
	 */
	askedAt: number;
	/**
	 * What this Run's child is doing, as of the last tool it started. Absent for
	 * a Run that has not run a tool yet, and for one that is Waiting.
	 *
	 * The last tool it *started*, deliberately: a child spends its time inside
	 * tool calls, and one that has finished a tool and not yet started another is
	 * a moment too short to be worth a line that says nothing.
	 */
	activity?: string;
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
	/** Why the Run stopped, once it has failed. Absent otherwise. */
	failure?: RunFailure;
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
 * A queued Run's answer to a join that asked about it before it had started.
 *
 * Only a join ever sees one, and only in the one case where waiting any longer
 * would strand it: see `isInFlight`. Nothing settled it, so there is nothing to
 * deliver and nothing to mark as said.
 */
export interface Queued {
	kind: "queued";
	run: Run;
	/** The message body the parent session receives. */
	text: string;
}

/**
 * What a settling Run asks the parent session to say.
 *
 * A Question and a Delivery both land in the conversation the same way and
 * differ in one thing that matters upstream: a Delivery ends the Run, a Question
 * leaves its child alive and waiting to be answered.
 */
export type SettledMessage = Delivery | Question;

/** Everything a join can come back holding, settled or not. */
export type ParentMessage = SettledMessage | Queued;

export interface SupervisorOptions {
	/**
	 * A queued Run whose slot has come free, handed over to be started.
	 *
	 * The Supervisor owns which Run goes next and when, and nothing else: it has
	 * no way to spawn one. Called only for a Run that was queued — one registered
	 * into a free slot is already the caller's to start.
	 */
	onAdmit?: (run: Run) => void;
	/**
	 * What time it is, in milliseconds, for stamping a Run's `askedAt`.
	 *
	 * Injected rather than read, so that this file keeps reading nothing outside
	 * itself and a test can say how old a Run is instead of waiting for it to get
	 * that old. Defaults to the wall clock.
	 */
	now?: () => number;
}

export class Supervisor {
	private readonly byName = new Map<string, RunRecord>();
	private readonly onAdmit?: (run: Run) => void;
	private readonly now: () => number;
	/**
	 * Whether every Run is being ended, and so nothing may be admitted.
	 *
	 * Without it `endAll` would fail a Run, free its slot, and start a queued one
	 * into the session that is going away — the orphan the reap exists to prevent.
	 */
	private ending = false;
	/**
	 * The `subagent_wait` calls in flight, each with the Runs it named.
	 *
	 * A message a join is waiting for is collected by that join rather than
	 * delivered on its own — half of the no-double-delivery rule. The other half
	 * is the mailbox: see `RunRecord.said`.
	 */
	private readonly joins = new Set<PendingJoin>();

	constructor(options: SupervisorOptions = {}) {
		this.onAdmit = options.onAdmit;
		this.now = options.now ?? Date.now;
	}

	/**
	 * Take on a new Run: reserve a name for it and record it as running, or as
	 * queued when every slot is taken.
	 *
	 * Called before anything is spawned, because the name is what the caller
	 * needs back and what the child is told it is. The caller starts a Run that
	 * came back running; a queued one is handed to `onAdmit` later instead, so
	 * that a fan-out past the cap costs the parent a wait rather than an error.
	 */
	register(agent: string, task: string, requestedName?: string): Run {
		const name = this.reserveName(requestedName?.trim() || agent);
		const state: RunState = this.slotsInUse() < RUN_SLOTS ? "running" : "queued";
		const record: RunRecord = { run: { name, agent, task, state, askedAt: this.now() }, said: false };
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
	 * Every Run that has not finished — what a join with no names waits on.
	 *
	 * A Waiting Run counts as active: it is alive, and a join that passed over it
	 * would say nothing at all about a session whose only Run needs an answer. A
	 * failed one does not: it is as finished as a done one, and a join that kept
	 * waiting on it would wait forever.
	 */
	active(): Run[] {
		return this.list().filter((run) => !hasStopped(run.state));
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
	observe(name: string, event: JsonAgentSessionEvent): SettledMessage | undefined {
		const record = this.byName.get(name);
		if (!record || hasStopped(record.run.state)) return undefined;

		if (event.type === "message_end") {
			if (isResultBearing(event.message)) record.lastAssistant = event.message;
			return undefined;
		}

		if (event.type === "tool_execution_start") {
			record.run.activity = activityOf(event.toolName, event.args);
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
			// Waiting is the whole of what a Waiting Run is doing. The tool it last
			// started was the `ask_question` that got it here, and reporting that as
			// activity would say a Run is busy when it is stopped.
			record.run.activity = undefined;
		} else {
			record.run.state = "done";
			record.run.result = record.lastAssistant && assistantText(record.lastAssistant);
			// The slot this Run was holding is free, so whatever has been queued
			// longest starts now rather than when the parent next asks for anything.
			this.admitQueued();
		}

		// Either way the Run now has something it has not said yet.
		record.said = false;
		return settledFor(record.run);
	}

	/**
	 * Report that a Waiting Run has been answered, and is working again.
	 *
	 * The parent answering is what takes a Run out of Waiting — not its child
	 * getting round to starting a turn. Only the first of those is a moment the
	 * parent can sequence against, and a join placed after an answer has to wait
	 * for the resumed Run rather than collect the Question it just answered.
	 *
	 * Does nothing to a Run that is not Waiting: callers check that first,
	 * because they are the ones who can say what state it is in instead.
	 */
	answered(name: string): void {
		const record = this.byName.get(name);
		if (record?.run.state !== "waiting") return;
		record.run.state = "running";
		record.run.question = undefined;
	}

	/**
	 * Put an answered Run back to Waiting on the Question it was answered about,
	 * for an answer that never reached its child.
	 *
	 * The inverse of `answered`, and not optional: a Run left running on a turn
	 * that never started is one every join waits on forever, and a Question the
	 * parent can no longer be told about is one it can never answer again.
	 */
	unanswered(name: string, question?: string): void {
		const record = this.byName.get(name);
		if (record?.run.state !== "running") return;
		record.run.state = "waiting";
		record.run.question = question;
	}

	/**
	 * Report that a Run stopped without finishing, and hand back the failed
	 * Delivery to route. Returns nothing for a Run that had already stopped, or
	 * one this Supervisor never registered.
	 *
	 * A failure is a Delivery like any other, deliberately: a Run that dies is
	 * reported down the same path as one that succeeds, because the parent has
	 * the same decision to make either way — what to do with what came back.
	 *
	 * A Run that has already delivered is left alone. Its child exiting
	 * afterwards is how a finished Run ends, not a failure to report.
	 */
	fail(name: string, failure: RunFailure): Delivery | undefined {
		const record = this.byName.get(name);
		if (!record || hasStopped(record.run.state)) return undefined;

		// A Question its child can no longer be asked about is spent, and a partial
		// message is not a result: a failed Run reports why it stopped, nothing else.
		record.asked = undefined;
		record.lastAssistant = undefined;
		record.run.question = undefined;
		record.run.state = "failed";
		record.run.failure = failure;
		record.said = false;
		// A Run that died frees its slot exactly like one that finished. Draining
		// on success alone would lose a slot to every crash until a session that
		// had seen four of them could start nothing at all.
		this.admitQueued();
		return deliveryFor(record.run);
	}

	/**
	 * Wait for every named Run to stop being in flight, then collect what each has
	 * to say — a Delivery for one that finished, its Question for one that is
	 * Waiting.
	 *
	 * Waiting counts as stopping, deliberately: only the parent can answer a
	 * Question, and a parent inside this call cannot, so a Waiting Run has to end
	 * the join rather than the two features deadlocking each other. It can be
	 * answered and joined again.
	 *
	 * Every name must be one this Supervisor registered; callers check that first,
	 * because they are the ones who can say what the valid names were.
	 *
	 * `signal` is the caller's turn. An aborted turn abandons the join rather
	 * than collecting into it: collecting marks the Runs said, and a result
	 * marked said inside a tool call nobody will read is a result the parent
	 * never sees. Abandoned, they deliver on their own instead.
	 */
	join(names: string[], signal?: AbortSignal): Promise<ParentMessage[]> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (names.every((name) => !this.isInFlight(name))) return Promise.resolve(this.collect(names));
		return new Promise((resolve, reject) => {
			// `abandon` closes over the join and the join closes over `abandon`, so
			// one of the two has to be filled in second.
			let abandon = () => {};
			const pending: PendingJoin = {
				names,
				resolve: (messages) => {
					signal?.removeEventListener("abort", abandon);
					resolve(messages);
				},
				reject,
			};
			if (signal) {
				abandon = () => {
					this.joins.delete(pending);
					reject(signal.reason);
				};
				signal.addEventListener("abort", abandon, { once: true });
			}
			this.joins.add(pending);
		});
	}

	/**
	 * End every Run that is still going, because the session that owns them is
	 * ending, and hand back the failed Deliveries to route.
	 *
	 * The other half of ADR-0001's reap: killing the children leaves the Runs
	 * looking alive, and a Run that is listed as running but whose child is gone
	 * is one every later join waits on forever.
	 *
	 * Joins in flight are ended rather than answered, for the reason `join`
	 * gives: the turn a join would return its Deliveries into is the turn that
	 * just went away.
	 *
	 * A queued Run ends here too, and is reported in the same words as one that
	 * was already working: it is a Run the session took on, and leaving it listed
	 * as waiting for a slot that will never come would be a Run nothing ever
	 * resolves.
	 */
	endAll(reason: string): Delivery[] {
		for (const pending of this.joins) pending.reject(new Error(`Waiting stopped: ${reason}.`));
		this.joins.clear();

		const deliveries: Delivery[] = [];
		// Every slot these Runs free is freed into a session that is going away, so
		// nothing is admitted while this runs. Restored afterwards rather than set
		// for good: an aborted turn ends every Run and the session carries on.
		this.ending = true;
		try {
			for (const name of this.byName.keys()) {
				const delivery = this.fail(name, { kind: "stopped", reason });
				if (delivery) deliveries.push(delivery);
			}
		} finally {
			this.ending = false;
		}
		return deliveries;
	}

	/**
	 * Post a settled Run's message, and say where it went: to a join that named
	 * that Run, or to the conversation.
	 *
	 * A joined message re-enters the conversation as that join's own result, so
	 * the caller must not auto-deliver it as well. Called right after `observe`,
	 * on the message it returned, because only the Supervisor knows what is being
	 * joined.
	 */
	post(message: SettledMessage): "join" | "conversation" {
		let joined = false;
		for (const pending of this.joins) {
			if (!pending.names.includes(message.run.name)) continue;
			joined = true;
			// Settling may have been the last thing this join was waiting for. The
			// messages are collected now, while the Runs still say what they said.
			if (pending.names.every((name) => !this.isInFlight(name))) {
				this.joins.delete(pending);
				pending.resolve(this.collect(pending.names));
			}
		}
		if (joined) return "join";
		// Only a Delivery is marked. A Question is still outstanding however often
		// it is said, and nothing that repeats it says it a second time.
		if (message.kind === "delivery") this.markSaid(message.run.name);
		return "conversation";
	}

	/**
	 * Mark a Run's Delivery as already re-entered into the parent conversation.
	 *
	 * Called for a Delivery this Supervisor routed there itself, and by the
	 * spawn-failure path, which returns its Delivery as the `subagent` call's own
	 * result — already the conversation a Delivery would have landed in. Either
	 * way it keeps a later join from repeating what the parent already holds.
	 */
	markSaid(name: string): void {
		const record = this.byName.get(name);
		if (record) record.said = true;
	}

	/**
	 * Whether a Run is still working, or still expected to, and so still worth a
	 * join's while.
	 *
	 * A queued Run counts while something is running: a join that passed over one
	 * would come back before the work it named had even started. It stops counting
	 * once every slot is held by a Waiting Run, for the reason `join` gives about
	 * Waiting itself — nothing left can free a slot except the parent answering,
	 * and a parent inside the join cannot. Waiting for it there is not patience,
	 * it is a deadlock.
	 */
	private isInFlight(name: string): boolean {
		const state = this.byName.get(name)?.run.state;
		if (state === "running") return true;
		return state === "queued" && this.list().some((run) => run.state === "running");
	}

	/** How many of the `RUN_SLOTS` are taken right now. */
	private slotsInUse(): number {
		return this.list().filter((run) => holdsSlot(run.state)).length;
	}

	/**
	 * Start every queued Run a free slot can now take, oldest request first.
	 *
	 * Called wherever a Run stops, which is the only thing that frees a slot —
	 * and from both terminal states, not just `done`, because a queue that
	 * drained on success alone would leak a slot on every crash until the session
	 * had none left.
	 *
	 * Order comes from the registry itself, which is insertion-ordered and so
	 * already in the order the Runs were asked for; there is no second list to
	 * keep in step with it. The admissions are handed over after the promotions,
	 * so `onAdmit` sees a Supervisor whose slots are already accounted for.
	 */
	private admitQueued(): void {
		if (this.ending) return;
		const admitted: Run[] = [];
		let used = this.slotsInUse();
		for (const record of this.byName.values()) {
			if (used >= RUN_SLOTS) break;
			if (record.run.state !== "queued") continue;
			record.run.state = "running";
			used++;
			admitted.push(record.run);
		}
		for (const run of admitted) this.onAdmit?.(run);
	}

	/**
	 * What each named Run has to say, right now — emptying its mailbox as it goes.
	 *
	 * A Run whose Delivery has already been said comes back saying so rather than
	 * saying its result twice: the half of the no-double-delivery rule that a
	 * pending join cannot cover on its own. It is a mark rather than a destructive
	 * drain, so a Run still has its result to hand for anything that asks.
	 *
	 * A Waiting Run is the exception, and comes back with its Question however
	 * often it is asked for: the Question is still outstanding, and a join that
	 * said a Run was Waiting without saying what on would leave the parent nothing
	 * to act on.
	 */
	private collect(names: string[]): ParentMessage[] {
		const messages: ParentMessage[] = [];
		for (const name of names) {
			const record = this.byName.get(name);
			if (!record) continue;
			if (!hasStopped(record.run.state)) {
				messages.push(messageFor(record.run));
				continue;
			}
			messages.push(record.said ? alreadySaid(record.run) : messageFor(record.run));
			record.said = true;
		}
		return messages;
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

/** One `subagent_wait` in flight: the Runs it named, and how to answer it. */
interface PendingJoin {
	names: string[];
	resolve: (messages: ParentMessage[]) => void;
	/** How to end it without an answer, when there is no longer one to give. */
	reject: (error: unknown) => void;
}

interface RunRecord {
	run: Run;
	/**
	 * The mailbox, as one bit: whether this Run's Delivery has already re-entered
	 * the parent conversation.
	 *
	 * Cleared every time the Run gets something new to say, and set by whoever
	 * says it — an auto-delivery, a join collecting it, or a caller that said it
	 * inline. A join that finds it set reports the Run without repeating its
	 * result, which is the half of the no-double-delivery rule a pending join
	 * cannot cover on its own.
	 *
	 * A Delivery only. A Question is outstanding until it is answered, so saying
	 * it again is not saying it twice.
	 */
	said: boolean;
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
 * The argument names a tool call is read as a subject through.
 *
 * pi's own file tools take a `path` and its two search tools take a `pattern`,
 * and both are short, single-valued and the thing the call is *about*. `bash`'s
 * `command` is deliberately not among them: it is arbitrary shell, routinely
 * longer and more line-broken than a status line can hold, and "bash" already
 * says as much as a clipped fragment of it would.
 */
const ACTIVITY_SUBJECTS: readonly string[] = ["path", "pattern"];

/**
 * What a child is doing, from the tool it just started: the tool's name, and
 * what it is working on when the call names something.
 *
 * `unknown` because this is the far side of a process boundary — the arguments
 * are whatever the child's model produced for whatever tools its Agent
 * allowlisted, so nothing here assumes a shape.
 */
function activityOf(toolName: string, args: unknown): string {
	const named = (args ?? {}) as Record<string, unknown>;
	for (const key of ACTIVITY_SUBJECTS) {
		const subject = named[key];
		if (typeof subject === "string" && subject.trim()) return `${toolName} ${subject.trim()}`;
	}
	return toolName;
}

/**
 * What a Run that has stopped being in flight has to say.
 *
 * The message is derived from the Run rather than stored when it settles, so a
 * join collects exactly what an auto-delivery would have said — one shape of
 * words for both halves of the Delivery policy.
 */
function messageFor(run: Run): ParentMessage {
	if (run.state === "queued") return { kind: "queued", run, text: queuedMessageText(run) };
	return settledFor(run);
}

/** What a Run that settled has to say — the only two things a Run says on its own. */
function settledFor(run: Run): SettledMessage {
	if (run.state === "waiting") return { kind: "question", run, text: questionMessageText(run) };
	return deliveryFor(run);
}

function deliveryFor(run: Run): Delivery {
	return { kind: "delivery", run, text: deliveryText(run) };
}

/**
 * A Delivery that has already landed, said again without saying it twice.
 *
 * Says where the Run got to and stops, rather than repeating a result the parent
 * is already holding: a join that names a Run whose Delivery has landed is
 * asking for something it already has, and the useful reply is to say so.
 */
function alreadySaid(run: Run): Delivery {
	const what = run.state === "failed" ? "failed. Why it failed" : "is done. Its result";
	return { kind: "delivery", run, text: `${runHeader(run)} ${what} was already delivered into this conversation, and is not repeated here.` };
}

/** How every message names the Run that is speaking. */
function runHeader(run: Run): string {
	return `Run \`${run.name}\` (agent \`${run.agent}\`)`;
}

/** Whether a Run has stopped for good, whichever way it stopped. */
function hasStopped(state: RunState): boolean {
	return state === "done" || state === "failed";
}

/**
 * Whether a Run is holding one of the `RUN_SLOTS`.
 *
 * A Waiting Run holds its slot, deliberately. Its child is up and idle with the
 * whole task in its context, and an answer resumes it that instant: releasing
 * the slot would mean either exceeding the cap the moment it is answered, or
 * making the parent's own answer queue behind work it started later. The cheaper
 * of the two mistakes is a slot held by a process that is only waiting to be
 * told something.
 */
function holdsSlot(state: RunState): boolean {
	return state === "running" || state === "waiting";
}

/**
 * The message body a Question arrives in.
 *
 * Named after the Run rather than the Agent's persona: the parent answers a Run,
 * and the Run's name is what addresses it.
 */
function questionMessageText(run: Run): string {
	const header = `${runHeader(run)} has a question and is waiting for an answer.`;
	return run.question ? `${header}\n\n${run.question}` : `${header}\n\nIt did not say what it wanted to know.`;
}

/**
 * The message body a still-queued Run comes back to a join in.
 *
 * Only ever said in the one case that produces it: every slot is held by a Run
 * waiting for an answer, so this Run cannot start until the parent answers one.
 * It says that, because the parent reading it is the only one who can act on it.
 */
function queuedMessageText(run: Run): string {
	return `${runHeader(run)} has not started yet: every run slot is held by a run that is waiting for an answer. Answer those and it starts on its own.`;
}

/**
 * The Delivery body.
 *
 * Deliberately thin: the result's shape is whatever the Agent's markdown asked
 * for, so this only says which Run is speaking and gets out of the way.
 */
function deliveryText(run: Run): string {
	if (run.state === "failed") return failureText(run);
	const header = `${runHeader(run)} is done.`;
	return run.result ? `${header}\n\n${run.result}` : `${header}\n\nIt finished without producing a result.`;
}

/**
 * The failed Delivery body.
 *
 * It hands over the child's own last words and then stops: whether to run the
 * task again or route around it is the parent agent's judgement, and nothing
 * here knows enough to make it. There is no retry and no timeout — the stderr
 * is the evidence the parent decides on.
 */
function failureText(run: Run): string {
	const header = `${runHeader(run)} failed: ${failureCause(run.failure)}. It produced no result.`;
	const guidance = "Decide whether to run the task again, run it differently, or carry on without it.";
	const stderr = run.failure?.kind === "exit" ? run.failure.stderr : undefined;
	return stderr ? `${header}\n\n${guidance}\n\nIts last stderr:\n\n${stderr}` : `${header}\n\n${guidance}`;
}

/** What stopped a Run, in the few words a Delivery header has room for. */
function failureCause(failure: RunFailure | undefined): string {
	if (!failure) return "it stopped without saying why";
	if (failure.kind === "spawn") return `it could not be started: ${failure.message}`;
	if (failure.kind === "stopped") return `it was stopped because ${failure.reason}`;
	if (failure.signal) return `its child was killed by ${failure.signal}`;
	// A clean exit still failed the Run — the child stopped without settling — but
	// blaming "code 0" reads like a fault where there was none. Say what happened.
	if (failure.exitCode === 0) return "its child exited before the run finished";
	if (failure.exitCode !== undefined) return `its child exited with code ${failure.exitCode}`;
	return "its child stopped without saying why";
}
