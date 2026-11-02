/**
 * Team setup: the Lead and the human agree a Team's Playbook, and the human
 * adopts it explicitly.
 *
 * The Lead edits a draft under the agent dir with pi's own file tools. Asking
 * for adoption validates the draft and snapshots its bytes with their sha256;
 * only the human's approval in `/team pending` writes the snapshot as the
 * adopted Playbook, so agreement in chat never adopts anything, and an edit
 * made to the draft after the request is not what gets adopted.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PlaybookChange } from "./core.ts";
import { EVERY_ROLE, PERMISSION_MODES, type PermissionMode, type Playbook, parsePlaybook, playbookPaths, type Role, sha256, type Team } from "./definitions.ts";
import { availableTeams, findTeam } from "./start.ts";

/** The checkpoint id the Lead names to ask for a Playbook's adoption. */
export const ADOPT_PLAYBOOK = "adopt-playbook";

/** A Team setup running in this session. */
export interface TeamSetup {
	team: string;
	/** The draft the Lead edits, and the only file it may ask to adopt. */
	draftPath: string;
	/** Begun by `/team start`, so the Team starts once its Playbook is adopted. */
	startsTeam: boolean;
}

/** A Playbook draft snapshotted for the human to adopt from `/team pending`. */
export interface PendingAdoption {
	team: string;
	/** The draft the snapshot was taken from. */
	path: string;
	/** Of `snapshot`, which is what adoption records. */
	sha256: string;
	/** The draft's bytes when the Lead asked: exactly what approving adopts. */
	snapshot: Buffer;
	/** What in it doesn't do what it looks like it does; see {@link playbookWarnings}. */
	warnings: string[];
}

/** Where a setup's draft came from. */
type DraftSeed =
	/** A draft left by an earlier setup that ended before adoption. */
	| { from: "kept" }
	/** The adopted Playbook, unchanged since. */
	| { from: "adopted"; adoptedAt: string }
	/** The adopted Playbook's file, hand-edited after adoption. */
	| { from: "edited"; filePath: string }
	/** The Team's `default-playbook.md`. */
	| { from: "default" }
	/** Nothing: the Lead drafts one with the human. */
	| { from: "none" };

/**
 * `/team setup <name>`: the Team to set up, or why it can't be.
 *
 * A broken adoption record doesn't stop setup, because adopting the Playbook
 * again is how it is fixed; any other config error does.
 */
export function setupTeam(teams: readonly Team[], name: string | undefined, agentDir: string): { team: Team } | { error: string } {
	if (name === undefined) return { error: `\`/team setup\` needs a Team. ${availableTeams(teams)}` };
	const playbooksDir = playbookPaths(agentDir, name).dir;
	return findTeam(teams, name, "be set up", (problem) => dirname(problem.filePath) === playbooksDir);
}

/**
 * Start Team setup for a Team: seed its draft unless one is already there, and
 * say what the Lead is to do.
 *
 * An existing draft is kept rather than reseeded, so revisions agreed in a
 * setup that ended unadopted are not thrown away.
 */
export function beginSetup(agentDir: string, team: Team, startsTeam: boolean): { setup: TeamSetup; prompt: string } {
	const paths = playbookPaths(agentDir, team.name);
	let seed: DraftSeed;
	if (existsSync(paths.draft)) {
		seed = { from: "kept" };
	} else if (team.adoption.state !== "not-adopted" && existsSync(paths.adopted)) {
		mkdirSync(paths.dir, { recursive: true });
		copyFileSync(paths.adopted, paths.draft);
		seed = team.adoption.state === "adopted" ? { from: "adopted", adoptedAt: team.adoption.adoptedAt } : { from: "edited", filePath: paths.adopted };
	} else if (team.defaultPlaybook) {
		mkdirSync(paths.dir, { recursive: true });
		copyFileSync(join(team.dir, "default-playbook.md"), paths.draft);
		seed = { from: "default" };
	} else {
		seed = { from: "none" };
	}
	return { setup: { team: team.name, draftPath: paths.draft, startsTeam }, prompt: setupPrompt(team, paths.draft, seed) };
}

