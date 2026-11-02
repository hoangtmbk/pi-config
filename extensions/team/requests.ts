/**
 * A Teammate's held requests: the permission prompts and `AskUserQuestion`s
 * its hook holds open for the Lead, while each stays live in the Teammate's
 * terminal for the human. The first answer wins, and nothing is allowed by
 * default.
 *
 * This module decides what the Lead is told of a request, whether its
 * `team_answer` can be taken, and the hook decision it becomes. The core keeps
 * each request's state in the Effort's lines.
 */

/** Where a held request stands. */
export type RequestState =
	/** Its hook holds it open, waiting on the first answer. */
	| "held"
	/** Its hook gave up holding it: only the human can answer it now, in the Teammate's terminal. */
	| "expired"
	/** The Lead answered it, through the hook. */
	| "answered"
	/** A `PostToolUse` for its call showed the human answered it in the terminal. */
	| "answered-in-terminal"
	/** Its hook was killed: the human answered "No" or Esc in the terminal. */
	| "denied-in-terminal"
	/** The Teammate's turn ended after it, so nothing waits on it. */
	| "ended";

/** A `PermissionRequest` a Teammate's hook journalled with a request id. */
export interface HeldRequest {
	/** `req-<8 hex>`, from the hook script. */
	request: string;
	teammate: string;
	/** The Task in the Teammate's context when it asked. */
	task?: string;
	tool: string;
	input: Record<string, unknown>;
	/** Claude Code's id of the tool call, when the payload carried one. */
	toolUseId?: string;
	at: string;
	state: RequestState;
}

/** A session-scoped rule, the only kind the Lead adds. */
export interface SessionRule {
	type: "addRules";
	rules: { toolName: string; ruleContent?: string }[];
	behavior: "allow";
	destination: "session";
}

/** What the hook prints as its `PermissionRequest` decision. */
export type HookDecision =
	| { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: SessionRule[] }
	| { behavior: "deny"; message: string };

/** `team_answer`'s arguments. */
export interface RequestAnswer {
	request: string;
	decision?: "allow" | "deny";
	reason?: string;
	rule?: string;
	grant?: string;
	answers?: Record<string, string | string[]>;
	/** The human's free-text answer to an escalated prose question, relayed from chat. */
	text?: string;
}

/** An answer taken: the decision for the hook, the rule to keep, and what the decided-for-you log says of it. */
export interface TakenAnswer {
	decision: HookDecision;
	rule?: string;
	logged: string[];
}

const QUESTION_TOOL = "AskUserQuestion";

interface Question {
	question: string;
	multiSelect: boolean;
	labels: string[];
}

function questions(input: Record<string, unknown>): Question[] {
	const list = Array.isArray(input.questions) ? input.questions : [];
	return list.flatMap((each) => {
		if (typeof each !== "object" || each === null) return [];
		const { question, multiSelect, options } = each as Record<string, unknown>;
		if (typeof question !== "string") return [];
		const labels = (Array.isArray(options) ? options : []).flatMap((option) => {
			const label = typeof option === "object" && option !== null ? (option as Record<string, unknown>).label : undefined;
			return typeof label === "string" ? [label] : [];
		});
		return [{ question, multiSelect: multiSelect === true, labels }];
	});
}

/** The part of a tool call's input a person reads it by: the command, the file, the URL. */
function gist(input: Record<string, unknown>): string {
	for (const key of ["command", "file_path", "path", "url", "pattern", "query"]) {
		const value = input[key];
		if (typeof value === "string" && value !== "") return value;
	}
	const json = JSON.stringify(input);
	return json.length > 80 ? `${json.slice(0, 79)}…` : json;
}

function backticked(items: readonly string[]): string {
	return items.map((item) => `\`${item}\``).join(", ");
}

/** Whether a held request is an `AskUserQuestion` rather than a permission prompt. */
export function isQuestion(held: HeldRequest): boolean {
	return held.tool === QUESTION_TOOL;
}

/** An `AskUserQuestion`'s questions, each with its own options, for the human to pick from. */
export function askedQuestions(held: HeldRequest): { question: string; multiSelect: boolean; labels: string[] }[] {
	return questions(held.input);
}

/** What a held request asks, in a line: its questions with their options, or the tool and what it would run on. */
export function askedText(held: HeldRequest): string {
	if (held.tool === QUESTION_TOOL) {
		return questions(held.input)
			.map((each) => `"${each.question}" (${each.multiSelect ? "any" : "one"} of ${backticked(each.labels)})`)
			.join("; ");
	}
	return `\`${held.tool}\` \`${gist(held.input)}\``;
}

