/**
 * The Effort core: a pure state machine over `effort.jsonl`.
 *
 * Its input is the Effort's lines plus one new input (a Lead tool call, a
 * human's answer). Its output is the folded state, the lines to append and the
 * mechanical actions for the shell to carry out, or a refusal saying why the
 * input can't be taken. It does no I/O: the shell reads and appends the lines,
 * validates and writes the records, and wakes the Lead.
 *
 * `effort.jsonl` is the extension's whole memory of an Effort, so every change
 * is one appended line and the state is only ever what the lines fold to.
 */

import { CONSENT_FAMILY, classify, type Family, familyOf, LIMIT_FAMILY, type LimitKind, type TransientWhy } from "./limits.ts";
import { answersText, askedText, askText, closedText, type HeldRequest, type HookDecision, isCallOf, isQuestion, type RequestAnswer, requestKind, settledText, type TakenAnswer, takeAnswer, terminalText } from "./requests.ts";

/** The one checkpoint an Effort has before its Brief is approved. */
export const BRIEF = "brief";

/** The checkpoint that ends an Effort: the human signs off its final Report. */
export const SIGN_OFF = "sign-off";

/** A Playbook change the final Report proposes, which the human adopts or declines on its own. */
export const PLAYBOOK_CHANGE = "playbook-change";

/**
 * A change to the approved Brief: the Lead drafts it in `brief.draft.md` and
 * names the planned Tasks it affects, which are held until the human answers.
 * Approved, the draft becomes `brief.md`.
 */
export const BRIEF_CHANGE = "brief-change";

/**
 * A change the Lead proposes to the Team's Playbook in the final Report: the
 * one passage `oldText` replaced by `newText`. Adopted, it applies to the
 * Playbook the next Effort adopts; the running Effort keeps its snapshot.
 */
export interface PlaybookChange {
	/** Kebab-case, unique in the Report; how the human and the record name it. */
	id: string;
	summary: string;
	oldText: string;
	newText: string;
}

/** What the human sees, and approves by its sha256, when a Playbook change is offered. */
export function changeSnapshot(change: PlaybookChange): string {
	return `Playbook change \`${change.id}\`: ${change.summary}\n\nReplace:\n${change.oldText}\n\nWith:\n${change.newText}\n`;
}

/** A request the human answers in `/team pending`, with what they would approve. */
export interface PendingApproval {
	/** Unique within the Effort: `r1`, `r2`, … */
	id: string;
	/** One of the fixed checkpoints, or, once the Brief is approved, a Playbook checkpoint id or an `escalate` id. */
	checkpoint: string;
	/** For a Playbook change, the change itself. */
	change?: PlaybookChange;
	/** For a Brief change, the slugs of the planned Tasks it holds until the human answers. */
	affects?: string[];
	/** The draft the snapshot was taken from. */
	path: string;
	/** Of `snapshot`'s UTF-8 bytes. */
	sha256: string;
	/** The draft as the Lead asked about it: exactly what approving promotes. */
	snapshot: string;
	at: string;
}

/**
 * Where the Effort's Teammates work, added at Brief approval: for a
 * `git-worktree` Workspace, the worktree on the Effort's own branch, cut from
 * the default branch `from` at commit `base`.
 */
export interface Workspace {
	kind: "git-worktree";
	path: string;
	branch: string;
	/** The commit the Effort started from. */
	base: string;
	/** The default branch `base` was the tip of. */
	from: string;
}

/** One Task of the Lead's plan. */
export interface PlannedTask {
	/** Kebab-case, unique in the plan; how the Lead hands it off. */
	slug: string;
	role: string;
	goal: string;
	/** Slugs of planned Tasks it waits for. */
	dependsOn: string[];
	/** Ids of the Brief's acceptance criteria it covers. */
	criteria: string[];
}

/** A Task handed to a Teammate: its folder under `tasks/`, fixed at its first handoff. */
export interface HandedTask {
	/** `<nnn>-<role>-<slug>`, numbered in handoff order. */
	folder: string;
	role: string;
	teammate: string;
	at: string;
	/** The round in progress: its result is `result-<round>.md` in the folder. */
	round: number;
	/** The last round whose result was reported to the Lead as done. */
	reported?: number;
	/** When the Lead accepted it, which ends the Task; absent until then. */
	accepted?: string;
	/** How many times the Lead sent it back; absent before the first. */
	sendBacks?: number;
	/** When a re-plan dropped it, which ends this handoff: planned again, it is handed off afresh into a new folder. */
	dropped?: string;
	/** An isolated Task's own worktree and branch, cut from the Effort branch's tip; absent for a Task worked in the Workspace. */
	worktree?: TaskWorktree;
	/** When the merge of its branch, written ahead on accept, began; absent once the merge is in or has failed. */
	merging?: string;
}

/**
 * An isolated Task's worktree, `…/team-<effort-id>-task-<nnn>/` beside the
 * Workspace (not nested in it), on branch `team/<effort-id>-task-<nnn>`.
 */
export interface TaskWorktree {
	path: string;
	branch: string;
}

/** Where a Task of the plan stands, as `plan.md` shows it. */
export type TaskStatus = "planned" | "queued" | "running" | "in review" | "sent back" | "accepted" | "dropped";

/**
 * A Task handed off while the Effort is at its cap of live Teammates, waiting
 * to start by itself when one frees up. Its folder is numbered and written at
 * handoff, like any other.
 */
export interface QueuedTask {
	slug: string;
	folder: string;
	role: string;
	/** Why it waits, as the Team block shows it: `cap 3 reached; waits for 002 and 003`. */
	why: string;
	/** The permission mode the handoff asked for, which a Teammate started for it launches in. */
	mode?: string;
	/** Handed off `isolated`: it gets a worktree of its own when it starts. */
	isolated?: true;
	at: string;
}

/** A Claude Code background session the Effort started, filling one Role for life. */
export interface Teammate {
	/** `<role>-<n>`, numbered per Role: `dev-1`. */
	id: string;
	role: string;
	/** Its `--name`, `team-<effort-id>-<teammate-id>`, unique across Efforts. */
	name: string;
	/** The slug of the Task in its context. */
	task: string;
	startedAt: string;
	/** Its current Claude Code session id, from its latest `SessionStart`; a clear changes it. */
	sessionId?: string;
	/** The id `claude agents --json` and `claude attach` know it by, which a clear keeps. */
	shortId?: string;
	/** Its inbox socket and the token to write to it, from its latest `SessionStart` that carried them. */
	inbox?: Inbox;
	/** The last line of its journal applied to the Effort, counted from 1; absent before any. */
	cursor?: number;
	/** The permission mode it was launched in. */
	mode?: string;
	/** The permission mode its hooks last reported, once one differs from {@link mode}: drift is logged, not a Takeover. */
	observedMode?: string;
	/** Absent until a prompt first lands: then `busy`, and `idle` once it stops. */
	activity?: "busy" | "idle";
	/** How its last turn ended, while idle: `round 1 done`, `stopped short`. */
	doing?: string;
	/** The slug of the Task it was reused for, while its context is cleared and before the Task's pointer is sent. */
	clearing?: string;
	/** When it was stopped to make room under the cap; it no longer counts, nor is it reused. */
	retiredAt?: string;
	/** The short id the human last attached to through pi's `/team` menu. */
	attached?: string;
	/** Set when a new session gave it a new short id the human hasn't attached to through pi: the block marks it `(new)`. */
	newShortId?: boolean;
	/** The session-scoped rules the Lead added for it, each with the Task it was added on. */
	rules?: { rule: string; task?: string }[];
	/**
	 * Set once its session is over for the Effort: `stopped` with `claude stop`
	 * when its Task was dropped, or `crashed` on a `SessionEnd` nobody asked
	 * for. It is never woken again, and its Task's next round goes to another
	 * Teammate of its Role. An idle stop is not this: a send wakes it.
	 */
	ended?: { how: "stopped" | "crashed"; at: string };
	/** What its last turn failed on, while it waits to be continued: set by a `StopFailure`, cleared once it goes on. */
	limit?: TeammateLimit;
	/** Set when an approved Brief change alters its Role's launch options: its next Task starts in a fresh session, never mid-Task. */
	freshDue?: true;
	/** Set from its fresh session's launch until that session's `SessionStart`, which gives it its new short id. */
	relaunching?: true;
	/** Set while the human has taken it over in its terminal: the Lead backs off until they hand it back. */
	takeover?: Takeover;
	/**
	 * The held request the terminal killed the hook of, until something shows
	 * whether it was a No: a call of it running says Yes, and anything else
	 * the Teammate does first starts a Takeover.
	 */
	denied?: string;
}

/** What started a Takeover: a prompt or a command the human typed, Esc during a turn, or a No to a card. */
export type TakeoverTrigger = { kind: "prompt" } | { kind: "command"; command: string } | { kind: "interrupt" } | { kind: "deny"; request: string };

/** A send the Lead made to a taken-over Teammate, held until the hand-back: a message, dropped then, or a Task's pointer, sent then after a clear. */
export interface HeldSend {
	what: "message" | "pointer";
	message?: string;
	slug?: string;
	at: string;
}

/** The human holds a Teammate: since when, what started it, what they typed since, and the sends held meanwhile. */
export interface Takeover {
	since: string;
	trigger: TakeoverTrigger;
	/** The prompts and commands (`/model sonnet`) the human typed, oldest first. */
	inputs: string[];
	held: HeldSend[];
}

/**
 * What a Teammate's last turn failed on: a usage limit, a usage-credit confirm
 * nobody answered, a failure that clears by itself (retried on the ladder), or
 * one the Lead is told of.
 */
export interface TeammateLimit {
	kind: LimitKind | TransientWhy | "consent" | "unknown";
	/** When the limit resets, when Claude Code said. */
	reset?: string;
	/** Claude Code's own auto-wait continues it at the reset: the Effort sends it nothing while this holds. */
	armed?: true;
	/** Retries the ladder has sent it so far, for a failure that clears by itself. */
	tries?: number;
	/** When the ladder's next retry goes; absent while one is out, and once the ladder is used up. */
	next?: string;
	at: string;
}

/** A model family's usage limit, or a usage-credit confirm, holding the Roles on that family: their new Tasks queue. */
export interface ModelHold {
	family: Family;
	kind: "opus" | "sonnet" | "consent";
	/** The Roles on the family when it was set, from the Team snapshot's models. */
	roles: string[];
	/** When it lifts; absent for a usage-credit confirm, which lifts once the human answers it. */
	reset?: string;
	/** For a usage-credit confirm: the Teammate whose terminal it waits in. */
	teammate?: string;
	at: string;
}

/** A usage limit the human decides on, in `/team pending`. */
export interface UsageItem {
	/** `u<n>`, numbered per Effort. */
	id: string;
	/** `far-reset`: the usage pause lifts more than a day away, or Claude Code didn't say when; stay paused or cancel. `retries`: a Teammate still fails after the retry ladder; retry again or leave it to the Lead. */
	why: "far-reset" | "retries";
	kind: TeammateLimit["kind"];
	teammate?: string;
	reset?: string;
	at: string;
}

/** The choices a usage item offers, by why it was raised. */
export const USAGE_CHOICES = { "far-reset": ["stay", "cancel"], retries: ["retry", "leave"] } as const;

/** The waits between the retries of a failure that clears by itself: 1, 2 and 5 minutes; a failure after the last is the human's. */
export const RETRY_MS: readonly number[] = [60_000, 120_000, 300_000];

/** How long after a limit's reset a Teammate it stopped is sent `continue`, so the reset has surely happened. */
export const GRACE_MS = 120_000;

/** A usage pause whose reset is further than this asks the human whether to stay paused or cancel. */
export const FAR_RESET_MS = 24 * 3_600_000;

/** A Teammate's inbox socket, which Claude Code gives its hooks in the environment. */
export interface Inbox {
	socket: string;
	token: string;
}

/**
 * One line of a Teammate's journal, `teammates/<id>/events.jsonl`. The hook
 * script writes one per hook event: the payload as Claude Code sent it, with
 * the inbox on a `SessionStart`.
 */
export interface JournalLine {
	/** Who wrote it: `hook` for the hook script. */
	from: string;
	at: string;
	/** The hook event, `hook_event_name`. */
	event?: string;
	payload?: Record<string, unknown>;
	inbox?: Inbox;
	/** The id of a `PermissionRequest` the hook holds open, on that request's line and the lines that end its hold. */
	request?: string;
}

/** One line of `effort.jsonl`. */
export type EffortLine =
	/** The first line: the Effort exists, on this Team, repo and Playbook. */
	| { type: "effort-opened"; effortId: string; team: string; repo: string; playbook: string; at: string }
	/** The Lead asked the human to approve a snapshot. */
	| ({ type: "approval-requested" } & PendingApproval)
	/** The human answered a request in `/team pending`. */
	| {
			type: "approval-answered";
			id: string;
			answer: Answer;
			note?: string;
			workspace?: Workspace;
			/** For an approved Brief change, the Roles whose launch options it alters: their Teammates get a fresh session at their next Task boundary. */
			refresh?: string[];
			/** For an approved Brief change that alters what the Lead answers under, the Teammates holding session rules added under the old terms: each gets a fresh session at its next Task boundary. */
			renew?: string[];
			at: string;
	  }
	/** The Lead wrote its whole Task list, replacing any before it. */
	| { type: "plan-written"; tasks: PlannedTask[]; reason?: string; at: string }
	/** A Teammate was launched. */
	| ({ type: "teammate-started" } & Teammate)
	/** A planned Task was handed to a Teammate, its folder written. */
	| ({ type: "task-handed-off"; slug: string } & Omit<HandedTask, "reported" | "accepted" | "sendBacks" | "merging">)
	/** The Lead sent round `round` of a Task back with feedback, which starts round `round + 1` with the same Teammate. */
	| { type: "task-sent-back"; slug: string; round: number; at: string }
	/** The Lead accepted round `round` of a Task, which ends it; for an isolated Task, once its branch is merged, by merge commit `merge` (absent when it had nothing to merge). */
	| { type: "task-accepted"; slug: string; round: number; merge?: string; at: string }
	/**
	 * Written ahead of merging an isolated Task's `branch` into the Effort
	 * branch `into` on accept: a `task-accepted` or a `merge-failed` of the
	 * Task closes it, and one left open after a crash is finished from git's
	 * evidence (`MERGE_HEAD`, or the branch already merged).
	 */
	| { type: "merge-intended"; slug: string; branch: string; into: string; at: string }
	/** The merge an accept intended didn't happen, and left nothing half-done: the Task is still in review. */
	| { type: "merge-failed"; slug: string; reason: string; at: string }
	/**
	 * Written ahead of launching Teammate `teammate` as `--name` `name`: the
	 * `lines` its launch puts on record once it is in. Its own
	 * `teammate-started` closes it, and one left open after a crash is finished
	 * from `claude agents --json` or the Teammate's journal, or abandoned.
	 */
	| { type: "launch-intended"; teammate: string; name: string; lines: EffortLine[]; at: string }
	/** A launch written ahead never happened: none of its lines went on record. */
	| { type: "launch-abandoned"; teammate: string; reason: string; at: string }
	/**
	 * The lines below each apply one journal line of `teammate`, and carry the
	 * `cursor` it was read at, so it is never applied twice.
	 */
	/** A `SessionStart`: the Teammate's session, short id and inbox now. */
	| { type: "teammate-session"; teammate: string; cursor: number; source: string; sessionId: string; shortId: string; inbox?: Inbox; at: string }
	/** A `UserPromptSubmit`: a message reached the Teammate's model, which is how a send is known to have landed. */
	| { type: "prompt-landed"; teammate: string; cursor: number; prompt: string; at: string }
	/** A `PermissionDenied`: a tool call was refused by a rule or the classifier. */
	| { type: "permission-denied"; teammate: string; cursor: number; tool: string; reason?: string; at: string }
	/** A `Stop` with the round's result written: the Task's round is done. */
	| { type: "task-done"; teammate: string; cursor: number; slug: string; round: number; at: string }
	/** A `SessionEnd` that wasn't a clear, a resume or the extension's own `claude stop`: the Teammate's session is over. */
	| { type: "teammate-crashed"; teammate: string; cursor: number; reason: string; at: string }
	/** A `Stop` without a new result: the Teammate stopped short, saying this last. */
	| { type: "teammate-stopped"; teammate: string; cursor: number; slug: string; message: string; at: string }
	/** A hook reported a permission mode other than the one last known: the mode the Teammate actually got. */
	| { type: "teammate-mode"; teammate: string; cursor: number; mode: string; at: string }
	/** A handoff found the Effort at its cap of live Teammates: the Task waits, its folder written. */
	| ({ type: "task-queued" } & QueuedTask)
	/** An idle Teammate whose Task is accepted was reused for Task `slug`: its context is cleared before the pointer goes. */
	| { type: "clear-requested"; teammate: string; slug: string; at: string }
	/** An idle Teammate whose Task is accepted was stopped to make room under the cap. */
	| { type: "teammate-retired"; teammate: string; at: string }
	/**
	 * An idle Teammate whose Role's launch options an approved Brief change
	 * altered was stopped and launched afresh, under the same id and name, for
	 * Task `task`, in permission mode `mode`. Its next `SessionStart` gives it
	 * a new short id.
	 */
	| { type: "teammate-relaunched"; teammate: string; task: string; mode?: string; at: string }
	/** The human used the `/team` menu on a Teammate: the short id they were given, which clears its `(new)` mark. Reads no journal line. */
	| { type: "teammate-attached"; teammate: string; shortId: string; at: string }
	/** A send-back gave the Task to a new Teammate, since its own had ended. */
	| { type: "task-reassigned"; slug: string; teammate: string; at: string }
	/** A re-plan left out a handed-off Task, or gave it another Role: this handoff of it is over. */
	| { type: "task-dropped"; slug: string; at: string }
	/** The extension stopped a Teammate with `claude stop`, since its Task was dropped, or its isolated Task merged and its worktree goes. Reads no journal line. */
	| { type: "teammate-ended"; teammate: string; how: "stopped"; at: string }
	/** Something decided for the human on their behalf, for the next Report: a permission answer, a rule, a grant used, a limit pause. */
	| ({ type: "decided-for-you" } & Logged)
	/** Work found outside the Brief (scope creep), kept for the final Report as a suggestion. */
	| ({ type: "found-work" } & Logged)
	/** Report `n` was written as `reports/<nnn>.md`; the next one covers what comes after this line. */
	| { type: "report-written"; n: number; final?: true; at: string }
	/** `by` paused the Effort: no new Task starts until every pause is lifted. */
	| ({ type: "paused" } & Pause)
	/** `by` lifted its own pause. */
	| { type: "resumed"; by: PauseSetter; at: string }
	/** A Task queued while paused waits on, once the Effort runs, for this reason instead. */
	| { type: "task-requeued"; slug: string; why: string; at: string }
	/** A usage reading: a Teammate's status line, or `get_usage`. */
	| ({ type: "usage-read" } & UsageReading)
	/** A `PermissionRequest` the Teammate's hook holds open for the first answer, the Lead's or the human's in the terminal. */
	| ({ type: "request-held"; cursor: number } & Omit<HeldRequest, "state">)
	/** The terminal settled a held request: answered there, denied there, or left there once the hook's hold ran out. */
	| { type: "request-settled"; teammate: string; cursor: number; request: string; how: "answered-in-terminal" | "denied-in-terminal" | "expired"; at: string }
	/** The Lead answered a held request through its hook, adding `rule` for the Teammate's session. Reads no journal line. */
	| { type: "request-answered"; teammate: string; request: string; task?: string; decision: HookDecision; rule?: string; at: string }
	/** A `StopFailure`: the Teammate's turn failed on a usage limit or an error, and it waits idle. */
	| { type: "teammate-limited"; teammate: string; cursor: number; limit: TeammateLimit; at: string }
	/** A `Notification` that Claude Code's auto-wait continued the Teammate, or a prompt landed on it: it goes on. */
	| { type: "limit-cleared"; teammate: string; cursor: number; at: string }
	/** The extension sent a limited Teammate `continue`: a retry on the ladder (its count now `tries`), or after its limit reset. Reads no journal line. */
	| { type: "teammate-continued"; teammate: string; why: "retry" | "reset"; tries?: number; at: string }
	/** A model family's limit, or a usage-credit confirm, holds the Roles on that family. */
	| ({ type: "model-held" } & ModelHold)
	/** The family's hold lifted. */
	| { type: "model-released"; family: Family; at: string }
	/** A usage limit asks the human to decide, in `/team pending`. */
	| ({ type: "usage-escalated" } & UsageItem)
	/** The human answered usage item `id`. */
	| { type: "usage-answered"; id: string; choice: string; at: string }
	/** The Effort is over: the human signed off its final Report, or cancelled it. Nothing more is taken. */
	| { type: "effort-ended"; how: Ended["how"]; at: string }
	/** The Lead moved a held request, or a stopped-short Teammate's prose question, to the human's pending items. */
	| ({ type: "escalated" } & Omit<Escalation, "answered">)
	/** The human answered an escalated item: in `/team pending`, or in chat with the Lead relaying it. */
	| ({ type: "escalation-answered"; id: string } & NonNullable<Escalation["answered"]>)
	/** The Lead sent a Teammate a prose message with `team_send`. */
	| { type: "message-sent"; teammate: string; message: string; at: string }
	/** The human took a Teammate over in its terminal, typing `input` (a prompt, or a command as `/name args`) when they did. */
	| { type: "takeover-started"; teammate: string; cursor: number; trigger: TakeoverTrigger; input?: string; at: string }
	/** The human typed another prompt or command to a Teammate they hold. */
	| { type: "takeover-input"; teammate: string; cursor: number; input: string; at: string }
	/** A turn of a Teammate the human holds ended: it waits on them, and nothing it wrote counts as done yet. */
	| { type: "takeover-turn"; teammate: string; cursor: number; at: string }
	/** A send to a Teammate the human holds, kept until the hand-back. Reads no journal line. */
	| ({ type: "send-held"; teammate: string } & HeldSend)
	/** The Takeover is over: handed back from the Teammate's terminal (`/handback`, a journal line) or from pi, or ended by a crash. */
	| { type: "takeover-ended"; teammate: string; cursor?: number; by: "terminal" | "pi" | "crash"; note?: string; at: string };

/**
 * A held request or a prose question the Lead escalated with
 * `team_escalate`: it waits on the human, and only its Task waits with it.
 * An escalated permission takes only the human's answer in `/team pending`;
 * an escalated question also takes the human's answer relayed from chat.
 */
export interface Escalation {
	/** The held request's id, or `q<n>` for a prose question. */
	id: string;
	teammate: string;
	/** The Task in the Teammate's context when it asked. */
	task?: string;
	/** A permission prompt or an `AskUserQuestion` its hook holds, or a question in a stopped-short Teammate's last message. */
	kind: "permission" | "question" | "prose";
	/** What is asked, as the human reads it. */
	question: string;
	/** The Lead's summary for the human: what is asked and why the Brief doesn't settle it. */
	summary: string;
	/** What the Brief says on it, as the Lead read it. */
	brief?: string;
	at: string;
	/** Set once the human answered it. */
	answered?: { answer: string; decision?: "allow" | "deny"; via: "pending" | "lead"; at: string };
}

/** An entry of `clarifications.md`: the human's answer to an escalated question, which counts as part of the Brief. */
export interface Clarification {
	id: string;
	teammate: string;
	task?: string;
	question: string;
	summary: string;
	brief?: string;
	answer: string;
	/** Where the human answered: `/team pending`, or in chat with the Lead relaying it. */
	via: "pending" | "lead";
	at: string;
}

/** The human's answer to a pending item: a Playbook change is approved (adopted) or declined, the rest approved or sent back. */
export type Answer = "approved" | "sent-back" | "declined";

/** How an Effort ended. */
export interface Ended {
	how: "signed-off" | "cancelled";
	at: string;
}

/** A request the human was asked, kept after it leaves `pending`, for the final Report's checkpoints. */
export interface Asked {
	id: string;
	checkpoint: PendingApproval["checkpoint"];
	sha256: string;
	at: string;
	/** The proposed change's id, for a Playbook change. */
	change?: string;
	/** How it left `pending`; absent while it waits. */
	outcome?: { how: Answer | "replaced" | "dropped"; at: string; note?: string };
}

/** One of the account's usage windows, as a reading gives it. */
export interface UsageWindow {
	/** How much of it is used, 0 to 100. */
	percent: number;
	/** When it resets, ISO; absent when the reading doesn't say. */
	resetsAt?: string;
}

/**
 * One usage reading: a Teammate's status line, or the `get_usage` control
 * request when no status line is fresh. A window the reading doesn't give is
 * absent, never 0.
 */
export interface UsageReading {
	source: "status-line" | "get-usage";
	/** When it was taken: the status line file's modification time, or when `get_usage` answered. */
	at: string;
	/** The Teammate whose status line it is. */
	teammate?: string;
	/** The Claude Code session the status line is of. */
	sessionId?: string;
	/** Whether it came with the account's rate limits: a subscription's does, an API key's never. */
	rateLimits: boolean;
	fiveHour?: UsageWindow;
	sevenDay?: UsageWindow;
	/** The session's input and output tokens so far. */
	tokens?: number;
	/** The session's estimate so far, at API prices, in USD. */
	costUsd?: number;
	/** How full the session's context window is, 0 to 100. */
	ctx?: number;
}

/** What one session has spent: its latest figures, and what earlier figures it reset from had reached. */
export interface SessionSpend {
	tokens: number;
	costUsd: number;
	/** The sum of the figures a drop showed to be reset: they were spent too. */
	banked: { tokens: number; costUsd: number };
}

/** What the usage readings fold to. */
export interface UsageState {
	/** The freshest account reading: the newest with rate limits, or the newest of all while none has them. */
	latest: UsageReading;
	/** Each window as the first reading that gave it had it, for the change since the Effort began. */
	first: { fiveHour?: UsageWindow; sevenDay?: UsageWindow };
	/** Whether any reading came with rate limits; never, with an API key. */
	rateLimits: boolean;
	/** Each Teammate's latest status line: when it was taken, and how full its context was. */
	statusLines: Record<string, { at: string; ctx?: number }>;
	/** What each Teammate spent, by session id. */
	spend: Record<string, Record<string, SessionSpend>>;
}

