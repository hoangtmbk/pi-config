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
}

/** Where a Task of the plan stands, as `plan.md` shows it. */
export type TaskStatus = "planned" | "running" | "in review" | "sent back" | "accepted";

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
	| { type: "plan-written"; tasks: PlannedTask[]; at: string }
	/** A Teammate was launched. */
	| ({ type: "teammate-started" } & Teammate)
	/** A planned Task was handed to a Teammate, its folder written. */
	| ({ type: "task-handed-off"; slug: string } & Omit<HandedTask, "reported" | "accepted" | "sendBacks">)
	/** The Lead sent round `round` of a Task back with feedback, which starts round `round + 1` with the same Teammate. */
	| { type: "task-sent-back"; slug: string; round: number; at: string }
	/** The Lead accepted round `round` of a Task, which ends it. */
	| { type: "task-accepted"; slug: string; round: number; at: string }
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
	/** A `Stop` without a new result: the Teammate stopped short, saying this last. */
	| { type: "teammate-stopped"; teammate: string; cursor: number; slug: string; message: string; at: string };

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
			at: string;
	  }
	/** `team_handoff` of a planned Task. */
	| { kind: "handoff"; slug: string; at: string }
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
			at: string;
	  };

/** Work the core leaves to the shell. */
export type EffortAction =
	/** Write the approved Brief as `brief.md`, snapshot the Team and the Playbook, and record the act. */
	| { kind: "promote-brief"; approval: PendingApproval; at: string }
	/** Start a turn of the Lead's model with this text. */
	| { kind: "wake-lead"; text: string }
	/** Write `plan.md` as a view of the state's plan. */
	| { kind: "write-plan" }
	/** Write the Task's folder and `task.md`, then launch the Teammate on it. */
	| { kind: "launch-teammate"; teammate: Omit<Teammate, "task" | "startedAt">; task: { slug: string; folder: string } }
	/**
	 * Write `feedback` as `feedback-<round>.md` in the Task's folder, then send
	 * the Teammate a pointer to it over its inbox, with no clear: it keeps its
	 * own reasoning, and writes `result-<round + 1>.md` next.
	 */
	| { kind: "send-back"; teammate: string; inbox: Inbox; slug: string; folder: string; round: number; feedback: string };

export type Step =
	| { ok: true; state: EffortState; append: EffortLine[]; actions: EffortAction[]; reply?: string }
	| { ok: false; refusal: string };

/** The first line of a new Effort. */
export function openEffort(opened: { effortId: string; team: string; repo: string; playbook: string; at: string }): EffortLine {
	return { type: "effort-opened", ...opened };
}

/** Fold one line into the state. */
function apply(state: EffortState, line: EffortLine): EffortState {
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
			return { ...state, tasks: { ...state.tasks, [slug]: handed } };
		}
		case "teammate-session":
			return withTeammate(state, line, {
				sessionId: line.sessionId,
				shortId: line.shortId,
				...(line.inbox === undefined ? {} : { inbox: line.inbox }),
			});
		case "prompt-landed":
		case "permission-denied":
		case "teammate-stopped":
			return withTeammate(state, line, {});
		case "task-sent-back": {
			const task = state.tasks[line.slug];
			return task ? withTask(state, line.slug, { round: line.round + 1, sendBacks: (task.sendBacks ?? 0) + 1 }) : state;
		}
		case "task-accepted":
			return withTask(state, line.slug, { accepted: line.at });
		case "task-done": {
			const advanced = withTeammate(state, line, {});
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

/** The state with `line.teammate` changed by `change`, its cursor moved to the line's. */
function withTeammate(state: EffortState, line: { teammate: string; cursor: number }, change: Partial<Teammate>): EffortState {
	return {
		...state,
		teammates: state.teammates.map((teammate) => (teammate.id === line.teammate ? { ...teammate, ...change, cursor: line.cursor } : teammate)),
	};
}

/** The state an Effort's lines fold to. The first line must open the Effort. */
export function fold(lines: readonly EffortLine[]): EffortState {
	const [first, ...rest] = lines;
	if (first?.type !== "effort-opened") {
		throw new Error(`effort.jsonl must start with an \`effort-opened\` line, not ${first ? `\`${first.type}\`` : "nothing"}`);
	}
	const { type: _type, at: _at, ...opened } = first;
	return rest.reduce(apply, { ...opened, pending: [], requests: 0, tasks: {}, teammates: [] });
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
	}
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
					"Teammates may start once planning is available.",
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
	for (const [slug, handed] of Object.entries(state.tasks)) {
		const kept = tasks.find((task) => task.slug === slug);
		if (!kept) problems.push(`Task \`${slug}\` was handed off to \`${handed.teammate}\`, so it stays in the plan`);
		else if (kept.role !== handed.role) problems.push(`Task \`${slug}\` was handed off to \`${handed.teammate}\` in Role \`${handed.role}\`, so it keeps that Role`);
	}
	if (problems.length > 0) {
		return { ok: false, refusal: `The plan for Effort \`${state.effortId}\` can't be taken until these are fixed:\n${problems.map((problem) => `- ${problem}`).join("\n")}` };
	}
	const reply = `${state.plan ? "Replaced" : "Wrote"} the plan of Effort \`${state.effortId}\`: ${tasks.length} Task${tasks.length === 1 ? "" : "s"}, covering ${quoted(input.criteria)}. Hand each off with \`team_handoff\` when it is ready.`;
	return took(state, [{ type: "plan-written", tasks, at: input.at }], [{ kind: "write-plan" }], reply);
}

