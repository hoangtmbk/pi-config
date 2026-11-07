/**
 * When the Lead hears from the extension: woken at once while idle, held
 * until its run settles while busy, and its end-of-Effort message stored
 * without a turn (#143).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { leadWakes } from "../lead-wakes.ts";

function recorded() {
	const woken: { customType: string; text: string }[] = [];
	const stored: string[] = [];
	const wakes = leadWakes({ wake: (customType, text) => woken.push({ customType, text }), store: (content) => stored.push(content) });
	return { wakes, woken, stored };
}

describe("leadWakes", () => {
	it("wakes an idle Lead about its Teammates at once, joined, and not at all with nothing to say", () => {
		const { wakes, woken } = recorded();
		wakes.teammates(["one", "two"]);
		wakes.teammates([]);
		assert.deepEqual(woken, [{ customType: "team-teammate", text: "one\n\ntwo" }]);
	});

	it("holds wakes while the Lead's run is active, then wakes once with them and what is new since", () => {
		const { wakes, woken } = recorded();
		wakes.started();
		wakes.teammates(["held"]);
		wakes.away("away");
		assert.deepEqual(woken, []);
		wakes.settled(() => ["fresh"]);
		assert.deepEqual(woken, [{ customType: "team-teammate", text: "held\n\naway\n\nfresh" }]);
		wakes.settled(() => []);
		assert.equal(woken.length, 1, "what waited is said once");
	});

	it("wakes an idle Lead with a pick-up's text as team-away", () => {
		const { wakes, woken } = recorded();
		wakes.away("picked up");
		assert.deepEqual(woken, [{ customType: "team-away", text: "picked up" }]);
	});

	it("stores the end message at once while the Lead is idle, and never as a wake", () => {
		const { wakes, woken, stored } = recorded();
		wakes.ended("ended");
		assert.deepEqual(stored, ["ended"]);
		assert.deepEqual(woken, []);
	});

	it("holds the end message during a run and stores it once the run settles, before any wake", () => {
		const order: string[] = [];
		const wakes = leadWakes({ wake: (_type, text) => order.push(`wake:${text}`), store: (content) => order.push(`store:${content}`) });
		wakes.started();
		wakes.ended("ended");
		wakes.teammates(["late"]);
		assert.deepEqual(order, []);
		wakes.settled(() => []);
		assert.deepEqual(order, ["store:ended", "wake:late"]);
		wakes.settled(() => []);
		assert.deepEqual(order, ["store:ended", "wake:late"], "the end message is stored once");
	});

	it("collects wakes about Teammates while a pick-up runs, and wakes again once it ends", () => {
		const { wakes, woken } = recorded();
		const away: string[] = [];
		wakes.collectInto(away);
		wakes.teammates(["during"]);
		wakes.collectInto(undefined);
		wakes.teammates(["after"]);
		assert.deepEqual(away, ["during"]);
		assert.deepEqual(woken, [{ customType: "team-teammate", text: "after" }]);
	});
});
