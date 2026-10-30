/**
 * The replay check's deterministic half: the file-state diff, recurring-detail
 * retention and the collapse guard, scored on small fixture sessions written
 * for the purpose — never real transcripts.
 *
 * Each fixture is a session driven through the recording fake pi and compacted
 * the way pi would, so the Handoff under check is the one the extension really
 * writes; "what really happened next" is a few recorded messages that follow
 * the cut. A Handoff the extension would never write — one that has lost
 * something — is made by hand from a real one.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { HandoffDetails } from "../handoff.ts";
import { registerCompaction } from "../index.ts";
import { collapseGuard, fileStateDiff, recurringDetailRetention } from "../replay.ts";
import { calling, type FakePi, fakePi, result, said, user } from "./fake-pi.ts";
import { type Reply, scriptModel } from "./scripted-model.ts";

/** pi's summarizer's reply, in pi's own headings. */
const PI_SUMMARY = "## Goal\nAdd retries to the fetcher.\n\n## Progress\n- Wrote the wrapper.";

/** A fake pi with the extension on it, pi's summarizer scripted with `replies`, keeping only the newest message or so. */
function session(replies: Reply[] = [{ text: PI_SUMMARY }]): FakePi {
	const model = scriptModel(...replies);
	return fakePi({ settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: false } } }, (api) => registerCompaction(api, { stream: model.stream }));
}

/** One tool call and its result, as a turn that goes on. */
async function tool(pi: FakePi, name: string, args: Record<string, unknown>, isError = false): Promise<void> {
	const call = calling(name, args);
	await pi.turnEnd({ message: call, toolResults: [result(call, isError ? "failed" : "ok", isError)] });
}

