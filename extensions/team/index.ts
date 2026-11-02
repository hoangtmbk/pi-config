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

import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { attachTarget, chooseAttach, pickerLabel } from "./attach.ts";
import { renderTeamBlock, teamStatus } from "./block.ts";
import { type Bridge, openBridge } from "./bridge.ts";
import { agentsList, CLEAR_MARKER, installMod, launchBackground, sendToInbox, stopBackground, teammateArgs, teammateSettings, trustFolder, versionWarning } from "./claude.ts";
import {
	currentResult,
	DEFAULT_MAX_TEAMMATES,
	type EffortAction,
	type EffortState,
	fold,
	type Inbox,
	openEffort,
	type PendingApproval,
	refuseRequest,
	type Step,
	step,
	USAGE_CHOICES,
	type UsageItem,
	usageText,
	type Workspace,
	waitingInTerminal,
	workdir,
} from "./core.ts";
import { EVERY_ROLE, listTeams, loadTeam, type Playbook, readSnapshot, type Role, sha256, type Team, type TeamRoots } from "./definitions.ts";
import { briefApprovalTitle, intakePrompt, openedText } from "./intake.ts";
import { adoptable, holderText, ledFrom, type Leader, leaveLead, liveLead, POINTER, pointerIn, takeLead } from "./lead.ts";
import {
	appendLines,
	briefCriteria,
	checkRecords,
	createEffort,
	type EffortPaths,
	effortPaths,
	promoteBrief,
	protectedRecords,
	readJournal,
	readLead,
	readLines,
	readReports,
	reportMarkdown,
	validateBrief,
	writeFeedback,
	writePlan,
	writeReport,
	writeTask,
} from "./records.ts";
import { repoRoot } from "./repo.ts";
import { terminalText } from "./requests.ts";
import { REPORT_OVERLAY, type ReportChrome, ReportView, type ReportTui } from "./reports-view.ts";
import { addTaskWorkspace, addWorkspace, mergeTaskWorkspace, removeTaskWorkspace } from "./workspace.ts";
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
import { handoffPointer, restaffPointer, sendBackPointer, teammatePrompt } from "./teammate.ts";

/** The Lead's tools while this session runs Team setup. */
const SETUP_TOOLS = ["team_request_approval"];
/** The Lead's tools while this session holds an Effort. */
const EFFORT_TOOLS = ["team_request_approval", "team_plan", "team_handoff", "team_review", "team_status", "team_report", "team_pause", "team_resume", "team_answer"];
/** Every Lead tool: registered at load, and switched on only by what the session runs. */
const LEAD_TOOLS = [...new Set([...SETUP_TOOLS, ...EFFORT_TOOLS])];

const RequestApprovalParams = Type.Object({
	checkpoint: Type.String({ description: "Which checkpoint: `brief` for an Effort's Brief, `adopt-playbook` during Team setup." }),
	path: Type.String({ description: "The draft to approve: the Effort's `brief.draft.md`, or the Team setup's Playbook draft." }),
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
});

const DECISIONS = ["allow", "deny"] as const;

const AnswerParams = Type.Object({
	request: Type.String({ description: "The held request's id, `req-<8 hex>`, from the message that woke you about it." }),
	decision: Type.Optional(Type.String({ description: "For a permission request: `allow` or `deny`. Leave it out when answering an AskUserQuestion." })),
	reason: Type.Optional(Type.String({ description: "Why: the deny message the Teammate sees, and what the human reads in the next Report." })),
	rule: Type.Optional(
		Type.String({ description: "With `allow`: a session rule for the same tool, such as `Bash(npm test:*)`, so the Teammate isn't asked again this session." }),
	),
	grant: Type.Optional(Type.String({ description: "With `allow`: the grant in the Brief or Playbook the allow relies on, logged for the human." })),
	answers: Type.Optional(
		Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())]), {
			description: "For an AskUserQuestion: each question's exact text to the label picked, or a list of labels for a multiSelect question.",
		}),
	),
});

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
	/** The `claude` executable. Injected by tests, and by nothing else. */
	claudePath?: string;
	/** The bundled Teams. Injected by tests, and by nothing else. */
	bundledTeamsDir?: string;
	/** The clock adoption times are read from. Injected by tests, and by nothing else. */
	now?: () => Date;
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
	/** Run `fn` every `ms` until the returned stop is called: the clock usage limits lift on. Injected by tests, and by nothing else. */
	every?: (ms: number, fn: () => unknown) => () => void;
}

/** How often the Lead's clock looks at what a usage limit holds back. */
const TICK_MS = 60_000;

