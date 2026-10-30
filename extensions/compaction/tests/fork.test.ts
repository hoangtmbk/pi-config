/**
 * The forked call: the first writer on every path. A side request on the
 * session's own model and thinking level that sends the live conversation
 * exactly as the agent's next turn would, plus one trailing instruction, so
 * that it reads the warm cache and knows the plan as well as the agent does.
 *
 * Driven only through the recording fake pi, with the model call scripted: a
 * test builds a session, compacts it on one of the three paths, and reads back
 * the request the fork made and what came of its reply.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convertToLlm, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { Message, ToolCall, Usage } from "@earendil-works/pi-ai";
import { registerCompaction, SELF_COMPACT_TOOL } from "../index.ts";
import { assistant, type FakeSetup, fakePi, MODEL, said, user } from "./fake-pi.ts";
import { fakeClock, type Reply, scriptModel } from "./scripted-model.ts";

/** A reply in exactly the shape the instruction asks for. */
const HANDOFF = [
	"<handoff>",
	"## Goal",
	'Add retries to the fetcher. "Add retries to the fetcher."',
	"",
	"## Progress",
	"### Done",
	"- Wrote the wrapper in src/retry.ts.",
	"",
	"## Decisions and why",
	"(none)",
	"",
	"## Open problems",
	"(none)",
	"",
	"## Critical context",
	"- `npm test` runs the suite.",
	"",
	"## Next step",
	'Wire the wrapper into fetch(). "Go ahead."',
	"</handoff>",
	"<ledger></ledger>",
].join("\n");

/** What opens the fork's trailing user message, word for word. */
const PREAMBLE =
	"[Compaction: this message comes from the compaction extension, not from the user. Reply with text only and don't call any tools; a tool call here is never run.]";

/** A session whose compaction keeps only the newest message or so. */
const SMALL_TAIL: FakeSetup = { settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: false } } };

/** A fake pi with the extension on it and its model call scripted with `replies`. */
function compacting(replies: Reply[], setup: FakeSetup = SMALL_TAIL) {
	const model = scriptModel(...replies);
	const pi = fakePi(setup, (api) => registerCompaction(api, { stream: model.stream }));
	return { pi, model };
}

/** The session's leading system message, as pi persists it: the prompt and the tools. */
const SYSTEM: Message = {
	role: "system",
	content: "You are pi, a coding agent.",
	toolsAdded: [{ name: "bash", description: "Run a command.", parameters: { type: "object", properties: {} } as never }],
	timestamp: 1,
};

/** A short session: the system prompt, a task, a turn, a go-ahead and a reply. */
async function session(pi: ReturnType<typeof fakePi>): Promise<void> {
	pi.session.appendMessage(SYSTEM);
	pi.session.appendMessage(user("Add retries to the fetcher. Keep the public API unchanged."));
	await pi.turnEnd({ message: said("On it.") });
	pi.session.appendMessage(user("Go ahead."));
	await pi.turnEnd({ message: said("Done.") });
}

/** Our compaction among a boundary's drafts. */
function compactionIn(drafts: SessionBoundaryDraft[]) {
	return drafts.find((draft): draft is Extract<SessionBoundaryDraft, { type: "compaction" }> => draft.type === "compaction");
}

