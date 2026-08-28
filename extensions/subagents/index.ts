/**
 * subagents — hand a task to an Agent and keep working.
 *
 * `subagent` spawns a Run in a child pi process and returns its name straight
 * away; when the Run settles, its result is delivered back into this
 * conversation on its own — unless a `subagent_wait` named that Run, in which
 * case the join collects it and it is not said twice (ADR-0002). The `subagent`
 * tool's description carries the whole roster, so choosing an Agent costs no
 * round trip.
 *
 * This file is wiring and nothing else. The lifecycle lives in `supervisor.ts`,
 * which is pure; the subprocess lives in `child.ts`, which is the only thing
 * that knows a process exists.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Agent, discoverAgents, type Roster } from "./agents.ts";
import { type RunChild, RUN_NAME_ENV, type SpawnOptions, spawnRun } from "./child.ts";
import { ASK_QUESTION_TOOL, type QuestionDetails, type Run, RUN_SLOTS, type RunState, type SettledMessage, Supervisor } from "./supervisor.ts";

const SubagentParams = Type.Object({
	agent: Type.String({ description: "Which agent to run — one of the names listed in this tool's description." }),
	task: Type.String({
		description:
			"The whole task, self-contained. The run starts from an empty context and cannot see this conversation, so state the goal, the relevant paths and what a finished answer looks like.",
	}),
	name: Type.Optional(
		Type.String({
			description: "Name this run instead of naming it after its agent. Collisions are auto-suffixed either way.",
		}),
	),
	model: Type.Optional(Type.String({ description: "Override the model the agent asked for." })),
});

const SubagentAnswerParams = Type.Object({
	name: Type.String({ description: "The run to answer — the name it was announced with when it asked." }),
	answer: Type.String({
		description:
			"The answer, in full. It arrives as the run's next prompt, so restate anything from this conversation the run needs; it still cannot see this conversation.",
	}),
});

const SubagentWaitParams = Type.Object({
	names: Type.Optional(
		Type.Array(Type.String(), {
			description: "The runs to wait for, by name. Omit to wait for every run that has not finished.",
		}),
	),
});

const AskQuestionParams = Type.Object({
	question: Type.String({
		description:
			"What you need to know, in full. Whoever answers cannot see your session, so include the context that makes the question answerable and say what you would do with each likely answer.",
	}),
});

/**
 * How long the reap waits for its children to go before letting the session
 * finish shutting down.
 *
 * `RunChild.stop` is already bounded — a SIGTERM, then a SIGKILL for anything
 * still standing after the grace period — so this covers the one part of the
 * reap that is not: a child still being spawned, whose first prompt a wedged pi
 * might never answer. Comfortably longer than that SIGTERM grace, so a child
 * that is going to go has gone, and short enough that quitting pi is never
 * something to sit and wait through.
 */
const REAP_GRACE_MS = 2000;

/** Metadata for the transcript — the Run's identity, not its result. */
interface SubagentDetails {
	run: string;
	agent: string;
	task: string;
}

/** Metadata for the transcript — which Runs a join collected, and how each stopped. */
interface SubagentWaitDetails {
	runs: { run: string; agent: string; state: RunState }[];
}

/**
 * Why a name cannot be addressed, said with the Runs that could have been.
 *
 * The states come along because they are the difference between a name the
 * caller mistyped and one it addressed too late: listing bare names would make a
 * Run that has already delivered look like a Run still waiting to be answered.
 */
function unknownRun(name: string, runs: Run[]): Error {
	const known = runs.map((candidate) => `\`${candidate.name}\` (${candidate.state})`).join(", ");
	return new Error(`Unknown run \`${name}\`. ${known ? `Runs in this session: ${known}.` : "No runs have been started in this session."}`);
}

/** Why a name cannot be answered: the wrong state, or no such Run at all. */
function unanswerableRun(name: string, run: Run | undefined, runs: Run[]): Error {
	if (run) return new Error(`Run \`${name}\` is ${run.state}, not waiting for an answer. Only a waiting run can be answered.`);
	return unknownRun(name, runs);
}

