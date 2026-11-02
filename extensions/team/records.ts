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
import { type Clarification, type EffortLine, type EffortState, type JournalLine, type PendingApproval, type Report, taskStatus, type Workspace } from "./core.ts";
import { BRIEF_SKELETON, isKebabCase, type Playbook, sha256 } from "./definitions.ts";
import type { AnswerTerms, CitableGrant } from "./requests.ts";

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
	/** One file per Report, `reports/<nnn>.md`, numbered from 001 and never overwritten. */
	reports: string;
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
		reports: join(dir, "reports"),
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
export type ApprovalRecord = BriefRecord | BriefChangeRecord | CheckpointRecord | SignOffRecord | PlaybookChangeRecord;

/** The Brief's approval, which every record the Effort reads afterwards is checked against. */
export interface BriefRecord {
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
 * A Brief change the human approved: `brief.md` is now its snapshot, while
 * the Playbook and Team snapshots stay those the Brief approval recorded.
 */
export interface BriefChangeRecord {
	act: "brief-change";
	request: string;
	/** Of `brief.md` as the change left it. */
	brief: string;
	/** The planned Tasks it held until the answer. */
	affects: string[];
	at: string;
}

/** An approval at one of the Playbook's checkpoints or `escalate` ids. */
export interface CheckpointRecord {
	act: "checkpoint";
	/** The checkpoint or `escalate` id. */
	checkpoint: string;
	request: string;
	/** The file asked about. */
	path: string;
	/** Of that file as the human saw it. */
	sha256: string;
	at: string;
}

/**
 * Make an approved Brief change the Effort's `brief.md` and record it. Only
 * the Brief moves: the Playbook and Team stay the snapshots taken at Brief
 * approval, which the change was checked against.
 */
export function promoteBriefChange(paths: EffortPaths, promotion: { approval: PendingApproval; at: string }): BriefChangeRecord {
	writeFileSync(paths.brief, promotion.approval.snapshot);
	const record: BriefChangeRecord = {
		act: "brief-change",
		request: promotion.approval.id,
		brief: sha256(promotion.approval.snapshot),
		affects: [...(promotion.approval.affects ?? [])],
		at: promotion.at,
	};
	recordApproval(paths, record);
	return record;
}

/** The human's sign-off of the final Report, which ends the Effort. */
export interface SignOffRecord {
	act: "sign-off";
	request: string;
	/** Of the final Report's file, as the human signed it off. */
	report: string;
	at: string;
}

/** A Playbook change the human adopted for the Team's next Effort. */
export interface PlaybookChangeRecord {
	act: "playbook-change";
	request: string;
	/** The change's id in the final Report. */
	change: string;
	/** Of the change as the human saw it. */
	sha256: string;
	/** Of the adopted Playbook it made. */
	playbook: string;
	at: string;
}

/** Add an approved act to the Effort's `approvals.jsonl`. */
export function recordApproval(paths: EffortPaths, record: ApprovalRecord): void {
	appendFileSync(paths.approvals, `${JSON.stringify(record)}\n`);
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
): BriefRecord {
	writeFileSync(paths.brief, promotion.approval.snapshot);
	const playbook = readFileSync(promotion.playbookFile);
	writeFileSync(paths.playbook, playbook);
	cpSync(promotion.teamDir, paths.team, { recursive: true });
	const record: BriefRecord = {
		act: "brief",
		request: promotion.approval.id,
		brief: sha256(promotion.approval.snapshot),
		playbook: sha256(playbook),
		team: teamDigest(paths.team),
		...(promotion.workspace === undefined ? {} : { workspace: promotion.workspace }),
		at: promotion.at,
	};
	recordApproval(paths, record);
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
	const approved = [...records].reverse().find((record): record is BriefRecord => record.act === "brief");
	if (!approved) return [`${paths.approvals} records no approved Brief, so no record of this Effort can be trusted`];
	// The Brief is the one the latest approval of it left, which a Brief change can be.
	const brief = [...records].reverse().find((record): record is BriefRecord | BriefChangeRecord => record.act === "brief" || record.act === "brief-change") ?? approved;
	const problems: string[] = [];
	const compare = (name: string, actual: string | undefined, expected: string) => {
		if (actual !== expected) {
			problems.push(
				`${name} ${actual === undefined ? "is missing" : `has sha256 ${actual}`}, but the human approved ${expected} (${paths.approvals}); it has changed since approval, so it is not used`,
			);
		}
	};
	compare(paths.brief, existsSync(paths.brief) ? sha256(readFileSync(paths.brief)) : undefined, brief.brief);
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
 * What an approved Brief and its Playbook let the Lead allow, for
 * `team_answer`'s guard: the Playbook's grants and those the Brief's overrides
 * add, less those it skips; its Delivery text; and the `escalate` entries it
 * doesn't skip. `workspace` is where the requesting Teammate works.
 */
export function answerTerms(playbook: Playbook, text: string, workspace: string): AnswerTerms {
	const { frontmatter, body } = parseFrontmatter(text);
	const overrides = isMapping(frontmatter) && Array.isArray(frontmatter.overrides) ? frontmatter.overrides.filter(isMapping) : [];
	const skipped = new Set(overrides.flatMap((each) => (typeof each.rule === "string" && typeof each.change === "string" && each.change.trim() === SKIP ? [each.rule] : [])));
	const added = overrides.flatMap((each): CitableGrant[] => {
		const change = typeof each.change === "string" ? each.change.trim() : "";
		return typeof each.rule === "string" && change.startsWith(ADD_GRANT) ? [{ id: each.rule, allow: change.slice(ADD_GRANT.length).trim(), from: "Brief" }] : [];
	});
	const delivery = (sections(body).get("delivery") ?? []).join("\n").trim().replace(/\s+/g, " ");
	return {
		workspace,
		grants: [...playbook.grants.filter(({ id }) => !skipped.has(id)).map(({ id, allow }): CitableGrant => ({ id, allow, from: "Playbook" })), ...added],
		...(delivery === "" ? {} : { delivery }),
		escalate: playbook.escalate.filter(({ id }) => !skipped.has(id)).map(({ id, ask }) => ({ id, ask })),
	};
}

/**
 * Write `plan.md`, a view of the state's plan for the human to read. It is
 * rewritten whole from `effort.jsonl` each time, so editing it changes
 * nothing.
 */
export function writePlan(paths: EffortPaths, state: EffortState): void {
	const lines = [`# Plan of Effort \`${state.effortId}\``, "", "A view of `effort.jsonl`, rewritten by the team extension; editing it changes nothing.", ""];
	for (const task of state.plan ?? []) {
		// A dropped handoff is over: a Task planned again waits for a fresh one.
		const handed = state.tasks[task.slug]?.dropped === undefined ? state.tasks[task.slug] : undefined;
		const sendBacks = handed?.sendBacks ?? 0;
		lines.push(
			`## ${task.slug}`,
			"",
			`- Role: ${task.role}`,
			`- Goal: ${task.goal}`,
			`- Depends on: ${task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "nothing"}`,
			`- Covers: ${task.criteria.length > 0 ? task.criteria.join(", ") : "no criterion"}`,
			`- Status: ${taskStatus(state, task.slug)}${handed ? `, with \`${handed.teammate}\` (tasks/${handed.folder}/)` : ""}${sendBacks > 0 ? `; sent back ${sendBacks} time${sendBacks === 1 ? "" : "s"}` : ""}`,
			"",
		);
	}
	const dropped = Object.entries(state.tasks).filter(([slug]) => taskStatus(state, slug) === "dropped");
	if (dropped.length > 0) lines.push("## Dropped", "", ...dropped.map(([slug, task]) => `- ${slug}: was with \`${task.teammate}\` (tasks/${task.folder}/)`), "");
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
		writeFileSync(paths.clarifications, CLARIFICATIONS_HEADER);
	}
	return dir;
}

