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
	| ({ type: "task-handed-off"; slug: string } & HandedTask);

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
	| { kind: "start-teammate"; tool: "team_plan" | "team_handoff" }
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
	| { kind: "handoff"; slug: string; at: string };

/** Work the core leaves to the shell. */
export type EffortAction =
	/** Write the approved Brief as `brief.md`, snapshot the Team and the Playbook, and record the act. */
	| { kind: "promote-brief"; approval: PendingApproval; at: string }
	/** Start a turn of the Lead's model with this text. */
	| { kind: "wake-lead"; text: string }
	/** Write `plan.md` as a view of the state's plan. */
	| { kind: "write-plan" }
	/** Write the Task's folder and `task.md`, then launch the Teammate on it. */
	| { kind: "launch-teammate"; teammate: Omit<Teammate, "task" | "startedAt">; task: { slug: string; folder: string } };

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
	}
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
		return { ok: false, refusal: `Task \`${input.slug}\` is already running, with \`${handed.teammate}\`; a Task is handed off once until its result is reviewed.` };
	}
	const n = state.teammates.filter((teammate) => teammate.role === task.role).length + 1;
	const id = `${task.role}-${n}`;
	const name = `team-${state.effortId}-${id}`;
	const folder = `${String(Object.keys(state.tasks).length + 1).padStart(3, "0")}-${task.role}-${task.slug}`;
	return took(
		state,
		[
			{ type: "teammate-started", id, role: task.role, name, task: task.slug, startedAt: input.at },
			{ type: "task-handed-off", slug: task.slug, folder, role: task.role, teammate: id, at: input.at },
		],
		[{ kind: "launch-teammate", teammate: { id, role: task.role, name }, task: { slug: task.slug, folder } }, { kind: "write-plan" }],
		`started ${id} on Task \`${task.slug}\` (tasks/${folder}/task.md).`,
	);
}
