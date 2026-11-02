/**
 * team — a Lead in pi running a Team of Claude Code Teammates on one Effort.
 *
 * This file is wiring and nothing else. Teams, Roles and Playbooks are read
 * and checked by `definitions.ts`; what `/team start` says is decided by
 * `start.ts`; an Effort's state is folded and stepped by `core.ts`, and its
 * files are kept by `records.ts`; the `claude` executable is known only to
 * `claude.ts`.
 *
 * Every path root is injected through {@link TeamDeps}, so tests point the
 * extension at temp folders and a fake `claude`, and nothing reaches the
 * human's real agent dir or Claude Code config.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { launchBackground, teammateArgs, teammateSettings, trustFolder, versionWarning } from "./claude.ts";
import { type EffortAction, type EffortState, fold, openEffort, type PendingApproval, refuseRequest, type Step, step, type Workspace } from "./core.ts";
import { EVERY_ROLE, listTeams, loadTeam, type Playbook, readSnapshot, type Role, sha256, type Team, type TeamRoots } from "./definitions.ts";
import { briefApprovalTitle, intakePrompt, openedText } from "./intake.ts";
import { appendLines, briefCriteria, checkRecords, createEffort, type EffortPaths, promoteBrief, protectedRecords, readLines, validateBrief, writePlan, writeTask } from "./records.ts";
import { repoRoot } from "./repo.ts";
import { addWorkspace } from "./workspace.ts";
import {
	ADOPT_PLAYBOOK,
	APPROVE,
	adoptedText,
	adoptionRequested,
	adoptPlaybook,
	beginSetup,
	LATER,
	modeInForce,
	type PendingAdoption,
	pendingAdoptionTitle,
	requestAdoption,
	SEND_BACK,
	sentBackText,
	setupTeam,
	type TeamSetup,
} from "./setup.ts";
import { pickTeam, proposeTeam, type StartOutcome } from "./start.ts";
import { handoffPointer, teammatePrompt } from "./teammate.ts";

/** The Lead's tools while this session runs Team setup. */
const SETUP_TOOLS = ["team_request_approval"];
/** The Lead's tools while this session holds an Effort. */
const EFFORT_TOOLS = ["team_request_approval", "team_plan", "team_handoff"];
/** Every Lead tool: registered at load, and switched on only by what the session runs. */
const LEAD_TOOLS = [...new Set([...SETUP_TOOLS, ...EFFORT_TOOLS])];

const RequestApprovalParams = Type.Object({
	checkpoint: Type.String({ description: "Which checkpoint: `brief` for an Effort's Brief, `adopt-playbook` during Team setup." }),
	path: Type.String({ description: "The draft to approve: the Effort's `brief.draft.md`, or the Team setup's Playbook draft." }),
});

const PlanParams = Type.Object({
	tasks: Type.Array(
		Type.Object({
			slug: Type.String({ description: "The Task's kebab-case slug, unique in the Effort." }),
			role: Type.String({ description: "The Role that does it." }),
			goal: Type.String({ description: "What the Task is for, in a sentence." }),
			dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Slugs of the Tasks it waits for." })),
			criteria: Type.Optional(Type.Array(Type.String(), { description: "Ids of the Brief's acceptance criteria it covers, such as `AC1`." })),
		}),
		{ description: "The whole Task list." },
	),
});

const HandoffParams = Type.Object({
	slug: Type.String({ description: "The planned Task to hand off." }),
	body: Type.String({ description: "The `task.md` body the Teammate works from." }),
	isolated: Type.Optional(Type.Boolean({ description: "Whether the Task needs a worktree of its own." })),
});

/** Where the extension finds everything outside itself. Each defaults to the real thing. */
export interface TeamDeps {
	/** pi's agent dir, `~/.pi/agent`. Injected by tests, and by nothing else. */
	agentDir?: string;
	/** Claude Code's config file, `~/.claude.json`. Injected by tests, and by nothing else. */
	claudeConfigPath?: string;
	/** The `claude` executable. Injected by tests, and by nothing else. */
	claudePath?: string;
	/** The bundled Teams. Injected by tests, and by nothing else. */
	bundledTeamsDir?: string;
	/** The clock adoption times are read from. Injected by tests, and by nothing else. */
	now?: () => Date;
}

