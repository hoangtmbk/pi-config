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

	it("counts a Waiting Run as active and a finished one as not", () => {
		const supervisor = new Supervisor();
		const finished = supervisor.register("scout", "one");
		const asking = supervisor.register("worker", "two");
		feed(supervisor, finished.name, [said("done"), SETTLED]);
		feed(supervisor, asking.name, [asked("Which one?"), SETTLED]);

		assert.deepEqual(supervisor.active().map((run) => run.name), ["worker"]);
	});

	it("has nothing to say about a name it never registered", () => {
		const supervisor = new Supervisor();

		assert.equal(supervisor.observe("ghost", SETTLED), undefined);
	});
});

/**
 * Feed a sequence the way the extension does — observe, then post whatever the
 * Run announces — and collect where each message was routed.
 */
function announce(supervisor: Supervisor, name: string, events: JsonAgentSessionEvent[]): string[] {
	const routes: string[] = [];
	for (const event of events) {
		const message = supervisor.observe(name, event);
		if (message) routes.push(supervisor.post(message));
	}
	return routes;
}

/** A join in flight, so a test can ask whether it has answered yet. */
function watch(joined: Promise<ParentMessage[]>): { collected?: ParentMessage[] } {
	const state: { collected?: ParentMessage[] } = {};
	joined.then((messages) => {
		state.collected = messages;
	});
	return state;
}

describe("Supervisor joins", () => {
	it("collects a Run that has already finished, without waiting for anything", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		feed(supervisor, run.name, [said("Found three call sites."), SETTLED]);

		const collected = await supervisor.join([run.name]);

		assert.equal(collected.length, 1);
		assert.equal(collected[0].kind, "delivery");
		assert.match(collected[0].text, /Found three call sites\./);
	});

	it("waits for a Run that is still in flight, and takes its Delivery when it settles", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");

		const joined = supervisor.join([run.name]);
		const routes = announce(supervisor, run.name, [said("Found three call sites."), SETTLED]);
		const collected = await joined;

		assert.deepEqual(routes, ["join"], "a joined message is not also delivered on its own");
		assert.equal(collected.length, 1);
		assert.match(collected[0].text, /Found three call sites\./);
	});

	it("returns once the last of the Runs it named has stopped, with all of them", async () => {
		const supervisor = new Supervisor();
		const first = supervisor.register("scout", "one");
		const second = supervisor.register("worker", "two");
		const join = watch(supervisor.join([first.name, second.name]));

		announce(supervisor, first.name, [said("first result"), SETTLED]);
		await Promise.resolve();
		const halfway = join.collected;
		assert.equal(halfway, undefined, "one Run of two has stopped, so the join is not finished");

		announce(supervisor, second.name, [said("second result"), SETTLED]);
		await Promise.resolve();

		assert.deepEqual(join.collected?.map((message) => message.run.name), ["scout", "worker"]);
		assert.match(join.collected?.[0].text ?? "", /first result/);
		assert.match(join.collected?.[1].text ?? "", /second result/);
	});

	it("collects both Runs when two settle in the same tick", async () => {
		const supervisor = new Supervisor();
		const first = supervisor.register("scout", "one");
		const second = supervisor.register("scout", "two");

		const joined = supervisor.join([first.name, second.name]);
		supervisor.observe(first.name, said("first result"));
		supervisor.observe(second.name, said("second result"));
		const firstRoute = supervisor.post(supervisor.observe(first.name, SETTLED) as ParentMessage);
		const secondRoute = supervisor.post(supervisor.observe(second.name, SETTLED) as ParentMessage);
		const collected = await joined;

		assert.deepEqual([firstRoute, secondRoute], ["join", "join"]);
		assert.deepEqual(collected.map((message) => message.run.result), ["first result", "second result"]);
	});

	it("ends on a Waiting Run rather than deadlocking, and can be joined again once it is answered", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");

		const joined = supervisor.join([run.name]);
		announce(supervisor, run.name, [asked("Which auth module do you mean?"), SETTLED]);
		const waiting = await joined;

		assert.equal(waiting[0].kind, "question");
		assert.match(waiting[0].text, /Which auth module do you mean\?/);

		// Answering is what takes a Run out of Waiting, and it is the only moment
		// the parent can sequence against — a join placed after it waits for the
		// resumed Run rather than collecting the spent Question again.
		supervisor.answered(run.name);
		const rejoined = watch(supervisor.join([run.name]));
		await Promise.resolve();
		const halfway = rejoined.collected;
		assert.equal(halfway, undefined, "the answered Run is working again, so the join waits for it");

		announce(supervisor, run.name, [said("Three call sites."), SETTLED]);
		await Promise.resolve();

		assert.equal(rejoined.collected?.[0].kind, "delivery");
		assert.match(rejoined.collected?.[0].text ?? "", /Three call sites\./);
	});

	it("leaves a Run no join named to deliver on its own", () => {
		const supervisor = new Supervisor();
		const joined = supervisor.register("scout", "one");
		const other = supervisor.register("scout", "two");
		supervisor.join([joined.name]);

		const routes = announce(supervisor, other.name, [said("second result"), SETTLED]);

		assert.deepEqual(routes, ["conversation"]);
	});
});

