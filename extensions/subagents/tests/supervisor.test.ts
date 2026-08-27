/**
 * The Supervisor: naming Runs, and the lifecycle rule that decides when one is
 * done.
 *
 * Every test here feeds an event sequence in by hand. Nothing spawns anything —
 * that is the point of the Supervisor being pure.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ASK_QUESTION_TOOL, type ParentMessage, Supervisor } from "../supervisor.ts";
import { AGENT_END, AGENT_START, asked, failed, ran, RETRYING, said, SETTLED } from "./child-events.ts";

/** Feed a whole sequence to one Run and collect whatever it asks the parent to say. */
function feed(supervisor: Supervisor, name: string, events: JsonAgentSessionEvent[]): ParentMessage[] {
	const announced: ParentMessage[] = [];
	for (const event of events) {
		const message = supervisor.observe(name, event);
		if (message) announced.push(message);
	}
	return announced;
}

describe("Supervisor naming", () => {
	it("names a Run after its Agent", () => {
		const supervisor = new Supervisor();

		assert.equal(supervisor.register("scout", "look around").name, "scout");
	});

	it("auto-suffixes on collision, counting from 2", () => {
		const supervisor = new Supervisor();

		const names = [
			supervisor.register("scout", "one").name,
			supervisor.register("scout", "two").name,
			supervisor.register("scout", "three").name,
		];

		assert.deepEqual(names, ["scout", "scout-2", "scout-3"]);
	});
});

describe("Supervisor lifecycle", () => {
	it("delivers the child's last assistant message when the Run settles", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");

		const deliveries = feed(supervisor, run.name, [said("Found three call sites."), AGENT_END, SETTLED]);

		assert.equal(deliveries.length, 1);
		assert.equal(deliveries[0].run.state, "done");
		assert.equal(deliveries[0].run.result, "Found three call sites.");
		assert.match(deliveries[0].text, /^Run `scout` \(agent `scout`\) is done\.\n\nFound three call sites\.$/);
	});

	it("settles on agent_settled, not agent_end — a retried turn delivers once, with its final answer", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");

		const deliveries = feed(supervisor, run.name, [
			said("half an answer"),
			RETRYING,
			said("the real answer"),
			AGENT_END,
			SETTLED,
		]);

		assert.equal(deliveries.length, 1);
		assert.equal(deliveries[0].run.result, "the real answer");
	});

	it("ignores events that arrive after a Run is done", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");

		const deliveries = feed(supervisor, run.name, [said("done"), SETTLED, said("more"), SETTLED]);

		assert.equal(deliveries.length, 1);
		assert.equal(supervisor.get(run.name)?.result, "done");
	});

	it("keeps each Run's result to itself when two settle in the same tick", () => {
		const supervisor = new Supervisor();
		const first = supervisor.register("scout", "one");
		const second = supervisor.register("scout", "two");

		supervisor.observe(first.name, said("first result"));
		supervisor.observe(second.name, said("second result"));
		const firstDelivery = supervisor.observe(first.name, SETTLED);
		const secondDelivery = supervisor.observe(second.name, SETTLED);

		assert.equal(firstDelivery?.run.result, "first result");
		assert.equal(secondDelivery?.run.result, "second result");
		assert.equal(secondDelivery?.run.name, "scout-2");
	});

	it("says so plainly when a Run settles without an assistant message", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("worker", "do nothing");

		const delivery = supervisor.observe(run.name, SETTLED);

		assert.equal(delivery?.run.result, undefined);
		assert.match(delivery?.text ?? "", /without producing a result/);
	});

	it("has nothing to say about a name it never registered", () => {
		const supervisor = new Supervisor();

		assert.equal(supervisor.observe("ghost", SETTLED), undefined);
	});
});

