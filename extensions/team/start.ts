/**
 * Picking a Team for `/team start`: what the human is told, and what the Lead
 * is asked when the human names no Team. Pure, so it is tested by the Teams it
 * is handed.
 */

import { type ConfigError, type Playbook, quoteList, type Team } from "./definitions.ts";

/** What `/team start` says back, by how it lands in pi. */
export type StartOutcome =
	/** Show the human a toast. */
	| { kind: "notify"; level: "info" | "error"; text: string }
	/** Ask the Lead to propose a Team, starting a turn. */
	| { kind: "ask-lead"; text: string }
	/** Tell the human, then run Team setup first: the Team has no adopted Playbook to run on. */
	| { kind: "setup"; team: Team; text: string }
	/** Open an Effort on the Team and its adopted Playbook, and tell the human `text` with where it is. */
	| { kind: "intake"; team: Team; playbook: Playbook; text: string };

function problemLines(problems: readonly ConfigError[]): string {
	return problems.map((problem) => `- ${problem.filePath}: ${problem.reason}`).join("\n");
}

/** "Teams: …" for an error that must say which Teams would have worked. */
export function availableTeams(teams: readonly Team[]): string {
	return teams.length > 0 ? `Teams: ${quoteList(teams.map((team) => team.name))}.` : "There are no Teams.";
}

/**
 * The named Team, or why it can't be used: it doesn't exist, or a file of it
 * has a config error that `excused` doesn't let through.
 */
export function findTeam(
	teams: readonly Team[],
	name: string,
	action: string,
	excused: (problem: ConfigError) => boolean = () => false,
): { team: Team } | { error: string } {
	const team = teams.find((candidate) => candidate.name === name);
	if (!team) return { error: `Unknown Team \`${name}\`. ${availableTeams(teams)}` };
	const problems = team.problems.filter((problem) => !excused(problem));
	if (problems.length > 0) return { error: `Team \`${name}\` can't ${action} until its config errors are fixed:\n${problemLines(problems)}` };
	return { team };
}

/**
 * `/team start <name>`: the named Team, if it exists and every file of it is
 * right, goes on to intake on its adopted Playbook. A Team with no adopted
 * Playbook goes through Team setup first, and so does one whose adopted
 * Playbook was edited by hand, since that edit was never agreed. A broken
 * adoption record is a config error like any other here.
 */
export function pickTeam(teams: readonly Team[], name: string): StartOutcome {
	const found = findTeam(teams, name, "start");
	if ("error" in found) return { kind: "notify", level: "error", text: found.error };
	const { team } = found;
	const then = "Agree it with the Lead and adopt it from `/team pending`; the Team starts once it is adopted.";
	switch (team.adoption.state) {
		case "not-adopted":
			return { kind: "setup", team, text: `Team \`${name}\` has no adopted Playbook, so Team setup runs first. ${then}` };
		case "edited":
			return {
				kind: "setup",
				team,
				text: `Team \`${name}\`'s Playbook ${team.adoption.filePath} was edited after it was adopted, so Team setup runs first. ${then}`,
			};
		case "adopted": {
			const roles = quoteList(team.roles.map((role) => role.name));
			const playbook = `adopted ${team.adoption.adoptedAt} (${team.adoption.playbook.filePath}).`;
			return { kind: "intake", team, playbook: team.adoption.playbook, text: `Team \`${name}\` picked: Roles ${roles}. Playbook: ${playbook}` };
		}
	}
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
