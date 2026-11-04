/**
 * Intake: what the Lead is asked when an Effort opens, and what the human sees
 * when it asks them to approve the Brief. Pure text, built from the Effort and
 * the Team and Playbook in force.
 */

import { BRIEF, type PendingApproval } from "./core.ts";
import { BRIEF_SKELETON, type Playbook, type Team } from "./definitions.ts";
import { type EffortPaths, overridableIds } from "./records.ts";
import { modeInForce } from "./setup.ts";

/** What intake is about: the Effort just opened, on this Team, Playbook and repo. */
export interface IntakeContext {
	effortId: string;
	paths: EffortPaths;
	team: Team;
	playbook: Playbook;
	repo: string;
}

function quoted(names: readonly string[]): string {
	return names.map((name) => `\`${name}\``).join(", ");
}

/** The Brief's shape, with this Effort's frontmatter filled in, for the Lead to copy. */
function briefTemplate(context: IntakeContext): string {
	const extra = context.playbook.briefSections.flatMap((name) => [`## ${name}`, "", `<what the Playbook asks for under \`${name}\`>`, ""]);
	return [
		"---",
		`team: ${context.team.name}`,
		`playbook: ${context.playbook.sha256}`,
		`repo: ${context.repo}`,
		"overrides: []",
		"---",
		"",
		"# <a short title for the Effort>",
		"",
		"## Goal",
		"",
		"<what the human wants, and why>",
		"",
		"## Acceptance criteria",
		"",
		"- **AC1** <one checkable criterion>",
		"- **AC2** <another; ids are unique and never reused>",
		"",
		"## Scope",
		"",
		"In: <what this Effort covers>",
		"Out: <what it leaves alone>",
		"",
		"## Decide for me / Ask me",
		"",
		"<what the Lead may decide for the human, and what it must ask them>",
		"",
		"## Delivery",
		"",
		"<what the human gets at the end, and in what form>",
		"",
		...extra,
	].join("\n");
}

/** The turn that starts intake: the Lead grills the human and drafts the Brief. */
export function intakePrompt(context: IntakeContext): string {
	const { effortId, paths, team, playbook } = context;
	const ids = overridableIds(playbook);
	return [
		`The human ran \`/team start ${team.name}\`, which opened Effort \`${effortId}\` (${paths.dir}). Run its intake: agree with the human what they want from this Effort, write it down as the Brief, and ask them to approve it. No Teammate starts until they do.`,
		"",
		"- Grill the human until you understand what they want: one question at a time, each with the answer you would recommend. Use subagents for lookups such as reading the codebase, so the Brief rests on the real code rather than guesses.",
		`- Write the Brief to ${paths.draft} with your file tools. Only you edit the draft.`,
		`- Then call \`team_request_approval\` with checkpoint \`${BRIEF}\` and that path. It checks the Brief and adds it to \`/team pending\`, and only the human's approval there counts, never agreement in chat. If it names problems, fix them and call it again.`,
		"",
		`The Brief has the sections every Brief has (${quoted(BRIEF_SKELETON)})${playbook.briefSections.length > 0 ? `, plus the ones the \`${team.name}\` Playbook adds (${quoted(playbook.briefSections)}), described under its \`Brief sections\` heading` : ""}. Copy this shape, frontmatter as it is:`,
		"",
		"```markdown",
		briefTemplate(context),
		"```",
		"",
		`The Playbook in force is ${playbook.filePath} (sha256 ${playbook.sha256}); read it for its rules. When the human wants this Effort to depart from one, add an override to \`overrides\`: \`{ rule: <id>, change: skip, reason: <why> }\` drops one of the Playbook's ids (${ids.length > 0 ? quoted(ids) : "it has none"}), and \`{ rule: <new id>, change: "add grant: <what it allows>", reason: <why> }\` adds a grant.`,
		"",
		"Before you write the Brief, check each of the Playbook's rules against what your tools can do. A rule that asks for something none of them does can't be carried out: choosing a Task's model is one, since each Teammate runs on its Role's `model` and models are chosen in the Role files, so a cheaper model for simpler Tasks means a separate Role, such as a `dev-lite` on Haiku. Tell the human which rule and why while you grill them, add `{ rule: <its id>, change: skip, reason: <what your tools can't do> }` to `overrides`, name it in the plan Report, and propose the Playbook change that fixes the rule in the final Report's `changes`. Never skip a rule silently: the human reads the Playbook as what happens.",
	].join("\n");
}

/** What the human is told once the Effort is open, after what `/team start` picked. */
export function openedText(picked: string, effortId: string, paths: EffortPaths): string {
	return `${picked} Effort \`${effortId}\` opened at ${paths.dir}; the Lead drafts its Brief with you, and nothing runs until you approve it from \`/team pending\`.`;
}

/**
 * The `/team pending` dialog's title for a Brief: what would be approved, by
 * path and sha, and each Role of the Team with the mode it would run in.
 */
export function briefApprovalTitle(item: PendingApproval, context: Omit<IntakeContext, "paths">): string {
	return [
		`Approve the Brief of Effort \`${context.effortId}\` (request \`${item.id}\`)? ${item.path} (sha256 ${item.sha256})`,
		`Repo: ${context.repo}`,
		`Roles of Team \`${context.team.name}\`, each with the mode it runs in:`,
		...context.team.roles.map((role) => `- \`${role.name}\`: ${modeInForce(context.playbook, role)}`),
		"Approving promotes exactly this snapshot to brief.md, which is never edited, and snapshots the Team and its Playbook beside it.",
	].join("\n");
}