/** What a Teammate a usage limit stopped is sent once it resets, as the human would type it. */
const CONTINUE = "continue";

/** What each usage-item choice reads as in `/team pending`. */
const USAGE_LABELS: Record<string, string> = {
	stay: "Stay paused until it resets",
	cancel: "Cancel the Effort: stop its Teammates, and the Lead writes the final Report",
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
	const now = deps.now ?? (() => new Date());
	const pid = deps.pid ?? process.pid;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const env = deps.env ?? process.env;
	const tmuxPath = deps.tmuxPath ?? "tmux";
	const copy = deps.copy ?? copyToClipboard;
	const every =
		deps.every ??
		((ms: number, fn: () => unknown) => {
			const timer = setInterval(fn, ms);
			// The clock never keeps pi running by itself.
			timer.unref();
			return () => clearInterval(timer);
		});

	// What this session is running, which decides whether the Lead's tools are on.
	let setup: TeamSetup | undefined;
	// Playbook adoptions waiting on the human in `/team pending`, oldest first. An Effort's own wait in its `effort.jsonl`.
	let pending: PendingAdoption[] = [];
	// The one Effort this session's Lead holds.
	let effort: HeldEffort | undefined;
	// The Lead bridge the held Effort's hooks ring, open while this session is its Lead.
	let bridge: Promise<Bridge> | undefined;
	// Whether the Lead's model is in a run, and what wakes about Teammates wait for it to settle.
	let busy = false;
	let waiting: string[] = [];
	// Where the Team block goes, when pi has a UI, and the lines it last showed.
	let surface: ExtensionUIContext | undefined;
	let shown: string[] | undefined;
	// The clock that lifts what a usage limit holds back, running while this session holds an Effort, and the context queued Tasks start in.
	let stopClock: (() => void) | undefined;
	let ticking = false;
	let leadCtx: ExtensionContext | undefined;

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
		if (!surface) return;
		const lines = effort ? renderTeamBlock(teamStatus(effortState(effort), { adoptionsPending: pending.length }), now().getTime(), { maxTeammates: maxTeammates() }) : undefined;
		if (lines === shown || (lines && shown && lines.length === shown.length && lines.every((line, index) => line === shown?.[index]))) return;
		shown = lines;
		surface.setWidget(BLOCK_KEY, lines, { placement: "aboveEditor" });
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

	/** Lead the Effort and hold it in this session, or say why not. */
	async function lead(held: HeldEffort, ctx: ExtensionContext): Promise<boolean> {
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
		stopClock ??= every(TICK_MS, tickEffort);
		// A reset that passed while no session led the Effort is caught up on now.
		void tickEffort();
		return true;
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
			return Object.fromEntries(snapshotOf(held).roles.flatMap((role) => (role.model === undefined ? [] : [[role.name, role.model]])));
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
	function applyJournals(held: HeldEffort, only?: string): string[] {
		let state = effortState(held);
		const texts: string[] = [];
		// A reset naming no time zone is read in the machine's.
		const tz = -now().getTimezoneOffset();
		let models: Record<string, string> | undefined | null = null;
		for (const { id, cursor } of state.teammates) {
			if (only !== undefined && id !== only) continue;
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
				});
				if (!result.ok) break;
				appendLines(held.paths, result.append);
				state = result.state;
				for (const action of result.actions) {
					if (action.kind === "wake-lead") texts.push(action.text);
					else if (action.kind === "send-pointer") sendPointer(held, action);
				}
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

	/** Wake the Lead about its Teammates now, or with everything else once its run settles. */
	function wakeAboutTeammates(texts: string[]): void {
		if (busy) waiting.push(...texts);
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
		if (!(await lead(held, ctx))) return;
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
	function approvedEffort(tool: "team_plan" | "team_handoff" | "team_review", ctx: ExtensionContext): { held: HeldEffort; state: EffortState } {
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
	 * Send a Task back to a new Teammate of its Role, its own having ended: the
	 * feedback is written for the pointer to name, and taken back if the launch
	 * fails, so the Lead can send it back again; the lines go on record once it
	 * has started, as a handoff's do.
	 */
	async function restaffTask(
		held: HeldEffort,
		result: Extract<Step, { ok: true }>,
		{ teammate, slug, folder, round, feedback }: Extract<EffortAction, { kind: "restaff-teammate" }>,
		ctx: ExtensionContext,
	): Promise<void> {
		const { roles, playbook } = snapshotOf(held);
		const role = roles.find((each) => each.name === teammate.role);
		const workspace = result.state.workspace;
		if (!role || !workspace) throw new Error(`Task \`${slug}\` can't go to a new Teammate: Effort \`${held.effortId}\` has no Role \`${teammate.role}\` in its Team snapshot or no Workspace. Stop and tell the human.`);
		const taskDir = join(held.paths.tasks, folder);
		const written = writeFeedback(held.paths, folder, round, feedback);
		await listenForTeammates(held, ctx);
		const cwd = workdir(result.state, teammate.id) ?? workspace.path;
		const launched = await launchBackground(paths.claudePath, cwd, launchArgs(held, teammate, role, playbook, restaffPointer(slug, taskDir, round)));
		if (launched) {
			rmSync(written);
			throw new Error(`Teammate \`${teammate.id}\` didn't start, so Task \`${slug}\` isn't sent back and its feedback-${round}.md is taken back: ${launched.error}`);
		}
		writePlan(held.paths, result.state);
		appendLines(held.paths, result.append);
		wakeAboutTeammates(applyJournals(held));
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

	/** The `claude --bg` arguments that start `teammate` in `role`, with `pointer` as its first turn. */
	function launchArgs(held: HeldEffort, teammate: { id: string; name: string }, role: Role, playbook: Playbook, pointer: string): string[] {
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
		const { roles, playbook } = snapshotOf(held);
		const stopped: string[] = [];
		const added: Extract<EffortAction, { kind: "add-task-workspace" }>[] = [];
		const still = body === undefined ? "queued" : "planned";
		for (const action of result.actions) {
			if (action.kind === "write-task" && body !== undefined) writeTask(held.paths, action.folder, body);
			else if (action.kind === "add-task-workspace") {
				const cut = addTaskWorkspace(result.state.repo, action);
				if ("error" in cut) throw new Error(`Task \`${action.slug}\` didn't get a worktree of its own, so it is still ${still}: ${cut.error}`);
				added.push(action);
			}
			else if (action.kind === "write-plan") writePlan(held.paths, result.state);
			else if (action.kind === "stop-teammate") {
				const failed = await stopTeammate(result.state, action);
				if (failed) throw new Error(`Idle Teammate \`${action.teammate}\` didn't stop (${failed.error}), so no Teammate starts in its place; stop and tell the human.`);
				stopped.push(action.teammate);
			} else if (action.kind === "launch-teammate") {
				const failed = await launchTeammate(held, result.state, action, roles, playbook);
				if (failed) {
					// Its worktree goes with it: nothing was worked there, and a handoff again cuts it afresh.
					for (const worktree of added) removeTaskWorkspace(result.state.repo, worktree, true);
					// The idle Teammate stopped for it is gone either way.
					appendLines(
						held.paths,
						result.append.filter((line) => line.type === "teammate-retired" && stopped.includes(line.teammate)),
					);
					throw new Error(`Teammate \`${action.teammate.id}\` didn't start, so Task \`${action.task.slug}\` is still ${still}: ${failed}`);
				}
			}
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
			const drained = step(state, { kind: "drain", at: now().toISOString(), maxTeammates: maxTeammates() });
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
		const args = launchArgs(held, teammate, role, playbook, handoffPointer(task.slug, join(held.paths.tasks, task.folder), 1));
		return (await launchBackground(paths.claudePath, workdir(state, teammate.id) ?? state.workspace.path, args))?.error;
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
		const result = step(effortState(held), { kind: "answer-usage", id: item.id, choice, at: now().toISOString() });
		if (!result.ok) {
			ctx.ui.notify(result.refusal, "error");
			return;
		}
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
				const usage = state?.usageItems ?? [];
				if (pending.length === 0 && briefs.length === 0 && terminal.length === 0 && usage.length === 0) {
					ctx.ui.notify("Nothing is waiting on you.", "info");
					return;
				}
				for (const item of [...pending]) await answerAdoption(item, ctx);
				if (held) for (const item of briefs) await answerBrief(held, item, ctx);
				for (const item of terminal) {
					const attach = `Attach to ${item.teammate}`;
					const answer = await ctx.ui.select(`\`${item.request}\` waited past its hook's hold: ${terminalText(item)}`, [attach, LATER]);
					if (answer === attach) await attachTo(item.teammate, ctx);
				}
				if (held) for (const item of usage) await answerUsage(held, item, ctx);
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
				if (!(await lead(held, ctx))) return;
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
		attach: {
			async run(args, ctx) {
				await attachTo(args[0], ctx);
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
				const text = requestBriefApproval(effort, params.checkpoint, path);
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
			const { roles } = snapshotOf(held);
			const criteria = briefCriteria(readFileSync(held.paths.brief, "utf8"));
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
			const { roles, playbook } = snapshotOf(held);
			const result = step(state, {
				kind: "handoff",
				slug: params.slug,
				at: now().toISOString(),
				mode: launchMode(state, params.slug, roles, playbook),
				maxTeammates: maxTeammates(),
				...(params.isolated ? { isolated: true } : {}),
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
			const { roles, playbook } = snapshotOf(held);
			const result = step(state, {
				kind: "review",
				slug: params.slug,
				verdict,
				feedback: params.feedback,
				result: { path, written: path !== "" && existsSync(path) },
				sendBackLimit: playbook.sendBackLimit,
				at: now().toISOString(),
				mode: launchMode(state, params.slug, roles, playbook),
			});
			if (!result.ok) throw new Error(result.refusal);
			const merge = result.actions.find((action) => action.kind === "merge");
			if (merge) {
				const said = await acceptMerged(held, result, merge);
				const started = await startQueued(held, effortState(held), ctx);
				paintBlock();
				return { content: [{ type: "text", text: [said, ...started].join(" ") }], details: undefined };
			}
			const restaff = result.actions.find((action) => action.kind === "restaff-teammate");
			if (restaff) {
				await restaffTask(held, result, restaff, ctx);
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
			"The held Effort at a glance, as the human sees it in the Team block: the phase, Tasks accepted out of planned, each Teammate's state, Task, context use and permission mode (`acceptEdits≠auto` is drift from the mode it launched in), queued Tasks and why, each pause that holds (who set it, why and since when), and what waits on the human.",
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
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!effort) throw new Error("No Effort is open in this session, so there is nothing to report on; the human opens one with `/team start <team>`.");
			const held = effort;
			const state = effortState(held);
			const criteria = state.brief ? briefCriteria(readFileSync(held.paths.brief, "utf8")) : [];
			// The Role modes go only into the plan Report, and need the snapshot only then.
			const snapshot = state.brief && state.reports === 0 ? snapshotOf(held) : undefined;
			const modes = snapshot ? snapshot.roles.map((role) => ({ role: role.name, mode: modeInForce(snapshot.playbook, role) })) : [];
			const result = step(state, { kind: "report", headline: params.headline, coverage: params.coverage, found: params.found, criteria, modes, at: now().toISOString() });
			if (!result.ok) throw new Error(result.refusal);
			let details: ReportDetails | undefined;
			for (const action of result.actions) {
				if (action.kind !== "write-report") continue;
				const markdown = reportMarkdown(held.effortId, action.report);
				details = { n: action.report.n, path: writeReport(held.paths, markdown, action.report.n), headline: action.report.headline, markdown };
			}
			appendLines(held.paths, result.append);
			paintBlock();
			return { content: [{ type: "text", text: result.reply ?? "" }], details };
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
			"For an AskUserQuestion, `answers` maps each question's exact text to a label, or a list of labels for a multiSelect question.",
			"The first answer wins: refused once the human answered in the terminal, or the hook gave up holding it. Nothing is allowed by default, and the next Report logs what you decided.",
		].join(" "),
		promptSnippet: "Answer a Teammate's held permission request or AskUserQuestion: allow or deny, with a reason",
		parameters: AnswerParams,
		defaultActive: false,
		async execute(_toolCallId, params) {
			if (!effort) throw new Error("No Effort is open in this session, so no request waits on you; the human opens one with `/team start <team>`.");
			const held = effort;
			const decision = params.decision === undefined ? undefined : DECISIONS.find((each) => each === params.decision);
			if (params.decision !== undefined && decision === undefined) throw new Error(`\`decision\` is \`allow\` or \`deny\`, not \`${params.decision}\`.`);
			// What the terminal did meanwhile counts first: the first answer wins.
			wakeAboutTeammates(applyJournals(held));
			const answer = { kind: "answer-request" as const, request: params.request, decision, reason: params.reason, rule: params.rule, grant: params.grant, answers: params.answers, at: now().toISOString() };
			const result = step(effortState(held), answer);
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
		const run = await chooseAttach(target, { mode: ctx.mode, ui: ctx.ui, env, tmuxPath, copy });
		if (!run) return;
		const result = step(effortState(held), { kind: "attach", teammate: target.teammate, at: now().toISOString() });
		if (!result.ok) {
			ctx.ui.notify(result.refusal, "error");
			return;
		}
		appendLines(held.paths, result.append);
		paintBlock();
		await run();
	}

	pi.registerCommand("team", {
		description: "Run a Team on one Effort: /team start [team], /team setup <team>, /team pending, /team pause [reason], /team resume [effort], /team report, /team reports, /team attach [teammate] (or just /team)",
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
