/**
 * The Handoff on the hook path: what `/compact` and pi's own backstop get from
 * `session_before_compact` — our compaction entry, its `details` record and the
 * summary rendered from it — with pi's summarizer as the writer, the forked
 * call and serialized mode in front of it scripted to fail.
 *
 * Driven only through the recording fake pi, with the model call scripted: a
 * test builds a session, compacts it the way pi would, and reads back what was
 * returned, what the summarizer was asked and what the user was shown.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerCompaction } from "../index.ts";
import { calling, type FakeSetup, fakePi, result, said, user } from "./fake-pi.ts";
import { type Reply, scriptModel } from "./scripted-model.ts";

/** pi's summarizer's reply, in pi's own headings. */
const PI_SUMMARY = "## Goal\nAdd retries to the fetcher.\n\n## Progress\n- Wrote the wrapper.";

/** A session whose compaction keeps only the newest message or so, so nearly everything is in the removed span. */
const SMALL_TAIL: FakeSetup = { settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: false } } };

/** What the forked call and serialized mode get here: a reply neither can use, so that pi's summarizer, last in the chain, writes. */
const NO_HANDOFF: Reply = { text: "I'll carry on with the fetcher." };
const FORK_FAILED = { writer: "fork", reason: "the reply has no <handoff> block" };
const SERIALIZED_FAILED = { writer: "serialized", reason: "the reply has no <handoff> block" };

/**
 * A fake pi with the extension on it, and pi's summarizer scripted to answer
 * each compaction with the next of `replies`. Each compaction is three model
 * calls: the forked call's and serialized mode's, which fail, and then pi's
 * summarizer's — two on overflow, where the fork is skipped.
 */
function compacting(replies: Reply[], setup: FakeSetup = SMALL_TAIL, overflow = false) {
	const model = scriptModel(...replies.flatMap((reply) => [...(overflow ? [] : [NO_HANDOFF]), NO_HANDOFF, reply]));
	const pi = fakePi(setup, (api) => registerCompaction(api, { stream: model.stream }));
	return { pi, model };
}

/** The `details` of what the chain returned. */
function detailsOf(done: Awaited<ReturnType<ReturnType<typeof fakePi>["compact"]>>): any {
	return done?.result?.compaction?.details;
}