function setupPrompt(team: Team, draftPath: string, seed: DraftSeed): string {
	const opening = `Team setup for the \`${team.name}\` Team is running: you and the human agree its Playbook, the standing rules for how you run this Team, and the human adopts it.`;
	const asking = [
		`When the human is happy with it, call \`team_request_approval\` with checkpoint \`${ADOPT_PLAYBOOK}\` and path \`${draftPath}\`.`,
		"That only asks: the human adopts the Playbook from `/team pending`, and nothing they say in chat adopts it.",
	].join(" ");

	if (seed.from === "none") {
		return [
			opening,
			"",
			`The Team ships no default Playbook, so draft one with the human. Grill them, one question at a time, until you know how they want the Team run: when you must stop and bring them something (checkpoints), what you may allow a Teammate without asking (grants), what must always reach them (escalate entries), each Role's permission mode and rules, and how many times a Task may be sent back. Roles: ${team.roles.map((role) => `\`${role.name}\``).join(", ")}.`,
			"",
			`Write the draft to \`${draftPath}\` with your file tools, in this format:`,
			"",
			"```markdown",
			playbookExample(team),
			"```",
			"",
			`Every key shown is optional; no other key is allowed. Ids are kebab-case and unique across rules, checkpoints, grants and escalate entries. A Role's \`mode\` is one of ${PERMISSION_MODES.map((mode) => `\`${mode}\``).join(", ")}; \`*\` applies to every Role. Rules are the body's bullets that start with a bold id.`,
			"",
			asking,
		].join("\n");
	}

	const source = {
		kept: "kept from an earlier Team setup that ended before it was adopted",
		adopted: seed.from === "adopted" ? `copied from the Playbook adopted ${seed.adoptedAt}` : "",
		edited:
			seed.from === "edited" ? `copied from ${seed.filePath}, which was edited by hand after it was adopted, so it counts as not adopted until it is adopted again` : "",
		default: "copied from the Team's default Playbook",
		none: "",
	}[seed.from];
	return [
		opening,
		"",
		`The draft is \`${draftPath}\`, ${source}. Walk the human through it: its rules, checkpoints, grants, escalate entries and per-Role permissions. Change it with your file tools as you agree changes, keeping its format.`,
		"",
		asking,
	].join("\n");
}

/**
 * `team_request_approval` during Team setup: validate the draft and snapshot
 * it, or say what is wrong.
 *
 * The draft is read once, and those bytes are both what is validated and
 * what is snapshotted, so the Playbook adopted is the one that passed.
 */
export function requestAdoption(setup: TeamSetup | undefined, team: Team | undefined, checkpoint: string, path: string): PendingAdoption {
	if (!setup || !team) {
		throw new Error("No Team setup is running in this session, so there is nothing to adopt; the human starts one with `/team setup <team>`.");
	}
	if (checkpoint !== ADOPT_PLAYBOOK) {
		throw new Error(`There is no checkpoint \`${checkpoint}\` during Team setup; the one checkpoint it has is \`${ADOPT_PLAYBOOK}\`.`);
	}
	if (path !== setup.draftPath) {
		throw new Error(`Only the Team setup's draft, \`${setup.draftPath}\`, can be adopted, not \`${path}\`. Write the Playbook there and ask again.`);
	}

	let snapshot: Buffer;
	try {
		snapshot = readFileSync(path);
	} catch {
		throw new Error(`The draft \`${path}\` doesn't exist yet. Write the Playbook there with your file tools, then ask again.`);
	}
	// The human adopts it as their own, so it may set `bypassPermissions`.
	const roleNames = team.roles.map((role) => role.name);
	const { playbook, problems } = parsePlaybook(path, { source: "user", roleNames }, snapshot);
	if (!playbook) {
		const lines = problems.map((problem) => `- ${problem.reason}`);
		throw new Error(
			[`The draft \`${path}\` can't be adopted until its config errors are fixed:`, ...lines, "Fix the draft and call `team_request_approval` again."].join("\n"),
		);
	}
	return { team: team.name, path, sha256: playbook.sha256, snapshot, warnings: playbookWarnings(playbook, team.roles) };
}

/** Interpreters a wildcarded Bash allow rule hands arbitrary code to. */
const INTERPRETERS = ["python", "python3", "node", "ruby", "perl", "php", "lua", "sh", "bash", "zsh", "fish", "deno", "bun"];
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];

