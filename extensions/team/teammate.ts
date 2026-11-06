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
		'- Your own scratch folder is your Claude Code job temp folder, `$CLAUDE_JOB_DIR/tmp`. Write it out in every delete there, so the delete doesn\'t wait on the Lead: `rm -rf "$CLAUDE_JOB_DIR"/tmp/old`, or `cd "$CLAUDE_JOB_DIR"/tmp/<folder>` first. Don\'t put the folder in a variable of your own: a delete through one counts as outside the Workspace and waits on the Lead, unless the same command sets it once, plainly, before the delete (`T="$CLAUDE_JOB_DIR/tmp/x" && rm -rf "$T"`), and has no loop, `if`, `case`, `{ … }` group, `eval` or `source`. A delete of `$CLAUDE_JOB_DIR/tmp` itself, or in a command that sets `CLAUDE_JOB_DIR`, waits on the Lead too.',
		'- Write a local server\'s URL out in every request to it: `curl -X PUT -d v "http://127.0.0.1:$PORT/keys/a"`, with `$PORT` a plain number. A write (`POST`, `PUT`, `DELETE` and the like) to a URL held in a variable (`"$URL/keys/a"`) counts as a send to an outside service and waits on the Lead.',
		"- The Workspace is fresh: installing dependencies is yours to do before you build or test.",
		"- Stop every process you start in the background (a server, a browser, a watcher) before you write your result: stopping your session doesn't stop them. Record each one's pid when you start it (`$!`) and stop it by that pid (`kill <pid>`), never by name or pattern (`pkill`, `killall`, `kill $(pgrep …)`): those can end another Teammate's processes, or the human's. In your result, name each one you leave running, with its pid and command.",
		"- To wait on a long run, end your turn with a `Monitor` or background task watching it: you are prompted again when it ends, so there is no need to poll or sleep in a loop. Ending your turn doesn't end your session.",
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