/** Who set a pause, the only one who lifts it: the human, the Lead, or a usage limit. */
export type PauseSetter = "human" | "lead" | "usage";

/** A pause that holds. */
export interface Pause {
	by: PauseSetter;
	reason?: string;
	/** For the usage pause: the limit that set it. */
	kind?: "session" | "weekly";
	/** For the usage pause: when it lifts, when Claude Code said. */
	reset?: string;
	/** For the usage pause: the human was asked to stay paused or cancel, so nothing asks again while it holds. */
	asked?: true;
	/** When it started. */
	at: string;
}

/** Who lifts each pause, in the order the Team block shows them. */
const SETTERS: readonly PauseSetter[] = ["human", "lead", "usage"];

/** One entry of the decided-for-you or found-work log. */
export interface Logged {
	what: string;
	/** The Task it came up in, when it did. */
	task?: string;
	at: string;
}

/** One logged section of a Report, which is left out when it has no lines. */
export interface ReportSection {
	title: string;
	lines: string[];
}

/** A Report: the Lead's narrative and the sections the extension adds from the log. */
export interface Report {
	n: number;
	at: string;
	headline: string;
	/** Brief coverage by criterion id, as the Lead tells it. */
	coverage: { criterion: string; note: string }[];
	sections: ReportSection[];
	/** Set on the final Report, which the human signs off. */
	final?: true;
}

/** What the shell gathers for the final Report: the Playbook snapshot's checkpoint ids, the proposed changes, the Effort's worktrees now and each Role's model. */
export interface FinalFacts {
	checkpoints: readonly string[];
	changes: readonly PlaybookChange[];
	worktrees: readonly { path: string; branch: string; dirty: boolean }[];
	/** Each Role's model in the Team snapshot, which its Teammates were launched on; a Role without one ran on Claude Code's default. */
	models: Readonly<Record<string, string>>;
}

/** What an Effort's lines fold to. */
export interface EffortState {
	effortId: string;
	team: string;
	/** The git root the Effort works on. */
	repo: string;
	/** The sha256 of the Playbook in force when the Effort was opened. */
	playbook: string;
	/** Set once the human approves the Brief; until then no Teammate starts. An approved Brief change moves it on. */
	brief?: { sha256: string; approvedAt: string; request: string };
	/** The Tasks a Brief change holds, from its request until the human approves one; a send-back keeps them held. */
	briefHold?: { request: string; slugs: string[] };
	/** Added when the Brief is approved. */
	workspace?: Workspace;
	/** What waits on the human, oldest first. */
	pending: PendingApproval[];
	/** How many approvals have been requested, which numbers the next one. */
	requests: number;
	/** The Lead's latest Task list; absent until it first plans. */
	plan?: PlannedTask[];
	/** Every Task handed off, by slug, in handoff order. */
	tasks: Record<string, HandedTask>;
	/** Every Teammate started, oldest first. */
	teammates: Teammate[];
	/** Tasks handed off while at the cap, in handoff order: each starts by itself when a Teammate frees up. */
	queue: QueuedTask[];
	/** The last Report's number; 0 before the first. */
	reports: number;
	/** The lines a Report tells of since the last one, oldest first. */
	sinceReport: EffortLine[];
	/** The decided-for-you log, oldest first. */
	decided: Logged[];
	/** The found-work (scope-creep) log, oldest first. */
	found: Logged[];
	/** The pauses that hold, by setter; absent before the first pause. */
	pauses?: Partial<Record<PauseSetter, Pause>>;
	/** What the usage readings say; absent before the first. */
	usage?: UsageState;
	/** Every request a Teammate's hook held for an answer, by request id, oldest first. */
	teammateRequests: Record<string, HeldRequest>;
	/** Everything the Lead escalated to the human, by id, oldest first; absent before the first. */
	escalations?: Record<string, Escalation>;
	/** The model-family holds, by family; absent before the first. */
	holds?: Partial<Record<Family, ModelHold>>;
	/** The usage items waiting on the human, oldest first; absent before the first. */
	usageItems?: UsageItem[];
	/** How many usage items have been raised, which numbers the next one. */
	usageAsked?: number;
	/** Every approval requested, oldest first, with how it was answered; absent before the first. */
	asked?: Asked[];
	/** The number of the last Report while it is the final one, which sign-off is asked for. */
	finalReport?: number;
	/** Set once the Effort is over; then nothing more is taken. */
	ended?: Ended;
	/** Launches written ahead and not yet in or abandoned, by Teammate id; absent before the first. */
	launching?: Record<string, { name: string; lines: EffortLine[]; at: string }>;
	/** Pointers sent over an inbox and not yet known to have landed: the round each Task's is for, by slug; absent when none is owed. */
	undelivered?: Record<string, number>;
}

/** A new input to the core. */
export type EffortInput =
	/** `team_request_approval`, with the draft already validated and snapshotted. */
	| { kind: "request-approval"; checkpoint: string; path: string; sha256: string; snapshot: string; affects?: string[]; checkpoints?: string[]; at: string }
	/**
	 * The human's answer to a pending item, with the Workspace the shell added
	 * for an approved Brief, and for an approved Brief change the Roles whose
	 * launch options it alters.
	 */
	| { kind: "answer"; id: string; answer: Answer; note?: string; workspace?: Workspace; refresh?: string[]; terms?: boolean; at: string }
	/** A Lead tool that would start a Teammate. */
	| { kind: "start-teammate"; tool: "team_plan" | "team_handoff" | "team_review" }
	/**
	 * `team_plan`: the whole Task list, checked against the approved Brief's
	 * criterion ids and the Roles of the Team snapshot, which the shell reads.
	 */
	| {
			kind: "plan";
			tasks: { slug: string; role: string; goal: string; dependsOn?: string[]; criteria?: string[] }[];
			criteria: readonly string[];
			roles: readonly string[];
			/** Why the Lead re-planned, for the next Report. */
			reason?: string;
			at: string;
	  }
	/**
	 * `team_report`: the Lead's narrative, with the approved Brief's criterion
	 * ids and the mode each Role launches in, which the shell reads, and any
	 * work the Lead found outside the Brief since the last Report.
	 */
	| {
			kind: "report";
			headline: string;
			coverage?: { criterion: string; note: string }[];
			found?: string[];
			criteria: readonly string[];
			modes: readonly { role: string; mode: string }[];
			/** For the final Report, which maps every criterion to evidence: what the shell gathered. */
			final?: FinalFacts;
			/** The Lead's own cost so far, in USD, as pi reports it, which the shell reads. */
			leadCostUsd?: number;
			at: string;
	  }
	/**
	 * Ask the human to sign off the final Report just written, as the shell
	 * rendered it (`snapshot`, with its sha256), and to adopt or decline each
	 * change it proposes, each with the sha256 of its {@link changeSnapshot}.
	 */
	| { kind: "request-sign-off"; path: string; sha256: string; snapshot: string; changes: readonly { change: PlaybookChange; sha256: string }[]; at: string }
	/** `/team cancel`, confirmed: the Effort ends without sign-off. */
	| { kind: "cancel"; at: string }
	/**
	 * `team_handoff` of a planned Task, with the permission mode a Teammate
	 * started for it launches in and the cap of live Teammates (pi's
	 * `maxTeammates` setting, {@link DEFAULT_MAX_TEAMMATES} by default), and
	 * the `--name`s `claude agents --json` lists (undefined when it couldn't be read).
	 */
	| { kind: "handoff"; slug: string; at: string; mode?: string; maxTeammates?: number; isolated?: boolean; agents?: readonly string[] }
	/** What the merge an accept intended came to: merge commit `commit` (absent when there was nothing to merge), or why git refused it, nothing half-done. */
	| { kind: "merge-result"; slug: string; commit?: string; error?: string; at: string }
	/**
	 * Line `cursor` of `teammate`'s journal (counted from 1), with whether the
	 * result its current Task is due to write ({@link currentResult}) is on disk.
	 */
	| {
			kind: "journal";
			teammate: string;
			cursor: number;
			line: JournalLine;
			result: { path: string; written: boolean };
			/** The machine's UTC offset in minutes, which a limit's reset naming no time zone is read in; UTC when absent. */
			tz?: number;
			/** Each Role's model, from the Team snapshot, which a model-family limit holds Roles by. */
			models?: Record<string, string>;
			/** The prompts the Effort itself sent the Teammate (its pointers, `continue`): a prompt matching one is not the human's. */
			sent?: readonly string[];
	  }
	/**
	 * `team_review` of a handed-off Task, with whether its current round's
	 * result is on disk and the Playbook's `sendBackLimit`, which the shell reads.
	 */
	| {
			kind: "review";
			slug: string;
			verdict: "accept" | "send_back";
			feedback?: string;
			result: { path: string; written: boolean };
			sendBackLimit: number;
			/** The permission mode a new Teammate of the Task's Role launches in, should a send-back need one. */
			mode?: string;
			/** The cap of live Teammates, for a send-back whose Teammate has ended and goes through the staffing ladder. */
			maxTeammates?: number;
			at: string;
	  }
	/**
	 * Start the first queued Task the staffing ladder can staff now, with the
	 * cap of live Teammates. The shell asks after each acceptance, once the
	 * acceptance is on record, and again while one starts: each start is its
	 * own step, so a launch that fails leaves only its own Task queued. With
	 * `agents` as for a handoff.
	 */
	| { kind: "drain"; at: string; maxTeammates?: number; agents?: readonly string[] }
	/** The human used the `/team` menu on a Teammate: attached here, in a tmux window, or took the command. */
	| { kind: "attach"; teammate: string; at: string }
	/** `/team pause` from the human, or `team_pause` from the Lead, which must give a reason. */
	| { kind: "pause"; by: "human" | "lead"; reason?: string; at: string }
	/** `/team resume` from the human in a session holding the Effort, or `team_resume` from the Lead: each lifts only its own pause. */
	| { kind: "resume"; by: "human" | "lead"; at: string }
	/** A usage reading the shell took: a Teammate's `statusline.json`, or `get_usage`. */
	| { kind: "usage"; reading: UsageReading }
	/** `team_answer` of a held request. */
	| ({ kind: "answer-request"; at: string } & RequestAnswer)
	/** `team_escalate`: a held `request`, or a stopped-short `teammate`'s prose `question`, moved to the human with the Lead's summary. */
	| { kind: "escalate"; request?: string; teammate?: string; question?: string; summary: string; brief?: string; at: string }
	/** The human's answer to an escalated item in `/team pending`. */
	| { kind: "answer-escalation"; id: string; decision?: "allow" | "deny"; reason?: string; answers?: Record<string, string | string[]>; text?: string; at: string }
	/** `team_send`: a short prose message to a Teammate. */
	| { kind: "send"; teammate: string; message: string; at: string }
	/** The shell's clock, every minute while an Effort is held: lifts usage pauses and holds at their reset, and continues limited Teammates when due. */
	| { kind: "tick"; at: string }
	/** The human's answer to usage item `id`, one of its {@link USAGE_CHOICES}. */
	| { kind: "answer-usage"; id: string; choice: string; at: string }
	/**
	 * After a restart, before the journals are replayed: git's and Claude
	 * Code's evidence for the intents left open, which the shell gathers.
	 */
	| {
			kind: "recover";
			/** The `--name`s `claude agents --json` lists; absent when it couldn't be read. */
			agents?: readonly string[];
			/** Ids of the Teammates whose launched session wrote to their journal: any line for a new one, a `SessionStart` past its cursor, other than a clear, for one started afresh. */
			journaled?: readonly string[];
			/** Where each open merge stands in git, by slug; absent for one git couldn't tell. */
			merges?: Record<string, MergeEvidence>;
			/** The Brief promotions `approvals.jsonl` records. */
			promoted?: readonly { request: string; brief: string; workspace?: Workspace }[];
			/**
			 * The other approvals `approvals.jsonl` records, in its order: a Brief
			 * change (with the Roles it refreshed), a Playbook change or a
			 * sign-off, by request id and the sha of what the human approved.
			 */
			recorded?: readonly { request: string; sha256: string; refresh?: readonly string[]; terms?: boolean }[];
			at: string;
	  }
	/**
	 * After a restart, once the journals are replayed: what was sent and never
	 * landed is sent again. `sent` names the Tasks whose pointer the replay
	 * sent; `agents` the `--name`s `claude agents --json` lists, absent when it
	 * couldn't be read; `marked` the Teammates with a `takeover` marker on disk,
	 * absent when the markers weren't read.
	 */
	| { kind: "reconcile"; sent?: readonly string[]; agents?: readonly string[]; marked?: readonly string[]; at: string }
	/** `/team handback <teammate> [note]` in pi, with whether the Teammate's current result is on disk. */
	| { kind: "handback"; teammate: string; note?: string; result: { path: string; written: boolean }; at: string };

/** Where an open merge stands in git: in the Effort branch (by merge commit `commit`, absent when it had nothing new), cut short with `MERGE_HEAD` left behind, or never begun. */
export type MergeEvidence = { state: "merged"; commit?: string } | { state: "half-done" } | { state: "not-started" };

/** Work the core leaves to the shell. */
export type EffortAction =
	/** Write the approved Brief as `brief.md`, snapshot the Team and the Playbook, and record the act. */
	| { kind: "promote-brief"; approval: PendingApproval; at: string }
	/** Write the approved Brief change as `brief.md` and record the act; the Playbook and Team snapshots stay as they are. */
	| { kind: "promote-brief-change"; approval: PendingApproval; at: string }
	/** Record the approval at a Playbook checkpoint or an `escalate` id, with the sha256 of what was approved. */
	| { kind: "record-checkpoint"; approval: PendingApproval; at: string }
	/** Start a turn of the Lead's model with this text. */
	| { kind: "wake-lead"; text: string }
	/** Write `plan.md` as a view of the state's plan. */
	| { kind: "write-plan" }
	/** Write the Task's folder and `task.md` from the plan. */
	| { kind: "write-task"; slug: string; folder: string }
	/** Launch the Teammate on the Task, not before `at`: starts are staggered {@link STAGGER_MS} apart. */
	| { kind: "launch-teammate"; teammate: Omit<Teammate, "task" | "startedAt">; task: { slug: string; folder: string }; at: string }
	/** Stop the Teammate's background session, `claude stop <short id>`. */
	| { kind: "stop-teammate"; teammate: string; shortId: string }
	/**
	 * Send the Teammate the clear marker over its inbox, which the mod turns
	 * into a `/clear`; the Task's pointer follows once its `SessionStart`
	 * with source `clear` is read ({@link EffortAction} `send-pointer`).
	 */
	| { kind: "clear-then-send"; teammate: string; inbox: Inbox; slug: string; folder: string }
	/** Send the Teammate the pointer to round `round` of the Task over its inbox. */
	| { kind: "send-pointer"; teammate: string; inbox: Inbox; slug: string; folder: string; round: number }
	/**
	 * Write `feedback` as `feedback-<round>.md` in the Task's folder, then send
	 * the Teammate a pointer to it over its inbox, with no clear: it keeps its
	 * own reasoning, and writes `result-<round + 1>.md` next.
	 */
	| { kind: "send-back"; teammate: string; inbox: Inbox; slug: string; folder: string; round: number; feedback: string }
	/**
	 * Write `feedback` as `feedback-<round>.md` in the Task's folder, for a
	 * send-back whose Teammate has ended: the Teammate the staffing ladder gives
	 * it, now or once queued, launches with a pointer to the rounds so far.
	 */
	| { kind: "write-feedback"; folder: string; round: number; feedback: string }
	/** Stop the Teammate's background session, `claude stop <short id>`, which keeps its conversation; its `--name` before it has a short id. */
	| { kind: "stop-teammate"; teammate: string; shortId: string }
	/** Write the Report as `reports/<nnn>.md`. */
	| { kind: "write-report"; report: Report }
	/** Cut an isolated Task's worktree at `path` on new branch `branch` from the Effort branch `from`'s tip, copying what `.worktreeinclude` lists, before its Teammate launches there. */
	| ({ kind: "add-task-workspace"; slug: string; from: string } & TaskWorktree)
	/**
	 * Merge an isolated Task's `branch` into the Effort's Workspace at `into`
	 * with `--no-ff`, refusing a dirty Workspace and leaving nothing half-merged
	 * on a conflict, then step its `merge-result`. Its intent is on record first.
	 * `abort`: a merge cut short by a restart left `MERGE_HEAD`, aborted first.
	 */
	| ({ kind: "merge"; slug: string; folder: string; into: string; abort?: true } & TaskWorktree)
	/** Remove a merged Task's worktree and its branch, once its Teammate is stopped. */
	| ({ kind: "remove-task-workspace"; slug: string } & TaskWorktree)
	/** Send the decision to the hook holding `request`, which prints it for Claude Code. */
	| { kind: "answer-hook"; request: string; teammate: string; decision: HookDecision }
	/** Send a limited Teammate `continue` over its inbox. */
	| { kind: "send-continue"; teammate: string; inbox: Inbox }
	/** Check the final Report still has the sha256 signed off, and record the act in `approvals.jsonl`. */
	| { kind: "record-sign-off"; approval: PendingApproval; at: string }
	/** Apply the approved change to the Team's adopted Playbook, for the next Effort, and record the act. */
	| { kind: "adopt-playbook-change"; approval: PendingApproval & { change: PlaybookChange }; at: string }
	/** The Effort is over: clean up its worktrees, keep every branch, and let go of it in this session. */
	| { kind: "end-effort"; how: Ended["how"] }
	/** Append the human's answer to an escalated question to `clarifications.md`. */
	| { kind: "append-clarification"; entry: Clarification }
	/** Get `message` to the Teammate as its next turn: through its inbox, or by resuming its session. */
	| { kind: "send-message"; teammate: string; inbox: Inbox; message: string }
	/** Send the Teammate the pointer to round `round` of the Task again: through its inbox, or by resuming its session. */
	| { kind: "redeliver"; teammate: string; slug: string; folder: string; round: number }
	/** Remove `feedback-<round>.md` from the Task's folder: the send-back that wrote it never launched its Teammate. */
	| { kind: "discard-feedback"; slug: string; folder: string; round: number }
	/** Write (`on`) or remove the Teammate's `takeover` marker, which its hook reads to leave permission prompts to the human. */
	| { kind: "mark-takeover"; teammate: string; on: boolean }
	/** Room opened for queued Tasks: a usage pause or a model hold lifted, or a Teammate crashed. Drain the queue. */
	| { kind: "start-queued" };

export type Step =
	| { ok: true; state: EffortState; append: EffortLine[]; actions: EffortAction[]; reply?: string }
	| { ok: false; refusal: string };

/** The first line of a new Effort. */
export function openEffort(opened: { effortId: string; team: string; repo: string; playbook: string; at: string }): EffortLine {
	return { type: "effort-opened", ...opened };
}

/** Lines a Report doesn't tell of: they only carry what other lines say. */
const UNREPORTED: ReadonlySet<EffortLine["type"]> = new Set(["effort-opened", "teammate-started", "teammate-session", "prompt-landed", "report-written", "teammate-attached", "clear-requested", "usage-read", "request-held", "request-answered", "takeover-input", "takeover-turn", "send-held", "launch-intended", "launch-abandoned"]);

/** Fold one line into the state, keeping what the next Report tells of. */
function apply(state: EffortState, line: EffortLine): EffortState {
	const next = applyLine(state, line);
	if (line.type === "report-written") {
		const { finalReport: _final, ...rest } = next;
		return { ...rest, reports: line.n, sinceReport: [], ...(line.final ? { finalReport: line.n } : {}) };
	}
	return UNREPORTED.has(line.type) ? next : { ...next, sinceReport: [...next.sinceReport, line] };
}