function messagesOf(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

/** The compaction entries on the session's branch, oldest first: a chain of Handoffs, all of them ours here. */
function chainOf(pi: FakePi): CompactionEntry<HandoffDetails>[] {
	return pi.session.getBranch().filter((entry): entry is CompactionEntry<HandoffDetails> => entry.type === "compaction");
}

/**
 * The session as it stands at its newest compaction: that compaction, every
 * message it stands in for since the session began, and the kept tail.
 */
function cutAt(pi: FakePi): { handoff: CompactionEntry<HandoffDetails>; removed: AgentMessage[]; tail: AgentMessage[] } {
	const branch = pi.session.getBranch();
	const handoff = chainOf(pi).at(-1)!;
	const at = branch.indexOf(handoff);
	const kept = branch.findIndex((entry) => entry.id === handoff.firstKeptEntryId);
	return { handoff, removed: messagesOf(branch.slice(0, kept)), tail: messagesOf(branch.slice(kept, at)) };
}

describe("the file-state diff", () => {
	it("passes as exact when the Handoff's file state is the true one at the cut", async () => {
		const pi = session();
		pi.session.appendMessage(user("Tidy the fetcher."));
		await tool(pi, "read", { path: "src/api.ts" });
		await tool(pi, "read", { path: "src/fetch.ts" });
		await tool(pi, "edit", { path: "src/fetch.ts", oldText: "a", newText: "b" });
		await tool(pi, "write", { path: "src/retry.ts", content: "export {}" });
		await tool(pi, "bash", { command: "git rm -q src/old.ts" });
		await pi.turnEnd({ message: said("Tidied.") });
		pi.session.appendMessage(user("Thanks."));
		await pi.compact();

		const { handoff, removed } = cutAt(pi);
		const diff = fileStateDiff(handoff, removed);
		assert.equal(diff.exact, true);
		assert.deepEqual(diff.missing, []);
		assert.deepEqual(diff.extra, []);
		assert.deepEqual(diff.wrong, []);
	});

	it("fails a Handoff that leaves a file out, lists one never touched, or names the wrong operation", async () => {
		const pi = session();
		pi.session.appendMessage(user("Tidy the fetcher."));
		await tool(pi, "read", { path: "src/api.ts" });
		await tool(pi, "write", { path: "src/retry.ts", content: "export {}" });
		await tool(pi, "bash", { command: "rm src/old.ts" });
		await pi.turnEnd({ message: said("Tidied.") });
		pi.session.appendMessage(user("Thanks."));
		await pi.compact();

		const { handoff, removed } = cutAt(pi);
		const lossy = { ...handoff, details: { ...handoff.details, fileState: { "src/retry.ts": "edited", "src/old.ts": "deleted", "src/ghost.ts": "read" } } };
		const diff = fileStateDiff(lossy, removed);
		assert.equal(diff.exact, false);
		assert.deepEqual(diff.missing, ["src/api.ts"]);
		assert.deepEqual(diff.extra, ["src/ghost.ts"]);
		assert.deepEqual(diff.wrong, [{ path: "src/retry.ts", handoff: "edited", truth: "created" }]);
	});

	it("takes the truth from every message since the session began, with the Handoff's own mapping", async () => {
		const pi = session([{ text: PI_SUMMARY }, { text: PI_SUMMARY }]);
		pi.session.appendMessage(user("Tidy the fetcher."));
		await tool(pi, "write", { path: "src/retry.ts", content: "export {}" });
		await tool(pi, "read", { path: "src/fetch.ts" });
		await tool(pi, "bash", { command: "rm src/keep.ts" }, true);
		await pi.turnEnd({ message: said("Started.") });
		pi.session.appendMessage(user("Carry on."));
		await pi.compact();
		await tool(pi, "edit", { path: "src/retry.ts", oldText: "{}", newText: "{ retry }" });
		await tool(pi, "edit", { path: "src/fetch.ts", oldText: "a", newText: "b" });
		await tool(pi, "bash", { command: "mv src/legacy.ts src/compat.ts" });
		await pi.turnEnd({ message: said("Done.") });
		pi.session.appendMessage(user("Thanks."));
		await pi.compact();

		const { handoff, removed } = cutAt(pi);
		const diff = fileStateDiff(handoff, removed);
		// Written fresh, so created however often it was edited after; a failed `rm` deleted nothing.
		assert.deepEqual(diff.truth, { "src/retry.ts": "created", "src/fetch.ts": "edited", "src/legacy.ts": "deleted" });
		assert.equal(diff.exact, true);
	});

	it("scores pi's own compaction, which can say only read or modified, as not exact when a file was created or deleted", async () => {
		const pi = session();
		pi.session.appendMessage(user("Tidy the fetcher."));
		await tool(pi, "read", { path: "src/api.ts" });
		await tool(pi, "edit", { path: "src/fetch.ts", oldText: "a", newText: "b" });
		await tool(pi, "write", { path: "src/retry.ts", content: "export {}" });
		await pi.turnEnd({ message: said("Tidied.") });
		const removed = messagesOf(pi.session.getBranch());

		const pis = { summary: PI_SUMMARY, details: { readFiles: ["src/api.ts"], modifiedFiles: ["src/fetch.ts", "src/retry.ts"] } };
		const diff = fileStateDiff(pis, removed);
		assert.equal(diff.exact, false);
		assert.deepEqual(diff.wrong, [{ path: "src/retry.ts", handoff: "edited", truth: "created" }]);
		assert.deepEqual(diff.missing, []);
	});
});

describe("recurring-detail retention", () => {
	it("reports the share of the removed span's identifiers that come up after the cut and survive in the Handoff", async () => {
		const pi = session([{ text: "## Goal\nAdd retries to fetchJson.\n\n## Progress\n- retryWithBackoff fails with ECONNRESET." }]);
		pi.session.appendMessage(user("Add retries to fetchJson in src/fetch.ts, behind the --max-attempts flag."));
		await tool(pi, "edit", { path: "src/fetch.ts", oldText: "a", newText: "b" });
		const run = calling("bash", { command: "npm test -- --grep retryWithBackoff" });
		await pi.turnEnd({ message: run, toolResults: [result(run, "FAIL retryWithBackoff: ECONNRESET on port 8080", true)] });
		await pi.turnEnd({ message: said("The retry test fails.") });
		pi.session.appendMessage(user("Thanks."));
		await pi.compact();

		const { handoff, removed, tail } = cutAt(pi);
		const after = [user("Try port 8080 again: is retryWithBackoff still failing with ECONNRESET?"), calling("read", { path: "src/fetch.ts" })];
		const retention = recurringDetailRetention(handoff, { removed, tail, after });
		// fetchJson, --max-attempts and the rest never come up again, so they are not counted.
		assert.deepEqual(retention.recurring, ["src/fetch.ts", "retryWithBackoff", "ECONNRESET", "8080"]);
		// The path survives in the parts code writes, the rest in the writer's; the port survives nowhere.
		assert.deepEqual(retention.retained, ["src/fetch.ts", "retryWithBackoff", "ECONNRESET"]);
		assert.deepEqual(retention.lost, ["8080"]);
		assert.equal(retention.share, 0.75);
		assert.equal(retention.handoffChars, handoff.summary.length);
	});

	it("counts neither prose nor what the kept tail already shows, and has no share when nothing recurs", async () => {
		const pi = session();
		pi.session.appendMessage(user("Write parseRetryAfter for the and/or case, e.g. a date or seconds."));
		await tool(pi, "write", { path: "src/retry-after.ts", content: "export {}" });
		await pi.turnEnd({ message: said("Written.") });
		pi.session.appendMessage(user("Thanks, parseRetryAfter looks right."));
		await pi.compact();

		const { handoff, removed, tail } = cutAt(pi);
		assert.match(JSON.stringify(tail), /parseRetryAfter looks right/, "the fixture's last message is its kept tail");
		const after = [user("Does parseRetryAfter take a date, e.g. the and/or case?")];
		const retention = recurringDetailRetention(handoff, { removed, tail, after });
		assert.deepEqual(retention.recurring, []);
		assert.equal(retention.share, undefined);
	});

	it("scores pi's own summary the same way", async () => {
		const pi = session();
		pi.session.appendMessage(user("Make fetchJson retry on ECONNRESET."));
		await tool(pi, "edit", { path: "src/fetch.ts", oldText: "a", newText: "b" });
		await pi.turnEnd({ message: said("Done.") });
		const removed = messagesOf(pi.session.getBranch());

		const pis = { summary: "## Goal\nMake fetchJson retry.", details: { readFiles: [], modifiedFiles: ["src/fetch.ts"] } };
		const after = [user("Does fetchJson retry on ECONNRESET now? Check src/fetch.ts.")];
		const retention = recurringDetailRetention(pis, { removed, tail: [], after });
		assert.deepEqual(retention.retained, ["fetchJson"]);
		assert.deepEqual(retention.lost, ["ECONNRESET", "src/fetch.ts"]);
		assert.equal(retention.share, 1 / 3);
	});
});

describe("the collapse guard", () => {
	it("flags a chained Handoff whose writer wrote less than the one before it", async () => {
		const full = `${PI_SUMMARY}\n- Wired it into fetchJson.\n\n## Next step\nCap the backoff at 30s.`;
		const pi = session([{ text: full }, { text: "## Goal\nRetries." }]);
		pi.session.appendMessage(user("Add retries to the fetcher."));
		await tool(pi, "write", { path: "src/retry.ts", content: "export {}" });
		await pi.turnEnd({ message: said("Wrote the wrapper.") });
		pi.session.appendMessage(user("Carry on."));
		await pi.compact();
		await tool(pi, "edit", { path: "src/fetch.ts", oldText: "a", newText: "b" });
		await pi.turnEnd({ message: said("Wired it in.") });
		pi.session.appendMessage(user("Thanks."));
		await pi.compact();

		const guard = collapseGuard(chainOf(pi));
		assert.equal(guard.collapsed, true);
		assert.deepEqual(guard.flags, [{ depth: 2, measure: "size", before: full.length, after: "## Goal\nRetries.".length }]);
	});

	it("passes a chain where each Handoff carries everything the one before it did", async () => {
		const pi = session([{ text: PI_SUMMARY }, { text: `${PI_SUMMARY}\n- Wired it in.` }]);
		pi.session.appendMessage(user("Add retries to the fetcher."));
		await tool(pi, "write", { path: "src/retry.ts", content: "export {}" });
		await pi.turnEnd({ message: said("Wrote the wrapper.") });
		pi.session.appendMessage(user("Carry on."));
		await pi.compact();
		await tool(pi, "edit", { path: "src/fetch.ts", oldText: "a", newText: "b" });
		await pi.turnEnd({ message: said("Wired it in.") });
		pi.session.appendMessage(user("Thanks."));
		await pi.compact();

		const guard = collapseGuard(chainOf(pi));
		assert.equal(guard.collapsed, false);
		assert.deepEqual(guard.flags, []);
		assert.deepEqual(guard.measures, [
			{ size: PI_SUMMARY.length, ledger: 0, files: 1, userMessages: 1, openItems: undefined },
			{ size: PI_SUMMARY.length + "\n- Wired it in.".length, ledger: 0, files: 2, userMessages: 2, openItems: undefined },
		]);
	});

	it("flags each count that fell: ledger entries, files, user messages and open items", async () => {
		const pi = session();
		pi.session.appendMessage(user("Add retries to the fetcher. Never touch the public API."));
		await tool(pi, "read", { path: "src/api.ts" });
		await tool(pi, "write", { path: "src/retry.ts", content: "export {}" });
		await pi.turnEnd({ message: said("Wrote the wrapper.") });
		pi.session.appendMessage(user("Thanks."));
		await pi.compact();

		const [real] = chainOf(pi);
		const sections = {
			goal: "Add retries.",
			progress: "- Wrote the wrapper.",
			decisions: "- Exponential backoff.",
			openProblems: "- The retry test fails.\n- No cap on the backoff.\n- Unclear what to do on 429.",
			criticalContext: "Run `npm test`.",
			nextStep: "Cap the backoff.",
		};
		const ledger = [{ quote: "Never touch the public API.", kind: "constraint" }, { quote: "Add retries to the fetcher.", kind: "focus" }];
		const first = { ...real!, details: { ...real!.details, sections, ledger } };
		const second = {
			...real!,
			details: {
				...real!.details,
				sections: { ...sections, openProblems: "- The retry test fails." },
				ledger: ledger.slice(0, 1),
				fileState: { "src/retry.ts": "created" },
				userMessages: [],
			},
		};

		const guard = collapseGuard([first, second]);
		assert.equal(guard.collapsed, true);
		assert.deepEqual(
			guard.flags.map(({ measure, before, after }) => [measure, before, after]),
			[
				["size", guard.measures[0]!.size, guard.measures[1]!.size],
				["ledger", 2, 1],
				["files", 2, 1],
				["userMessages", 1, 0],
				["openItems", 3, 1],
			],
		);
		assert.ok(guard.flags.every((flag) => flag.depth === 2));
	});

	it("counts a user message dropped to fit as still carried", async () => {
		const pi = session();
		pi.session.appendMessage(user("Add retries to the fetcher."));
		await pi.turnEnd({ message: said("On it.") });
		pi.session.appendMessage(user("Thanks."));
		await pi.compact();

		const [real] = chainOf(pi);
		const details = real!.details as { userMessages: string[] };
		const first = { ...real!, details: { ...details, userMessages: ["first", "second", "third"], droppedUserMessages: 0 } };
		const second = { ...real!, details: { ...details, userMessages: ["first", "third", "fourth"], droppedUserMessages: 1 } };
		assert.deepEqual(collapseGuard([first, second]).flags, []);
	});

	it("measures pi's own compactions by their summary and file lists, and compares only what both have", () => {
		const pis = (summary: string, readFiles: string[]) => ({ summary, details: { readFiles, modifiedFiles: ["src/fetch.ts"] } });
		const ours = { summary: PI_SUMMARY, details: { kind: "handoff", version: 1, sections: { piDefault: PI_SUMMARY }, ledger: [], fileState: {}, userMessages: [], droppedUserMessages: 0 } };

		const guard = collapseGuard([pis(`${PI_SUMMARY}\n- More.`, ["src/api.ts"]), pis(PI_SUMMARY, []), ours]);
		assert.deepEqual(guard.measures[0], { size: PI_SUMMARY.length + "\n- More.".length, ledger: undefined, files: 2, userMessages: undefined, openItems: undefined });
		assert.deepEqual(
			guard.flags.map(({ depth, measure }) => [depth, measure]),
			[
				[2, "size"],
				[2, "files"],
				[3, "files"],
			],
		);
	});
});
