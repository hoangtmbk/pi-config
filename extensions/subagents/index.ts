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
import { type RunChild, type SpawnOptions, spawnRun } from "./child.ts";
import { Supervisor } from "./supervisor.ts";

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

/** Metadata for the transcript — the Run's identity, not its result. */
interface SubagentDetails {
	run: string;
	agent: string;
	task: string;
}

export interface SubagentsOptions {
	/** Defaults to discovery. Injected by tests, and by nothing else. */
	roster?: Roster;
	/** Defaults to spawning a real child. Injected by tests, and by nothing else. */
	spawn?: (options: SpawnOptions) => Promise<RunChild>;
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

export function registerSubagents(pi: ExtensionAPI, options: SubagentsOptions = {}): void {
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
					const delivery = supervisor.observe(run.name, event);
					if (!delivery) return;

					pi.sendMessage(
						{
							customType: "subagent-delivery",
							content: delivery.text,
							display: true,
							details: { run: delivery.run.name, agent: delivery.run.agent, task: delivery.run.task },
						},
						// The parent may well be idle, and a result nobody reads is a
						// wasted run. Landing it while the parent is streaming is 05's job.
						{ triggerTurn: true },
					);

					// A done Run has nothing left to say, and an idle pi child is a
					// process burning nothing but still holding a slot. Reaping a child
					// that never settles — SIGTERM on parent abort and on
					// `session_shutdown`, per ADR-0001 — is 07's job.
					const finished = children.get(delivery.run.name);
					children.delete(delivery.run.name);
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
}

export default function (pi: ExtensionAPI) {
	registerSubagents(pi);
}
