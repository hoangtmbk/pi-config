/**
 * Picking a Team for `/team start`: what the human is told, and what the Lead
 * is asked when the human names no Team. Pure, so it is tested by the Teams it
 * is handed.
 */

import type { ConfigError, Team } from "./definitions.ts";

/** What `/team start` says back, by how it lands in pi. */
export type StartOutcome =
	/** Show the human a toast. */
	| { kind: "notify"; level: "info" | "error"; text: string }
	/** Ask the Lead to propose a Team, starting a turn. */
	| { kind: "ask-lead"; text: string };

function names(teams: readonly Team[]): string {
	return teams.map((team) => `\`${team.name}\``).join(", ");
}

function problemLines(problems: readonly ConfigError[]): string {
	return problems.map((problem) => `- ${problem.filePath}: ${problem.reason}`).join("\n");
}

function adoptionText(team: Team): string {
	switch (team.adoption.state) {
		case "adopted":
			return `adopted ${team.adoption.adoptedAt} (${team.adoption.playbook.filePath}).`;
		case "edited":
			return `${team.adoption.filePath} was edited after it was adopted, so it counts as not adopted until it is adopted again.`;
		case "not-adopted":
			return team.defaultPlaybook
				? "not adopted yet, so the Team's default Playbook is what setup would start from."
				: "not adopted yet, and the Team ships no default Playbook.";
	}
}

/** `/team start <name>`: the named Team, if it exists and every file of it is right. */
export function pickTeam(teams: readonly Team[], name: string): StartOutcome {
	const team = teams.find((candidate) => candidate.name === name);
	if (!team) {
		const available = teams.length > 0 ? `Teams: ${names(teams)}.` : "There are no Teams.";
		return { kind: "notify", level: "error", text: `Unknown Team \`${name}\`. ${available}` };
	}
	if (team.problems.length > 0) {
		return { kind: "notify", level: "error", text: `Team \`${name}\` can't start until its config errors are fixed:\n${problemLines(team.problems)}` };
	}
	const roles = team.roles.map((role) => `\`${role.name}\``).join(", ");
	return { kind: "notify", level: "info", text: `Team \`${name}\` picked: Roles ${roles}. Playbook: ${adoptionText(team)}` };
}

/**
 * `/team start` with no name: the Lead reads each Team's description and
 * proposes one, and the human starts it by name. Teams that can't start are
 * listed apart, with why, so the Lead can say so rather than propose one.
 */
export function proposeTeam(teams: readonly Team[]): StartOutcome {
	const ready = teams.filter((team) => team.problems.length === 0);
	const refused = teams.filter((team) => team.problems.length > 0);
	if (ready.length === 0) {
		const detail = refused.length > 0 ? `:\n${problemLines(refused.flatMap((team) => team.problems))}` : ": there are no Teams.";
		return { kind: "notify", level: "error", text: `No Team can start until its config errors are fixed${detail}` };
	}

	const lines = [
		"The human ran `/team start` without naming a Team. From what they want done, and from each Team's description below, propose the one Team that fits and say why in a sentence or two. If the work they want is not yet clear, ask them first. Once they agree, they start it with `/team start <team>`; you can't start it for them.",
		"",
		"Teams:",
		...ready.map((team) => `- \`${team.name}\`: ${team.description}`),
	];
	if (refused.length > 0) {
		lines.push(
			"",
			"Teams that can't start until their config errors are fixed:",
			...refused.map((team) => `- \`${team.name}\`: ${team.problems.map((problem) => `${problem.filePath}: ${problem.reason}`).join("; ")}`),
		);
	}
	return { kind: "ask-lead", text: lines.join("\n") };
}
