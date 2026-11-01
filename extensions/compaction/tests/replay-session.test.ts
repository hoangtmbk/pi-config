/**
 * Replaying one recorded session: the whole of what the live runner does to a
 * session, offline. The session is cut in a chain; at each cut our extension
 * writes a Handoff through the fake pi and pi's own compaction writes its
 * default summary, both continuations carry on against the recording, the
 * judge scores the cut and the deterministic checks run on both.
 *
 * Every model call is scripted, routed by what is being asked: the forked
 * call's instruction, pi's summarizer, the agent answering its steer, the
 * continuation, and the judge. The recording is a fixture written for the
 * purpose.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Context, getCurrentTools, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { HandoffDetails } from "../handoff.ts";
import { FORK_PREAMBLE } from "../instruction.ts";
import { type CutKind, readRecording } from "../replay/replay-corpus.ts";
import { CALL_CAP_MS, CALL_STALL_MS, guardCall, type ReplayDeps, rejudgeProblem, rejudgeSession, replaySession, type SessionResult, type Spending } from "../replay/replay-session.ts";
import { MODEL } from "./fake-pi.ts";
import { recorder } from "./recordings.ts";
import { fakeClock, type Reply, scriptModel } from "./scripted-model.ts";

const RULE = "Never touch the generated files under gen/";
const NOTE = "Retries are wired in; next I run the tests.";
const PI_SUMMARY = "## Goal\nAdd retries to the fetcher.\n\n## Progress\n- Read the fetcher.";

const HANDOFF = `<handoff>
## Goal
Add retries to the fetcher. "Add retries to the fetcher."
## Progress
Done: read src/fetch.ts.
## Decisions and why
(none)
## Open problems
(none)
## Critical context
src/fetch.ts
## Next step
Carry on with the retries. "Add retries to the fetcher."
</handoff>
<ledger>
<add>${RULE}</add>
</ledger>`;

/**
 * A session with room for a chain of three cuts, and three user turns after
 * the last. Recorded before the extension was loaded, as every real one in the
 * corpus was, so it declares no `self_compact`.
 */
function session(): string {
	const read = (path: string) => ({ name: "read", arguments: { path }, result: `contents of ${path}` });
	return recorder("/work")
		.system(undefined, ["read", "write", "edit", "bash"])
		.user(`Add retries to the fetcher. ${RULE}.`, 150)
		.turn([read("src/fetch.ts")], { tokens: 100 })
		.turn([read("src/retry.ts")], { tokens: 100 })
		.turn([{ name: "edit", arguments: { path: "src/fetch.ts", oldText: "fetch(", newText: "retry(fetch)(" }, result: "Edited." }], { tokens: 150 })
		.turn([{ name: "bash", arguments: { command: "npm test" }, result: "12 passing" }], { tokens: 150 })
		.say("Retries are in and the tests pass.")
		.user("Now the docs.", 100)
		.turn([read("README.md")], { tokens: 150 })
		.turn([{ name: "write", arguments: { path: "docs/retry.md", content: "# Retries" }, result: "Wrote docs/retry.md" }], { tokens: 150 })
		.say("Docs written.")
		.user("Add a changelog entry.")
		.turn([{ name: "edit", arguments: { path: "CHANGELOG.md", oldText: "## Next", newText: "## Next\n- Retries" }, result: "Edited." }], { tokens: 100 })
		.say("Added.")
		.user("Commit it.")
		.turn([{ name: "bash", arguments: { command: "git commit -am retries" }, result: "1 file changed" }])
		.say("Committed.")
		.user("Thanks.")
		.say("You're welcome.")
		.text();
}