/** What a request is, as a pending item names it: a `Bash` prompt, or a question. */
export function requestKind(held: HeldRequest): string {
	return held.tool === QUESTION_TOOL ? "question" : `\`${held.tool}\` prompt`;
}

/** An `AskUserQuestion`'s answers in a line, in the order it asked them. */
export function answersText(held: HeldRequest, given: Record<string, string | string[]>): string {
	return questions(held.input)
		.map((each) => {
			const value = given[each.question];
			return `"${each.question}": ${Array.isArray(value) ? value.join(", ") : value}`;
		})
		.join("; ");
}

/** The text that wakes the Lead with a request. */
export function askText(held: HeldRequest): string {
	const on = held.task === undefined ? "" : ` on Task \`${held.task}\``;
	const live = `It is also live in ${held.teammate}'s terminal; the first answer wins. Nothing is allowed by default: if the Brief doesn't settle it, deny it or move it to the human with \`team_escalate\`.`;
	if (held.tool === QUESTION_TOOL) {
		const asked = questions(held.input).map((each) => `- "${each.question}" (${each.multiSelect ? "any" : "one"} of ${backticked(each.labels)})`);
		return [
			`\`${held.teammate}\` asks${on} (\`${held.request}\`):`,
			"",
			...asked,
			"",
			`Answer from the Brief with \`team_answer\` and \`answers\` keyed by each question's exact text: one label where it says "one of", a list of labels where it says "any of". Or deny it with a reason. ${live}`,
		].join("\n");
	}
	return [
		`\`${held.teammate}\` asks permission to use \`${held.tool}\`${on} (\`${held.request}\`):`,
		"",
		JSON.stringify(held.input, null, 2),
		"",
		`Answer from the Brief with \`team_answer\`: allow or deny, with a reason. An allow may add a session \`rule\` such as \`Bash(npm test:*)\`, and name the \`grant\` it relies on. ${live}`,
	].join("\n");
}

/** What a request in the terminal asks of the human, as the Report and `/team pending` show it. */
export function terminalText(held: HeldRequest): string {
	const what = held.tool === QUESTION_TOOL ? "question" : `\`${held.tool}\` prompt`;
	return `answer ${held.teammate}'s ${what} in ${held.teammate}'s terminal (\`/team attach ${held.teammate}\`)`;
}

/** Why a request that isn't held can't be answered by the Lead. */
export function closedText(held: HeldRequest): string {
	const terminal = `${held.teammate}'s terminal`;
	switch (held.state) {
		case "held":
			return `Request \`${held.request}\` is held`;
		case "expired":
			return `Request \`${held.request}\` waited past the hook's hold, so only the human can answer it now, in ${terminal} (\`/team attach ${held.teammate}\`).`;
		case "answered":
			return `Request \`${held.request}\` is already answered: you answered it.`;
		case "answered-in-terminal":
			return `Request \`${held.request}\` is already answered: the human answered it in ${terminal}.`;
		case "denied-in-terminal":
			return `Request \`${held.request}\` is already answered: the human denied it in ${terminal}.`;
		case "ended":
			return `Request \`${held.request}\` no longer waits: ${held.teammate}'s turn ended after it.`;
	}
}

/** What a Report says of a request the terminal settled. */
export function settledText(teammate: string, request: string, how: "answered-in-terminal" | "denied-in-terminal" | "expired"): string {
	switch (how) {
		case "answered-in-terminal":
			return `the human answered ${teammate}'s request \`${request}\` in its terminal`;
		case "denied-in-terminal":
			return `the human denied ${teammate}'s request \`${request}\` in its terminal`;
		case "expired":
			return `${teammate}'s request \`${request}\` waited past the hook's hold`;
	}
}

/** Whether a `PostToolUse` of `tool` with `input` (and `toolUseId`, when given) is the call `held` asked for. */
export function isCallOf(held: HeldRequest, tool: string | undefined, input: unknown, toolUseId: string | undefined): boolean {
	if (held.toolUseId !== undefined && toolUseId !== undefined) return held.toolUseId === toolUseId;
	return held.tool === tool && sameJson(held.input, input);
}

