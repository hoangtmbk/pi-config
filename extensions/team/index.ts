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

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { attachTarget, chooseAttach, pickerLabel } from "./attach.ts";
import { renderTeamBlock, teamStatus } from "./block.ts";
import { type Bridge, openBridge } from "./bridge.ts";
import { agentsList, CLEAR_MARKER, getUsage, humanStatusLine, installMod, launchBackground, sendToInbox, statusLineReading, stopBackground, teammateArgs, teammateSettings, trustFolder, versionWarning } from "./claude.ts";
import {
	awayText,
	BRIEF,
	BRIEF_CHANGE,
	changeSnapshot,
	currentResult,
	DEFAULT_MAX_TEAMMATES,
	type EffortAction,
	type EffortInput,
	type EffortState,
	type Escalation,
	escalationText,
	type FinalFacts,
	fold,
	freshStatusLine,
	type Inbox,
	openEffort,
	openEscalations,
	openMerges,
	PLAYBOOK_CHANGE,
	type PendingApproval,
	type PlaybookChange,
	refuseRequest,
	SIGN_OFF,
	type Step,
	step,
	USAGE_CHOICES,
	usageHolds,
	type UsageItem,
	usageText,
	USAGE_FRESH_MS,
	type UsageReading,
	type Workspace,
	waitingInTerminal,
	workdir,
} from "./core.ts";
import { EVERY_ROLE, listTeams, loadTeam, type Playbook, type Role, sha256, type Team, type TeamRoots } from "./definitions.ts";
import { briefApprovalTitle, intakePrompt, openedText } from "./intake.ts";
import { adoptable, hasEnded, holderText, ledFrom, type Leader, leaveLead, liveLead, POINTER, pointerIn, takeLead } from "./lead.ts";
import {
	answerTerms,
	appendClarification,
	appendLines,
	briefCriteria,
	type Approved,
	briefChangeProblems,
	changedLaunch,
	createEffort,
	type EffortPaths,
	effortPaths,
	promoteBrief,
	promoteBriefChange,
	protectedRecords,
	readApprovals,
	recordedApprovals,
	readJournal,
	readLead,
	readApproved,
	readLines,
	readReports,
	recordApproval,
	reportFile,
	reportMarkdown,
	validateBrief,
	writeFeedback,
	writePlan,
	writeReport,
	writeTask,
} from "./records.ts";
import { repoRoot } from "./repo.ts";
import { askedQuestions, terminalText } from "./requests.ts";
import { REPORT_OVERLAY, type ReportChrome, ReportView, type ReportTui } from "./reports-view.ts";
import { addTaskWorkspace, addWorkspace, effortWorktrees, endWorktrees, mergeEvidence, mergeTaskWorkspace, removeTaskWorkspace } from "./workspace.ts";
import {
	ADOPT_PLAYBOOK,
	APPROVE,
	adoptedText,
	adoptionRequested,
	adoptPlaybook,
	adoptPlaybookChange,
	beginSetup,
	changedPlaybook,
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
import { handoffPointer, launchPointer, restaffPointer, sendBackPointer, teammatePrompt } from "./teammate.ts";

/** The Lead's tools while this session runs Team setup. */
const SETUP_TOOLS = ["team_request_approval"];
/** The Lead's tools while this session holds an Effort. */
const EFFORT_TOOLS = ["team_request_approval", "team_plan", "team_handoff", "team_review", "team_status", "team_report", "team_pause", "team_resume", "team_answer", "team_escalate", "team_send"];
/** Every Lead tool: registered at load, and switched on only by what the session runs. */
const LEAD_TOOLS = [...new Set([...SETUP_TOOLS, ...EFFORT_TOOLS])];

const RequestApprovalParams = Type.Object({
	checkpoint: Type.String({
		description:
			"Which checkpoint: `brief` for an Effort's Brief, `brief-change` for a change to its approved Brief, a Playbook checkpoint id or an `escalate` id once the Brief is approved, `adopt-playbook` during Team setup.",
	}),
	path: Type.String({ description: "The draft to approve: the Effort's `brief.draft.md` (for `brief` and `brief-change`), the file a Playbook checkpoint or `escalate` id asks about, or the Team setup's Playbook draft." }),
	affects: Type.Optional(
		Type.Array(Type.String(), { description: "For `brief-change` only, and required there: the slugs of the planned Tasks the change holds until the human answers; `[]` holds none." }),
	),
});

const PauseParams = Type.Object({
	reason: Type.String({ description: "Why the Team holds, in a sentence; the human reads it in the Team block." }),
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
	reason: Type.Optional(Type.String({ description: "When re-planning: why the plan changed, in a sentence. It goes into the next Report." })),
});

const ReportParams = Type.Object({
	headline: Type.String({ description: "Where the Effort stands, in a sentence or two." }),
	coverage: Type.Optional(
		Type.Array(
			Type.Object({
				criterion: Type.String({ description: "A Brief acceptance-criterion id, such as `AC1`." }),
				note: Type.String({ description: "How the plan or the accepted work covers it so far." }),
			}),
			{ description: "Brief coverage, criterion by criterion, as you see it." },
		),
	),
	found: Type.Optional(
		Type.Array(Type.String(), { description: "Work found since the last Report that is outside the Brief: kept as suggestions for the final Report, never started." }),
	),
	final: Type.Optional(
		Type.Boolean({
			description: "The final Report, once every Brief criterion is met: `coverage` maps each one to its evidence, and writing it asks the human to sign off, which ends the Effort.",
		}),
	),
	changes: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String({ description: "The change's kebab-case id, unique in the Report." }),
				summary: Type.String({ description: "What the change is and why, in a sentence." }),
				oldText: Type.String({ description: "The passage of the Effort's playbook.md to replace, quoted exactly; it must be there once." }),
				newText: Type.String({ description: "What replaces it." }),
			}),
			{ description: "With `final`: Playbook changes the Effort taught, each adopted or declined by the human on its own, for the Team's next Effort." },
		),
	),
});

/** The `/team pending` choices for a proposed Playbook change. */
const ADOPT_CHANGE = "Adopt for the next Effort";
const DECLINE = "Decline";

const DECISIONS = ["allow", "deny"] as const;

const AnswerParams = Type.Object({
	request: Type.String({ description: "The held request's id, `req-<8 hex>`, from the message that woke you about it." }),
	decision: Type.Optional(Type.String({ description: "For a permission request: `allow` or `deny`. Leave it out when answering an AskUserQuestion." })),
	reason: Type.Optional(Type.String({ description: "Why: the deny message the Teammate sees, and what the human reads in the next Report." })),
	rule: Type.Optional(
		Type.String({ description: "With `allow`: a session rule for the same tool, such as `Bash(npm test:*)`, so the Teammate isn't asked again this session." }),
	),
	grant: Type.Optional(
		Type.String({
			description: "With `allow`: the grant id in the Playbook or Brief the allow relies on, or `delivery` for the Brief's Delivery, logged for the human. Required to allow a floor action.",
		}),
	),
	answers: Type.Optional(
		Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())]), {
			description: "For an AskUserQuestion: each question's exact text to the label picked, or a list of labels for a multiSelect question.",
		}),
	),
	text: Type.Optional(Type.String({ description: "For an escalated prose question (`q<n>`): the human's answer in their own words, as they gave it to you in chat." })),
});

const EscalateParams = Type.Object({
	request: Type.Optional(Type.String({ description: "The held request to escalate, `req-<8 hex>`. Leave it out to escalate a prose question with `teammate` and `question`." })),
	teammate: Type.Optional(Type.String({ description: "For a prose question: the Teammate that stopped short asking it, such as `dev-1`." })),
	question: Type.Optional(Type.String({ description: "For a prose question: the question, as the Teammate's last message asked it." })),
	summary: Type.String({ description: "For the human: what is asked, and why the Brief doesn't settle it, in a sentence or two." }),
	brief: Type.Optional(Type.String({ description: "What the Brief says on it, if anything; it goes into clarifications.md with the human's answer." })),
});

const SendParams = Type.Object({
	teammate: Type.String({ description: "The Teammate to message, such as `dev-1`." }),
	message: Type.String({ description: "A short prose message, at most 2000 characters; longer instructions belong in a Task." }),
});

/** The `/team pending` choices for an escalated permission, and the end of a multiSelect question's picks. */
const ALLOW = "Allow";
const DENY = "Deny";
const DONE = "Done";

/** What a `team_report` result carries for the human's view of it in chat; the Lead reads only its short `content`. */
interface ReportDetails {
	n: number;
	path: string;
	headline: string;
	markdown: string;
}

/** The Team block's key among pi's widgets. */
const BLOCK_KEY = "team";

/** The cap on live Teammates when pi's settings name none. */

const HandoffParams = Type.Object({
	slug: Type.String({ description: "The planned Task to hand off." }),
	body: Type.String({ description: "The `task.md` body the Teammate works from." }),
	isolated: Type.Optional(Type.Boolean({ description: "Whether the Task needs a worktree of its own." })),
});

/** What `team_review` can decide about a round's result. */
const VERDICTS = ["accept", "send_back"] as const;

const ReviewParams = Type.Object({
	slug: Type.String({ description: "The handed-off Task whose newest result was reviewed." }),
	verdict: Type.String({ description: "`accept` to accept the result, or `send_back` to send the Task back to its Teammate with `feedback`." }),
	feedback: Type.Optional(
		Type.String({ description: "For `send_back`: what is wrong with the result and what would make it acceptable. It is written to the Task's `feedback-<n>.md`." }),
	),
});

/** Where the extension finds everything outside itself. Each defaults to the real thing. */
export interface TeamDeps {
	/** pi's agent dir, `~/.pi/agent`. Injected by tests, and by nothing else. */
	agentDir?: string;
	/** Claude Code's config file, `~/.claude.json`. Injected by tests, and by nothing else. */
	claudeConfigPath?: string;
	/** Claude Code's folder, `~/.claude`, whose settings.json names the human's status line; only read. Injected by tests, and by nothing else. */
	claudeDir?: string;
	/** The `claude` executable. Injected by tests, and by nothing else. */
	claudePath?: string;
	/** The bundled Teams. Injected by tests, and by nothing else. */
	bundledTeamsDir?: string;
	/** The clock adoption times are read from. Injected by tests, and by nothing else. */
	now?: () => Date;
	/** Run `tick` every `ms` until the returned stop is called: the Team block's usage readings, and the clock usage limits lift on. Injected by tests, and by nothing else. */
	every?: (ms: number, tick: () => Promise<void> | void) => () => void;
	/** The pid this session leads an Effort as. Injected by tests standing in for another pi process, and by nothing else. */
	pid?: number;
	/** Waits out the stagger between Teammate starts. Injected by tests, and by nothing else. */
	sleep?: (ms: number) => Promise<void>;
	/** The environment `$TMUX` is read from, `process.env`. Injected by tests, and by nothing else. */
	env?: Record<string, string | undefined>;
	/** The `tmux` executable. Injected by tests, and by nothing else. */
	tmuxPath?: string;
	/** Put text on the clipboard, pi's `copyToClipboard`. Injected by tests, and by nothing else. */
	copy?: (text: string) => Promise<void>;
}

/** How often the Lead's clock looks at what a usage limit holds back. */
const TICK_MS = 60_000;

/** What a Teammate a usage limit stopped is sent once it resets, as the human would type it. */
const CONTINUE = "continue";

