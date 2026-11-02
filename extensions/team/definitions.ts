/**
 * Definitions: turning folders of markdown into Teams the Lead can run.
 *
 * A Team is a folder: `team.md` (name, description, `workspace`, and a body
 * saying what work it covers), `roles/*.md` (a Team's Roles are the files
 * present) and an optional `default-playbook.md`. Teams come from two places
 * only: the set bundled beside this file and the human's own under
 * `<agent dir>/teams/<team>/`. A user Team replaces a bundled Team of the same
 * name as a whole, never merged, so a half-overridden Team can't exist.
 *
 * Nothing is read from the checkout pi runs in. A Role sets a Teammate's
 * permission mode, tools, MCP servers and plugins, so a Team a cloned repo
 * carried would be that repo choosing what runs on the human's machine with
 * which permissions. Unlike the subagents extension's project Agents there is
 * no trust prompt that could make that safe enough, so there is no project scope
 * at all.
 *
 * Validation is loud. Every file that is wrong is reported with the reason and
 * the path, and a Team with any problem (its own file, any Role, its Playbook)
 * is still listed, problems attached, so `/team start` can refuse it by name
 * rather than the Team silently going missing or running short a position.
 */

import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** The Teams shipped with this extension. */
export const BUNDLED_TEAMS_DIR = join(dirname(fileURLToPath(import.meta.url)), "teams");

/** Where a Team came from. Only `user` content may ask for `bypassPermissions`. */
export type TeamSource = "bundled" | "user";

/** One thing wrong with one file. */
export interface ConfigError {
	filePath: string;
	reason: string;
}

/**
 * The modes a Teammate may be launched in, as `--permission-mode` spells them.
 *
 * `plan` is deliberately absent: a Teammate in plan mode stalls behind a plan
 * card that no hook can approve (ADR-0006), so a plan is a Task whose result is
 * the plan.
 */
