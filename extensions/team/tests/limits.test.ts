/**
 * The core's classifier of a Teammate's `StopFailure`: Claude Code's `error`
 * and the message it showed in, what kind of failure it is and when its limit
 * resets out. The limit-message text is a fragile dependency, so every kind
 * the Effort acts on is pinned here as Claude Code words it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, familyOf } from "../limits.ts";

// A Monday, 10:00 UTC.
const AT = "2026-11-02T10:00:00.000Z";

describe("classifying a StopFailure", () => {
	it("tells every limit message kind apart, with when it resets", () => {
		const table: [string, string | undefined, ReturnType<typeof classify>][] = [
			["You've hit your session limit · resets 3:45pm", "rate_limit", { kind: "limit", limit: "session", reset: "2026-11-02T15:45:00.000Z", armed: false }],
			["You've hit your 5-hour limit · resets 11am", "rate_limit", { kind: "limit", limit: "session", reset: "2026-11-02T11:00:00.000Z", armed: false }],
			["You've hit your weekly limit · resets Mon 12:00am", "rate_limit", { kind: "limit", limit: "weekly", reset: "2026-11-09T00:00:00.000Z", armed: false }],
			["You've hit your Opus limit · resets 3:45pm", "rate_limit", { kind: "limit", limit: "opus", reset: "2026-11-02T15:45:00.000Z", armed: false }],
			["You've hit your Sonnet limit · resets Thu 9am", undefined, { kind: "limit", limit: "sonnet", reset: "2026-11-05T09:00:00.000Z", armed: false }],
		];
		for (const [message, error, expected] of table) assert.deepEqual(classify(error, message, AT), expected, message);
	});

	it("reads the reset as the next time it names after the failure, in the machine's time zone or the one the message names", () => {
		// 2:00am at UTC+7 is 19:00 UTC the day before, which has passed by 10:00 UTC: the next one is tomorrow's.
		assert.equal(classifyReset("You've hit your session limit · resets 2am", 7 * 60), "2026-11-02T19:00:00.000Z");
		assert.equal(classifyReset("You've hit your session limit · resets 9am", 0), "2026-11-03T09:00:00.000Z");
		assert.equal(classifyReset("You've hit your session limit · resets 17:30", 0), "2026-11-02T17:30:00.000Z");
		assert.equal(classifyReset("You've hit your session limit · resets 3pm (Asia/Saigon)", 0), "2026-11-03T08:00:00.000Z");
		assert.equal(classifyReset("You've hit your weekly limit · resets Nov 20, 9am", 0), "2026-11-20T09:00:00.000Z");
		assert.equal(classifyReset("You've hit your session limit", 0), undefined);
	});

	it("tells a burst throttle, an overload and a server error apart from a usage limit", () => {
		assert.deepEqual(classify("rate_limit", "API Error: Server is temporarily limiting requests (not your usage limit)", AT), { kind: "transient", why: "throttle" });
		assert.deepEqual(classify("overloaded", "Repeated 529 Overloaded errors", AT), { kind: "transient", why: "overloaded" });
		assert.deepEqual(classify(undefined, "Repeated 529 Overloaded errors", AT), { kind: "transient", why: "overloaded" });
		assert.deepEqual(classify("server_error", "API Error: 500 Internal server error", AT), { kind: "transient", why: "server_error" });
	});

	it("counts a usage-credit confirm that went unanswered as the consent case, which only the human answers", () => {
		assert.deepEqual(classify("billing_error", "Your limit is reached and the prompt to confirm usage credits went unanswered — nothing was sent", AT), { kind: "consent" });
	});

	it("leaves anything else unknown, with its error, for the Lead", () => {
		assert.deepEqual(classify("billing_error", "Your credit balance is too low", AT), { kind: "unknown", error: "billing_error" });
		assert.deepEqual(classify(undefined, undefined, AT), { kind: "unknown" });
	});

	it("marks a limit whose message says Claude Code will continue by itself: its auto-wait is armed", () => {
		assert.deepEqual(classify("rate_limit", "You've hit your session limit · resets 3:45pm\nContinuing automatically at 3:45pm · Esc to cancel", AT), {
			kind: "limit",
			limit: "session",
			reset: "2026-11-02T15:45:00.000Z",
			armed: true,
		});
	});
});

describe("a Role's model family", () => {
	it("is read from its model, alias or full id, and unknown for none", () => {
		assert.equal(familyOf("opus"), "opus");
		assert.equal(familyOf("claude-opus-4-1"), "opus");
		assert.equal(familyOf("sonnet[1m]"), "sonnet");
		assert.equal(familyOf("claude-fable-5"), "fable");
		assert.equal(familyOf("haiku"), undefined);
		assert.equal(familyOf(undefined), undefined);
	});
});

function classifyReset(message: string, offset: number): string | undefined {
	const failure = classify("rate_limit", message, AT, offset);
	return failure.kind === "limit" ? failure.reset : undefined;
}
