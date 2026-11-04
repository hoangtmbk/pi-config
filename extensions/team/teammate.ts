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

/**
 * The pointer that sends round `round` of a Task back: it names the feedback
 * file and the next round's result, and carries neither text.
 */
export function sendBackPointer(slug: string, taskDir: string, round: number): string {
	return [
		`Round ${round} of Task \`${slug}\` was sent back: read ${join(taskDir, `feedback-${round}.md`)} and do what it asks.`,
		`When it is done, write your result to ${join(taskDir, `result-${round + 1}.md`)}.`,
	].join(" ");
}

/**
 * The pointer that hands a sent-back Task to a new Teammate, after the one
 * working it has ended: it names the Task, every earlier round's result and
 * feedback, and the next round's result, and carries none of their text.
 */
export function restaffPointer(slug: string, taskDir: string, round: number): string {
	const rounds = Array.from({ length: round }, (_, index) => [`result-${index + 1}.md`, `feedback-${index + 1}.md`]).flat();
	return [
		`Task \`${slug}\` is yours now: the Teammate working it has ended, after round ${round} was sent back.`,
		`Read ${join(taskDir, "task.md")}, then the rounds so far (${rounds.map((file) => join(taskDir, file)).join(", ")}), and do what ${join(taskDir, `feedback-${round}.md`)} asks.`,
		`When it is done, write your result to ${join(taskDir, `result-${round + 1}.md`)}.`,
	].join(" ");
}

/**
 * The pointer a Teammate's launch carries for round `round` of a Task: the
 * handoff's for the first, and for a later one, the rounds so far, since a
 * Teammate launched on a sent-back Task has none of them in its context.
 */
export function launchPointer(slug: string, taskDir: string, round: number): string {
	return round > 1 ? restaffPointer(slug, taskDir, round - 1) : handoffPointer(slug, taskDir, 1);
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
		"- Your own scratch folder is your Claude Code job temp folder, `$CLAUDE_JOB_DIR/tmp` (`~/.claude/jobs/<short id>/tmp`; `echo $CLAUDE_JOB_DIR` prints it). To delete something there, write its path out in full, starting `/` or `~/`, with no shell variable such as `$CLAUDE_JOB_DIR` or `$J`: a delete whose path holds one counts as outside the Workspace and waits on the Lead.",
		"- The Workspace is fresh: installing dependencies is yours to do before you build or test.",
		"",
		"# Your Role",
		"",
		rolePrompt,
	].join("\n");
}

/** The pointer of round `round` of a Task, sent again when it never landed: the handoff's for round 1, else the send-back's of the round before. */
export function roundPointer(slug: string, taskDir: string, round: number): string {
	return round === 1 ? handoffPointer(slug, taskDir, 1) : sendBackPointer(slug, taskDir, round - 1);
}

/** Every pointer the Effort sends Teammate `id` for its Tasks under `tasksDir`, over every round so far. */
export function taskPointers(tasksDir: string, tasks: Readonly<Record<string, { teammate?: string; folder: string; round: number }>>, id: string): string[] {
	const sent: string[] = [];
	for (const [slug, task] of Object.entries(tasks)) {
		if (task.teammate !== id) continue;
		const dir = join(tasksDir, task.folder);
		for (let round = 1; round <= task.round; round++) sent.push(handoffPointer(slug, dir, round), sendBackPointer(slug, dir, round), restaffPointer(slug, dir, round));
	}
	return sent;
}