export const PERMISSION_MODES = ["auto", "acceptEdits", "manual", "dontAsk", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The kinds of Workspace a Team can ask for. */
export const WORKSPACE_KINDS = ["git-worktree"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/** One position on a Team. Every field but the prompt maps to a `claude` launch flag. */
export interface Role {
	/** The file's own name, which is how the Lead staffs it and how Teammates are named (`dev-1`). */
	name: string;
	/** What the Role is for, read by the Lead when it staffs. */
	description: string;
	/** `--model`, passed as written. Absent means Claude Code's own default. */
	model?: string;
	/** `--effort`, passed as written. */
	effort?: string;
	/** `--allowedTools`. */
	allowedTools: string[];
	/** `--disallowedTools`, to which every launch adds `EnterPlanMode`. */
	disallowedTools: string[];
	/** The `mcpServers` object of the `--mcp-config` this Role adds, by server name. */
	mcpServers: Record<string, Record<string, unknown>>;
	/** `--plugin-dir`, one per entry. */
	plugins: string[];
	/** `--permission-mode`, when the Role sets one. */
	permissionMode?: PermissionMode;
	/** The body: the Role's prompt. */
	prompt: string;
	filePath: string;
}

/** A point in the work where the Lead must bring something to the human. */
export interface Checkpoint {
	id: string;
	when: string;
}

/** Something the human lets the Lead allow that is otherwise past its floor. */
export interface Grant {
	id: string;
	allow: string;
}

/** A kind of request brought to the human even when the Lead would approve it. */
export interface Escalation {
	id: string;
	when: string;
	/** Permission rules added as `permissions.ask`, so the request prompts at all. */
	ask: string[];
}

/** A Playbook's settings for one Role, or for every Role under `*`. */
export interface RolePermissions {
	mode?: PermissionMode;
	allow: string[];
	deny: string[];
}

/** A Team's standing rules, parsed. */
export interface Playbook {
	filePath: string;
	/** Of the file's bytes as read, which is what adoption records. */
	sha256: string;
	sendBackLimit: number;
	checkpoints: Checkpoint[];
	grants: Grant[];
	escalate: Escalation[];
	/** By Role name, or `*` for every Role. */
	roles: Record<string, RolePermissions>;
	/** The ids of the body's rules, in the order written. */
	rules: string[];
	/** The sections this Team's Briefs have beyond `BRIEF_SKELETON`, in the order written. */
	briefSections: string[];
	body: string;
}

/**
 * Whether the human has adopted a Playbook for a Team.
 *
 * `edited` is an adopted Playbook whose bytes no longer match the sha256
 * recorded when it was adopted: the human changed it by hand, so what is on disk
 * is not what they agreed to, and it counts as not adopted until they adopt it
 * again.
 */
export type Adoption =
	| { state: "adopted"; playbook: Playbook; adoptedAt: string }
	| { state: "not-adopted" }
	| { state: "edited"; filePath: string; adoptedSha256: string; sha256: string };

export interface Team {
	/** The folder's name, which `team.md`'s `name` must repeat. */
	name: string;
	/** Empty only when `team.md` is missing or lacks one, which is then a problem. */
	description: string;
	workspace?: WorkspaceKind;
	/** What work the Team covers. */
	body: string;
	source: TeamSource;
	dir: string;
	/** The Roles that parsed, by name. A Role that didn't is in `problems` instead. */
	roles: Role[];
	defaultPlaybook?: Playbook;
	adoption: Adoption;
	/** Everything wrong with the Team's files, its Playbooks included. Empty means it can run. */
	problems: ConfigError[];
}

/** Where Teams are read from. */
export interface TeamRoots {
	/** pi's agent dir (`~/.pi/agent`): user Teams in `teams/`, adopted Playbooks in `team/playbooks/`. */
	agentDir: string;
	/** Defaults to the Teams shipped beside this file. */
	bundledTeamsDir?: string;
}

/** The files that hold a Team's adopted Playbook. */
/** Where a Team's Playbook lives under the agent dir, once adopted and while drafted. */
export interface PlaybookPaths {
	/** The folder holding every Team's Playbook files. */
	dir: string;
	/** The adopted Playbook. */
	adopted: string;
	/** `{ sha256, adoptedAt }`: what was adopted, and when. */
	adoptedJson: string;
	/** The draft the Lead edits during Team setup. */
	draft: string;
}

export function playbookPaths(agentDir: string, team: string): PlaybookPaths {
	const dir = join(agentDir, "team", "playbooks");
	return { dir, adopted: join(dir, `${team}.md`), adoptedJson: join(dir, `${team}.adopted.json`), draft: join(dir, `${team}.draft.md`) };
}

/** The sha256 a Playbook is adopted by, in hex. */
export function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Lowercase letters and digits in words joined by single hyphens: `design-review`, `ac-2`. */
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isKebabCase(text: string): boolean {
	return KEBAB.test(text);
}

const TEAM_FIELDS = ["name", "description", "workspace"];
const ROLE_FIELDS = [
	"name",
	"description",
	"model",
	"effort",
	"allowedTools",
	"disallowedTools",
	"mcpServers",
	"plugins",
	"permissionMode",
];
const PLAYBOOK_FIELDS = ["sendBackLimit", "checkpoints", "permissions"];
const PERMISSIONS_FIELDS = ["grants", "escalate", "roles"];
const CHECKPOINT_FIELDS = ["id", "when"];
const GRANT_FIELDS = ["id", "allow"];
const ESCALATE_FIELDS = ["id", "when", "ask"];
const ROLE_PERMISSION_FIELDS = ["mode", "allow", "deny"];

const DEFAULT_SEND_BACK_LIMIT = 2;

/** The key a Playbook uses for settings that apply to every Role. */
export const EVERY_ROLE = "*";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function quoteList(items: readonly string[]): string {
	return items.map((item) => `\`${item}\``).join(", ");
}

/** Codepoint order, so listings read the same on every machine whatever its locale. */
function byCodepoint(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

type Fields = Record<string, unknown>;

function isMapping(value: unknown): value is Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collects the problems of one file as it is read, so a file with three
 * mistakes reports all three rather than one per edit-and-retry.
 */
class FileCheck {
	readonly problems: ConfigError[] = [];
	readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	fail(reason: string): void {
		this.problems.push({ filePath: this.filePath, reason });
	}

	/** Reject any key outside `allowed`, naming the ones that would have worked. */
	onlyFields(fields: Fields, allowed: readonly string[], where: string): void {
		for (const key of Object.keys(fields)) {
			if (!allowed.includes(key)) this.fail(`unknown field \`${key}\` in ${where}; the fields are ${quoteList(allowed)}`);
		}
	}

	requiredText(value: unknown, field: string, why: string): string | undefined {
		if (typeof value === "string" && value.trim()) return value.trim();
		this.fail(`needs a \`${field}\` ${why}`);
		return undefined;
	}

	optionalText(value: unknown, field: string): string | undefined {
		if (value === undefined) return undefined;
		if (typeof value === "string" && value.trim()) return value.trim();
		this.fail(`\`${field}\` must be a non-empty string`);
		return undefined;
	}

	stringList(value: unknown, field: string): string[] {
		if (value === undefined || value === null) return [];
		if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())) {
			return value.map((item: string) => item.trim());
		}
		this.fail(`\`${field}\` must be a YAML list of non-empty strings, such as ["Bash(npm test:*)"]`);
		return [];
	}

	/**
	 * A permission mode, with `plan` refused by name and `bypassPermissions`
	 * refused in anything the human didn't write themselves.
	 */
	mode(value: unknown, field: string, source: TeamSource): PermissionMode | undefined {
		if (value === undefined) return undefined;
		if (value === "plan") {
			this.fail(
				`\`${field}: plan\` is not allowed: a Teammate in plan mode stalls behind a plan card no hook can approve. Make the plan a Task whose result is the plan, and use one of ${quoteList(PERMISSION_MODES)}`,
			);
			return undefined;
		}
		if (typeof value !== "string" || !(PERMISSION_MODES as readonly string[]).includes(value)) {
			this.fail(`\`${field}\` must be one of ${quoteList(PERMISSION_MODES)}, not \`${String(value)}\``);
			return undefined;
		}
		if (value === "bypassPermissions" && source === "bundled") {
			this.fail(
				`\`${field}: bypassPermissions\` is refused in a bundled Team: bypassing permissions is only ever the human's own decision, in their own Team under the agent dir's \`teams/\` or in a Playbook they adopted`,
			);
			return undefined;
		}
		return value as PermissionMode;
	}

	id(value: unknown, where: string): string | undefined {
		if (typeof value === "string" && isKebabCase(value)) return value;
		this.fail(`${where} needs an \`id\` in kebab-case (lowercase letters and digits joined by single hyphens), not \`${String(value)}\``);
		return undefined;
	}
}

/** Read and split a markdown file, or the bytes already read from it, or report why it can't be. */
function readMarkdown(check: FileCheck, bytes?: Buffer): { fields: Fields; body: string; raw: Buffer } | undefined {
	let raw: Buffer;
	try {
		raw = bytes ?? readFileSync(check.filePath);
	} catch (error) {
		check.fail(`could not be read: ${errorText(error)}`);
		return undefined;
	}
	let parsed: { frontmatter: unknown; body: string };
	try {
		parsed = parseFrontmatter(raw.toString("utf8"));
	} catch (error) {
		check.fail(`frontmatter is not valid YAML: ${errorText(error).split("\n")[0]}`);
		return undefined;
	}
	if (!isMapping(parsed.frontmatter)) {
		check.fail("frontmatter must be a YAML mapping of fields between `---` lines");
		return undefined;
	}
	return { fields: parsed.frontmatter, body: parsed.body, raw };
}

function parseRole(filePath: string, source: TeamSource): { role?: Role; problems: ConfigError[] } {
	const check = new FileCheck(filePath);
	const file = readMarkdown(check);
	if (!file) return { problems: check.problems };
	const { fields, body } = file;

	check.onlyFields(fields, ROLE_FIELDS, "a Role, whose fields map one-to-one to launch flags");
	const fileName = basename(filePath, ".md");
	const name = check.requiredText(fields.name, "name", `matching the file name, \`${fileName}\``);
	if (name !== undefined && name !== fileName) check.fail(`\`name: ${name}\` must match the file name, \`${fileName}\``);
	if (name !== undefined && !isKebabCase(name)) check.fail(`\`name: ${name}\` must be kebab-case, since Teammates are named after it (\`${name}-1\`)`);
	const description = check.requiredText(fields.description, "description", "saying what the Role is for, which the Lead reads when it staffs");
	const model = check.optionalText(fields.model, "model");
	const effort = check.optionalText(fields.effort, "effort");
	const allowedTools = check.stringList(fields.allowedTools, "allowedTools");
	const disallowedTools = check.stringList(fields.disallowedTools, "disallowedTools");
	const plugins = check.stringList(fields.plugins, "plugins");
	const permissionMode = check.mode(fields.permissionMode, "permissionMode", source);

	let mcpServers: Record<string, Record<string, unknown>> = {};
	if (fields.mcpServers !== undefined) {
		if (isMapping(fields.mcpServers) && Object.values(fields.mcpServers).every(isMapping)) {
			mcpServers = fields.mcpServers as Record<string, Record<string, unknown>>;
		} else {
			check.fail("`mcpServers` must be a mapping of server name to server config, as in the `mcpServers` object of an `--mcp-config` file");
		}
	}

	if (check.problems.length > 0 || name === undefined || description === undefined) return { problems: check.problems };
	return {
		role: { name, description, model, effort, allowedTools, disallowedTools, mcpServers, plugins, permissionMode, prompt: body, filePath },
		problems: [],
	};
}

/**
 * A bullet or numbered item that opens with bold text: `- **design-first**: …`.
 * Only bold text in kebab-case is a rule id; `- **A design** is done when…` is
 * guidance.
 */
const BOLD_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\*\*([^*]+)\*\*/;

/**
 * Bold item text that reads as an id but isn't one: one lowercase hyphenated
 * word with a stray character, such as `criteria-are-the-human's`. Reported
 * rather than read as guidance, because a rule that silently stops being a rule
 * is exactly what an override would then fail to name. `**Non-goals**` and
 * `**A design**` are headings of prose, not near-ids.
 */
const ALMOST_ID = /^[^\sA-Z]*-[^\sA-Z]*$/;

/** The sections every Brief has, whatever its Team. */
export const BRIEF_SKELETON = ["Goal", "Acceptance criteria", "Scope", "Decide for me / Ask me", "Delivery"] as const;

/** The heading a Playbook lists its extra Brief sections under. */
const BRIEF_SECTIONS_HEADING = "brief sections";

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * Split the `## Brief sections` block off a Playbook's body. Its bold list
 * items name the sections the Team's Briefs add (`- **Constraints**: …`); they
 * are not rules, so the rest is what rule ids are read from.
 */
function splitBriefSections(body: string, check: FileCheck): { sections: string[]; rest: string } {
	const sections: string[] = [];
	const rest: string[] = [];
	let inside: number | undefined;
	for (const line of body.split("\n")) {
		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1].length;
			if (inside !== undefined && level <= inside) inside = undefined;
			if (heading[2].toLowerCase() === BRIEF_SECTIONS_HEADING) {
				inside = level;
				continue;
			}
		}
		if (inside === undefined) {
			rest.push(line);
			continue;
		}
		const name = BOLD_ITEM.exec(line)?.[1]?.trim();
		if (name === undefined) continue;
		const lower = name.toLowerCase();
		if (BRIEF_SKELETON.some((section) => section.toLowerCase() === lower)) {
			check.fail(`the Brief section \`${name}\` is already part of every Brief (${quoteList(BRIEF_SKELETON)}); list only the sections this Team adds`);
		} else if (sections.some((section) => section.toLowerCase() === lower)) {
			check.fail(`the Brief section \`${name}\` is listed more than once under \`Brief sections\``);
		} else sections.push(name);
	}
	return { sections, rest: rest.join("\n") };
}

