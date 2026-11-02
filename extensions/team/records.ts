/**
 * Records: the files an Effort keeps, and the checks that make them
 * trustworthy.
 *
 * The Brief a Lead drafts is validated here before the human is ever asked
 * about it. Approval then promotes the exact snapshot the human saw, together
 * with snapshots of the Playbook and the Team in force, and records the act in
 * `approvals.jsonl` with each one's sha256. From then on the Effort reads only
 * its own copies, and a copy whose sha no longer matches its approval is
 * reported and never used.
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { EffortLine, EffortState, JournalLine, PendingApproval, Workspace } from "./core.ts";
import { BRIEF_SKELETON, isKebabCase, type Playbook, sha256 } from "./definitions.ts";

/** The files of one Effort, all under `<agent dir>/team/efforts/<effort-id>/`. */
export interface EffortPaths {
	dir: string;
	/** The Lead's draft of the Brief, which only the Lead edits. */
	draft: string;
	/** The Brief as approved, never edited afterwards. */
	brief: string;
	/** The Playbook in force at approval. */
	playbook: string;
	/** The Team's folder as it was at approval. */
	team: string;
	/** One line per approved act, with the sha of what was approved. */
	approvals: string;
	/** The Effort's whole state, one line per change. */
	log: string;
	/** Answers to escalated questions, which Teammates read as part of the Brief. */
	clarifications: string;
	/** A view of the plan, rewritten from the state whenever the plan or a Task's staffing changes. */
	plan: string;
	/** One folder per Task handed off, `tasks/<nnn>-<role>-<slug>/`. */
	tasks: string;
	/** One folder per Teammate, `teammates/<id>/`, with its launch files and its journal. */
	teammates: string;
	/** Where the Lead bridge listens, for the hook script's doorbell: {@link LeadRecord}. */
	lead: string;
}

export function effortsDir(agentDir: string): string {
	return join(agentDir, "team", "efforts");
}

export function effortPaths(agentDir: string, effortId: string): EffortPaths {
	const dir = join(effortsDir(agentDir), effortId);
	return {
		dir,
		draft: join(dir, "brief.draft.md"),
		brief: join(dir, "brief.md"),
		playbook: join(dir, "playbook.md"),
		team: join(dir, "team"),
		approvals: join(dir, "approvals.jsonl"),
		log: join(dir, "effort.jsonl"),
		clarifications: join(dir, "clarifications.md"),
		plan: join(dir, "plan.md"),
		tasks: join(dir, "tasks"),
		teammates: join(dir, "teammates"),
		lead: join(dir, "lead.json"),
	};
}

/**
 * Make a new Effort's directory. Its id is the Team and the day,
 * `software-2026-11-02`, numbered `-2`, `-3`, … when that is taken; creating
 * the directory is what claims the id, so two sessions never share one.
 */