describe("Supervisor no double delivery", () => {
	it("says a Delivery that already reached the conversation was delivered, rather than saying it twice", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		const routes = announce(supervisor, run.name, [said("Found three call sites."), SETTLED]);

		const collected = await supervisor.join([run.name]);

		assert.deepEqual(routes, ["conversation"], "no join was pending, so it was auto-delivered");
		assert.equal(collected.length, 1);
		assert.match(collected[0].text, /already delivered/);
		assert.doesNotMatch(collected[0].text, /Found three call sites\./);
	});

	it("hands a result to the first join to collect it and to no second one", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		feed(supervisor, run.name, [said("Found three call sites."), SETTLED]);

		const first = await supervisor.join([run.name]);
		const second = await supervisor.join([run.name]);

		assert.match(first[0].text, /Found three call sites\./);
		assert.match(second[0].text, /already delivered/);
		assert.doesNotMatch(second[0].text, /Found three call sites\./);
	});

	it("does not repeat an already-delivered Run for the sake of the in-flight one beside it", async () => {
		const supervisor = new Supervisor();
		const finished = supervisor.register("scout", "one");
		const working = supervisor.register("worker", "two");
		announce(supervisor, finished.name, [said("first result"), SETTLED]);

		const joined = supervisor.join([finished.name, working.name]);
		announce(supervisor, working.name, [said("second result"), SETTLED]);
		const collected = await joined;

		assert.match(collected[0].text, /already delivered/);
		assert.doesNotMatch(collected[0].text, /first result/);
		assert.match(collected[1].text, /second result/);
	});

	it("counts a failed Run's Delivery as said too, because failures travel the same path", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		const failure = supervisor.fail(run.name, { kind: "exit", exitCode: 3, stderr: "pi: out of tokens" });
		supervisor.post(failure as ParentMessage);

		const collected = await supervisor.join([run.name]);

		assert.equal(collected[0].kind, "delivery");
		assert.match(collected[0].text, /already delivered/);
		assert.doesNotMatch(collected[0].text, /out of tokens/);
	});

	it("marks a message its caller said itself, so a later join does not say it again", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		supervisor.fail(run.name, { kind: "spawn", message: "pi: unknown tool `telepathy`" });
		supervisor.markSaid(run.name);

		const collected = await supervisor.join([run.name]);

		assert.match(collected[0].text, /already delivered/);
		assert.doesNotMatch(collected[0].text, /telepathy/);
	});

	it("keeps saying an outstanding Question, which is not a result the parent already holds", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		const routes = announce(supervisor, run.name, [asked("Which auth module do you mean?"), SETTLED]);

		const first = await supervisor.join([run.name]);
		const second = await supervisor.join([run.name]);

		assert.deepEqual(routes, ["conversation"]);
		assert.match(first[0].text, /Which auth module do you mean\?/);
		assert.match(second[0].text, /Which auth module do you mean\?/);
	});

	it("gives an answered Run a fresh thing to say, so its Delivery is not mistaken for the spent Question", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		announce(supervisor, run.name, [asked("Which auth module do you mean?"), SETTLED]);
		supervisor.answered(run.name);

		announce(supervisor, run.name, [said("Three call sites."), SETTLED]);
		const collected = await supervisor.join([run.name]);

		assert.match(collected[0].text, /already delivered/, "the Delivery went to the conversation, once");
		assert.equal(supervisor.get(run.name)?.result, "Three call sites.");
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

		const announced = feed(supervisor, run.name, [asked("Which auth module do you mean?"), SETTLED]);
		supervisor.answered(run.name);
		announced.push(...feed(supervisor, run.name, [AGENT_START, asked("Should I include the tests?"), SETTLED]));
		supervisor.answered(run.name);
		announced.push(...feed(supervisor, run.name, [AGENT_START, said("Three call sites, tests included."), AGENT_END, SETTLED]));

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

	it("counts a Run as running again once it has been answered, without waiting on its child", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");

		feed(supervisor, run.name, [asked("Which auth module do you mean?"), SETTLED]);
		supervisor.answered(run.name);

		assert.equal(supervisor.get(run.name)?.state, "running");
		assert.equal(supervisor.get(run.name)?.question, undefined);
	});

	it("puts an answered Run back on its Question when the answer could not be sent", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		feed(supervisor, run.name, [asked("Which auth module do you mean?"), SETTLED]);

		supervisor.answered(run.name);
		supervisor.unanswered(run.name, "Which auth module do you mean?");

		assert.equal(supervisor.get(run.name)?.state, "waiting");
		assert.equal(supervisor.get(run.name)?.question, "Which auth module do you mean?");
	});

	it("leaves a Run that is not Waiting alone when told it was answered", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		feed(supervisor, run.name, [said("Found three call sites."), SETTLED]);

		supervisor.answered(run.name);
		supervisor.answered("ghost");

		assert.equal(supervisor.get(run.name)?.state, "done");
		assert.equal(supervisor.get(run.name)?.result, "Found three call sites.");
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
		supervisor.answered(run.name);
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

describe("Supervisor failures", () => {
	it("says a child that exited cleanly but early stopped early, not that code 0 went wrong", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");

		const delivery = supervisor.fail(run.name, { kind: "exit", exitCode: 0 });

		assert.match(delivery?.text ?? "", /exited before the run finished/i);
		assert.doesNotMatch(delivery?.text ?? "", /code 0/);
	});

	it("delivers a failed result carrying the exit code and the last stderr", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		feed(supervisor, run.name, [AGENT_START]);

		const delivery = supervisor.fail(run.name, { kind: "exit", exitCode: 3, stderr: "pi: out of tokens" });

		assert.equal(delivery?.kind, "delivery");
		assert.equal(delivery?.run.state, "failed");
		assert.match(delivery?.text ?? "", /Run `scout` \(agent `scout`\) failed/);
		assert.match(delivery?.text ?? "", /code 3/);
		assert.match(delivery?.text ?? "", /pi: out of tokens/);
	});
});