function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	return keysA.length === keysB.length && keysA.every((key) => sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

const RULE = /^([A-Za-z][\w-]*)(?:\((.+)\))?$/s;

/**
 * The Lead's answer to a held request: the hook decision it becomes, or why
 * it can't be taken. A permission request takes allow or deny with a reason,
 * and an allow may add a session rule for the request's own tool; an
 * `AskUserQuestion` takes `answers` for every question, or a deny with a reason.
 */
export function takeAnswer(held: HeldRequest, answer: RequestAnswer): TakenAnswer | string {
	const reason = answer.reason?.trim() ?? "";
	const about = `\`${held.request}\``;
	if (held.tool === QUESTION_TOOL) return takeQuestionAnswer(held, answer, reason);
	const call = `${held.teammate}'s \`${held.tool}\` \`${gist(held.input)}\``;
	if (answer.answers !== undefined) {
		return `\`answers\` answer an AskUserQuestion; ${about} asks permission to use \`${held.tool}\`, so answer allow or deny, with a reason.`;
	}
	if (answer.decision === undefined) return `${about} asks permission to use \`${held.tool}\`: answer allow or deny, with a reason.`;
	if (reason === "") return `An answer to ${about} needs a reason: say what in the Brief settles it.`;
	if (answer.decision === "deny") {
		if (answer.rule !== undefined) return `A \`rule\` goes only with an allow; ${about} is being denied.`;
		return { decision: { behavior: "deny", message: reason }, logged: [`denied ${call}: ${reason}`] };
	}
	const logged = [`allowed ${call}: ${reason}`];
	let updatedPermissions: SessionRule[] | undefined;
	if (answer.rule !== undefined) {
		const parsed = RULE.exec(answer.rule.trim());
		if (!parsed) return `A \`rule\` is \`Tool\` or \`Tool(content)\`, such as \`Bash(npm test:*)\`; \`${answer.rule}\` is neither.`;
		const [, toolName, content] = parsed;
		if (toolName !== held.tool) return `A \`rule\` here is for \`${held.tool}\`, the tool ${about} asks for, not \`${toolName}\`.`;
		updatedPermissions = [{ type: "addRules", rules: [{ toolName, ...(content === undefined ? {} : { ruleContent: content }) }], behavior: "allow", destination: "session" }];
		logged.push(`added session rule \`${answer.rule.trim()}\` for ${held.teammate}`);
	}
	if (answer.grant !== undefined && answer.grant.trim() !== "") logged.push(`used grant \`${answer.grant.trim()}\` for ${held.teammate}'s \`${held.tool}\``);
	return {
		decision: { behavior: "allow", ...(updatedPermissions === undefined ? {} : { updatedPermissions }) },
		...(updatedPermissions === undefined ? {} : { rule: answer.rule?.trim() }),
		logged,
	};
}

function takeQuestionAnswer(held: HeldRequest, answer: RequestAnswer, reason: string): TakenAnswer | string {
	const about = `\`${held.request}\``;
	const asked = questions(held.input);
	if (answer.rule !== undefined || answer.grant !== undefined) return `${about} is an AskUserQuestion: answer it with \`answers\`, which take no \`rule\` or \`grant\`.`;
	if (answer.decision === "deny") {
		if (answer.answers !== undefined) return `Deny ${about} or give its \`answers\`, not both.`;
		if (reason === "") return `Denying ${about} needs a reason: say why the Brief leaves it to the human.`;
		return { decision: { behavior: "deny", message: reason }, logged: [`denied ${held.teammate}'s question "${asked[0]?.question ?? ""}": ${reason}`] };
	}
	if (answer.answers === undefined) {
		return `${about} is an AskUserQuestion: answer it with \`answers\`, keyed by each question's exact text (${asked.map((each) => `"${each.question}"`).join(", ")}), or deny it with a reason.`;
	}
	const given = answer.answers;
	const problems: string[] = [];
	for (const each of asked) {
		const value = given[each.question];
		if (value === undefined) problems.push(`"${each.question}" has no answer`);
		else if (each.multiSelect && (!Array.isArray(value) || value.length === 0)) problems.push(`"${each.question}" allows many, so it takes a list of labels`);
		else if (!each.multiSelect && (typeof value !== "string" || value.trim() === "")) problems.push(`"${each.question}" takes one label`);
	}
	const known = new Set(asked.map((each) => each.question));
	for (const key of Object.keys(given)) {
		if (!known.has(key)) problems.push(`"${key}" isn't one of its questions; key each answer by the question's exact text`);
	}
	if (problems.length > 0) return `The answers to ${about} can't be sent until these are fixed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`;
	return {
		decision: { behavior: "allow", updatedInput: { ...held.input, answers: given } },
		logged: [`answered ${held.teammate}'s ${answersText(held, given)}`],
	};
}