/**
 * Hand a planned Task to a fresh Teammate of its Role. The Task folder is
 * numbered in handoff order and named `<nnn>-<role>-<slug>`; the Teammate is
 * the next of its Role, `dev-1`, `dev-2`, …
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
	if (handed) {
		const status = taskStatus(state, input.slug);
		if (status === "accepted") {
			return { ok: false, refusal: `Task \`${input.slug}\` is accepted (round ${handed.round}, with \`${handed.teammate}\`), and an accepted Task is never handed off again.` };
		}
		return {
			ok: false,
			refusal: `Task \`${input.slug}\` is already ${status}, with \`${handed.teammate}\`; a Task is handed off once, and \`team_review\` sends it back for another round once its result is written.`,
		};
	}
	const n = state.teammates.filter((teammate) => teammate.role === task.role).length + 1;
	const id = `${task.role}-${n}`;
	const name = `team-${state.effortId}-${id}`;
	const folder = `${String(Object.keys(state.tasks).length + 1).padStart(3, "0")}-${task.role}-${task.slug}`;
	return took(
		state,
		[
			{ type: "teammate-started", id, role: task.role, name, task: task.slug, startedAt: input.at },
			{ type: "task-handed-off", slug: task.slug, folder, role: task.role, teammate: id, at: input.at, round: 1 },
		],
		[{ kind: "launch-teammate", teammate: { id, role: task.role, name }, task: { slug: task.slug, folder } }, { kind: "write-plan" }],
		`started ${id} on Task \`${task.slug}\` (tasks/${folder}/task.md).`,
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
 * nothing, so they leave no trace and wake nobody.
 */
function journal(state: EffortState, input: Extract<EffortInput, { kind: "journal" }>): Step {
	const teammate = state.teammates.find((each) => each.id === input.teammate);
	if (!teammate) return { ok: false, refusal: `Effort \`${state.effortId}\` has no Teammate \`${input.teammate}\` to read a journal of.` };
	if (input.cursor <= (teammate.cursor ?? 0)) return took(state, [], []);
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
			return took(state, [{ type: "teammate-session", ...at_, source, sessionId, shortId, ...(line.inbox === undefined ? {} : { inbox: line.inbox }), at }], []);
		}
		case "UserPromptSubmit":
			return took(state, [{ type: "prompt-landed", ...at_, prompt: text(payload.prompt) ?? "", at }], []);
		case "PermissionDenied": {
			const reason = text(payload.reason);
			return took(state, [{ type: "permission-denied", ...at_, tool: text(payload.tool_name) ?? "", ...(reason === undefined ? {} : { reason }), at }], []);
		}
		case "Stop":
			return stopped(state, teammate, input);
		default:
			return took(state, [], []);
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
	const inbox = state.teammates.find((each) => each.id === task.teammate)?.inbox;
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
 * Where Task `slug` stands: planned until handed off; then running, in review
 * once its round's result is reported, sent back while a later round is
 * worked, and accepted for good.
 */
export function taskStatus(state: EffortState, slug: string): TaskStatus {
	const task = state.tasks[slug];
	if (!task) return "planned";
	if (task.accepted !== undefined) return "accepted";
	if (task.reported === task.round) return "in review";
	return task.round > 1 ? "sent back" : "running";
}