function applyLine(state: EffortState, line: EffortLine): EffortState {
	switch (line.type) {
		case "effort-opened":
			throw new Error(`effort.jsonl opens Effort \`${state.effortId}\` a second time, as \`${line.effortId}\``);
		case "approval-requested": {
			const { type: _type, ...approval } = line;
			// A newer request at the same checkpoint replaces one the human hasn't answered; a new sign-off also replaces the changes the last final Report proposed.
			const replaces = (item: PendingApproval) =>
				approval.checkpoint === PLAYBOOK_CHANGE ? false : item.checkpoint === approval.checkpoint || (approval.checkpoint === SIGN_OFF && item.checkpoint === PLAYBOOK_CHANGE);
			const replaced = state.pending.filter(replaces).map((item) => item.id);
			return {
				...state,
				// A Brief change holds its Tasks from the moment it is asked, in place of any change before it.
				...(approval.checkpoint === BRIEF_CHANGE ? { briefHold: { request: approval.id, slugs: approval.affects ?? [] } } : {}),
				pending: [...state.pending.filter((item) => !replaces(item)), approval],
				requests: state.requests + 1,
				asked: [
					...settle(state.asked ?? [], replaced, { how: "replaced", at: line.at }),
					{ id: line.id, checkpoint: line.checkpoint, sha256: line.sha256, at: line.at, ...(line.change === undefined ? {} : { change: line.change.id }) },
				],
			};
		}
		case "approval-answered": {
			const answered = state.pending.find((item) => item.id === line.id);
			// Sending back the final Report drops the changes it proposed: the next final Report proposes its own.
			const dropped = answered?.checkpoint === SIGN_OFF && line.answer === "sent-back" ? state.pending.filter((item) => item.checkpoint === PLAYBOOK_CHANGE).map((item) => item.id) : [];
			const pending = state.pending.filter((item) => item.id !== line.id && !dropped.includes(item.id));
			const asked = settle(settle(state.asked ?? [], [line.id], { how: line.answer, at: line.at, ...(line.note === undefined ? {} : { note: line.note }) }), dropped, { how: "dropped", at: line.at });
			if (line.answer === "approved" && answered?.checkpoint === BRIEF) {
				return {
					...state,
					pending,
					asked,
					brief: { sha256: answered.sha256, approvedAt: line.at, request: answered.id },
					...(line.workspace === undefined ? {} : { workspace: line.workspace }),
				};
			}
			if (line.answer === "approved" && answered?.checkpoint === BRIEF_CHANGE) {
				const { briefHold: _briefHold, ...rest } = state;
				const refresh = line.refresh ?? [];
				const renew = line.renew ?? [];
				return {
					...rest,
					pending,
					asked,
					brief: { sha256: answered.sha256, approvedAt: line.at, request: answered.id },
					// Each live Teammate of a Role whose launch options changed, or holding session rules the change outdates, gets a fresh session at its next Task boundary.
					teammates: state.teammates.map((teammate) =>
						(refresh.includes(teammate.role) || renew.includes(teammate.id)) && isLive(teammate) ? { ...teammate, freshDue: true } : teammate,
					),
				};
			}
			return { ...state, pending, asked };
		}
		case "effort-ended":
			return { ...state, pending: [], ended: { how: line.how, at: line.at } };
		case "plan-written":
			return { ...state, plan: line.tasks };
		case "teammate-started": {
			const { type: _type, ...teammate } = line;
			return { ...launched(state, line.id), teammates: [...state.teammates, teammate] };
		}
		case "launch-intended": {
			const { type: _type, teammate, ...intent } = line;
			return { ...state, launching: { ...state.launching, [teammate]: intent } };
		}
		case "launch-abandoned":
			return launched(state, line.teammate);
		case "task-handed-off": {
			const { type: _type, slug, ...handed } = line;
			// A reused Teammate takes the Task into a fresh context, so how its last one ended no longer applies.
			const teammates = state.teammates.map((teammate) => {
				if (teammate.id !== line.teammate || teammate.task === slug) return teammate;
				const { activity: _activity, doing: _doing, ...rest } = teammate;
				return { ...rest, task: slug };
			});
			return { ...state, teammates, tasks: { ...state.tasks, [slug]: handed }, queue: state.queue.filter((queued) => queued.slug !== slug) };
		}
		case "task-queued": {
			const { type: _type, ...queued } = line;
			return { ...state, queue: [...state.queue, queued] };
		}
		case "clear-requested":
			return owe(
				{ ...state, teammates: state.teammates.map((teammate) => (teammate.id === line.teammate ? { ...teammate, clearing: line.slug } : teammate)) },
				line.slug,
				state.tasks[line.slug]?.round,
			);
		case "teammate-retired":
			return { ...state, teammates: state.teammates.map((teammate) => (teammate.id === line.teammate ? { ...teammate, retiredAt: line.at } : teammate)) };
		case "teammate-relaunched":
			return launched({
				...state,
				teammates: state.teammates.map((teammate) => {
					if (teammate.id !== line.teammate) return teammate;
					// What the old session knew goes with it: the new one starts from its launch, with no session rules.
					// A card its old session's terminal killed the hook of goes too: the new session going on says nothing of it.
					const { freshDue: _fresh, inbox: _inbox, activity: _activity, doing: _doing, limit: _limit, rules: _rules, clearing: _clearing, observedMode: _observed, mode: _mode, denied: _denied, ...rest } = teammate;
					return { ...rest, task: line.task, startedAt: line.at, relaunching: true, ...(line.mode === undefined ? {} : { mode: line.mode }) };
				}),
			}, line.teammate);
		case "teammate-session": {
			const before = state.teammates.find((teammate) => teammate.id === line.teammate)?.shortId;
			const started = withTeammate(state, line, {
				sessionId: line.sessionId,
				shortId: line.shortId,
				...(line.inbox === undefined ? {} : { inbox: line.inbox }),
				// A short id that replaces another is a new attach target, marked until the human attaches to it.
				...(before !== undefined && before !== line.shortId ? { newShortId: true } : {}),
			});
			// A fresh session's start ends its relaunch.
			const changed = {
				...started,
				teammates: started.teammates.map((teammate) => {
					if (teammate.id !== line.teammate || !teammate.relaunching) return teammate;
					const { relaunching: _relaunching, ...rest } = teammate;
					return rest;
				}),
			};
			if (line.source !== "clear") return changed;
			// The clear asked for has happened.
			return {
				...changed,
				teammates: changed.teammates.map((teammate) => {
					if (teammate.id !== line.teammate) return teammate;
					const { clearing: _clearing, ...rest } = teammate;
					return rest;
				}),
			};
		}
		case "teammate-attached":
			return {
				...state,
				teammates: state.teammates.map((teammate) => {
					if (teammate.id !== line.teammate) return teammate;
					const { newShortId: _new, ...rest } = teammate;
					return { ...rest, attached: line.shortId };
				}),
			};
		case "prompt-landed":
			return delivered(landed(withTeammate(state, line, { activity: "busy", doing: undefined }), line.teammate), line);
		case "permission-denied":
			return withTeammate(state, line, {});
		case "task-sent-back": {
			const task = state.tasks[line.slug];
			return task ? owe(withTask(state, line.slug, { round: line.round + 1, sendBacks: (task.sendBacks ?? 0) + 1 }), line.slug, line.round + 1) : state;
		}
		case "task-accepted":
			return merged(withTask(state, line.slug, { accepted: line.at }), line.slug);
		case "merge-intended":
			return withTask(state, line.slug, { merging: line.at });
		case "merge-failed":
			return merged(state, line.slug);
		case "teammate-stopped":
			return withLimit(endRequests(withTeammate(state, line, { activity: "idle", doing: "stopped short" }), line.teammate), line.teammate, undefined);
		case "teammate-mode":
			return withTeammate(state, line, { observedMode: line.mode });
		case "task-dropped":
			return { ...withTask(state, line.slug, { dropped: line.at }), queue: state.queue.filter((queued) => queued.slug !== line.slug) };
		case "task-reassigned":
			// Its new Teammate's launch carries the pointer. A sent-back Task queued for one leaves the queue.
			return { ...owe(withTask(state, line.slug, { teammate: line.teammate }), line.slug, undefined), queue: state.queue.filter((queued) => queued.slug !== line.slug) };
		case "teammate-ended":
			return endRequests({ ...state, teammates: state.teammates.map((teammate) => (teammate.id === line.teammate ? { ...teammate, ended: { how: line.how, at: line.at } } : teammate)) }, line.teammate);
		case "teammate-crashed":
			return endRequests(withTeammate(state, line, { ended: { how: "crashed", at: line.at } }), line.teammate);
		case "decided-for-you":
		case "found-work": {
			const { type, ...logged } = line;
			return type === "decided-for-you" ? { ...state, decided: [...state.decided, logged] } : { ...state, found: [...state.found, logged] };
		}
		case "paused": {
			const { type: _type, ...pause } = line;
			return { ...state, pauses: { ...state.pauses, [line.by]: pause } };
		}
		case "resumed": {
			const { [line.by]: _lifted, ...rest } = state.pauses ?? {};
			return { ...state, pauses: rest };
		}
		case "task-requeued":
			return { ...state, queue: state.queue.map((queued) => (queued.slug === line.slug ? { ...queued, why: line.why } : queued)) };
		case "report-written":
			return state;
		case "usage-read": {
			const { type: _type, ...reading } = line;
			return { ...state, usage: withReading(state.usage, reading) };
		}
		case "request-held": {
			const { type: _type, cursor: _cursor, ...held } = line;
			return { ...withTeammate(state, line, {}), teammateRequests: { ...state.teammateRequests, [line.request]: { ...held, state: "held" } } };
		}
		case "request-settled": {
			const denied = state.teammates.find((each) => each.id === line.teammate)?.denied;
			// A kill may still be a Yes: it is a No only once the Teammate goes on without the call.
			const change = line.how === "denied-in-terminal" ? { denied: line.request } : denied === line.request ? { denied: undefined } : {};
			return withRequest(withTeammate(state, line, change), line.request, line.how);
		}
		case "takeover-started":
			return withTeammate(state, line, { takeover: { since: line.at, trigger: line.trigger, inputs: line.input === undefined ? [] : [line.input], held: [] }, denied: undefined });
		case "takeover-input":
			return withTakeover(withTeammate(state, line, {}), line.teammate, (takeover) => ({ ...takeover, inputs: [...takeover.inputs, line.input] }));
		case "takeover-turn":
			return endRequests(withTeammate(state, line, { activity: "idle", doing: "yours" }), line.teammate);
		case "send-held": {
			const { type: _type, teammate: _teammate, ...held } = line;
			return withTakeover(state, line.teammate, (takeover) => ({ ...takeover, held: [...takeover.held, held] }));
		}
		case "takeover-ended": {
			const moved = line.cursor === undefined ? state : withTeammate(state, { teammate: line.teammate, cursor: line.cursor }, {});
			return { ...moved, teammates: moved.teammates.map((teammate) => (teammate.id === line.teammate ? withoutTakeover(teammate) : teammate)) };
		}
		case "request-answered": {
			const answered = withRequest(state, line.request, "answered");
			if (line.rule === undefined) return answered;
			const rule = { rule: line.rule, ...(line.task === undefined ? {} : { task: line.task }) };
			return {
				...answered,
				teammates: answered.teammates.map((teammate) => (teammate.id === line.teammate ? { ...teammate, rules: [...(teammate.rules ?? []), rule] } : teammate)),
			};
		}
		case "escalated": {
			const { type: _type, ...escalation } = line;
			return { ...state, escalations: { ...state.escalations, [line.id]: escalation } };
		}
		case "escalation-answered": {
			const { type: _type, id, ...answered } = line;
			const escalation = state.escalations?.[id];
			return escalation ? { ...state, escalations: { ...state.escalations, [id]: { ...escalation, answered } } } : state;
		}
		case "message-sent":
			return state;
		case "task-done": {
			const advanced = withLimit(endRequests(withTeammate(state, line, { activity: "idle", doing: `round ${line.round} done` }), line.teammate), line.teammate, undefined);
			const task = advanced.tasks[line.slug];
			return task ? { ...advanced, tasks: { ...advanced.tasks, [line.slug]: { ...task, reported: line.round } } } : advanced;
		}
		case "teammate-limited":
			return withLimit(endRequests(withTeammate(state, line, { activity: "idle", doing: limitDoing(line.limit) }), line.teammate), line.teammate, line.limit);
		case "limit-cleared":
			return withLimit(withTeammate(state, line, {}), line.teammate, undefined);
		case "teammate-continued": {
			const limit = state.teammates.find((teammate) => teammate.id === line.teammate)?.limit;
			if (line.why === "reset" || limit === undefined) return withLimit(state, line.teammate, undefined);
			const { next: _next, ...rest } = limit;
			return withLimit(state, line.teammate, { ...rest, tries: line.tries ?? 0 });
		}
		case "model-held": {
			const { type: _type, ...hold } = line;
			return { ...state, holds: { ...state.holds, [line.family]: hold } };
		}
		case "model-released": {
			const { [line.family]: _lifted, ...rest } = state.holds ?? {};
			return { ...state, holds: rest };
		}
		case "usage-escalated": {
			const { type: _type, ...item } = line;
			const usage = state.pauses?.usage;
			const pauses = line.why === "far-reset" && usage ? { ...state.pauses, usage: { ...usage, asked: true as const } } : state.pauses;
			return { ...state, ...(pauses ? { pauses } : {}), usageItems: [...(state.usageItems ?? []), item], usageAsked: (state.usageAsked ?? 0) + 1 };
		}
		case "usage-answered":
			return { ...state, usageItems: (state.usageItems ?? []).filter((item) => item.id !== line.id) };
	}
}

/** The state with Task `slug`'s pointer owed for `round`, or no longer owed. */
function owe(state: EffortState, slug: string, round: number | undefined): EffortState {
	const { [slug]: _owed, ...rest } = state.undelivered ?? {};
	const undelivered = round === undefined ? rest : { ...rest, [slug]: round };
	const { undelivered: _all, ...without } = state;
	return Object.keys(undelivered).length === 0 ? without : { ...without, undelivered };
}

/** A prompt landed: a pointer it names the owed result of has arrived. */
function delivered(state: EffortState, line: Extract<EffortLine, { type: "prompt-landed" }>): EffortState {
	return Object.entries(state.undelivered ?? {}).reduce((each, [slug, round]) => {
		const task = each.tasks[slug];
		return task?.teammate === line.teammate && line.prompt.includes(`${task.folder}/result-${round}.md`) ? owe(each, slug, undefined) : each;
	}, state);
}

/** The launch of `teammate` written ahead is closed: it is in, or abandoned. */
function launched(state: EffortState, teammate: string): EffortState {
	if (state.launching?.[teammate] === undefined) return state;
	const { [teammate]: _closed, ...rest } = state.launching;
	const { launching: _all, ...without } = state;
	return Object.keys(rest).length === 0 ? without : { ...without, launching: rest };
}

/** The state with `teammate`'s limit set to `limit`, or cleared. */
function withLimit(state: EffortState, teammate: string, limit: TeammateLimit | undefined): EffortState {
	return {
		...state,
		teammates: state.teammates.map((each) => {
			if (each.id !== teammate) return each;
			const { limit: _limit, ...rest } = each;
			return limit === undefined ? rest : { ...rest, limit };
		}),
	};
}

/** A prompt landed on `teammate`: its auto-wait, if armed, is spent, and a limit that isn't retried on the ladder is over. */
function landed(state: EffortState, teammate: string): EffortState {
	const limit = state.teammates.find((each) => each.id === teammate)?.limit;
	if (limit === undefined) return state;
	if (!TRANSIENT.has(limit.kind)) return withLimit(state, teammate, undefined);
	const { armed: _armed, ...rest } = limit;
	return withLimit(state, teammate, rest);
}

/** The failures that clear by themselves, retried on the ladder. */
const TRANSIENT: ReadonlySet<TeammateLimit["kind"]> = new Set(["throttle", "overloaded", "server_error"]);

/** How a limited Teammate's turn ended, as the Team block shows it. */
function limitDoing(limit: TeammateLimit): string {
	if (limit.kind === "consent") return "usage credits unconfirmed";
	if (limit.kind === "unknown") return "turn failed";
	if (TRANSIENT.has(limit.kind)) return `${limit.kind.replace("_", " ")}, retrying`;
	return `${LIMIT_NAMES[limit.kind as LimitKind]} limit`;
}

/** A limited turn, as a Report tells it. */
function limitTold(limit: TeammateLimit): string {
	if (limit.kind === "consent") return "waits for a usage-credit confirm in its terminal";
	if (limit.kind === "unknown") return "failed its turn";
	if (TRANSIENT.has(limit.kind)) return `hit ${limit.kind.replace("_", " ")}${limit.next === undefined ? "" : `, retry ${(limit.tries ?? 0) + 1} at ${clock(limit.next)}`}`;
	return `hit its ${LIMIT_NAMES[limit.kind as LimitKind]} limit${limit.reset === undefined ? "" : `, ${untilText(limit.reset, limit.at)}`}`;
}

/** A limit as replies and the Team block name it. */
const LIMIT_NAMES: Record<LimitKind, string> = { session: "session", weekly: "weekly", opus: "Opus", sonnet: "Sonnet" };

/** The asked requests `ids` given `outcome`, once: an outcome is never rewritten. */
function settle(asked: readonly Asked[], ids: readonly string[], outcome: NonNullable<Asked["outcome"]>): Asked[] {
	return asked.map((each) => (ids.includes(each.id) && each.outcome === undefined ? { ...each, outcome } : each));
}

/** The usage state with one more reading folded in. */
function withReading(usage: UsageState | undefined, reading: UsageReading): UsageState {
	const before = usage ?? { latest: reading, first: {}, rateLimits: false, statusLines: {}, spend: {} };
	const latest = before.latest;
	const fresher = usage === undefined || (reading.rateLimits ? !latest.rateLimits || reading.at >= latest.at : !latest.rateLimits && reading.at >= latest.at);
	const next: UsageState = {
		...before,
		latest: fresher ? reading : latest,
		first: { fiveHour: before.first.fiveHour ?? reading.fiveHour, sevenDay: before.first.sevenDay ?? reading.sevenDay },
		rateLimits: before.rateLimits || reading.rateLimits,
	};
	if (next.first.fiveHour === undefined) delete next.first.fiveHour;
	if (next.first.sevenDay === undefined) delete next.first.sevenDay;
	const teammate = reading.teammate;
	if (reading.source !== "status-line" || teammate === undefined) return next;
	next.statusLines = { ...before.statusLines, [teammate]: { at: reading.at, ...(reading.ctx === undefined ? {} : { ctx: reading.ctx }) } };
	if (reading.sessionId !== undefined && (reading.tokens !== undefined || reading.costUsd !== undefined)) {
		const sessions = before.spend[teammate] ?? {};
		const was = sessions[reading.sessionId] ?? { tokens: 0, costUsd: 0, banked: { tokens: 0, costUsd: 0 } };
		const tokens = reading.tokens ?? was.tokens;
		const costUsd = reading.costUsd ?? was.costUsd;
		// A figure that drops was reset, so what it had reached was spent too.
		const banked = { tokens: was.banked.tokens + (tokens < was.tokens ? was.tokens : 0), costUsd: was.banked.costUsd + (costUsd < was.costUsd ? was.costUsd : 0) };
		next.spend = { ...before.spend, [teammate]: { ...sessions, [reading.sessionId]: { tokens, costUsd, banked } } };
	}
	return next;
}

/** Whether a Teammate's status line was read under a minute before `now`, in ms: then `get_usage` isn't needed. */
export function freshStatusLine(state: EffortState, now: number): boolean {
	return Object.values(state.usage?.statusLines ?? {}).some((each) => now - Date.parse(each.at) < USAGE_FRESH_MS);
}

/** A status line younger than this is fresh; `get_usage` is asked at most this often. */
export const USAGE_FRESH_MS = 60_000;

/**
 * Take a usage reading. A status line no newer than the last one read of its
 * Teammate adds nothing, so the same file read twice is kept once.
 */
function usage(state: EffortState, input: Extract<EffortInput, { kind: "usage" }>): Step {
	const { reading } = input;
	if (reading.source === "status-line") {
		const last = reading.teammate === undefined ? undefined : state.usage?.statusLines[reading.teammate];
		if (reading.teammate === undefined || (last !== undefined && reading.at <= last.at)) return took(state, [], []);
	}
	return took(state, [{ type: "usage-read", ...reading }], []);
}

/** The state with handed-off Task `slug` changed by `change`. */
function withTask(state: EffortState, slug: string, change: Partial<HandedTask>): EffortState {
	const task = state.tasks[slug];
	return task ? { ...state, tasks: { ...state.tasks, [slug]: { ...task, ...change } } } : state;
}

/** The state with Task `slug`'s merge no longer under way, whether it went in or failed. */
function merged(state: EffortState, slug: string): EffortState {
	const task = state.tasks[slug];
	if (task?.merging === undefined) return state;
	const { merging: _merging, ...rest } = task;
	return { ...state, tasks: { ...state.tasks, [slug]: rest } };
}

/** The state with `line.teammate` changed by `change`, its cursor moved to the line's. */
function withTeammate(state: EffortState, line: { teammate: string; cursor: number }, change: Partial<Teammate>): EffortState {
	return {
		...state,
		teammates: state.teammates.map((teammate) => (teammate.id === line.teammate ? { ...teammate, ...change, cursor: line.cursor } : teammate)),
	};
}

/** The state with `teammate`'s Takeover changed by `change`; a Teammate nobody holds is left alone. */
function withTakeover(state: EffortState, teammate: string, change: (takeover: Takeover) => Takeover): EffortState {
	return { ...state, teammates: state.teammates.map((each) => (each.id === teammate && each.takeover ? { ...each, takeover: change(each.takeover) } : each)) };
}

function withoutTakeover(teammate: Teammate): Teammate {
	const { takeover: _takeover, denied: _denied, ...rest } = teammate;
	return rest;
}

/** The state with request `request` moved to `to`. */
function withRequest(state: EffortState, request: string, to: HeldRequest["state"]): EffortState {
	const held = state.teammateRequests[request];
	return held ? { ...state, teammateRequests: { ...state.teammateRequests, [request]: { ...held, state: to } } } : state;
}

/** The state with `teammate`'s open requests ended: its turn ended, so none waits any more. */
function endRequests(state: EffortState, teammate: string): EffortState {
	const open = Object.values(state.teammateRequests).filter((held) => held.teammate === teammate && (held.state === "held" || held.state === "expired"));
	return open.reduce((changed, held) => withRequest(changed, held.request, "ended"), state);
}

/** The requests only the human can answer now, in a Teammate's terminal, oldest first. */
export function waitingInTerminal(state: EffortState): HeldRequest[] {
	return Object.values(state.teammateRequests).filter((held) => held.state === "expired");
}

/** The usage-credit confirm waiting in a Teammate's terminal, which only the human answers there; undefined when none waits. */
export function waitingConfirm(state: EffortState): (ModelHold & { teammate: string }) | undefined {
	const hold = state.holds?.[CONSENT_FAMILY];
	return hold?.kind === "consent" && hold.teammate !== undefined ? { ...hold, teammate: hold.teammate } : undefined;
}

/** The state an Effort's lines fold to. The first line must open the Effort. */
export function fold(lines: readonly EffortLine[]): EffortState {
	const [first, ...rest] = lines;
	if (first?.type !== "effort-opened") {
		throw new Error(`effort.jsonl must start with an \`effort-opened\` line, not ${first ? `\`${first.type}\`` : "nothing"}`);
	}
	const { type: _type, at: _at, ...opened } = first;
	return rest.reduce(apply, { ...opened, pending: [], requests: 0, tasks: {}, teammates: [], queue: [], reports: 0, sinceReport: [], decided: [], found: [], teammateRequests: {} });
}

/** Take one input: the lines it appends and what the shell must do, or why it is refused. */
export function step(state: EffortState, input: EffortInput): Step {
	const result = stepOnce(state, input);
	if (result.ok && result.append.some(freesRoom)) return { ...result, actions: [...result.actions, { kind: "start-queued" }] };
	return result;
}

/** A line after which a queued Task may start: a usage pause or a model hold lifted, or a Teammate crashed, freeing room under the cap. */
function freesRoom(line: EffortLine): boolean {
	return (line.type === "resumed" && line.by === "usage") || line.type === "model-released" || line.type === "teammate-crashed";
}

function stepOnce(state: EffortState, input: EffortInput): Step {
	if (state.ended) {
		// A Teammate's last journal lines can still arrive after the end; there is nothing left for them to change.
		if (input.kind === "journal") return took(state, [], []);
		return { ok: false, refusal: endedText(state, state.ended) };
	}
	switch (input.kind) {
		case "request-sign-off":
			return requestSignOff(state, input);
		case "cancel":
			return took(state, ending(state, "cancelled", input.at), [...stops(state), { kind: "end-effort", how: "cancelled" }], `Cancelled Effort \`${state.effortId}\` without sign-off: every Teammate is stopped.`);
		case "start-teammate": {
			const refusal = beforeBrief(state, input.tool);
			if (refusal !== undefined) return { ok: false, refusal };
			return { ok: true, state, append: [], actions: [] };
		}
		case "plan":
			return plan(state, input);
		case "handoff":
			return handoff(state, input);
		case "request-approval":
			return requestApproval(state, input);
		case "answer":
			return answer(state, input);
		case "journal":
			return journal(state, input);
		case "review":
			return review(state, input);
		case "merge-result":
			return mergeResult(state, input);
		case "drain":
			return drain(state, input);
		case "report":
			return report(state, input);
		case "attach":
			return attach(state, input);
		case "pause":
			return pause(state, input);
		case "resume":
			return resume(state, input);
		case "usage":
			return usage(state, input);
		case "answer-request":
			return answerRequest(state, input);
		case "escalate":
			return escalate(state, input);
		case "answer-escalation":
			return answerEscalation(state, input);
		case "send":
			return send(state, input);
		case "tick":
			return tick(state, input);
		case "answer-usage":
			return answerUsage(state, input);
		case "recover":
			return recover(state, input);
		case "reconcile":
			return reconcile(state, input);
		case "handback":
			return handBackInPi(state, input);
	}
}

/** The pauses that hold, the human's first, then the Lead's, then the usage pause. The Effort runs only when there are none. */
export function heldPauses(state: EffortState): Pause[] {
	return SETTERS.flatMap((by) => state.pauses?.[by] ?? []);
}

/** Who set a pause, as a reply to someone else names them. */
const SETTER_NAMES: Record<PauseSetter, string> = { human: "the human", lead: "the Lead", usage: "a usage limit" };

/** A pause, as a reply names it: who set it, since when, and why. */
function pauseText(pause: Pause): string {
	return `paused by ${SETTER_NAMES[pause.by]} since ${clock(pause.at)} UTC${pause.reason === undefined ? "" : `: ${pause.reason}`}${pause.reset === undefined ? "" : `, ${untilText(pause.reset, pause.at)}`}`;
}

/** Who lifts a pause and how. */
function lifter(pause: Pause): string {
	if (pause.by === "human") return "only the human lifts it, with `/team resume`";
	if (pause.by === "lead") return "only the Lead lifts it, with `team_resume`";
	return "it lifts at its reset";
}

/** When a limit lifts, as replies and the Team block name it: `until 15:45 UTC`, with the date when it isn't the day of `from`. */
export function untilText(reset: string, from: string): string {
	const day = reset.slice(0, 10) === from.slice(0, 10) ? "" : `${reset.slice(0, 10)} `;
	return `until ${day}${clock(reset)} UTC`;
}

/** The hold on `role`'s model family, when one holds it. */
export function holdOn(state: EffortState, role: string): ModelHold | undefined {
	return Object.values(state.holds ?? {}).find((hold) => hold?.roles.includes(role));
}

/** A hold, as a reply names it: `an Opus limit until 15:45 UTC`. */
export function holdText(hold: ModelHold): string {
	if (hold.kind === "consent") return `a usage-credit confirm waiting in ${hold.teammate ?? "a Teammate"}'s terminal, which only the human answers`;
	return `${hold.kind === "opus" ? "an Opus" : "a Sonnet"} limit${hold.reset === undefined ? "" : ` ${untilText(hold.reset, hold.at)}`}`;
}

/** Why Task `slug` waits on a Brief change the human hasn't approved, when one holds it. */
function briefHeld(state: EffortState, slug: string): string | undefined {
	return state.briefHold?.slugs.includes(slug) ? `held: Brief change ${state.briefHold.request}` : undefined;
}

/** Why a Task of a held Role waits. */
function heldWhy(hold: ModelHold): string {
	return `held: ${hold.kind === "consent" ? "usage-credit confirm" : `${LIMIT_NAMES[hold.kind]} limit`}${hold.reset === undefined ? "" : ` ${untilText(hold.reset, hold.at)}`}`;
}

/** A usage item, as `/team pending` and the Report name it. */
export function usageText(item: UsageItem, teammates: readonly Teammate[] = []): string {
	if (item.why === "far-reset") {
		if (item.reset === undefined) return `the usage pause on a ${item.kind} limit has held for more than a day, and Claude Code didn't say when it lifts: stay paused, or cancel the Effort`;
		return `the usage pause on a ${item.kind} limit lifts ${untilText(item.reset, item.at).replace(/^until /, "at ")}, more than a day away: stay paused, or cancel the Effort`;
	}
	const task = teammates.find((each) => each.id === item.teammate)?.task;
	return `${item.teammate ?? "a Teammate"} still fails with ${item.kind.replace("_", " ")} after ${RETRY_MS.length} retries${task === undefined ? "" : ` on Task \`${task}\``}: retry again, or leave it to the Lead`;
}

/** Set the human's or the Lead's pause: no new Task starts while it holds, and running Teammates finish their Task. */
function pause(state: EffortState, input: Extract<EffortInput, { kind: "pause" }>): Step {
	const held = state.pauses?.[input.by];
	if (held) {
		return { ok: false, refusal: `Effort \`${state.effortId}\` is already paused by you since ${clock(held.at)} UTC${held.reason === undefined ? "" : `: ${held.reason}`}.` };
	}
	const reason = input.reason?.trim();
	if (input.by === "lead" && !reason) return { ok: false, refusal: "`team_pause` needs a `reason`: say in a sentence why the Team should hold, for the human to read in the Team block." };
	const others = heldPauses(state);
	return took(
		state,
		[{ type: "paused", by: input.by, ...(reason ? { reason } : {}), at: input.at }],
		[],
		`Effort \`${state.effortId}\` is paused: no new Task starts and handoffs queue, while running Teammates finish their Task.${others.length > 0 ? ` It was already ${others.map(pauseText).join(", and ")}.` : ""}`,
	);
}

/** Lift the setter's own pause, never another's. */
function resume(state: EffortState, input: Extract<EffortInput, { kind: "resume" }>): Step {
	if (!state.pauses?.[input.by]) {
		const others = heldPauses(state);
		return {
			ok: false,
			refusal:
				others.length === 0
					? `Effort \`${state.effortId}\` isn't paused by you, so there is nothing to resume.`
					: `Effort \`${state.effortId}\` isn't paused by you, so there is nothing for you to resume. It is ${others.map((each) => `${pauseText(each)}; ${lifter(each)}`).join(", and ")}.`,
		};
	}
	const lifted: EffortLine = { type: "resumed", by: input.by, at: input.at };
	const still = heldPauses(apply(state, lifted));
	return took(
		state,
		[lifted],
		[],
		still.length === 0
			? `Effort \`${state.effortId}\` runs again: queued Tasks start through the staffing ladder.`
			: `Lifted your pause, but Effort \`${state.effortId}\` is still ${still.map(pauseText).join(", and ")}, so nothing new starts yet.`,
	);
}

/**
 * The Lead's `team_answer` of a held request, taken only while its hook holds
 * it: the first answer wins. The answer, any rule and any grant it used join
 * the decided-for-you log with the request's Task.
 */
function answerRequest(state: EffortState, input: Extract<EffortInput, { kind: "answer-request" }>): Step {
	// An escalated item is the human's to answer: the Lead only relays what they said in chat.
	const escalation = state.escalations?.[input.request];
	if (escalation) return answerEscalated(state, escalation, input, "lead");
	const held = state.teammateRequests[input.request];
	if (!held) return { ok: false, refusal: noRequestText(state, input.request) };
	if (held.state !== "held") return { ok: false, refusal: closedText(held) };
	if (underTakeover(state, held.teammate)) {
		return { ok: false, refusal: `The human has taken \`${held.teammate}\` over, so its permission prompts are theirs to answer in its terminal; you're woken when they hand it back.` };
	}
	const taken = takeAnswer(held, input);
	if (typeof taken === "string") return { ok: false, refusal: taken };
	const task = held.task === undefined ? {} : { task: held.task };
	return took(
		state,
		[
			{ type: "request-answered", teammate: held.teammate, request: held.request, ...task, decision: taken.decision, ...(taken.rule === undefined ? {} : { rule: taken.rule }), at: input.at },
			...taken.logged.map((what): EffortLine => ({ type: "decided-for-you", what, ...task, at: input.at })),
		],
		[{ kind: "answer-hook", request: held.request, teammate: held.teammate, decision: taken.decision }],
		`Answered \`${held.request}\`: ${held.teammate}'s hook has your ${taken.decision.behavior}, and the next Report logs it.`,
	);
}