/** What each usage-item choice reads as in `/team pending`. */
const USAGE_LABELS: Record<string, string> = {
	stay: "Stay paused until it resets",
	cancel: "Cancel the Effort: stop every Teammate and end it without sign-off",
	retry: "Retry: send it `continue` again",
	leave: "Leave it to the Lead",
};

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
	const claudeDir = deps.claudeDir ?? join(homedir(), ".claude");
	const now = deps.now ?? (() => new Date());
	const every =
		deps.every ??
		((ms: number, tick: () => Promise<void> | void) => {
			const timer = setInterval(() => void tick(), ms);
			// Neither the block's readings nor the usage clock keep pi running.
			timer.unref();
			return () => clearInterval(timer);
		});
	const pid = deps.pid ?? process.pid;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const env = deps.env ?? process.env;
	const tmuxPath = deps.tmuxPath ?? "tmux";
	const copy = deps.copy ?? copyToClipboard;

	// What this session is running, which decides whether the Lead's tools are on.
	let setup: TeamSetup | undefined;
	// Playbook adoptions waiting on the human in `/team pending`, oldest first. An Effort's own wait in its `effort.jsonl`.
	let pending: PendingAdoption[] = [];
	// The one Effort this session's Lead holds.
	let effort: HeldEffort | undefined;
	// The Lead bridge the held Effort's hooks ring, open while this session is its Lead.
	let bridge: Promise<Bridge> | undefined;
	/** The Teammates being stopped and launched afresh right now, whose journals aren't read until that is on record. */
	const relaunching = new Set<string>();
	// Whether the Lead's model is in a run, and what wakes about Teammates wait for it to settle.
	let busy = false;
	let waiting: string[] = [];
	// While the Effort is picked up again after a restart: what it has to tell the Lead, said once at the end.
	let recovering: string[] | undefined;
	// After a restart, the Teammates heard from since; the block marks the others' short ids unconfirmed.
	let confirmed: Set<string> | undefined;
	// Where the Team block goes, when pi has a UI, and the lines it last showed.
	let surface: ExtensionUIContext | undefined;
	let shown: string[] | undefined;
	// The clock that lifts what a usage limit holds back, running while this session holds an Effort, and the context queued Tasks start in.
	let stopClock: (() => void) | undefined;
	let ticking = false;
	let leadCtx: ExtensionContext | undefined;
	// While the block shows: the timer that reads usage into it, the reading under way, and when `get_usage` was last asked.
	let stopUsage: (() => void) | undefined;
	let usageRun: Promise<void> | undefined;
	let usageAsked: number | undefined;

	function syncLeadTools(): void {
		const others = pi.getActiveTools().filter((name) => !LEAD_TOOLS.includes(name));
		pi.setActiveTools([...others, ...(effort ? EFFORT_TOOLS : setup ? SETUP_TOOLS : [])]);
	}

	function effortState(held: HeldEffort): EffortState {
		return fold(readLines(held.paths));
	}

	/**
	 * Redraw the Team block from the held Effort's lines, or take it away when
	 * the session holds none. Called wherever the Effort or what waits on the
	 * human can have changed; an unchanged block isn't handed to pi again.
	 */
	function paintBlock(): void {
		const state = effort ? effortState(effort) : undefined;
		syncClock(state);
		if (!surface) return;
		const lines = state ? renderTeamBlock(teamStatus(state, { adoptionsPending: pending.length, ...(confirmed ? { confirmed } : {}) }), now().getTime(), { maxTeammates: maxTeammates() }) : undefined;
		if (lines && !stopUsage) stopUsage = every(USAGE_FRESH_MS, readUsage);
		if (!lines) endUsage();
		if (lines === shown || (lines && shown && lines.length === shown.length && lines.every((line, index) => line === shown?.[index]))) return;
		shown = lines;
		surface.setWidget(BLOCK_KEY, lines, { placement: "aboveEditor" });
	}

	/** Run the Lead's clock while a usage limit holds anything back in the held Effort, and only then. */
	function syncClock(state: EffortState | undefined): void {
		if (state && usageHolds(state)) stopClock ??= every(TICK_MS, tickEffort);
		else {
			stopClock?.();
			stopClock = undefined;
		}
	}

	function endUsage(): void {
		stopUsage?.();
		stopUsage = undefined;
	}

	/**
	 * Each live Teammate's status line, read from its `statusline.json` on
	 * demand (the wrapper never pushes it), recorded when newer than the last
	 * one recorded. The file's modification time is when it was taken.
	 */
	function readStatusLines(held: HeldEffort): EffortState {
		let state = effortState(held);
		for (const teammate of state.teammates) {
			if (teammate.retiredAt !== undefined || teammate.ended !== undefined) continue;
			const file = join(held.paths.teammates, teammate.id, "statusline.json");
			let reading: UsageReading | undefined;
			try {
				reading = statusLineReading(readFileSync(file, "utf8"), teammate.id, statSync(file).mtime.toISOString());
			} catch {
				// No status line yet: Claude Code runs it once the session's footer first draws.
			}
			if (reading) state = recordUsage(held, state, reading);
		}
		return state;
	}

	function recordUsage(held: HeldEffort, state: EffortState, reading: UsageReading): EffortState {
		const result = step(state, { kind: "usage", reading });
		if (!result.ok) return state;
		appendLines(held.paths, result.append);
		return result.state;
	}

	/**
	 * The block's usage, once a minute while it shows: the status lines, and
	 * only when none is under a minute old, the undocumented \`get_usage\`, asked
	 * at most once a minute whatever came of the last ask. One that fails
	 * leaves the last reading standing.
	 */
	function readUsage(): Promise<void> {
		if (usageRun) return usageRun;
		const run = async () => {
			const held = effort;
			if (!held || !shown) return;
			const state = readStatusLines(held);
			const at = now().getTime();
			if (!freshStatusLine(state, at) && (usageAsked === undefined || at - usageAsked >= USAGE_FRESH_MS)) {
				usageAsked = at;
				const reading = await getUsage(paths.claudePath, new Date(at).toISOString());
				if (!("error" in reading) && effort === held) recordUsage(held, effortState(held), reading);
			}
			paintBlock();
		};
		usageRun = run()
			.catch(() => {})
			.finally(() => {
				usageRun = undefined;
			});
		return usageRun;
	}

	/** pi's `maxTeammates` setting, which reaches a running session only after `/reload`. */
	function maxTeammates(): number {
		const set = (pi.getSettings() as Record<string, unknown>).maxTeammates;
		return typeof set === "number" && Number.isInteger(set) && set >= 1 ? set : DEFAULT_MAX_TEAMMATES;
	}

	/** Where the Team block goes: nowhere in print and JSON modes, where `hasUI` is false. */
	function showBlockIn(ctx: ExtensionContext): void {
		if (ctx.hasUI) surface = ctx.ui;
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

	function leader(ctx: ExtensionContext): Leader {
		return { pid, sessionFile: ctx.sessionManager.getSessionFile() };
	}

	/**
	 * Lead the Effort: start the Lead bridge, once, and take the lock, which
	 * writes `lead.json` so the hook script can ring it. Throws, with the bridge
	 * closed again, while another session is its live Lead. Every launch waits
	 * for it first.
	 */
	async function listenForTeammates(held: HeldEffort, ctx: ExtensionContext): Promise<void> {
		bridge ??= (async () => {
			const opened = await openBridge((teammate) => {
				if (effort) wakeAboutTeammates(applyJournals(effort, teammate));
			});
			const refused = await takeLead(held.paths, leader(ctx), opened, now().toISOString()).catch((error: unknown) => {
				opened.close();
				throw error;
			});
			if (refused) {
				opened.close();
				throw new Error(refused.refusal);
			}
			return opened;
		})().catch((error: unknown) => {
			bridge = undefined;
			throw error;
		});
		await bridge;
	}

	/**
	 * Lead the Effort and hold it in this session, or say why not. `records`:
	 * the Effort's records, for a Lead that hasn't read them (an adoption, a
	 * fork made before its first message), named in the wake if one comes.
	 */
	async function lead(held: HeldEffort, ctx: ExtensionContext, records?: readonly string[]): Promise<boolean> {
		try {
			await listenForTeammates(held, ctx);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return false;
		}
		effort = held;
		leadCtx = ctx;
		syncLeadTools();
		paintBlock();
		await pickUp(held, records);
		return true;
	}

	/**
	 * Pick the Effort up where pi left it, once this session leads it: finish
	 * the intents left open from git's and Claude Code's evidence, replay the
	 * journals, send again what never landed, and catch up on a reset that
	 * passed (a reset that passed while no session led the Effort among it).
	 * The Lead is woken once, with all of it, and not at all when none of it
	 * needs the Lead.
	 */
	async function pickUp(held: HeldEffort, records?: readonly string[]): Promise<void> {
		const away: string[] = [];
		recovering = away;
		try {
			const names = await listedNames();
			confirmed = new Set(effortState(held).teammates.filter((teammate) => names?.includes(teammate.name)).map((teammate) => teammate.id));
			paintBlock();
			away.push(...(await recoverIntents(held, names)));
			// A sign-off on record ended the Effort: there is nothing left to pick up.
			if (effort !== held) return;
			const sent: string[] = [];
			away.push(...applyJournals(held, undefined, sent));
			away.push(...(await resend(held, sent, names)));
			await tickEffort();
		} catch (error) {
			away.push(`Picking Effort \`${held.effortId}\` up after the restart stopped short: ${error instanceof Error ? error.message : String(error)}. Stop and tell the human.`);
		} finally {
			recovering = undefined;
		}
		const text = awayText(effortState(held), away, records);
		if (text === undefined) return;
		if (busy) waiting.push(text);
		else wakeLead("team-away", text);
	}

	/** The `--name`s `claude agents --json` lists, or undefined when it can't be read. */
	async function listedNames(): Promise<string[] | undefined> {
		const agents = await agentsList(paths.claudePath);
		return agents instanceof Map ? [...agents.keys()] : undefined;
	}

	/** The records a Lead new to the Effort reads first: those written so far. */
	function recordsOf(held: HeldEffort): string[] {
		return [held.paths.brief, held.paths.clarifications, held.paths.plan, held.paths.reports].filter((path) => existsSync(path));
	}

	/**
	 * Finish each intent a restart left open, from the evidence: `names`, the
	 * `--name`s `claude agents --json` lists (undefined when it couldn't be
	 * read), each Teammate's journal, git, and `approvals.jsonl`. Returns what
	 * the Lead must hear.
	 */
	async function recoverIntents(held: HeldEffort, names: string[] | undefined): Promise<string[]> {
		const state = effortState(held);
		// A Teammate started afresh already has a journal: only a SessionStart past its cursor, other than a clear, is its new session's.
		const journaled = Object.keys(state.launching ?? {}).filter((id) => {
			const known = state.teammates.find((teammate) => teammate.id === id);
			const lines = readJournal(held.paths, id, known?.cursor ?? 0);
			return known === undefined ? lines.length > 0 : lines.some(({ line }) => line.event === "SessionStart" && line.payload?.source !== "clear");
		});
		const merges = Object.fromEntries(
			openMerges(state).flatMap(({ slug, branch }) => {
				const evidence = state.workspace && mergeEvidence(state.workspace.path, branch);
				return evidence ? [[slug, evidence] as const] : [];
			}),
		);
		const result = step(state, { kind: "recover", ...(names ? { agents: names } : {}), journaled, merges, ...recordedApprovals(held.paths, state), at: now().toISOString() });
		if (!result.ok) return [result.refusal];
		appendLines(held.paths, result.append);
		const texts: string[] = [];
		const unstopped: string[] = [];
		let stopped = true;
		let ended = false;
		for (const action of result.actions) {
			if (action.kind === "wake-lead") texts.push(action.text);
			else if (action.kind === "end-effort") ended = true;
			else if (action.kind === "write-plan") writePlan(held.paths, effortState(held));
			else if (action.kind === "discard-feedback") rmSync(join(held.paths.tasks, action.folder, `feedback-${action.round}.md`), { force: true });
			else if (action.kind === "stop-teammate") {
				const failed = await stopTeammate(result.state, action);
				if (failed) {
					stopped = false;
					unstopped.push(`\`${action.teammate}\` (${failed.error})`);
					texts.push(`\`${action.teammate}\` didn't stop (${failed.error}), so its worktree is left in place; tell the human.`);
				}
			} else if (action.kind === "remove-task-workspace") {
				// A merged Task's worktree goes as an accept removes it; an abandoned launch's had nothing worked in it.
				const accepted = result.state.tasks[action.slug]?.accepted !== undefined;
				if (accepted && (!stopped || !result.state.workspace)) continue;
				const left = removeTaskWorkspace(accepted && result.state.workspace ? result.state.workspace.path : result.state.repo, action, !accepted);
				if (left) texts.push(`Task \`${action.slug}\`'s worktree or branch is left in place: ${left}`);
			} else if (action.kind === "merge") {
				try {
					texts.push(await acceptMerged(held, { ok: true, state: effortState(held), append: [], actions: [] }, action));
				} catch (error) {
					texts.push(error instanceof Error ? error.message : String(error));
				}
			}
		}
		// A sign-off on record before pi stopped: the Effort ends now, as it would have then, and the Lead hears it with the end.
		if (ended && leadCtx) {
			await endEffort(held, result.state, texts.filter(Boolean).join(" "), unstopped, leadCtx);
			return [];
		}
		return texts.filter(Boolean);
	}

	/**
	 * Once the journals are replayed: clear again a reused Teammate whose clear
	 * never came, and send again a pointer that never landed, unless the replay
	 * sent it (`sent`). Returns what the Lead must hear.
	 */
	async function resend(held: HeldEffort, sent: string[], names: string[] | undefined): Promise<string[]> {
		const state = effortState(held);
		const marked = state.teammates.filter((teammate) => existsSync(join(held.paths.teammates, teammate.id, "takeover"))).map((teammate) => teammate.id);
		const result = step(state, { kind: "reconcile", sent, ...(names ? { agents: names } : {}), marked, at: now().toISOString() });
		if (!result.ok) return [result.refusal];
		takeoverActions(held, result.actions.filter((action) => action.kind === "mark-takeover"));
		const texts: string[] = result.reply === undefined ? [] : [result.reply];
		for (const action of result.actions) {
			if (action.kind === "clear-then-send") {
				const failed = await sendToInbox(action.inbox, CLEAR_MARKER);
				if (failed) texts.push(`\`${action.teammate}\` was clearing its context for Task \`${action.slug}\` when pi stopped, and the clear sent again couldn't reach its inbox (${failed.error}), so it isn't working on it. Stop and tell the human.`);
			} else if (action.kind === "redeliver") {
				const taskDir = join(held.paths.tasks, action.folder);
				const pointer = action.round === 1 ? handoffPointer(action.slug, taskDir, 1) : sendBackPointer(action.slug, taskDir, action.round - 1);
				const inbox = state.teammates.find((teammate) => teammate.id === action.teammate)?.inbox;
				const failed = inbox ? await deliver(held, action.teammate, inbox, pointer) : { error: "it has no inbox on record" };
				if (failed) texts.push(`Task \`${action.slug}\`'s pointer, sent to \`${action.teammate}\` before pi stopped, never landed, and sending it again failed (${failed.error}), so it isn't working on it. Stop and tell the human.`);
			}
		}
		return texts;
	}

	/**
	 * One beat of the Lead's clock: what a usage limit holds back is let go
	 * once its reset has passed, and a Teammate due a retry or its reset's
	 * grace is sent `continue`. A beat still running when the next comes
	 * skips that one.
	 */
	async function tickEffort(): Promise<void> {
		const held = effort;
		if (!held || ticking) return;
		ticking = true;
		try {
			const result = step(effortState(held), { kind: "tick", at: now().toISOString() });
			if (!result.ok || result.append.length === 0) return;
			appendLines(held.paths, result.append);
			paintBlock();
			wakeAboutTeammates(await afterUsage(held, result));
		} finally {
			ticking = false;
		}
	}

	/**
	 * Carry out what a usage step asks once its lines are on record: send
	 * `continue`, start the queued Tasks a lifted pause or hold lets go, and
	 * return what the Lead must hear, a failed send among it.
	 */
	async function afterUsage(held: HeldEffort, result: Extract<Step, { ok: true }>): Promise<string[]> {
		const texts: string[] = [];
		for (const action of result.actions) {
			if (action.kind === "wake-lead") texts.push(action.text);
			else if (action.kind === "send-continue") {
				const failed = await deliver(held, action.teammate, action.inbox, CONTINUE);
				if (failed) texts.push(`\`${action.teammate}\`'s usage limit reset, but \`continue\` couldn't reach it (${failed.error}), so it is still stopped. Stop and tell the human.`);
			}
		}
		const lifted = result.append.some((line) => (line.type === "resumed" && line.by === "usage") || line.type === "model-released");
		if (lifted && leadCtx) texts.push(...(await startQueued(held, effortState(held), leadCtx)));
		paintBlock();
		return texts;
	}

	/** Each Role's model in the Effort's Team snapshot, which a model-family limit holds Roles by; none before its Brief is approved. */
	function roleModels(held: HeldEffort): Record<string, string> | undefined {
		try {
			return Object.fromEntries(readApproved(held.paths, held.effortId).roles.flatMap((role) => (role.model === undefined ? [] : [[role.name, role.model]])));
		} catch {
			return undefined;
		}
	}

	/**
	 * Apply every Teammate's journal (or only `only`'s) from its cursor, and
	 * return what the Lead must be woken with. A line already applied is
	 * skipped by the core, so a doorbell rung twice, or a re-read, changes
	 * nothing.
	 */
	function applyJournals(held: HeldEffort, only?: string, sent?: string[]): string[] {
		let state = effortState(held);
		const texts: string[] = [];
		// A reset naming no time zone is read in the machine's.
		const tz = -now().getTimezoneOffset();
		let models: Record<string, string> | undefined | null = null;
		for (const { id, cursor } of state.teammates) {
			if (only !== undefined && id !== only) continue;
			// A Teammate being started afresh is read once its relaunch is on record, so its new session's lines go to its new Task.
			if (relaunching.has(id)) continue;
			const sent = sentTo(held, state, id);
			for (const read of readJournal(held.paths, id, cursor ?? 0)) {
				const due = currentResult(state, id);
				const path = due ? join(held.paths.tasks, due.folder, `result-${due.round}.md`) : "";
				if (models === null) models = roleModels(held);
				const result = step(state, {
					kind: "journal",
					teammate: id,
					cursor: read.cursor,
					line: read.line,
					result: { path, written: path !== "" && existsSync(path) },
					tz,
					...(models ? { models } : {}),
					sent,
				});
				if (!result.ok) break;
				appendLines(held.paths, result.append);
				state = result.state;
				confirmed?.add(id);
				for (const action of result.actions) {
					if (action.kind === "wake-lead") texts.push(action.text);
					else if (action.kind === "send-pointer") {
						sendPointer(held, action);
						sent?.push(action.slug);
					}
				}
				takeoverActions(held, result.actions);
				// Claude Code's auto-resume fired: the others on that limit get `continue`, and what it held back starts.
				if (result.actions.some((action) => action.kind === "send-continue") || result.append.some((line) => (line.type === "resumed" && line.by === "usage") || line.type === "model-released")) {
					const usage = { ...result, actions: result.actions.filter((action) => action.kind === "send-continue") };
					void afterUsage(held, usage).then(wakeAboutTeammates, (error: unknown) => wakeAboutTeammates([`A usage limit lifted, but what it held back didn't restart: ${error instanceof Error ? error.message : String(error)}`]));
				}
			}
		}
		paintBlock();
		return texts;
	}

	/** Send a cleared Teammate its new Task's pointer, waking the Lead if it doesn't get through. */
	function sendPointer(held: HeldEffort, { teammate, inbox, slug, folder, round }: Extract<EffortAction, { kind: "send-pointer" }>): void {
		void sendToInbox(inbox, handoffPointer(slug, join(held.paths.tasks, folder), round)).then((failed) => {
			if (!failed) return;
			wakeAboutTeammates([
				`\`${teammate}\` cleared its context for Task \`${slug}\`, but the Task's pointer couldn't reach its inbox (${failed.error}), so it isn't working on it. Stop and tell the human.`,
			]);
		});
	}

	/** The prompts the Effort itself sends Teammate `id`: every round's pointer of its Tasks, and `continue`. */
	function sentTo(held: HeldEffort, state: EffortState, id: string): string[] {
		const sent = [CONTINUE];
		for (const [slug, task] of Object.entries(state.tasks)) {
			if (task.teammate !== id) continue;
			const dir = join(held.paths.tasks, task.folder);
			for (let round = 1; round <= task.round; round++) sent.push(handoffPointer(slug, dir, round), sendBackPointer(slug, dir, round), restaffPointer(slug, dir, round));
		}
		return sent;
	}

	/**
	 * Carry out a Takeover's own actions: the hook's marker, written or removed,
	 * and the clear before a held Task pointer at the hand-back, whose pointer
	 * goes once the clear lands. A clear that doesn't get through wakes the Lead.
	 */
	function takeoverActions(held: HeldEffort, actions: readonly EffortAction[]): void {
		for (const action of actions) {
			if (action.kind === "mark-takeover") {
				const dir = join(held.paths.teammates, action.teammate);
				if (action.on) {
					mkdirSync(dir, { recursive: true });
					writeFileSync(join(dir, "takeover"), `${now().toISOString()}\n`);
				} else rmSync(join(dir, "takeover"), { force: true });
			} else if (action.kind === "clear-then-send") {
				void sendToInbox(action.inbox, CLEAR_MARKER).then((failed) => {
					if (!failed) return;
					wakeAboutTeammates([
						`\`${action.teammate}\` was handed back with Task \`${action.slug}\`'s pointer held, but the clear couldn't reach its inbox (${failed.error}), so it isn't working on it. Stop and tell the human.`,
					]);
				});
			}
		}
	}

	/**
	 * `/team handback`, and the attach menu's "Hand back": confirm, then end
	 * the human's Takeover of `teammate` from pi, with what it did reviewed by
	 * the Lead.
	 */
	async function handBackFromPi(teammate: string, note: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
		const held = effort;
		if (!held) {
			ctx.ui.notify("This session holds no Effort, so there is no Teammate to hand back.", "error");
			return;
		}
		wakeAboutTeammates(applyJournals(held));
		const input = (): Extract<EffortInput, { kind: "handback" }> => {
			const due = currentResult(effortState(held), teammate);
			const path = due ? join(held.paths.tasks, due.folder, `result-${due.round}.md`) : "";
			return { kind: "handback", teammate, ...(note === undefined ? {} : { note }), result: { path, written: path !== "" && existsSync(path) }, at: now().toISOString() };
		};
		const probe = step(effortState(held), input());
		if (!probe.ok) {
			ctx.ui.notify(probe.refusal, "error");
			return;
		}
		const sure = await ctx.ui.confirm(
			`Hand \`${teammate}\` back to the Lead?`,
			"Any send held for it while you had it is dropped, and the Lead reviews what you did in its terminal like any result. The next new Task it gets starts with a clear of its context.",
		);
		if (!sure) return;
		const result = step(effortState(held), input());
		if (!result.ok) {
			ctx.ui.notify(result.refusal, "error");
			return;
		}
		appendLines(held.paths, result.append);
		takeoverActions(held, result.actions);
		wakeAboutTeammates(result.actions.flatMap((action) => (action.kind === "wake-lead" ? [action.text] : [])));
		paintBlock();
		ctx.ui.notify(result.reply ?? `Handed \`${teammate}\` back.`, "info");
	}

	/** Wake the Lead about its Teammates now, or with everything else once its run settles. */
	function wakeAboutTeammates(texts: string[]): void {
		if (recovering) recovering.push(...texts);
		else if (busy) waiting.push(...texts);
		else if (texts.length > 0) wakeLead("team-teammate", texts.join("\n\n"));
	}

	pi.on("agent_start", () => {
		busy = true;
	});

	pi.on("agent_settled", () => {
		busy = false;
		// A doorbell is only a nudge: whatever the journals hold now is applied, rung or not.
		const texts = [...waiting, ...(effort ? applyJournals(effort) : [])];
		waiting = [];
		wakeAboutTeammates(texts);
	});

	pi.on("session_start", (_event, ctx) => {
		showBlockIn(ctx);
		// A session started again has whatever it showed behind it, so the block is drawn afresh.
		shown = undefined;
		paintBlock();
	});

	pi.on("session_shutdown", async () => {
		stopClock?.();
		stopClock = undefined;
		// The block shows only while this session holds the Effort.
		if (shown) surface?.setWidget(BLOCK_KEY, undefined, { placement: "aboveEditor" });
		shown = undefined;
		endUsage();
		const open = bridge;
		bridge = undefined;
		await open?.then(
			(opened) => opened.close(),
			() => {},
		);
	});

	// Leaving the session leaves the Effort with no live Lead, marked in `lead.json` for whoever leads it next.
	// `/tree` moves along the session's branches, but the Effort lives in its files: the Lead hears where it stands on its next turn.
	pi.on("session_tree", () => {
		if (!effort) return;
		const status = teamStatus(effortState(effort), { adoptionsPending: pending.length });
		const text = `This session still leads Effort \`${effort.effortId}\` (${effort.paths.dir}), whichever branch of the tree you are on: its state lives in its files. Its status, as \`team_status\` gives it:\n\n${JSON.stringify(status, null, 2)}`;
		pi.sendMessage({ customType: "team-status", content: text, display: true }, { deliverAs: "nextTurn" });
	});

	// Switching to another session leaves the Effort with no live Lead, so the human is asked first.
	pi.on("session_before_switch", async (event, ctx) => {
		if (!effort || !ctx.hasUI) return undefined;
		if (event.reason === "resume" && event.targetSessionFile === ctx.sessionManager.getSessionFile()) return undefined;
		const leave = await ctx.ui.confirm(
			`Leave Effort \`${effort.effortId}\`?`,
			`This session leads it. Switching leaves it with no live Lead until \`/resume\` brings you back here, or \`/team resume ${effort.effortId}\` adopts it in another session.`,
		);
		return leave ? undefined : { cancel: true };
	});

	// `/fork` and `/clone` move the Effort to the new session, which re-attaches to it.
	pi.on("session_shutdown", async (event, ctx) => {
		if (!effort) return;
		try {
			await leaveLead(effort.paths, leader(ctx), now().toISOString(), event.reason === "fork" ? event.targetSessionFile : undefined);
		} catch (error) {
			// Best effort: a Lead that can't mark it is taken over once its pid has died.
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	});

	/**
	 * Re-attach to the Effort this session leads: `pi -c`, `/resume` back to
	 * it, `/reload`, or the session a fork or clone moved it to. The session's
	 * pointer names the Effort, and `lead.json` must name this session file: a
	 * session that has since handed the Effort on leaves it where it is.
	 */
	pi.on("session_start", async (event, ctx) => {
		if (effort) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		let pointer = pointerIn(ctx.sessionManager.getEntries());
		let moved = false;
		if (!pointer && event.reason === "fork") {
			// Forked before its first message, a session carries none of its Lead's entries; lead.json names it already.
			const effortId = ledFrom(paths.agentDir, sessionFile);
			if (effortId !== undefined) {
				pointer = { effortId, effortDir: effortPaths(paths.agentDir, effortId).dir };
				moved = true;
			}
		}
		if (!pointer) return;
		const held = { effortId: pointer.effortId, paths: effortPaths(paths.agentDir, pointer.effortId) };
		try {
			if (!existsSync(held.paths.log)) {
				ctx.ui.notify(`This session led Effort \`${pointer.effortId}\`, whose files are no longer at ${held.paths.dir}.`, "warning");
				return;
			}
			// An Effort that has ended is over for good: the session holds none.
			if (hasEnded(held.paths)) return;
			const record = readLead(held.paths);
			if (record && record.sessionFile !== sessionFile) {
				const live = liveLead(held.paths);
				const where = live ? `${holderText(live)}; \`/team resume ${pointer.effortId}\` adopts it here once that session leaves it` : `${record.sessionFile ?? "a pi session kept in memory"}, which has left it; \`/team resume ${pointer.effortId}\` adopts it here`;
				ctx.ui.notify(`This session led Effort \`${pointer.effortId}\`, which is now led from ${where}.`, "info");
				return;
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		if (!(await lead(held, ctx, moved ? recordsOf(held) : undefined))) return;
		if (moved) pi.appendEntry(POINTER, { effortId: held.effortId, effortDir: held.paths.dir });
		ctx.ui.notify(`This session leads Effort \`${held.effortId}\` (${held.paths.dir}) again.`, "info");
	});

	function runSetup(team: Team, startsTeam: boolean): void {
		const begun = beginSetup(paths.agentDir, team, startsTeam);
		// A setup for another Team ends the one before it, and with it what that one asked.
		pending = pending.filter((item) => item.team === team.name);
		setup = begun.setup;
		syncLeadTools();
		wakeLead("team-setup", begun.prompt);
	}

	async function land(outcome: StartOutcome, ctx: ExtensionCommandContext): Promise<void> {
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
				await openIntake(outcome.team, outcome.playbook, outcome.text, ctx);
				return;
		}
	}

	/** Open an Effort on the Team in the repo pi runs in, and wake the Lead to draft its Brief. */
	async function openIntake(team: Team, playbook: Playbook, picked: string, ctx: ExtensionCommandContext): Promise<void> {
		const repo = repoRoot(ctx.cwd);
		if ("error" in repo) {
			ctx.ui.notify(`Team \`${team.name}\` can't open an Effort here: ${repo.error}. An Effort works on a git repo, which its Brief records; start pi in that repo and run \`/team start ${team.name}\` again.`, "error");
			return;
		}
		const at = now();
		const { effortId, paths: files } = createEffort(paths.agentDir, team.name, at);
		appendLines(files, [openEffort({ effortId, team: team.name, repo: repo.root, playbook: playbook.sha256, at: at.toISOString() })]);
		if (!(await lead({ effortId, paths: files }, ctx))) return;
		pi.appendEntry(POINTER, { effortId, effortDir: files.dir });
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
			const problems = validateBrief(item.snapshot, { team: state.team, repo: state.repo, playbook: found.playbook, roles: found.team.roles.map((role) => role.name) });
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

	/**
	 * `team_request_approval` at one of the Effort's checkpoints: check the
	 * draft (a Brief or a Brief change against its Playbook), snapshot it and
	 * add it to `/team pending`. A Brief change, and a Playbook checkpoint or
	 * `escalate` id, go by the Playbook the Effort snapshotted at Brief approval.
	 */
	function requestBriefApproval(held: HeldEffort, checkpoint: string, path: string, affects?: string[]): string {
		const state = effortState(held);
		const current = state.brief ? approved(held) : undefined;
		const checkpoints = current ? [...current.playbook.checkpoints.map(({ id }) => id), ...current.playbook.escalate.map(({ id }) => id)] : [];
		const refusal = refuseRequest(state, checkpoint, { affects, checkpoints });
		if (refusal !== undefined) throw new Error(refusal);
		const ofBrief = checkpoint === BRIEF || checkpoint === BRIEF_CHANGE;
		if (ofBrief && path !== held.paths.draft) {
			throw new Error(`Only the Effort's own Brief draft can be asked about: ${held.paths.draft}, not ${path}.`);
		}
		if (!existsSync(path)) throw new Error(ofBrief ? `There is no Brief draft at ${path} yet; write the Brief there first.` : `There is no file at ${path} to ask about; write it first.`);
		const bytes = readFileSync(path);
		let snapshot: string;
		try {
			snapshot = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new Error(`${ofBrief ? "The Brief draft" : "The file"} ${path} is not valid UTF-8 text; write it as markdown.`);
		}
		if (checkpoint === BRIEF) {
			const found = inForce(state);
			if ("error" in found) throw new Error(`The Brief of Effort \`${state.effortId}\` can't be asked about: ${found.error}.`);
			const problems = validateBrief(snapshot, { team: state.team, repo: state.repo, playbook: found.playbook, roles: found.team.roles.map((role) => role.name) });
			if (problems.length > 0) throw new Error(`The Brief ${path} can't be asked about until these are fixed:\n${bullets(problems)}`);
		} else if (checkpoint === BRIEF_CHANGE && current) {
			const problems = briefChangeProblems(snapshot, current, state);
			if (problems.length > 0) throw new Error(`The Brief change ${path} can't be asked about until these are fixed:\n${bullets(problems)}`);
		}
		const result = step(state, { kind: "request-approval", checkpoint, path, sha256: sha256(bytes), snapshot, ...(affects === undefined ? {} : { affects }), checkpoints, at: now().toISOString() });
		if (!result.ok) throw new Error(result.refusal);
		appendLines(held.paths, result.append);
		return result.reply ?? "";
	}

	/**
	 * The Effort a Lead tool that leads to a Teammate works on: refused before
	 * the Brief is approved, and on any record changed since.
	 */
	function approvedEffort(tool: "team_plan" | "team_handoff" | "team_review", ctx: ExtensionContext): { held: HeldEffort; state: EffortState } {
		if (!effort) throw new Error(`No Effort is open in this session, so \`${tool}\` has nothing to work on; the human opens one with \`/team start <team>\`.`);
		const state = effortState(effort);
		const result = step(state, { kind: "start-teammate", tool });
		if (!result.ok) throw new Error(result.refusal);
		approved(effort, ctx);
		return { held: effort, state };
	}

	/**
	 * The Effort's approved Brief and its Team and Playbook snapshot, which is
	 * all it staffs and answers from: each checked against its approval
	 * first, and one changed since told to the human and never used.
	 */
	function approved(held: HeldEffort, ctx: ExtensionContext | undefined = leadCtx): Approved {
		try {
			return readApproved(held.paths, held.effortId);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			ctx?.ui.notify(text, "error");
			throw new Error(`${text}\n\nStop and tell the human; the Effort goes on once its records match their approval.`);
		}
	}

	/** The mode a Teammate handed `slug` launches in, when the plan and the snapshot name its Role: drift is measured against it. */
	function launchMode(state: EffortState, slug: string, roles: Role[], playbook: Playbook): string | undefined {
		const planned = state.plan?.find((task) => task.slug === slug);
		const role = planned && roles.find((each) => each.name === planned.role);
		return role ? modeInForce(playbook, role) : undefined;
	}

	/**
	 * Get `pointer` to Teammate `teammateId` as its next turn: through its inbox
	 * while `claude agents --json` lists it and the send goes through, otherwise
	 * by resuming its session with the pointer as the message (ADR-0006), whose
	 * `SessionStart` brings the new socket. Only a send wakes a Teammate.
	 */
	async function deliver(held: HeldEffort, teammateId: string, inbox: Inbox, pointer: string): Promise<{ error: string } | undefined> {
		const teammate = effortState(held).teammates.find((each) => each.id === teammateId);
		const agents = await agentsList(paths.claudePath);
		// When the list can't be read, the send is the test of whether it is there.
		const listed = !(agents instanceof Map) || (teammate !== undefined && agents.has(teammate.name));
		const sent = listed ? await sendToInbox(inbox, pointer) : { error: "it isn't in `claude agents --json`" };
		if (!sent) return undefined;
		const sessionId = teammate?.sessionId;
		const workspace = effortState(held).workspace;
		if (sessionId === undefined || !workspace) return sent;
		const resumed = await launchBackground(paths.claudePath, workdir(effortState(held), teammateId) ?? workspace.path, ["--bg", "--resume", sessionId, pointer]);
		return resumed ? { error: `${sent.error}, and resuming its session failed: ${resumed.error}` } : undefined;
	}

	/**
	 * Accept an isolated Task by merging its branch into the Effort branch. The
	 * intent is on record before git runs, so a merge cut short is found again;
	 * a refused merge closes it and leaves the Task in review. Once merged, the
	 * Task is accepted for good: a Teammate that won't stop or a worktree that
	 * won't go is told to the Lead, not undone.
	 */
	async function acceptMerged(held: HeldEffort, result: Extract<Step, { ok: true }>, merge: Extract<EffortAction, { kind: "merge" }>): Promise<string> {
		appendLines(held.paths, result.append);
		const merged = mergeTaskWorkspace(merge);
		const outcome = step(result.state, { kind: "merge-result", slug: merge.slug, at: now().toISOString(), ...merged });
		if (!outcome.ok) throw new Error(outcome.refusal);
		appendLines(held.paths, outcome.append);
		if ("error" in merged) {
			writePlan(held.paths, outcome.state);
			throw new Error(outcome.reply);
		}
		const notes: string[] = [];
		let stopped = true;
		for (const action of outcome.actions) {
			if (action.kind === "stop-teammate") {
				const failed = await stopTeammate(outcome.state, action);
				if (failed) {
					stopped = false;
					notes.push(`\`${action.teammate}\` didn't stop (${failed.error}), so its worktree is left in place; tell the human.`);
				}
			} else if (action.kind === "remove-task-workspace" && stopped && result.state.workspace) {
				const left = removeTaskWorkspace(result.state.workspace.path, action);
				if (left) notes.push(`Its worktree or branch is left in place: ${left}`);
			} else if (action.kind === "write-plan") writePlan(held.paths, outcome.state);
		}
		return [outcome.reply ?? "", ...notes].join(" ");
	}

	/** The `claude --bg` arguments that start `teammate` in `role` in the folder `cwd`, with `pointer` as its first turn. */
	function launchArgs(held: HeldEffort, teammate: { id: string; name: string }, role: Role, playbook: Playbook, pointer: string, cwd: string): string[] {
		return teammateArgs({
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
				workspace: cwd,
				humanStatusLine: humanStatusLine(effortState(held).workspace?.path ?? effortState(held).repo, claudeDir),
			}),
			prompt: teammatePrompt({ teammateId: teammate.id, role: role.name, brief: held.paths.brief, clarifications: held.paths.clarifications, tasks: held.paths.tasks }, role.prompt),
			pointer,
			mod: installMod(paths.agentDir),
		});
	}

	/** Carry out a step's actions in order, then append its lines: records are written before the line that claims them. */
	async function carryOut(held: HeldEffort, result: Extract<Step, { ok: true }>, launch: (action: Extract<EffortAction, { kind: "launch-teammate" }>) => Promise<void>): Promise<void> {
		for (const action of result.actions) {
			if (action.kind === "write-plan") writePlan(held.paths, result.state);
			else if (action.kind === "launch-teammate") await launch(action);
			else if (action.kind === "stop-teammate") {
				const stopped = await stopTeammate(result.state, action);
				if (stopped) throw new Error(`Teammate \`${action.teammate}\` couldn't be stopped with \`claude stop ${action.shortId}\` (${stopped.error}), so nothing was re-planned. Stop and tell the human.`);
			}
		}
		appendLines(held.paths, result.append);
	}

	/**
	 * Stop a Teammate with `claude stop`, which keeps its conversation for the
	 * human to read. One already idle-stopped needs none: a failed stop counts
	 * only while `claude agents --json` still lists it, or can't be read.
	 */
	async function stopTeammate(state: EffortState, action: Extract<EffortAction, { kind: "stop-teammate" }>): Promise<{ error: string } | undefined> {
		const stopped = await stopBackground(paths.claudePath, action.shortId);
		if (!stopped) return undefined;
		const agents = await agentsList(paths.claudePath);
		const name = state.teammates.find((teammate) => teammate.id === action.teammate)?.name;
		return !(agents instanceof Map) || (name !== undefined && agents.has(name)) ? stopped : undefined;
	}

	/**
	 * Carry out a staffing step, from a handoff or a drain: write the Task,
	 * stop and start Teammates, record it all, then clear a reused Teammate.
	 * The clear is on record before its marker goes, since the `SessionStart`
	 * it causes is what sends the Task's pointer.
	 */
	async function staffTask(held: HeldEffort, result: Extract<Step, { ok: true }>, body?: string): Promise<void> {
		// A launch under an id the Effort already has is a fresh session for that Teammate: its journal waits for the lines.
		const known = new Set(effortState(held).teammates.map((teammate) => teammate.id));
		const fresh = result.actions.flatMap((action) => (action.kind === "launch-teammate" && known.has(action.teammate.id) ? [action.teammate.id] : []));
		for (const id of fresh) relaunching.add(id);
		try {
			await staffTaskNow(held, result, body);
		} finally {
			for (const id of fresh) relaunching.delete(id);
		}
	}

	/** {@link staffTask}, past the journal hold. */
	async function staffTaskNow(held: HeldEffort, result: Extract<Step, { ok: true }>, body?: string): Promise<void> {
		const { roles, playbook } = approved(held);
		const stopped: string[] = [];
		const added: Extract<EffortAction, { kind: "add-task-workspace" }>[] = [];
		const feedback = result.actions.find((action) => action.kind === "write-feedback");
		// A send-back whose Teammate ended takes its feedback back if no Teammate starts on it, so the Lead can send it back again.
		const still = (slug: string): string =>
			feedback ? `Task \`${slug}\` isn't sent back and its feedback-${feedback.round}.md is taken back` : `Task \`${slug}\` is still ${body === undefined ? "queued" : "planned"}`;
		const written = feedback ? writeFeedback(held.paths, feedback.folder, feedback.round, feedback.feedback) : undefined;
		try {
			for (const action of result.actions) {
				if (action.kind === "write-task" && body !== undefined) writeTask(held.paths, action.folder, body);
				else if (action.kind === "add-task-workspace") {
					const cut = addTaskWorkspace(result.state.repo, action);
					if ("error" in cut) throw new Error(`Task \`${action.slug}\` didn't get a worktree of its own, so it is still ${body === undefined ? "queued" : "planned"}: ${cut.error}`);
					added.push(action);
				} else if (action.kind === "write-plan") writePlan(held.paths, result.state);
				else if (action.kind === "stop-teammate") {
					const failed = await stopTeammate(result.state, action);
					if (failed) throw new Error(`Idle Teammate \`${action.teammate}\` didn't stop (${failed.error}), so no Teammate starts in its place; stop and tell the human.`);
					stopped.push(action.teammate);
				} else if (action.kind === "launch-teammate") {
					// Written ahead, so a restart mid-launch finds the Teammate again rather than starting a second.
					appendLines(held.paths, [{ type: "launch-intended", teammate: action.teammate.id, name: action.teammate.name, lines: result.append, at: now().toISOString() }]);
					const failed = await launchTeammate(held, result.state, action, roles, playbook);
					if (failed) {
						// Its worktree goes with it: nothing was worked there, and a handoff again cuts it afresh.
						for (const worktree of added) removeTaskWorkspace(result.state.repo, worktree, true);
						// The idle Teammate stopped for it is gone either way.
						appendLines(held.paths, [
							...result.append.filter((line) => line.type === "teammate-retired" && stopped.includes(line.teammate)),
							{ type: "launch-abandoned", teammate: action.teammate.id, reason: failed, at: now().toISOString() },
						]);
						throw new Error(`Teammate \`${action.teammate.id}\` didn't start, so ${still(action.task.slug)}: ${failed}`);
					}
				}
			}
		} catch (error) {
			if (written) rmSync(written, { force: true });
			throw error;
		}
		appendLines(held.paths, result.append);
		for (const action of result.actions) {
			if (action.kind !== "clear-then-send") continue;
			const failed = await sendToInbox(action.inbox, CLEAR_MARKER);
			if (failed) {
				throw new Error(
					`Task \`${action.slug}\` is handed to \`${action.teammate}\`, but the clear couldn't reach its inbox (${failed.error}), so it isn't working on it. Stop and tell the human.`,
				);
			}
		}
	}

	/**
	 * Start the queued Tasks a freed Teammate makes room for, one staffing step
	 * at a time, and return what each step did. One that fails stays queued,
	 * and the Lead hears why rather than losing what came before.
	 */
	async function startQueued(held: HeldEffort, state: EffortState, ctx: ExtensionContext): Promise<string[]> {
		const said: string[] = [];
		for (;;) {
			const agents = await listedNames();
			const drained = step(state, { kind: "drain", at: now().toISOString(), maxTeammates: maxTeammates(), ...(agents ? { agents } : {}) });
			if (!drained.ok) break;
			if (drained.reply === undefined) {
				// Nothing starts; the lines left say why each queued Task still waits, now that a pause no longer does.
				appendLines(held.paths, drained.append);
				break;
			}
			try {
				await listenForTeammates(held, ctx);
				await staffTask(held, drained);
			} catch (error) {
				said.push(`A queued Task didn't start: ${error instanceof Error ? error.message : String(error)}`);
				break;
			}
			said.push(drained.reply);
			state = drained.state;
		}
		if (said.length > 0) wakeAboutTeammates(applyJournals(held));
		return said;
	}

	/** Lift `by`'s own pause and start the queued Tasks it held back, saying what happened; refused while `by` holds none. */
	async function liftPause(held: HeldEffort, by: "human" | "lead", ctx: ExtensionContext): Promise<{ ok: true; said: string } | { ok: false; refusal: string }> {
		const result = step(effortState(held), { kind: "resume", by, at: now().toISOString() });
		if (!result.ok) return result;
		appendLines(held.paths, result.append);
		const started = await startQueued(held, result.state, ctx);
		paintBlock();
		return { ok: true, said: [result.reply ?? "", ...started].join(" ") };
	}

	/** Launch a Teammate once its stagger is up, returning why it didn't start. */
	async function launchTeammate(
		held: HeldEffort,
		state: EffortState,
		{ teammate, task, at }: Extract<EffortAction, { kind: "launch-teammate" }>,
		roles: Role[],
		playbook: Playbook,
	): Promise<string | undefined> {
		const role = roles.find((each) => each.name === teammate.role);
		if (!role) return `the Team snapshot of Effort \`${held.effortId}\` has no Role \`${teammate.role}\`; stop and tell the human.`;
		if (!state.workspace) return `Effort \`${held.effortId}\` has no Workspace; stop and tell the human.`;
		const wait = Date.parse(at) - now().getTime();
		if (wait > 0) await sleep(wait);
		const cwd = workdir(state, teammate.id) ?? state.workspace.path;
		const args = launchArgs(held, teammate, role, playbook, launchPointer(task.slug, join(held.paths.tasks, task.folder), state.tasks[task.slug]?.round ?? 1), cwd);
		return (await launchBackground(paths.claudePath, cwd, args))?.error;
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
			if (startsTeam) await land(pickTeam(listTeams(paths), item.team), ctx);
		} else if (answer === SEND_BACK) {
			const note = (await ctx.ui.input("Note for the Lead: what should change?"))?.trim();
			// Backing out of the note leaves the item waiting, as "later" does.
			if (!note) return;
			pending = pending.filter((waiting) => waiting !== item);
			wakeLead("team-pending", sentBackText(item, note));
		}
	}

	/** One usage item in `/team pending`: the choices its kind offers, or leave it for later. */
	async function answerUsage(held: HeldEffort, item: UsageItem, ctx: ExtensionCommandContext): Promise<void> {
		const choices = USAGE_CHOICES[item.why];
		const answer = await ctx.ui.select(usageText(item, effortState(held).teammates), [...choices.map((choice) => USAGE_LABELS[choice]), LATER]);
		const choice = choices.find((each) => USAGE_LABELS[each] === answer);
		if (choice === undefined) return;
		const state = effortState(held);
		const result = step(state, { kind: "answer-usage", id: item.id, choice, at: now().toISOString() });
		if (!result.ok) {
			ctx.ui.notify(result.refusal, "error");
			return;
		}
		// Cancelling ends the Effort as `/team cancel` does.
		if (result.actions.some((action) => action.kind === "end-effort")) return carryOutEnd(held, state, result, ctx);
		const texts: string[] = [];
		for (const action of result.actions) {
			if (action.kind !== "stop-teammate") continue;
			const failed = await stopTeammate(result.state, action);
			if (failed) texts.push(`\`${action.teammate}\` didn't stop with \`claude stop ${action.shortId}\` (${failed.error}); tell the human.`);
		}
		appendLines(held.paths, result.append);
		texts.unshift(...(await afterUsage(held, result)));
		ctx.ui.notify(result.reply ?? "", "info");
		wakeAboutTeammates(texts);
	}

	/**
	 * The escalated items in `/team pending`, oldest first: a permission takes
	 * allow or deny with a reason, a question the Teammate's own options, and a
	 * prose question the human's words. Backing out leaves an item for later.
	 * Each is looked up again before it is asked and before its answer is
	 * taken, since its Teammate's terminal can settle it meanwhile.
	 */
	async function answerEscalations(held: HeldEffort, items: readonly Escalation[], ctx: ExtensionCommandContext): Promise<void> {
		for (const { id } of items) {
			if (effort !== held) return;
			wakeAboutTeammates(applyJournals(held));
			const escalation = openEscalations(effortState(held)).find((each) => each.id === id);
			if (!escalation) continue;
			const answer = await askEscalation(held, escalation, ctx);
			if (!answer || effort !== held) continue;
			wakeAboutTeammates(applyJournals(held));
			const result = step(effortState(held), { kind: "answer-escalation", id, ...answer, at: now().toISOString() });
			if (!result.ok) {
				ctx.ui.notify(result.refusal, "error");
				continue;
			}
			const failed = await carryOutAnswer(held, result);
			if (failed) ctx.ui.notify(failed, "error");
		}
	}

	/** The human's answer to one escalated item, from its dialogs, or undefined when they leave it for later. */
	async function askEscalation(
		held: HeldEffort,
		escalation: Escalation,
		ctx: ExtensionCommandContext,
	): Promise<{ decision?: "allow" | "deny"; reason?: string; answers?: Record<string, string | string[]>; text?: string } | undefined> {
		const state = effortState(held);
		const head = [
			`\`${escalation.id}\`: ${escalationText(escalation, state)}, escalated by the Lead: ${escalation.summary}`,
			...(escalation.brief === undefined ? [] : [`The Brief says: ${escalation.brief}`]),
		];
		if (escalation.kind === "prose") {
			const title = [...head, `${escalation.teammate} asks: ${escalation.question}`, `Your answer goes to ${escalation.teammate} and into clarifications.md:`].join("\n");
			const text = (await ctx.ui.input(title))?.trim();
			return text ? { text } : undefined;
		}
		if (escalation.kind === "permission") {
			const picked = await ctx.ui.select([...head, `It asks for ${escalation.question}.`].join("\n"), [ALLOW, DENY, LATER]);
			if (picked !== ALLOW && picked !== DENY) return undefined;
			const decision = picked === ALLOW ? "allow" : "deny";
			const reason = await ctx.ui.input(decision === "deny" ? `Why not? ${escalation.teammate} reads it:` : "Why? The Lead and the next Report read it:");
			if (reason === undefined) return undefined;
			return { decision, reason: reason.trim() || `the human ${decision === "allow" ? "allowed" : "denied"} it in /team pending` };
		}
		const request = state.teammateRequests[escalation.id];
		if (!request) return undefined;
		const answers: Record<string, string | string[]> = {};
		for (const [n, asked] of askedQuestions(request).entries()) {
			const title = [...(n === 0 ? head : [`\`${escalation.id}\`, question ${n + 1}:`]), `"${asked.question}"${asked.multiSelect ? " (pick any, then Done)" : ""}`].join("\n");
			if (!asked.multiSelect) {
				const label = await ctx.ui.select(title, [...asked.labels, LATER]);
				if (label === undefined || !asked.labels.includes(label)) return undefined;
				answers[asked.question] = label;
				continue;
			}
			const picks = new Set<string>();
			while (picks.size < asked.labels.length) {
				const left = asked.labels.filter((label) => !picks.has(label));
				const label = await ctx.ui.select(title, [...left, ...(picks.size > 0 ? [DONE] : []), LATER]);
				if (label === DONE) break;
				if (label === undefined || !left.includes(label)) return undefined;
				picks.add(label);
			}
			answers[asked.question] = asked.labels.filter((label) => picks.has(label));
		}
		return { answers };
	}

	/**
	 * Carry out the human's answer to an escalated item: the hook's decision or
	 * the Teammate's message goes first, and only once it got there is the
	 * answer kept in clarifications.md, on record, and the Lead woken with it.
	 * What went wrong, or undefined.
	 */
	async function carryOutAnswer(held: HeldEffort, result: Extract<Step, { ok: true }>): Promise<string | undefined> {
		const opened = await bridge?.catch(() => undefined);
		for (const action of result.actions) {
			if (action.kind === "answer-hook" && !opened?.answer(action.request, action.decision)) {
				wakeAboutTeammates(applyJournals(held));
				return `No hook holds \`${action.request}\` any more, so your answer can't reach it: it waits in ${action.teammate}'s terminal (\`/team attach ${action.teammate}\`).`;
			}
			if (action.kind === "send-message") {
				const failed = await deliver(held, action.teammate, action.inbox, action.message);
				if (failed) return `Your answer didn't reach ${action.teammate}, so it still waits: ${failed.error}.`;
			}
		}
		for (const action of result.actions) if (action.kind === "append-clarification") appendClarification(held.paths, action.entry);
		appendLines(held.paths, result.append);
		for (const action of result.actions) if (action.kind === "wake-lead") wakeLead("team-pending", action.text);
		paintBlock();
		return undefined;
	}
	/**
	 * The Effort's requests in `/team pending`: each proposed Playbook change
	 * first, since sign-off waits for them, then sign-off, then a Brief. Each
	 * is looked up again before it is asked, since an answer can end the
	 * Effort or drop what came with it.
	 */
	async function answerApprovals(held: HeldEffort, items: readonly PendingApproval[], ctx: ExtensionCommandContext): Promise<void> {
		const order = [PLAYBOOK_CHANGE, SIGN_OFF];
		const rank = (item: PendingApproval) => (order.includes(item.checkpoint) ? order.indexOf(item.checkpoint) : order.length);
		for (const { id } of [...items].sort((a, b) => rank(a) - rank(b))) {
			if (effort !== held) return;
			const item = effortState(held).pending.find((each) => each.id === id);
			if (!item) continue;
			if (item.checkpoint === PLAYBOOK_CHANGE) await answerChange(held, item, ctx);
			else if (item.checkpoint === SIGN_OFF) await answerSignOff(held, item, ctx);
			else if (item.checkpoint === BRIEF) await answerBrief(held, item, ctx);
			else if (item.checkpoint === BRIEF_CHANGE) await answerBriefChange(held, item, ctx);
			else await answerCheckpoint(held, item, ctx);
		}
	}

	/** Approve, send back with a note, or leave for later: what the human answers to `title`; undefined leaves the item waiting. */
	async function approveOrSendBack(title: string, ctx: ExtensionCommandContext): Promise<{ answer: "approved" | "sent-back"; note?: string } | undefined> {
		const answer = await ctx.ui.select(title, [APPROVE, SEND_BACK, LATER]);
		if (answer === APPROVE) return { answer: "approved" };
		if (answer !== SEND_BACK) return undefined;
		const note = (await ctx.ui.input("Note for the Lead: what should change?"))?.trim();
		// Backing out of the note leaves the item waiting, as "later" does.
		return note ? { answer: "sent-back", note } : undefined;
	}

	/**
	 * A Brief change in `/team pending`. Approving checks the snapshot again
	 * against the Effort's Playbook snapshot, makes it brief.md and records it
	 * before the line that approves it, then starts the Tasks it held. A
	 * send-back keeps them held.
	 */
	async function answerBriefChange(held: HeldEffort, item: PendingApproval, ctx: ExtensionCommandContext): Promise<void> {
		const state = effortState(held);
		const current = approved(held, ctx);
		const holds = item.affects ?? [];
		const title = [
			`Approve a Brief change of Effort \`${state.effortId}\` (request \`${item.id}\`)? ${item.path} (sha256 ${item.sha256})`,
			holds.length > 0 ? `It holds Task${holds.length === 1 ? "" : "s"} ${holds.map((slug) => `\`${slug}\``).join(", ")} until you answer; every other Task goes on.` : "It holds no Task.",
			"Approving makes exactly this snapshot brief.md; the Team and Playbook snapshots stay as they are.",
		].join("\n");
		const picked = await approveOrSendBack(title, ctx);
		if (!picked) return;
		if (picked.answer === "approved") {
			const problems = briefChangeProblems(item.snapshot, current, state);
			if (problems.length > 0) {
				ctx.ui.notify(`The Brief change of Effort \`${state.effortId}\` (request \`${item.id}\`) can't be approved:\n${bullets(problems)}`, "error");
				return;
			}
		}
		const at = now().toISOString();
		const refresh = picked.answer === "approved" ? changedLaunch(current, item.snapshot) : [];
		const result = step(state, { kind: "answer", id: item.id, ...picked, ...(refresh.length > 0 ? { refresh } : {}), at });
		if (!result.ok) {
			ctx.ui.notify(result.refusal, "error");
			return;
		}
		for (const action of result.actions) {
			if (action.kind === "promote-brief-change") promoteBriefChange(held.paths, { approval: action.approval, refresh, at });
		}
		appendLines(held.paths, result.append);
		if (picked.answer === "approved") ctx.ui.notify(`Approved the Brief change of Effort \`${state.effortId}\`: ${held.paths.brief}, sha256 ${item.sha256}.`, "info");
		for (const action of result.actions) {
			if (action.kind === "wake-lead") wakeLead("team-pending", action.text);
		}
		if (picked.answer === "approved") {
			for (const text of await startQueued(held, effortState(held), ctx)) ctx.ui.notify(text, "info");
		}
	}

	/** An approval at a Playbook checkpoint or \`escalate\` id in \`/team pending\`: approving records the file with its sha, as the human was asked about it. */
	async function answerCheckpoint(held: HeldEffort, item: PendingApproval, ctx: ExtensionCommandContext): Promise<void> {
		const picked = await approveOrSendBack(`Approve checkpoint \`${item.checkpoint}\` of Effort \`${held.effortId}\` (request \`${item.id}\`)? ${item.path} (sha256 ${item.sha256})`, ctx);
		if (!picked) return;
		if (picked.answer === "approved" && (!existsSync(item.path) || sha256(readFileSync(item.path)) !== item.sha256)) {
			ctx.ui.notify(`${item.path} changed since checkpoint \`${item.checkpoint}\` was asked (request \`${item.id}\`, sha256 ${item.sha256}), so it isn't approved. Nothing changed; send it back, or ask again.`, "error");
			return;
		}
		const state = effortState(held);
		const at = now().toISOString();
		const result = step(state, { kind: "answer", id: item.id, ...picked, at });
		if (!result.ok) {
			ctx.ui.notify(result.refusal, "error");
			return;
		}
		for (const action of result.actions) {
			if (action.kind === "record-checkpoint") {
				recordApproval(held.paths, { act: "checkpoint", checkpoint: action.approval.checkpoint, request: action.approval.id, path: action.approval.path, sha256: action.approval.sha256, at });
			}
		}
		appendLines(held.paths, result.append);
		if (picked.answer === "approved") ctx.ui.notify(`Approved checkpoint \`${item.checkpoint}\` of Effort \`${state.effortId}\`: ${item.path}, sha256 ${item.sha256}.`, "info");
		for (const action of result.actions) {
			if (action.kind === "wake-lead") wakeLead("team-pending", action.text);
		}
	}

	/** Sign-off of the final Report in `/team pending`: approve it, which ends the Effort, send it back with a note, or leave it for later. */
	async function answerSignOff(held: HeldEffort, item: PendingApproval, ctx: ExtensionCommandContext): Promise<void> {
		const title = [
			`Sign off the final Report of Effort \`${held.effortId}\`: ${item.path} (sha256 ${item.sha256})?`,
			"Signing off stops every Teammate and ends the Effort; its clean worktrees are removed and every branch is kept.",
		].join("\n");
		const answer = await ctx.ui.select(title, [APPROVE, SEND_BACK, LATER]);
		let note: string | undefined;
		if (answer === SEND_BACK) {
			note = (await ctx.ui.input("Note for the Lead: what should change?"))?.trim();
			// Backing out of the note leaves the item waiting, as "later" does.
			if (!note) return;
		} else if (answer !== APPROVE) {
			return;
		}
		// What is signed off is the file as the human was asked about it.
		if (answer === APPROVE && (!existsSync(item.path) || sha256(readFileSync(item.path)) !== item.sha256)) {
			ctx.ui.notify(`The final Report ${item.path} changed since sign-off was asked (request \`${item.id}\`, sha256 ${item.sha256}), so it isn't signed off. Nothing changed; send it back for a new final Report.`, "error");
			return;
		}
		const state = effortState(held);
		const result = step(state, { kind: "answer", id: item.id, answer: answer === APPROVE ? "approved" : "sent-back", note, at: now().toISOString() });
		if (!result.ok) {
			ctx.ui.notify(result.refusal, "error");
			return;
		}
		await carryOutEnd(held, state, result, ctx);
	}

	/**
	 * Carry out a step that can end the Effort, sign-off or cancel: the
	 * sign-off is recorded before the line that claims it, then every Teammate
	 * is stopped and the lines appended, and the session lets the Effort go.
	 */
	async function carryOutEnd(held: HeldEffort, state: EffortState, result: Extract<Step, { ok: true }>, ctx: ExtensionCommandContext): Promise<void> {
		for (const action of result.actions) {
			if (action.kind === "record-sign-off") recordApproval(held.paths, { act: "sign-off", request: action.approval.id, report: action.approval.sha256, at: action.at });
		}
		const unstopped: string[] = [];
		for (const action of result.actions) {
			if (action.kind !== "stop-teammate") continue;
			const failed = await stopTeammate(state, action);
			if (failed) unstopped.push(`\`${action.teammate}\` (${failed.error})`);
		}
		appendLines(held.paths, result.append);
		for (const action of result.actions) {
			if (action.kind === "wake-lead") wakeLead("team-pending", action.text);
			else if (action.kind === "end-effort") await endEffort(held, state, result.reply ?? "", unstopped, ctx);
		}
		paintBlock();
	}

	/**
	 * Let go of an Effort that has ended: its clean worktrees go and every
	 * branch stays, then the bridge closes, `lead.json` marks no live Lead and
	 * the session holds no Effort, so its tools are off and the block is gone.
	 * While a Teammate didn't stop, its worktrees are all left in place.
	 */
	async function endEffort(held: HeldEffort, state: EffortState, said: string, unstopped: readonly string[], ctx: ExtensionContext): Promise<void> {
		const notes = [said];
		if (unstopped.length > 0) {
			notes.push(`These didn't stop, so every worktree is left in place: ${unstopped.join(", ")}. Stop them with \`claude stop\`.`);
		} else {
			try {
				const { removed, kept } = endWorktrees(state.repo, held.effortId);
				if (removed.length > 0) notes.push(`Removed the clean worktrees ${removed.map((each) => each.path).join(", ")}.`);
				for (const each of kept) notes.push(`Kept ${each.path} (\`${each.branch}\`): ${each.why}.`);
			} catch (error) {
				notes.push(`Its worktrees are left in place: ${error instanceof Error ? error.message : String(error)}.`);
			}
		}
		notes.push("Every branch is kept.");
		const open = bridge;
		bridge = undefined;
		await open?.then(
			(opened) => opened.close(),
			() => {},
		);
		try {
			await leaveLead(held.paths, leader(ctx), now().toISOString());
		} catch (error) {
			notes.push(error instanceof Error ? error.message : String(error));
		}
		if (effort === held) effort = undefined;
		syncLeadTools();
		paintBlock();
		ctx.ui.notify(notes.join(" "), unstopped.length > 0 ? "warning" : "info");
		pi.sendMessage(
			{ customType: "team-ended", content: `${said} This session holds no Effort now, so the Team tools are off.`, display: true },
			{ deliverAs: "nextTurn" },
		);
	}

	/** A Playbook change the final Report proposed, in `/team pending`: adopt it for the next Effort, decline it, or leave it for later. */
	async function answerChange(held: HeldEffort, item: PendingApproval, ctx: ExtensionCommandContext): Promise<void> {
		const change = item.change;
		if (!change) return;
		const state = effortState(held);
		const title = `${item.snapshot}\nAdopt it into the \`${state.team}\` Playbook for the next Effort? This Effort keeps the Playbook it runs on.`;
		const answer = await ctx.ui.select(title, [ADOPT_CHANGE, DECLINE, LATER]);
		if (answer !== ADOPT_CHANGE && answer !== DECLINE) return;
		const at = now();
		const result = step(state, { kind: "answer", id: item.id, answer: answer === ADOPT_CHANGE ? "approved" : "declined", at: at.toISOString() });
		if (!result.ok) {
			ctx.ui.notify(result.refusal, "error");
			return;
		}
		let where = "";
		for (const action of result.actions) {
			if (action.kind !== "adopt-playbook-change") continue;
			const team = loadTeam(paths, state.team);
			const adopted = team ? adoptPlaybookChange(paths.agentDir, team, action.approval.change, at) : { error: `Team \`${state.team}\` no longer exists` };
			if ("error" in adopted) {
				ctx.ui.notify(`Playbook change \`${change.id}\` (request \`${item.id}\`) can't be adopted: ${adopted.error}. Nothing was adopted; decline it, or fix that and answer it again.`, "error");
				return;
			}
			recordApproval(held.paths, { act: "playbook-change", request: item.id, change: change.id, sha256: item.sha256, playbook: adopted.sha256, at: action.at });
			where = ` It is in ${adopted.adopted} (sha256 ${adopted.sha256}).`;
		}
		appendLines(held.paths, result.append);
		ctx.ui.notify(`${result.reply ?? ""}${where}`, "info");
	}

	/**
	 * What the shell gathers for the final Report: the checkpoints the Effort's
	 * Playbook snapshot names, the proposed changes, each checked to apply to
	 * that Playbook, and the Effort's worktrees as git has them now.
	 */
	function finalFacts(held: HeldEffort, state: EffortState, changes: readonly PlaybookChange[]): FinalFacts {
		const { roles, playbook } = approved(held);
		const problems = changes.flatMap((change) => {
			const made = changedPlaybook(playbook, change, roles.map((role) => role.name));
			return "error" in made ? [`Playbook change \`${change.id}\`: ${made.error}`] : [];
		});
		if (problems.length > 0) throw new Error(`The final Report wasn't written:\n${bullets(problems)}`);
		return { checkpoints: playbook.checkpoints.map((checkpoint) => checkpoint.id), changes, worktrees: effortWorktrees(state.repo, held.effortId) };
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
				await land(args[0] === undefined ? proposeTeam(teams) : pickTeam(teams, args[0]), ctx);
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
				if (held) wakeAboutTeammates(applyJournals(held));
				const state = held ? effortState(held) : undefined;
				const briefs = state?.pending ?? [];
				const terminal = state ? waitingInTerminal(state) : [];
				const escalated = state ? openEscalations(state) : [];
				const usage = state?.usageItems ?? [];
				if (pending.length === 0 && briefs.length === 0 && terminal.length === 0 && escalated.length === 0 && usage.length === 0) {
					ctx.ui.notify("Nothing is waiting on you.", "info");
					return;
				}
				for (const item of [...pending]) await answerAdoption(item, ctx);
				if (held) await answerApprovals(held, briefs, ctx);
				if (held) await answerEscalations(held, escalated, ctx);
				for (const item of terminal) {
					const attach = `Attach to ${item.teammate}`;
					const answer = await ctx.ui.select(`\`${item.request}\` waited past its hook's hold: ${terminalText(item)}`, [attach, LATER]);
					if (answer === attach) await attachTo(item.teammate, ctx);
				}
				// An answer before it can end the Effort, which leaves nothing to answer.
				for (const item of usage) if (held && effort === held) await answerUsage(held, item, ctx);
			},
		},
		pause: {
			async run(args, ctx) {
				if (!effort) {
					ctx.ui.notify("This session holds no Effort, so there is nothing to pause; `/team start` opens one, and `/team resume` adopts one without a live Lead.", "error");
					return;
				}
				const held = effort;
				const result = step(effortState(held), { kind: "pause", by: "human", reason: args.join(" ") || undefined, at: now().toISOString() });
				if (!result.ok) {
					ctx.ui.notify(result.refusal, "info");
					return;
				}
				appendLines(held.paths, result.append);
				paintBlock();
				ctx.ui.notify(result.reply ?? "", "info");
			},
		},
		resume: {
			async run(args, ctx) {
				if (effort) {
					// Only the human's pause is lifted here; adopting is for a session holding no Effort.
					const held = effort;
					const lifted = await liftPause(held, "human", ctx);
					if (!lifted.ok) {
						ctx.ui.notify(lifted.refusal, "info");
						return;
					}
					ctx.ui.notify(lifted.said, "info");
					wakeLead("team-resumed", `The human lifted their pause on Effort \`${held.effortId}\`. ${lifted.said}`);
					return;
				}
				const candidates = adoptable(paths.agentDir);
				const named = args[0];
				if (named === undefined && candidates.length === 0) {
					ctx.ui.notify("No Effort is without a live Lead, so there is nothing to adopt; `/team start` opens a new one.", "info");
					return;
				}
				// One with a live Lead is still tried, so the refusal names the session leading it.
				if (named !== undefined && !existsSync(effortPaths(paths.agentDir, named).log)) {
					const none = candidates.length === 0 ? "none" : candidates.map((id) => `\`${id}\``).join(", ");
					ctx.ui.notify(`There is no Effort \`${named}\` to adopt. Efforts without a live Lead: ${none}.`, "error");
					return;
				}
				const effortId = named ?? (await ctx.ui.select("Adopt which Effort? These have no live Lead:", candidates));
				if (effortId === undefined) return;
				const held = { effortId, paths: effortPaths(paths.agentDir, effortId) };
				if (hasEnded(held.paths)) {
					const how = fold(readLines(held.paths)).ended?.how === "cancelled" ? "cancelled" : "signed off";
					ctx.ui.notify(`Effort \`${effortId}\` was ${how}, so there is nothing to adopt; \`/team start\` opens a new one.`, "error");
					return;
				}
				if (!(await lead(held, ctx, recordsOf(held)))) return;
				pi.appendEntry(POINTER, { effortId, effortDir: held.paths.dir });
				ctx.ui.notify(`Adopted Effort \`${effortId}\` (${held.paths.dir}): this session is its Lead now.`, "info");
			},
		},
		report: {
			async run(_args, ctx) {
				if (!effort) {
					ctx.ui.notify("No Effort is open in this session, so there is nothing to report on; `/team start <team>` opens one.", "error");
					return;
				}
				if (!effortState(effort).brief) {
					ctx.ui.notify(`Effort \`${effort.effortId}\` has no approved Brief yet, so there is nothing to report against.`, "error");
					return;
				}
				wakeLead(
					"team-report-request",
					`The human asked for a Report on Effort \`${effort.effortId}\`. Write one with \`team_report\` now, covering everything since the last Report: where the Effort stands, Brief coverage criterion by criterion, and any work found outside the Brief.`,
				);
				ctx.ui.notify(`Asked the Lead for a Report on Effort \`${effort.effortId}\`.`, "info");
			},
		},
		reports: {
			async run(_args, ctx) {
				if (!effort) {
					ctx.ui.notify("No Effort is open in this session, so there are no Reports to read; `/team resume` adopts one.", "error");
					return;
				}
				const held = effort;
				const written = readReports(held.paths);
				if (written.length === 0) {
					ctx.ui.notify(`No Reports yet for Effort \`${held.effortId}\`.`, "info");
					return;
				}
				const label = (each: (typeof written)[number]) => [`Report ${each.n}`, each.time, each.headline].filter((part) => part).join(" · ");
				const picked = await ctx.ui.select(`Reports of Effort \`${held.effortId}\`, newest first:`, written.map(label));
				const chosen = written.find((each) => label(each) === picked);
				if (!chosen) return;
				// Only pi's terminal can draw an overlay; elsewhere the file is where to read it.
				if (ctx.mode !== "tui") {
					ctx.ui.notify(`Report ${chosen.n} is ${chosen.path}.`, "info");
					return;
				}
				await ctx.ui.custom<void>(
					(tui, theme, _keybindings, done) =>
						new ReportView(tui as unknown as ReportTui, theme as unknown as ReportChrome, `Report ${chosen.n} · ${held.effortId}`, chosen.markdown, () => done()),
					{ overlay: true, overlayOptions: REPORT_OVERLAY },
				);
			},
		},
		cancel: {
			async run(_args, ctx) {
				if (!effort) {
					ctx.ui.notify("This session holds no Effort, so there is nothing to cancel; `/team resume` adopts one without a live Lead.", "error");
					return;
				}
				const held = effort;
				const sure = await ctx.ui.confirm(
					`Cancel Effort \`${held.effortId}\`?`,
					"Every Teammate is stopped and the Effort ends without sign-off. Clean worktrees are removed; every branch, and any worktree with uncommitted changes, is kept.",
				);
				if (!sure) return;
				const state = effortState(held);
				const result = step(state, { kind: "cancel", at: now().toISOString() });
				if (!result.ok) {
					ctx.ui.notify(result.refusal, "error");
					return;
				}
				await carryOutEnd(held, state, result, ctx);
			},
		},
		attach: {
			async run(args, ctx) {
				await attachTo(args[0], ctx);
			},
		},
		handback: {
			async run(args, ctx) {
				const [teammate, ...note] = args;
				if (teammate === undefined) {
					const held = effort ? effortState(effort).teammates.filter((each) => each.takeover !== undefined).map((each) => `\`${each.id}\``) : [];
					ctx.ui.notify(`Name the Teammate to hand back: \`/team handback <teammate> [note]\`. Taken over now: ${held.length === 0 ? "none" : held.join(", ")}.`, "error");
					return;
				}
				await handBackFromPi(teammate, note.length === 0 ? undefined : note.join(" "), ctx);
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
				const text = requestBriefApproval(effort, params.checkpoint, path, params.affects);
				paintBlock();
				return { content: [{ type: "text", text }], details: undefined };
			}
			const team = setup ? loadTeam(paths, setup.team) : undefined;
			const item = requestAdoption(setup, team, params.checkpoint, path);
			// A newer request for the same Team replaces the one the human hasn't answered.
			pending = [...pending.filter((waiting) => waiting.team !== item.team), item];
			paintBlock();
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
			const { roles, brief } = approved(held, ctx);
			const criteria = briefCriteria(brief);
			const result = step(state, { kind: "plan", tasks: params.tasks, criteria, roles: roles.map((role) => role.name), reason: params.reason, at: now().toISOString() });
			if (!result.ok) throw new Error(result.refusal);
			await carryOut(held, result, async () => {});
			// A Teammate stopped with its dropped Task makes room for a queued one.
			const started = result.actions.some((action) => action.kind === "stop-teammate") ? await startQueued(held, result.state, ctx) : [];
			paintBlock();
			return { content: [{ type: "text", text: [result.reply ?? "", ...started].join(" ") }], details: undefined };
		},
	});

	pi.registerTool({
		name: "team_handoff",
		label: "Hand off",
		description: [
			"Hand a planned Task to a Teammate of its Role, which the extension staffs: it reuses an idle Teammate of the Role (clearing its context first), else starts one as a Claude Code background session in the Effort's Workspace while under the human's `maxTeammates`, else stops an idle Teammate no queued Task needs and starts one, else queues the Task until a Teammate frees up.",
			"`body` becomes the Task's `task.md`: make it self-contained, listing the Effort's `brief.md` and `clarifications.md` among its inputs, since the Teammate has no earlier conversation.",
			"While the Effort is paused, by the human, by you or by a usage limit, the Task queues with `paused` and starts by itself once every pause is lifted.",
			"Returns which Teammate was started or reused, or that the Task is queued and why. Refused until the human approves the Brief, and for a Task already handed off or queued (running, in review, sent back or accepted).",
			"`isolated: true` gives the Task a worktree and branch of its own, cut from the Effort branch's tip beside the Workspace, for work that would clash with other Tasks' uncommitted files; its Teammate always starts fresh there. Say in `body` that only what it commits merges: accepting it merges its branch into the Effort branch.",
		].join(" "),
		promptSnippet: "Hand a planned Task to a Teammate once the Brief is approved",
		parameters: HandoffParams,
		defaultActive: false,
		// Each handoff staffs against the Teammates the one before it started.
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { held, state } = approvedEffort("team_handoff", ctx);
			const { roles, playbook } = approved(held);
			const agents = await listedNames();
			const result = step(state, {
				kind: "handoff",
				slug: params.slug,
				at: now().toISOString(),
				mode: launchMode(state, params.slug, roles, playbook),
				maxTeammates: maxTeammates(),
				...(params.isolated ? { isolated: true } : {}),
				...(agents ? { agents } : {}),
			});
			if (!result.ok) throw new Error(result.refusal);
			if (!state.workspace) throw new Error(`Effort \`${held.effortId}\` has no Workspace, so no Teammate starts; stop and tell the human.`);
			await listenForTeammates(held, ctx);
			await staffTask(held, result, params.body);
			// Its hooks can ring before it is recorded as started, so its journal is read once it is.
			wakeAboutTeammates(applyJournals(held));
			return { content: [{ type: "text", text: result.reply ?? "" }], details: undefined };
		},
	});

	pi.registerTool({
		name: "team_review",
		label: "Review",
		description: [
			"Decide on the newest result of a handed-off Task, once its Teammate has written it and you were woken about it.",
			"`accept` marks the Task accepted in plan.md, and starts any queued Task its Teammate frees room for.",
			"Accepting an isolated Task first merges its branch into the Effort branch (`--no-ff`), then stops its Teammate and removes its worktree and branch; while the Workspace has uncommitted changes, the Task's worktree does, or the merge conflicts, nothing is merged and it stays in review.",
			"`send_back` writes `feedback` to the Task's `feedback-<n>.md` and sends its Teammate a pointer to it; the Teammate writes `result-<n+1>.md` and you are woken again.",
			"Refused while the round's result isn't written, for an accepted Task, and for a send-back past the Playbook's `sendBackLimit`, when you escalate to the human instead.",
		].join(" "),
		promptSnippet: "Accept a Task's result, or send it back to its Teammate with feedback",
		parameters: ReviewParams,
		defaultActive: false,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { held, state } = approvedEffort("team_review", ctx);
			const verdict = VERDICTS.find((each) => each === params.verdict);
			if (verdict === undefined) throw new Error(`\`verdict\` is \`accept\` or \`send_back\`, not \`${params.verdict}\`.`);
			const due = state.tasks[params.slug];
			const path = due ? join(held.paths.tasks, due.folder, `result-${due.round}.md`) : "";
			const { roles, playbook } = approved(held);
			const result = step(state, {
				kind: "review",
				slug: params.slug,
				verdict,
				feedback: params.feedback,
				result: { path, written: path !== "" && existsSync(path) },
				sendBackLimit: playbook.sendBackLimit,
				at: now().toISOString(),
				mode: launchMode(state, params.slug, roles, playbook),
				maxTeammates: maxTeammates(),
			});
			if (!result.ok) throw new Error(result.refusal);
			const merge = result.actions.find((action) => action.kind === "merge");
			if (merge) {
				const said = await acceptMerged(held, result, merge);
				const started = await startQueued(held, effortState(held), ctx);
				paintBlock();
				return { content: [{ type: "text", text: [said, ...started].join(" ") }], details: undefined };
			}
			if (result.actions.some((action) => action.kind === "write-feedback")) {
				// Its Teammate has ended: the staffing ladder gives the next round to another, or queues it.
				await listenForTeammates(held, ctx);
				await staffTask(held, result);
				wakeAboutTeammates(applyJournals(held));
				return { content: [{ type: "text", text: result.reply ?? "" }], details: undefined };
			}
			const sends: Extract<EffortAction, { kind: "send-back" }>[] = [];
			for (const action of result.actions) {
				if (action.kind === "send-back") {
					writeFeedback(held.paths, action.folder, action.round, action.feedback);
					sends.push(action);
				} else if (action.kind === "write-plan") writePlan(held.paths, result.state);
			}
			// The send-back is on record before the pointer goes, since the Teammate can answer before the send returns.
			appendLines(held.paths, result.append);
			for (const send of sends) {
				const pointer = sendBackPointer(send.slug, join(held.paths.tasks, send.folder), send.round);
				const failed = await deliver(held, send.teammate, send.inbox, pointer);
				if (failed) {
					throw new Error(
						`Task \`${send.slug}\` is sent back and its feedback-${send.round}.md is written, but the pointer couldn't reach \`${send.teammate}\`'s inbox (${failed.error}), so it isn't working on round ${send.round + 1}. Stop and tell the human.`,
					);
				}
			}
			const started = verdict === "accept" ? await startQueued(held, result.state, ctx) : [];
			return { content: [{ type: "text", text: [result.reply ?? "", ...started].join(" ") }], details: undefined };
		},
	});

	pi.registerTool({
		name: "team_status",
		label: "Team status",
		description: [
			"The held Effort at a glance, as the human sees it in the Team block: the phase, Tasks accepted out of planned, each Teammate's state, Task, context use and permission mode (`acceptEdits≠auto` is drift from the mode it launched in), queued Tasks and why, each pause that holds (who set it, why and since when), the account's usage from the freshest reading (where it came from and when), and what waits on the human.",
			"Returns it as JSON. Changes nothing.",
		].join(" "),
		promptSnippet: "See the Effort's Teammates, Tasks and what waits on the human",
		parameters: Type.Object({}),
		defaultActive: false,
		async execute() {
			if (!effort) throw new Error("No Effort is open in this session, so there is no status to give; the human opens one with `/team start <team>`.");
			const state = effortState(effort);
			const block = teamStatus(state, { adoptionsPending: pending.length });
			// One `claude agents --json` for every row: what Claude Code says of each session, or `missing` once it is gone (idle-stopped).
			const agents = await agentsList(paths.claudePath);
			const status = {
				...block,
				teammates: block.teammates.map((row) => {
					const name = state.teammates.find((teammate) => teammate.id === row.id)?.name;
					if (!(agents instanceof Map) || name === undefined) return row;
					return { ...row, agent: agents.get(name) ?? "missing" };
				}),
			};
			return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], details: status };
		},
	});

	pi.registerTool({
		name: "team_pause",
		label: "Pause",
		description: [
			"Pause the Effort yourself, with a `reason` the human reads in the Team block: no new Task starts and handoffs queue, while running Teammates finish their Task.",
			"Your pause is one of three that hold independently (the human's, yours, a usage limit's); the Effort runs only when none holds, and you lift only yours, with `team_resume`.",
			"Refused while you already hold a pause.",
		].join(" "),
		promptSnippet: "Pause the Effort yourself, saying why",
		parameters: PauseParams,
		defaultActive: false,
		async execute(_toolCallId, params) {
			if (!effort) throw new Error("No Effort is open in this session, so there is nothing to pause; the human opens one with `/team start <team>`.");
			const held = effort;
			const result = step(effortState(held), { kind: "pause", by: "lead", reason: params.reason, at: now().toISOString() });
			if (!result.ok) throw new Error(result.refusal);
			appendLines(held.paths, result.append);
			paintBlock();
			return { content: [{ type: "text", text: result.reply ?? "" }], details: undefined };
		},
	});

	pi.registerTool({
		name: "team_resume",
		label: "Resume",
		description: [
			"Lift your own pause, set with `team_pause`; once no pause holds, queued Tasks start through the staffing ladder and you get back what started.",
			"Refused when you hold no pause: the human's pause is lifted only by the human, with `/team resume`, and a usage pause lifts at its reset.",
		].join(" "),
		promptSnippet: "Lift the pause you set with team_pause",
		parameters: Type.Object({}),
		defaultActive: false,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!effort) throw new Error("No Effort is open in this session, so there is nothing to resume; the human opens one with `/team start <team>`.");
			const lifted = await liftPause(effort, "lead", ctx);
			if (!lifted.ok) throw new Error(lifted.refusal);
			return { content: [{ type: "text", text: lifted.said }], details: undefined };
		},
	});

	pi.registerTool({
		name: "team_report",
		label: "Report",
		description: [
			"Write the next Report to the human: your headline and Brief coverage, with the sections the extension adds from the Effort's log (what happened since the last Report, the plan, what waits on the human, what was decided for them, Teammate modes, work found outside the Brief).",
			"Write the plan Report once you have planned, and another whenever the human asks with `/team report` or the Effort reaches a milestone.",
			"Saved as `reports/<nnn>.md` and shown to the human in chat; you get back only where it went. Refused until the human approves the Brief.",
		].join(" "),
		promptSnippet: "Write a Report to the human: where the Effort stands and Brief coverage",
		parameters: ReportParams,
		defaultActive: false,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!effort) throw new Error("No Effort is open in this session, so there is nothing to report on; the human opens one with `/team start <team>`.");
			const held = effort;
			// The Report's usage is as of now: each live Teammate's status line is read first.
			const state = readStatusLines(held);
			const records = state.brief ? approved(held, ctx) : undefined;
			const criteria = records ? briefCriteria(records.brief) : [];
			// The Role modes go only into the plan Report.
			const snapshot = state.reports === 0 ? records : undefined;
			const modes = snapshot ? snapshot.roles.map((role) => ({ role: role.name, mode: modeInForce(snapshot.playbook, role) })) : [];
			const final = params.final && state.brief ? finalFacts(held, state, params.changes ?? []) : undefined;
			const leadCostUsd = leadCost(ctx.sessionManager.getEntries());
			const at = now().toISOString();
			const result = step(state, { kind: "report", headline: params.headline, coverage: params.coverage, found: params.found, criteria, modes, final, leadCostUsd, at });
			if (!result.ok) throw new Error(result.refusal);
			let details: ReportDetails | undefined;
			const replies = [result.reply ?? ""];
			const append = [...result.append];
			for (const action of result.actions) {
				if (action.kind !== "write-report") continue;
				const markdown = reportMarkdown(held.effortId, action.report);
				// The final Report asks for sign-off of its own bytes, so the request is checked to stand before the file is written.
				if (action.report.final) {
					const asked = step(result.state, {
						kind: "request-sign-off",
						path: reportFile(held.paths, action.report.n),
						sha256: sha256(markdown),
						snapshot: markdown,
						changes: (final?.changes ?? []).map((change) => ({ change, sha256: sha256(changeSnapshot(change)) })),
						at,
					});
					if (!asked.ok) throw new Error(asked.refusal);
					append.push(...asked.append);
					replies.push(asked.reply ?? "");
				}
				details = { n: action.report.n, path: writeReport(held.paths, markdown, action.report.n), headline: action.report.headline, markdown };
			}
			appendLines(held.paths, append);
			paintBlock();
			return { content: [{ type: "text", text: replies.filter((reply) => reply).join(" ") }], details };
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as ReportDetails | undefined;
			if (!details) return new Text(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"), 0, 0);
			if (expanded) return new Text(details.markdown.trimEnd(), 0, 0);
			// Collapsed, it is one line however narrow the chat is: the Report's number and headline.
			const line = `${theme.fg("accent", theme.bold(`Report ${details.n}`))} · ${details.headline} ${theme.fg("dim", "(expand to read it)")}`;
			return { render: (width: number) => [truncateToWidth(line, width)], invalidate() {} };
		},
	});

	pi.registerTool({
		name: "team_answer",
		label: "Answer",
		description: [
			"Answer a Teammate's held request: a permission prompt or an AskUserQuestion its hook holds open while the prompt stays live in its terminal.",
			"For a permission, `decision` is `allow` or `deny` with a `reason`; an allow may add a session `rule` for the same tool and name the `grant` it relies on.",
			"A floor action (push, publish, deploy, send, delete outside the Workspace) is allowed only citing as `grant` a Playbook grant, a Brief override grant, or `delivery` (the Brief's Delivery), and takes no `rule`; one the Playbook's `escalate` entries ask about goes to the human with `team_escalate`.",
			"For an AskUserQuestion, `answers` maps each question's exact text to a label, or a list of labels for a multiSelect question.",
			"The first answer wins: refused once the human answered in the terminal, or the hook gave up holding it. Nothing is allowed by default, and the next Report logs what you decided.",
		].join(" "),
		promptSnippet: "Answer a Teammate's held permission request or AskUserQuestion: allow or deny, with a reason",
		parameters: AnswerParams,
		defaultActive: false,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!effort) throw new Error("No Effort is open in this session, so no request waits on you; the human opens one with `/team start <team>`.");
			const held = effort;
			const decision = params.decision === undefined ? undefined : DECISIONS.find((each) => each === params.decision);
			if (params.decision !== undefined && decision === undefined) throw new Error(`\`decision\` is \`allow\` or \`deny\`, not \`${params.decision}\`.`);
			// What the terminal did meanwhile counts first: the first answer wins.
			wakeAboutTeammates(applyJournals(held));
			const state = effortState(held);
			// What the approved Brief lets you allow on the floor, deletes judged against the Teammate's own folder.
			const asker = state.teammateRequests[params.request]?.teammate;
			const records = state.brief && state.workspace ? approved(held, ctx) : undefined;
			const terms = records && state.workspace ? answerTerms(records.playbook, records.brief, (asker && workdir(state, asker)) ?? state.workspace.path) : undefined;
			const answer = {
				kind: "answer-request" as const,
				request: params.request,
				decision,
				reason: params.reason,
				rule: params.rule,
				grant: params.grant,
				answers: params.answers,
				text: params.text,
				...(terms ? { terms } : {}),
				at: now().toISOString(),
			};
			const result = step(state, answer);
			if (!result.ok) throw new Error(result.refusal);
			const opened = await bridge?.catch(() => undefined);
			for (const action of result.actions) {
				if (action.kind !== "answer-hook" || opened?.answer(action.request, action.decision)) continue;
				// The hook let go between the journal read and the answer: what it journalled says why.
				wakeAboutTeammates(applyJournals(held));
				const again = step(effortState(held), answer);
				throw new Error(
					again.ok
						? `No hook holds \`${action.request}\` any more, so your answer can't reach it: it waits in ${action.teammate}'s terminal (\`/team attach ${action.teammate}\`). Stop and tell the human.`
						: again.refusal,
				);
			}
			// An escalated prose question's answer goes to its Teammate; it is on record only once it got there.
			for (const action of result.actions) {
				if (action.kind !== "send-message") continue;
				const failed = await deliver(held, action.teammate, action.inbox, action.message);
				if (failed) throw new Error(`The human's answer didn't reach ${action.teammate}, so nothing is recorded: ${failed.error}. Stop and tell the human.`);
			}
			for (const action of result.actions) if (action.kind === "append-clarification") appendClarification(held.paths, action.entry);
			appendLines(held.paths, result.append);
			paintBlock();
			return { content: [{ type: "text", text: result.reply ?? "" }], details: undefined };
		},
	});

	pi.registerTool({
		name: "team_escalate",
		label: "Escalate",
		description: [
			"Move a question the Brief doesn't settle to the human's `/team pending`, with your `summary`: a held `request` (a permission prompt or an AskUserQuestion), or the prose `question` a stopped-short `teammate` asked.",
			"Only the Task that asked waits on it; the rest of the Effort goes on. An escalated permission takes only the human's answer in `/team pending`.",
			"An escalated question may also be answered by the human in chat: pass their answer on with `team_answer` (`answers`, or `text` for a prose question). Every answer to a question goes into clarifications.md, which counts as part of the Brief.",
		].join(" "),
		promptSnippet: "Escalate a held request or a stopped-short Teammate's question to the human, with a summary",
		parameters: EscalateParams,
		defaultActive: false,
		async execute(_toolCallId, params) {
			if (!effort) throw new Error("No Effort is open in this session, so there is nothing to escalate; the human opens one with `/team start <team>`.");
			const held = effort;
			// What the terminal did meanwhile counts first: a request it answered can't be escalated.
			wakeAboutTeammates(applyJournals(held));
			const result = step(effortState(held), { kind: "escalate", ...params, at: now().toISOString() });
			if (!result.ok) throw new Error(result.refusal);
			appendLines(held.paths, result.append);
			paintBlock();
			return { content: [{ type: "text", text: result.reply ?? "" }], details: undefined };
		},
	});

	pi.registerTool({
		name: "team_send",
		label: "Send",
		description: [
			"Send a Teammate a short prose message, at most 2000 characters, which it reads as its next turn: through its inbox, or by resuming its session.",
			"Use it for a nudge or a fact it needs; new work goes in a Task with `team_handoff`, and a send-back with `team_review`. The message is on record once it is sent.",
		].join(" "),
		promptSnippet: "Send a Teammate a short prose message",
		parameters: SendParams,
		defaultActive: false,
		async execute(_toolCallId, params) {
			if (!effort) throw new Error("No Effort is open in this session, so there is no Teammate to message; the human opens one with `/team start <team>`.");
			const held = effort;
			wakeAboutTeammates(applyJournals(held));
			const result = step(effortState(held), { kind: "send", ...params, at: now().toISOString() });
			if (!result.ok) throw new Error(result.refusal);
			for (const action of result.actions) {
				if (action.kind !== "send-message") continue;
				const failed = await deliver(held, action.teammate, action.inbox, action.message);
				if (failed) throw new Error(`The message didn't reach ${action.teammate}, so nothing is recorded: ${failed.error}.`);
			}
			appendLines(held.paths, result.append);
			paintBlock();
			return { content: [{ type: "text", text: result.reply ?? "" }], details: undefined };
		},
	});

	/**
	 * `/team` and `/team attach [id]`: pick a Teammate with a session, unless
	 * one is named, then use the menu on it. Using the menu records the short id
	 * attached to, which clears its `(new)` mark; backing out records nothing.
	 */
	async function attachTo(named: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
		const held = effort;
		if (!held) {
			ctx.ui.notify(`No Teammate has a session to attach to: this session holds no Effort. Subcommands: ${valid}.`, "info");
			return;
		}
		const rows = teamStatus(effortState(held), { adoptionsPending: pending.length }).teammates.filter((row) => row.shortId !== undefined);
		let row = rows.find((candidate) => candidate.id === named);
		if (named !== undefined && !row) {
			const ones = rows.length === 0 ? "none yet" : rows.map((candidate) => `\`${candidate.id}\``).join(", ");
			ctx.ui.notify(`There is no Teammate \`${named}\` with a session to attach to. Teammates with one: ${ones}.`, "error");
			return;
		}
		if (named === undefined) {
			if (rows.length === 0) {
				ctx.ui.notify(`No Teammate of Effort \`${held.effortId}\` has a session to attach to yet. Subcommands: ${valid}.`, "info");
				return;
			}
			const label = await ctx.ui.select("Attach to which Teammate?", rows.map(pickerLabel));
			row = rows.find((candidate) => pickerLabel(candidate) === label);
		}
		const target = row && attachTarget(row, paths.claudePath);
		if (!target) return;
		const chosen = await chooseAttach(target, { mode: ctx.mode, ui: ctx.ui, env, tmuxPath, copy, handBack: (teammate) => handBackFromPi(teammate, undefined, ctx) });
		if (!chosen) return;
		if (!chosen.attaches) {
			await chosen.run();
			return;
		}
		const result = step(effortState(held), { kind: "attach", teammate: target.teammate, at: now().toISOString() });
		if (!result.ok) {
			ctx.ui.notify(result.refusal, "error");
			return;
		}
		appendLines(held.paths, result.append);
		paintBlock();
		await chosen.run();
	}

	pi.registerCommand("team", {
		description: "Run a Team on one Effort: /team start [team], /team setup <team>, /team pending, /team pause [reason], /team resume [effort], /team report, /team reports, /team cancel, /team attach [teammate] (or just /team), /team handback <teammate> [note]",
		async handler(args, ctx) {
			// Bare `/team` is the attach picker: getting to a Teammate is what it is reached for most.
			const [name = "attach", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = Object.hasOwn(subcommands, name) ? subcommands[name] : undefined;
			if (!subcommand) {
				ctx.ui.notify(`Unknown \`/team\` subcommand \`${name}\`. Subcommands: ${valid}.`, "error");
				return;
			}
			showBlockIn(ctx);
			try {
				await subcommand.run(rest, ctx);
			} finally {
				paintBlock();
			}
		},
	});
}

function bullets(lines: readonly string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

export default function (pi: ExtensionAPI): void {
	registerTeam(pi);
}

/**
 * What the Lead's session has cost, as pi's own usage totals add it up: each
 * entry's `usage.cost.total`, from assistant replies, tool results that made
 * model calls, usage entries, and compaction and branch summaries. pi doesn't
 * export the sum (`getUsageCostBreakdown`), so it is mirrored here.
 */
export function leadCost(entries: readonly unknown[]): number {
	let total = 0;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const { type, message, usage } = entry as { type?: unknown; message?: { role?: unknown; usage?: unknown }; usage?: unknown };
		const counted =
			type === "message" && (message?.role === "assistant" || message?.role === "toolResult") ? message.usage : type === "usage" || type === "compaction" || type === "branch_summary" ? usage : undefined;
		const cost = (counted as { cost?: { total?: unknown } } | undefined)?.cost?.total;
		if (typeof cost === "number" && Number.isFinite(cost)) total += cost;
	}
	return total;
}