function ruleIds(body: string, check: FileCheck): string[] {
	const ids: string[] = [];
	for (const line of body.split("\n")) {
		const bold = BOLD_ITEM.exec(line)?.[1];
		if (bold === undefined) continue;
		if (isKebabCase(bold)) ids.push(bold);
		else if (ALMOST_ID.test(bold)) {
			check.fail(`the rule id \`${bold}\` must be kebab-case (lowercase letters and digits joined by single hyphens)`);
		}
	}
	return ids;
}

/** What a Playbook is checked against beyond its own file. */
export interface PlaybookContext {
	/** Only `user` content may set `bypassPermissions`. */
	source: TeamSource;
	/** The Team's Roles, which `permissions.roles` keys must name (or `*`). */
	roleNames: readonly string[];
}

/**
 * Parse and validate a Playbook file, or `bytes` already read from it, so
 * what is validated is exactly what a snapshot holds.
 *
 * Only `sendBackLimit`, `checkpoints` and `permissions` mean anything to the
 * extension, and a misspelt key would be a rule that silently does nothing, so
 * every other key is an error. Rules, checkpoints, grants and escalate entries
 * share one id namespace, because a Brief override names an id and must mean
 * exactly one thing.
 */
export function parsePlaybook(filePath: string, context: PlaybookContext, bytes?: Buffer): { playbook?: Playbook; problems: ConfigError[] } {
	const check = new FileCheck(filePath);
	const file = readMarkdown(check, bytes);
	if (!file) return { problems: check.problems };
	const { fields, body, raw } = file;

	check.onlyFields(fields, PLAYBOOK_FIELDS, "a Playbook's frontmatter");

	let sendBackLimit = DEFAULT_SEND_BACK_LIMIT;
	if (fields.sendBackLimit !== undefined) {
		if (typeof fields.sendBackLimit === "number" && Number.isInteger(fields.sendBackLimit) && fields.sendBackLimit > 0) {
			sendBackLimit = fields.sendBackLimit;
		} else {
			check.fail(`\`sendBackLimit\` must be a positive integer, not \`${String(fields.sendBackLimit)}\`; omit it for ${DEFAULT_SEND_BACK_LIMIT}`);
		}
	}

	const checkpoints: Checkpoint[] = [];
	for (const entry of entries(fields.checkpoints, "checkpoints", check)) {
		check.onlyFields(entry, CHECKPOINT_FIELDS, "a checkpoint");
		const id = check.id(entry.id, "a checkpoint");
		const when = check.requiredText(entry.when, "when", `on checkpoint \`${String(entry.id)}\`, saying when it applies`);
		if (id && when) checkpoints.push({ id, when });
	}

	const permissions = fields.permissions ?? {};
	const grants: Grant[] = [];
	const escalate: Escalation[] = [];
	const roles: Record<string, RolePermissions> = {};
	if (!isMapping(permissions)) {
		check.fail("`permissions` must be a mapping with `grants`, `escalate` and `roles`");
	} else {
		check.onlyFields(permissions, PERMISSIONS_FIELDS, "`permissions`");

		for (const entry of entries(permissions.grants, "permissions.grants", check)) {
			check.onlyFields(entry, GRANT_FIELDS, "a grant");
			const id = check.id(entry.id, "a grant");
			const allow = check.requiredText(entry.allow, "allow", `on grant \`${String(entry.id)}\`, saying what it lets the Lead allow`);
			if (id && allow) grants.push({ id, allow });
		}

		for (const entry of entries(permissions.escalate, "permissions.escalate", check)) {
			check.onlyFields(entry, ESCALATE_FIELDS, "an escalate entry");
			const id = check.id(entry.id, "an escalate entry");
			const when = check.requiredText(entry.when, "when", `on escalate entry \`${String(entry.id)}\`, saying what it covers`);
			const ask = check.stringList(entry.ask, `ask\` of \`${String(entry.id)}`);
			if (id && when) escalate.push({ id, when, ask });
		}

		const perRole = permissions.roles ?? {};
		if (!isMapping(perRole)) {
			check.fail("`permissions.roles` must be a mapping of Role name (or `*`) to `{ mode, allow, deny }`");
		} else {
			const known = [EVERY_ROLE, ...context.roleNames];
			for (const [roleName, settings] of Object.entries(perRole)) {
				if (!known.includes(roleName)) {
					check.fail(`\`permissions.roles\` names \`${roleName}\`, which is not a Role of this Team; the Roles are ${quoteList(known)}`);
					continue;
				}
				if (!isMapping(settings)) {
					check.fail(`\`permissions.roles.${roleName}\` must be a mapping of \`mode\`, \`allow\` and \`deny\``);
					continue;
				}
				check.onlyFields(settings, ROLE_PERMISSION_FIELDS, `\`permissions.roles.${roleName}\``);
				roles[roleName] = {
					mode: check.mode(settings.mode, `permissions.roles.${roleName}.mode`, context.source),
					allow: check.stringList(settings.allow, `permissions.roles.${roleName}.allow`),
					deny: check.stringList(settings.deny, `permissions.roles.${roleName}.deny`),
				};
			}
		}
	}

	const { sections: briefSections, rest } = splitBriefSections(body, check);
	const rules = ruleIds(rest, check);

	const kinds = new Map<string, string[]>();
	const claim = (id: string, kind: string) => kinds.set(id, [...(kinds.get(id) ?? []), kind]);
	for (const id of rules) claim(id, "rule");
	for (const { id } of checkpoints) claim(id, "checkpoint");
	for (const { id } of grants) claim(id, "grant");
	for (const { id } of escalate) claim(id, "escalate entry");
	for (const [id, uses] of kinds) {
		if (uses.length > 1) {
			check.fail(`the id \`${id}\` is used more than once (${uses.join(", ")}); rules, checkpoints, grants and escalate entries share one namespace, so each id must be unique`);
		}
	}

	if (check.problems.length > 0) return { problems: check.problems };
	return {
		playbook: { filePath, sha256: sha256(raw), sendBackLimit, checkpoints, grants, escalate, roles, rules, briefSections, body },
		problems: [],
	};
}