/** The paths the extension runs against once defaults are filled in. */
interface Paths extends TeamRoots {
	claudeConfigPath: string;
	claudePath: string;
}

/** The Effort this session holds. Its state is only ever what its `effort.jsonl` folds to. */
interface HeldEffort {
	effortId: string;
	paths: EffortPaths;
}

/** One `/team` subcommand. */
interface Subcommand {
	run(args: string[], ctx: ExtensionCommandContext): Promise<void>;
}

export function registerTeam(pi: ExtensionAPI, deps: TeamDeps = {}): void {
	const paths: Paths = {
		agentDir: deps.agentDir ?? getAgentDir(),
		bundledTeamsDir: deps.bundledTeamsDir,
		claudeConfigPath: deps.claudeConfigPath ?? join(homedir(), ".claude.json"),
		claudePath: deps.claudePath ?? "claude",
	};
	const now = deps.now ?? (() => new Date());

	// What this session is running, which decides whether the Lead's tools are on.
	let setup: TeamSetup | undefined;
	// Playbook adoptions waiting on the human in `/team pending`, oldest first. An Effort's own wait in its `effort.jsonl`.
	let pending: PendingAdoption[] = [];
	// The one Effort this session's Lead holds.
	let effort: HeldEffort | undefined;

	function syncLeadTools(): void {
		const others = pi.getActiveTools().filter((name) => !LEAD_TOOLS.includes(name));
		pi.setActiveTools([...others, ...(effort ? EFFORT_TOOLS : setup ? SETUP_TOOLS : [])]);
	}

	function effortState(held: HeldEffort): EffortState {
		return fold(readLines(held.paths));
	}

	/**
	 * The Team and Playbook an Effort runs on, until its Brief is approved and
	 * snapshots them: the Team as it is now, on the Playbook adopted when the
	 * Effort opened. A Playbook adopted again or edited since is refused, since
	 * the Brief records the one it was agreed under.
	 */
	function inForce(state: EffortState): { team: Team; playbook: Playbook } | { error: string } {
		const team = loadTeam(paths, state.team);
		if (!team) return { error: `Team \`${state.team}\` of Effort \`${state.effortId}\` no longer exists` };
		if (team.adoption.state !== "adopted" || team.adoption.playbook.sha256 !== state.playbook) {
			const now = team.adoption.state === "adopted" ? `is now ${team.adoption.playbook.sha256}` : `is ${team.adoption.state}`;
			return {
				error: `the \`${state.team}\` Playbook Effort \`${state.effortId}\` opened on (sha256 ${state.playbook}) ${now}, so its Brief can no longer be checked against it; start a new Effort on the Playbook in force`,
			};
		}
		return { team, playbook: team.adoption.playbook };
	}

	function wakeLead(customType: string, text: string): void {
		pi.sendMessage({ customType, content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
	}

	function runSetup(team: Team, startsTeam: boolean): void {
		const begun = beginSetup(paths.agentDir, team, startsTeam);
		// A setup for another Team ends the one before it, and with it what that one asked.
		pending = pending.filter((item) => item.team === team.name);
		setup = begun.setup;
		syncLeadTools();
		wakeLead("team-setup", begun.prompt);
	}

	function land(outcome: StartOutcome, ctx: ExtensionCommandContext): void {
		switch (outcome.kind) {
			case "notify":
				ctx.ui.notify(outcome.text, outcome.level);
				return;
			case "ask-lead":
				wakeLead("team-start", outcome.text);
				return;
			case "setup":
				ctx.ui.notify(outcome.text, "info");
				runSetup(outcome.team, true);
				return;
			case "intake":
				openIntake(outcome.team, outcome.playbook, outcome.text, ctx);
				return;
		}
	}

	/** Open an Effort on the Team in the repo pi runs in, and wake the Lead to draft its Brief. */
	function openIntake(team: Team, playbook: Playbook, picked: string, ctx: ExtensionCommandContext): void {
		const repo = repoRoot(ctx.cwd);
		if ("error" in repo) {
			ctx.ui.notify(`Team \`${team.name}\` can't open an Effort here: ${repo.error}. An Effort works on a git repo, which its Brief records; start pi in that repo and run \`/team start ${team.name}\` again.`, "error");
			return;
		}
		const at = now();
		const { effortId, paths: files } = createEffort(paths.agentDir, team.name, at);
		appendLines(files, [openEffort({ effortId, team: team.name, repo: repo.root, playbook: playbook.sha256, at: at.toISOString() })]);
		pi.appendEntry("team-effort", { effortId, effortDir: files.dir });
		effort = { effortId, paths: files };
		syncLeadTools();
		ctx.ui.notify(openedText(picked, effortId, files), "info");
		wakeLead("team-intake", intakePrompt({ effortId, paths: files, team, playbook, repo: repo.root }));
	}

	/** A Brief in `/team pending`: approve, send back with a note, or leave it for later. */
	async function answerBrief(held: HeldEffort, item: PendingApproval, ctx: ExtensionCommandContext): Promise<void> {
		const state = effortState(held);
		const found = inForce(state);
		if ("error" in found) {
			ctx.ui.notify(`The Brief of Effort \`${state.effortId}\` (request \`${item.id}\`) can't be approved: ${found.error}.`, "error");
			return;
		}
		const answer = await ctx.ui.select(briefApprovalTitle(item, { effortId: state.effortId, team: found.team, playbook: found.playbook, repo: state.repo }), [
			APPROVE,
			SEND_BACK,
			LATER,
		]);
		let note: string | undefined;
		if (answer === SEND_BACK) {
			note = (await ctx.ui.input("Note for the Lead: what should change?"))?.trim();
			// Backing out of the note leaves the item waiting, as "later" does.
			if (!note) return;
		} else if (answer !== APPROVE) {
			return;
		}
		if (answer === APPROVE) {
			// Checked again against what is in force now, since the snapshot may have waited a while.
			const problems = validateBrief(item.snapshot, { team: state.team, repo: state.repo, playbook: found.playbook });
			if (problems.length > 0) {
				ctx.ui.notify(`The Brief of Effort \`${state.effortId}\` (request \`${item.id}\`) can't be approved:\n${bullets(problems)}`, "error");
				return;
			}
		}
		const at = now().toISOString();
		const answered = { kind: "answer", id: item.id, answer: answer === APPROVE ? "approved" : "sent-back", note, at } as const;
		let result = step(state, answered);
		if (!result.ok) {
			ctx.ui.notify(result.refusal, "error");
			return;
		}
		// The core is pure, so the answer is known to stand before the Workspace changes the human's repo.
		let workspace: Workspace | undefined;
		if (answer === APPROVE) {
			const added = addEffortWorkspace(state, found.team);
			if ("error" in added) {
				ctx.ui.notify(`The Brief of Effort \`${state.effortId}\` (request \`${item.id}\`) can't be approved yet: ${added.error}. Nothing was approved; answer it again from \`/team pending\` once that is fixed.`, "error");
				return;
			}
			workspace = added.workspace;
			result = step(state, { ...answered, workspace });
			if (!result.ok) throw new Error(`the Effort core refused an answer it had just accepted: ${result.refusal}`);
		}
		// The records are written before the line that approves them, so the log never claims an approval its records lack.
		for (const action of result.actions) {
			if (action.kind === "promote-brief") promoteBrief(held.paths, { approval: action.approval, playbookFile: found.playbook.filePath, teamDir: found.team.dir, workspace, at });
		}
		appendLines(held.paths, result.append);
		if (answer === APPROVE) {
			const where = workspace ? ` Workspace: ${workspace.path} on \`${workspace.branch}\`, from \`${workspace.from}\` at ${workspace.base}.` : "";
			ctx.ui.notify(`Approved the Brief of Effort \`${state.effortId}\`: ${held.paths.brief}, sha256 ${item.sha256}.${where}`, "info");
		}
		for (const action of result.actions) {
			if (action.kind === "wake-lead") wakeLead("team-pending", action.text);
		}
	}

	/**
	 * What Brief approval sets up before any Teammate starts: folder trust for
	 * the repo in Claude Code's config, then the Workspace of the Team's kind.
	 * Trust comes first, since it changes nothing git would refuse to redo.
	 */
	function addEffortWorkspace(state: EffortState, team: Team): { workspace: Workspace } | { error: string } {
		if (team.workspace === undefined) return { error: `Team \`${team.name}\` names no \`workspace\` kind in its team.md` };
		const untrusted = trustFolder(paths.claudeConfigPath, state.repo);
		if (untrusted) return untrusted;
		return addWorkspace(team.workspace, state.repo, state.effortId);
	}

	/** `team_request_approval` at the Effort's checkpoint: check the Brief, snapshot it and add it to `/team pending`. */
	function requestBriefApproval(held: HeldEffort, checkpoint: string, path: string): string {
		const state = effortState(held);
		const refusal = refuseRequest(state, checkpoint);
		if (refusal !== undefined) throw new Error(refusal);
		if (path !== held.paths.draft) {
			throw new Error(`Only the Effort's own Brief draft can be asked about: ${held.paths.draft}, not ${path}.`);
		}
		if (!existsSync(path)) throw new Error(`There is no Brief draft at ${path} yet; write the Brief there first.`);
		const bytes = readFileSync(path);
		let snapshot: string;
		try {
			snapshot = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new Error(`The Brief draft ${path} is not valid UTF-8 text; write it as markdown.`);
		}
		const found = inForce(state);
		if ("error" in found) throw new Error(`The Brief of Effort \`${state.effortId}\` can't be asked about: ${found.error}.`);
		const problems = validateBrief(snapshot, { team: state.team, repo: state.repo, playbook: found.playbook });
		if (problems.length > 0) throw new Error(`The Brief ${path} can't be asked about until these are fixed:\n${bullets(problems)}`);
		const result = step(state, { kind: "request-approval", checkpoint, path, sha256: sha256(bytes), snapshot, at: now().toISOString() });
		if (!result.ok) throw new Error(result.refusal);
		appendLines(held.paths, result.append);
		return result.reply ?? "";
	}

	/**
	 * The Effort a Lead tool that leads to a Teammate works on: refused before
	 * the Brief is approved, and on any record changed since.
	 */
	function approvedEffort(tool: "team_plan" | "team_handoff", ctx: ExtensionContext): { held: HeldEffort; state: EffortState } {
		if (!effort) throw new Error(`No Effort is open in this session, so \`${tool}\` has nothing to work on; the human opens one with \`/team start <team>\`.`);
		const state = effortState(effort);
		const result = step(state, { kind: "start-teammate", tool });
		if (!result.ok) throw new Error(result.refusal);
		const problems = checkRecords(effort.paths);
		if (problems.length > 0) {
			const text = `Effort \`${effort.effortId}\` has records that changed since the human approved them, so they are not used:\n${bullets(problems)}`;
			ctx.ui.notify(text, "error");
			throw new Error(`${text}\n\nStop and tell the human; \`${tool}\` runs again once the records match their approval.`);
		}
		return { held: effort, state };
	}

	/** The Roles and Playbook the Effort snapshotted at Brief approval, which is all it staffs from. */
	function snapshotOf(held: HeldEffort): { roles: Role[]; playbook: Playbook } {
		const found = readSnapshot(held.paths.team, held.paths.playbook);
		if ("problems" in found) {
			const problems = found.problems.map((problem) => `${problem.filePath}: ${problem.reason}`);
			throw new Error(`The Team snapshot of Effort \`${held.effortId}\` can't be read, so no Teammate starts:\n${bullets(problems)}\n\nStop and tell the human.`);
		}
		return found;
	}

	/** Carry out a step's actions in order, then append its lines: records are written before the line that claims them. */
	async function carryOut(held: HeldEffort, result: Extract<Step, { ok: true }>, launch: (action: Extract<EffortAction, { kind: "launch-teammate" }>) => Promise<void>): Promise<void> {
		for (const action of result.actions) {
			if (action.kind === "write-plan") writePlan(held.paths, result.state);
			else if (action.kind === "launch-teammate") await launch(action);
		}
		appendLines(held.paths, result.append);
	}

	/** One adoption in `/team pending`: approve, send back with a note, or leave it for later. */
	async function answerAdoption(item: PendingAdoption, ctx: ExtensionCommandContext): Promise<void> {
		const answer = await ctx.ui.select(pendingAdoptionTitle(item), [APPROVE, SEND_BACK, LATER]);
		if (answer === APPROVE) {
			const adopted = adoptPlaybook(paths.agentDir, item, now());
			pending = pending.filter((waiting) => waiting !== item);
			const startsTeam = setup?.team === item.team && setup.startsTeam;
			if (setup?.team === item.team) setup = undefined;
			syncLeadTools();
			ctx.ui.notify(`Adopted the \`${item.team}\` Playbook: ${adopted}.`, "info");
			wakeLead("team-pending", adoptedText(item, adopted));
			if (startsTeam) land(pickTeam(listTeams(paths), item.team), ctx);
		} else if (answer === SEND_BACK) {
			const note = (await ctx.ui.input("Note for the Lead: what should change?"))?.trim();
			// Backing out of the note leaves the item waiting, as "later" does.
			if (!note) return;
			pending = pending.filter((waiting) => waiting !== item);
			wakeLead("team-pending", sentBackText(item, note));
		}
	}

	// Each subcommand is one row, so later ones are added without touching the rest.
	const subcommands: Record<string, Subcommand> = {
		start: {
			async run(args, ctx) {
				if (effort) {
					ctx.ui.notify(
						`This session already holds Effort \`${effort.effortId}\` (${effort.paths.dir}), and a Lead holds one Effort at a time; start another from a new pi session.`,
						"error",
					);
					return;
				}
				const warning = await versionWarning(paths.claudePath);
				if (warning) ctx.ui.notify(warning, "warning");
				// Read fresh every time, so a fixed file is picked up without `/reload`.
				const teams = listTeams(paths);
				land(args[0] === undefined ? proposeTeam(teams) : pickTeam(teams, args[0]), ctx);
			},
		},
		setup: {
			async run(args, ctx) {
				const found = setupTeam(listTeams(paths), args[0], paths.agentDir);
				if ("error" in found) {
					ctx.ui.notify(found.error, "error");
					return;
				}
				runSetup(found.team, false);
			},
		},
		pending: {
			async run(_args, ctx) {
				const held = effort;
				const briefs = held ? effortState(held).pending : [];
				if (pending.length === 0 && briefs.length === 0) {
					ctx.ui.notify("Nothing is waiting on you.", "info");
					return;
				}
				for (const item of [...pending]) await answerAdoption(item, ctx);
				if (held) for (const item of briefs) await answerBrief(held, item, ctx);
			},
		},
	};
	const valid = Object.keys(subcommands)
		.map((name) => `\`${name}\``)
		.join(", ");

	pi.registerTool({
		name: "team_request_approval",
		label: "Request approval",
		description: [
			"Ask the human to approve a draft at one of the Team's checkpoints: the Effort's Brief at `brief`, or a Playbook at `adopt-playbook` during Team setup.",
			"Validates the draft, snapshots it with its sha256 and adds a pending item the human answers in `/team pending`; returns at once without waiting for the answer.",
			"Agreement in chat never counts: only the human's approval in `/team pending` does.",
		].join(" "),
		promptSnippet: "Ask the human to approve a draft, such as the Effort's Brief or a Playbook to adopt, from `/team pending`",
		parameters: RequestApprovalParams,
		defaultActive: false,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const path = resolve(ctx.cwd, params.path);
			if (effort && params.checkpoint !== ADOPT_PLAYBOOK) {
				return { content: [{ type: "text", text: requestBriefApproval(effort, params.checkpoint, path) }], details: undefined };
			}
			const team = setup ? loadTeam(paths, setup.team) : undefined;
			const item = requestAdoption(setup, team, params.checkpoint, path);
			// A newer request for the same Team replaces the one the human hasn't answered.
			pending = [...pending.filter((waiting) => waiting.team !== item.team), item];
			return { content: [{ type: "text", text: adoptionRequested(item) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "team_plan",
		label: "Plan",
		description: [
			"Write the Effort's whole Task list: each Task's slug, Role, goal, the Tasks it depends on and the acceptance-criterion ids it covers.",
			"Refused when a Brief criterion is left uncovered or a Task names a Role the Team doesn't have. Planning again replaces the list; a Task already handed off keeps its Role.",
			"Writes `plan.md` in the Effort directory as a view. Refused until the human approves the Brief.",
		].join(" "),
		promptSnippet: "Write the Effort's Task list once its Brief is approved",
		parameters: PlanParams,
		defaultActive: false,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { held, state } = approvedEffort("team_plan", ctx);
			const { roles } = snapshotOf(held);
			const criteria = briefCriteria(readFileSync(held.paths.brief, "utf8"));
			const result = step(state, { kind: "plan", tasks: params.tasks, criteria, roles: roles.map((role) => role.name), at: now().toISOString() });
			if (!result.ok) throw new Error(result.refusal);
			await carryOut(held, result, async () => {});
			return { content: [{ type: "text", text: result.reply ?? "" }], details: undefined };
		},
	});

	pi.registerTool({
		name: "team_handoff",
		label: "Hand off",
		description: [
			"Hand a planned Task to a new Teammate of its Role, launched as a Claude Code background session in the Effort's Workspace.",
			"`body` becomes the Task's `task.md`: make it self-contained, listing the Effort's `brief.md` and `clarifications.md` among its inputs, since the Teammate has no earlier conversation.",
			"Returns which Teammate started. Refused until the human approves the Brief, for a Task that isn't planned or is already running, and for `isolated`, which isn't built yet.",
		].join(" "),
		promptSnippet: "Hand a planned Task to a Teammate once the Brief is approved",
		parameters: HandoffParams,
		defaultActive: false,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { held, state } = approvedEffort("team_handoff", ctx);
			if (params.isolated) {
				throw new Error(`Task \`${params.slug}\` can't be handed off isolated yet: a Task with a worktree of its own isn't built. Hand it off without \`isolated\`, into the Effort's Workspace.`);
			}
			const result = step(state, { kind: "handoff", slug: params.slug, at: now().toISOString() });
			if (!result.ok) throw new Error(result.refusal);
			const workspace = state.workspace;
			if (!workspace) throw new Error(`Effort \`${held.effortId}\` has no Workspace, so no Teammate starts; stop and tell the human.`);
			const { roles, playbook } = snapshotOf(held);
			await carryOut(held, result, async ({ teammate, task }) => {
				const role = roles.find((each) => each.name === teammate.role);
				if (!role) throw new Error(`The Team snapshot of Effort \`${held.effortId}\` has no Role \`${teammate.role}\`, so no Teammate starts; stop and tell the human.`);
				const taskDir = writeTask(held.paths, task.folder, params.body);
				const args = teammateArgs({
					name: teammate.name,
					role,
					mode: modeInForce(playbook, role),
					effortDir: held.paths.dir,
					dir: join(held.paths.teammates, teammate.id),
					settings: teammateSettings({
						effortDir: held.paths.dir,
						teammateId: teammate.id,
						allow: [role.name, EVERY_ROLE].flatMap((key) => playbook.roles[key]?.allow ?? []),
						deny: [role.name, EVERY_ROLE].flatMap((key) => playbook.roles[key]?.deny ?? []),
						ask: playbook.escalate.flatMap((entry) => entry.ask),
						records: protectedRecords(held.paths),
					}),
					prompt: teammatePrompt(
						{ teammateId: teammate.id, role: role.name, brief: held.paths.brief, clarifications: held.paths.clarifications, tasks: held.paths.tasks },
						role.prompt,
					),
					pointer: handoffPointer(task.slug, taskDir, 1),
				});
				const launched = await launchBackground(paths.claudePath, workspace.path, args);
				if (launched) throw new Error(`Teammate \`${teammate.id}\` didn't start, so Task \`${task.slug}\` is still planned: ${launched.error}`);
			});
			return { content: [{ type: "text", text: result.reply ?? "" }], details: undefined };
		},
	});

	pi.registerCommand("team", {
		description: "Run a Team on one Effort: /team start [team], /team setup <team>, /team pending",
		async handler(args, ctx) {
			const [name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (name === undefined) {
				ctx.ui.notify(`\`/team\` needs a subcommand. Subcommands: ${valid}.`, "error");
				return;
			}
			const subcommand = Object.hasOwn(subcommands, name) ? subcommands[name] : undefined;
			if (!subcommand) {
				ctx.ui.notify(`Unknown \`/team\` subcommand \`${name}\`. Subcommands: ${valid}.`, "error");
				return;
			}
			await subcommand.run(rest, ctx);
		},
	});
}

function bullets(lines: readonly string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

export default function (pi: ExtensionAPI): void {
	registerTeam(pi);
}