/** The escalated items the human can still answer, oldest first: a held request still held, or a prose question whose Teammate is still on. */
export function openEscalations(state: EffortState): Escalation[] {
	return Object.values(state.escalations ?? {}).filter((escalation) => {
		if (escalation.answered) return false;
		if (escalation.kind === "prose") return !state.teammates.find((each) => each.id === escalation.teammate)?.ended;
		return state.teammateRequests[escalation.id]?.state === "held";
	});
}

/** How an escalated item reads to the human: `dev-1's \`Bash\` prompt on Task \`rename\``. */
export function escalationText(escalation: Escalation, state: EffortState, withTask = true): string {
	const held = state.teammateRequests[escalation.id];
	const what = escalation.kind === "prose" || !held ? "question" : requestKind(held);
	return `${escalation.teammate}'s ${what}${!withTask || escalation.task === undefined ? "" : ` on Task \`${escalation.task}\``}`;
}

/** Why no Teammate `id` can be messaged or asked about, or the Teammate. */
function teammateOf(state: EffortState, id: string): Teammate | string {
	const teammate = state.teammates.find((each) => each.id === id);
	if (teammate) return teammate;
	const known = state.teammates.map((each) => each.id);
	return `Effort \`${state.effortId}\` has no Teammate \`${id}\`: ${known.length === 0 ? "it has no Teammates yet" : `its Teammates are ${quoted(known)}`}.`;
}

function noRequestText(state: EffortState, request: string): string {
	const open = Object.values(state.teammateRequests).filter((each) => each.state === "held").map((each) => each.request);
	return `No request \`${request}\` waits on you: ${open.length === 0 ? "no request is held right now" : `the requests held now are ${quoted(open)}`}.`;
}

/**
 * `team_escalate`: move a held request, or a stopped-short Teammate's prose
 * question, to the human's pending items with the Lead's summary. Only the
 * Task that asked waits on it; the rest of the Effort goes on.
 */
function escalate(state: EffortState, input: Extract<EffortInput, { kind: "escalate" }>): Step {
	if ((input.request === undefined) === (input.teammate === undefined)) {
		return { ok: false, refusal: "Escalate either a held `request` by its id, or a stopped-short `teammate` with its `question`; not both, and not neither." };
	}
	const summary = input.summary.trim();
	if (summary === "") return { ok: false, refusal: "An escalation needs a `summary` for the human: what is asked, and why the Brief doesn't settle it." };
	const brief = input.brief?.trim() ? { brief: input.brief.trim() } : {};
	if (input.request !== undefined) {
		const held = state.teammateRequests[input.request];
		if (!held) return { ok: false, refusal: noRequestText(state, input.request) };
		if (state.escalations?.[held.request]) return { ok: false, refusal: `Request \`${held.request}\` is already escalated: it waits on the human in \`/team pending\`.` };
		if (held.state !== "held") return { ok: false, refusal: closedText(held) };
		const kind = isQuestion(held) ? "question" : "permission";
		const task = held.task === undefined ? {} : { task: held.task };
		const line: EffortLine = { type: "escalated", id: held.request, teammate: held.teammate, ...task, kind, question: askedText(held), summary, ...brief, at: input.at };
		const after =
			kind === "question"
				? "If the human answers it to you in chat instead, pass their answer on with `team_answer`: it goes to clarifications.md as theirs."
				: "Only the human's answer in `/team pending` counts for it, so don't answer it yourself.";
		return took(state, [line], [], `Escalated \`${held.request}\` to the human's \`/team pending\`, with your summary. ${waitsText(held.task)} ${after}`);
	}
	const teammate = teammateOf(state, input.teammate ?? "");
	if (typeof teammate === "string") return { ok: false, refusal: teammate };
	if (teammate.ended) return { ok: false, refusal: `Teammate \`${teammate.id}\` has ended, so there is nobody to take the human's answer.` };
	if (teammate.doing !== "stopped short") {
		return { ok: false, refusal: `Teammate \`${teammate.id}\` hasn't stopped short on a question: escalate a prose question only from a Teammate whose turn stopped short asking one; a held request is escalated by its \`request\` id.` };
	}
	const question = input.question?.trim() ?? "";
	if (question === "") return { ok: false, refusal: `Escalating ${teammate.id}'s prose question needs the \`question\`, as its last message asked it.` };
	const open = openEscalations(state).find((each) => each.kind === "prose" && each.teammate === teammate.id);
	if (open) return { ok: false, refusal: `${teammate.id}'s question \`${open.id}\` already waits on the human: one prose question per Teammate at a time.` };
	const id = `q${Object.values(state.escalations ?? {}).filter((each) => each.kind === "prose").length + 1}`;
	const line: EffortLine = { type: "escalated", id, teammate: teammate.id, task: teammate.task, kind: "prose", question, summary, ...brief, at: input.at };
	return took(
		state,
		[line],
		[],
		`Escalated ${teammate.id}'s question to the human's \`/team pending\` as \`${id}\`, with your summary. ${waitsText(teammate.task)} If the human answers it to you in chat instead, pass their words on with \`team_answer\` and \`text\`.`,
	);
}

function waitsText(task: string | undefined): string {
	return `${task === undefined ? "Only the Teammate that asked" : `Only Task \`${task}\``} waits on it; the rest of the Effort goes on.`;
}

/** The human's answer to an escalated item, in `/team pending`. */
function answerEscalation(state: EffortState, input: Extract<EffortInput, { kind: "answer-escalation" }>): Step {
	const escalation = state.escalations?.[input.id];
	if (!escalation) {
		const open = openEscalations(state).map((each) => each.id);
		return { ok: false, refusal: `No escalated item \`${input.id}\` waits on the human: ${open.length === 0 ? "nothing is escalated right now" : `the escalated items now are ${quoted(open)}`}.` };
	}
	const { id: _id, kind: _kind, at, ...answer } = input;
	return answerEscalated(state, escalation, { ...answer, at }, "pending");
}

/**
 * The human's answer to `escalation`: given in `/team pending`, or in chat and
 * relayed by the Lead with `team_answer`. A permission takes only the former.
 * A question's answer goes to clarifications.md, as part of the Brief.
 */
function answerEscalated(state: EffortState, escalation: Escalation, input: Omit<RequestAnswer, "request"> & { at: string }, via: "pending" | "lead"): Step {
	const about = `\`${escalation.id}\``;
	if (escalation.answered) return { ok: false, refusal: `${about} is already answered: the human answered it at ${clock(escalation.answered.at)}.` };
	if (via === "lead" && escalation.kind === "permission") {
		return { ok: false, refusal: `${about} is escalated, so only the human can answer it, in \`/team pending\`; an escalated permission takes no answer relayed from chat.` };
	}
	const what = escalationText(escalation, state);
	const task = escalation.task === undefined ? {} : { task: escalation.task };
	const clarification = (answer: string): EffortAction => ({
		kind: "append-clarification",
		entry: { id: escalation.id, teammate: escalation.teammate, ...task, question: escalation.question, summary: escalation.summary, ...(escalation.brief === undefined ? {} : { brief: escalation.brief }), answer, via, at: input.at },
	});
	const wake = (text: string): EffortAction[] => (via === "pending" ? [{ kind: "wake-lead", text }] : []);
	const noted = "it is in clarifications.md, next to brief.md, and counts as part of the Brief";
	if (escalation.kind === "prose") {
		const text = input.text?.trim() ?? "";
		if (input.decision !== undefined || input.answers !== undefined) return { ok: false, refusal: `${about} is a prose question: answer it with \`text\`, the human's own words.` };
		if (text === "") return { ok: false, refusal: `${about} needs an answer: the human's own words, as text.` };
		const teammate = state.teammates.find((each) => each.id === escalation.teammate);
		if (!teammate || teammate.ended || !teammate.inbox) return { ok: false, refusal: `${escalation.teammate} has ended, so nobody can take the answer to ${about}.` };
		const message = `The human answered your question (\`${escalation.id}\`): ${text}\n\nIt is in clarifications.md, next to brief.md, and counts as part of the Brief.${escalation.task === undefined ? "" : ` Go on with Task \`${escalation.task}\`.`}`;
		return took(
			state,
			[{ type: "escalation-answered", id: escalation.id, answer: text, via, at: input.at }],
			[clarification(text), { kind: "send-message", teammate: teammate.id, inbox: teammate.inbox, message }, ...wake(`The human answered \`${escalation.id}\` (${what}) in \`/team pending\`: ${text}. ${teammate.id} has it, and ${noted}.`)],
			`Sent the human's answer to \`${escalation.id}\` to ${teammate.id}; ${noted}.`,
		);
	}
	const held = state.teammateRequests[escalation.id];
	if (!held) return { ok: false, refusal: noRequestText(state, escalation.id) };
	if (held.state !== "held") return { ok: false, refusal: closedText(held) };
	// The Lead's floor and `escalate` checks are what bring a permission to the human, so the human's own allow passes them.
	const humanAllows = escalation.kind === "permission" && via === "pending" && input.decision === "allow" && input.answers === undefined;
	const taken: TakenAnswer | string = humanAllows
		? input.reason?.trim()
			? { decision: { behavior: "allow" }, logged: [] }
			: `An answer to \`${held.request}\` needs a reason.`
		: takeAnswer(held, { request: held.request, ...input });
	if (typeof taken === "string") return { ok: false, refusal: taken };
	const behavior = taken.decision.behavior;
	const reason = input.reason?.trim() ?? "";
	const answer = escalation.kind === "question" && behavior === "allow" && input.answers ? answersText(held, input.answers) : reason;
	const decision = escalation.kind === "permission" || behavior === "deny" ? { decision: behavior } : {};
	const lines: EffortLine[] = [
		{ type: "request-answered", teammate: held.teammate, request: held.request, ...task, decision: taken.decision, ...(taken.rule === undefined ? {} : { rule: taken.rule }), at: input.at },
		{ type: "escalation-answered", id: escalation.id, answer, ...decision, via, at: input.at },
	];
	const hook: EffortAction = { kind: "answer-hook", request: held.request, teammate: held.teammate, decision: taken.decision };
	if (escalation.kind === "permission") {
		const verb = behavior === "allow" ? "allowed" : "denied";
		return took(state, lines, [hook, ...wake(`The human ${verb} \`${escalation.id}\` (${what}) in \`/team pending\`: ${reason} ${held.teammate}'s hook has it.`)]);
	}
	const said = behavior === "deny" ? `declined it: ${reason}` : `answered it: ${answer}`;
	return took(
		state,
		lines,
		[hook, clarification(behavior === "deny" ? `declined: ${reason}` : answer), ...wake(`The human answered \`${escalation.id}\` (${what}) in \`/team pending\`: ${behavior === "deny" ? `declined: ${reason}` : answer}. ${held.teammate}'s hook has it, and ${noted}.`)],
		`Passed on the human's answer to \`${escalation.id}\`: they ${said}. ${held.teammate}'s hook has it, and ${noted}.`,
	);
}

/** Messages longer than this belong in a Task, not a send. */
const SEND_LIMIT = 2000;

/** `team_send`: a short prose message to a Teammate, as its next turn. */
function send(state: EffortState, input: Extract<EffortInput, { kind: "send" }>): Step {
	const teammate = teammateOf(state, input.teammate);
	if (typeof teammate === "string") return { ok: false, refusal: teammate };
	if (teammate.ended) return { ok: false, refusal: `Teammate \`${teammate.id}\` has ended (${teammate.ended.how}), so it takes no more messages.` };
	if (teammate.retiredAt !== undefined) return { ok: false, refusal: `Teammate \`${teammate.id}\` was stopped to make room under the cap, so it takes no more messages.` };
	if (!teammate.inbox) return { ok: false, refusal: `Teammate \`${teammate.id}\` has no session yet, so there is nowhere to send to; wait for it to start.` };
	const message = input.message.trim();
	if (message === "") return { ok: false, refusal: "The message is empty: say what the Teammate should know." };
	if (message.length > SEND_LIMIT) return { ok: false, refusal: `A message is at most ${SEND_LIMIT} characters, and this one is ${message.length}: put longer instructions in a Task.` };
	if (teammate.takeover) {
		return took(
			state,
			[{ type: "send-held", teammate: teammate.id, what: "message", message, at: input.at }],
			[],
			`The human has taken \`${teammate.id}\` over, so your message is held, and dropped when they hand it back. You're woken then.`,
		);
	}
	return took(
		state,
		[{ type: "message-sent", teammate: teammate.id, message, at: input.at }],
		[{ kind: "send-message", teammate: teammate.id, inbox: teammate.inbox, message }],
		`Sent ${teammate.id} your message; it reads it as its next turn.`,
	);
}

/** The human used the `/team` menu on a Teammate: its short id is recorded as the one last attached, once per change. */
function attach(state: EffortState, input: Extract<EffortInput, { kind: "attach" }>): Step {
	const teammate = state.teammates.find((each) => each.id === input.teammate);
	if (!teammate) return { ok: false, refusal: `Effort \`${state.effortId}\` has no Teammate \`${input.teammate}\` to attach to` };
	const { shortId } = teammate;
	if (shortId === undefined) return { ok: false, refusal: `Teammate \`${teammate.id}\` has no short id yet: its session hasn't started, so there is nothing to attach to` };
	if (teammate.attached === shortId && !teammate.newShortId) return took(state, [], []);
	return took(state, [{ type: "teammate-attached", teammate: teammate.id, shortId, at: input.at }], []);
}

/** Take the step that `lines` make, checking it folds: the state is only ever what the lines fold to. */
function took(state: EffortState, append: EffortLine[], actions: EffortAction[], reply?: string): Step {
	return { ok: true, state: append.reduce(apply, state), append, actions, ...(reply === undefined ? {} : { reply }) };
}

/**
 * Why a request at `checkpoint` can't be taken now, or undefined when it can.
 * The shell asks this before it reads the draft, so a request that would be
 * refused anyway is refused for the reason that matters.
 */
export function refuseRequest(state: EffortState, checkpoint: string, asked: { affects?: readonly string[]; checkpoints?: readonly string[] } = {}): string | undefined {
	if (state.ended) return endedText(state, state.ended);
	if (checkpoint === SIGN_OFF || checkpoint === PLAYBOOK_CHANGE) {
		return `Sign-off of Effort \`${state.effortId}\` comes from the final Report: write it with \`team_report\` and \`final: true\`, which asks for sign-off and offers each proposed Playbook change.`;
	}
	if (asked.affects !== undefined && checkpoint !== BRIEF_CHANGE) {
		return `\`affects\` names the Tasks a Brief change holds, so it goes only with checkpoint \`${BRIEF_CHANGE}\`, not \`${checkpoint}\`.`;
	}
	if (checkpoint === BRIEF) {
		if (state.brief) {
			return `The Brief of Effort \`${state.effortId}\` is already approved (sha256 ${state.brief.sha256}, ${state.brief.approvedAt}), and an approved Brief is never edited; ask for a Brief change at checkpoint \`${BRIEF_CHANGE}\` instead.`;
		}
		return undefined;
	}
	if (!state.brief) {
		return `Effort \`${state.effortId}\` has no checkpoint \`${checkpoint}\` open; the one checkpoint before Teammates start is \`${BRIEF}\`.`;
	}
	if (checkpoint === BRIEF_CHANGE) {
		const planned = state.plan?.map((task) => task.slug) ?? [];
		if (asked.affects === undefined) {
			return `A Brief change needs \`affects\`: the slugs of the planned Tasks it holds until the human answers (${planned.length > 0 ? `the planned ones are ${quoted(planned)}` : "nothing is planned yet"}), or \`[]\` when it holds none.`;
		}
		const unknown = asked.affects.filter((slug) => !planned.includes(slug));
		if (unknown.length > 0) {
			return `A Brief change holds only planned Tasks, and Effort \`${state.effortId}\` has no planned ${quoted(unknown)}; ${planned.length > 0 ? `the planned ones are ${quoted(planned)}` : "nothing is planned yet"}.`;
		}
		return undefined;
	}
	if (asked.checkpoints?.includes(checkpoint)) return undefined;
	const open = [BRIEF_CHANGE, ...(asked.checkpoints ?? [])];
	return `Effort \`${state.effortId}\` has no checkpoint \`${checkpoint}\`; the ones it asks at are ${quoted(open)}, and sign-off comes from the final Report.`;
}

/** What a request at `checkpoint` is called in replies and Reports. */
function requestName(item: Pick<PendingApproval, "checkpoint">): string {
	if (item.checkpoint === BRIEF) return "the Brief";
	if (item.checkpoint === BRIEF_CHANGE) return "a Brief change";
	return `checkpoint \`${item.checkpoint}\``;
}

function requestApproval(state: EffortState, input: Extract<EffortInput, { kind: "request-approval" }>): Step {
	const refusal = refuseRequest(state, input.checkpoint, input);
	if (refusal !== undefined) return { ok: false, refusal };
	const replaced = state.pending.find((item) => item.checkpoint === input.checkpoint);
	const id = `r${state.requests + 1}`;
	const { kind: _kind, checkpoints: _checkpoints, affects, ...asked } = input;
	const line: EffortLine = { type: "approval-requested", id, ...asked, ...(input.checkpoint === BRIEF_CHANGE ? { affects: [...(affects ?? [])] } : {}) };
	const holds = affects ?? [];
	const reply = [
		input.checkpoint === BRIEF
			? `Asked the human to approve the Brief of Effort \`${state.effortId}\` as request \`${id}\`: ${input.path} (sha256 ${input.sha256}).`
			: `Asked the human to approve ${requestName(input)} of Effort \`${state.effortId}\` as request \`${id}\`: ${input.path} (sha256 ${input.sha256}).`,
		replaced ? `It replaces request \`${replaced.id}\`, which the human hadn't answered.` : undefined,
		input.checkpoint === BRIEF_CHANGE
			? holds.length > 0
				? `It holds Task${holds.length === 1 ? "" : "s"} ${quoted(holds)} until they answer: a handoff queues, a queued one waits and a review waits, while every other Task goes on.`
				: "It holds no Task, so every Task goes on."
			: undefined,
		input.checkpoint === BRIEF
			? "They answer it in `/team pending`; approving promotes exactly this snapshot, so later edits to the draft don't count. Stop here and wait for their answer."
			: "They answer it in `/team pending`; approving approves exactly this snapshot, so later edits to the draft don't count. Go on with what it doesn't hold, and wait for their answer before what it does.",
	]
		.filter((part) => part !== undefined)
		.join(" ");
	return took(state, [line], [], reply);
}

function answer(state: EffortState, input: Extract<EffortInput, { kind: "answer" }>): Step {
	const item = state.pending.find((pending) => pending.id === input.id);
	if (!item) {
		const open = state.pending.map((pending) => `\`${pending.id}\``).join(", ");
		return {
			ok: false,
			refusal: `Effort \`${state.effortId}\` has no pending request \`${input.id}\`; ${open ? `the pending ones are ${open}` : "nothing is pending"}.`,
		};
	}
	if (item.checkpoint === PLAYBOOK_CHANGE) {
		if (input.answer === "sent-back") return { ok: false, refusal: `Request \`${item.id}\` is Playbook change \`${item.change?.id}\`, which is adopted or declined, not sent back.` };
	} else if (input.answer === "declined") {
		return { ok: false, refusal: `Only a Playbook change is declined; request \`${item.id}\` is approved or sent back.` };
	}
	if (item.checkpoint === SIGN_OFF) return answerSignOff(state, item, input);
	if (item.checkpoint === PLAYBOOK_CHANGE && item.change !== undefined) {
		const line: EffortLine = { type: "approval-answered", id: item.id, answer: input.answer, at: input.at };
		const change = item.change;
		return input.answer === "approved"
			? took(state, [line], [{ kind: "adopt-playbook-change", approval: { ...item, change }, at: input.at }], `Adopted Playbook change \`${change.id}\` for the next Effort.`)
			: took(state, [line], [], `Declined Playbook change \`${change.id}\`.`);
	}
	if (item.checkpoint === BRIEF_CHANGE) return answerBriefChange(state, item, input);
	if (item.checkpoint !== BRIEF) return answerCheckpoint(state, item, input);
	const line: EffortLine = {
		type: "approval-answered",
		id: input.id,
		answer: input.answer,
		...(input.note === undefined ? {} : { note: input.note }),
		...(input.answer === "approved" && input.workspace !== undefined ? { workspace: input.workspace } : {}),
		at: input.at,
	};
	if (input.answer === "approved") {
		return took(state, [line], [
			{ kind: "promote-brief", approval: item, at: input.at },
			{
				kind: "wake-lead",
				text: [
					`The human approved the Brief of Effort \`${state.effortId}\` (request \`${item.id}\`, sha256 ${item.sha256}). It is now brief.md in the Effort's directory and is never edited.`,
					input.workspace
						? `The Workspace is ${input.workspace.path}, on branch \`${input.workspace.branch}\` cut from \`${input.workspace.from}\` at ${input.workspace.base}.`
						: undefined,
					"Plan the Tasks with `team_plan`, then write the plan Report with `team_report` before handing any off.",
				]
					.filter((part) => part !== undefined)
					.join(" "),
			},
		]);
	}
	return took(state, [line], [
		{
			kind: "wake-lead",
			text: `The human sent back the Brief of Effort \`${state.effortId}\` (request \`${item.id}\`) with this note:\n\n${input.note ?? ""}\n\nRevise ${item.path} with them, then ask again with \`team_request_approval\` at checkpoint \`${BRIEF}\`.`,
		},
	]);
}

/**
 * A Brief change. Approving it makes the snapshot the Brief, releases the
 * Tasks it held, and marks each live Teammate of a Role in `refresh` (whose
 * launch options it changed) for a fresh session at its next Task boundary.
 * When `terms` says the change alters what the Lead answers under (grants,
 * Delivery, skipped escalates), each other live Teammate holding session rules
 * the Lead added gets the same fresh start, so no rule outlives its terms.
 * A send-back wakes the Lead with the note and keeps the Tasks held, since
 * the change they wait on is still unsettled.
 */
function answerBriefChange(state: EffortState, item: PendingApproval, input: Extract<EffortInput, { kind: "answer" }>): Step {
	const holds = item.affects ?? [];
	const refresh = input.answer === "approved" ? (input.refresh ?? []) : [];
	const renew =
		input.answer === "approved" && input.terms
			? live(state)
					.filter((teammate) => !refresh.includes(teammate.role) && (teammate.rules?.length ?? 0) > 0)
					.map((teammate) => teammate.id)
			: [];
	const line: EffortLine = {
		type: "approval-answered",
		id: item.id,
		answer: input.answer,
		...(input.note === undefined ? {} : { note: input.note }),
		...(refresh.length > 0 ? { refresh: [...refresh] } : {}),
		...(renew.length > 0 ? { renew } : {}),
		at: input.at,
	};
	const tasks = holds.length === 0 ? undefined : `Task${holds.length === 1 ? "" : "s"} ${quoted(holds)}`;
	const one = holds.length === 1;
	if (input.answer === "approved") {
		const renewed = live(state).filter((teammate) => refresh.includes(teammate.role)).map((teammate) => teammate.id);
		const fresh =
			refresh.length === 0
				? undefined
				: `The launch options of Role${refresh.length === 1 ? "" : "s"} ${quoted(refresh)} changed, so ${
						renewed.length === 0
							? "their next Teammates start with the new ones"
							: `${quoted(renewed)} ${renewed.length === 1 ? "starts" : "each start"} in a fresh session at its next Task, never mid-Task, keeping ${renewed.length === 1 ? "its" : "their"} id`
					}.`;
		const ruled =
			renew.length === 0
				? undefined
				: `${quoted(renew)} ${renew.length === 1 ? "holds" : "hold"} session rules you added under the old terms, so ${renew.length === 1 ? "it starts" : "each starts"} in a fresh session at its next Task, never mid-Task, keeping ${renew.length === 1 ? "its" : "their"} id.`;
		return took(state, [line], [
			{ kind: "promote-brief-change", approval: item, at: input.at },
			{
				kind: "wake-lead",
				text: [
					`The human approved the Brief change of Effort \`${state.effortId}\` (request \`${item.id}\`, sha256 ${item.sha256}). It is now brief.md in the Effort's directory.`,
					tasks ? `${tasks} ${one ? "is" : "are"} released: a queued one starts by itself.` : undefined,
					fresh,
					ruled,
				]
					.filter((part) => part !== undefined)
					.join(" "),
			},
		]);
	}
	return took(state, [line], [
		{
			kind: "wake-lead",
			text: [
				`The human sent back the Brief change of Effort \`${state.effortId}\` (request \`${item.id}\`) with this note:\n\n${input.note ?? ""}\n`,
				tasks ? `${tasks} ${one ? "stays" : "stay"} held until a Brief change is approved; every other Task goes on.` : undefined,
				`Revise ${item.path} with them, then ask again with \`team_request_approval\` at checkpoint \`${BRIEF_CHANGE}\`.`,
			]
				.filter((part) => part !== undefined)
				.join(" "),
		},
	]);
}

/**
 * An approval at one of the Playbook's checkpoints or \`escalate\` ids. It
 * holds nothing; approving records the file with its sha, and either answer
 * wakes the Lead.
 */