/** A Playbook list field's entries, each a mapping, or a problem saying it isn't. */
function entries(value: unknown, field: string, check: FileCheck): Fields[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		check.fail(`\`${field}\` must be a YAML list`);
		return [];
	}
	const mappings = value.filter(isMapping);
	if (mappings.length !== value.length) check.fail(`every entry of \`${field}\` must be a mapping with an \`id\``);
	return mappings;
}

/**
 * The human's adoption of this Team's Playbook, as recorded under the agent dir.
 *
 * The record is `{ sha256, adoptedAt }` beside the adopted file, and the sha is
 * checked against the file's bytes every time: an edit by hand after adoption
 * turns the Playbook back into one the human hasn't agreed to.
 */
function readAdoption(agentDir: string, team: string, roleNames: readonly string[]): { adoption: Adoption; problems: ConfigError[] } {
	const paths = playbookPaths(agentDir, team);
	if (!existsSync(paths.adoptedJson)) return { adoption: { state: "not-adopted" }, problems: [] };

	let record: unknown;
	try {
		record = JSON.parse(readFileSync(paths.adoptedJson, "utf8"));
	} catch (error) {
		return {
			adoption: { state: "not-adopted" },
			problems: [{ filePath: paths.adoptedJson, reason: `is not valid JSON (${errorText(error)}); adopt the Playbook again` }],
		};
	}
	if (!isMapping(record) || typeof record.sha256 !== "string" || typeof record.adoptedAt !== "string") {
		return {
			adoption: { state: "not-adopted" },
			problems: [{ filePath: paths.adoptedJson, reason: `must be \`{ "sha256": …, "adoptedAt": … }\`; adopt the Playbook again` }],
		};
	}

	let raw: Buffer;
	try {
		raw = readFileSync(paths.adopted);
	} catch {
		return { adoption: { state: "not-adopted" }, problems: [] };
	}
	const actual = sha256(raw);
	if (actual !== record.sha256) {
		return { adoption: { state: "edited", filePath: paths.adopted, adoptedSha256: record.sha256, sha256: actual }, problems: [] };
	}

	// An adopted Playbook is the human's own, so it may set `bypassPermissions`.
	const { playbook, problems } = parsePlaybook(paths.adopted, { source: "user", roleNames });
	if (!playbook) return { adoption: { state: "not-adopted" }, problems };
	return { adoption: { state: "adopted", playbook, adoptedAt: record.adoptedAt }, problems: [] };
}

