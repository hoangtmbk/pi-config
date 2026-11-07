/**
 * The `/team pending` dialogs: what the human is asked about an item, and
 * the answer read back from their picks. Nothing here changes the Effort;
 * the caller steps the core with the answer, or leaves the item waiting when
 * the human backs out (undefined).
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type EffortState, type Escalation, escalationText, type Teammate, USAGE_CHOICES, type UsageItem, usageText } from "./core.ts";
import { askedInFull, askedQuestions } from "./requests.ts";
import { APPROVE, LATER, SEND_BACK } from "./setup.ts";

/** The dialogs a `/team pending` answer is read from. */
export type DialogUI = Pick<ExtensionUIContext, "select" | "input">;

/** The `/team pending` choices for an escalated permission, and the end of a multiSelect question's picks. */
export const ALLOW = "Allow";
export const DENY = "Deny";
export const DONE = "Done";

/** What each usage-item choice reads as in `/team pending`. */
export const USAGE_LABELS: Record<string, string> = {
	stay: "Stay paused until it resets",
	cancel: "Cancel the Effort: stop every Teammate and end it without sign-off",
	retry: "Retry: send it `continue` again",
	leave: "Leave it to the Lead",
};

/** A usage item's choice, as `USAGE_CHOICES` names it. */
export type UsageChoice = (typeof USAGE_CHOICES)[keyof typeof USAGE_CHOICES][number];

/** The human's answer to one escalated item. */
export interface EscalationAnswer {
	decision?: "allow" | "deny";
	reason?: string;
	answers?: Record<string, string | string[]>;
	text?: string;
}

/** Approve, send back with a note, or leave for later: what the human answers to `title`; undefined leaves the item waiting. */
export async function approveOrSendBack(ui: DialogUI, title: string): Promise<{ answer: "approved"; note?: undefined } | { answer: "sent-back"; note: string } | undefined> {
	const answer = await ui.select(title, [APPROVE, SEND_BACK, LATER]);
	if (answer === APPROVE) return { answer: "approved" };
	if (answer !== SEND_BACK) return undefined;
	const note = (await ui.input("Note for the Lead: what should change?"))?.trim();
	// Backing out of the note leaves the item waiting, as "later" does.
	return note ? { answer: "sent-back", note } : undefined;
}

/** The choice the human picks for a usage item, from those its kind offers; undefined leaves it for later. */
export async function askUsage(ui: DialogUI, item: UsageItem, teammates: readonly Teammate[]): Promise<UsageChoice | undefined> {
	const choices: readonly UsageChoice[] = USAGE_CHOICES[item.why];
	const answer = await ui.select(usageText(item, teammates), [...choices.map((choice) => USAGE_LABELS[choice]), LATER]);
	return choices.find((each) => USAGE_LABELS[each] === answer);
}

/**
 * The human's answer to one escalated item, from its dialogs: a permission
 * takes allow or deny with a reason, a question the Teammate's own options,
 * and a prose question the human's words. Undefined when they leave it for
 * later.
 */
export async function askEscalation(ui: DialogUI, escalation: Escalation, state: EffortState): Promise<EscalationAnswer | undefined> {
	const head = [
		`\`${escalation.id}\`: ${escalationText(escalation, state)}, escalated by the Lead: ${escalation.summary}`,
		...(escalation.brief === undefined ? [] : [`The Brief says: ${escalation.brief}`]),
	];
	if (escalation.kind === "prose") {
		const title = [...head, `${escalation.teammate} asks: ${escalation.question}`, `Your answer goes to ${escalation.teammate} and into clarifications.md:`].join("\n");
		const text = (await ui.input(title))?.trim();
		return text ? { text } : undefined;
	}
	if (escalation.kind === "permission") {
		// The whole call, not the line the Report shows: the human decides on what would run.
		const request = state.teammateRequests[escalation.id];
		const asks = request ? askedInFull(request) : escalation.question;
		const picked = await ui.select([...head, asks.includes("\n") ? `It asks for ${asks}` : `It asks for ${asks}.`].join("\n"), [ALLOW, DENY, LATER]);
		if (picked !== ALLOW && picked !== DENY) return undefined;
		const decision = picked === ALLOW ? "allow" : "deny";
		const reason = await ui.input(decision === "deny" ? `Why not? ${escalation.teammate} reads it:` : "Why? The Lead and the next Report read it:");
		if (reason === undefined) return undefined;
		return { decision, reason: reason.trim() || `the human ${decision === "allow" ? "allowed" : "denied"} it in /team pending` };
	}
	const request = state.teammateRequests[escalation.id];
	if (!request) return undefined;
	const answers: Record<string, string | string[]> = {};
	for (const [n, asked] of askedQuestions(request).entries()) {
		const title = [...(n === 0 ? head : [`\`${escalation.id}\`, question ${n + 1}:`]), `"${asked.question}"${asked.multiSelect ? " (pick any, then Done)" : ""}`].join("\n");
		if (!asked.multiSelect) {
			const label = await ui.select(title, [...asked.labels, LATER]);
			if (label === undefined || !asked.labels.includes(label)) return undefined;
			answers[asked.question] = label;
			continue;
		}
		const picks = new Set<string>();
		while (picks.size < asked.labels.length) {
			const left = asked.labels.filter((label) => !picks.has(label));
			const label = await ui.select(title, [...left, ...(picks.size > 0 ? [DONE] : []), LATER]);
			if (label === DONE) break;
			if (label === undefined || !left.includes(label)) return undefined;
			picks.add(label);
		}
		answers[asked.question] = asked.labels.filter((label) => picks.has(label));
	}
	return { answers };
}