function answerCheckpoint(state: EffortState, item: PendingApproval, input: Extract<EffortInput, { kind: "answer" }>): Step {
	const line: EffortLine = { type: "approval-answered", id: item.id, answer: input.answer, ...(input.note === undefined ? {} : { note: input.note }), at: input.at };
	if (input.answer === "approved") {
		return took(state, [line], [
			{ kind: "record-checkpoint", approval: item, at: input.at },
			{ kind: "wake-lead", text: `The human approved checkpoint \`${item.checkpoint}\` of Effort \`${state.effortId}\` (request \`${item.id}\`): ${item.path}, sha256 ${item.sha256}.` },
		]);
	}
	return took(state, [line], [
		{
			kind: "wake-lead",
			text: `The human sent back checkpoint \`${item.checkpoint}\` of Effort \`${state.effortId}\` (request \`${item.id}\`, ${item.path}) with this note:\n\n${input.note ?? ""}\n\nWork it in, then ask again with \`team_request_approval\` at checkpoint \`${item.checkpoint}\`.`,
		},
	]);
}

/**
 * Sign-off of the final Report. Approving it ends the Effort: every live
 * Teammate is stopped, which keeps its conversation, and nothing more is
 * taken. It waits until each proposed Playbook change is answered, since the
 * end drops whatever is still pending. A send-back wakes the Lead with the
 * note and leaves the Teammates running.
 */
function answerSignOff(state: EffortState, item: PendingApproval, input: Extract<EffortInput, { kind: "answer" }>): Step {
	const line: EffortLine = { type: "approval-answered", id: item.id, answer: input.answer, ...(input.note === undefined ? {} : { note: input.note }), at: input.at };
	if (input.answer === "sent-back") {
		const dropped = state.pending.filter((each) => each.checkpoint === PLAYBOOK_CHANGE);
		return took(state, [line], [
			{
				kind: "wake-lead",
				text: [
					`The human sent back the final Report of Effort \`${state.effortId}\` (request \`${item.id}\`) with this note:\n\n${input.note ?? ""}\n\nThe Teammates are still running.`,
					dropped.length > 0 ? `The Playbook changes it proposed (${quoted(dropped.map((each) => each.change?.id ?? each.id))}) are dropped; propose them again in the next final Report if they still apply.` : undefined,
					"Re-plan with `team_plan` if the work needs more Tasks, then write a new final Report with `team_report` and `final: true`, which asks for sign-off again.",
				]
					.filter((part) => part !== undefined)
					.join(" "),
			},
		]);
	}
	const unanswered = state.pending.filter((each) => each.checkpoint === PLAYBOOK_CHANGE);
	if (unanswered.length > 0) {
		return {
			ok: false,
			refusal: `Adopt or decline each proposed Playbook change before signing off Effort \`${state.effortId}\`: ${unanswered.map((each) => `\`${each.id}\` (\`${each.change?.id}\`)`).join(", ")} still wait${unanswered.length === 1 ? "s" : ""}.`,
		};
	}
	return took(
		state,
		[line, ...ending(state, "signed-off", input.at)],
		[{ kind: "record-sign-off", approval: item, at: input.at }, ...stops(state), { kind: "end-effort", how: "signed-off" }],
		`Signed off Effort \`${state.effortId}\`: every Teammate is stopped.`,
	);
}

/** The lines that end the Effort: each live Teammate stopped, then the end itself. */
function ending(state: EffortState, how: Ended["how"], at: string): EffortLine[] {
	return [...live(state).map((teammate): EffortLine => ({ type: "teammate-ended", teammate: teammate.id, how: "stopped", at })), { type: "effort-ended", how, at }];
}

/** `claude stop` for each live Teammate, by its short id, or its `--name` before it has one. */
function stops(state: EffortState): EffortAction[] {
	return live(state).map((teammate) => ({ kind: "stop-teammate", teammate: teammate.id, shortId: teammate.shortId ?? teammate.name }));
}

/** Why an ended Effort takes nothing more. */
function endedText(state: EffortState, ended: Ended): string {
	return `Effort \`${state.effortId}\` has ended: it was ${ended.how === "signed-off" ? "signed off" : "cancelled"} at ${clock(ended.at)} UTC, so it takes nothing more. Start the next one with \`/team start\`.`;
}

/**
 * Ask for sign-off of the final Report just written, and offer each change it
 * proposes as its own pending item, so each is adopted or declined on its own.
 */
function requestSignOff(state: EffortState, input: Extract<EffortInput, { kind: "request-sign-off" }>): Step {
	if (state.finalReport === undefined || state.finalReport !== state.reports) {
		return { ok: false, refusal: `Effort \`${state.effortId}\` has no final Report to sign off: write it with \`team_report\` and \`final: true\`.` };
	}
	const signOff: EffortLine = { type: "approval-requested", id: `r${state.requests + 1}`, checkpoint: SIGN_OFF, path: input.path, sha256: input.sha256, snapshot: input.snapshot, at: input.at };
	const changes = input.changes.map(
		({ change, sha256 }, index): EffortLine => ({
			type: "approval-requested",
			id: `r${state.requests + 2 + index}`,
			checkpoint: PLAYBOOK_CHANGE,
			change,
			path: input.path,
			sha256,
			snapshot: changeSnapshot(change),
			at: input.at,
		}),
	);
	const offered = changes.flatMap((line) => (line.type === "approval-requested" && line.change ? [`\`${line.id}\` (\`${line.change.id}\`)`] : []));
	return took(
		state,
		[signOff, ...changes],
		[],
		[
			`Asked the human to sign off the final Report of Effort \`${state.effortId}\` as request \`${signOff.id}\`: ${input.path} (sha256 ${input.sha256}).`,
			offered.length > 0 ? `Each proposed Playbook change is its own request: ${offered.join(", ")}.` : undefined,
			"They answer in `/team pending`. Signing off stops every Teammate and ends the Effort; a send-back comes back to you with a note. Stop here and wait.",
		]
			.filter((part) => part !== undefined)
			.join(" "),
	);
}

/** Why `tool` can't start a Teammate yet, or undefined once the Brief is approved. */
function beforeBrief(state: EffortState, tool: string): string | undefined {
	if (state.brief) return undefined;
	return `No Teammate starts before the human approves the Brief of Effort \`${state.effortId}\`, so \`${tool}\` can't run yet. Draft the Brief, ask for it with \`team_request_approval\` at checkpoint \`${BRIEF}\`, and wait for the human to approve it in \`/team pending\`.`;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function quoted(items: readonly string[]): string {
	return items.map((item) => `\`${item}\``).join(", ");
}

/**
 * The dependency cycles a walk of the plan finds, each once, as the slugs
 * around it with the first repeated at the end: a plan with a cycle has at
 * least one listed. Unknown slugs and self-dependencies are skipped.
 */
function dependencyCycles(tasks: readonly PlannedTask[]): string[][] {
	const edges = new Map(tasks.map((task) => [task.slug, [...new Set(task.dependsOn)].filter((slug) => slug !== task.slug)]));
	const done = new Set<string>();
	const path: string[] = [];
	const cycles: string[][] = [];
	const visit = (slug: string): void => {
		const at = path.indexOf(slug);
		if (at >= 0) {
			cycles.push([...path.slice(at), slug]);
			return;
		}
		if (done.has(slug) || !edges.has(slug)) return;
		path.push(slug);
		for (const next of edges.get(slug) ?? []) visit(next);
		path.pop();
		done.add(slug);
	};
	for (const task of tasks) visit(task.slug);
	return cycles;
}

/**
 * The Lead's whole Task list. Every criterion of the Brief must be covered,
 * since dropping one is a Brief change, and only the snapshot's Roles staff
 * Tasks. A Task already handed off keeps its slug and Role: its folder is
 * named by both, and its Teammate fills that Role for life.
 */
function plan(state: EffortState, input: Extract<EffortInput, { kind: "plan" }>): Step {
	const early = beforeBrief(state, "team_plan");
	if (early !== undefined) return { ok: false, refusal: early };
	const tasks: PlannedTask[] = input.tasks.map((task) => ({
		slug: task.slug,
		role: task.role,
		goal: task.goal,
		dependsOn: task.dependsOn ?? [],
		criteria: task.criteria ?? [],
	}));
	const problems: string[] = [];
	if (tasks.length === 0) problems.push("the plan has no Tasks; list every Task the Effort needs");
	const slugs = tasks.map((task) => task.slug);
	for (const slug of new Set(slugs)) {
		if (!KEBAB.test(slug)) problems.push(`the slug \`${slug}\` must be kebab-case, such as \`rename-config-key\``);
		if (slugs.filter((other) => other === slug).length > 1) problems.push(`the slug \`${slug}\` is used more than once; each Task's slug must be unique`);
	}
	for (const task of tasks) {
		if (!input.roles.includes(task.role)) {
			problems.push(`Task \`${task.slug}\` names the Role \`${task.role}\`, which Team \`${state.team}\` doesn't have; its Roles are ${quoted(input.roles)}`);
		}
		for (const id of task.criteria) {
			if (!input.criteria.includes(id)) problems.push(`Task \`${task.slug}\` covers \`${id}\`, which the Brief doesn't have; its criteria are ${quoted(input.criteria)}`);
		}
		for (const slug of task.dependsOn) {
			if (slug === task.slug) problems.push(`Task \`${task.slug}\` depends on itself`);
			else if (!slugs.includes(slug)) problems.push(`Task \`${task.slug}\` depends on \`${slug}\`, which isn't in the plan`);
		}
	}
	for (const cycle of dependencyCycles(tasks)) {
		problems.push(`dependency cycle: ${cycle.map((slug) => `\`${slug}\``).join(" -> ")}; no Task in it could ever have a result to work from`);
	}
	const uncovered = input.criteria.filter((id) => !tasks.some((task) => task.criteria.includes(id)));
	if (uncovered.length > 0) {
		problems.push(`no Task covers ${quoted(uncovered)}; every acceptance criterion of the Brief must be covered, and dropping one is a Brief change for the human`);
	}
	// A handoff left out, or moved to another Role, is dropped; an accepted Task is done, and stays as it was.
	const dropping: string[] = [];
	for (const [slug, handed] of Object.entries(state.tasks)) {
		if (handed.dropped !== undefined) continue;
		const kept = tasks.find((task) => task.slug === slug);
		if (handed.accepted !== undefined) {
			if (!kept) problems.push(`Task \`${slug}\` is accepted, so it stays in the plan`);
			else if (kept.role !== handed.role) problems.push(`Task \`${slug}\` is accepted in Role \`${handed.role}\`, so it keeps that Role`);
		} else if (!kept || kept.role !== handed.role) dropping.push(slug);
	}
	// A queued Task has no Teammate yet: dropped, it just leaves the queue.
	const unqueuing = state.queue.filter((queued) => {
		const kept = tasks.find((task) => task.slug === queued.slug);
		return !kept || kept.role !== queued.role;
	});
	if (problems.length > 0) {
		return { ok: false, refusal: `The plan for Effort \`${state.effortId}\` can't be taken until these are fixed:\n${problems.map((problem) => `- ${problem}`).join("\n")}` };
	}
	const reason = input.reason?.trim();
	const append: EffortLine[] = [{ type: "plan-written", tasks, ...(reason ? { reason } : {}), at: input.at }];
	const actions: EffortAction[] = [];
	const notes: string[] = [];
	for (const slug of dropping) {
		const handed = state.tasks[slug];
		const teammate = state.teammates.find((each) => each.id === handed?.teammate);
		const replanned = tasks.find((task) => task.slug === slug);
		append.push({ type: "task-dropped", slug, at: input.at });
		const live = teammate !== undefined && teammate.ended === undefined && teammate.task === slug;
		if (live) {
			append.push({ type: "teammate-ended", teammate: teammate.id, how: "stopped", at: input.at });
			actions.push({ kind: "stop-teammate", teammate: teammate.id, shortId: teammate.shortId ?? teammate.name });
		}
		// Its worktree goes once its Teammate is stopped; the shell keeps one with uncommitted changes or unmerged commits.
		if (handed?.worktree) actions.push({ kind: "remove-task-workspace", slug, ...handed.worktree });
		const stopped = live ? `, and stopped \`${teammate.id}\` with \`claude stop\`, which keeps its conversation` : "";
		notes.push(
			replanned
				? `Dropped the handoff of Task \`${slug}\` to \`${handed?.teammate}\`${stopped}: it is planned again in Role \`${replanned.role}\`, and \`team_handoff\` starts it afresh in a new folder.`
				: `Dropped Task \`${slug}\`${stopped}.`,
		);
	}
	for (const queued of unqueuing) {
		const replanned = tasks.find((task) => task.slug === queued.slug);
		append.push({ type: "task-dropped", slug: queued.slug, at: input.at });
		notes.push(
			replanned
				? `Dropped queued Task \`${queued.slug}\`: it is planned again in Role \`${replanned.role}\`, and \`team_handoff\` hands it off afresh in a new folder.`
				: `Dropped queued Task \`${queued.slug}\`.`,
		);
	}
	const reply = [
		`${state.plan ? "Replaced" : "Wrote"} the plan of Effort \`${state.effortId}\`: ${tasks.length} Task${tasks.length === 1 ? "" : "s"}, covering ${quoted(input.criteria)}. Hand each off with \`team_handoff\` when it is ready.`,
		...notes,
	].join("\n");
	return took(state, append, [...actions, { kind: "write-plan" }], reply);
}

/** How many Teammates may be live at once when pi's `maxTeammates` setting is absent. */
export const DEFAULT_MAX_TEAMMATES = 3;

/** The cap pi's `maxTeammates` setting `set` gives: a whole number of 1 or more, else the default with what is wrong with it. */
export function maxTeammatesSetting(set: unknown): { max: number; problem?: string } {
	if (set === undefined || (typeof set === "number" && Number.isInteger(set) && set >= 1)) return { max: (set as number | undefined) ?? DEFAULT_MAX_TEAMMATES };
	return {
		max: DEFAULT_MAX_TEAMMATES,
		problem: `pi's \`maxTeammates\` setting is ${JSON.stringify(set)}, which isn't a whole number of 1 or more, so the default of ${DEFAULT_MAX_TEAMMATES} live Teammates is used. Fix it in pi's settings and \`/reload\`.`,
	};
}

/** The least time between two Teammate launches, so a burst of handoffs doesn't start them all at once. */
export const STAGGER_MS = 5000;

/**
 * Hand a planned Task off. Its folder is numbered in handoff order and named
 * `<nnn>-<role>-<slug>`, and written whether the Task starts now or queues;
 * {@link staff} then decides who takes it.
 */
function handoff(state: EffortState, input: Extract<EffortInput, { kind: "handoff" }>): Step {
	const early = beforeBrief(state, "team_handoff");
	if (early !== undefined) return { ok: false, refusal: early };
	const task = state.plan?.find((planned) => planned.slug === input.slug);
	if (!task) {
		const planned = state.plan?.map((each) => each.slug) ?? [];
		return {
			ok: false,
			refusal: `Effort \`${state.effortId}\` has no planned Task \`${input.slug}\`; ${planned.length > 0 ? `the planned ones are ${quoted(planned)}` : "write the plan with `team_plan` first"}.`,
		};
	}
	const handed = state.tasks[input.slug];
	if (handed && handed.dropped === undefined) {
		const status = taskStatus(state, input.slug);
		if (status === "accepted") {
			return { ok: false, refusal: `Task \`${input.slug}\` is accepted (round ${handed.round}, with \`${handed.teammate}\`), and an accepted Task is never handed off again.` };
		}
		return {
			ok: false,
			refusal: `Task \`${input.slug}\` is already ${status}, with \`${handed.teammate}\`; a Task is handed off once, and \`team_review\` sends it back for another round once its result is written.`,
		};
	}
	const queued = state.queue.find((each) => each.slug === input.slug);
	if (queued) {
		return {
			ok: false,
			refusal: `Task \`${input.slug}\` is already queued (${queued.why}); it starts by itself when a Teammate frees up, so don't hand it off again.`,
		};
	}
	if (input.isolated && !state.workspace) {
		return {
			ok: false,
			refusal: `Effort \`${state.effortId}\` has no git Workspace, so Task \`${input.slug}\` can't have a worktree of its own; hand it off without \`isolated\`.`,
		};
	}
	const folder = `${String(nextFolder(state)).padStart(3, "0")}-${task.role}-${task.slug}`;
	const wanted: QueuedTask = {
		slug: task.slug,
		folder,
		role: task.role,
		why: "",
		at: input.at,
		...(input.mode === undefined ? {} : { mode: input.mode }),
		...(input.isolated ? { isolated: true } : {}),
	};
	const max = input.maxTeammates ?? DEFAULT_MAX_TEAMMATES;
	const pointer = `Task \`${task.slug}\` (tasks/${folder}/task.md)`;
	const pauses = heldPauses(state);
	if (pauses.length > 0) {
		return took(
			state,
			[{ type: "task-queued", ...wanted, why: "paused" }],
			[{ kind: "write-task", slug: task.slug, folder }, { kind: "write-plan" }],
			`queued ${pointer}: ${pauses.map(pauseText).join(", and ")}. It starts by itself once every pause is lifted (${pauses.map(lifter).join("; ")}).`,
		);
	}
	const briefHold = briefHeld(state, task.slug);
	if (briefHold) {
		return took(
			state,
			[{ type: "task-queued", ...wanted, why: briefHold }],
			[{ kind: "write-task", slug: task.slug, folder }, { kind: "write-plan" }],
			`queued ${pointer}: held by Brief change \`${state.briefHold?.request}\`, which the human hasn't approved, while other Tasks go on. It starts by itself once they approve a Brief change.`,
		);
	}
	const hold = holdOn(state, task.role);
	if (hold) {
		return took(
			state,
			[{ type: "task-queued", ...wanted, why: heldWhy(hold) }],
			[{ kind: "write-task", slug: task.slug, folder }, { kind: "write-plan" }],
			`queued ${pointer}: Role \`${task.role}\` is held by ${holdText(hold)}, while other Roles go on. It starts by itself once the hold lifts.`,
		);
	}
	const staffed = staff(state, wanted, max, input.agents);
	if (staffed) {
		return took(
			state,
			staffed.append,
			[{ kind: "write-task", slug: task.slug, folder }, ...staffed.actions, { kind: "write-plan" }],
			`${staffed.who} on ${pointer}.${staffed.note ? ` ${staffed.note}` : ""}`,
		);
	}
	const why = waitReason(state, max);
	return took(
		state,
		[{ type: "task-queued", ...wanted, why }],
		[{ kind: "write-task", slug: task.slug, folder }, { kind: "write-plan" }],
		`queued ${pointer}: ${why}. It starts by itself when a Teammate frees up, and \`team_review\` says so when an acceptance starts it.`,
	);
}

/** The number of the next Task folder: one past the highest yet, queued ones included, since a dropped Task handed off again takes a new one. */
function nextFolder(state: EffortState): number {
	return Math.max(0, ...[...Object.values(state.tasks), ...state.queue].map((task) => Number.parseInt(task.folder, 10) || 0)) + 1;
}

/** Whether `teammate` is live: started, not stopped to make room, and not ended by a drop or a crash. */
export function isLive(teammate: Teammate): boolean {
	return teammate.retiredAt === undefined && teammate.ended === undefined;
}

/** Live Teammates, as {@link isLive} has it. */
function live(state: EffortState): Teammate[] {
	return state.teammates.filter(isLive);
}

/** Whether `teammate` is between Tasks: its Task is accepted and it hasn't been given another. */
function free(state: EffortState, teammate: Teammate): boolean {
	// A Teammate the human holds is never cleared for a new Task.
	return state.tasks[teammate.task]?.accepted !== undefined && teammate.clearing === undefined && teammate.takeover === undefined;
}

/**
 * The staffing ladder, for a Task about to start: reuse an idle Teammate of
 * its Role whose Task is accepted (cleared first, never mid-Task); else start
 * a new one under the cap; else, at the cap, stop a free Teammate of a Role
 * with no Task queued and start one in its place. Undefined when none applies,
 * and the Task queues. A queued Task taken here leaves the queue.
 *
 * A reused Teammate `agents` doesn't list has idle-stopped: its inbox is
 * closed, and a clear only reaches an inbox, so it starts afresh instead,
 * which leaves it in the same fresh context a clear would.
 *
 * A sent-back Task whose Teammate ended goes up the same ladder, in its own
 * folder (and worktree): a Teammate reused for it starts afresh, since its
 * launch is what carries the pointer to the rounds so far.
 */
function staff(state: EffortState, task: QueuedTask, max: number, agents?: readonly string[]): { append: EffortLine[]; actions: EffortAction[]; who: string; note?: string } | undefined {
	// An isolated Task needs a Teammate launched in its own worktree, so it never reuses one.
	const reused = task.isolated ? undefined : live(state).find((teammate) => teammate.role === task.role && teammate.inbox !== undefined && free(state, teammate));
	if (reused?.freshDue && reused.shortId) return relaunch(state, reused, task, freshForBrief(reused.role));
	if (reused && agents !== undefined && !agents.includes(reused.name)) return relaunch(state, reused, task, FRESH_FOR_IDLE);
	if (reused && sentBack(state, task.slug)) return relaunch(state, reused, task, FRESH_FOR_SENT_BACK);
	if (reused?.inbox) {
		return {
			append: [
				takenBy(state, task, reused.id),
				{ type: "clear-requested", teammate: reused.id, slug: task.slug, at: task.at },
			],
			actions: [{ kind: "clear-then-send", teammate: reused.id, inbox: reused.inbox, slug: task.slug, folder: task.folder }],
			who: `reused ${reused.id}`,
			note: "Its context is cleared first, then it gets the Task's pointer.",
		};
	}
	if (live(state).length < max) return start(state, task);
	const roles = new Set(state.queue.filter((queued) => queued.slug !== task.slug).map((queued) => queued.role));
	const idle = live(state).find((teammate) => teammate.shortId !== undefined && free(state, teammate) && !roles.has(teammate.role));
	if (!idle?.shortId) return undefined;
	const retired: EffortLine = { type: "teammate-retired", teammate: idle.id, at: task.at };
	const started = start(apply(state, retired), task);
	return {
		append: [retired, ...started.append],
		actions: [{ kind: "stop-teammate", teammate: idle.id, shortId: idle.shortId }, ...started.actions],
		who: started.who,
		note: `It stopped idle \`${idle.id}\`, whose Task is accepted, to stay within the cap of ${max} live Teammates.`,
	};
}

/** Why a Teammate starts afresh when an approved Brief change altered its Role's launch options. */
function freshForBrief(role: string): string {
	return `An approved Brief change altered Role \`${role}\`'s launch options, so its old session is stopped (its conversation kept) and a new one starts with them; it keeps its id, with a new short id.`;
}

/** Whether `slug` is a sent-back Task waiting for a new Teammate, rather than one handed off for the first time. */
function sentBack(state: EffortState, slug: string): boolean {
	const task = state.tasks[slug];
	return task !== undefined && task.dropped === undefined;
}

/** The line that gives `task` to `teammate`: its handoff, or for a sent-back Task, its reassignment. */
function takenBy(state: EffortState, task: QueuedTask, teammate: string, worktree?: TaskWorktree): EffortLine {
	if (sentBack(state, task.slug)) return { type: "task-reassigned", slug: task.slug, teammate, at: task.at };
	return { type: "task-handed-off", slug: task.slug, folder: task.folder, role: task.role, teammate, at: task.at, round: 1, ...(worktree ? { worktree } : {}) };
}

/** Why an idle Teammate given a sent-back Task starts afresh rather than being cleared. */
const FRESH_FOR_SENT_BACK = "It was idle, its own Task accepted, so a new session starts on this one (the old conversation is kept), launched with the pointer to the rounds so far; it keeps its id, with a new short id.";

/** Why an idle-stopped Teammate starts afresh rather than being cleared. */
const FRESH_FOR_IDLE =
	"It had idle-stopped, and a clear only reaches a running session, so a new session starts in the fresh context a clear would leave (the old conversation is kept); it keeps its id, with a new short id.";

/**
 * Start a free Teammate afresh on the Task, for `note`'s reason: its old
 * session is stopped (its conversation kept), and a new one launched under
 * the same id and name, at a Task boundary, never mid-Task.
 */
function relaunch(state: EffortState, teammate: Teammate, task: QueuedTask, note: string): { append: EffortLine[]; actions: EffortAction[]; who: string; note: string } {
	const last = Math.max(...state.teammates.map((each) => Date.parse(each.startedAt)));
	const at = new Date(Math.max(Date.parse(task.at), last + STAGGER_MS)).toISOString();
	return {
		append: [
			takenBy(state, task, teammate.id),
			{ type: "teammate-relaunched", teammate: teammate.id, task: task.slug, ...(task.mode === undefined ? {} : { mode: task.mode }), at },
		],
		actions: [
			{ kind: "stop-teammate", teammate: teammate.id, shortId: teammate.shortId ?? teammate.name },
			{ kind: "launch-teammate", teammate: { id: teammate.id, role: teammate.role, name: teammate.name }, task: { slug: task.slug, folder: task.folder }, at },
		],
		who: `started ${teammate.id} afresh`,
		note,
	};
}

/** Start the next Teammate of the Task's Role on it, no sooner than {@link STAGGER_MS} after the last start. */
function start(state: EffortState, task: QueuedTask): { append: EffortLine[]; actions: EffortAction[]; who: string } {
	const id = `${task.role}-${state.teammates.filter((teammate) => teammate.role === task.role).length + 1}`;
	const name = `team-${state.effortId}-${id}`;
	const last = Math.max(...state.teammates.map((teammate) => Date.parse(teammate.startedAt)));
	const at = new Date(Math.max(Date.parse(task.at), last + STAGGER_MS)).toISOString();
	const worktree = task.isolated && state.workspace ? taskWorktree(state.workspace, task.folder) : undefined;
	const launch: EffortAction = { kind: "launch-teammate", teammate: { id, role: task.role, name }, task: { slug: task.slug, folder: task.folder }, at };
	return {
		append: [
			{ type: "teammate-started", id, role: task.role, name, task: task.slug, startedAt: at, ...(task.mode === undefined ? {} : { mode: task.mode }) },
			takenBy(state, task, id, worktree),
		],
		actions: worktree && state.workspace ? [{ kind: "add-task-workspace", slug: task.slug, from: state.workspace.branch, ...worktree }, launch] : [launch],
		who: worktree
			? `started ${id} in a worktree of its own, ${worktree.path} on \`${worktree.branch}\` (only what it commits there merges when you accept),`
			: `started ${id}`,
	};
}