const CLARIFICATIONS_HEADER = "# Clarifications\n\nAnswers to questions the human was asked during this Effort. They count as part of the Brief.\n";

/**
 * Append the human's answer to an escalated question to `clarifications.md`,
 * with who asked, on which Task, and what the Brief says of it. The file is
 * only ever appended to, so `brief.md` and its sha stay as approved.
 */
export function appendClarification(paths: EffortPaths, entry: Clarification): void {
	if (!existsSync(paths.clarifications)) writeFileSync(paths.clarifications, CLARIFICATIONS_HEADER);
	const when = `${entry.at.slice(0, 10)} ${entry.at.slice(11, 16)}`;
	const lines = [
		"",
		`## \`${entry.id}\`: ${entry.teammate}${entry.task === undefined ? "" : `, Task \`${entry.task}\``}, ${when}`,
		"",
		`- Asked: ${entry.question}`,
		`- Lead's summary: ${entry.summary}`,
		...(entry.brief === undefined ? [] : [`- The Brief says: ${entry.brief}`]),
		`- The human's answer (${entry.via === "pending" ? "in `/team pending`" : "in chat, relayed by the Lead"}): ${entry.answer}`,
	];
	appendFileSync(paths.clarifications, `${lines.join("\n")}\n`);
}

/**
 * Write the feedback of a send-back as `feedback-<round>.md` in the Task's
 * folder, and return its path. Refused when that file is already there: no
 * file in a Task folder is ever overwritten across rounds.
 */