describe("Supervisor questions", () => {
	it("moves a Run to Waiting when its settling turn asked a Question, delivering nothing", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");

		const announced = feed(supervisor, run.name, [asked("Which auth module do you mean?"), AGENT_END, SETTLED]);

		assert.equal(announced.length, 1);
		assert.equal(announced[0].kind, "question");
		assert.equal(supervisor.get(run.name)?.state, "waiting");
		assert.equal(supervisor.get(run.name)?.question, "Which auth module do you mean?");
		assert.equal(supervisor.get(run.name)?.result, undefined);
		assert.match(announced[0].text, /scout/);
		assert.match(announced[0].text, /Which auth module do you mean\?/);
	});

	it("finishes a Run whose settling turn ran tools but asked nothing", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");

		const announced = feed(supervisor, run.name, [ran("read"), said("Found three call sites."), ran("grep"), AGENT_END, SETTLED]);

		assert.equal(announced.length, 1);
		assert.equal(announced[0].kind, "delivery");
		assert.equal(supervisor.get(run.name)?.state, "done");
		assert.equal(supervisor.get(run.name)?.result, "Found three call sites.");
	});

	it("still moves a Run to Waiting when it keeps working after the Question and settles later", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");

		const announced = feed(supervisor, run.name, [
			asked("Which auth module do you mean?"),
			ran("read"),
			ran("grep"),
			said("Waiting to hear back."),
			AGENT_END,
			SETTLED,
		]);

		assert.equal(announced.length, 1);
		assert.equal(announced[0].kind, "question");
		assert.equal(supervisor.get(run.name)?.state, "waiting");
		assert.equal(supervisor.get(run.name)?.question, "Which auth module do you mean?");
	});

	it("carries a Run that asks twice over its lifetime, and delivers only when it finishes", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");

		const announced = feed(supervisor, run.name, [
			asked("Which auth module do you mean?"),
			SETTLED,
			AGENT_START,
			asked("Should I include the tests?"),
			SETTLED,
			AGENT_START,
			said("Three call sites, tests included."),
			SETTLED,
		]);

		assert.deepEqual(
			announced.map((message) => message.kind),
			["question", "question", "delivery"],
		);
		assert.match(announced[0].text, /Which auth module do you mean\?/);
		assert.match(announced[1].text, /Should I include the tests\?/);
		assert.equal(supervisor.get(run.name)?.state, "done");
		assert.equal(supervisor.get(run.name)?.result, "Three call sites, tests included.");
		assert.equal(supervisor.get(run.name)?.question, undefined);
	});

	it("counts a Run as running again once its child starts the turn after a Question", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");

		feed(supervisor, run.name, [asked("Which auth module do you mean?"), SETTLED]);
		supervisor.observe(run.name, AGENT_START);

		assert.equal(supervisor.get(run.name)?.state, "running");
		assert.equal(supervisor.get(run.name)?.question, undefined);
	});

	it("finishes a Run whose ask_question failed, because no Question ever reached the parent", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		const failedAsk = failed(ASK_QUESTION_TOOL, "A question cannot be empty.");

		const announced = feed(supervisor, run.name, [failedAsk, said("Guessed instead."), AGENT_END, SETTLED]);

		assert.equal(announced.length, 1);
		assert.equal(announced[0].kind, "delivery");
		assert.equal(supervisor.get(run.name)?.state, "done");
	});

	it("never delivers a Question turn's own message as a result", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");

		feed(supervisor, run.name, [said("I need to know which module."), asked("Which auth module do you mean?"), SETTLED]);
		const announced = feed(supervisor, run.name, [AGENT_START, SETTLED]);

		assert.equal(announced.length, 1);
		assert.equal(announced[0].kind, "delivery");
		assert.equal(supervisor.get(run.name)?.result, undefined);
		assert.match(announced[0].text, /without producing a result/);
	});

	it("says so plainly when a Run starts Waiting without saying what it wanted to know", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		const silentAsk = {
			type: "tool_execution_end",
			toolCallId: "call-ask",
			toolName: ASK_QUESTION_TOOL,
			result: { content: [] },
			isError: false,
		} as unknown as JsonAgentSessionEvent;

		const announced = feed(supervisor, run.name, [silentAsk, SETTLED]);

		assert.equal(announced[0].kind, "question");
		assert.equal(supervisor.get(run.name)?.state, "waiting");
		assert.match(announced[0].text, /did not say what it wanted to know/);
	});
});