/** A message's text, whatever shape its content takes. */
function textOf(message: Message | undefined): string {
	if (!message) return "";
	const content = message.content as string | { type: string; text?: string }[];
	return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

describe("the forked call at a forced compaction", () => {
	it("writes the Handoff, sending the live context as the next turn would, plus one trailing instruction", async () => {
		const { pi, model } = compacting([{ text: HANDOFF }]);
		await session(pi);
		const live = convertToLlm(pi.session.buildSessionProjection().messages);
		const compaction = compactionIn(await pi.turnEnd({ tokens: 172_000, message: said("Wired it in.") }));

		assert.equal((compaction?.details as any).writer, "fork");
		assert.deepEqual((compaction?.details as any).attempts, []);
		assert.equal((compaction?.details as any).sections.nextStep, 'Wire the wrapper into fetch(). "Go ahead."');
		assert.equal(model.calls.length, 1);
		const sent = model.calls[0]!.context.messages;
		// The context `turn_end` previewed, then the instruction.
		const preview = convertToLlm(pi.session.buildSessionProjection().messages);
		assert.ok(preview.length > live.length);
		assert.deepEqual(sent.slice(0, -1), preview);
		const trailing = sent.at(-1)!;
		assert.equal(trailing.role, "user");
		assert.ok(textOf(trailing).startsWith(`${PREAMBLE}\n\n`));
		assert.ok(textOf(trailing).includes("Reply in exactly this shape:"));
		// The system prompt and tools are the transcript's own, not passed beside it.
		assert.deepEqual(sent[0], SYSTEM);
		assert.equal(model.calls[0]!.context.systemPrompt, undefined);
		assert.equal(model.calls[0]!.context.tools, undefined);
	});
});

describe("the forked call's instruction", () => {
	it("says how much stays, and on a repeat compaction that the conversation opens with the Handoff to edit", async () => {
		const { pi, model } = compacting([{ text: HANDOFF }, { text: HANDOFF }], { settings: { compaction: { keepRecentTokens: 2_000 }, retry: { enabled: false } } });
		const big = (tag: string) => `${tag} `.padEnd(12_000, "x");
		pi.session.appendMessage(user(big("Add retries to the fetcher.")));
		await pi.turnEnd({ message: said("On it.") });
		pi.session.appendMessage(user(big("Go ahead.")));
		await pi.turnEnd({ message: said("Done.") });
		await pi.compact();
		pi.session.appendMessage(user(big("Now run the tests.")));
		await pi.turnEnd({ message: said("They pass.") });
		await pi.compact();

		const [first, second] = [model.prompt(0), model.prompt(1)];
		for (const text of [first, second]) {
			assert.ok(
				text.includes(
					"The conversation above is about to be compacted. Everything before the newest ~2K tokens will be replaced by a Handoff: the record the agent carries on from, with no other memory of what was removed. The newest messages stay verbatim after it.",
				),
			);
			assert.ok(text.includes("Write it as of the end of the conversation, not as of where the cut falls"));
		}
		assert.doesNotMatch(first, /previous Handoff/);
		assert.ok(
			second.includes(
				"The conversation opens with the previous Handoff. Edit it rather than starting over. Keep every line that still holds, update lines that later messages changed, and add what is new. Remove a line only when something later superseded it, and say in its place what superseded it. Write all six sections again, in full.",
			),
		);
		// It does: the previous compaction's summary is the second request's first message after the system prompt.
		assert.equal(model.calls[1]!.context.messages.filter((m) => m.role !== "system")[0]?.role, "user");
		assert.match(textOf(model.calls[1]!.context.messages.filter((m) => m.role !== "system")[0]), /## Goal/);
	});
});

describe("the forked call on the hook path", () => {
	it("writes /compact's Handoff and pi's threshold backstop's, sending the session as the model sees it", async () => {
		for (const reason of ["manual", "threshold"] as const) {
			const { pi, model } = compacting([{ text: HANDOFF }]);
			await session(pi);
			const live = convertToLlm(pi.session.buildSessionProjection().messages);
			const done = await pi.compact({ reason, customInstructions: "the retry path" });
			assert.equal((done?.result?.compaction?.details as any).writer, "fork", reason);
			const sent = model.calls[0]!.context.messages;
			assert.deepEqual(sent.slice(0, -1), live, reason);
			assert.ok(textOf(sent.at(-1)).startsWith(PREAMBLE), reason);
			assert.ok(textOf(sent.at(-1)).includes('The user asked for this compaction with: "the retry path".'), reason);
			// Writers stop on the compaction's own signal there.
			assert.equal(model.calls[0]!.options?.signal?.aborted, false, reason);
		}
	});

	it("is skipped on overflow, where the live context is what didn't fit: serialized mode writes first", async () => {
		const { pi, model } = compacting([{ text: HANDOFF }]);
		await session(pi);
		const details = (await pi.compact({ reason: "overflow" }))?.result?.compaction?.details as any;
		assert.equal(details.writer, "serialized");
		assert.deepEqual(details.attempts, []);
		assert.equal(model.calls.length, 1);
		assert.ok(textOf(model.calls[0]!.context.messages.at(-1)).startsWith("<conversation>"));
	});
});

describe("the forked call at a Self-compaction", () => {
	it("sends the previous request plus the calling message, then one placeholder result per call still pending, then the instruction", async () => {
		const { pi, model } = compacting([{ text: HANDOFF }]);
		await session(pi);
		const calls: ToolCall[] = [
			{ type: "toolCall", id: "run", name: "bash", arguments: { command: "npm test" } },
			{ type: "toolCall", id: "self", name: SELF_COMPACT_TOOL, arguments: { note: "Tests next." } },
			{ type: "toolCall", id: "look", name: "read", arguments: { path: "src/fetch.ts" } },
		];
		const message = assistant(calls, "toolUse");
		const drafts = await pi.turnEnd({ tokens: 125_000, message });

		assert.equal((compactionIn(drafts)?.details as any).writer, "fork");
		const sent = model.calls[0]!.context.messages;
		// What the session held as `self_compact` ran: up to the calling message and the one result already in.
		const at = sent.findIndex((m) => m.role === "assistant" && m.content === message.content);
		assert.ok(at > 0, "the calling message was sent");
		const after = sent.slice(at + 1);
		assert.deepEqual(
			after.map((m) => (m.role === "toolResult" ? [m.toolCallId, m.toolName, textOf(m), m.isError] : [m.role])),
			[
				["run", "bash", "ok", false],
				["self", SELF_COMPACT_TOOL, "Writing the Handoff; see the next message.", false],
				["look", "read", "(This result isn't available to the Handoff writer. It stays in the kept tail.)", false],
				["user"],
			],
		);
		assert.ok(textOf(after.at(-1)).startsWith(PREAMBLE));
	});
});

describe("a forked call that fails", () => {
	/** Each failure shape, and the reason recorded for it. */
	const shapes: [string, Reply, string][] = [
		["a provider error", { errorMessage: "overloaded_error: Overloaded" }, "the provider returned an error: overloaded_error: Overloaded"],
		["a reply stopped at the token cap", { text: HANDOFF.slice(0, 200), stopReason: "length" }, "the reply hit the token cap and is incomplete"],
		["no <handoff> block", { text: "Sure, I'll keep working on the fetcher." }, "the reply has no <handoff> block"],
		["only a tool call", { toolCall: { name: "bash", arguments: { command: "npm test" } } }, "the reply is only a tool call, with no <handoff> block"],
		["a missing heading", { text: HANDOFF.replace("## Critical context\n", "") }, 'the <handoff> block is missing "## Critical context"'],
		["an empty Next step", { text: HANDOFF.replace('Wire the wrapper into fetch(). "Go ahead."', "(none)") }, "the Handoff's Next step is empty"],
	];

	for (const [shape, reply, reason] of shapes) {
		it(`falls through to serialized mode on ${shape}, recording why`, async () => {
			const { pi } = compacting([reply, { text: HANDOFF }]);
			await session(pi);
			const details = compactionIn(await pi.turnEnd({ tokens: 172_000, message: said("Wired it in.") }))?.details as any;
			assert.equal(details.writer, "serialized");
			assert.deepEqual(details.attempts, [{ writer: "fork", reason }]);
			// Only pi's summarizer raises a toast.
			assert.deepEqual(pi.notifications, []);
		});
	}

	it("ignores a tool call beside a usable block, and never runs it", async () => {
		const { pi, model } = compacting([{ text: HANDOFF, toolCall: { name: "bash", arguments: { command: "rm -rf src" } } }]);
		await session(pi);
		const details = compactionIn(await pi.turnEnd({ tokens: 172_000, message: said("Wired it in.") }))?.details as any;
		assert.equal(details.writer, "fork");
		assert.equal(model.calls.length, 1);
		assert.deepEqual(pi.errors, []);
	});

	it("fails after 60s with nothing streamed, aborting the call, and serialized mode writes", async () => {
		const clock = fakeClock();
		const model = scriptModel({ stall: true }, { text: HANDOFF });
		const pi = fakePi(SMALL_TAIL, (api) => registerCompaction(api, { stream: model.stream, clock }));
		await session(pi);
		const drafting = pi.turnEnd({ tokens: 172_000, message: said("Wired it in.") });
		await until(() => model.calls.length === 1);
		clock.advance(60_000);
		const details = compactionIn(await drafting)?.details as any;
		assert.equal(model.calls[0]?.options?.signal?.aborted, true);
		assert.equal(details.writer, "serialized");
		assert.deepEqual(details.attempts, [{ writer: "fork", reason: "the provider streamed nothing for 60s" }]);
	});

	it("stops the chain on Escape: nothing compacted, serialized mode never asked, no toast", async () => {
		const { pi, model } = compacting([{ text: HANDOFF, during: () => pi.escapeCompaction() }, { text: HANDOFF }]);
		await session(pi);
		const done = await pi.compact();
		assert.equal(model.calls[0]?.options?.signal?.aborted, true);
		assert.deepEqual(done?.result, { cancel: true });
		assert.equal(model.calls.length, 1);
		assert.deepEqual(pi.notifications, []);
	});
});

describe("the forked call's cache read", () => {
	/** A usage as a provider reports it: `input` paid in full, `cacheRead` from the cache. */
	function usage(input: number, cacheRead: number, cacheWrite = 0): Usage {
		const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		return { input, output: 300, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + 300, cost };
	}

	/** The `details.log` of a forced compaction whose last real request used `last`, and whose fork's reply used `fork`. */
	async function logged(last: Usage, fork: Partial<Usage>): Promise<string[]> {
		const { pi } = compacting([{ text: HANDOFF, usage: fork }]);
		await session(pi);
		const drafts = await pi.turnEnd({ tokens: 172_000, message: { ...said("Wired it in."), usage: last } });
		return (compactionIn(drafts)?.details as any).log;
	}

	it("is compared with the last real request afterwards, and a miss is logged", async () => {
		assert.deepEqual(await logged(usage(2_000, 148_000), usage(151_000, 0)), [
			"fork: missed the cache by 150,000 tokens (read 0 of the last request's 150,000)",
		]);
		assert.deepEqual(await logged(usage(2_000, 140_000, 8_000), usage(60_000, 91_000)), [
			"fork: missed the cache by 59,000 tokens (read 91,000 of the last request's 150,000)",
		]);
	});

	it("allows 1,024 tokens of noise", async () => {
		assert.deepEqual(await logged(usage(2_000, 148_000), usage(3_024, 148_976)), []);
		assert.deepEqual(await logged(usage(2_000, 148_000), usage(3_025, 148_975)), [
			"fork: missed the cache by 1,025 tokens (read 148,975 of the last request's 150,000)",
		]);
	});

	it("logs nothing for a read as warm as the request before it", async () => {
		assert.deepEqual(await logged(usage(2_000, 148_000), usage(4_000, 150_000)), []);
	});

	it("logs nothing on a provider that never reports caching", async () => {
		assert.deepEqual(await logged(usage(150_000, 0), usage(152_000, 0)), []);
	});
});

/** Let the extension's pending work run — at least one turn of the event loop — until `done` says so. */
async function until(done: () => boolean): Promise<void> {
	for (let i = 0; i === 0 || (i < 1_000 && !done()); i++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(done(), "it never happened");
}

/** A model on OpenAI's Codex API. */
const CODEX = { ...MODEL, id: "gpt-6.1-sol", name: "GPT-6.1 Sol", api: "openai-codex-responses", provider: "openai-codex" } as typeof MODEL;

describe("the forked call's request", () => {
	it("on Anthropic, is the agent's own: the reply's model and thinking level, the session id, pi's transport, and nothing else", async () => {
		const { pi, model } = compacting([{ text: HANDOFF }], { ...SMALL_TAIL, thinkingLevel: "high" });
		await session(pi);
		await pi.turnEnd({ tokens: 172_000, message: said("Wired it in.") });
		const call = model.calls[0]!;
		assert.equal(call.model.id, "fable-5");
		// Setting tool_choice on Anthropic voids the cached conversation; maxTokens and cacheRetention would change the request too.
		const { signal, ...options } = call.options ?? {};
		assert.ok(signal);
		assert.deepEqual(options, { sessionId: pi.session.getSessionId(), reasoning: "high", transport: "auto" });
	});

	it("on Codex, sets tool_choice to none", async () => {
		const { pi, model } = compacting([{ text: HANDOFF }], { ...SMALL_TAIL, model: CODEX });
		await session(pi);
		await pi.turnEnd({ tokens: 172_000, message: said("Wired it in.") });
		assert.equal(model.calls[0]!.model.id, "gpt-6.1-sol");
		assert.equal(model.calls[0]!.options?.toolChoice, "none");
	});

	it("carries pi's thinking budgets and transport as the agent's requests do, and no thinking level at off", async () => {
		const budgets = { low: 2_000, high: 30_000 };
		const settings = { ...SMALL_TAIL.settings, thinkingBudgets: budgets, transport: "websocket" };
		const { pi, model } = compacting([{ text: HANDOFF }], { settings, thinkingLevel: "off" });
		await session(pi);
		await pi.turnEnd({ tokens: 172_000, message: said("Wired it in.") });
		const options = model.calls[0]!.options;
		assert.deepEqual(options?.thinkingBudgets, budgets);
		assert.equal(options?.transport, "websocket");
		assert.ok(!("reasoning" in (options ?? {})));
	});
});