export function writeFeedback(paths: EffortPaths, folder: string, round: number, feedback: string): string {
	const path = join(paths.tasks, folder, `feedback-${round}.md`);
	try {
		writeFileSync(path, `# Feedback on round ${round}\n\n${feedback.trim()}\n`, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		throw new Error(`${path} is already there, and no file in a Task folder is ever overwritten, so nothing was sent back. Stop and tell the human.`);
	}
	return path;
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

/**
 * `lead.json` once its Lead has left: marked, never deleted, so the session
 * that led it is still known. It has no bridge, so the hook script rings no one.
 */
export interface NoLiveLead {
	pid: number;
	sessionFile?: string;
	startedAt: string;
	/** When the Lead left; its mark. */
	stoppedAt: string;
}

/** Write `lead.json` whole, through a rename, so the hook script never reads half of it. */
export function writeLead(paths: EffortPaths, lead: LeadRecord | NoLiveLead): void {
	const partial = `${paths.lead}.${process.pid}.tmp`;
	writeFileSync(partial, `${JSON.stringify(lead)}\n`);
	renameSync(partial, paths.lead);
}

/** What `lead.json` says, or undefined before the Effort was ever led. */
export function readLead(paths: EffortPaths): LeadRecord | NoLiveLead | undefined {
	if (!existsSync(paths.lead)) return undefined;
	let lead: unknown;
	try {
		lead = JSON.parse(readFileSync(paths.lead, "utf8"));
	} catch (error) {
		lead = error;
	}
	if (!isMapping(lead) || typeof lead.pid !== "number" || typeof lead.startedAt !== "string") {
		throw new Error(`${paths.lead} isn't a Lead record of \`{ pid, port, token, sessionFile, startedAt }\`; only the extension writes it. Move it aside once no pi session leads the Effort, and lead it again.`);
	}
	return lead as unknown as LeadRecord | NoLiveLead;
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

/** A Report as the human reads it, in chat and in `reports/<nnn>.md`. */
export function reportMarkdown(effortId: string, report: Report): string {
	const parts = [`# ${report.final ? "Final Report" : "Report"} ${report.n} · Effort \`${effortId}\``, `_${report.at.slice(0, 10)} ${report.at.slice(11, 16)} UTC_`, report.headline];
	if (report.coverage.length > 0) parts.push(`## Brief coverage\n\n${report.coverage.map(({ criterion, note }) => `- ${criterion}: ${note.trim()}`).join("\n")}`);
	for (const section of report.sections) parts.push(`## ${section.title}\n\n${section.lines.map((line) => `- ${line}`).join("\n")}`);
	return `${parts.join("\n\n")}\n`;
}

/** The file Report `n` is written to. */
export function reportFile(paths: EffortPaths, n: number): string {
	return join(paths.reports, `${String(n).padStart(3, "0")}.md`);
}

/** Write a Report to its own file, which is never overwritten; returns its path. */
export function writeReport(paths: EffortPaths, markdown: string, n: number): string {
	const path = reportFile(paths, n);
	mkdirSync(paths.reports, { recursive: true });
	try {
		writeFileSync(path, markdown, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		throw new Error(`${path} is already there, and a Report is never overwritten, so Report ${n} wasn't written. Stop and tell the human.`);
	}
	return path;
}

/** A Report on disk, as `/team reports` lists it. */
export interface WrittenReport {
	n: number;
	path: string;
	/** `HH:MM` UTC, when the file says. */
	time: string | undefined;
	headline: string;
	markdown: string;
}

/** The Effort's Reports, newest first, read from `reports/`. */
export function readReports(paths: EffortPaths): WrittenReport[] {
	if (!existsSync(paths.reports)) return [];
	return readdirSync(paths.reports)
		.filter((name) => /^\d{3,}\.md$/.test(name))
		.map((name) => {
			const path = join(paths.reports, name);
			const markdown = readFileSync(path, "utf8");
			const lines = markdown.split("\n").map((line) => line.trim());
			const stamp = lines.findIndex((line) => /^_\d{4}-\d\d-\d\d \d\d:\d\d UTC_$/.test(line));
			const headline = lines.slice(stamp + 1).find((line) => line !== "" && !line.startsWith("#")) ?? "";
			return { n: Number.parseInt(name, 10), path, time: stamp >= 0 ? lines[stamp].slice(12, 17) : undefined, headline, markdown };
		})
		.sort((a, b) => b.n - a.n);
}
