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

import { askText, closedText, type HeldRequest, type HookDecision, isCallOf, type RequestAnswer, settledText, takeAnswer, terminalText } from "./requests.ts";

/** The one checkpoint an Effort has before its Brief is approved. */
export const BRIEF = "brief";

/** A request the human answers in `/team pending`, with what they would approve. */
export interface PendingApproval {
	/** Unique within the Effort: `r1`, `r2`, … */
	id: string;
	checkpoint: typeof BRIEF;
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
}

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
	| { type: "approval-answered"; id: string; answer: "approved" | "sent-back"; note?: string; workspace?: Workspace; at: string }
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
	| { type: "report-written"; n: number; at: string }
	/** `by` paused the Effort: no new Task starts until every pause is lifted. */
	| ({ type: "paused" } & Pause)
	/** `by` lifted its own pause. */
	| { type: "resumed"; by: PauseSetter; at: string }
	/** A Task queued while paused waits on, once the Effort runs, for this reason instead. */
	| { type: "task-requeued"; slug: string; why: string; at: string }
	/** A `PermissionRequest` the Teammate's hook holds open for the first answer, the Lead's or the human's in the terminal. */
	| ({ type: "request-held"; cursor: number } & Omit<HeldRequest, "state">)
	/** The terminal settled a held request: answered there, denied there, or left there once the hook's hold ran out. */
	| { type: "request-settled"; teammate: string; cursor: number; request: string; how: "answered-in-terminal" | "denied-in-terminal" | "expired"; at: string }
	/** The Lead answered a held request through its hook, adding `rule` for the Teammate's session. Reads no journal line. */
	| { type: "request-answered"; teammate: string; request: string; task?: string; decision: HookDecision; rule?: string; at: string };

/** Who set a pause, the only one who lifts it: the human, the Lead, or a usage limit. */
export type PauseSetter = "human" | "lead" | "usage";

/** A pause that holds. */
export interface Pause {
	by: PauseSetter;
	reason?: string;
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
}

/** What an Effort's lines fold to. */
export interface EffortState {
	effortId: string;
	team: string;
	/** The git root the Effort works on. */
	repo: string;
	/** The sha256 of the Playbook in force when the Effort was opened. */
	playbook: string;
	/** Set once the human approves the Brief; until then no Teammate starts. */
	brief?: { sha256: string; approvedAt: string; request: string };
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
	/** Every request a Teammate's hook held for an answer, by request id, oldest first. */
	teammateRequests: Record<string, HeldRequest>;
}

/** A new input to the core. */
export type EffortInput =
	/** `team_request_approval`, with the draft already validated and snapshotted. */
	| { kind: "request-approval"; checkpoint: string; path: string; sha256: string; snapshot: string; at: string }
	/** The human's answer to a pending item, with the Workspace the shell added for an approved Brief. */
	| { kind: "answer"; id: string; answer: "approved" | "sent-back"; note?: string; workspace?: Workspace; at: string }
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
			at: string;
	  }
	/**
	 * `team_handoff` of a planned Task, with the permission mode a Teammate
	 * started for it launches in and the cap of live Teammates (pi's
	 * `maxTeammates` setting, {@link DEFAULT_MAX_TEAMMATES} by default).
	 */
	| { kind: "handoff"; slug: string; at: string; mode?: string; maxTeammates?: number; isolated?: boolean }
	/** What the merge an accept intended came to: merge commit `commit` (absent when there was nothing to merge), or why git refused it, nothing half-done. */
	| { kind: "merge-result"; slug: string; commit?: string; error?: string; at: string }
	/**
	 * Line `cursor` of `teammate`'s journal (counted from 1), with whether the
	 * result its current Task is due to write ({@link currentResult}) is on disk.
	 */
	| { kind: "journal"; teammate: string; cursor: number; line: JournalLine; result: { path: string; written: boolean } }
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
			at: string;
	  }
	/**
	 * Start the first queued Task the staffing ladder can staff now, with the
	 * cap of live Teammates. The shell asks after each acceptance, once the
	 * acceptance is on record, and again while one starts: each start is its
	 * own step, so a launch that fails leaves only its own Task queued.
	 */
	| { kind: "drain"; at: string; maxTeammates?: number }
	/** The human used the `/team` menu on a Teammate: attached here, in a tmux window, or took the command. */
	| { kind: "attach"; teammate: string; at: string }
	/** `/team pause` from the human, or `team_pause` from the Lead, which must give a reason. */
	| { kind: "pause"; by: "human" | "lead"; reason?: string; at: string }
	/** `/team resume` from the human in a session holding the Effort, or `team_resume` from the Lead: each lifts only its own pause. */
	| { kind: "resume"; by: "human" | "lead"; at: string }
	/** `team_answer` of a held request. */
	| ({ kind: "answer-request"; at: string } & RequestAnswer);