describe("the hook path", () => {
	it("gives /compact our compaction entry, carrying our details, with pi's summarizer as the writer", async () => {
		const { pi } = compacting([{ text: PI_SUMMARY }]);
		pi.session.appendMessage(user("Add retries to the fetcher."));
		await pi.turnEnd({ message: said("On it.") });
		pi.session.appendMessage(user("Go ahead."));
		await pi.turnEnd({ message: said("Done.") });

		const done = await pi.compact();
		assert.ok(done?.result?.compaction, "a compaction came back");
		assert.equal(done.result.cancel, undefined);
		assert.equal(done.result.compaction.firstKeptEntryId, done.preparation.firstKeptEntryId);
		assert.equal(done.result.compaction.tokensBefore, done.preparation.tokensBefore);
		const details = detailsOf(done);
		assert.equal(details.kind, "handoff");
		assert.equal(details.version, 1);
		assert.equal(details.writer, "pi-default");
		assert.deepEqual(details.sections, { piDefault: PI_SUMMARY });
		assert.match(done.result.compaction.summary, /Add retries to the fetcher\.\n\n## Progress\n- Wrote the wrapper\./);
		assert.deepEqual(pi.errors, []);
	});
});

describe("the user's words", () => {
	it("carries every message the user typed in the removed span, in order, and nothing else", async () => {
		const { pi } = compacting([{ text: PI_SUMMARY }]);
		pi.session.appendMessage(user("Add retries to the fetcher.\nKeep the public API unchanged."));
		const ask = calling("ask_question", { question: "Which backoff?" });
		await pi.turnEnd({ message: ask, toolResults: [result(ask, "Your question is on its way to the session that delegated this task.")] });
		// The answer to a Question reaches a Run as its next prompt.
		pi.session.appendMessage(user("Exponential, capped at 30s."));
		// Custom messages are not the user's words, though pi sends them to the model as user messages.
		pi.session.appendMessage({ role: "custom", customType: "compaction", content: "This is a good point to Self-compact.", display: false, timestamp: Date.now() });
		pi.session.appendMessage({ role: "custom", customType: "subagent-steer", content: "The user sent run `scout` a message directly.", display: true, timestamp: Date.now() });
		const run = calling("bash", { command: "npm test" });
		await pi.turnEnd({ message: run, toolResults: [result(run, "user: not a user message")] });
		pi.session.appendMessage(user("Looks good."));
		await pi.turnEnd({ message: said("Done.") });

		const details = detailsOf(await pi.compact());
		assert.deepEqual(details.userMessages, ["Add retries to the fetcher.\nKeep the public API unchanged.", "Exponential, capped at 30s.", "Looks good."]);
		assert.equal(details.droppedUserMessages, 0);
	});

	it("renders them verbatim and numbered", async () => {
		const { pi } = compacting([{ text: PI_SUMMARY }]);
		pi.session.appendMessage(user("Add retries.\nKeep the API."));
		await pi.turnEnd({ message: said("On it.") });
		pi.session.appendMessage(user("Go ahead."));
		await pi.turnEnd({ message: said("Done.") });

		const summary = (await pi.compact())?.result?.compaction?.summary ?? "";
		assert.match(summary, /## User messages \(verbatim\)\n\[1\] Add retries\.\nKeep the API\.\n\[2\] Go ahead\.(\n|$)/);
	});

	it("keeps the first message and the newest within ~20K tokens, counting what was dropped between them", async () => {
		const { pi } = compacting([{ text: PI_SUMMARY }]);
		// Fifteen messages of 1,750 tokens each: the first, then the ten newest, fit in 20K.
		const message = (n: number) => `m${n} `.padEnd(7_000, "x");
		for (let n = 1; n <= 15; n++) {
			pi.session.appendMessage(user(message(n)));
			await pi.turnEnd({ message: said("Noted.") });
		}

		const done = await pi.compact();
		const details = detailsOf(done);
		assert.deepEqual(
			details.userMessages.map((text: string) => text.split(" ")[0]),
			["m1", "m6", "m7", "m8", "m9", "m10", "m11", "m12", "m13", "m14", "m15"],
		);
		assert.equal(details.droppedUserMessages, 4);
		const summary = done?.result?.compaction?.summary ?? "";
		assert.match(summary, /\n\[1\] m1 x+\n\[… 4 messages dropped here to fit …\]\n\[6\] m6 x+\n/);
	});

	it("cuts a single message over ~2K tokens to its head and tail, with a marker", async () => {
		const { pi } = compacting([{ text: PI_SUMMARY }]);
		const log = `HEAD${"a".repeat(9_996)}${"b".repeat(9_996)}TAIL`;
		pi.session.appendMessage(user(log));
		await pi.turnEnd({ message: said("Reading it.") });
		pi.session.appendMessage(user("Thanks."));
		await pi.turnEnd({ message: said("Done.") });

		const [kept] = detailsOf(await pi.compact()).userMessages;
		assert.equal(kept, `HEAD${"a".repeat(3_996)}\n[… 12,000 characters cut …]\n${"b".repeat(3_996)}TAIL`);
	});
});

/** One tool call and its result, as a turn that goes on. */
async function tool(pi: ReturnType<typeof fakePi>, name: string, args: Record<string, unknown>, isError = false): Promise<void> {
	const call = calling(name, args);
	await pi.turnEnd({ message: call, toolResults: [result(call, isError ? "failed" : "ok", isError)] });
}

describe("file state", () => {
	it("lists files created, edited, deleted and read but unchanged, from the span's tool calls", async () => {
		const { pi } = compacting([{ text: PI_SUMMARY }]);
		pi.session.appendMessage(user("Tidy the fetcher."));
		await tool(pi, "read", { path: "src/api.ts" });
		await tool(pi, "read", { path: "src/fetch.ts" });
		await tool(pi, "edit", { path: "src/fetch.ts", oldText: "a", newText: "b" });
		await tool(pi, "write", { path: "src/retry.ts", content: "export {}" });
		await tool(pi, "edit", { path: "src/retry.ts", oldText: "{}", newText: "{ retry }" });
		await tool(pi, "read", { path: "README.md" });
		await tool(pi, "write", { path: "README.md", content: "# fetch" });
		await tool(pi, "bash", { command: "git rm -q src/old.ts && rm -f tmp/a.log tmp/b.log" });
		await tool(pi, "bash", { command: "mv src/legacy.ts src/compat.ts" });
		// A failed delete deleted nothing, and nothing after a `cd` can be placed.
		await tool(pi, "bash", { command: "rm src/keep.ts" }, true);
		await tool(pi, "bash", { command: "cd sub && rm x.ts" });
		await tool(pi, "bash", { command: "rm -rf build/*" });
		await tool(pi, "bash", { command: "git rm --cached src/tracked.ts" });
		await pi.turnEnd({ message: said("Tidied.") });

		const done = await pi.compact();
		assert.deepEqual(detailsOf(done).fileState, {
			"src/api.ts": "read",
			"src/fetch.ts": "edited",
			"src/retry.ts": "created",
			"README.md": "edited",
			"src/old.ts": "deleted",
			"tmp/a.log": "deleted",
			"tmp/b.log": "deleted",
			"src/legacy.ts": "deleted",
		});
		assert.match(
			done?.result?.compaction?.summary ?? "",
			/## File state\n- read src\/api\.ts\n- edited src\/fetch\.ts\n- created src\/retry\.ts\n- edited README\.md\n- deleted src\/old\.ts\n/,
		);
	});

	it("is unioned with the previous Handoff's on a repeat compaction", async () => {
		const { pi } = compacting([{ text: PI_SUMMARY }, { text: PI_SUMMARY }]);
		pi.session.appendMessage(user("Tidy the fetcher."));
		await tool(pi, "write", { path: "src/retry.ts", content: "export {}" });
		await tool(pi, "read", { path: "src/api.ts" });
		await tool(pi, "read", { path: "src/fetch.ts" });
		await pi.turnEnd({ message: said("Started.") });
		await pi.compact();

		pi.session.appendMessage(user("Carry on."));
		await tool(pi, "edit", { path: "src/retry.ts", oldText: "{}", newText: "{ retry }" });
		await tool(pi, "edit", { path: "src/fetch.ts", oldText: "a", newText: "b" });
		await tool(pi, "read", { path: "src/types.ts" });
		await pi.turnEnd({ message: said("Done.") });

		assert.deepEqual(detailsOf(await pi.compact()).fileState, {
			"src/retry.ts": "created",
			"src/api.ts": "read",
			"src/fetch.ts": "edited",
			"src/types.ts": "read",
		});
	});

	it("takes up what pi's own previous compaction knew about files", async () => {
		const { pi } = compacting([{ text: PI_SUMMARY }]);
		pi.session.appendMessage(user("Tidy the fetcher."));
		await pi.turnEnd({ message: said("Started.") });
		const kept = pi.session.appendMessage(user("Go on."));
		pi.session.appendCompaction("pi's summary", kept, 50_000, { readFiles: ["src/api.ts"], modifiedFiles: ["src/fetch.ts"] });
		await tool(pi, "read", { path: "src/types.ts" });
		await pi.turnEnd({ message: said("Done.") });

		assert.deepEqual(detailsOf(await pi.compact()).fileState, { "src/api.ts": "read", "src/fetch.ts": "edited", "src/types.ts": "read" });
	});
});

describe("a repeat compaction", () => {
	it("merges from the previous details, and records which compaction, who wrote it and what failed", async () => {
		const SECOND = "## Goal\nAdd retries to the fetcher.\n\n## Progress\n- Wrapper done, tests pass.";
		const { pi, model } = compacting([{ text: PI_SUMMARY }, { text: SECOND }]);
		pi.session.appendMessage(user("Add retries to the fetcher."));
		await pi.turnEnd({ message: said("On it.") });
		const first = await pi.compact();
		assert.equal(detailsOf(first).compactionNo, 1);

		pi.session.appendMessage(user("Now run the tests."));
		await pi.turnEnd({ message: said("They pass.") });
		const second = await pi.compact();
		const details = detailsOf(second);
		assert.equal(details.compactionNo, 2);
		assert.equal(details.writer, "pi-default");
		assert.deepEqual(details.attempts, [FORK_FAILED, SERIALIZED_FAILED]);
		assert.deepEqual(details.log, []);
		assert.deepEqual(details.userMessages, ["Add retries to the fetcher.", "Now run the tests."]);
		assert.deepEqual(details.sections, { piDefault: SECOND });
		// pi's summarizer updates the previous judgment part rather than starting over —
		// handed the record's own text, not the old summary with our parts in it.
		assert.match(model.prompt(5), /<previous-summary>\n## Goal\nAdd retries to the fetcher\.\n\n## Progress\n- Wrote the wrapper\.\n<\/previous-summary>/);
		assert.doesNotMatch(model.prompt(5), /<previous-summary>[^]*## User messages/);
	});

	it("carries the previous Constraint ledger forward, superseded entries included, and renders only the active ones", async () => {
		const { pi } = compacting([{ text: PI_SUMMARY }]);
		pi.session.appendMessage(user("Don't add any new dependencies, please."));
		await pi.turnEnd({ message: said("Understood.") });
		const kept = pi.session.appendMessage(user("Actually p-retry is fine."));
		const ledger = [
			{ quote: "Don't add any new dependencies", kind: "constraint", supersededBy: "Actually p-retry is fine." },
			{ quote: "Keep the public API unchanged", kind: "constraint" },
			{ quote: "the retry path", kind: "focus" },
		];
		pi.session.appendCompaction("(earlier Handoff)", kept, 50_000, {
			kind: "handoff",
			version: 1,
			compactionNo: 1,
			writer: "pi-default",
			attempts: [],
			userMessages: ["Don't add any new dependencies, please."],
			droppedUserMessages: 0,
			ledger,
			fileState: {},
			note: "Next I wire the wrapper in.",
			sections: { piDefault: "## Goal\nRetries." },
			log: [],
		}, true);
		await pi.turnEnd({ message: said("Using p-retry.") });

		const done = await pi.compact();
		const details = detailsOf(done);
		assert.deepEqual(details.ledger, ledger);
		// The note lasts one compaction: never merged forward.
		assert.equal(details.note, undefined);
		assert.deepEqual(details.userMessages, ["Don't add any new dependencies, please.", "Actually p-retry is fine."]);
		assert.match(
			done?.result?.compaction?.summary ?? "",
			/## Constraint ledger\n- "Keep the public API unchanged"\n- Compaction focus: "the retry path"\n\n/,
		);
		assert.doesNotMatch(done?.result?.compaction?.summary ?? "", /Next I wire the wrapper in/);
	});
});

describe("the rendered Handoff", () => {
	it("is in its fixed order, with pi's text standing in where the judgment sections begin", async () => {
		const { pi } = compacting([{ text: PI_SUMMARY }]);
		pi.session.appendMessage(user("Add retries to the fetcher."));
		await tool(pi, "read", { path: "src/fetch.ts" });
		await pi.turnEnd({ message: said("Done.") });

		const summary = (await pi.compact())?.result?.compaction?.summary;
		assert.equal(
			summary,
			[
				PI_SUMMARY,
				"## Constraint ledger\n(none)",
				"## File state\n- read src/fetch.ts",
				"## User messages (verbatim)\n[1] Add retries to the fetcher.",
			].join("\n\n"),
		);
	});
});

describe("pi's summarizer as the writer", () => {
	it("is asked about the removed span, on the reply's model and thinking level, with the session id and the /compact focus", async () => {
		const { pi, model } = compacting([{ text: PI_SUMMARY }], { ...SMALL_TAIL, thinkingLevel: "high" });
		pi.session.appendMessage(user("Add retries to the fetcher."));
		await pi.turnEnd({ message: said("On it.") });
		pi.session.appendMessage(user("The kept tail starts here."));
		await pi.turnEnd({ message: said("Done.") });

		await pi.compact({ customInstructions: "the retry path" });
		assert.equal(model.calls.length, 3);
		const call = model.calls[2];
		assert.equal(call?.model.id, "fable-5");
		assert.equal(call?.options?.reasoning, "high");
		assert.equal(call?.options?.sessionId, pi.session.getSessionId());
		assert.match(model.prompt(2), /<conversation>[^]*Add retries to the fetcher\.[^]*<\/conversation>/);
		assert.match(model.prompt(2), /Additional focus: the retry path$/);
	});

	it("writes the Handoff for pi's threshold and overflow backstop too", async () => {
		for (const reason of ["threshold", "overflow"] as const) {
			const { pi } = compacting([{ text: PI_SUMMARY }], SMALL_TAIL, reason === "overflow");
			pi.session.appendMessage(user("Add retries to the fetcher."));
			await pi.turnEnd({ message: said("Done.") });
			const details = detailsOf(await pi.compact({ reason }));
			assert.equal(details?.kind, "handoff", reason);
			assert.deepEqual(details.sections, { piDefault: PI_SUMMARY }, reason);
			assert.deepEqual(details.userMessages, ["Add retries to the fetcher."], reason);
		}
	});
});

describe("what the user sees", () => {
	/** A session with something to compact, at warning pressure. */
	async function underPressure(replies: Reply[], setup: FakeSetup = SMALL_TAIL) {
		const scripted = compacting(replies, setup);
		scripted.pi.session.appendMessage(user("Add retries to the fetcher."));
		await scripted.pi.turnEnd({ tokens: 152_000, message: said("Done.") });
		return scripted;
	}

	it("warns that pi's default summary wrote the Handoff, and draws nothing else", async () => {
		const { pi } = await underPressure([{ text: PI_SUMMARY }]);
		const toastsBefore = pi.notifications.length;
		const sentBefore = pi.sent.length;
		await pi.compact();
		assert.deepEqual(pi.notifications.slice(toastsBefore), [{ message: "Compaction used pi's default summary; the Handoff may be thinner.", type: "warning" }]);
		// Nothing of ours on pi's compaction indicator or its card.
		assert.deepEqual(pi.working, []);
		assert.equal(pi.sent.length, sentBefore);
	});

	it("clears the footer status while compacting, and leaves it for the next reading to restore", async () => {
		let during: string | undefined = "unread";
		const { pi } = await underPressure([{ text: PI_SUMMARY, during: () => (during = pi.status()) }]);
		assert.equal(pi.status(), "<warning>ctx warning · 152k</warning>");
		await pi.compact();
		assert.equal(during, undefined);
		assert.equal(pi.status(), undefined);

		// The next reading after a compaction paints it again only at notice or above.
		await pi.startRun();
		pi.session.appendMessage(user("Next."));
		await pi.turnEnd({ tokens: 30_000, message: said("Ok.") });
		assert.equal(pi.status(), undefined);
		await pi.turnEnd({ tokens: 125_000, message: said("Ok.") });
		assert.equal(pi.status(), "<muted>ctx notice · 125k</muted>");
	});

	it("says compacting in a Run's status while it writes, and clears it after", async () => {
		let during: string | undefined;
		const { pi } = await underPressure([{ text: PI_SUMMARY, during: () => (during = pi.status()) }], { ...SMALL_TAIL, mode: "rpc" });
		assert.equal(pi.status(), "ctx warning · 152k");
		await pi.compact();
		assert.equal(during, "ctx compacting");
		assert.equal(pi.status(), undefined);
	});
});

describe("when the Handoff can't be written", () => {
	it("compacts nothing when the writer fails, says so, and puts the status back", async () => {
		const { pi } = await (async () => {
			const scripted = compacting([{ errorMessage: "invalid_request_error: prompt is too long" }]);
			scripted.pi.session.appendMessage(user("Add retries to the fetcher."));
			await scripted.pi.turnEnd({ tokens: 125_000, message: said("Done.") });
			return scripted;
		})();
		const done = await pi.compact();
		assert.deepEqual(done?.result, { cancel: true });
		assert.equal(done?.entryId, undefined);
		assert.deepEqual(pi.notifications, [
			{
				message:
					"Compaction failed (Summarization failed: invalid_request_error: prompt is too long). Context will keep growing until the next run or pi's own compaction.",
				type: "error",
			},
		]);
		assert.equal(pi.status(), "<muted>ctx notice · 125k</muted>");
	});

	it("stops on Escape: nothing compacted, no toast, the status back", async () => {
		const { pi, model } = compacting([{ text: PI_SUMMARY, during: () => pi.escapeCompaction() }]);
		pi.session.appendMessage(user("Add retries to the fetcher."));
		await pi.turnEnd({ tokens: 125_000, message: said("Done.") });
		const done = await pi.compact();
		// The writer stops on the compaction's own signal: `/compact` had already aborted the run's.
		assert.equal(model.calls[2]?.options?.signal?.aborted, true);
		assert.deepEqual(done?.result, { cancel: true });
		assert.deepEqual(pi.notifications, []);
		assert.equal(pi.status(), "<muted>ctx notice · 125k</muted>");
	});
});
