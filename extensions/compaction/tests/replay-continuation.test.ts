/**
 * The replay runner's continuation: an agent carrying on from a Handoff and the
 * kept tail, compared action by action with what the recorded agent did.
 *
 * Open-loop: nothing is ever executed. While an action matches the recorded
 * one, the recorded result is fed back; the first that differs is what gets
 * judged. Driven against a scripted model call, on recorded futures written
 * for the purpose.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { continueFrom, futureAfter, proposer } from "../replay-continuation.ts";
import { readRecording } from "../replay-corpus.ts";
import { MODEL, user } from "./fake-pi.ts";
import { recorder } from "./recordings.ts";
import { type Reply, scriptModel } from "./scripted-model.ts";

/** What really happened after the cut: a recorded run of reads, a test run and an answer, then the user again. */
function recorded() {
	const text = recorder("/work")
		.system()
		.user("Fix the flaky test.")
		.turn([{ name: "read", arguments: { path: "src/a.ts" }, result: "export const a = 1;" }]) // 2, 3: the cut is after this turn
		.turn([{ name: "read", arguments: { path: "./src/b.ts" }, result: "export const b = 2;" }])
		.turn([{ name: "bash", arguments: { command: "npm  test" }, result: "1 passing" }])
		.turn([{ name: "edit", arguments: { path: "src/b.ts", oldText: "2", newText: "3" }, result: "Edited." }])
		.say("Fixed.")
		.user("Thanks.")
		.text();
	const recording = readRecording(text);
	if ("problem" in recording) throw new Error(recording.problem);
	return { recording, future: futureAfter(recording.branch, 3) };
}

const call = (name: string, args: Record<string, unknown>): Reply => ({ toolCall: { name, arguments: args }, stopReason: "toolUse" });

/** A continuation on the scripted model: `replies` are the actions it proposes, in order. */
async function carryOn(replies: Reply[], context: AgentMessage[] = [user("[the Handoff]")]) {
	const { future } = recorded();
	const model = scriptModel(...replies);
	const done = await continueFrom(context, future, proposer(model.stream, MODEL, { sessionId: "s-1", thinkingLevel: "medium" }), "/work");
	return { done, model, future };
}

function texts(messages: Message[]): string[] {
	return messages.map((message) =>
		typeof message.content === "string" ? message.content : message.content.map((part) => ("text" in part ? part.text : `[${part.type}]`)).join(""),
	);
}

describe("the continuation", () => {
	it("feeds back the recorded result while each action matches, and stops at the first that differs", async () => {
		const { done, model, future } = await carryOn([
			call("read", { path: "/work/src/b.ts" }), // the same file the recording read as ./src/b.ts
			call("bash", { command: " npm test" }), // the same command, spaced differently
			call("bash", { command: "npm test -- --watch" }), // not what the recording did next
		]);
		assert.equal(done.matched.length, 2);
		assert.equal(done.differed?.proposed.content.find((part) => part.type === "toolCall")?.arguments.command, "npm test -- --watch");
		assert.equal(done.differed?.recorded, future.steps[2]!.action);

		// What the second proposal was sent: the first, answered with the recorded result under its own call id.
		const second = model.calls[1]!.context.messages;
		const fedBack = second.at(-1) as ToolResultMessage;
		assert.equal(fedBack.role, "toolResult");
		assert.equal(fedBack.toolCallId, "scripted-1");
		assert.deepEqual(texts([fedBack]), ["export const b = 2;"]);
		assert.equal(model.calls.length, 3);
	});

	it("proposes at most three actions, however well they match", async () => {
		const { done, model } = await carryOn([
			call("read", { path: "src/b.ts" }),
			call("bash", { command: "npm test" }),
			call("edit", { path: "src/b.ts", oldText: "2", newText: "3" }),
		]);
		assert.equal(done.matched.length, 3);
		assert.equal(done.differed, undefined);
		assert.equal(model.calls.length, 3);
	});

	it("never counts an answer in words as a match: there is no result to feed back, so it is judged", async () => {
		const { done } = await carryOn([{ text: "Should I read src/b.ts?" }]);
		assert.equal(done.matched.length, 0);
		assert.equal(done.differed?.proposed.stopReason, "stop");
	});

	it("starts from the Handoff, the tail and whatever the recording has before the agent's next action", async () => {
		const text = recorder("/work").system().user("Fix it.").say("Done.").user("Now the docs.").turn([{ name: "read", arguments: { path: "README.md" } }]).user("Thanks.").text();
		const recording = readRecording(text);
		if ("problem" in recording) throw new Error(recording.problem);
		const future = futureAfter(recording.branch, 2);
		const model = scriptModel(call("read", { path: "docs/index.md" }));
		await continueFrom([user("[the Handoff]")], future, proposer(model.stream, MODEL, { sessionId: "s-1", thinkingLevel: "off" }), "/work");
		assert.deepEqual(texts(model.calls[0]!.context.messages), ["[the Handoff]", "Now the docs."]);
		assert.equal(model.calls[0]!.options?.sessionId, "s-1");
		assert.equal(model.calls[0]!.options?.reasoning, undefined, "no reasoning at thinking level off");
	});

	it("fails on a provider error rather than judging an action nobody proposed", async () => {
		await assert.rejects(carryOn([{ errorMessage: "overloaded" }]), /overloaded/);
	});
});