/** Work the core leaves to the shell. */
export type EffortAction =
	/** Write the approved Brief as `brief.md`, snapshot the Team and the Playbook, and record the act. */
	| { kind: "promote-brief"; approval: PendingApproval; at: string }
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
	 * Write `feedback` as `feedback-<round>.md` in the Task's folder, then
	 * launch a new Teammate on the Task, since its own has ended: its pointer
	 * names `task.md`, the results and feedback so far, and `result-<round + 1>.md`.
	 */
	| { kind: "restaff-teammate"; teammate: Omit<Teammate, "task" | "startedAt">; slug: string; folder: string; round: number; feedback: string }
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
	 */
	| ({ kind: "merge"; slug: string; folder: string; into: string } & TaskWorktree)
	/** Remove a merged Task's worktree and its branch, once its Teammate is stopped. */
	| ({ kind: "remove-task-workspace"; slug: string } & TaskWorktree)
	/** Send the decision to the hook holding `request`, which prints it for Claude Code. */
	| { kind: "answer-hook"; request: string; teammate: string; decision: HookDecision };

export type Step =
	| { ok: true; state: EffortState; append: EffortLine[]; actions: EffortAction[]; reply?: string }
	| { ok: false; refusal: string };

/** The first line of a new Effort. */
export function openEffort(opened: { effortId: string; team: string; repo: string; playbook: string; at: string }): EffortLine {
	return { type: "effort-opened", ...opened };
}

/** Lines a Report doesn't tell of: they only carry what other lines say. */
const UNREPORTED: ReadonlySet<EffortLine["type"]> = new Set(["effort-opened", "teammate-started", "teammate-session", "prompt-landed", "report-written", "teammate-attached", "clear-requested", "request-held", "request-answered"]);

/** Fold one line into the state, keeping what the next Report tells of. */
function apply(state: EffortState, line: EffortLine): EffortState {
	const next = applyLine(state, line);
	if (line.type === "report-written") return { ...next, reports: line.n, sinceReport: [] };
	return UNREPORTED.has(line.type) ? next : { ...next, sinceReport: [...next.sinceReport, line] };
}