export function createEffort(agentDir: string, team: string, now: Date): { effortId: string; paths: EffortPaths } {
	mkdirSync(effortsDir(agentDir), { recursive: true });
	const base = `${team}-${now.toISOString().slice(0, 10)}`;
	for (let n = 1; ; n++) {
		const effortId = n === 1 ? base : `${base}-${n}`;
		const paths = effortPaths(agentDir, effortId);
		try {
			mkdirSync(paths.dir);
			return { effortId, paths };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

/** The Effort's lines, oldest first. */
export function readLines(paths: EffortPaths): EffortLine[] {
	return readFileSync(paths.log, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as EffortLine);
}

export function appendLines(paths: EffortPaths, lines: readonly EffortLine[]): void {
	if (lines.length > 0) appendFileSync(paths.log, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

/** One line of `approvals.jsonl`: an approved act and the sha of everything it approved. */
export interface ApprovalRecord {
	act: "brief";
	/** The pending request the human answered. */
	request: string;
	/** Of `brief.md`. */
	brief: string;
	/** Of `playbook.md`. */
	playbook: string;
	/** Of the `team/` folder, as `teamDigest` computes it. */
	team: string;
	/** The Workspace the approval added, with the commit the Effort started from. */
	workspace?: Workspace;
	at: string;
}

/**
 * The sha256 of a folder: each file's path relative to it and its own sha256,
 * in path order, so a file added, removed, renamed or edited all change it.
 */
export function teamDigest(dir: string): string {
	const files: string[] = [];
	const walk = (folder: string) => {
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			const path = join(folder, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.push(path);
		}
	};
	walk(dir);
	const listing = files
		.map((path) => [relative(dir, path).split(sep).join("/"), sha256(readFileSync(path))] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([path, sha]) => `${path}\0${sha}\n`)
		.join("");
	return sha256(listing);
}

/**
 * Promote the snapshot the human approved to `brief.md`, copy the Playbook and
 * the Team in force beside it, and record the act with the Workspace it
 * added. Everything the Effort reads
 * from now on is these copies, so editing the human's own Team or Playbook
 * changes nothing here.
 */
export function promoteBrief(
	paths: EffortPaths,
	promotion: { approval: PendingApproval; playbookFile: string; teamDir: string; workspace?: Workspace; at: string },
): ApprovalRecord {
	writeFileSync(paths.brief, promotion.approval.snapshot);
	const playbook = readFileSync(promotion.playbookFile);
	writeFileSync(paths.playbook, playbook);
	cpSync(promotion.teamDir, paths.team, { recursive: true });
	const record: ApprovalRecord = {
		act: "brief",
		request: promotion.approval.id,
		brief: sha256(promotion.approval.snapshot),
		playbook: sha256(playbook),
		team: teamDigest(paths.team),
		...(promotion.workspace === undefined ? {} : { workspace: promotion.workspace }),
		at: promotion.at,
	};
	appendFileSync(paths.approvals, `${JSON.stringify(record)}\n`);
	return record;
}

/**
 * Check the Effort's approved records against `approvals.jsonl`. Each problem
 * names the record and both shas; a record with a problem is never used.
 */
export function checkRecords(paths: EffortPaths): string[] {
	if (!existsSync(paths.approvals)) return [`${paths.approvals} is missing, so nothing in this Effort is approved and no record can be trusted`];
	const records = readFileSync(paths.approvals, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as ApprovalRecord);
	const approved = [...records].reverse().find((record) => record.act === "brief");
	if (!approved) return [`${paths.approvals} records no approved Brief, so no record of this Effort can be trusted`];
	const problems: string[] = [];
	const compare = (name: string, actual: string | undefined, expected: string) => {
		if (actual !== expected) {
			problems.push(
				`${name} ${actual === undefined ? "is missing" : `has sha256 ${actual}`}, but the human approved ${expected} (${paths.approvals}); it has changed since approval, so it is not used`,
			);
		}
	};
	compare(paths.brief, existsSync(paths.brief) ? sha256(readFileSync(paths.brief)) : undefined, approved.brief);
	compare(paths.playbook, existsSync(paths.playbook) ? sha256(readFileSync(paths.playbook)) : undefined, approved.playbook);
	compare(`${paths.team}/`, existsSync(paths.team) ? teamDigest(paths.team) : undefined, approved.team);
	return problems;
}

/** What a Brief's frontmatter must agree with: the Effort it belongs to. */
export interface BriefExpectations {
	team: string;
	/** The git root the Effort works on. */
	repo: string;
	/** The Playbook in force, whose sha the Brief records and whose ids overrides name. */
	playbook: Playbook;
}

const BRIEF_FIELDS = ["team", "playbook", "repo", "overrides"];
const OVERRIDE_FIELDS = ["rule", "change", "reason"];
const SKIP = "skip";
const ADD_GRANT = "add grant:";

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^ ?(?:[-*+]|\d+[.)])\s+/;
const CRITERION = /^ ?(?:[-*+]|\d+[.)])\s+\*\*(AC\d+)\*\*/;

/**
 * Check a Brief draft against the skeleton, its Playbook and its Effort. Returns
 * every problem found, each naming what is wrong and what would be right; an
 * empty list means the human may be asked to approve it.
 */
export function validateBrief(text: string, expected: BriefExpectations): string[] {
	if (!/^---\r?\n/.test(text)) {
		return [`the Brief must open with YAML frontmatter between \`---\` lines, holding ${quoteList(BRIEF_FIELDS)}`];
	}
	let parsed: { frontmatter: unknown; body: string };
	try {
		parsed = parseFrontmatter(text);
	} catch (error) {
		return [`the Brief's frontmatter is not valid YAML: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`];
	}
	if (!isMapping(parsed.frontmatter)) return ["the Brief's frontmatter must be a YAML mapping of fields between `---` lines"];
	return [...checkFrontmatter(parsed.frontmatter, expected), ...checkBody(parsed.body, expected)];
}

function checkFrontmatter(fields: Record<string, unknown>, expected: BriefExpectations): string[] {
	const problems: string[] = [];
	for (const key of Object.keys(fields)) {
		if (!BRIEF_FIELDS.includes(key)) problems.push(`unknown field \`${key}\` in the Brief's frontmatter; the fields are ${quoteList(BRIEF_FIELDS)}`);
	}
	if (fields.team !== expected.team) {
		problems.push(`\`team: ${String(fields.team)}\` doesn't match: this Effort's Team is \`${expected.team}\``);
	}
	if (String(fields.playbook) !== expected.playbook.sha256) {
		problems.push(`\`playbook\` must be the sha256 of the Playbook in force, ${expected.playbook.sha256}, not \`${String(fields.playbook)}\``);
	}
	if (fields.repo !== expected.repo) {
		problems.push(`\`repo\` must be the Effort's repo, ${expected.repo}, not \`${String(fields.repo)}\``);
	}
	problems.push(...checkOverrides(fields.overrides, expected.playbook));
	return problems;
}

/** The ids a Brief's override may name: the Playbook's rules, checkpoints, grants and escalate entries. */
export function overridableIds(playbook: Playbook): string[] {
	return [...playbook.rules, ...playbook.checkpoints.map(({ id }) => id), ...playbook.grants.map(({ id }) => id), ...playbook.escalate.map(({ id }) => id)];
}

function checkOverrides(overrides: unknown, playbook: Playbook): string[] {
	if (overrides === undefined || overrides === null) return [];
	if (!Array.isArray(overrides)) return ["`overrides` must be a list of `{ rule, change, reason }`"];
	const known = overridableIds(playbook);
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const override of overrides) {
		if (!isMapping(override)) {
			problems.push("each override must be a mapping of `rule`, `change` and `reason`");
			continue;
		}
		for (const key of Object.keys(override)) {
			if (!OVERRIDE_FIELDS.includes(key)) problems.push(`unknown field \`${key}\` in an override; the fields are ${quoteList(OVERRIDE_FIELDS)}`);
		}
		const rule = override.rule;
		if (typeof rule !== "string" || !isKebabCase(rule)) {
			problems.push(`an override needs a \`rule\`: an id in kebab-case, not \`${String(rule)}\``);
			continue;
		}
		if (seen.has(rule)) problems.push(`\`${rule}\` is overridden more than once; give each rule one override`);
		seen.add(rule);
		const change = typeof override.change === "string" ? override.change.trim() : undefined;
		if (change === SKIP) {
			if (!known.includes(rule)) {
				problems.push(
					`override \`${rule}\` skips something the Playbook doesn't have: there is no rule, checkpoint, grant or escalate entry \`${rule}\`; the ids are ${quoteList(known)}`,
				);
			}
		} else if (change?.startsWith(ADD_GRANT) && change.slice(ADD_GRANT.length).trim() !== "") {
			if (known.includes(rule)) problems.push(`the \`add grant\` override \`${rule}\` needs a new id; the Playbook already has \`${rule}\``);
		} else {
			problems.push(`override \`${rule}\` has change \`${String(override.change)}\`; the changes are \`${SKIP}\` and \`${ADD_GRANT} <what it allows>\``);
		}
		if (typeof override.reason !== "string" || override.reason.trim() === "") {
			problems.push(`override \`${rule}\` needs a \`reason\`, saying why this Effort departs from the Playbook`);
		}
	}
	return problems;
}

/** The body's sections by lowercased heading, each with its lines. Only headings below the title count. */
function sections(body: string): Map<string, string[]> {
	const found = new Map<string, string[]>();
	let current: string[] | undefined;
	let level = 0;
	for (const line of body.split("\n")) {
		const heading = HEADING.exec(line);
		if (heading && heading[1].length >= 2) {
			level = heading[1].length;
			current = [];
			found.set(heading[2].toLowerCase(), current);
			continue;
		}
		if (heading && heading[1].length < 2) current = undefined;
		else if (heading && heading[1].length <= level) current = undefined;
		current?.push(line);
	}
	return found;
}

function checkBody(body: string, expected: BriefExpectations): string[] {
	const problems: string[] = [];
	const found = sections(body);
	for (const name of BRIEF_SKELETON) {
		if (!found.has(name.toLowerCase())) problems.push(`the Brief has no \`${name}\` section; every Brief has ${quoteList(BRIEF_SKELETON)}`);
	}
	for (const name of expected.playbook.briefSections) {
		if (!found.has(name.toLowerCase())) problems.push(`the Brief has no \`${name}\` section; the ${expected.team} Team's Playbook adds it`);
	}

	const scope = found.get("scope");
	if (scope) {
		for (const side of ["In", "Out"]) {
			const pattern = new RegExp(`^${side}\\s*:`, "i");
			if (!scope.some((line) => pattern.test(line.replace(/^\s*(?:[-*+]\s+)?/, "").replace(/\*/g, "")))) {
				problems.push(`\`Scope\` needs an \`${side}:\` line saying what is ${side === "In" ? "in" : "out of"} scope`);
			}
		}
	}

	const criteria = found.get("acceptance criteria");
	if (criteria) {
		const ids = new Map<string, number>();
		let items = 0;
		for (const line of criteria) {
			if (!LIST_ITEM.test(line)) continue;
			items++;
			const id = CRITERION.exec(line)?.[1];
			if (id === undefined) {
				problems.push(`every criterion starts with its id, \`**AC<n>**\`; this one doesn't: \`${line.trim()}\``);
				continue;
			}
			ids.set(id, (ids.get(id) ?? 0) + 1);
		}
		if (items === 0) problems.push("`Acceptance criteria` lists no criteria; write each as a list item starting `**AC<n>**`");
		for (const [id, count] of ids) {
			if (count > 1) problems.push(`the criterion id \`${id}\` is used more than once; each criterion's id must be unique`);
		}
	}
	return problems;
}

/**
 * The acceptance-criterion ids of an approved Brief, in the order written:
 * what a plan must cover.
 */
export function briefCriteria(text: string): string[] {
	const lines = sections(parseFrontmatter(text).body).get("acceptance criteria") ?? [];
	return lines.flatMap((line) => {
		const id = CRITERION.exec(line)?.[1];
		return id === undefined ? [] : [id];
	});
}

/**
 * Write `plan.md`, a view of the state's plan for the human to read. It is
 * rewritten whole from `effort.jsonl` each time, so editing it changes
 * nothing.
 */
export function writePlan(paths: EffortPaths, state: EffortState): void {
	const lines = [`# Plan of Effort \`${state.effortId}\``, "", "A view of `effort.jsonl`, rewritten by the team extension; editing it changes nothing.", ""];
	for (const task of state.plan ?? []) {
		const handed = state.tasks[task.slug];
		lines.push(
			`## ${task.slug}`,
			"",
			`- Role: ${task.role}`,
			`- Goal: ${task.goal}`,
			`- Depends on: ${task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "nothing"}`,
			`- Covers: ${task.criteria.length > 0 ? task.criteria.join(", ") : "no criterion"}`,
			`- Status: ${handed ? `running, with \`${handed.teammate}\` (tasks/${handed.folder}/)` : "planned"}`,
			"",
		);
	}
	writeFileSync(paths.plan, lines.join("\n"));
}

/**
 * The records a Teammate may never edit, as absolute paths (a folder as
 * `<folder>/**`): what the human approved, and the Effort's own state.
 */
export function protectedRecords(paths: EffortPaths): string[] {
	return [paths.brief, paths.clarifications, paths.approvals, paths.playbook, `${paths.team}/**`, paths.log];
}

/**
 * Write a handed-off Task's folder and its `task.md`, the self-contained
 * input the Teammate works from, and return the folder. `clarifications.md`
 * is made here when missing, since a Teammate is told to read it from its
 * first turn and answers to escalations are added to it later.
 */
export function writeTask(paths: EffortPaths, folder: string, body: string): string {
	const dir = join(paths.tasks, folder);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "task.md"), body);
	if (!existsSync(paths.clarifications)) {
		writeFileSync(paths.clarifications, "# Clarifications\n\nAnswers to questions the human was asked during this Effort. They count as part of the Brief.\n");
	}
	return dir;
}

function isMapping(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoteList(items: readonly string[]): string {
	return items.map((item) => `\`${item}\``).join(", ");
}

/** `lead.json`: the live Lead's bridge, which the hook script rings. */
export interface LeadRecord {
	pid: number;
	/** The bridge's port on 127.0.0.1. */
	port: number;
	/** The token a doorbell must carry. */
	token: string;
	/** The pi session file of the Lead, absent for a session kept in memory. */
	sessionFile?: string;
	startedAt: string;
}

/** Write `lead.json` whole, through a rename, so the hook script never reads half of it. */
export function writeLead(paths: EffortPaths, lead: LeadRecord): void {
	const partial = `${paths.lead}.${process.pid}.tmp`;
	writeFileSync(partial, `${JSON.stringify(lead)}\n`);
	renameSync(partial, paths.lead);
}

/** A Teammate's journal, `teammates/<id>/events.jsonl`, which the hook script appends to. */
export function journalFile(paths: EffortPaths, teammate: string): string {
	return join(paths.teammates, teammate, "events.jsonl");
}

/**
 * The lines of a Teammate's journal after line `after`, each with its cursor:
 * its line number, counted from 1. Only whole lines are read, so a line the
 * hook script is still writing waits for the next read. A line that isn't
 * JSON keeps its number and reads as a line with no event.
 */
export function readJournal(paths: EffortPaths, teammate: string, after: number): { cursor: number; line: JournalLine }[] {
	const file = journalFile(paths, teammate);
	if (!existsSync(file)) return [];
	const whole = readFileSync(file, "utf8").split("\n").slice(0, -1);
	return whole.slice(after).map((text, index) => ({ cursor: after + index + 1, line: journalLine(text) }));
}

function journalLine(text: string): JournalLine {
	try {
		const parsed: unknown = JSON.parse(text);
		if (isMapping(parsed)) return { ...parsed, from: String(parsed.from ?? ""), at: String(parsed.at ?? "") } as JournalLine;
	} catch {
		// Kept as a line with no event below.
	}
	return { from: "unreadable", at: "" };
}
