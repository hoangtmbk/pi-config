/**
 * The Constraint ledger: the user's rules, preferences and exclusions as exact
 * quotes, proposed by the writer in `<ledger>` and checked by code against
 * what the user really wrote, merged into the previous record so that it only
 * grows — and the `/compact` focus, which code writes into it and the next
 * focus replaces.
 *
 * Driven only through the recording fake pi, with the forked call — the first
 * writer in the chain — scripted to propose the ledger.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerCompaction } from "../index.ts";
import { calling, type FakeSetup, fakePi, result, said, user } from "./fake-pi.ts";
import { type Reply, scriptModel } from "./scripted-model.ts";

/** A Handoff in the shape the instruction asks for, with `ledger` after it: the `<ledger>` block's inner lines, or `undefined` for none. */
function reply(ledger: string[] | undefined): Reply {
	const handoff = [
		"<handoff>",
		"## Goal",
		'Add retries to the fetcher. "Add retries to the fetcher."',
		"## Progress",
		"- Wrote the wrapper.",
		"## Decisions and why",
		"(none)",
		"## Open problems",
		"(none)",
		"## Critical context",
		"(none)",
		"## Next step",
		'Wire it in. "Go ahead."',
		"</handoff>",
	];
	return { text: [...handoff, ...(ledger === undefined ? [] : ["<ledger>", ...ledger, "</ledger>"])].join("\n") };
}

const add = (quote: string) => `<add>${quote}</add>`;
const supersede = (old: string, by: string) => `<supersede><old>${old}</old><by>${by}</by></supersede>`;

/** A session whose compaction keeps only the newest message or so, so nearly everything is in the removed span. */
const SMALL_TAIL: FakeSetup = { settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: false } } };

/** A fake pi with the extension on it, and the forked call answering each compaction with the next of `replies`. */
function compacting(...replies: Reply[]) {
	return compactingWith(SMALL_TAIL, ...replies);
}

function compactingWith(setup: FakeSetup, ...replies: Reply[]) {
	const model = scriptModel(...replies);
	const pi = fakePi(setup, (api) => registerCompaction(api, { stream: model.stream }));
	return { pi, model };
}

/** The `details` and summary of a hook compaction. */
async function compact(pi: ReturnType<typeof fakePi>, customInstructions?: string): Promise<{ details: any; summary: string }> {
	const done = await pi.compact({ customInstructions });
	return { details: done?.result?.compaction?.details, summary: done?.result?.compaction?.summary ?? "" };
}

/** The rendered Constraint ledger section's lines. */
function rendered(summary: string): string[] {
	const section = /## Constraint ledger\n([^]*?)\n\n## /.exec(summary)?.[1];
	assert.ok(section !== undefined, "the summary has a Constraint ledger section");
	return section.split("\n");
}

const RULES = "Add retries to the fetcher. Please don't add any new dependencies, and keep the public API unchanged.";

