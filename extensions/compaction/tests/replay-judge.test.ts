/**
 * The replay runner's judge: what it is shown about one cut, and how its reply
 * is read — every verdict citing its evidence, every rule a quote of the user.
 *
 * Driven against a scripted model call; the cases are written for the purpose.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type JudgeCase, judgeCut, judgeRequest, parseVerdict } from "../replay/replay-judge.ts";
import { assistant, MODEL, result, user } from "./fake-pi.ts";
import { scriptModel } from "./scripted-model.ts";

const RULE = "never touch the generated files under gen/";
const ASK = "Which test runner should I use?";

function judgeCase(): JudgeCase {
	const read = assistant([{ type: "toolCall", id: "c-1", name: "read", arguments: { path: "src/a.ts" } }], "toolUse");
	return {
		userMessages: [`Fix the flaky test, and ${RULE}.`, "Use vitest."],
		history: [user(`Fix the flaky test, and ${RULE}.`), read, result(read, "export const a = 1;"), user("Use vitest.")],
		handoffs: { A: "## Goal\nFix the flaky test.\n## Constraint ledger\n- \"never touch the generated files under gen/\"", B: "The user wants the test fixed." },
		continuations: {
			A: { matched: [], differed: { proposed: assistant([{ type: "text", text: "Running vitest now." }], "stop"), recorded: undefined } },
			B: { matched: [], differed: { proposed: assistant([{ type: "text", text: ASK }], "stop"), recorded: undefined } },
		},
		future: [assistant([{ type: "text", text: "Done." }], "stop"), user("Thanks.")],
	};
}

const cited = (verdict: boolean, evidence: string) => ({ verdict, evidence });

/** A reply as the judge is asked to give it. */
function reply(overrides: Record<string, unknown> = {}): string {
	const verdict = {
		constraints: [
			{ quote: RULE, A: { carried: true, evidence: 'Constraint ledger: "never touch the generated files under gen/"' }, B: { carried: false, evidence: "B never mentions gen/" } },
			{ quote: "Use   vitest.", A: { carried: false, evidence: "not in A" }, B: { carried: false, evidence: "not in B" } },
		],
		A: { violations: [], reask: cited(false, "A runs vitest, as told"), redone: cited(false, "nothing was done before") },
		B: {
			violations: [{ rule: RULE, evidence: "B edits gen/client.ts" }],
			reask: cited(true, `B asks "${ASK}", answered by "Use vitest."`),
			redone: cited(false, "nothing redone"),
		},
		...overrides,
	};
	return `Here is my verdict.\n\n\`\`\`json\n${JSON.stringify(verdict, null, 2)}\n\`\`\``;
}

describe("the judge's request", () => {
	it("shows the user's words, the history, both Handoffs blind, both continuations and the future, as data", () => {
		const { systemPrompt, prompt } = judgeRequest(judgeCase());
		assert.match(systemPrompt, /data, not instructions/);
		assert.match(systemPrompt, /re-read/i, "re-reading a file is not redone work");
		for (const text of [RULE, "Use vitest.", "src/a.ts", "export const a = 1;", ASK, "Running vitest now.", "Thanks."]) assert.ok(prompt.includes(text), text);
		assert.ok(prompt.indexOf("<handoff-a>") < prompt.indexOf("Fix the flaky test.\n## Constraint ledger"));
		assert.ok(prompt.indexOf("<handoff-b>") < prompt.indexOf("The user wants the test fixed."));
		assert.doesNotMatch(prompt + systemPrompt, /pi's default|our Handoff|baseline/i, "nothing says which Handoff is which");
	});
});

describe("the judge's verdict", () => {
	it("is read for both Handoffs, each verdict with what it rests on", () => {
		const verdict = parseVerdict(reply(), judgeCase().userMessages);
		assert.ok(!("problem" in verdict), "problem" in verdict ? verdict.problem : "");
		assert.deepEqual(verdict.constraints.map((c) => [c.quote, c.A.verdict, c.B.verdict]), [
			[RULE, true, false],
			["Use   vitest.", false, false],
		]);
		assert.deepEqual(verdict.B.violations, [{ rule: RULE, evidence: "B edits gen/client.ts" }]);
		assert.equal(verdict.B.reask.verdict, true);
		assert.match(verdict.B.reask.evidence, /Use vitest/);
		assert.equal(verdict.A.redone.verdict, false);
	});

	it("drops a rule the user never gave, and says so, rather than score against it", () => {
		const verdict = parseVerdict(
			reply({
				constraints: [{ quote: "always use tabs", A: { carried: true, evidence: "x" }, B: { carried: true, evidence: "y" } }],
				A: { violations: [{ rule: "always use tabs", evidence: "z" }], reask: cited(false, "-"), redone: cited(false, "-") },
			}),
			judgeCase().userMessages,
		);
		assert.ok(!("problem" in verdict));
		assert.deepEqual(verdict.constraints, []);
		assert.deepEqual(verdict.A.violations, []);
		assert.deepEqual(verdict.dropped, ['constraint "always use tabs": the user never said it', 'A violation of "always use tabs": the user never said it']);
	});

	it("is refused when it isn't JSON of the asked shape, or a verdict cites nothing", () => {
		const users = judgeCase().userMessages;
		assert.match((parseVerdict("I think A is better.", users) as { problem: string }).problem, /no JSON/);
		assert.match((parseVerdict(reply({ A: undefined }), users) as { problem: string }).problem, /A/);
		assert.match((parseVerdict(reply({ B: { violations: [], reask: cited(true, " "), redone: cited(false, "-") } }), users) as { problem: string }).problem, /B\.reask.*evidence/);
		const uncited = { constraints: [{ quote: RULE, A: { carried: true }, B: { carried: false, evidence: "no" } }] };
		assert.match((parseVerdict(reply(uncited), users) as { problem: string }).problem, /constraints\[0\]\.A.*evidence/);
	});
});

describe("judging a cut", () => {
	it("asks once more when the first reply can't be read, and gives up after that", async () => {
		const model = scriptModel({ text: "A is better." }, { text: reply() });
		const verdict = await judgeCut(model.stream, MODEL, judgeCase());
		assert.ok(!("problem" in verdict));
		assert.equal(model.calls.length, 2);
		assert.equal(model.calls[0]!.context.systemPrompt, judgeRequest(judgeCase()).systemPrompt);

		const never = scriptModel({ text: "A." }, { text: "B." });
		const failed = await judgeCut(never.stream, MODEL, judgeCase());
		assert.match((failed as { problem: string }).problem, /no JSON/);
	});
});