/** Why a Task can't start now: the cap, and the folder numbers of the live Teammates' unaccepted Tasks. */
function waitReason(state: EffortState, max: number): string {
	const busy = live(state)
		.map((teammate) => state.tasks[teammate.task])
		.filter((task) => task !== undefined && task.accepted === undefined)
		.map((task) => task?.folder.slice(0, 3) ?? "")
		.sort();
	const list = busy.length > 1 ? `${busy.slice(0, -1).join(", ")} and ${busy.at(-1)}` : busy[0];
	return `cap ${max} reached; ${list === undefined ? "waits for a Teammate to free up" : `waits for ${list}`}`;
}

/**
 * Start the first queued Task, in handoff order, that the staffing ladder can
 * staff now; one it can't stays queued. Nothing to start is a step with no
 * lines and no reply.
 */
function drain(state: EffortState, input: Extract<EffortInput, { kind: "drain" }>): Step {
	const max = input.maxTeammates ?? DEFAULT_MAX_TEAMMATES;
	if (heldPauses(state).length > 0) return took(state, [], []);
	for (const queued of state.queue) {
		if (holdOn(state, queued.role) || briefHeld(state, queued.slug)) continue;
		// It starts now, whenever it was queued.
		const staffed = staff(state, { ...queued, at: input.at }, max, input.agents);
		if (!staffed) continue;
		return took(
			state,
			staffed.append,
			[...staffed.actions, { kind: "write-plan" }],
			`Queued Task \`${queued.slug}\` ${staffed.who} (tasks/${queued.folder}/task.md).${staffed.note ? ` ${staffed.note}` : ""}`,
		);
	}
	// A Task queued while paused or held still waits once the Effort runs: it gets the reason it waits for now, with no reply.
	const why = waitReason(state, max);
	return took(
		state,
		state.queue.flatMap((queued): EffortLine[] => {
			if (queued.why !== "paused" && !queued.why.startsWith("held:")) return [];
			const hold = holdOn(state, queued.role);
			const now = briefHeld(state, queued.slug) ?? (hold ? heldWhy(hold) : why);
			return now === queued.why ? [] : [{ type: "task-requeued", slug: queued.slug, why: now, at: input.at }];
		}),
		[],
	);
}

/**
 * The result `teammate`'s current Task is due to write: `result-<round>.md`
 * in the Task's folder. Undefined for a Teammate the Effort doesn't have.
 */
export function currentResult(state: EffortState, teammate: string): { slug: string; folder: string; round: number } | undefined {
	const slug = state.teammates.find((each) => each.id === teammate)?.task;
	const task = slug === undefined ? undefined : state.tasks[slug];
	return slug === undefined || task === undefined ? undefined : { slug, folder: task.folder, round: task.round };
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * One line of a Teammate's journal, applied once: a line at or before the
 * Teammate's cursor was applied already. Events this doesn't act on append
 * nothing, so they leave no trace and wake nobody. Any event whose
 * `permission_mode` differs from the mode last known first appends a
 * `teammate-mode` line, which wakes nobody either.
 */
function journal(state: EffortState, input: Extract<EffortInput, { kind: "journal" }>): Step {
	const teammate = state.teammates.find((each) => each.id === input.teammate);
	if (!teammate) return { ok: false, refusal: `Effort \`${state.effortId}\` has no Teammate \`${input.teammate}\` to read a journal of.` };
	if (input.cursor <= (teammate.cursor ?? 0)) return took(state, [], []);
	const event = journalEvent(state, teammate, input);
	const reported = text(input.line.payload?.permission_mode);
	// Claude Code calls manual `default`.
	const mode = reported === "default" ? "manual" : reported;
	if (!event.ok || mode === undefined || mode === (teammate.observedMode ?? teammate.mode)) return event;
	return took(state, [{ type: "teammate-mode", teammate: teammate.id, cursor: input.cursor, mode, at: input.line.at }, ...event.append], event.actions, event.reply);
}

/** The commands that only look, which never start a Takeover. */
export const READ_ONLY_COMMANDS: readonly string[] = ["context", "cost", "usage", "status", "help"];

/** The hook events that show a card the terminal killed the hook of was a No: the Teammate went on without the call. */
const AFTER_A_NO: ReadonlySet<string> = new Set(["Stop", "UserPromptSubmit", "Notification"]);

/**
 * What the human typed, by a mod journal line: a prompt that isn't one the
 * Effort sent, or a command (`/model sonnet`) not on the read-only list.
 * Undefined for anything else, `/handback` included.
 */
function humanInput(line: JournalLine, sent: readonly string[] | undefined): string | undefined {
	const payload = line.payload ?? {};
	if (line.event === "prompt.submit") {
		const typed = (text(payload.text) ?? "").trim();
		if (typed === "" || typed.startsWith("/")) return undefined;
		return (sent ?? []).some((each) => each.trim() === typed) ? undefined : typed;
	}
	if (line.event === "command.run") {
		const command = (text(payload.command) ?? "").replace(/^\//, "");
		if (command === "" || command === "handback" || READ_ONLY_COMMANDS.includes(command)) return undefined;
		return `/${command} ${text(payload.args) ?? ""}`.trim();
	}
	return undefined;
}

/** What a mod journal line starts a Takeover with, or undefined when it doesn't. */
function triggerOf(line: JournalLine, sent: readonly string[] | undefined): TakeoverTrigger | undefined {
	if (line.event === "turn.complete") return line.payload?.aborted === true ? { kind: "interrupt" } : undefined;
	const input = humanInput(line, sent);
	if (input === undefined) return undefined;
	return line.event === "command.run" ? { kind: "command", command: input.split(" ")[0] ?? input } : { kind: "prompt" };
}

/** What started a Takeover, as the Lead and the Team block say it: `typed a prompt`. */
export function takeoverText(trigger: TakeoverTrigger): string {
	switch (trigger.kind) {
		case "prompt":
			return "typed a prompt";
		case "command":
			return `ran \`${trigger.command}\``;
		case "interrupt":
			return "interrupted a turn";
		case "deny":
			return `said No to its permission prompt \`${trigger.request}\``;
	}
}

/** Whether the human holds Teammate `id` in a Takeover. */
export function underTakeover(state: EffortState, id: string): boolean {
	return state.teammates.find((each) => each.id === id)?.takeover !== undefined;
}

/** A Takeover starting: one line, the Lead woken once, and the hook's marker written. */
function takeoverStart(teammate: Teammate, cursor: number, trigger: TakeoverTrigger, input: string | undefined, at: string): { append: EffortLine[]; actions: EffortAction[] } {
	return {
		append: [{ type: "takeover-started", teammate: teammate.id, cursor, trigger, ...(input === undefined ? {} : { input }), at }],
		actions: [
			{ kind: "mark-takeover", teammate: teammate.id, on: true },
			{
				kind: "wake-lead",
				text: `The human took over \`${teammate.id}\` in its terminal: they ${takeoverText(trigger)}${input === undefined ? "" : ` (${JSON.stringify(input)})`}. Until they hand it back, sends to it are held and dropped at the hand-back, its permission prompts are theirs, and nothing it does counts as done; re-plan around it. You're woken once more at the hand-back.`,
			},
		],
	};
}

/**
 * A journal line of a Teammate the human may be taking over. A mod line of
 * their input starts a Takeover or adds to it, and `/handback` ends it; a
 * card the terminal killed the hook of is a No once the Teammate goes on
 * without the call. Undefined for a line the usual rules take.
 */
function takeoverEvent(state: EffortState, teammate: Teammate, input: Extract<EffortInput, { kind: "journal" }>): Step | undefined {
	const { cursor, line } = input;
	const at = line.at;
	const mod = line.from === "mod";
	if (!isLive(teammate)) return mod ? took(state, [], []) : undefined;
	// Until its fresh session starts, what the human types reaches only the old one, which is being stopped for a Brief change's fresh start.
	if (teammate.relaunching && teammate.takeover === undefined) return mod ? took(state, [], []) : undefined;
	if (teammate.takeover === undefined && teammate.denied !== undefined && (mod ? line.event !== "handback" : AFTER_A_NO.has(line.event ?? ""))) {
		const start = takeoverStart(teammate, cursor, { kind: "deny", request: teammate.denied }, mod ? humanInput(line, input.sent) : undefined, at);
		if (mod) return took(state, start.append, start.actions);
		const after = start.append.reduce(apply, state);
		const rest = journalEvent(after, after.teammates.find((each) => each.id === teammate.id) ?? teammate, input);
		return rest.ok ? took(state, [...start.append, ...rest.append], [...start.actions, ...rest.actions], rest.reply) : rest;
	}
	if (teammate.takeover === undefined) {
		if (!mod) return undefined;
		const trigger = triggerOf(line, input.sent);
		if (trigger === undefined) return took(state, [], []);
		const start = takeoverStart(teammate, cursor, trigger, humanInput(line, input.sent), at);
		return took(state, start.append, start.actions);
	}
	if (mod) {
		if (line.event === "handback") return handBack(state, teammate, { by: "terminal", note: text(line.payload?.note), result: input.result, at, cursor });
		const typed = humanInput(line, input.sent);
		return took(state, typed === undefined ? [] : [{ type: "takeover-input", teammate: teammate.id, cursor, input: typed, at }], []);
	}
	switch (line.event) {
		case "Stop":
			// Nothing a Teammate the human holds writes counts as done until they hand it back.
			return took(state, [{ type: "takeover-turn", teammate: teammate.id, cursor, at }, ...wentThrough(state, teammate, at)], []);
		case "SessionStart": {
			const sessionId = text(line.payload?.session_id);
			if (sessionId === undefined || teammate.clearing === undefined || text(line.payload?.source) !== "clear") return undefined;
			// A clear asked for before the human took over landed: the Task's pointer waits for the hand-back.
			const plain = journalEvent(state, { ...teammate, clearing: undefined }, input);
			if (!plain.ok) return plain;
			return took(state, [...plain.append, { type: "send-held", teammate: teammate.id, what: "pointer", slug: teammate.clearing, at }], []);
		}
		case "SessionEnd": {
			const ended = sessionEnded(state, teammate, input);
			if (!ended.ok || ended.append.length === 0) return ended;
			return took(state, [...ended.append, { type: "takeover-ended", teammate: teammate.id, cursor, by: "crash", at }], [{ kind: "mark-takeover", teammate: teammate.id, on: false }, ...ended.actions]);
		}
		default:
			return undefined;
	}
}

/**
 * The human handed a Teammate back: from its terminal with `/handback`, or
 * from pi. Held messages are dropped; a held Task pointer goes after a clear,
 * since the context is the human's now. A result written meanwhile is done
 * now, and the Lead is woken once with what the human did.
 */
function handBack(
	state: EffortState,
	teammate: Teammate,
	from: { by: "terminal" | "pi"; note?: string; result: { path: string; written: boolean }; at: string; cursor?: number },
): Step {
	const takeover = teammate.takeover;
	if (takeover === undefined) {
		if (from.by === "terminal") return took(state, [], []);
		return { ok: false, refusal: `Nobody holds \`${teammate.id}\`: it isn't taken over, so there is nothing to hand back.` };
	}
	const { at } = from;
	const note = from.note?.trim() || undefined;
	const append: EffortLine[] = [
		{ type: "takeover-ended", teammate: teammate.id, ...(from.cursor === undefined ? {} : { cursor: from.cursor }), by: from.by, ...(note === undefined ? {} : { note }), at },
	];
	const actions: EffortAction[] = [{ kind: "mark-takeover", teammate: teammate.id, on: false }];
	const due = currentResult(state, teammate.id);
	const task = due === undefined ? undefined : state.tasks[due.slug];
	const done = due !== undefined && task !== undefined && task.teammate === teammate.id && task.accepted === undefined && task.dropped === undefined && from.result.written && task.reported !== due.round;
	if (done) append.push({ type: "task-done", teammate: teammate.id, cursor: from.cursor ?? teammate.cursor ?? 0, slug: due.slug, round: due.round, at });
	const pointer = [...takeover.held].reverse().find((held) => held.what === "pointer");
	const next = pointer?.slug === undefined ? undefined : state.tasks[pointer.slug];
	if (pointer?.slug !== undefined && next !== undefined && teammate.inbox !== undefined) {
		append.push({ type: "clear-requested", teammate: teammate.id, slug: pointer.slug, at });
		actions.push({ kind: "clear-then-send", teammate: teammate.id, inbox: teammate.inbox, slug: pointer.slug, folder: next.folder });
	}
	const after = append.reduce(apply, state).teammates.find((each) => each.id === teammate.id) ?? teammate;
	const messages = takeover.held.filter((held) => held.what === "message");
	const lines = [
		`The human handed \`${teammate.id}\` back ${from.by === "pi" ? "in pi" : "from its terminal"}. They took it over at ${clock(takeover.since)}, when they ${takeoverText(takeover.trigger)}.`,
		takeover.inputs.length === 0 ? "They typed no prompt or command to it." : `What they typed to it, in order:\n${takeover.inputs.map((each) => `- ${JSON.stringify(each)}`).join("\n")}`,
		due === undefined
			? `It has no open Task.`
			: from.result.written
				? `Round ${due.round}'s result of Task \`${due.slug}\` is written: ${from.result.path}.`
				: `Round ${due.round}'s result of Task \`${due.slug}\` isn't written: ${from.result.path} isn't there.`,
		`It is ${after.activity ?? "not started"}${after.doing === undefined ? "" : ` (${after.doing})`}${pointer?.slug === undefined ? "" : `, and gets Task \`${pointer.slug}\`'s pointer after a clear`}.`,
		messages.length === 0 ? "No send was held." : `The ${messages.length === 1 ? "send" : `${messages.length} sends`} held meanwhile, now dropped:\n${messages.map((held) => `- ${JSON.stringify(held.message ?? "")}`).join("\n")}`,
		note === undefined ? "They left no note." : `Their note: ${note}`,
		`What they did is part of ${due === undefined ? "its work" : `Task \`${due.slug}\``}: review it like any result. It never amends the Brief. Decide afresh what comes next.`,
	];
	actions.push({ kind: "wake-lead", text: lines.join("\n\n") });
	return took(state, append, actions, `Handed \`${teammate.id}\` back: ${messages.length === 0 ? "no send was held" : `${messages.length} held send${messages.length === 1 ? " is" : "s are"} dropped`}, and the Lead reviews what you did.`);
}

/** `/team handback <teammate> [note]` in pi. */
function handBackInPi(state: EffortState, input: Extract<EffortInput, { kind: "handback" }>): Step {
	const teammate = teammateOf(state, input.teammate);
	if (typeof teammate === "string") return { ok: false, refusal: teammate };
	return handBack(state, teammate, { by: "pi", ...(input.note === undefined ? {} : { note: input.note }), result: input.result, at: input.at });
}

/** What one journal event of `teammate` appends, past its cursor. */
function journalEvent(state: EffortState, teammate: Teammate, input: Extract<EffortInput, { kind: "journal" }>): Step {
	const taken = takeoverEvent(state, teammate, input);
	if (taken !== undefined) return taken;
	const { cursor, line } = input;
	const payload = line.payload ?? {};
	const at = line.at;
	const at_ = { teammate: teammate.id, cursor };
	switch (line.event) {
		case "SessionStart": {
			const sessionId = text(payload.session_id);
			if (sessionId === undefined) return took(state, [], []);
			// The short id is the launch session's first eight characters; a clear or a resume keeps it, and a fresh session's launch replaces it.
			const shortId = teammate.relaunching || teammate.shortId === undefined ? sessionId.slice(0, 8) : teammate.shortId;
			const source = text(payload.source) ?? "startup";
			const session: EffortLine = { type: "teammate-session", ...at_, source, sessionId, shortId, ...(line.inbox === undefined ? {} : { inbox: line.inbox }), at };
			// The clear a reuse asked for has happened: the reused Teammate gets its new Task's pointer in the fresh context.
			const task = teammate.clearing === undefined ? undefined : state.tasks[teammate.clearing];
			const inbox = line.inbox ?? teammate.inbox;
			if (source !== "clear" || teammate.clearing === undefined || task === undefined || inbox === undefined) return took(state, [session], []);
			return took(state, [session], [{ kind: "send-pointer", teammate: teammate.id, inbox, slug: teammate.clearing, folder: task.folder, round: task.round }]);
		}
		case "UserPromptSubmit": {
			// A prompt landing on a Teammate waiting on a usage-credit confirm means the human answered it in its terminal.
			const confirmed = teammate.limit?.kind === "consent" && state.holds?.[CONSENT_FAMILY]?.teammate === teammate.id;
			return took(state, [{ type: "prompt-landed", ...at_, prompt: text(payload.prompt) ?? "", at }, ...(confirmed ? [{ type: "model-released", family: CONSENT_FAMILY, at } as const] : [])], []);
		}
		case "PermissionDenied": {
			const reason = text(payload.reason);
			return took(state, [{ type: "permission-denied", ...at_, tool: text(payload.tool_name) ?? "", ...(reason === undefined ? {} : { reason }), at }], []);
		}
		case "Stop": {
			const done = stopped(state, teammate, input);
			const lifts = done.ok ? wentThrough(state, teammate, at) : [];
			return done.ok && lifts.length > 0 ? took(state, [...done.append, ...lifts], done.actions, done.reply) : done;
		}
		case "StopFailure":
			return limitHit(state, teammate, input);
		case "Notification":
			return notified(state, teammate, input);
		case "PermissionRequest": {
			const request = line.request;
			if (request === undefined || state.teammateRequests[request] !== undefined) return took(state, [], []);
			const toolInput = payload.tool_input;
			const toolUseId = text(payload.tool_use_id);
			const held: HeldRequest = {
				request,
				teammate: teammate.id,
				task: teammate.task,
				tool: text(payload.tool_name) ?? "",
				input: typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput) ? (toolInput as Record<string, unknown>) : {},
				...(toolUseId === undefined ? {} : { toolUseId }),
				...(text(payload.cwd) === undefined ? {} : { cwd: text(payload.cwd) }),
				at,
				state: "held",
			};
			const { state: _state, ...fields } = held;
			return took(state, [{ type: "request-held", cursor, ...fields }], [{ kind: "wake-lead", text: askText(held) }]);
		}
		case "PostToolUse":
		case "PostToolUseFailure": {
			// A call a held request asked for ran: the human answered it in the terminal first.
			// A hook killed by the terminal looks like a deny until the call runs, and a call
			// that ran and failed (PostToolUseFailure) was allowed all the same, so the No
			// that started no Takeover yet is known for the Yes it was.
			const tool = text(payload.tool_name);
			const toolUseId = text(payload.tool_use_id);
			const open = new Set<HeldRequest["state"]>(["held", "expired", "denied-in-terminal"]);
			const answered = Object.values(state.teammateRequests).find(
				(held) => held.teammate === teammate.id && open.has(held.state) && isCallOf(held, tool, payload.tool_input, toolUseId),
			);
			if (!answered) return took(state, [], []);
			return took(state, [{ type: "request-settled", ...at_, request: answered.request, how: "answered-in-terminal", at }], []);
		}
		case "denied-in-terminal":
		case "hold-expired": {
			const held = line.request === undefined ? undefined : state.teammateRequests[line.request];
			if (held?.state !== "held") return took(state, [], []);
			const how = line.event === "hold-expired" ? "expired" : "denied-in-terminal";
			return took(state, [{ type: "request-settled", ...at_, request: held.request, how, at }], []);
		}
		case "SessionEnd":
			return sessionEnded(state, teammate, input);
		default:
			return took(state, [], []);
	}
}

/**
 * A `SessionEnd`. A clear or a resume goes on in a new session, and a
 * Teammate the extension stopped, its Task dropped or merged or to make room
 * under the cap, is already over; anything else is a crash, which ends the
 * Teammate and wakes the Lead once, through the cursor.
 */
function sessionEnded(state: EffortState, teammate: Teammate, input: Extract<EffortInput, { kind: "journal" }>): Step {
	const reason = text(input.line.payload?.reason) ?? "other";
	if (reason === "clear" || reason === "resume" || !isLive(teammate)) return took(state, [], []);
	// The old session of a Teammate started afresh ends as the new one starts: that is no crash.
	const ended = text(input.line.payload?.session_id);
	if (teammate.relaunching || (ended !== undefined && teammate.sessionId !== undefined && ended !== teammate.sessionId)) return took(state, [], []);
	const task = state.tasks[teammate.task];
	const open = task !== undefined && task.teammate === teammate.id && task.accepted === undefined && task.dropped === undefined;
	const text_ = open
		? `\`${teammate.id}\`'s session ended (${reason}) during round ${task.round} of Task \`${teammate.task}\`, so it is gone for this Effort. A send-back of the Task with \`team_review\` goes to another Teammate of Role \`${teammate.role}\`, carrying its folder; or drop it with \`team_plan\`; or stop and tell the human.`
		: `\`${teammate.id}\`'s session ended (${reason}), so it is gone for this Effort. It had no open Task.`;
	return took(state, [{ type: "teammate-crashed", teammate: teammate.id, cursor: input.cursor, reason, at: input.line.at }], [{ kind: "wake-lead", text: text_ }]);
}

/** The Roles on `family`, by the Team snapshot's models, with the limited Teammate's own. */
function rolesOn(family: Family, teammate: Teammate, models: Record<string, string> | undefined): string[] {
	const roles = Object.entries(models ?? {}).flatMap(([role, model]) => (familyOf(model) === family ? [role] : []));
	return roles.includes(teammate.role) ? roles : [...roles, teammate.role];
}

/** Whether a limit at `reset` replaces one already holding until `held`: the later reset wins, and one Claude Code named beats one it didn't. */
function later(reset: string | undefined, held: { reset?: string } | undefined): boolean {
	if (held === undefined) return true;
	if (reset === undefined) return false;
	return held.reset === undefined || reset > held.reset;
}

/** The next usage item's id. */
function usageId(state: EffortState): string {
	return `u${(state.usageAsked ?? 0) + 1}`;
}

/**
 * A `StopFailure`, classified by {@link classify}. A session or weekly limit
 * sets the usage pause and a model family's limit holds the Roles on it,
 * waking nobody: the Lead's own turns spend the same account. A failure that
 * clears by itself goes on the retry ladder. A usage-credit confirm holds the
 * Fable Roles until the human answers it in the Teammate's terminal, and
 * anything else goes to the Lead.
 */
function limitHit(state: EffortState, teammate: Teammate, input: Extract<EffortInput, { kind: "journal" }>): Step {
	const { cursor, line } = input;
	const at = line.at;
	const message = text(line.payload?.last_assistant_message);
	const failure = classify(text(line.payload?.error), message, at, input.tz ?? 0);
	const limited = (limit: TeammateLimit): EffortLine => ({ type: "teammate-limited", teammate: teammate.id, cursor, limit, at });
	const task = state.tasks[teammate.task] === undefined ? {} : { task: teammate.task };
	switch (failure.kind) {
		case "unknown":
			return took(
				state,
				[limited({ kind: "unknown", at })],
				[
					{
						kind: "wake-lead",
						text: `\`${teammate.id}\`'s turn on Task \`${teammate.task}\` failed${failure.error === undefined ? "" : ` (${failure.error})`}, and the extension can't settle it by itself. Its last message:\n\n${message || "(none)"}\n\nDecide what comes next, or tell the human. Never change its model or confirm usage credits for it.`,
					},
				],
			);
		case "transient": {
			const tries = teammate.limit !== undefined && TRANSIENT.has(teammate.limit.kind) ? (teammate.limit.tries ?? 0) : 0;
			const wait = RETRY_MS[tries];
			if (wait !== undefined) return took(state, [limited({ kind: failure.why, tries, next: new Date(Date.parse(at) + wait).toISOString(), at })], []);
			const open = state.usageItems?.some((item) => item.why === "retries" && item.teammate === teammate.id);
			return took(state, [limited({ kind: failure.why, tries, at }), ...(open ? [] : [{ type: "usage-escalated", id: usageId(state), why: "retries", kind: failure.why, teammate: teammate.id, at } as const])], []);
		}
		case "consent": {
			const held = state.holds?.[CONSENT_FAMILY];
			const roles = rolesOn(CONSENT_FAMILY, teammate, input.models);
			return took(
				state,
				[
					limited({ kind: "consent", at }),
					...(held ? [] : [{ type: "model-held", family: CONSENT_FAMILY, kind: "consent", roles, teammate: teammate.id, at } as const]),
					...(held ? [] : [{ type: "decided-for-you", what: `held the Fable Roles (${roles.join(", ")}) while ${teammate.id} waits for a usage-credit confirm`, ...task, at } as const]),
				],
				[
					{
						kind: "wake-lead",
						text: `\`${teammate.id}\` hit a limit on Task \`${teammate.task}\`, and Claude Code's prompt to confirm usage credits went unanswered. Only the human confirms usage credits, in its terminal (\`/team\`, then attach): tell them. Never confirm them yourself, nor change its model. New Tasks for ${quoted(roles)} wait until it is answered.`,
					},
				],
			);
		}
		case "limit": {
			const limit: TeammateLimit = { kind: failure.limit, ...(failure.reset === undefined ? {} : { reset: failure.reset }), ...(failure.armed ? { armed: true as const } : {}), at };
			const until = failure.reset === undefined ? "" : `, ${untilText(failure.reset, at)}`;
			const family = LIMIT_FAMILY[failure.limit];
			if (family !== undefined) {
				if (!later(failure.reset, state.holds?.[family])) return took(state, [limited(limit)], []);
				const roles = rolesOn(family, teammate, input.models);
				return took(
					state,
					[
						limited(limit),
						{ type: "model-held", family, kind: failure.limit as "opus" | "sonnet", roles, ...(failure.reset === undefined ? {} : { reset: failure.reset }), at },
						{ type: "decided-for-you", what: `held the ${LIMIT_NAMES[failure.limit]} Roles (${roles.join(", ")}) on ${teammate.id}'s ${LIMIT_NAMES[failure.limit]} limit${until}`, ...task, at },
					],
					[],
				);
			}
			if (!later(failure.reset, state.pauses?.usage)) return took(state, [limited(limit)], []);
			const kind = failure.limit as "session" | "weekly";
			// A reset Claude Code didn't give may be minutes away: the pause waits for the auto-resume or the next ordinary Stop, and asks only once it has held a day (`tick`).
			const far = failure.reset !== undefined && Date.parse(failure.reset) - Date.parse(at) > FAR_RESET_MS;
			const asked = state.usageItems?.some((item) => item.why === "far-reset");
			return took(
				state,
				[
					limited(limit),
					{ type: "paused", by: "usage", kind, reason: `${kind} limit`, ...(failure.reset === undefined ? {} : { reset: failure.reset }), at },
					{ type: "decided-for-you", what: `paused the Effort on ${teammate.id}'s ${kind} limit${until}`, ...task, at },
					...(far && !asked ? [{ type: "usage-escalated", id: usageId(state), why: "far-reset", kind, teammate: teammate.id, ...(failure.reset === undefined ? {} : { reset: failure.reset }), at } as const] : []),
				],
				[],
			);
		}
	}
}