/**
 * An allow rule Claude Code drops when a session enters auto mode: any-command
 * Bash, a wildcarded interpreter, a package-manager run command, `Agent` or
 * `Monitor`.
 */
function droppedInAuto(rule: string): boolean {
	if (rule === "Agent" || rule === "Monitor" || rule === "Bash") return true;
	const bash = /^Bash\((.*)\)$/.exec(rule);
	if (!bash) return false;
	const command = bash[1].trim();
	if (command === "" || command === "*") return true;
	const [program, verb] = command.split(/[\s:]+/);
	if (INTERPRETERS.includes(program) && command.includes("*")) return true;
	return PACKAGE_MANAGERS.includes(program) && verb === "run";
}

/** The mode a Role runs in under this Playbook: its own entry, then `*`, then its Role file, then `auto`. */
export function modeInForce(playbook: Playbook, role: Role): PermissionMode {
	return playbook.roles[role.name]?.mode ?? playbook.roles[EVERY_ROLE]?.mode ?? role.permissionMode ?? "auto";
}

function quoted(names: readonly string[]): string {
	return names.map((name) => `\`${name}\``).join(", ");
}

/**
 * What in a draft doesn't do what it looks like it does: a per-Role `allow`
 * rule the mode in force drops, and an `escalate` entry with no `ask:` list,
 * which only fires on requests that prompt anyway.
 */
export function playbookWarnings(playbook: Playbook, roles: readonly Role[]): string[] {
	const warnings: string[] = [];
	for (const [key, permissions] of Object.entries(playbook.roles)) {
		const reached = roles.filter((role) => key === EVERY_ROLE || role.name === key);
		const inAuto = reached.filter((role) => modeInForce(playbook, role) === "auto").map((role) => role.name);
		if (inAuto.length === 0) continue;
		for (const rule of permissions.allow.filter(droppedInAuto)) {
			warnings.push(
				`\`roles.${key}\` allows \`${rule}\`, which won't take effect for ${quoted(inAuto)}: in \`auto\`, the mode in force there, Claude Code drops broad allow rules (any-command Bash, interpreter wildcards, package-manager run commands, \`Agent\`, \`Monitor\`).`,
			);
		}
	}
	for (const entry of playbook.escalate.filter((each) => each.ask.length === 0)) {
		warnings.push(
			`Escalate entry \`${entry.id}\` has no \`ask:\` list, so it reaches the human only for requests that prompt anyway; one an allow rule or the mode in force lets through never reaches the Lead.`,
		);
	}
	return warnings;
}

function warningLines(item: PendingAdoption): string[] {
	return item.warnings.length > 0 ? ["", "Warnings:", ...item.warnings.map((warning) => `- ${warning}`)] : [];
}

/** What the Lead is told once its request is pending. */
export function adoptionRequested(item: PendingAdoption): string {
	return [
		[
			`Asked the human to adopt the \`${item.team}\` Playbook: \`${item.path}\`, sha256 \`${item.sha256}\`.`,
			"They answer in `/team pending`, and nothing is adopted until they approve it there. Their answer comes back to you as a message.",
		].join(" "),
		...warningLines(item),
	].join("\n");
}

/** The human's answers to an adoption in `/team pending`. */
export const APPROVE = "Approve";
export const SEND_BACK = "Send back with a note";
export const LATER = "Later";

/** The `/team pending` dialog's title for an adoption: what would be adopted, by path and sha. */
export function pendingAdoptionTitle(item: PendingAdoption): string {
	return [`Adopt the \`${item.team}\` Playbook ${item.path} (sha256 ${item.sha256})?`, ...warningLines(item)].join("\n");
}

/**
 * The human approved: write the snapshot as the adopted Playbook with the
 * approved sha and the time, and drop the draft it came from.
 */
export function adoptPlaybook(agentDir: string, item: PendingAdoption, now: Date): string {
	const adopted = writeAdopted(agentDir, item.team, item.snapshot, item.sha256, now);
	rmSync(playbookPaths(agentDir, item.team).draft, { force: true });
	return adopted;
}

