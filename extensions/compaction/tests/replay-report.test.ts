/**
 * The replay runner's report: what was spent, how the cuts score against the
 * fixed pass bars, and the report a maintainer reads.
 *
 * Scored on results made up for the purpose: each test says what the judge
 * and the deterministic checks found on each cut, and reads the verdict.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { Meter, renderReport, score } from "../replay/replay-report.ts";
import type { CutResult, LaneCut, SessionResult } from "../replay/replay-session.ts";
import { MODEL } from "./fake-pi.ts";
import { scriptModel } from "./scripted-model.ts";

/** What one lane came to at a cut: its file state exact or not, and the share of recurring details it kept. */
function lane(exact = true, share: number | undefined = 0.8): LaneCut {
	return {
		handoff: { summary: "## Goal\n…", details: { writer: "fork" } },
		fileState: { exact, missing: exact ? [] : ["src/a.ts"], extra: [], wrong: [] },
		retention: { share, recurring: [], lost: [] },
		continuation: { matched: [] },
	} as unknown as LaneCut;
}

const no = (evidence = "checked") => ({ verdict: false, evidence });
const yes = (evidence: string) => ({ verdict: true, evidence });
const clean = () => ({ violations: [] as { rule: string; evidence: string }[], reask: no(), redone: no() });

interface CutSpec {
	/** Of 20 constraints the user gave, how many each Handoff carries. */
	carried?: { ours: number; pi: number };
	ours?: Partial<ReturnType<typeof clean>>;
	pi?: Partial<ReturnType<typeof clean>>;
	exact?: { ours: boolean; pi: boolean };
}

function cut(depth: number, spec: CutSpec = {}): CutResult {
	const carried = spec.carried ?? { ours: 20, pi: 14 };
	return {
		depth,
		kind: (["self", "forced", "before-user"] as const)[(depth - 1) % 3]!,
		requested: (["self", "forced", "before-user"] as const)[(depth - 1) % 3]!,
		ours: lane(spec.exact?.ours ?? true),
		pi: lane(spec.exact?.pi ?? false, 0.5),
		verdict: {
			constraints: Array.from({ length: 20 }, (_, i) => ({
				quote: `rule ${i + 1}`,
				ours: i < carried.ours ? yes("in the ledger") : no("not in it"),
				pi: i < carried.pi ? yes("in the summary") : no("not in it"),
			})),
			ours: { ...clean(), ...spec.ours },
			pi: { ...clean(), ...spec.pi },
			dropped: [],
		},
	};
}

/** Ten sessions of three chained cuts, as a full run has; `change` edits any cut before scoring. */
function run(change: (cut: CutResult, session: number) => void = () => {}): SessionResult[] {
	return Array.from({ length: 10 }, (_, s) => {
		const cuts = [cut(1), cut(2), cut(3)];
		for (const c of cuts) change(c, s);
		return { name: `session-${s + 1}`, model: "anthropic/fable-5", cuts };
	});
}

const bar = (scored: ReturnType<typeof score>, check: string) => {
	const found = scored.bars.find((b) => b.check.startsWith(check));
	assert.ok(found, `no bar for ${check}: ${scored.bars.map((b) => b.check).join(", ")}`);
	return found;
};