/** Whether a limit of `kind` still holds `role`: the usage pause for the account's limits, the family's hold for a model's. */
function stillHeld(state: EffortState, kind: TeammateLimit["kind"], role: string): boolean {
	if (kind === "session" || kind === "weekly") return state.pauses?.usage !== undefined;
	const family = LIMIT_FAMILY[kind as LimitKind];
	return family !== undefined && state.holds?.[family]?.roles.includes(role) === true;
}

/** The limits a turn that went through shows are over: a usage pause, or the hold on its Role, that Claude Code gave no reset for. */
function wentThrough(state: EffortState, teammate: Teammate, at: string): EffortLine[] {
	const lifts: EffortLine[] = [];
	if (state.pauses?.usage !== undefined && state.pauses.usage.reset === undefined) lifts.push({ type: "resumed", by: "usage", at });
	for (const hold of Object.values(state.holds ?? {})) {
		if (hold && hold.kind !== "consent" && hold.reset === undefined && hold.roles.includes(teammate.role)) lifts.push({ type: "model-released", family: hold.family, at });
	}
	return lifts;
}

/** `continue` for each Teammate in `teammates`, after its limit reset. */
function continueAll(teammates: readonly Teammate[], why: string, at: string): { append: EffortLine[]; actions: EffortAction[] } {
	return {
		append: teammates.flatMap((each): EffortLine[] => [
			{ type: "teammate-continued", teammate: each.id, why: "reset", at },
			{ type: "decided-for-you", what: `sent \`continue\` to ${each.id}, ${why}`, task: each.task, at },
		]),
		actions: teammates.flatMap((each): EffortAction[] => (each.inbox ? [{ kind: "send-continue", teammate: each.id, inbox: each.inbox }] : [])),
	};
}

/** A limited Teammate the Effort may send `continue`: live, still idle, reachable, and with no auto-wait of Claude Code's armed. */
/** Whether a usage limit holds anything back that the shell's clock lets go: the usage pause, a model hold, or a Teammate a limit stopped. */
export function usageHolds(state: EffortState): boolean {
	return state.pauses?.usage !== undefined || Object.keys(state.holds ?? {}).length > 0 || live(state).some((each) => each.limit !== undefined);
}

function continuable(state: EffortState): Teammate[] {
	return live(state).filter((each) => each.limit !== undefined && each.limit.armed === undefined && each.activity === "idle" && each.inbox !== undefined && each.takeover === undefined);
}

/**
 * A `Notification`. `quota_auto_resume_fired`: Claude Code's auto-wait
 * continued the Teammate, so its limit has reset; the pause or hold it set
 * lifts, and every other Teammate idle on the same limit gets `continue`.
 * A stale or disabled auto-wait is disarmed, and the reset's grace takes over.
 */
function notified(state: EffortState, teammate: Teammate, input: Extract<EffortInput, { kind: "journal" }>): Step {
	const { cursor, line } = input;
	const at = line.at;
	const type = text(line.payload?.notification_type);
	const limit = teammate.limit;
	if (limit === undefined) return took(state, [], []);
	if (type === "quota_auto_resume_stale" || type === "quota_auto_resume_disabled") {
		if (limit.armed === undefined) return took(state, [], []);
		const { armed: _armed, ...disarmed } = limit;
		return took(state, [{ type: "teammate-limited", teammate: teammate.id, cursor, limit: disarmed, at }], []);
	}
	if (type !== "quota_auto_resume_fired") return took(state, [], []);
	const account = limit.kind === "session" || limit.kind === "weekly";
	const family = LIMIT_FAMILY[limit.kind as LimitKind];
	const lifts: EffortLine[] = [
		{ type: "limit-cleared", teammate: teammate.id, cursor, at },
		...(account && state.pauses?.usage ? [{ type: "resumed", by: "usage", at } as const] : []),
		...(family !== undefined && state.holds?.[family] ? [{ type: "model-released", family, at } as const] : []),
	];
	const after = lifts.reduce(apply, state);
	const same = (other: TeammateLimit["kind"]) => (account ? other === "session" || other === "weekly" : other === limit.kind);
	const others = continuable(after).filter((each) => each.id !== teammate.id && each.limit !== undefined && same(each.limit.kind) && !stillHeld(after, each.limit.kind, each.role));
	const continued = continueAll(others, `since Claude Code's auto-resume fired for ${teammate.id}`, at);
	return took(state, [...lifts, ...continued.append], continued.actions);
}

/**
 * The shell's clock: the usage pause and model holds lift at their reset; a
 * Teammate on the retry ladder gets `continue` when its retry is due; and
 * one on a usage limit gets it ~2 min after the reset, once nothing holds it.
 * None of it goes to a Teammate whose auto-wait is armed.
 */
function tick(state: EffortState, input: Extract<EffortInput, { kind: "tick" }>): Step {
	const now = Date.parse(input.at);
	const at = input.at;
	const lifts: EffortLine[] = [];
	const usage = state.pauses?.usage;
	if (usage?.reset !== undefined && Date.parse(usage.reset) <= now) lifts.push({ type: "resumed", by: "usage", at });
	// A usage pause Claude Code gave no reset for, held a day with nothing lifting it: the human decides whether to stay or cancel.
	const unsaid = usage !== undefined && usage.reset === undefined && !usage.asked && now - Date.parse(usage.at) > FAR_RESET_MS ? usage.kind : undefined;
	if (unsaid && !state.usageItems?.some((item) => item.why === "far-reset")) lifts.push({ type: "usage-escalated", id: usageId(state), why: "far-reset", kind: unsaid, at });
	for (const hold of Object.values(state.holds ?? {})) {
		if (hold?.reset !== undefined && Date.parse(hold.reset) <= now) lifts.push({ type: "model-released", family: hold.family, at });
	}
	const after = lifts.reduce(apply, state);
	const append = [...lifts];
	const actions: EffortAction[] = [];
	const due: Teammate[] = [];
	for (const teammate of continuable(after)) {
		const limit = teammate.limit;
		if (limit === undefined || !teammate.inbox) continue;
		if (TRANSIENT.has(limit.kind)) {
			if (limit.next === undefined || Date.parse(limit.next) > now) continue;
			const tries = (limit.tries ?? 0) + 1;
			append.push(
				{ type: "teammate-continued", teammate: teammate.id, why: "retry", tries, at },
				{ type: "decided-for-you", what: `retried ${teammate.id} after ${limit.kind.replace("_", " ")} (${tries} of ${RETRY_MS.length})`, task: teammate.task, at },
			);
			actions.push({ kind: "send-continue", teammate: teammate.id, inbox: teammate.inbox });
		} else if (limit.kind in LIMIT_NAMES) {
			const reset = limit.reset === undefined || Date.parse(limit.reset) + GRACE_MS <= now;
			if (reset && !stillHeld(after, limit.kind, teammate.role)) due.push(teammate);
		}
	}
	const continued = continueAll(due, "since its limit reset", at);
	return took(state, [...append, ...continued.append], [...actions, ...continued.actions]);
}

/**
 * The human's answer to a usage item. A far reset: `stay` keeps the usage
 * pause, `cancel` cancels the Effort as `/team cancel` does: every Teammate
 * stops and it ends without sign-off. A run-out retry ladder: `retry` sends `continue` and starts the
 * ladder again, `leave` hands the Teammate to the Lead.
 */
function answerUsage(state: EffortState, input: Extract<EffortInput, { kind: "answer-usage" }>): Step {
	const item = state.usageItems?.find((each) => each.id === input.id);
	if (!item) return { ok: false, refusal: `No usage item \`${input.id}\` waits on you in Effort \`${state.effortId}\`.` };
	const choices: readonly string[] = USAGE_CHOICES[item.why];
	if (!choices.includes(input.choice)) return { ok: false, refusal: `Usage item \`${item.id}\` takes ${quoted(choices)}, not \`${input.choice}\`.` };
	const answered: EffortLine = { type: "usage-answered", id: item.id, choice: input.choice, at: input.at };
	const teammate = state.teammates.find((each) => each.id === item.teammate);
	switch (input.choice) {
		case "stay":
			return took(state, [answered], [], `The Effort stays paused on its ${item.kind} limit; it lifts at its reset.`);
		case "cancel": {
			// It is `/team cancel`: every Teammate stops and the Effort ends without sign-off.
			const ended = step(state, { kind: "cancel", at: input.at });
			if (!ended.ok) return ended;
			return took(state, [answered, ...ended.append], ended.actions, `${ended.reply} It was waiting out its ${item.kind} limit.`);
		}
		case "retry":
			if (!teammate?.inbox || teammate.ended !== undefined) return took(state, [answered], [], `\`${item.teammate ?? "The Teammate"}\` can't be reached any more, so nothing was sent.`);
			return took(
				state,
				[answered, { type: "teammate-continued", teammate: teammate.id, why: "retry", tries: 0, at: input.at }],
				[{ kind: "send-continue", teammate: teammate.id, inbox: teammate.inbox }],
				`Sent \`continue\` to ${teammate.id}; if it fails again, the retry ladder starts over.`,
			);
		default:
			return took(
				state,
				[answered],
				[
					{
						kind: "wake-lead",
						text: `\`${item.teammate ?? "A Teammate"}\` still fails with ${item.kind.replace("_", " ")} after ${RETRY_MS.length} retries${teammate === undefined ? "" : ` on Task \`${teammate.task}\``}, and the human left it to you: wait, re-plan, or tell the human. Never change its model.`,
					},
				],
				"Left it to the Lead.",
			);
	}
}

/**
 * A `Stop`. Done means the round's result is written and not yet reported;
 * anything else is stopped short, and the Lead gets the last thing it said.
 */
function stopped(state: EffortState, teammate: Teammate, input: Extract<EffortInput, { kind: "journal" }>): Step {
	const due = currentResult(state, teammate.id);
	if (!due) return took(state, [], []);
	const { cursor, line } = input;
	const fresh = input.result.written && state.tasks[due.slug]?.reported !== due.round;
	if (fresh) {
		return took(
			state,
			[{ type: "task-done", teammate: teammate.id, cursor, slug: due.slug, round: due.round, at: line.at }],
			[{ kind: "wake-lead", text: `\`${teammate.id}\` finished round ${due.round} of Task \`${due.slug}\`: its result is ${input.result.path}. Read it and decide what comes next.` }],
		);
	}
	const message = text(line.payload?.last_assistant_message) ?? "";
	return took(
		state,
		[{ type: "teammate-stopped", teammate: teammate.id, cursor, slug: due.slug, message, at: line.at }],
		[
			{
				kind: "wake-lead",
				text: `\`${teammate.id}\` stopped short on Task \`${due.slug}\`: it stopped without writing a new ${input.result.path}. Its last message:\n\n${message || "(none)"}`,
			},
		],
	);
}

/**
 * The Lead's verdict on a Task's current round, taken only once that round's
 * `result-<round>.md` is written: a round is reviewed once, since accepting
 * ends the Task and a send-back starts the next round.
 */
function review(state: EffortState, input: Extract<EffortInput, { kind: "review" }>): Step {
	const task = state.tasks[input.slug];
	if (!task) {
		const handed = Object.keys(state.tasks);
		return {
			ok: false,
			refusal: `Task \`${input.slug}\` hasn't been handed off, so it has no result to review; ${handed.length > 0 ? `the handed-off Tasks are ${quoted(handed)}` : "no Task has been handed off yet"}.`,
		};
	}
	if (task.accepted !== undefined) {
		return { ok: false, refusal: `Task \`${input.slug}\` is already accepted (round ${task.round}), and an accepted Task is never reviewed again.` };
	}
	if (task.dropped !== undefined) {
		return { ok: false, refusal: `Task \`${input.slug}\` was dropped from the plan, so there is nothing to review; plan it again with \`team_plan\` and hand it off afresh.` };
	}
	if (underTakeover(state, task.teammate)) {
		return { ok: false, refusal: `The human has taken \`${task.teammate}\` over, so Task \`${input.slug}\` waits on them: review it once they hand it back, when you're woken with what they did.` };
	}
	if (briefHeld(state, input.slug)) {
		return {
			ok: false,
			refusal: `Task \`${input.slug}\` is held by Brief change \`${state.briefHold?.request}\`, which the human hasn't answered, so its result waits: it is reviewed against the Brief they settle on. Review the other Tasks meanwhile.`,
		};
	}
	if (!input.result.written) {
		return {
			ok: false,
			refusal: `Task \`${input.slug}\` has no new result to review: round ${task.round}'s ${input.result.path} isn't written yet. Wait for \`${task.teammate}\` to finish; you are woken when it does.`,
		};
	}
	if (task.reported !== task.round) {
		return {
			ok: false,
			refusal: `Task \`${input.slug}\` has no new result to review: \`${task.teammate}\` hasn't finished round ${task.round} yet, though ${input.result.path} is on disk. Wait for it to stop; you are woken when it does.`,
		};
	}
	if (task.merging !== undefined) {
		return {
			ok: false,
			refusal: `Task \`${input.slug}\` is being accepted: a merge of \`${task.worktree?.branch}\` into the Effort branch has been under way since ${task.merging}. Wait for it; nothing more to review.`,
		};
	}
	if (input.verdict === "accept" && task.worktree && state.workspace) {
		const { path, branch } = task.worktree;
		return took(
			state,
			[{ type: "merge-intended", slug: input.slug, branch, into: state.workspace.branch, at: input.at }],
			[{ kind: "merge", slug: input.slug, folder: task.folder, path, branch, into: state.workspace.path }],
			`Merging \`${branch}\` into \`${state.workspace.branch}\` to accept Task \`${input.slug}\` at round ${task.round}.`,
		);
	}
	if (input.verdict === "accept") {
		return took(
			state,
			[{ type: "task-accepted", slug: input.slug, round: task.round, at: input.at }],
			[{ kind: "write-plan" }],
			`Accepted Task \`${input.slug}\` at round ${task.round} (${input.result.path}). plan.md shows it accepted.`,
		);
	}
	const feedback = input.feedback?.trim() ?? "";
	if (feedback === "") {
		return { ok: false, refusal: `A send-back of Task \`${input.slug}\` needs feedback: say specifically what is wrong with round ${task.round}'s result and what would make it acceptable.` };
	}
	const sendBacks = task.sendBacks ?? 0;
	if (sendBacks >= input.sendBackLimit) {
		return {
			ok: false,
			refusal: `Task \`${input.slug}\` was sent back ${sendBacks} time${sendBacks === 1 ? "" : "s"}, the Playbook's \`sendBackLimit\` of ${input.sendBackLimit}, so it can't be sent back again. Escalate to the human instead: stop and tell them what is still wrong with ${input.result.path} and ask how to go on. You can still accept it.`,
		};
	}
	const current = state.teammates.find((each) => each.id === task.teammate);
	if (current?.ended !== undefined) return restaff(state, input, task, feedback, `send-back ${sendBacks + 1} of ${input.sendBackLimit}`);
	const inbox = current?.inbox;
	if (!inbox) {
		return {
			ok: false,
			refusal: `Task \`${input.slug}\` can't be sent back yet: \`${task.teammate}\` has no inbox socket on record, since its session hasn't reported a \`SessionStart\`. Stop and tell the human.`,
		};
	}
	return took(
		state,
		[{ type: "task-sent-back", slug: input.slug, round: task.round, at: input.at }],
		[
			{ kind: "send-back", teammate: task.teammate, inbox, slug: input.slug, folder: task.folder, round: task.round, feedback },
			{ kind: "write-plan" },
		],
		`Sent Task \`${input.slug}\` back to \`${task.teammate}\` (send-back ${sendBacks + 1} of ${input.sendBackLimit}) with feedback-${task.round}.md; it writes result-${task.round + 1}.md next, and you are woken when it does.`,
	);
}

/**
 * A send-back of a Task whose Teammate has ended: the staffing ladder gives
 * the next round, in the same folder where the Task, its results and the
 * feedback are, to another Teammate of its Role, reused, started under the
 * cap or in a free one's place. While none can take it, or a pause or a hold
 * on its Role stands, it queues, and starts by itself like any queued Task.
 */
function restaff(state: EffortState, input: Extract<EffortInput, { kind: "review" }>, task: HandedTask, feedback: string, count: string): Step {
	const back: EffortLine = { type: "task-sent-back", slug: input.slug, round: task.round, at: input.at };
	const after = apply(state, back);
	const wanted: QueuedTask = { slug: input.slug, folder: task.folder, role: task.role, why: "", at: input.at, ...(input.mode === undefined ? {} : { mode: input.mode }) };
	const write: EffortAction = { kind: "write-feedback", folder: task.folder, round: task.round, feedback };
	const sent = `Sent Task \`${input.slug}\` back (${count}) with feedback-${task.round}.md. \`${task.teammate}\` has ended`;
	const max = input.maxTeammates ?? DEFAULT_MAX_TEAMMATES;
	const pauses = heldPauses(after);
	const hold = holdOn(after, task.role);
	const staffed = pauses.length > 0 || hold ? undefined : staff(after, wanted, max);
	if (staffed) {
		const id = staffed.append.flatMap((line) => (line.type === "task-reassigned" ? [line.teammate] : []))[0] ?? "";
		return took(
			state,
			[back, ...staffed.append],
			[write, ...staffed.actions, { kind: "write-plan" }],
			`${sent}, so this ${staffed.who.replace(id, `\`${id}\``)} on it, pointed at the Task's folder; it writes result-${task.round + 1}.md next, and you are woken when it does.${staffed.note ? ` ${staffed.note}` : ""}`,
		);
	}
	const why = pauses.length > 0 ? "paused" : hold ? heldWhy(hold) : waitReason(after, max);
	const waits = pauses.length > 0 ? pauses.map(pauseText).join(", and ") : hold ? `Role \`${task.role}\` is held by ${holdText(hold)}` : why;
	return took(
		state,
		[back, { type: "task-queued", ...wanted, why }],
		[write, { kind: "write-plan" }],
		`${sent}, and no Teammate can take it now (${waits}), so it is queued: it starts by itself once one can, pointed at the Task's folder, and writes result-${task.round + 1}.md.`,
	);
}

/**
 * What the merge an isolated Task's accept intended came to. Merged, the Task
 * is accepted, its Teammate stopped and its worktree and branch removed; the
 * Teammate's session ends with its worktree. Refused by git, the merge is
 * recorded as failed and the Task stays in review, its branch intact, for the
 * Lead to fix what git named and review again.
 */
function mergeResult(state: EffortState, input: Extract<EffortInput, { kind: "merge-result" }>): Step {
	const task = state.tasks[input.slug];
	if (!task?.worktree || task.merging === undefined || !state.workspace) {
		return { ok: false, refusal: `Task \`${input.slug}\` has no merge under way.` };
	}
	const { path, branch } = task.worktree;
	const into = state.workspace.branch;
	if (input.error !== undefined) {
		return took(
			state,
			[{ type: "merge-failed", slug: input.slug, reason: input.error, at: input.at }],
			[],
			`Task \`${input.slug}\` isn't accepted: merging \`${branch}\` into \`${into}\` failed (${input.error}), and nothing was merged. It stays in review with its branch intact; fix that (or send it back) and review it again.`,
		);
	}
	const teammate = state.teammates.find((each) => each.id === task.teammate);
	const ending = teammate && isLive(teammate) ? teammate : undefined;
	return took(
		state,
		[
			{ type: "task-accepted", slug: input.slug, round: task.round, ...(input.commit === undefined ? {} : { merge: input.commit }), at: input.at },
			...(ending ? [{ type: "teammate-ended", teammate: ending.id, how: "stopped", at: input.at } as const] : []),
		],
		[
			...(ending ? [{ kind: "stop-teammate", teammate: ending.id, shortId: ending.shortId ?? ending.name } as const] : []),
			{ kind: "remove-task-workspace", slug: input.slug, path, branch },
			{ kind: "write-plan" },
		],
		`Accepted Task \`${input.slug}\` at round ${task.round}: ${input.commit === undefined ? `\`${branch}\` had nothing new, so nothing was` : `merged \`${branch}\` into \`${into}\` (${input.commit.slice(0, 12)}), and`} its worktree and branch are removed, with \`${task.teammate}\` stopped. plan.md shows it accepted.`,
	);
}

/** An isolated Task's worktree beside the Workspace and its branch, both named after the Effort's with the Task's number. */
function taskWorktree(workspace: Workspace, folder: string): TaskWorktree {
	const nnn = folder.slice(0, 3);
	return { path: `${workspace.path}-task-${nnn}`, branch: `${workspace.branch}-task-${nnn}` };
}

/** Where `teammate` works: its isolated Task's worktree, else the Effort's Workspace. */
export function workdir(state: EffortState, teammate: string): string | undefined {
	const slug = state.teammates.find((each) => each.id === teammate)?.task;
	const worktree = slug === undefined ? undefined : state.tasks[slug]?.worktree;
	return worktree?.path ?? state.workspace?.path;
}

/** Merges of isolated Tasks written ahead and not yet resolved, for recovery to finish or undo. */
export function openMerges(state: EffortState): { slug: string; branch: string; into: string }[] {
	return Object.entries(state.tasks).flatMap(([slug, task]) =>
		task.merging !== undefined && task.worktree && state.workspace ? [{ slug, branch: task.worktree.branch, into: state.workspace.branch }] : [],
	);
}

/** The checkpoints whose approval `approvals.jsonl` records ahead of the line, besides the Brief's. */
const RECORDED: ReadonlySet<string> = new Set([BRIEF_CHANGE, PLAYBOOK_CHANGE, SIGN_OFF]);
/** What an approval's shell does that is done once it is on record. */
const ON_RECORD: ReadonlySet<EffortAction["kind"]> = new Set(["promote-brief-change", "adopt-playbook-change", "record-sign-off"]);

/**
 * After a restart, before the journals are replayed: finish each intent left
 * open from the evidence the shell gathered. A launch is in when `claude
 * agents --json` lists its `--name` or the Teammate wrote to its journal, and
 * abandoned when neither; a merge already in the Effort branch is recorded,
 * one cut short is aborted and merged again, one not begun is merged; an
 * approval `approvals.jsonl` records with the approved sha (a Brief, a Brief
 * change, a Playbook change, a sign-off) is recorded as answered, and a
 * sign-off ends the Effort. Nothing done is done twice. What the evidence
 * can't settle stays open, and the Lead is told.
 */

function recover(state: EffortState, input: Extract<EffortInput, { kind: "recover" }>): Step {
	let next = state;
	const append: EffortLine[] = [];
	const actions: EffortAction[] = [];
	const add = (step: Step) => {
		if (!step.ok) return;
		next = step.state;
		append.push(...step.append);
		actions.push(...step.actions, ...(step.reply === undefined ? [] : [{ kind: "wake-lead", text: step.reply } as const]));
	};
	for (const [id, intent] of Object.entries(state.launching ?? {})) add(recoverLaunch(next, id, intent, input));
	for (const { slug } of openMerges(next)) add(recoverMerge(next, slug, input));
	for (const record of input.promoted ?? []) {
		const item = next.pending.find((pending) => pending.checkpoint === BRIEF && pending.id === record.request && pending.sha256 === record.brief);
		if (!item) continue;
		const answered = answer(next, { kind: "answer", id: item.id, answer: "approved", ...(record.workspace === undefined ? {} : { workspace: record.workspace }), at: input.at });
		// brief.md, the snapshots and the record are written already.
		add(answered.ok ? { ...answered, actions: answered.actions.filter((action) => action.kind !== "promote-brief") } : answered);
	}
	for (const record of input.recorded ?? []) {
		const item = next.pending.find((pending) => RECORDED.has(pending.checkpoint) && pending.id === record.request && pending.sha256 === record.sha256);
		if (!item) continue;
		const refresh = item.checkpoint === BRIEF_CHANGE && record.refresh && record.refresh.length > 0 ? { refresh: [...record.refresh] } : {};
		const terms = item.checkpoint === BRIEF_CHANGE && record.terms ? { terms: true } : {};
		const answered = answer(next, { kind: "answer", id: item.id, answer: "approved", ...refresh, ...terms, at: input.at });
		// The record is written ahead of the line: brief.md (which the shell finishes first), the adopted Playbook or the sign-off are on disk already.
		add(answered.ok ? { ...answered, actions: answered.actions.filter((action) => !ON_RECORD.has(action.kind)) } : answered);
	}
	const plan = actions.some((action) => action.kind === "write-plan");
	return { ok: true, state: next, append, actions: [...actions.filter((action) => action.kind !== "write-plan"), ...(plan ? [{ kind: "write-plan" } as const] : [])] };
}