describe("Supervisor endings", () => {
	it("fails every Run still going, saying it was the session that stopped them", () => {
		const supervisor = new Supervisor();
		const first = supervisor.register("scout", "one");
		const second = supervisor.register("worker", "two");
		feed(supervisor, second.name, [asked("Which auth module do you mean?"), SETTLED]);

		const deliveries = supervisor.endAll("the session is shutting down");

		assert.deepEqual(deliveries.map((delivery) => delivery.run.name), [first.name, second.name]);
		assert.deepEqual(deliveries.map((delivery) => delivery.run.state), ["failed", "failed"]);
		assert.match(deliveries[0].text, /Run `scout` \(agent `scout`\) failed/);
		assert.match(deliveries[0].text, /the session is shutting down/);
		assert.doesNotMatch(deliveries[1].text, /Which auth module do you mean\?/, "a spent Question is not a result");
	});

	it("leaves a Run that already stopped alone, so a delivered result is not overwritten", () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		feed(supervisor, run.name, [said("Found three call sites."), SETTLED]);

		const deliveries = supervisor.endAll("the session is shutting down");

		assert.deepEqual(deliveries, []);
		assert.equal(supervisor.get(run.name)?.state, "done");
		assert.equal(supervisor.get(run.name)?.result, "Found three call sites.");
	});

	it("ends a join in flight rather than leaving it waiting on Runs that are gone", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		const joined = supervisor.join([run.name]);

		supervisor.endAll("the parent turn was aborted");

		await assert.rejects(joined, (error: Error) => {
			assert.match(error.message, /the parent turn was aborted/);
			return true;
		});
	});

	it("leaves the ended Runs unsaid, so their Deliveries still have somewhere to go", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		const joined = assert.rejects(supervisor.join([run.name]));

		const deliveries = supervisor.endAll("the parent turn was aborted");

		assert.equal(deliveries.length, 1, "the join in flight does not collect them: nobody will read its result");
		assert.match(deliveries[0].text, /the parent turn was aborted/);
		await joined;
	});
});

describe("Supervisor joins that are abandoned", () => {
	it("drops a join whose turn was aborted, rather than stranding it", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		const aborting = new AbortController();

		const joined = supervisor.join([run.name], aborting.signal);
		aborting.abort();

		await assert.rejects(joined);
	});

	it("delivers to the conversation after an abandoned join, rather than into it", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		const aborting = new AbortController();
		const joined = supervisor.join([run.name], aborting.signal);
		aborting.abort();
		await assert.rejects(joined);

		const routes = announce(supervisor, run.name, [said("Found three call sites."), SETTLED]);

		assert.deepEqual(routes, ["conversation"], "the abandoned join is no longer collecting");
	});

	it("collects normally when the turn is never aborted", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		const aborting = new AbortController();

		const joined = supervisor.join([run.name], aborting.signal);
		announce(supervisor, run.name, [said("Found three call sites."), SETTLED]);

		assert.match((await joined)[0].text, /Found three call sites\./);
	});

	it("refuses a join placed on an already-aborted turn, rather than marking Runs said for nobody", async () => {
		const supervisor = new Supervisor();
		const run = supervisor.register("scout", "look around");
		feed(supervisor, run.name, [said("Found three call sites."), SETTLED]);

		await assert.rejects(supervisor.join([run.name], AbortSignal.abort()));
		assert.match((await supervisor.join([run.name]))[0].text, /Found three call sites\./);
	});
});