function applyLine(state: EffortState, line: EffortLine): EffortState {
	switch (line.type) {
		case "effort-opened":
			throw new Error(`effort.jsonl opens Effort \`${state.effortId}\` a second time, as \`${line.effortId}\``);
		case "approval-requested": {
			const { type: _type, ...approval } = line;
			// A newer request at the same checkpoint replaces one the human hasn't answered.
			return {
				...state,
				pending: [...state.pending.filter((item) => item.checkpoint !== approval.checkpoint), approval],
				requests: state.requests + 1,
			};
		}
		case "approval-answered": {
			const answered = state.pending.find((item) => item.id === line.id);
			const pending = state.pending.filter((item) => item.id !== line.id);
			if (line.answer === "approved" && answered?.checkpoint === BRIEF) {
				return {
					...state,
					pending,
					brief: { sha256: answered.sha256, approvedAt: line.at, request: answered.id },
					...(line.workspace === undefined ? {} : { workspace: line.workspace }),
				};
			}
			return { ...state, pending };
		}
		case "plan-written":
			return { ...state, plan: line.tasks };
		case "teammate-started": {
			const { type: _type, ...teammate } = line;
			return { ...state, teammates: [...state.teammates, teammate] };
		}
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
			return { ...state, teammates: state.teammates.map((teammate) => (teammate.id === line.teammate ? { ...teammate, clearing: line.slug } : teammate)) };
		case "teammate-retired":
			return { ...state, teammates: state.teammates.map((teammate) => (teammate.id === line.teammate ? { ...teammate, retiredAt: line.at } : teammate)) };
		case "teammate-session": {
			const before = state.teammates.find((teammate) => teammate.id === line.teammate)?.shortId;
			const changed = withTeammate(state, line, {
				sessionId: line.sessionId,
				shortId: line.shortId,
				...(line.inbox === undefined ? {} : { inbox: line.inbox }),
				// A short id that replaces another is a new attach target, marked until the human attaches to it.
				...(before !== undefined && before !== line.shortId ? { newShortId: true } : {}),
			});
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
			return withTeammate(state, line, { activity: "busy", doing: undefined });
		case "permission-denied":
			return withTeammate(state, line, {});
		case "task-sent-back": {
			const task = state.tasks[line.slug];
			return task ? withTask(state, line.slug, { round: line.round + 1, sendBacks: (task.sendBacks ?? 0) + 1 }) : state;
		}
		case "task-accepted":
			return merged(withTask(state, line.slug, { accepted: line.at }), line.slug);
		case "merge-intended":
			return withTask(state, line.slug, { merging: line.at });
		case "merge-failed":
			return merged(state, line.slug);
		case "teammate-stopped":
			return endRequests(withTeammate(state, line, { activity: "idle", doing: "stopped short" }), line.teammate);
		case "teammate-mode":
			return withTeammate(state, line, { observedMode: line.mode });
		case "task-dropped":
			return { ...withTask(state, line.slug, { dropped: line.at }), queue: state.queue.filter((queued) => queued.slug !== line.slug) };
		case "task-reassigned":
			return withTask(state, line.slug, { teammate: line.teammate });
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
		case "request-held": {
			const { type: _type, cursor: _cursor, ...held } = line;
			return { ...withTeammate(state, line, {}), teammateRequests: { ...state.teammateRequests, [line.request]: { ...held, state: "held" } } };
		}
		case "request-settled":
			return withRequest(withTeammate(state, line, {}), line.request, line.how);
		case "request-answered": {
			const answered = withRequest(state, line.request, "answered");
			if (line.rule === undefined) return answered;
			const rule = { rule: line.rule, ...(line.task === undefined ? {} : { task: line.task }) };
			return {
				...answered,
				teammates: answered.teammates.map((teammate) => (teammate.id === line.teammate ? { ...teammate, rules: [...(teammate.rules ?? []), rule] } : teammate)),
			};
		}
		case "task-done": {
			const advanced = endRequests(withTeammate(state, line, { activity: "idle", doing: `round ${line.round} done` }), line.teammate);
			const task = advanced.tasks[line.slug];
			return task ? { ...advanced, tasks: { ...advanced.tasks, [line.slug]: { ...task, reported: line.round } } } : advanced;
		}
	}
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
	switch (input.kind) {
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
		case "answer-request":
			return answerRequest(state, input);
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
	return `paused by ${SETTER_NAMES[pause.by]} since ${clock(pause.at)} UTC${pause.reason === undefined ? "" : `: ${pause.reason}`}`;
}

/** Who lifts a pause and how. */
function lifter(pause: Pause): string {
	if (pause.by === "human") return "only the human lifts it, with `/team resume`";
	if (pause.by === "lead") return "only the Lead lifts it, with `team_resume`";
	return "it lifts at its reset";
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
	const held = state.teammateRequests[input.request];
	if (!held) {
		const open = Object.values(state.teammateRequests).filter((each) => each.state === "held").map((each) => each.request);
		return {
			ok: false,
			refusal: `No request \`${input.request}\` waits on you: ${open.length === 0 ? "no request is held right now" : `the requests held now are ${quoted(open)}`}.`,
		};
	}
	if (held.state !== "held") return { ok: false, refusal: closedText(held) };
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
export function refuseRequest(state: EffortState, checkpoint: string): string | undefined {
	if (checkpoint !== BRIEF) {
		return `Effort \`${state.effortId}\` has no checkpoint \`${checkpoint}\` open; the one checkpoint before Teammates start is \`${BRIEF}\`.`;
	}
	if (state.brief) {
		return `The Brief of Effort \`${state.effortId}\` is already approved (sha256 ${state.brief.sha256}, ${state.brief.approvedAt}), and an approved Brief is never edited.`;
	}
	return undefined;
}

function requestApproval(state: EffortState, input: Extract<EffortInput, { kind: "request-approval" }>): Step {
	const refusal = refuseRequest(state, input.checkpoint);
	if (refusal !== undefined) return { ok: false, refusal };
	const replaced = state.pending.find((item) => item.checkpoint === BRIEF);
	const id = `r${state.requests + 1}`;
	const { kind: _kind, ...asked } = input;
	const line: EffortLine = { type: "approval-requested", id, ...asked, checkpoint: BRIEF };
	const reply = [
		`Asked the human to approve the Brief of Effort \`${state.effortId}\` as request \`${id}\`: ${input.path} (sha256 ${input.sha256}).`,
		replaced ? `It replaces request \`${replaced.id}\`, which the human hadn't answered.` : undefined,
		"They answer it in `/team pending`; approving promotes exactly this snapshot, so later edits to the draft don't count. Stop here and wait for their answer.",
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
	const staffed = staff(state, wanted, max);
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

/** Live Teammates: started, not stopped to make room, and not ended by a drop or a crash. */
function live(state: EffortState): Teammate[] {
	return state.teammates.filter((teammate) => teammate.retiredAt === undefined && teammate.ended === undefined);
}

/** Whether `teammate` is between Tasks: its Task is accepted and it hasn't been given another. */
function free(state: EffortState, teammate: Teammate): boolean {
	return state.tasks[teammate.task]?.accepted !== undefined && teammate.clearing === undefined;
}

/**
 * The staffing ladder, for a Task about to start: reuse an idle Teammate of
 * its Role whose Task is accepted (cleared first, never mid-Task); else start
 * a new one under the cap; else, at the cap, stop a free Teammate of a Role
 * with no Task queued and start one in its place. Undefined when none applies,
 * and the Task queues. A queued Task taken here leaves the queue.
 */
function staff(state: EffortState, task: QueuedTask, max: number): { append: EffortLine[]; actions: EffortAction[]; who: string; note?: string } | undefined {
	const handed = { type: "task-handed-off", slug: task.slug, folder: task.folder, role: task.role, at: task.at, round: 1 } as const;
	// An isolated Task needs a Teammate launched in its own worktree, so it never reuses one.
	const reused = task.isolated ? undefined : live(state).find((teammate) => teammate.role === task.role && teammate.inbox !== undefined && free(state, teammate));
	if (reused?.inbox) {
		return {
			append: [
				{ ...handed, teammate: reused.id },
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
			{ type: "task-handed-off", slug: task.slug, folder: task.folder, role: task.role, teammate: id, at: task.at, round: 1, ...(worktree ? { worktree } : {}) },
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
		// It starts now, whenever it was queued.
		const staffed = staff(state, { ...queued, at: input.at }, max);
		if (!staffed) continue;
		return took(
			state,
			staffed.append,
			[...staffed.actions, { kind: "write-plan" }],
			`Queued Task \`${queued.slug}\` ${staffed.who} (tasks/${queued.folder}/task.md).${staffed.note ? ` ${staffed.note}` : ""}`,
		);
	}
	// A Task queued while paused still waits once the Effort runs: it gets the reason it waits for now, with no reply.
	const why = waitReason(state, max);
	return took(
		state,
		state.queue.filter((queued) => queued.why === "paused").map((queued) => ({ type: "task-requeued", slug: queued.slug, why, at: input.at })),
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

/** What one journal event of `teammate` appends, past its cursor. */
function journalEvent(state: EffortState, teammate: Teammate, input: Extract<EffortInput, { kind: "journal" }>): Step {
	const { cursor, line } = input;
	const payload = line.payload ?? {};
	const at = line.at;
	const at_ = { teammate: teammate.id, cursor };
	switch (line.event) {
		case "SessionStart": {
			const sessionId = text(payload.session_id);
			if (sessionId === undefined) return took(state, [], []);
			// The short id is the launch session's first eight characters; a clear or a resume keeps it.
			const shortId = teammate.shortId ?? sessionId.slice(0, 8);
			const source = text(payload.source) ?? "startup";
			const session: EffortLine = { type: "teammate-session", ...at_, source, sessionId, shortId, ...(line.inbox === undefined ? {} : { inbox: line.inbox }), at };
			// The clear a reuse asked for has happened: the reused Teammate gets its new Task's pointer in the fresh context.
			const task = teammate.clearing === undefined ? undefined : state.tasks[teammate.clearing];
			const inbox = line.inbox ?? teammate.inbox;
			if (source !== "clear" || teammate.clearing === undefined || task === undefined || inbox === undefined) return took(state, [session], []);
			return took(state, [session], [{ kind: "send-pointer", teammate: teammate.id, inbox, slug: teammate.clearing, folder: task.folder, round: task.round }]);
		}
		case "UserPromptSubmit":
			return took(state, [{ type: "prompt-landed", ...at_, prompt: text(payload.prompt) ?? "", at }], []);
		case "PermissionDenied": {
			const reason = text(payload.reason);
			return took(state, [{ type: "permission-denied", ...at_, tool: text(payload.tool_name) ?? "", ...(reason === undefined ? {} : { reason }), at }], []);
		}
		case "Stop":
			return stopped(state, teammate, input);
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
				at,
				state: "held",
			};
			const { state: _state, ...fields } = held;
			return took(state, [{ type: "request-held", cursor, ...fields }], [{ kind: "wake-lead", text: askText(held) }]);
		}
		case "PostToolUse": {
			// A call a held request asked for ran: the human answered it in the terminal first.
			// A hook killed by the terminal looks like a deny until the call runs.
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
 * Teammate the extension stopped is already over; anything else is a crash,
 * which ends the Teammate and wakes the Lead once, through the cursor.
 */
function sessionEnded(state: EffortState, teammate: Teammate, input: Extract<EffortInput, { kind: "journal" }>): Step {
	const reason = text(input.line.payload?.reason) ?? "other";
	if (reason === "clear" || reason === "resume" || teammate.ended !== undefined) return took(state, [], []);
	const task = state.tasks[teammate.task];
	const open = task !== undefined && task.teammate === teammate.id && task.accepted === undefined && task.dropped === undefined;
	const text_ = open
		? `\`${teammate.id}\`'s session ended (${reason}) during round ${task.round} of Task \`${teammate.task}\`, so it is gone for this Effort. A send-back of the Task with \`team_review\` goes to another Teammate of Role \`${teammate.role}\`, carrying its folder; or drop it with \`team_plan\`; or stop and tell the human.`
		: `\`${teammate.id}\`'s session ended (${reason}), so it is gone for this Effort. It had no open Task.`;
	return took(state, [{ type: "teammate-crashed", teammate: teammate.id, cursor: input.cursor, reason, at: input.line.at }], [{ kind: "wake-lead", text: text_ }]);
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
 * A send-back of a Task whose Teammate has ended: a new Teammate of its Role
 * takes the next round in the same folder, where the Task, its results and
 * the feedback are.
 */
function restaff(state: EffortState, input: Extract<EffortInput, { kind: "review" }>, task: HandedTask, feedback: string, count: string): Step {
	const n = state.teammates.filter((teammate) => teammate.role === task.role).length + 1;
	const id = `${task.role}-${n}`;
	const name = `team-${state.effortId}-${id}`;
	return took(
		state,
		[
			{ type: "teammate-started", id, role: task.role, name, task: input.slug, startedAt: input.at, ...(input.mode === undefined ? {} : { mode: input.mode }) },
			{ type: "task-sent-back", slug: input.slug, round: task.round, at: input.at },
			{ type: "task-reassigned", slug: input.slug, teammate: id, at: input.at },
		],
		[
			{ kind: "restaff-teammate", teammate: { id, role: task.role, name }, slug: input.slug, folder: task.folder, round: task.round, feedback },
			{ kind: "write-plan" },
		],
		`Sent Task \`${input.slug}\` back (${count}) with feedback-${task.round}.md. \`${task.teammate}\` has ended, so this started \`${id}\` on it, pointed at the Task's folder; it writes result-${task.round + 1}.md next, and you are woken when it does.`,
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
	const ending = teammate && teammate.ended === undefined && teammate.retiredAt === undefined ? teammate : undefined;
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
	if (task.reported === task.round) return "in review";
	return task.round > 1 ? "sent back" : "running";
}

/** `HH:MM` of an ISO time, as Reports show it. */
function clock(at: string): string {
	return at.slice(11, 16);
}

/** What a Report says of one line since the last Report, or undefined for a line its own section tells of. */
function told(line: EffortLine): string | undefined {
	switch (line.type) {
		case "approval-requested":
			return `asked you to approve the Brief (\`${line.id}\`)`;
		case "approval-answered":
			return line.answer === "approved" ? `you approved the Brief (\`${line.id}\`)` : `you sent back \`${line.id}\`: ${line.note ?? ""}`;
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
	if (problems.length > 0) {
		return { ok: false, refusal: `The Report for Effort \`${state.effortId}\` can't be written until these are fixed:\n${problems.map((problem) => `- ${problem}`).join("\n")}` };
	}
	const found: EffortLine[] = (input.found ?? []).map((what) => what.trim()).filter((what) => what !== "").map((what) => ({ type: "found-work", what, at: input.at }));
	const now = found.reduce(apply, state);
	const n = state.reports + 1;
	const sections = reportSections(now, n === 1 ? input.modes : undefined).filter((each) => each.lines.length > 0);
	const written: Report = { n, at: input.at, headline, coverage, sections };
	const file = `reports/${String(n).padStart(3, "0")}.md`;
	return took(
		state,
		[...found, { type: "report-written", n, at: input.at }],
		[{ kind: "write-report", report: written }],
		`Report ${n} of Effort \`${state.effortId}\` is written as ${file}. The human sees it in chat, so don't repeat it.`,
	);
}

/** The logged sections, from `since` the last Report; the plan Report passes each Role's mode. */
function reportSections(state: EffortState, modes: readonly { role: string; mode: string }[] | undefined): ReportSection[] {
	const since = state.sinceReport;
	const of = <T extends EffortLine["type"]>(type: T) => since.filter((line): line is Extract<EffortLine, { type: T }> => line.type === type);
	const planChanged = modes !== undefined || since.some((line) => ["plan-written", "task-handed-off", "task-done", "task-sent-back", "task-accepted"].includes(line.type));
	const plan = state.plan && planChanged ? state.plan.map((task) => `\`${task.slug}\` (${task.role}): ${taskStatus(state, task.slug)}`) : [];
	const reasons = of("plan-written").flatMap((line) => (line.reason === undefined ? [] : [`re-planned at ${clock(line.at)}: ${line.reason}`]));
	const newFound = of("found-work");
	const launched = (id: string) => state.teammates.find((each) => each.id === id)?.mode;
	return [
		{ title: "Since the last Report", lines: since.flatMap((line) => { const text = told(line); return text === undefined || !("at" in line) ? [] : [`${clock(line.at)} ${text}`]; }) },
		{ title: "Plan", lines: [...plan, ...reasons] },
		{
			title: "Waiting on you",
			lines: [
				...state.pending.map((item) => `\`${item.id}\`: approve the Brief, ${item.path} (sha256 ${item.sha256}), in \`/team pending\``),
				...waitingInTerminal(state).map((held) => `\`${held.request}\`: ${terminalText(held)}`),
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
				newFound.length === 0
					? []
					: [
							`${state.found.length} found so far outside the Brief, kept as suggestions for the final Report; new since the last Report:`,
							...newFound.map((line) => `${line.what}${line.task === undefined ? "" : ` (Task \`${line.task}\`)`}`),
						],
		},
	];
}