function recoverLaunch(state: EffortState, id: string, intent: { name: string; lines: EffortLine[] }, input: Extract<EffortInput, { kind: "recover" }>): Step {
	// A Teammate started afresh keeps its `--name`, so `claude agents --json` may list its old session: only its new session's journal says it is in.
	const afresh = intent.lines.some((line) => line.type === "teammate-relaunched");
	if ((!afresh && input.agents?.includes(intent.name)) || input.journaled?.includes(id)) return took(state, intent.lines, [{ kind: "write-plan" }]);
	if (input.agents === undefined && !afresh) {
		return took(state, [], [], `\`${id}\` may not have started: its launch as \`${intent.name}\` was under way when pi stopped, \`claude agents --json\` couldn't be read, and it hasn't written to its journal. It is checked again at the next restart; until then nothing of its launch is on record.`);
	}
	const handed = intent.lines.find((line) => line.type === "task-handed-off");
	const sentBack = intent.lines.find((line) => line.type === "task-sent-back");
	const slug = handed?.slug ?? sentBack?.slug ?? "";
	const folder = handed?.folder ?? state.tasks[slug]?.folder ?? "";
	const abandoned = took(
		state,
		[{ type: "launch-abandoned", teammate: id, reason: "`claude agents --json` doesn't list it and it never wrote to its journal", at: input.at }],
		[
			...(handed?.worktree ? [{ kind: "remove-task-workspace", slug, ...handed.worktree } as const] : []),
			...(sentBack ? [{ kind: "discard-feedback", slug, folder, round: sentBack.round } as const] : []),
			// plan.md may have been written with the launch's lines.
			{ kind: "write-plan" },
		],
	);
	if (!abandoned.ok) return abandoned;
	const status = taskStatus(abandoned.state, slug);
	const next =
		status === "planned"
			? "hand it off again with `team_handoff`"
			: status === "queued"
				? "it stays queued, and starts when a Teammate frees up"
				: `send it back again with \`team_review\`; feedback-${sentBack?.round ?? 0}.md is removed`;
	if (afresh) {
		return {
			...abandoned,
			reply: `\`${id}\` wasn't started afresh before pi stopped: its new session never wrote to its journal, so nothing of its relaunch is on record. Its old session was stopped for it (its conversation kept), and it is still due a fresh start. Task \`${slug}\` is still ${status}; ${next}.`,
		};
	}
	return { ...abandoned, reply: `\`${id}\` didn't start before pi stopped: \`claude agents --json\` doesn't list \`${intent.name}\` and it never wrote to its journal, so nothing of its launch is on record. Task \`${slug}\` is still ${status}; ${next}.` };
}

function recoverMerge(state: EffortState, slug: string, input: Extract<EffortInput, { kind: "recover" }>): Step {
	const task = state.tasks[slug];
	const evidence = input.merges?.[slug];
	if (!task?.worktree || !state.workspace) return took(state, [], []);
	const { path, branch } = task.worktree;
	if (evidence === undefined) {
		return took(state, [], [], `The merge of Task \`${slug}\`'s \`${branch}\` into \`${state.workspace.branch}\`, under way when pi stopped, isn't finished, and git couldn't say where it stands. It stays open and is checked again at the next restart; have the human look at ${state.workspace.path}.`);
	}
	if (evidence.state === "merged") return mergeResult(state, { kind: "merge-result", slug, ...(evidence.commit === undefined ? {} : { commit: evidence.commit }), at: input.at });
	return took(state, [], [{ kind: "merge", slug, folder: task.folder, path, branch, into: state.workspace.path, ...(evidence.state === "half-done" ? { abort: true as const } : {}) }]);
}

/**
 * After a restart, once the journals are replayed: a reused Teammate whose
 * clear never came is cleared again, and a pointer sent and never landed is
 * sent again, unless the replay sent it (`sent`). A Teammate missing from
 * `claude agents --json` with no crash on record is idle-stopped: nothing
 * wakes it but the next send, so this wakes nobody.
 */
function reconcile(state: EffortState, input: Extract<EffortInput, { kind: "reconcile" }>): Step {
	const actions: EffortAction[] = [];
	// The hook reads the marker, so it must say what the Takeover lines say: pi may have stopped between the two.
	for (const teammate of input.marked === undefined ? [] : state.teammates) {
		const on = teammate.takeover !== undefined;
		if (on !== input.marked?.includes(teammate.id)) actions.push({ kind: "mark-takeover", teammate: teammate.id, on });
	}
	for (const teammate of live(state)) {
		if (teammate.takeover !== undefined) continue;
		const task = teammate.clearing === undefined ? undefined : state.tasks[teammate.clearing];
		if (teammate.clearing !== undefined && task && teammate.inbox) actions.push({ kind: "clear-then-send", teammate: teammate.id, inbox: teammate.inbox, slug: teammate.clearing, folder: task.folder });
	}
	// Started afresh with no `SessionStart` from its new session: while `claude agents --json` lists it, that is still to come.
	const unstarted = live(state).filter((teammate) => teammate.relaunching && input.agents !== undefined && !input.agents.includes(teammate.name));
	for (const [slug, round] of Object.entries(state.undelivered ?? {})) {
		const task = state.tasks[slug];
		const teammate = state.teammates.find((each) => each.id === task?.teammate);
		// A Teammate the human holds gets what it is owed at the hand-back.
		if (!task || !teammate || !isLive(teammate) || teammate.takeover !== undefined || teammate.clearing === slug || input.sent?.includes(slug)) continue;
		actions.push({ kind: "redeliver", teammate: teammate.id, slug, folder: task.folder, round });
	}
	const reply = unstarted
		.map(
			(teammate) =>
				`\`${teammate.id}\` was started afresh on Task \`${teammate.task}\` before pi stopped, but its new session never started: \`claude agents --json\` doesn't list \`${teammate.name}\` and it never wrote to its journal, so nobody works the Task. Stop and tell the human.`,
		)
		.join("\n");
	return took(state, [], actions, reply === "" ? undefined : reply);
}

/**
 * The one message that wakes the Lead after a restart, from everything that
 * needs it, with the Effort's `records` after an adoption or a fork, whose
 * Lead hasn't read them; undefined when nothing needs it.
 */
export function awayText(state: EffortState, texts: readonly string[], records?: readonly string[]): string | undefined {
	if (texts.length === 0) return undefined;
	return [
		`While you were away, Effort \`${state.effortId}\`:`,
		...texts.map((text) => `- ${text}`),
		...(records === undefined || records.length === 0 ? [] : ["", `Read its records first: ${records.join(", ")}.`]),
	].join("\n");
}

/**
 * Where Task `slug` stands: planned until handed off; then running, in review
 * once its round's result is reported, sent back while a later round is
 * worked, and accepted for good.
 */
export function taskStatus(state: EffortState, slug: string): TaskStatus {
	const task = state.tasks[slug];
	if (!task || task.dropped !== undefined) {
		if (state.queue.some((queued) => queued.slug === slug)) return "queued";
		// A dropped Task planned again waits for a fresh handoff.
		if (!task || state.plan?.some((planned) => planned.slug === slug)) return "planned";
		return "dropped";
	}
	if (task.accepted !== undefined) return "accepted";
	// A send-back whose Teammate ended waits in the queue for another.
	if (state.queue.some((queued) => queued.slug === slug)) return "queued";
	if (task.reported === task.round) return "in review";
	return task.round > 1 ? "sent back" : "running";
}

/** `HH:MM` of an ISO time, as Reports show it. */
function clock(at: string): string {
	return at.slice(11, 16);
}

/** What a Report says of one line since the last Report, or undefined for a line its own section tells of. */
function told(line: EffortLine, state: EffortState): string | undefined {
	switch (line.type) {
		case "approval-requested":
			if (line.checkpoint === SIGN_OFF) return `asked for your sign-off (\`${line.id}\`)`;
			if (line.checkpoint === PLAYBOOK_CHANGE) return `proposed Playbook change \`${line.change?.id}\` (\`${line.id}\`)`;
			if (line.checkpoint === BRIEF_CHANGE) return `asked you to approve a Brief change (\`${line.id}\`)${line.affects && line.affects.length > 0 ? `, holding ${quoted(line.affects)}` : ""}`;
			if (line.checkpoint !== BRIEF) return `asked you to approve checkpoint \`${line.checkpoint}\` (\`${line.id}\`)`;
			return `asked you to approve the Brief (\`${line.id}\`)`;
		case "approval-answered": {
			const asked = state.asked?.find((each) => each.id === line.id);
			if (asked?.checkpoint === PLAYBOOK_CHANGE) return `you ${line.answer === "approved" ? "adopted" : "declined"} Playbook change \`${asked.change}\` (\`${line.id}\`)`;
			if (asked?.checkpoint === SIGN_OFF) return line.answer === "approved" ? `you signed off (\`${line.id}\`)` : `you sent back the final Report (\`${line.id}\`): ${line.note ?? ""}`;
			if (asked?.checkpoint === BRIEF_CHANGE) return line.answer === "approved" ? `you approved a Brief change (\`${line.id}\`)` : `you sent back a Brief change (\`${line.id}\`): ${line.note ?? ""}`;
			if (asked !== undefined && asked.checkpoint !== BRIEF) {
				return line.answer === "approved" ? `you approved checkpoint \`${asked.checkpoint}\` (\`${line.id}\`)` : `you sent back checkpoint \`${asked.checkpoint}\` (\`${line.id}\`): ${line.note ?? ""}`;
			}
			return line.answer === "approved" ? `you approved the Brief (\`${line.id}\`)` : `you sent back \`${line.id}\`: ${line.note ?? ""}`;
		}
		case "plan-written":
			return `${line.reason === undefined ? "planned" : "re-planned"} ${line.tasks.length} Task${line.tasks.length === 1 ? "" : "s"}`;
		case "task-handed-off":
			return `handed Task \`${line.slug}\` to ${line.teammate}`;
		case "task-queued":
			return `queued Task \`${line.slug}\`: ${line.why}`;
		case "teammate-retired":
			return `stopped idle ${line.teammate} to make room`;
		case "task-done":
			return `${line.teammate} finished round ${line.round} of Task \`${line.slug}\``;
		case "teammate-stopped":
			return `${line.teammate} stopped short on Task \`${line.slug}\``;
		case "escalated":
			return `escalated ${escalationText(line, state, false)} (\`${line.id}\`) to you: ${line.summary}`;
		case "escalation-answered": {
			const relayed = line.via === "lead" ? " (in chat, relayed by the Lead)" : "";
			if (line.decision === "allow" || line.decision === "deny") {
				const permission = state.escalations?.[line.id]?.kind === "permission";
				const verb = permission ? (line.decision === "allow" ? "allowed" : "denied") : "declined";
				return `you ${verb} \`${line.id}\`: ${line.answer}${relayed}`;
			}
			return `you answered \`${line.id}\`: ${line.answer}${relayed}`;
		}
		case "message-sent":
			return `sent ${line.teammate} a message`;
		case "task-sent-back":
			return `sent Task \`${line.slug}\` back after round ${line.round}`;
		case "task-accepted":
			return `accepted Task \`${line.slug}\` at round ${line.round}`;
		case "merge-failed":
			return `the merge of Task \`${line.slug}\` failed: ${line.reason}`;
		case "paused":
			return `${line.by === "human" ? "you" : line.by === "lead" ? "the Lead" : "a usage limit"} paused the Effort${line.reason === undefined ? "" : `: ${line.reason}`}`;
		case "resumed":
			return line.by === "human" ? "you lifted your pause" : line.by === "lead" ? "the Lead lifted its pause" : "the usage pause lifted";
		case "permission-denied":
			return `${line.teammate} was denied \`${line.tool}\`${line.reason === undefined ? "" : `: ${line.reason}`}`;
		case "request-settled":
			return settledText(line.teammate, line.request, line.how);
		case "teammate-limited":
			return `${line.teammate} ${limitTold(line.limit)}`;
		case "model-released":
			return `the ${line.family === "opus" ? "Opus" : line.family === "sonnet" ? "Sonnet" : "Fable"} hold lifted`;
		case "usage-answered":
			return `you answered \`${line.id}\`: ${line.choice}`;
		default:
			return undefined;
	}
}

/**
 * The Lead's Report: its narrative, with the logged sections added from what
 * happened since the last one. Each section is left out when it has nothing
 * new. Work the Lead found outside the Brief joins the found-work log first.
 */
function report(state: EffortState, input: Extract<EffortInput, { kind: "report" }>): Step {
	if (!state.brief) {
		return {
			ok: false,
			refusal: `Effort \`${state.effortId}\` has no approved Brief yet, so there is nothing to report against; the first Report is the plan Report, written once the human approves the Brief and you have planned.`,
		};
	}
	const headline = input.headline.trim();
	const coverage = input.coverage ?? [];
	const problems: string[] = [];
	if (headline === "") problems.push("the headline is empty; say in a sentence where the Effort stands");
	for (const { criterion } of coverage) {
		if (!input.criteria.includes(criterion)) problems.push(`coverage names \`${criterion}\`, which the Brief doesn't have; its criteria are ${quoted(input.criteria)}`);
	}
	if (input.final) problems.push(...finalProblems(coverage, input.criteria, input.final.changes));
	if (problems.length > 0) {
		return { ok: false, refusal: `The Report for Effort \`${state.effortId}\` can't be written until these are fixed:\n${problems.map((problem) => `- ${problem}`).join("\n")}` };
	}
	// Found work is logged once: text already on record, or repeated within this Report, is dropped (trimmed, case-insensitive).
	const onRecord = new Set(state.found.map((each) => each.what.trim().toLowerCase()));
	const found: EffortLine[] = [];
	for (const what of (input.found ?? []).map((each) => each.trim()).filter((each) => each !== "")) {
		if (onRecord.has(what.toLowerCase())) continue;
		onRecord.add(what.toLowerCase());
		found.push({ type: "found-work", what, at: input.at });
	}
	const now = found.reduce(apply, state);
	const n = state.reports + 1;
	const usage = { title: "Usage", lines: usageLines(now, input.leadCostUsd) };
	// The final Report tells every Task and all found work, not only what moved, so its own sections replace the logged ones; usage stays last, as in every Report.
	const kept = reportSections(now, n === 1 ? input.modes : undefined);
	const logged = input.final ? [...kept.filter((each) => each.title !== "Plan" && each.title !== "Found work"), ...finalSections(now, input.final)] : kept;
	const sections = [...logged, usage].filter((each) => each.lines.length > 0);
	const written: Report = { n, at: input.at, headline, coverage, sections, ...(input.final ? { final: true as const } : {}) };
	const file = `reports/${String(n).padStart(3, "0")}.md`;
	return took(
		state,
		[...found, { type: "report-written", n, ...(input.final ? { final: true as const } : {}), at: input.at }],
		[{ kind: "write-report", report: written }],
		`${input.final ? "The final Report" : "Report"} ${n} of Effort \`${state.effortId}\` is written as ${file}. The human sees it in chat, so don't repeat it.${input.final ? "" : foundOnRecord(now)}`,
	);
}

/** The found work already on record, told to the Lead so the next Report's `found` has only new items; empty when there is none. */
function foundOnRecord(state: EffortState): string {
	if (state.found.length === 0) return "";
	return `\nFound work already on record (${state.found.length}), don't report these again, not even reworded:\n${state.found.map((each) => `- ${each.what}`).join("\n")}`;
}

/** What keeps a final Report from being written: a criterion without evidence, or a proposed change that isn't well formed. */
function finalProblems(coverage: readonly { criterion: string; note: string }[], criteria: readonly string[], changes: readonly PlaybookChange[]): string[] {
	const problems: string[] = [];
	for (const criterion of criteria) {
		if (!coverage.some((each) => each.criterion === criterion && each.note.trim() !== "")) {
			problems.push(`the final Report maps every criterion to evidence, and \`${criterion}\` has none; give it a \`coverage\` note saying what shows it is met`);
		}
	}
	const seen = new Set<string>();
	for (const change of changes) {
		if (!KEBAB.test(change.id)) problems.push(`the Playbook change id \`${change.id}\` must be kebab-case, such as \`qa-before-dev\``);
		if (seen.has(change.id)) problems.push(`the Playbook change \`${change.id}\` is proposed more than once; propose each change once`);
		seen.add(change.id);
		if (change.summary.trim() === "") problems.push(`the Playbook change \`${change.id}\` has no summary; say in a sentence what it changes and why`);
		if (change.oldText.trim() === "") problems.push(`the Playbook change \`${change.id}\` has no \`oldText\`; quote the passage of the Playbook it replaces`);
		else if (change.newText === change.oldText) problems.push(`the Playbook change \`${change.id}\` leaves its passage as it is; \`newText\` must differ from \`oldText\``);
	}
	return problems;
}

/** What each checkpoint is called in the final Report. */
const CHECKPOINT_NAMES: Record<string, string> = { [BRIEF]: "Brief", [BRIEF_CHANGE]: "Brief change", [SIGN_OFF]: "Sign-off", [PLAYBOOK_CHANGE]: "Playbook change" };

/** A checkpoint's name in the final Report: a Playbook checkpoint or \`escalate\` id goes by its id. */
function checkpointName(checkpoint: string): string {
	return CHECKPOINT_NAMES[checkpoint] ?? `\`${checkpoint}\``;
}

/** How an asked request ended, as the final Report tells it. */
function outcomeText(asked: Asked): string {
	const outcome = asked.outcome;
	if (outcome === undefined) return `asked at ${clock(asked.at)} UTC, waiting`;
	const how = { approved: "approved", "sent-back": "sent back", declined: "declined", replaced: "replaced by a newer request", dropped: "dropped" }[outcome.how];
	return `${how} at ${clock(outcome.at)} UTC${outcome.note === undefined ? "" : `: ${outcome.note}`}`;
}

/**
 * The final Report's own sections, always present so a gap shows: every Task
 * with its Role and the model it ran on, every checkpoint with its approval (a
 * Playbook checkpoint never asked says so), all found work, each proposed
 * Playbook change, and what happens to each worktree at sign-off.
 */
function finalSections(state: EffortState, final: FinalFacts): ReportSection[] {
	const asked = (state.asked ?? []).filter((each) => each.checkpoint !== PLAYBOOK_CHANGE);
	const askedAt = new Set<string>(asked.map((each) => each.checkpoint));
	const model = (role: string) => (final.models[role] === undefined ? "Claude Code's default model" : `\`${final.models[role]}\``);
	return [
		{
			title: "Tasks",
			lines:
				(state.plan ?? []).length === 0
					? ["none"]
					: [...(state.plan ?? []).map((task) => `\`${task.slug}\` (${task.role}, on ${model(task.role)}): ${taskStatus(state, task.slug)}`), ...replanReasons(state)],
		},
		{
			title: "Checkpoints",
			lines: [
				`Playbook: adopted before the Effort opened (sha256 ${state.playbook})`,
				...asked.map((each) => `${checkpointName(each.checkpoint)}: \`${each.id}\` ${outcomeText(each)} (sha256 ${each.sha256})`),
				...final.checkpoints.filter((id) => !askedAt.has(id)).map((id) => `\`${id}\`: never asked`),
			],
		},
		{ title: "Found work", lines: state.found.length === 0 ? ["none"] : state.found.map((each) => `${each.what}${each.task === undefined ? "" : ` (Task \`${each.task}\`)`}`) },
		{
			title: "Proposed Playbook changes",
			lines:
				final.changes.length === 0
					? ["none"]
					: [
							...final.changes.map((change) => `\`${change.id}\`: ${change.summary}`),
							"Each is adopted or declined on its own in `/team pending`. An adopted one is the Playbook of the next Effort; this Effort keeps its snapshot.",
						],
		},
		{
			title: "Worktrees",
			lines:
				final.worktrees.length === 0
					? ["none"]
					: final.worktrees.map(
							(each) => `${each.path} (\`${each.branch}\`): ${each.dirty ? "has uncommitted changes, so it is kept" : "clean, removed at sign-off"}; the branch is kept`,
						),
		},
	];
}

/** `412k`, `1.2M`: a token count as a Report gives it. */
function tokenCount(tokens: number): string {
	if (tokens < 1000) return String(Math.round(tokens));
	if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function dollars(usd: number): string {
	return `$${usd.toFixed(2)}`;
}

/** Where a reading came from, as the Report and the Team block name it. */
export function usageSource(reading: UsageReading): string {
	return reading.source === "status-line" ? `${reading.teammate}'s status line` : "get_usage";
}

/**
 * Whether a window reset since its first reading: its reset time moved later by
 * more than the sources' rounding (they spell one moment differently), or the
 * reading is past the first reset time. An unparseable time says nothing.
 */
function windowReset(firstResetsAt: string | undefined, nowResetsAt: string | undefined, readAt: string): boolean {
	const first = Date.parse(firstResetsAt ?? "");
	if (Number.isNaN(first)) return false;
	const moved = Date.parse(nowResetsAt ?? "") - first;
	return moved > 60 * 60 * 1000 || Date.parse(readAt) > first;
}

/**
 * The Report's usage: the freshest account reading with its change since the
 * Effort began, each Role's tokens and estimate summed across its Teammates'
 * sessions, and the Lead's own cost. Empty with no reading and no Lead cost.
 */
function usageLines(state: EffortState, leadCostUsd: number | undefined): string[] {
	const lines: string[] = [];
	const usage = state.usage;
	if (usage !== undefined) {
		const window = (label: string, now: UsageWindow | undefined, first: UsageWindow | undefined): string => {
			if (now === undefined) return `${label} n/a`;
			const reset = windowReset(first?.resetsAt, now.resetsAt, usage.latest.at);
			const change = first === undefined ? "" : reset ? " (reset since the Effort began)" : ` (${now.percent - first.percent >= 0 ? "+" : ""}${Math.round(now.percent - first.percent)} since the Effort began)`;
			return `${label} ${Math.round(now.percent)}%${change}`;
		};
		const { latest } = usage;
		lines.push(`Account, from ${usageSource(latest)} at ${clock(latest.at)} UTC: ${window("5h", latest.fiveHour, usage.first.fiveHour)} · ${window("week", latest.sevenDay, usage.first.sevenDay)}. It includes your own use outside the Team.`);
		const byRole = new Map<string, { tokens: number; costUsd: number }>();
		for (const teammate of state.teammates) {
			const sessions = Object.values(usage.spend[teammate.id] ?? {});
			if (sessions.length === 0) continue;
			const sum = byRole.get(teammate.role) ?? { tokens: 0, costUsd: 0 };
			for (const each of sessions) {
				sum.tokens += each.tokens + each.banked.tokens;
				sum.costUsd += each.costUsd + each.banked.costUsd;
			}
			if (sum.tokens === 0) continue;
			byRole.set(teammate.role, sum);
		}
		if (byRole.size > 0) {
			const roles = [...byRole].sort(([a], [b]) => a.localeCompare(b)).map(([role, sum]) => `${role} ${tokenCount(sum.tokens)} tokens ≈ ${dollars(sum.costUsd)}`);
			const label = usage.rateLimits ? "*API-price equivalent, not your bill.*" : "No reading has `rate_limits`, as with an API key, so the estimate is the nearest thing to a charge.";
			lines.push(`By Role: ${roles.join(" · ")}. ${label}`);
		}
	}
	if (leadCostUsd !== undefined && leadCostUsd > 0) lines.push(`The Lead: ${dollars(leadCostUsd)}, as pi reports it.`);
	return lines;
}

/** Why the Lead re-planned since the last Report, one line for each re-plan that gave a reason. */
function replanReasons(state: EffortState): string[] {
	return state.sinceReport.flatMap((line) => (line.type === "plan-written" && line.reason !== undefined ? [`re-planned at ${clock(line.at)}: ${line.reason}`] : []));
}

/** The logged sections, from `since` the last Report; the plan Report passes each Role's mode. */
function reportSections(state: EffortState, modes: readonly { role: string; mode: string }[] | undefined): ReportSection[] {
	const since = state.sinceReport;
	const of = <T extends EffortLine["type"]>(type: T) => since.filter((line): line is Extract<EffortLine, { type: T }> => line.type === type);
	const planChanged = modes !== undefined || since.some((line) => ["plan-written", "task-handed-off", "task-done", "task-sent-back", "task-accepted"].includes(line.type));
	const plan = state.plan && planChanged ? state.plan.map((task) => `\`${task.slug}\` (${task.role}): ${taskStatus(state, task.slug)}`) : [];
	const reasons = replanReasons(state);
	const newFound = of("found-work");
	const launched = (id: string) => state.teammates.find((each) => each.id === id)?.mode;
	return [
		{ title: "Since the last Report", lines: since.flatMap((line) => { const text = told(line, state); return text === undefined || !("at" in line) ? [] : [`${clock(line.at)} ${text}`]; }) },
		{ title: "Plan", lines: [...plan, ...reasons] },
		{
			title: "Waiting on you",
			lines: [
				...state.pending.map((item) =>
					item.checkpoint === SIGN_OFF
						? `\`${item.id}\`: sign off the final Report, ${item.path} (sha256 ${item.sha256}), in \`/team pending\``
						: item.checkpoint === PLAYBOOK_CHANGE
							? `\`${item.id}\`: adopt or decline Playbook change \`${item.change?.id}\`, in \`/team pending\``
							: item.checkpoint === BRIEF
								? `\`${item.id}\`: approve the Brief, ${item.path} (sha256 ${item.sha256}), in \`/team pending\``
								: `\`${item.id}\`: approve ${requestName(item)}, ${item.path} (sha256 ${item.sha256})${item.affects && item.affects.length > 0 ? `, holding ${quoted(item.affects)}` : ""}, in \`/team pending\``,
				),
				...waitingInTerminal(state).map((held) => `\`${held.request}\`: ${terminalText(held)}`),
				...[waitingConfirm(state)].flatMap((hold) => (hold ? [`\`${hold.teammate}\`: a usage-credit confirm waits in its terminal, which only you answer: attach to it from \`/team pending\` or \`/team\``] : [])),
				...openEscalations(state).map((escalation) => `\`${escalation.id}\`: ${escalationText(escalation, state)}, escalated: ${escalation.summary} Answer it in \`/team pending\``),
				...(state.usageItems ?? []).map((item) => `\`${item.id}\`: ${usageText(item, state.teammates)}, in \`/team pending\``),
			],
		},
		{ title: "Decided for you", lines: of("decided-for-you").map((line) => `${clock(line.at)} ${line.what}${line.task === undefined ? "" : ` (Task \`${line.task}\`)`}`) },
		{
			title: "Teammate modes",
			lines: [
				...(modes ?? []).map(({ role, mode }) => `${role}: ${mode}`),
				...of("teammate-mode").map((line) => `${line.teammate}: ${line.mode}${launched(line.teammate) === undefined ? "" : `, launched in ${launched(line.teammate)}`} (${clock(line.at)})`),
			],
		},
		{
			title: "Found work",
			lines:
				state.found.length === 0
					? []
					: newFound.length === 0
						? [`${state.found.length} found so far outside the Brief, kept as suggestions for the final Report; none new since the last Report.`]
						: [
							`${state.found.length} found so far outside the Brief, kept as suggestions for the final Report; new since the last Report:`,
							...newFound.map((line) => `${line.what}${line.task === undefined ? "" : ` (Task \`${line.task}\`)`}`),
						],
		},
	];
}