describe("a ledger add", () => {
	it("is kept when it is the user's words, exactly", async () => {
		const { pi } = compacting(reply([add("don't add any new dependencies"), add("keep the public API unchanged")]));
		pi.session.appendMessage(user(RULES));
		await pi.turnEnd({ message: said("On it.") });
		pi.session.appendMessage(user("Go ahead."));
		await pi.turnEnd({ message: said("Done.") });

		const { details, summary } = await compact(pi);
		assert.deepEqual(details.ledger, [
			{ quote: "don't add any new dependencies", kind: "constraint" },
			{ quote: "keep the public API unchanged", kind: "constraint" },
		]);
		assert.deepEqual(details.log, []);
		assert.deepEqual(rendered(summary), ['- "don\'t add any new dependencies"', '- "keep the public API unchanged"']);
		// In its fixed place, right after Goal.
		assert.match(summary, /^## Goal\n[^\n]*\n\n## Constraint ledger\n/);
	});

	it("forgives whitespace differences, and only those", async () => {
		const { pi } = compacting(
			reply([
				// A line break in the user's message, and extra spaces in the quote.
				add("keep  the public\nAPI unchanged"),
				add("Run npm test before you say it's done"),
				add("Please don't add any new dependencies,and keep"),
				add("please don't add any new dependencies"),
				add("don’t add any new dependencies"),
			]),
		);
		pi.session.appendMessage(user("Please don't add any new dependencies, and keep the public\n   API unchanged."));
		pi.session.appendMessage(user("Run   npm test before you say it's\tdone."));
		await pi.turnEnd({ message: said("On it.") });

		const { details } = await compact(pi);
		assert.deepEqual(
			details.ledger.map((entry: any) => entry.quote),
			["keep the public API unchanged", "Run npm test before you say it's done"],
		);
		assert.deepEqual(details.log, [
			'ledger: dropped add "Please don\'t add any new dependencies,and keep": not found in any user message',
			'ledger: dropped add "please don\'t add any new dependencies": not found in any user message',
			'ledger: dropped add "don’t add any new dependencies": not found in any user message',
		]);
	});

	it("is dropped under 12 characters", async () => {
		const { pi } = compacting(reply([add("no new deps"), add("  keep it   "), add("no new deps!")]));
		pi.session.appendMessage(user("Add retries: no new deps! And keep it small."));
		await pi.turnEnd({ message: said("On it.") });

		const { details, summary } = await compact(pi);
		assert.deepEqual(details.ledger, [{ quote: "no new deps!", kind: "constraint" }]);
		assert.deepEqual(details.log, [
			'ledger: dropped add "no new deps": shorter than 12 characters',
			'ledger: dropped add "keep it": shorter than 12 characters',
		]);
		assert.deepEqual(rendered(summary), ['- "no new deps!"']);
	});

	it("is dropped when it quotes the assistant, a tool result or a custom message, never the user", async () => {
		const { pi } = compacting(reply([add("I won't add any new dependencies"), add("all 12 tests passing"), add("good point to Self-compact")]));
		pi.session.appendMessage(user("Add retries to the fetcher."));
		await pi.turnEnd({ message: said("Understood: I won't add any new dependencies.") });
		const run = calling("bash", { command: "npm test" });
		await pi.turnEnd({ message: run, toolResults: [result(run, "all 12 tests passing")] });
		pi.session.appendMessage({ role: "custom", customType: "compaction", content: "This is a good point to Self-compact.", display: false, timestamp: Date.now() });
		await pi.turnEnd({ message: said("Done.") });

		const { details, summary } = await compact(pi);
		assert.deepEqual(details.ledger, []);
		assert.equal(details.log.length, 3);
		for (const line of details.log) assert.match(line, /: not found in any user message$/);
		assert.deepEqual(rendered(summary), ["(none)"]);
	});

	it("may quote a user message the writer saw only in the kept tail", async () => {
		const tail: FakeSetup = { settings: { compaction: { keepRecentTokens: 20 }, retry: { enabled: false } } };
		const { pi } = compactingWith(tail, reply([add("Use exponential backoff, capped at 30s")]));
		pi.session.appendMessage(user("Add retries to the fetcher."));
		await pi.turnEnd({ message: said("On it.") });
		pi.session.appendMessage(user("Use exponential backoff, capped at 30s. That one's important to me."));
		await pi.turnEnd({ message: said("Will do.") });

		const done = await pi.compact();
		const removed = [...(done?.preparation.messagesToSummarize ?? []), ...(done?.preparation.turnPrefixMessages ?? [])];
		assert.ok(!removed.some((m) => m.role === "user" && JSON.stringify(m.content).includes("backoff")), "the message is in the kept tail");
		assert.deepEqual((done?.result?.compaction?.details as any).ledger, [{ quote: "Use exponential backoff, capped at 30s", kind: "constraint" }]);
	});
});

describe("a ledger supersede", () => {
	/** A first compaction that leaves two entries in the ledger, and a later message from the user overriding one. */
	async function twoRules(...later: Reply[]) {
		const { pi } = compacting(reply([add("don't add any new dependencies"), add("keep the public API unchanged")]), ...later);
		pi.session.appendMessage(user(RULES));
		await pi.turnEnd({ message: said("I'll stick to the standard library, then.") });
		await compact(pi);
		pi.session.appendMessage(user("Actually, you can use p-retry if it makes this simpler."));
		await pi.turnEnd({ message: said("Fine, p-retry it is: one new dependency is allowed now.") });
		return compact(pi);
	}

	it("retires the one active entry it names, by the user's later words: gone from the Handoff, kept in details", async () => {
		const { details, summary } = await twoRules(
			reply([supersede("don't add any new dependencies", "you can use p-retry if it makes this simpler")]),
		);
		assert.deepEqual(details.ledger, [
			{ quote: "don't add any new dependencies", kind: "constraint", supersededBy: "you can use p-retry if it makes this simpler" },
			{ quote: "keep the public API unchanged", kind: "constraint" },
		]);
		assert.deepEqual(details.log, []);
		assert.deepEqual(rendered(summary), ['- "keep the public API unchanged"']);
	});

	it("may name the entry by part of it, as long as only one entry contains that part", async () => {
		const { details } = await twoRules(reply([supersede("any new dependencies", "you can use p-retry if it makes this simpler")]));
		assert.equal(details.ledger[0].supersededBy, "you can use p-retry if it makes this simpler");
	});

	/** Each way a supersede is dropped, and what is logged for it. */
	const P_RETRY = "you can use p-retry if it makes this simpler";
	const DEPS = "don't add any new dependencies";
	const dropped: [string, string, string, string][] = [
		["names no active entry", "don't change the CLI flags", P_RETRY, 'ledger: dropped supersede of "don\'t change the CLI flags": it matches no active entry'],
		["names more than one", "an", P_RETRY, 'ledger: dropped supersede of "an": it matches 2 active entries'],
		[
			"quotes the assistant as its by",
			DEPS,
			"one new dependency is allowed now",
			`ledger: dropped supersede of "${DEPS}": its "by" quote "one new dependency is allowed now" is not found in any user message`,
		],
		["quotes under 12 characters as its by", DEPS, "p-retry", `ledger: dropped supersede of "${DEPS}": its "by" quote "p-retry" is shorter than 12 characters`],
	];
	for (const [how, old, by, logged] of dropped) {
		it(`is dropped, and the entry stays in force, when it ${how}`, async () => {
			const { details, summary } = await twoRules(reply([supersede(old, by)]));
			assert.deepEqual(details.ledger, [
				{ quote: "don't add any new dependencies", kind: "constraint" },
				{ quote: "keep the public API unchanged", kind: "constraint" },
			]);
			assert.deepEqual(details.log, [logged]);
			assert.deepEqual(rendered(summary), ['- "don\'t add any new dependencies"', '- "keep the public API unchanged"']);
		});
	}

	it("can't retire an entry already superseded", async () => {
		const { pi } = compacting(
			reply([add("don't add any new dependencies")]),
			reply([supersede("don't add any new dependencies", "you can use p-retry if it makes this simpler")]),
			reply([supersede("don't add any new dependencies", "Use whatever libraries you like")]),
		);
		pi.session.appendMessage(user(RULES));
		await pi.turnEnd({ message: said("On it.") });
		await compact(pi);
		pi.session.appendMessage(user("Actually, you can use p-retry if it makes this simpler."));
		await pi.turnEnd({ message: said("Using it.") });
		await compact(pi);
		pi.session.appendMessage(user("Use whatever libraries you like."));
		await pi.turnEnd({ message: said("Noted.") });

		const { details } = await compact(pi);
		assert.equal(details.ledger[0].supersededBy, "you can use p-retry if it makes this simpler");
		assert.deepEqual(details.log, ['ledger: dropped supersede of "don\'t add any new dependencies": it matches no active entry']);
	});
});

describe("the compaction focus", () => {
	/** A session that `/compact`s once with `focus`, then again with each of `later`, and the result of each. */
	async function focused(focus: string | undefined, ...later: (string | undefined)[]) {
		const { pi, model } = compacting(...[focus, ...later].map(() => reply([])));
		const results = [];
		for (const [n, instructions] of [focus, ...later].entries()) {
			pi.session.appendMessage(user(n === 0 ? RULES : `Step ${n} next, please.`));
			await pi.turnEnd({ message: said("On it.") });
			results.push(await compact(pi, instructions));
		}
		return { model, results };
	}

	it("is what /compact <instructions> asked for: told to the writer, and stored as a focus entry", async () => {
		const { model, results } = await focused("the retry path");
		const [{ details, summary }] = results as [{ details: any; summary: string }];
		assert.match(model.prompt(0), /The user asked for this compaction with: "the retry path"\. Give that the most care, but drop nothing else\./);
		assert.deepEqual(details.ledger, [{ quote: "the retry path", kind: "focus" }]);
		assert.deepEqual(rendered(summary), ['- Compaction focus: "the retry path"']);
	});

	it("lasts until the next /compact with instructions, which replaces it", async () => {
		const { model, results } = await focused("the retry path", undefined, "the error messages");
		const [, second, third] = results as { details: any; summary: string }[];
		// A compaction with no instructions leaves it in force, and asks the writer about nothing in particular.
		assert.deepEqual(second!.details.ledger, [{ quote: "the retry path", kind: "focus" }]);
		assert.doesNotMatch(model.prompt(1), /The user asked for this compaction with/);
		assert.deepEqual(third!.details.ledger, [
			{ quote: "the retry path", kind: "focus", supersededBy: "the error messages" },
			{ quote: "the error messages", kind: "focus" },
		]);
		assert.deepEqual(rendered(third!.summary), ['- Compaction focus: "the error messages"']);
	});

	it("is not one when the instructions are only whitespace", async () => {
		const { model, results } = await focused("  \n ");
		assert.deepEqual(results[0]!.details.ledger, []);
		assert.doesNotMatch(model.prompt(0), /The user asked for this compaction with/);
	});

	it("is code's: the writer can't supersede it, and no quote from the user is a duplicate of it", async () => {
		const { pi } = compacting(reply([]), reply([supersede("the retry path", "Add retries to the fetcher"), add("keep the public API unchanged")]));
		pi.session.appendMessage(user(RULES));
		await pi.turnEnd({ message: said("On it.") });
		await compact(pi, "keep the public API unchanged and the retry path");
		pi.session.appendMessage(user("Go on."));
		await pi.turnEnd({ message: said("Going.") });

		const { details } = await compact(pi);
		assert.deepEqual(details.ledger, [
			{ quote: "keep the public API unchanged and the retry path", kind: "focus" },
			{ quote: "keep the public API unchanged", kind: "constraint" },
		]);
		assert.deepEqual(details.log, ['ledger: dropped supersede of "the retry path": it matches no active entry']);
	});
});

describe("the ledger across compactions", () => {
	it("checks a quote against the previous Handoff's user messages too, which the writer no longer sees", async () => {
		const { pi } = compacting(reply([]), reply([add("keep the public API unchanged")]));
		pi.session.appendMessage(user(RULES));
		await pi.turnEnd({ message: said("On it.") });
		await compact(pi);
		pi.session.appendMessage(user("Now wire it in."));
		await pi.turnEnd({ message: said("Wired.") });

		const { details } = await compact(pi);
		assert.deepEqual(details.ledger, [{ quote: "keep the public API unchanged", kind: "constraint" }]);
		assert.deepEqual(details.log, []);
	});

	it("takes a reply with no <ledger> as no additions, and logs it", async () => {
		const { pi } = compacting(reply([add("keep the public API unchanged")]), reply(undefined), reply([]));
		pi.session.appendMessage(user(RULES));
		await pi.turnEnd({ message: said("On it.") });
		await compact(pi);
		pi.session.appendMessage(user("Now wire it in."));
		await pi.turnEnd({ message: said("Wired.") });

		const second = await compact(pi);
		assert.deepEqual(second.details.ledger, [{ quote: "keep the public API unchanged", kind: "constraint" }]);
		assert.deepEqual(second.details.log, ["ledger: the reply had no <ledger> block, so nothing was added"]);
		// An empty one is the writer saying there is nothing new.
		pi.session.appendMessage(user("And run the tests."));
		await pi.turnEnd({ message: said("They pass.") });
		assert.deepEqual((await compact(pi)).details.log, []);
	});

	it("drops an add contained in an active entry as a duplicate, but keeps one that only a superseded entry contains", async () => {
		const { pi } = compacting(
			reply([add("Please don't add any new dependencies, and keep the public API unchanged")]),
			reply([add("keep the public API unchanged"), supersede("Please don't add any new dependencies", "Actually, p-retry is fine as a dependency")]),
			reply([add("don't add any new dependencies"), add("keep the public API unchanged")]),
		);
		pi.session.appendMessage(user(RULES));
		await pi.turnEnd({ message: said("On it.") });
		await compact(pi);
		pi.session.appendMessage(user("Actually, p-retry is fine as a dependency."));
		await pi.turnEnd({ message: said("Using it.") });

		const second = await compact(pi);
		assert.deepEqual(second.details.log, [
			'ledger: dropped add "keep the public API unchanged": a duplicate of "Please don\'t add any new dependencies, and keep the public API unchanged"',
		]);
		pi.session.appendMessage(user("Go on."));
		await pi.turnEnd({ message: said("Going.") });
		const third = await compact(pi);
		assert.deepEqual(third.details.ledger, [
			{
				quote: "Please don't add any new dependencies, and keep the public API unchanged",
				kind: "constraint",
				supersededBy: "Actually, p-retry is fine as a dependency",
			},
			{ quote: "don't add any new dependencies", kind: "constraint" },
			{ quote: "keep the public API unchanged", kind: "constraint" },
		]);
		assert.deepEqual(third.details.log, []);
	});

	it("only grows over a chain of compactions: an entry survives each, one is superseded, and a writer that proposes nothing loses none", async () => {
		const { pi } = compacting(
			reply([add("don't add any new dependencies"), add("keep the public API unchanged")]),
			reply([add("run npm test before you tell me something is done")]),
			reply([supersede("don't add any new dependencies", "you can use p-retry if it makes this simpler")]),
			// The fourth is written by pi's summarizer, after the forked call and serialized mode fail: it proposes no ledger.
			{ text: "No Handoff here." },
			{ text: "No Handoff here." },
			{ text: "## Goal\nRetries." },
		);
		pi.session.appendMessage(user(RULES));
		await pi.turnEnd({ message: said("On it.") });
		const first = await compact(pi);
		pi.session.appendMessage(user("Also, run npm test before you tell me something is done."));
		await pi.turnEnd({ message: said("Will do.") });
		const second = await compact(pi);
		pi.session.appendMessage(user("Actually, you can use p-retry if it makes this simpler."));
		await pi.turnEnd({ message: said("Using it.") });
		const third = await compact(pi);
		pi.session.appendMessage(user("Go on."));
		await pi.turnEnd({ message: said("Going.") });
		const fourth = await compact(pi);

		const API = { quote: "keep the public API unchanged", kind: "constraint" };
		const TESTS = { quote: "run npm test before you tell me something is done", kind: "constraint" };
		const DEPS = { quote: "don't add any new dependencies", kind: "constraint" };
		const RETIRED = { ...DEPS, supersededBy: "you can use p-retry if it makes this simpler" };
		assert.deepEqual(first.details.ledger, [DEPS, API]);
		assert.deepEqual(second.details.ledger, [DEPS, API, TESTS]);
		assert.deepEqual(third.details.ledger, [RETIRED, API, TESTS]);
		assert.equal(fourth.details.writer, "pi-default");
		assert.deepEqual(fourth.details.ledger, [RETIRED, API, TESTS]);
		assert.deepEqual(fourth.details.log, []);
		assert.deepEqual(rendered(fourth.summary), ['- "keep the public API unchanged"', '- "run npm test before you tell me something is done"']);
	});

	it("has no size cap", async () => {
		const rules = Array.from({ length: 60 }, (_, i) => `Rule ${i + 1}: never touch module number ${i + 1}.`);
		const { pi } = compacting(reply(rules.map(add)));
		pi.session.appendMessage(user(rules.join("\n")));
		await pi.turnEnd({ message: said("On it.") });

		const { details, summary } = await compact(pi);
		assert.equal(details.ledger.length, 60);
		assert.equal(rendered(summary).length, 60);
	});
});

describe("on the boundary path", () => {
	it("a forced compaction gets the same checked ledger, merged into the previous one", async () => {
		const { pi } = compacting(
			reply([add("don't add any new dependencies")]),
			reply([add("keep the public API unchanged"), add("I'll keep the API as it is")]),
		);
		pi.session.appendMessage(user(RULES));
		await pi.turnEnd({ message: said("On it.") });
		await compact(pi, "the retry path");
		// `/compact` ended the run; the next prompt starts one.
		await pi.startRun();
		pi.session.appendMessage(user("Go on."));
		// Well under warning after the first compaction, so that forcing isn't paused.
		await pi.turnEnd({ tokens: 50_000, message: said("I'll keep the API as it is.") });

		const drafts = await pi.turnEnd({ tokens: 172_000, message: said("Wired it in.") });
		const compaction = drafts.find((draft) => draft.type === "compaction") as { details: any; summary: string } | undefined;
		assert.deepEqual(compaction?.details.ledger, [
			{ quote: "don't add any new dependencies", kind: "constraint" },
			{ quote: "the retry path", kind: "focus" },
			{ quote: "keep the public API unchanged", kind: "constraint" },
		]);
		assert.deepEqual(compaction?.details.log, ['ledger: dropped add "I\'ll keep the API as it is": not found in any user message']);
		assert.deepEqual(rendered(compaction?.summary ?? ""), [
			'- "don\'t add any new dependencies"',
			'- Compaction focus: "the retry path"',
			'- "keep the public API unchanged"',
		]);
	});
});