function directories(dir: string): string[] {
	let found: Dirent[];
	try {
		found = readdirSync(dir, { withFileTypes: true });
	} catch {
		// No folder means no Teams there: the normal case for a human who has written none.
		return [];
	}
	return found
		.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
		.map((entry) => entry.name)
		.sort(byCodepoint);
}

function readTeam(dir: string, name: string, source: TeamSource, agentDir: string): Team {
	const problems: ConfigError[] = [];
	let description = "";
	let workspace: WorkspaceKind | undefined;
	let body = "";

	const teamFile = join(dir, "team.md");
	const check = new FileCheck(teamFile);
	if (!existsSync(teamFile)) {
		check.fail("is missing; a Team is a folder with `team.md` (name, description, workspace) and `roles/*.md`");
	} else {
		const file = readMarkdown(check);
		if (file) {
			body = file.body;
			check.onlyFields(file.fields, TEAM_FIELDS, "`team.md`");
			const declared = check.requiredText(file.fields.name, "name", `matching its folder, \`${name}\``);
			if (declared !== undefined && declared !== name) check.fail(`\`name: ${declared}\` must match the Team's folder, \`${name}\``);
			description = check.requiredText(file.fields.description, "description", "saying what work the Team is for, which the Lead reads to propose a Team") ?? "";
			if (file.fields.workspace === undefined) {
				check.fail(`needs a \`workspace\`, one of ${quoteList(WORKSPACE_KINDS)}`);
			} else if (typeof file.fields.workspace === "string" && (WORKSPACE_KINDS as readonly string[]).includes(file.fields.workspace)) {
				workspace = file.fields.workspace as WorkspaceKind;
			} else {
				check.fail(`\`workspace\` must be one of ${quoteList(WORKSPACE_KINDS)}, not \`${String(file.fields.workspace)}\``);
			}
		}
	}
	problems.push(...check.problems);

	const rolesDir = join(dir, "roles");
	const roleFiles = readdirSafe(rolesDir)
		.filter((file) => file.endsWith(".md"))
		.sort(byCodepoint);
	if (roleFiles.length === 0) problems.push({ filePath: rolesDir, reason: "holds no Roles; a Team needs at least one `roles/<role>.md`" });
	const roles: Role[] = [];
	for (const file of roleFiles) {
		const parsed = parseRole(join(rolesDir, file), source);
		if (parsed.role) roles.push(parsed.role);
		problems.push(...parsed.problems);
	}
	// Every Role file's name, parsed or not, so one bad Role doesn't turn a
	// Playbook naming it into a second, misleading error.
	const roleNames = roleFiles.map((file) => basename(file, ".md"));

	let defaultPlaybook: Playbook | undefined;
	const defaultFile = join(dir, "default-playbook.md");
	if (existsSync(defaultFile)) {
		const parsed = parsePlaybook(defaultFile, { source, roleNames });
		defaultPlaybook = parsed.playbook;
		problems.push(...parsed.problems);
	}

	const { adoption, problems: adoptionProblems } = readAdoption(agentDir, name, roleNames);
	problems.push(...adoptionProblems);

	return { name, description, workspace, body, source, dir, roles, defaultPlaybook, adoption, problems };
}

function readdirSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/**
 * Every Team, sorted by name, each with its problems.
 *
 * A user folder named like a bundled Team replaces that Team outright, its
 * Roles and Playbook included: nothing of the bundled one is read.
 */
export function listTeams(roots: TeamRoots): Team[] {
	const bundledDir = roots.bundledTeamsDir ?? BUNDLED_TEAMS_DIR;
	const userDir = join(roots.agentDir, "teams");

	const byName = new Map<string, { dir: string; source: TeamSource }>();
	for (const name of directories(bundledDir)) byName.set(name, { dir: join(bundledDir, name), source: "bundled" });
	for (const name of directories(userDir)) byName.set(name, { dir: join(userDir, name), source: "user" });

	return [...byName.entries()]
		.sort(([a], [b]) => byCodepoint(a, b))
		.map(([name, { dir, source }]) => readTeam(dir, name, source, roots.agentDir));
}

/** One Team by name, or undefined when there is none by that name. */
export function loadTeam(roots: TeamRoots, name: string): Team | undefined {
	return listTeams(roots).find((team) => team.name === name);
}