/** What went wrong, from whatever a failed spawn threw. */
function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A deadline, as a promise.
 *
 * Unreferenced, so that waiting on one is never itself the reason a process
 * that has nothing left to do stays up.
 */
function deadline(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

export interface SubagentsOptions {
	/** Defaults to discovery. Injected by tests, and by nothing else. */
	roster?: Roster;
	/** Defaults to spawning a real child. Injected by tests, and by nothing else. */
	spawn?: (options: SpawnOptions) => Promise<RunChild>;
	/**
	 * The Run this session is, when it is itself one. Defaults to what the parent
	 * put in the environment. Injected by tests, and by nothing else.
	 */
	runName?: string;
}

/**
 * The tool description, built once at registration time.
 *
 * The roster is baked in rather than fetched: an agent list the model has to ask
 * for is a round trip before every delegation, and the set cannot change within
 * a session anyway.
 */
function describeRoster(roster: Roster): string {
	const lines = [
		"Delegate a task to a subagent and keep working. Returns the run's name immediately — the run works in its own process, and its result is delivered into this conversation when it finishes, so do not poll for it.",
		"If you have nothing to do until it comes back, wait for it with subagent_wait rather than polling.",
		"A run starts from an empty context: it sees only the task you write, never this conversation.",
		`Fan out as wide as the work needs: at most ${RUN_SLOTS} runs work at once and the rest queue, starting in the order you asked for them as slots free.`,
	];

	if (roster.agents.length === 0) {
		lines.push("There are no agents installed, so this tool cannot run anything until one is added.");
	} else {
		lines.push("Available agents:");
		for (const agent of roster.agents) lines.push(`- ${agent.name}: ${agent.description}`);
	}

	return lines.join("\n");
}

function unknownAgent(name: string, roster: Roster): Error {
	const known = roster.agents.map((agent) => `\`${agent.name}\``).join(", ") || "none";
	return new Error(`Unknown agent \`${name}\`. Available agents: ${known}.`);
}

/**
 * The child half of the extension: the one tool a Run has that its Agent's
 * allowlist did not ask for.
 *
 * It answers nothing itself. All it does is put the Question where the parent's
 * Supervisor will see it — in a tool result, on a `tool_execution_end` event —
 * and hand the turn back, so the child stops without blocking on anyone.
 */
function registerAskQuestion(pi: ExtensionAPI): void {
	pi.registerTool({
		name: ASK_QUESTION_TOOL,
		label: "Ask question",
		description: [
			"Ask the session that delegated this task a question, when the task is ambiguous enough that guessing would waste the work.",
			"Returns immediately and does not wait for an answer: say everything you need to say, then end your turn. The answer arrives as your next prompt, and you carry on from there.",
			"Use it for decisions only the delegating session can make, not for anything you could find out yourself.",
		].join(" "),
		promptSnippet: "Ask the delegating session a question when the task is genuinely ambiguous",
		parameters: AskQuestionParams,

		async execute(_toolCallId, params) {
			const question = params.question.trim();
			// A Question nobody can read would still stop the Run, so refuse it here
			// and let the turn carry on: a failed execution never reaches the parent.
			if (!question) throw new Error("A question cannot be empty. Say what you need to know.");

			const details: QuestionDetails = { question };
			return {
				content: [
					{
						type: "text",
						text: "Your question is on its way to the session that delegated this task. End your turn now; the answer will arrive as your next prompt.",
					},
				],
				details,
			};
		},
	});
}

export function registerSubagents(pi: ExtensionAPI, options: SubagentsOptions = {}): void {
	// A Run loads this same extension, and the two halves are disjoint: a child
	// can ask and cannot delegate, a parent can delegate and has nothing to ask.
	const runName = options.runName ?? process.env[RUN_NAME_ENV];
	if (runName) {
		registerAskQuestion(pi);
		return;
	}

	const roster = options.roster ?? discoverAgents();
	const spawn = options.spawn ?? spawnRun;
	/**
	 * Every Run's child, from the moment it starts being spawned.
	 *
	 * The promise rather than the child, because a Run is at its most orphanable
	 * while it is starting: the process exists before `spawn` resolves, and a
	 * session that ends in that window would otherwise have nothing to stop yet.
	 * The entry goes in when the spawn starts and is swapped for the child itself
	 * the moment `onStarted` says there is a process to signal, so a reap that
	 * lands anywhere in that window has something to take it out on.
	 */
	const children = new Map<string, Promise<RunChild>>();

	/**
	 * Put what a Run has to say into the parent conversation.
	 *
	 * `options` is the one thing that differs between the two callers, and it is
	 * the whole difference between the two: a settled Run's message wakes the
	 * parent, and an ended Run's waits for it.
	 */
	function say(message: SettledMessage, options: { triggerTurn: boolean; deliverAs?: "steer" }): void {
		const details: SubagentDetails = { run: message.run.name, agent: message.run.agent, task: message.run.task };
		pi.sendMessage(
			{
				customType: message.kind === "question" ? "subagent-question" : "subagent-delivery",
				content: message.text,
				display: true,
				details,
			},
			options,
		);
	}

	/**
	 * Stop a Run's child and forget it, resolving once it has gone.
	 *
	 * Never rejects, and callers that have nothing to wait for do not have to:
	 * a child that is already dead is no worse off for being asked to stop, and
	 * a spawn that threw has nothing to stop.
	 */
	function reap(name: string): Promise<void> {
		const spawning = children.get(name);
		children.delete(name);
		return spawning?.then((child) => child.stop()).catch(() => {}) ?? Promise.resolve();
	}

	/**
	 * Say what a settled Run has to say, and clean up after it once it has
	 * stopped for good.
	 *
	 * The same path for a Delivery, a Question and a failure, deliberately: a Run
	 * that dies is reported exactly like one that succeeds, so nothing downstream
	 * has to know which of the two happened to handle it.
	 */
	function announce(message: SettledMessage): void {
		// A `subagent_wait` that named this Run collects the message instead, and
		// returns it as its own result. Saying it here as well would say it twice,
		// which is the whole of the no-double-delivery rule.
		// Both halves of ADR-0002's Delivery policy in one call, because which one
		// happens is pi's decision, not this file's: an idle parent is woken, and a
		// streaming one takes it as a steer, which pi lands at a turn boundary
		// rather than mid-tool-call.
		if (supervisor.post(message) === "conversation") say(message, { triggerTurn: true, deliverAs: "steer" });

		// A Waiting Run keeps its child: the process stays up, doing nothing but
		// holding the context an answer lands in. Nothing is killed or reaped.
		if (message.kind === "question") return;

		// A stopped Run has nothing left to say, and the child left behind is a pi
		// process nothing will ever prompt again.
		//
		// The Supervisor handed this Run's slot on the moment it stopped, so for as
		// long as this reap takes there can be one more child alive than there are
		// slots. Deliberate: the extra one has settled and is issuing no requests,
		// which is the only thing the cap is protecting.
		void reap(message.run.name);
	}

	/**
	 * Spawn a Run's child and wire it to the Supervisor.
	 *
	 * Rejects with whatever the spawn threw, having left the Run itself untouched:
	 * the two callers report a Run that could not start in different places — a
	 * `subagent` call returns it, and an admission from the queue delivers it,
	 * because by then the call that asked for it is long gone.
	 */
	async function startRun(run: Run, agent: Agent, model?: string): Promise<void> {
		// Recorded before it is awaited, not after: a Run that settles or is reaped
		// while its child is still starting has to have something to reach the child
		// by, and the promise is the only thing that exists yet.
		const spawning = spawn({
			agent,
			name: run.name,
			task: run.task,
			model,
			onStarted(child) {
				// From here the reap has something to kill without waiting for the
				// whole spawn — which a child that never takes its first prompt would
				// never finish, leaving a live process nothing could reach. A Run
				// already reaped inside that window has no entry left to replace, and
				// its child is stopped on arrival instead.
				if (children.has(run.name)) children.set(run.name, Promise.resolve(child));
				else void child.stop().catch(() => {});
			},
			onEvent(event) {
				const message = supervisor.observe(run.name, event);
				if (message) announce(message);
			},
			onExit(exit) {
				// A child that outlives its Run's Delivery is a Run ending rather than
				// a Run failing, and the Supervisor says which by returning nothing.
				const message = supervisor.fail(run.name, { kind: "exit", ...exit });
				if (message) announce(message);
			},
		});
		children.set(run.name, spawning);

		try {
			await spawning;
		} catch (error) {
			children.delete(run.name);
			throw error;
		}
	}

	/**
	 * How to start each Run that is waiting for a slot, by name.
	 *
	 * The Supervisor owns the queue itself — who goes next, and when a slot frees
	 * — and this owns the one thing it has no business knowing: what the
	 * `subagent` call that queued the Run asked for, which is the Agent it named
	 * and the model it overrode. That call is long gone by the time the Run runs.
	 */
	const starters = new Map<string, () => Promise<void>>();

	const supervisor = new Supervisor({
		onAdmit(run) {
			const start = starters.get(run.name);
			starters.delete(run.name);
			// A Run admitted with nothing to start it would sit there running with no
			// child to ever end it, and every join would wait on it forever. It
			// cannot happen; if it does, it fails like any other Run that never
			// started rather than quietly holding a slot.
			const starting = start?.() ?? Promise.reject(new Error("its slot came free but nothing was left to start it with"));
			void starting.catch((error) => {
				// Delivered rather than returned: the `subagent` call that queued this
				// Run answered long ago, so there is nothing left to return it into.
				const failure = supervisor.fail(run.name, { kind: "spawn", message: describeError(error) });
				if (failure) announce(failure);
			});
		},
	});

	/**
	 * End every Run with the session that owns them — ADR-0001's reap.
	 *
	 * Every child is SIGTERMed whatever state its Run is in, Waiting and
	 * still-starting included, because an orphaned pi burns tokens invisibly with
	 * no session left to report to. The whole thing is bounded: `RunChild.stop`
	 * SIGKILLs a child that ignores the SIGTERM, and `REAP_GRACE_MS` bounds the
	 * one case `stop` cannot reach yet.
	 *
	 * Every shutdown reason, deliberately. `/reload` and a session switch both
	 * build a fresh Supervisor with no children in it, so a child left running
	 * through one is a child nothing can ever reach again.
	 */
	async function endEveryRun(reason: string): Promise<void> {
		// Started first and awaited last, so that nothing between here and there —
		// a `sendMessage` into a session already half torn down, say — can be what
		// stops the children being killed.
		const reaping = [...children.keys()].map(reap);
		// A queued Run has no child to reap — it is ended by the Supervisor failing
		// it like any other — so forgetting how to start it is the whole of what
		// keeps one from coming up after the session that asked for it has gone.
		starters.clear();
		for (const delivery of supervisor.endAll(reason)) {
			// Into the conversation, and deliberately without waking it — the one
			// place this departs from ADR-0002's Delivery policy, which wakes an idle
			// parent. The parent asked for all of this to stop, and starting a turn to
			// report that it stopped would be the opposite of what it asked for. It is
			// on the record for whenever the parent next takes a turn.
			supervisor.markSaid(delivery.run.name);
			say(delivery, { triggerTurn: false });
		}
		// Waited for, so pi does not exit before the signals are even sent — and
		// only up to the deadline, so that the last case with nothing to signal
		// yet, a spawn whose process has not come up, cannot hold the session open.
		// That one stops itself on arrival instead.
		await Promise.race([Promise.all(reaping), deadline(REAP_GRACE_MS)]);
	}

	// Awaited by pi, so the children are gone before the session is.
	pi.on("session_shutdown", () => endEveryRun("the session is shutting down"));

	// The turn's own AbortSignal is the whole of what says a parent abort
	// happened — pi has no abort event — so each turn is watched as it starts.
	// Reaping twice is harmless: the second finds nothing left to end.
	//
	// It is the agent's signal rather than the user's finger, and pi aborts the
	// agent for its own reasons too: a `/compact` issued mid-stream reaps, and a
	// session being replaced reaps under this reason rather than its own, because
	// pi aborts just before it emits `session_shutdown`. The second is only a
	// wording difference. The first is a real one, and there is nothing in pi's
	// extension API that tells the two aborts apart.
	pi.on("agent_start", (_event, ctx) => {
		ctx.signal?.addEventListener(
			"abort",
			// Nobody is awaiting this one, so its rejection would be an unhandled
			// one — and taking the session down over a reap would be worse than the
			// orphan it was trying to prevent.
			() => void endEveryRun("the parent turn was aborted").catch(() => {}),
			{ once: true },
		);
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: describeRoster(roster),
		promptSnippet: "Delegate a task to a subagent that works in its own process",
		parameters: SubagentParams,

		async execute(_toolCallId, params) {
			const agent: Agent | undefined = roster.agents.find((candidate) => candidate.name === params.agent);
			if (!agent) throw unknownAgent(params.agent, roster);

			const run = supervisor.register(agent.name, params.task, params.name);
			const details: SubagentDetails = { run: run.name, agent: agent.name, task: params.task };

			// Every slot is taken, so this Run starts when one frees. The name still
			// comes back now: a fan-out past the cap is a wait, not a refusal, and
			// nothing about how the parent addresses this Run depends on when its
			// child comes up.
			if (run.state === "queued") {
				starters.set(run.name, () => startRun(run, agent, params.model));
				return {
					content: [
						{
							type: "text",
							text: `Queued run \`${run.name}\` (agent \`${agent.name}\`). At most ${RUN_SLOTS} runs work at once, so it starts as soon as a slot frees; its result will arrive in this conversation on its own.`,
						},
					],
					details,
				};
			}

			// Awaited because spawning is the part that can fail in the caller's
			// face; the Run itself is not waited on — that is the whole point.
			try {
				await startRun(run, agent, params.model);
			} catch (error) {
				// A Run that never started is still a Run. Throwing here would lose it
				// mid-registration: its name would address something the session could
				// neither wait for nor account for. Failing it instead leaves it listed,
				// out of the active set, and reported in the same words a Run that died
				// later would be.
				const failure = supervisor.fail(run.name, { kind: "spawn", message: describeError(error) });
				// Said here rather than delivered, because this tool call is already
				// returning into the conversation the Delivery would have landed in.
				// Marked said for the same reason: a later join naming this Run reports
				// it without repeating a failure the parent already has.
				supervisor.markSaid(run.name);
				// `fail` returns nothing for a Run that had already stopped — a Run
				// reaped while it was starting, whose Delivery has already been said.
				// Naming it is still worth doing: without that this returns a bare RPC
				// error that says nothing about which Run it was about.
				const stopped = `Run \`${run.name}\` (agent \`${agent.name}\`) did not start: ${describeError(error)}`;
				return { content: [{ type: "text", text: failure?.text ?? stopped }], details };
			}

			return {
				content: [
					{
						type: "text",
						text: `Started run \`${run.name}\` (agent \`${agent.name}\`). Keep working; its result will arrive in this conversation on its own.`,
					},
				],
				details,
			};
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Wait for subagents",
		description: [
			"Wait for runs to finish and collect their results here, rather than letting them arrive in this conversation on their own.",
			"Waits until every run you name — or every run that has not finished, if you name none — is done or waiting on a question, then returns what each has to say.",
			"A run that is waiting comes back with its question: answer it with subagent_answer and wait again.",
			"Nothing is said twice: a result collected here is not also delivered on its own, and a run whose result already arrived on its own comes back saying so rather than repeating it.",
			"Use it when you have nothing to do until the runs come back; otherwise keep working and let their results arrive.",
		].join(" "),
		promptSnippet: "Wait for subagent runs to come back and collect their results",
		parameters: SubagentWaitParams,

		async execute(_toolCallId, params, signal) {
			// Deduped, because a name given twice is one Run, and collecting it twice
			// would report the same result twice inside a single join. Nothing is
			// filtered out: a blank name is rejected below rather than quietly
			// turning a named join into a join on everything.
			const named = [...new Set((params.names ?? []).map((name) => name.trim()))];
			// Checked here rather than in the Supervisor, because this is the side
			// that can say which names would have worked.
			for (const name of named) if (!supervisor.get(name)) throw unknownRun(name, supervisor.list());

			// Joining on nothing settles at once with nothing, which is the honest
			// answer to a session with no Runs left to wait for. The turn goes along
			// so that an aborted one ends the join rather than stranding it holding
			// results nobody will read.
			const collected = await supervisor.join(named.length > 0 ? named : supervisor.active().map((run) => run.name), signal);

			const details: SubagentWaitDetails = {
				runs: collected.map((message) => ({ run: message.run.name, agent: message.run.agent, state: message.run.state })),
			};
			const text = collected.map((message) => message.text).join("\n\n");
			return {
				content: [{ type: "text", text: text || "No runs are active, so there is nothing to wait for." }],
				details,
			};
		},
	});

	pi.registerTool({
		name: "subagent_answer",
		label: "Answer subagent",
		description: [
			"Answer a run that asked a question and is waiting for an answer.",
			"The answer starts a fresh turn in that run: it carries on from there and its result is delivered into this conversation on its own, exactly as it would have been without the question.",
			"Only a run that is waiting can be answered.",
		].join(" "),
		promptSnippet: "Answer a subagent run that is waiting on a question",
		parameters: SubagentAnswerParams,

		async execute(_toolCallId, params) {
			const name = params.name.trim();
			const run = supervisor.get(name);
			if (!run || run.state !== "waiting") throw unanswerableRun(name, run, supervisor.list());

			const answer = params.answer.trim();
			// An answer saying nothing would start a turn anyway and let the Run
			// settle on a guess. Refusing leaves it waiting, and still answerable.
			if (!answer) throw new Error(`An answer cannot be empty. Say what run \`${name}\` needs to know.`);

			// A waiting Run's child is deliberately still up, so this is a guard
			// against a lifecycle bug rather than something a caller can provoke.
			const spawning = children.get(name);
			if (!spawning) throw new Error(`Run \`${name}\` is waiting, but its child is gone, so the answer cannot be delivered.`);

			// The Run leaves Waiting here rather than when its child gets round to
			// starting a turn: this is the moment the caller can sequence against, so
			// a `subagent_wait` issued straight after an answer waits for the resumed
			// Run instead of collecting the Question it just answered. It also closes
			// the window a second answer would have been accepted in.
			const question = run.question;
			supervisor.answered(name);
			try {
				// A Run cannot be Waiting before its spawn resolved, so this is already
				// settled; awaiting it is how the child is reached, not a wait.
				await (await spawning).prompt(answer);
			} catch (error) {
				// The answer never reached the child, so the Run is waiting on the same
				// Question it was. Leaving it running would strand it: no turn was
				// started to end it, and every join would wait on it forever.
				supervisor.unanswered(name, question);
				throw error;
			}

			const details: SubagentDetails = { run: run.name, agent: run.agent, task: run.task };
			return {
				content: [
					{
						type: "text",
						text: `Answered run \`${run.name}\` (agent \`${run.agent}\`). It has resumed; its result will arrive in this conversation on its own.`,
					},
				],
				details,
			};
		},
	});
}

export default function (pi: ExtensionAPI) {
	registerSubagents(pi);
}
