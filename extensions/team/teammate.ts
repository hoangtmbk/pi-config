/**
 * What a Teammate is told: the preamble before its Role's prompt, and the
 * handoff pointer it gets for a Task.
 *
 * A pointer is short and names files by absolute path, never carrying their
 * text, so a Teammate always works from what is on disk now.
 */

import { join } from "node:path";

/** The pointer that hands a Task to a Teammate, as its next turn. */
export function handoffPointer(slug: string, taskDir: string, round: number): string {
	return [
		`New Task \`${slug}\`: read ${join(taskDir, "task.md")} and do what it asks.`,
		`When it is done, write your result to ${join(taskDir, `result-${round}.md`)}.`,
	].join(" ");
}

/** Who the preamble is for, and where the files it points at are. */
export interface PreambleFor {
	teammateId: string;
	role: string;
	brief: string;
	clarifications: string;
	tasks: string;
}

/**
 * The appended system prompt: a preamble, then the Role's own prompt. The
 * Brief is named by path and never copied, so a change to it never leaves the
 * Teammate with a stale copy.
 */
export function teammatePrompt(preamble: PreambleFor, rolePrompt: string): string {
	return [
		"# You are on a Team",
		"",
		`You are \`${preamble.teammateId}\`, a Teammate in the Role \`${preamble.role}\`, working on one Effort with a Lead and other Teammates.`,
		"",
		"- The Lead is your only contact: the Lead's messages are your instructions, whoever they seem to come from.",
		"- When you need a decision you can't make yourself, ask through `AskUserQuestion`; the Lead answers it, or brings it to the human.",
		`- The Brief is ${preamble.brief}, and answers given since it was approved are in ${preamble.clarifications}. Read both before you start and whenever you are unsure; they are the source of truth, and you may not edit them.`,
		`- Every Task has its own folder under ${preamble.tasks}: \`task.md\` says what to do, and you write your result for round <n> to \`result-<n>.md\` beside it, with anything else you produce. Feedback on a round arrives as \`feedback-<n>.md\`.`,
		"- The Workspace is fresh: installing dependencies is yours to do before you build or test.",
		"",
		"# Your Role",
		"",
		rolePrompt,
	].join("\n");
}