describe("the pass bars", () => {
	it("pass a run whose every cut is clean, with ours ahead of pi's default", () => {
		const scored = score(run());
		assert.equal(scored.cuts, 30);
		assert.deepEqual(scored.inconclusive, []);
		assert.deepEqual(scored.bars.filter((b) => !b.pass).map((b) => b.check), []);
		assert.equal(scored.pass, true);
		assert.deepEqual(scored.recall.ours, [1, 1, 1]);
		assert.deepEqual(scored.recall.pi, [0.7, 0.7, 0.7]);
	});

	it("fail ledger recall under 95% at any depth, or one that falls from the first cut to the last", () => {
		// 19 of 20 at depth 3 in five sessions, 20 of 20 in the rest: 97.5%, over the bar, but below depth 1.
		const declining = score(run((c, s) => c.depth === 3 && s < 5 && (c.verdict = cut(3, { carried: { ours: 19, pi: 14 } }).verdict)));
		assert.equal(bar(declining, "Ledger recall").pass, true);
		assert.equal(bar(declining, "No decline").pass, false);
		const low = score(run((c) => c.depth === 2 && (c.verdict = cut(2, { carried: { ours: 18, pi: 14 } }).verdict)));
		assert.equal(bar(low, "Ledger recall").pass, false);
		assert.match(bar(low, "Ledger recall").ours, /90\.0%/);
		assert.equal(low.pass, false);
	});

	it("fail one violation, a second re-ask in thirty cuts, a fourth cut of redone work, or a file state that isn't exact", () => {
		const violated = score(run((c, s) => s === 0 && c.depth === 1 && (c.verdict!.ours.violations = [{ rule: "rule 1", evidence: "edits gen/" }])));
		assert.equal(bar(violated, "Violations").pass, false);

		const reasks = (n: number) => score(run((c, s) => s < n && c.depth === 1 && (c.verdict!.ours.reask = yes("asks again"))));
		assert.equal(bar(reasks(1), "Re-asks").pass, true);
		assert.equal(bar(reasks(2), "Re-asks").pass, false);

		const redone = (n: number) => score(run((c, s) => s < n && c.depth === 2 && (c.verdict!.ours.redone = yes("rewrites it"))));
		assert.equal(bar(redone(3), "Redone work").pass, true);
		assert.equal(bar(redone(4), "Redone work").pass, false);

		const inexact = score(run((c, s) => s === 9 && c.depth === 3 && (c.ours = lane(false))));
		assert.equal(bar(inexact, "File state").pass, false);
		assert.match(bar(inexact, "File state").ours, /29\/30/);
	});

	it("fail ours doing worse than pi's default on any check, even inside the other bars", () => {
		// One re-ask of ours is within ≤1/30, but pi's default made none.
		const scored = score(run((c, s) => s === 0 && c.depth === 1 && (c.verdict!.ours.reask = yes("asks again"))));
		assert.equal(bar(scored, "Re-asks").pass, true);
		assert.equal(bar(scored, "No worse than pi's default").pass, false);
		assert.match(bar(scored, "No worse than pi's default").ours, /re-asks/);
	});

	it("leave a run inconclusive while any cut errored or went unjudged, or nothing was cut at all", () => {
		const errored = score(run((c, s) => s === 0 && c.depth === 3 && (c.error = "the provider is down")));
		assert.equal(errored.pass, false);
		assert.deepEqual(errored.inconclusive, ["session-1, cut 3: the provider is down"]);
		const unjudged = score(run((c, s) => s === 1 && c.depth === 2 && (delete c.verdict, (c.unjudged = "the reply has no JSON object"))));
		assert.deepEqual(unjudged.inconclusive, ["session-2, cut 2: not judged (the reply has no JSON object)"]);
		assert.deepEqual(score([{ name: "x", skipped: "too short", cuts: [] }]).inconclusive, ["no cut was replayed"]);
	});
});

const USAGE = (input: number, output: number, cost: number): Partial<Usage> => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

describe("the spend", () => {
	it("is what each call's usage says it cost, totalled by what it was spent on", async () => {
		const meter = new Meter();
		const model = scriptModel({ text: "a", usage: USAGE(1_000, 100, 0.25) }, { text: "b", usage: USAGE(2_000, 200, 0.5) }, { text: "c", usage: USAGE(500, 50, 0.1) });
		for (const spending of ["writer", "writer", "judge"] as const) {
			const events = meter.metered(spending, model.stream)(MODEL, { messages: [] }, {});
			await events.result();
		}
		await meter.settled();
		assert.deepEqual(
			meter.rows().map(({ spending, calls, input, output, cost }) => ({ spending, calls, input, output, cost })),
			[
				{ spending: "writer", calls: 2, input: 3_000, output: 300, cost: 0.75 },
				{ spending: "judge", calls: 1, input: 500, output: 50, cost: 0.1 },
			],
		);
		assert.equal(meter.total(), 0.85);
	});
});

describe("the report", () => {
	it("says the verdict, each bar against ours and pi's default, the spend, the skipped sessions and the evidence for each finding", async () => {
		const sessions = run((c, s) => s === 0 && c.depth === 1 && (c.verdict!.ours.reask = yes('asks "Which runner?", answered by "Use vitest."')));
		sessions.push({ name: "too-short", skipped: "it is too short for a chain of two cuts", cuts: [] });
		const meter = new Meter();
		meter.record("writer", USAGE(10_000, 1_000, 12.5) as Usage);
		meter.record("judge", USAGE(5_000, 500, 3.25) as Usage);
		const report = renderReport({ sessions, scored: score(sessions), meter, mode: "full", startedAt: new Date("2026-10-31T09:00:00Z"), judge: "anthropic/claude-fable-5" });

		assert.match(report, /^# Replay check/m);
		assert.match(report, /FAIL/);
		assert.match(report, /\| Ledger recall .*\| 100\.0% .*\| 70\.0% /);
		assert.match(report, /\| Re-asks .*\| 1\/30 /);
		assert.match(report, /Total.*\$15\.75/);
		assert.match(report, /too-short: it is too short for a chain of two cuts/);
		assert.ok(report.includes('asks "Which runner?", answered by "Use vitest."'), "a finding comes with its evidence");
		assert.match(report, /Recurring-detail retention/);
		assert.match(report, /claude-fable-5/);
	});
});
