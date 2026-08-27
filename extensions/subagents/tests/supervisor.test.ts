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
import { type Delivery, Supervisor } from "../supervisor.ts";

/** An assistant `message_end`, the event a result is read from. */
function said(text: string): JsonAgentSessionEvent {
	return {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }], api: "anthropic", provider: "", model: "", usage: {} },
	} as unknown as JsonAgentSessionEvent;
}

const AGENT_END = { type: "agent_end", messages: [], willRetry: false } as unknown as JsonAgentSessionEvent;
const SETTLED = { type: "agent_settled" } as JsonAgentSessionEvent;

/** Feed a whole sequence to one Run and collect whatever it delivers. */
function feed(supervisor: Supervisor, name: string, events: JsonAgentSessionEvent[]): Delivery[] {
	const deliveries: Delivery[] = [];
	for (const event of events) {
		const delivery = supervisor.observe(name, event);
		if (delivery) deliveries.push(delivery);
	}
	return deliveries;
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
			{ type: "agent_end", messages: [], willRetry: true } as unknown as JsonAgentSessionEvent,
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
