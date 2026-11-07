/**
 * The `/team pending` dialogs, against a UI that answers from a queue the way
 * the human would. The full flows through `/team pending` are in index.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EffortState, Escalation, UsageItem } from "../core.ts";
import { ALLOW, approveOrSendBack, askEscalation, askUsage, DENY, type DialogUI, USAGE_LABELS } from "../dialogs.ts";
import { APPROVE, LATER, SEND_BACK } from "../setup.ts";

/** A UI whose dialogs answer from `answers`, oldest first, recording what each asked. */
function scripted(...answers: (string | undefined)[]): { ui: DialogUI; asked: { kind: string; title: string; options?: string[] }[] } {
	const asked: { kind: string; title: string; options?: string[] }[] = [];
	const ui: DialogUI = {
		async select(title, options) {
			asked.push({ kind: "select", title, options });
			return answers.shift();
		},
		async input(title) {
			asked.push({ kind: "input", title });
			return answers.shift();
		},
	};
	return { ui, asked };
}

const NO_REQUESTS = { teammateRequests: {} } as unknown as EffortState;

describe("approveOrSendBack", () => {
	it("offers approve, send back and later", async () => {
		const { ui, asked } = scripted(APPROVE);
		assert.deepEqual(await approveOrSendBack(ui, "Approve it?"), { answer: "approved" });
		assert.deepEqual(asked, [{ kind: "select", title: "Approve it?", options: [APPROVE, SEND_BACK, LATER] }]);
	});

	it("sends back with the note trimmed", async () => {
		const { ui } = scripted(SEND_BACK, "  fix the title  ");
		assert.deepEqual(await approveOrSendBack(ui, "t"), { answer: "sent-back", note: "fix the title" });
	});

	it("leaves the item waiting on later, or on backing out of the note", async () => {
		assert.equal(await approveOrSendBack(scripted(LATER).ui, "t"), undefined);
		assert.equal(await approveOrSendBack(scripted(SEND_BACK, "   ").ui, "t"), undefined);
		assert.equal(await approveOrSendBack(scripted(SEND_BACK, undefined).ui, "t"), undefined);
		assert.equal(await approveOrSendBack(scripted(undefined).ui, "t"), undefined);
	});
});

describe("askUsage", () => {
	const item: UsageItem = { id: "u1", why: "retries", kind: "server_error", teammate: "dev-1", at: "2026-11-02T10:00:00.000Z" };

	it("offers the choices the item's kind takes, and reads the one picked", async () => {
		const { ui, asked } = scripted(USAGE_LABELS.retry);
		assert.equal(await askUsage(ui, item, []), "retry");
		assert.deepEqual(asked[0]?.options, [USAGE_LABELS.retry, USAGE_LABELS.leave, LATER]);
	});

	it("leaves it for later", async () => {
		assert.equal(await askUsage(scripted(LATER).ui, item, []), undefined);
	});
});

describe("askEscalation", () => {
	const base = { teammate: "dev-1", summary: "Which port?", at: "2026-11-02T10:00:00.000Z" };

	it("takes a prose question's answer in the human's words", async () => {
		const escalation: Escalation = { ...base, id: "q1", kind: "prose", question: "Which port should it use?", brief: "It says nothing." };
		const { ui, asked } = scripted(" 8080 ");
		assert.deepEqual(await askEscalation(ui, escalation, NO_REQUESTS), { text: "8080" });
		assert.match(asked[0]?.title ?? "", /The Brief says: It says nothing\.\ndev-1 asks: Which port should it use\?/);
	});

	it("leaves a prose question waiting on an empty answer", async () => {
		const escalation: Escalation = { ...base, id: "q1", kind: "prose", question: "Which port?" };
		assert.equal(await askEscalation(scripted("").ui, escalation, NO_REQUESTS), undefined);
	});

	it("takes allow or deny with a reason for a permission, filling in an empty reason", async () => {
		const escalation: Escalation = { ...base, id: "req-00000001", kind: "permission", question: "`Bash`: rm -rf /tmp/x" };
		assert.deepEqual(await askEscalation(scripted(DENY, "not yet").ui, escalation, NO_REQUESTS), { decision: "deny", reason: "not yet" });
		assert.deepEqual(await askEscalation(scripted(ALLOW, " ").ui, escalation, NO_REQUESTS), { decision: "allow", reason: "the human allowed it in /team pending" });
	});

	it("leaves a permission waiting on later, or on backing out of the reason", async () => {
		const escalation: Escalation = { ...base, id: "req-00000001", kind: "permission", question: "`Bash`: rm -rf /tmp/x" };
		assert.equal(await askEscalation(scripted(LATER).ui, escalation, NO_REQUESTS), undefined);
		assert.equal(await askEscalation(scripted(ALLOW, undefined).ui, escalation, NO_REQUESTS), undefined);
	});

	it("leaves a question whose held request is gone waiting", async () => {
		const escalation: Escalation = { ...base, id: "req-00000002", kind: "question", question: "Which one?" };
		const { ui, asked } = scripted();
		assert.equal(await askEscalation(ui, escalation, NO_REQUESTS), undefined);
		assert.deepEqual(asked, []);
	});
});