/** The text of a request's last user message. */
function lastUser(context: Context): string {
	const message = context.messages.filter((m) => m.role === "user").at(-1);
	if (!message) return "";
	return typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** A request's system prompt, however it carries it. */
function systemText(context: Context): string {
	const system = context.messages.find((m) => m.role === "system");
	const content = system?.content ?? "";
	return (context.systemPrompt ?? "") + (typeof content === "string" ? content : content.map((part) => part.text).join(""));
}

interface Routed {
	/** What each call was for, in the order made. */
	asked: string[];
	/** What the agent was steered with, each time it was. */
	steers: string[];
	/** The tools each steered request declared. */
	steeredTools: string[][];
	deps: ReplayDeps;
}

/** A judge's verdict: ours carries the rule, pi's summary doesn't; nobody re-asks, redoes or breaks anything. */
function verdict(oursIs: "A" | "B"): Reply {
	const carried = (yes: boolean) => ({ carried: yes, evidence: yes ? `"${RULE}"` : "not mentioned" });
	const clean = { violations: [], reask: { verdict: false, evidence: "asks nothing" }, redone: { verdict: false, evidence: "nothing redone" } };
	const piIs = oursIs === "A" ? "B" : "A";
	return { text: JSON.stringify({ constraints: [{ quote: RULE, [oursIs]: carried(true), [piIs]: carried(false) }], A: clean, B: clean }) };
}

/** The replay's dependencies, every model call scripted by what it is asked. */
function routed(options: { selfCompacts?: boolean; reachable?: (provider: string, id: string) => boolean } = {}): Routed {
	const asked: string[] = [];
	const steers: string[] = [];
	const steeredTools: string[][] = [];
	let cut = 0;
	const sessionModel = (model: Model<any>, context: Context, streamOptions?: SimpleStreamOptions) => {
		const last = lastUser(context);
		let reply: Reply;
		if (last.startsWith(FORK_PREAMBLE)) {
			asked.push("fork");
			reply = { text: HANDOFF };
		} else if (systemText(context).includes("summarization") || last.includes("# Instructions")) {
			// pi's summarizer, and its summary of a split turn's start.
			asked.push("pi-default");
			reply = { text: PI_SUMMARY };
		} else if (context.messages.at(-1)?.role === "user" && last.includes("Self-compact")) {
			asked.push("steered");
			steers.push(last);
			const tools = getCurrentTools(context.messages).map((tool) => tool.name);
			steeredTools.push(tools);
			// A model can only call a tool its request declares.
			const compacts = options.selfCompacts !== false && tools.includes("self_compact");
			reply = compacts ? { toolCall: { name: "self_compact", arguments: { note: NOTE } }, stopReason: "toolUse" } : { text: "I'll finish this step first." };
		} else {
			asked.push("continuation");
			reply = { text: "Carrying on with the task." };
		}
		return scriptModel(reply).stream(model, context, streamOptions);
	};
	const judge = (model: Model<any>, context: Context, streamOptions?: SimpleStreamOptions) => {
		asked.push("judge");
		return scriptModel(verdict(cut++ % 2 === 0 ? "A" : "B")).stream(model, context, streamOptions);
	};
	let blind = 0;
	const deps: ReplayDeps = {
		settings: { compaction: { keepRecentTokens: 150 }, retry: { enabled: false } },
		kinds: ["self", "forced", "before-user"] as CutKind[],
		findModel: (provider, id) => ((options.reachable?.(provider, id) ?? true) && provider === MODEL.provider && id === MODEL.id ? MODEL : undefined),
		stream: (_spending: Spending) => sessionModel,
		judge: { model: { ...MODEL, id: "claude-fable-5" }, stream: judge },
		oursSide: () => (blind++ % 2 === 0 ? "A" : "B"),
		prunedDir: mkdtempSync(join(tmpdir(), "replay-pruned-")),
	};
	return { asked, steers, steeredTools, deps };
}

function recording() {
	const read = readRecording(session());
	if ("problem" in read) throw new Error(read.problem);
	return read;
}

describe("replaying a session", () => {
	it("cuts it in a chain, each cut compacted by our extension and by pi, carried on from and judged", async () => {
		const { asked, steers, steeredTools, deps } = routed();
		const result = await replaySession(recording(), "fetcher", deps);
		assert.equal(result.skipped, undefined);
		assert.equal(result.model, "anthropic/fable-5");
		assert.deepEqual(
			result.cuts.map(({ depth, kind, error }) => ({ depth, kind, error })),
			[
				{ depth: 1, kind: "self", error: undefined },
				{ depth: 2, kind: "forced", error: undefined },
				{ depth: 3, kind: "before-user", error: undefined },
			],
		);

		// Self-compaction answered the extension's own steer, and its note opens the Handoff.
		assert.equal(steers.length, 1);
		assert.match(steers[0]!, /Self-compact at your next natural break/);
		// The recording predates the extension: its tool is declared to the agent as pi would, once the extension is loaded.
		assert.deepEqual(steeredTools, [["read", "write", "edit", "bash", "self_compact"]]);
		const [self, forced, beforeUser] = result.cuts;
		const ours = self!.ours!.handoff.details as HandoffDetails;
		assert.equal(ours.writer, "fork");
		assert.equal(ours.note, NOTE);
		assert.deepEqual(ours.ledger.map((entry) => entry.quote), [RULE]);
		assert.equal((forced!.ours!.handoff.details as HandoffDetails).compactionNo, 2, "the chain builds on the Handoff before it");
		assert.equal((beforeUser!.ours!.handoff.details as HandoffDetails).compactionNo, 3);

		// pi's default, on the same cuts, chained on its own summaries.
		for (const cut of result.cuts) {
			assert.ok(cut.pi!.handoff.summary.includes(PI_SUMMARY), cut.pi!.handoff.summary);
			assert.equal(cut.pi!.handoff.fromHook, false, "pi's own compaction, not an extension's");
		}

		// Both continuations, once per cut, and the judge once per cut, de-blinded.
		assert.equal(asked.filter((what) => what === "continuation").length, 6);
		assert.equal(asked.filter((what) => what === "judge").length, 3);
		for (const cut of result.cuts) {
			assert.equal(cut.ours!.continuation.matched.length, 0);
			assert.equal(cut.ours!.continuation.differed?.proposed.content[0]?.type, "text");
			assert.deepEqual(cut.verdict!.constraints.map((c) => [c.quote, c.ours.verdict, c.pi.verdict]), [[RULE, true, false]]);
		}

		// The deterministic checks, on both.
		assert.equal(self!.ours!.fileState.exact, true, JSON.stringify(self!.ours!.fileState));
		assert.ok(result.collapse);
		assert.equal(result.collapse.ours.measures.length, 3);
		assert.equal(result.collapse.pi.measures.length, 3);
		assert.ok(beforeUser!.ours!.retention.recurring.length >= 0);
	});

	it("compacts a Self-compaction cut as forced when the agent doesn't answer the steer by compacting, and says so", async () => {
		const { deps } = routed({ selfCompacts: false });
		const result = await replaySession(recording(), "fetcher", deps);
		const [first] = result.cuts;
		assert.equal(first!.kind, "forced");
		assert.equal(first!.requested, "self");
		assert.equal(first!.declined, true);
		assert.equal(first!.declinedWith, "replied in text");
		assert.equal((first!.ours!.handoff.details as HandoffDetails).note, undefined);
	});

	it("skips a session whose model can't be reached, or that is too short for a chain", async () => {
		const unreachable = await replaySession(recording(), "fetcher", routed({ reachable: () => false }).deps);
		assert.deepEqual(unreachable.cuts, []);
		assert.equal(unreachable.skipped, "its model anthropic/fable-5 can't be reached");

		const short = readRecording(recorder().system().user("Hi.").say("Hello.").user("Bye.").say("Bye.").text());
		if ("problem" in short) throw new Error(short.problem);
		const tooShort = await replaySession(short, "short", routed().deps);
		assert.match(tooShort.skipped ?? "", /too short for a chain of two cuts/);
	});
});

describe("re-judging a saved session", () => {
	it("runs only the judge, on the saved Handoffs and continuations, with the history and future cut where the replay cut them", async () => {
		const recorded = recording();
		const saved = JSON.parse(JSON.stringify(await replaySession(recorded, "fetcher", routed().deps))) as SessionResult;
		for (const cut of saved.cuts) cut.verdict = undefined;
		const { asked, deps } = routed();
		const prompts: string[] = [];
		const judge = deps.judge.stream;
		deps.judge.stream = (model, context, options) => {
			prompts.push(lastUser(context));
			return judge(model, context, options);
		};

		const result = await rejudgeSession(recorded, saved, deps);
		assert.deepEqual(asked, ["judge", "judge", "judge"], "no writer and no continuation is called again");
		assert.ok(prompts.every((prompt) => !prompt.includes("<rules>")), "a cut saved without a verdict has its rules listed afresh");
		assert.equal(result.cuts.length, 3);
		for (const [i, cut] of result.cuts.entries()) {
			assert.deepEqual(cut.verdict!.constraints.map((c) => [c.quote, c.ours.verdict, c.pi.verdict]), [[RULE, true, false]]);
			assert.ok(prompts[i]!.includes(saved.cuts[i]!.ours!.handoff.summary), "the saved Handoff is what is judged");
			assert.ok(prompts[i]!.includes(saved.cuts[i]!.pi!.handoff.summary));
			assert.deepEqual(cut.ours, saved.cuts[i]!.ours, "everything else is as saved");
		}
	});

	it("judges again only the cuts picked, and keeps the saved verdict on the rest", async () => {
		const recorded = recording();
		const saved = JSON.parse(JSON.stringify(await replaySession(recorded, "fetcher", routed().deps))) as SessionResult;
		const { asked, deps } = routed();
		const prompts: string[] = [];
		const judge = deps.judge.stream;
		deps.judge.stream = (model, context, options) => {
			prompts.push(lastUser(context));
			return judge(model, context, options);
		};
		const result = await rejudgeSession(recorded, saved, deps, (cut) => cut.depth === 2);
		assert.deepEqual(asked, ["judge"]);
		assert.ok(prompts[0]!.includes(`<rules>\n[1] ${RULE}\n</rules>`), "the judge scores the rules the saved verdict listed");
		assert.deepEqual(result.cuts[0], saved.cuts[0]);
		assert.deepEqual(result.cuts[2], saved.cuts[2]);
	});

	it("finds each saved cut in the recording, and refuses, before any call, one it can't find", async () => {
		const recorded = recording();
		const saved = JSON.parse(JSON.stringify(await replaySession(recorded, "fetcher", routed().deps))) as SessionResult;
		const { asked, deps } = routed();
		assert.equal(rejudgeProblem(recorded, saved), undefined);
		// A cut whose continuation was compared with an action the recording doesn't have.
		const lost = structuredClone(saved);
		lost.cuts[1]!.ours!.continuation.differed!.recorded!.responseId = "another";
		assert.match(rejudgeProblem(recorded, lost) ?? "", /its cut 2 matches no one turn of the recording/);
		await assert.rejects(rejudgeSession(recorded, lost, deps), /fetcher: its cut 2 matches no one turn/);
		assert.deepEqual(asked, []);
	});
});

describe("a replay call", () => {
	const ask = { messages: [{ role: "user" as const, content: "Go on.", timestamp: 0 }] } as Context;

	it("is relayed as the provider streams it", async () => {
		const clock = fakeClock();
		const model = scriptModel({ text: "Carrying on." });
		const reply = await guardCall(model.stream, clock)(MODEL, ask).result();
		assert.equal(reply.stopReason, "stop");
		assert.deepEqual(reply.content, [{ type: "text", text: "Carrying on." }]);
		assert.ok(model.calls[0]!.options?.signal, "the provider is handed a signal to abort on");
	});

	it("fails, and aborts the provider, once nothing has streamed for a minute", async () => {
		const clock = fakeClock();
		const model = scriptModel({ stall: true });
		const events = guardCall(model.stream, clock)(MODEL, ask);
		clock.advance(CALL_STALL_MS - 1);
		let settled = false;
		void events.result().then(() => (settled = true));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(settled, false, "a call still inside the stall timeout goes on");
		clock.advance(1);
		const reply = await events.result();
		assert.equal(reply.stopReason, "error");
		assert.match(reply.errorMessage ?? "", /streamed nothing for 60s/);
		assert.equal(model.calls[0]!.options?.signal?.aborted, true);
	});

	it("fails once it has run ten minutes, however much it streams", async () => {
		const clock = fakeClock();
		const model = scriptModel({ text: "…", paced: true });
		const events = guardCall(model.stream, clock)(MODEL, ask);
		await new Promise((resolve) => setImmediate(resolve));
		for (let ms = 0; ms < CALL_CAP_MS; ms += 30_000) {
			model.chunk();
			await new Promise((resolve) => setImmediate(resolve));
			clock.advance(30_000);
		}
		const reply = await events.result();
		assert.equal(reply.stopReason, "error");
		assert.match(reply.errorMessage ?? "", /ran past 10 minutes/);
		assert.equal(model.calls[0]!.options?.signal?.aborted, true);
	});
});
