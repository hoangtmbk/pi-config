/**
 * subagents — hand a task to an Agent and keep working.
 *
 * `subagent` spawns a Run in a child pi process and returns its name straight
 * away; when the Run settles, its result is delivered back into this
 * conversation on its own (ADR-0002). The tool's description carries the whole
 * roster, so choosing an Agent costs no round trip.
 *
 * This file is wiring and nothing else. The lifecycle lives in `supervisor.ts`,
 * which is pure; the subprocess lives in `child.ts`, which is the only thing
 * that knows a process exists.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Agent, discoverAgents, type Roster } from "./agents.ts";
import { type RunChild, RUN_NAME_ENV, type SpawnOptions, spawnRun } from "./child.ts";
import { ASK_QUESTION_TOOL, type QuestionDetails, Supervisor } from "./supervisor.ts";

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

const AskQuestionParams = Type.Object({
	question: Type.String({
		description:
			"What you need to know, in full. Whoever answers cannot see your session, so include the context that makes the question answerable and say what you would do with each likely answer.",
	}),
});

/** Metadata for the transcript — the Run's identity, not its result. */
interface SubagentDetails {
	run: string;
	agent: string;
	task: string;
}

/**
 * Why a name cannot be answered, said with the Runs that could have been.
 *
 * The states come along because they are the difference between a name the
 * caller mistyped and one it addressed too late: listing bare names would make a
 * Run that has already delivered look like a Run still waiting to be answered.
 */
function unanswerableRun(name: string, supervisor: Supervisor): Error {
	const run = supervisor.get(name);
	if (run) return new Error(`Run \`${name}\` is ${run.state}, not waiting for an answer. Only a waiting run can be answered.`);

	const runs = supervisor.list();
	const known = runs.map((candidate) => `\`${candidate.name}\` (${candidate.state})`).join(", ");
	return new Error(`Unknown run \`${name}\`. ${known ? `Runs in this session: ${known}.` : "No runs have been started in this session."}`);
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
		"A run starts from an empty context: it sees only the task you write, never this conversation.",
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
	const supervisor = new Supervisor();
	const children = new Map<string, RunChild>();

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

			// Awaited because spawning is the part that can fail in the caller's
			// face; the Run itself is not waited on — that is the whole point.
			const child = await spawn({
				agent,
				name: run.name,
				task: params.task,
				model: params.model,
				onEvent(event) {
					const message = supervisor.observe(run.name, event);
					if (!message) return;

					pi.sendMessage(
						{
							customType: message.kind === "question" ? "subagent-question" : "subagent-delivery",
							content: message.text,
							display: true,
							details: { run: message.run.name, agent: message.run.agent, task: message.run.task },
						},
						// The parent may well be idle, and a result nobody reads is a
						// wasted run — as is a question nobody answers. Landing either
						// while the parent is streaming is 05's job.
						{ triggerTurn: true },
					);

					// A Waiting Run keeps its child: the process stays up, doing nothing but
					// holding the context an answer lands in. Nothing is killed or reaped.
					if (message.kind === "question") return;

					// A done Run has nothing left to say, and an idle pi child is a
					// process burning nothing but still holding a slot. Reaping a child
					// that never settles — SIGTERM on parent abort and on
					// `session_shutdown`, per ADR-0001 — is 07's job.
					const finished = children.get(message.run.name);
					children.delete(message.run.name);
					// Nothing is waiting on this: the Delivery has already landed, and a
					// child that dies before it can be asked to is no worse off.
					finished?.stop().catch(() => {});
				},
			});
			children.set(run.name, child);

			const details: SubagentDetails = { run: run.name, agent: agent.name, task: params.task };
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
			if (!run || run.state !== "waiting") throw unanswerableRun(name, supervisor);

			const answer = params.answer.trim();
			// An answer saying nothing would start a turn anyway and let the Run
			// settle on a guess. Refusing leaves it waiting, and still answerable.
			if (!answer) throw new Error(`An answer cannot be empty. Say what run \`${name}\` needs to know.`);

			// A waiting Run's child is deliberately still up, so this is a guard
			// against a lifecycle bug rather than something a caller can provoke.
			const child = children.get(name);
			if (!child) throw new Error(`Run \`${name}\` is waiting, but its child is gone, so the answer cannot be delivered.`);

			// The Run leaves waiting when its child starts the turn this prompt
			// begins, which the Supervisor hears as `agent_start`. Nothing here
			// touches the lifecycle.
			await child.prompt(answer);

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