/** Write `text` as the Team's adopted Playbook, with its adoption record; returns its path. */
function writeAdopted(agentDir: string, team: string, text: string | Buffer, sha: string, now: Date): string {
	const paths = playbookPaths(agentDir, team);
	mkdirSync(paths.dir, { recursive: true });
	writeFileSync(paths.adopted, text);
	writeFileSync(paths.adoptedJson, `${JSON.stringify({ sha256: sha, adoptedAt: now.toISOString() }, null, "\t")}\n`);
	return paths.adopted;
}

/**
 * A Playbook's text with a proposed change made: its one `oldText` replaced
 * by `newText`, still a Playbook the extension reads. Why not, otherwise.
 */
export function changedPlaybook(playbook: Playbook, change: PlaybookChange, roleNames: readonly string[]): { text: string } | { error: string } {
	const text = readFileSync(playbook.filePath, "utf8");
	const at = text.indexOf(change.oldText);
	if (at === -1) return { error: `its \`oldText\` isn't in the Playbook ${playbook.filePath}; quote the passage to replace exactly` };
	if (text.indexOf(change.oldText, at + 1) !== -1) return { error: `its \`oldText\` is in the Playbook ${playbook.filePath} more than once; quote enough of the passage that it is there once` };
	const changed = text.slice(0, at) + change.newText + text.slice(at + change.oldText.length);
	const { problems } = parsePlaybook(playbook.filePath, { source: "user", roleNames }, Buffer.from(changed));
	if (problems.length > 0) return { error: `the Playbook it makes isn't one the extension reads: ${problems.map((problem) => problem.reason).join("; ")}` };
	return { text: changed };
}

/**
 * Adopt a Playbook change the human approved in the final Report: made to
 * the Team's adopted Playbook now, which the next Effort opens on. The
 * Effort that proposed it keeps its own snapshot. Refused, changing nothing,
 * when the Team's Playbook isn't adopted as it was or the change no longer applies.
 */
export function adoptPlaybookChange(agentDir: string, team: Team, change: PlaybookChange, now: Date): { adopted: string; sha256: string } | { error: string } {
	if (team.adoption.state !== "adopted") {
		return { error: `the \`${team.name}\` Playbook is ${team.adoption.state === "edited" ? "edited by hand since it was adopted" : "not adopted"}, so there is no adopted Playbook to change; run \`/team setup ${team.name}\` to adopt one` };
	}
	const made = changedPlaybook(team.adoption.playbook, change, team.roles.map((role) => role.name));
	if ("error" in made) return made;
	const sha = sha256(made.text);
	return { adopted: writeAdopted(agentDir, team.name, made.text, sha, now), sha256: sha };
}

/** What the Lead is told when the human adopts the Playbook it asked about. */
export function adoptedText(item: PendingAdoption, adoptedPath: string): string {
	return `The human adopted the \`${item.team}\` Playbook from \`/team pending\`: ${adoptedPath}, sha256 \`${item.sha256}\`. Team setup is over, and \`team_request_approval\` is switched off until the Team next needs it.`;
}

/** What the Lead is told when the human sends the draft back. */
export function sentBackText(item: PendingAdoption, note: string): string {
	return [
		`The human sent the \`${item.team}\` Playbook draft back from \`/team pending\` with this note:`,
		"",
		note,
		"",
		`Revise \`${item.path}\` with them, then call \`team_request_approval\` with checkpoint \`${ADOPT_PLAYBOOK}\` again.`,
	].join("\n");
}

/** A Playbook in the format the extension reads, for a Lead drafting one from nothing. */
export function playbookExample(team: Pick<Team, "name">): string {
	return [
		"---",
		"sendBackLimit: 2",
		"checkpoints:",
		"  - id: design-review",
		"    when: Before any build Task starts, once a design is accepted.",
		"permissions:",
		"  grants:",
		"    - id: push-effort-branch",
		"      allow: Push the Effort's branch to origin, never with force.",
		"  escalate:",
		"    - id: history-rewrite",
		"      when: Any git reset --hard, rebase or force-push.",
		'      ask: ["Bash(git reset --hard:*)", "Bash(git rebase:*)", "Bash(git push --force:*)"]',
		"  roles:",
		'    "*": { mode: auto, allow: [], deny: [] }',
		"---",
		"",
		`# ${team.name} Playbook`,
		"",
		"- **ask-before-guessing** A rule the Lead must follow, named by its bold id.",
	].join("\n");
}
