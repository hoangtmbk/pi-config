/**
 * The replay check's verdict: what a run spent, how its cuts score against the
 * fixed pass bars, and the report a maintainer reads.
 *
 * The bars are spec #32's, for a full run of ten sessions cut three times
 * each, and are applied as rates, so that a shorter run is held to the same
 * standard:
 *
 * - Constraint ledger recall at least 95% at every chain depth, with no
 *   decline from the first cut to the last;
 * - no violations;
 * - re-asks on at most 1 cut in 30, redone work on at most 3 in 30;
 * - file state exact on every cut;
 * - our Handoff no worse than pi's default summary on any of those.
 *
 * Recurring-detail retention and the collapse guard are reported, not gated.
 * A run with a cut that errored or went unjudged passes nothing: it is
 * inconclusive. The bars are only to be trusted once the judge has been
 * checked against hand labels (see the spec's build steps).
 *
 * Plain functions but for `Meter`, which counts what model calls cost.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { describeAction } from "./replay-judge.ts";
import type { CutResult, LaneCut, ModelCall, SessionResult, Spending } from "./replay-session.ts";

// ---------- the spend ----------

/** What one kind of call cost, all told. */
export interface SpendRow {
	spending: Spending;
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** In dollars, as each call's usage priced it. */
	cost: number;
}

const SPENDING_ORDER: readonly Spending[] = ["writer", "steered", "pi-default", "continuation", "judge"];

const SPENDING_LABEL: Record<Spending, string> = {
	writer: "Our Handoff writers",
	steered: "The agent answering its steer",
	"pi-default": "pi's default summary",
	continuation: "Continuations",
	judge: "The judge",
};

/** The actual spend: every model call's usage, as it comes back. */
export class Meter {
	private readonly byKind = new Map<Spending, SpendRow>();
	private readonly pending = new Set<Promise<unknown>>();

	record(spending: Spending, usage: Usage): void {
		const row = this.byKind.get(spending) ?? { spending, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		row.calls++;
		row.input += usage.input;
		row.output += usage.output;
		row.cacheRead += usage.cacheRead;
		row.cacheWrite += usage.cacheWrite;
		row.cost += usage.cost.total;
		this.byKind.set(spending, row);
	}

	/** `call`, counted under `spending` once each reply is in, however it ends. */
	metered(spending: Spending, call: ModelCall): ModelCall {
		return (model, context, options) => {
			const events = call(model, context, options);
			const counted = events.result().then(
				(reply) => this.record(spending, reply.usage),
				() => {},
			);
			this.pending.add(counted);
			void counted.finally(() => this.pending.delete(counted));
			return events;
		};
	}

	/** Once every call made so far is counted. */
	async settled(): Promise<void> {
		await Promise.all([...this.pending]);
	}

	rows(): SpendRow[] {
		return SPENDING_ORDER.flatMap((spending) => this.byKind.get(spending) ?? []);
	}

	total(): number {
		return Math.round(this.rows().reduce((sum, row) => sum + row.cost, 0) * 1e6) / 1e6;
	}
}

// ---------- the pass bars ----------

/** One pass bar, scored. */
export interface Bar {
	check: string;
	/** What it takes, as the report says it. */
	bar: string;
	ours: string;
	pi: string;
	pass: boolean;
}

export interface Scorecard {
	bars: Bar[];
	/** Whether every bar passed, on a conclusive run. */
	pass: boolean;
	/** Why the run can't be trusted to pass: cuts that errored or went unjudged. */
	inconclusive: string[];
	/** Cuts replayed and judged. */
	cuts: number;
	/** Constraint ledger recall at each chain depth, from 1; `undefined` where no constraint was given. */
	recall: { ours: (number | undefined)[]; pi: (number | undefined)[] };
}

const RECALL_BAR = 0.95;
const REASK_BAR = 1 / 30;
const REDONE_BAR = 3 / 30;

type Lane = "ours" | "pi";

interface LaneTotals {
	recall: (number | undefined)[];
	violations: number;
	reasks: number;
	redone: number;
	exact: number;
}

const percent = (share: number | undefined) => (share === undefined ? "—" : `${(share * 100).toFixed(1)}%`);
const outOf = (count: number, of: number) => `${count}/${of}${of > 0 ? ` (${percent(count / of)})` : ""}`;

function totals(cuts: readonly CutResult[], lane: Lane): LaneTotals {
	const depths = Math.max(0, ...cuts.map((cut) => cut.depth));
	const recall = Array.from({ length: depths }, (_, d) => {
		const constraints = cuts.filter((cut) => cut.depth === d + 1).flatMap((cut) => cut.verdict!.constraints);
		return constraints.length === 0 ? undefined : constraints.filter((c) => c[lane].verdict).length / constraints.length;
	});
	return {
		recall,
		violations: cuts.reduce((sum, cut) => sum + cut.verdict![lane].violations.length, 0),
		reasks: cuts.filter((cut) => cut.verdict![lane].reask.verdict).length,
		redone: cuts.filter((cut) => cut.verdict![lane].redone.verdict).length,
		exact: cuts.filter((cut) => cut[lane]!.fileState.exact).length,
	};
}

/** Score a run's sessions against the pass bars. */
export function score(sessions: readonly SessionResult[]): Scorecard {
	const inconclusive: string[] = [];
	for (const session of sessions) {
		for (const cut of session.cuts) {
			if (cut.error) inconclusive.push(`${session.name}, cut ${cut.depth}: ${cut.error}`);
			else if (!cut.verdict) inconclusive.push(`${session.name}, cut ${cut.depth}: not judged (${cut.unjudged ?? "no verdict"})`);
		}
	}
	const cuts = sessions.flatMap((session) => session.cuts.filter((cut) => !cut.error && cut.verdict && cut.ours && cut.pi));
	if (cuts.length === 0 && inconclusive.length === 0) inconclusive.push("no cut was replayed");
	const ours = totals(cuts, "ours");
	const pi = totals(cuts, "pi");
	const n = cuts.length;
	const known = (recall: (number | undefined)[]) => recall.filter((r): r is number => r !== undefined);
	const depths = (recall: (number | undefined)[]) => recall.map(percent).join(" · ") || "—";

	const worse: string[] = [];
	ours.recall.forEach((r, d) => r !== undefined && pi.recall[d] !== undefined && r < pi.recall[d]! && worse.push(`recall at depth ${d + 1}`));
	if (ours.violations > pi.violations) worse.push("violations");
	if (ours.reasks > pi.reasks) worse.push("re-asks");
	if (ours.redone > pi.redone) worse.push("redone work");
	if (ours.exact < pi.exact) worse.push("file state");
	const first = known(ours.recall)[0];
	const last = known(ours.recall).at(-1);

	const bars: Bar[] = [
		{
			check: "Ledger recall at every depth",
			bar: "≥95%",
			ours: depths(ours.recall),
			pi: depths(pi.recall),
			pass: known(ours.recall).every((r) => r >= RECALL_BAR),
		},
		{
			check: "No decline in recall from the first cut to the last",
			bar: "last ≥ first",
			ours: `${percent(first)} → ${percent(last)}`,
			pi: `${percent(known(pi.recall)[0])} → ${percent(known(pi.recall).at(-1))}`,
			pass: first === undefined || last === undefined || last >= first,
		},
		{ check: "Violations", bar: "0", ours: String(ours.violations), pi: String(pi.violations), pass: ours.violations === 0 },
		{ check: "Re-asks", bar: "≤1/30 cuts", ours: outOf(ours.reasks, n), pi: outOf(pi.reasks, n), pass: n === 0 || ours.reasks / n <= REASK_BAR },
		{ check: "Redone work", bar: "≤3/30 cuts", ours: outOf(ours.redone, n), pi: outOf(pi.redone, n), pass: n === 0 || ours.redone / n <= REDONE_BAR + 1e-9 },
		{ check: "File state exact", bar: "every cut", ours: outOf(ours.exact, n), pi: outOf(pi.exact, n), pass: ours.exact === n },
		{
			check: "No worse than pi's default",
			bar: "on every check",
			ours: worse.length ? `worse on ${worse.join(", ")}` : "no worse",
			pi: "—",
			pass: worse.length === 0,
		},
	];
	return { bars, pass: inconclusive.length === 0 && bars.every((b) => b.pass), inconclusive, cuts: n, recall: { ours: ours.recall, pi: pi.recall } };
}

// ---------- the report ----------

export interface Run {
	sessions: readonly SessionResult[];
	scored: Scorecard;
	meter: Meter;
	mode: "full" | "quick";
	startedAt: Date;
	/** `provider/id` of the judge. */
	judge: string;
	/** Why the run stopped short of its corpus, for a report written before the end. */
	unfinished?: string;
}

const dollars = (cost: number) => `$${cost.toFixed(2)}`;
const count = new Intl.NumberFormat("en-US");

/** The mean share of recurring details a lane kept, over the cuts where any recurred. */
function retention(sessions: readonly SessionResult[], lane: Lane): string {
	const shares = sessions.flatMap((s) => s.cuts.flatMap((cut) => (cut[lane]?.retention.share === undefined ? [] : [cut[lane]!.retention.share!])));
	if (shares.length === 0) return "— (nothing recurred)";
	return `${percent(shares.reduce((a, b) => a + b, 0) / shares.length)} over ${shares.length} cuts`;
}

function collapses(sessions: readonly SessionResult[], lane: Lane): string {
	const chains = sessions.filter((s) => s.collapse?.[lane].collapsed);
	const flags = sessions.reduce((sum, s) => sum + (s.collapse?.[lane].flags.length ?? 0), 0);
	return `${chains.length} of ${sessions.filter((s) => s.collapse).length} chains, ${flags} flags`;
}

function laneLine(name: string, lane: LaneCut | undefined): string {
	if (!lane) return `  - ${name}: none`;
	const { continuation, fileState } = lane;
	const writer = (lane.handoff.details as { writer?: string } | undefined)?.writer;
	const parts = [
		writer ? `written by ${writer}` : undefined,
		`${continuation.matched.length} action(s) matched`,
		continuation.differed ? `then differed: ${describeAction(continuation.differed.proposed).replace(/\n/g, " · ")}` : "every action matched",
		fileState.exact ? "file state exact" : `file state off (missing ${fileState.missing.join(", ") || "—"}; extra ${fileState.extra.join(", ") || "—"}; wrong ${fileState.wrong.map((w) => w.path).join(", ") || "—"})`,
	];
	return `  - ${name}: ${parts.filter(Boolean).join("; ")}`;
}

function findings(cut: CutResult, lane: Lane): string[] {
	const verdict = cut.verdict;
	if (!verdict) return [];
	const lines: string[] = [];
	for (const c of verdict.constraints) if (!c[lane].verdict) lines.push(`    - dropped "${c.quote}": ${c[lane].evidence}`);
	for (const v of verdict[lane].violations) lines.push(`    - violates "${v.rule}": ${v.evidence}`);
	if (verdict[lane].reask.verdict) lines.push(`    - re-asks: ${verdict[lane].reask.evidence}`);
	if (verdict[lane].redone.verdict) lines.push(`    - redoes work: ${verdict[lane].redone.evidence}`);
	return lines;
}

function cutSection(cut: CutResult): string[] {
	const kind = cut.kind === cut.requested ? cut.kind : `${cut.kind} (asked for ${cut.requested}${cut.declined ? `; the agent didn't Self-compact when steered${cut.declinedWith ? `, it ${cut.declinedWith}` : ""}` : ""})`;
	const lines = [`- Cut ${cut.depth}, ${kind}`];
	if (cut.error) return [...lines, `  - error: ${cut.error}`];
	lines.push(laneLine("ours", cut.ours), ...findings(cut, "ours"), laneLine("pi's default", cut.pi), ...findings(cut, "pi"));
	if (cut.unjudged) lines.push(`  - not judged: ${cut.unjudged}`);
	if (cut.verdict?.dropped.length) lines.push(`  - the judge's findings dropped: ${cut.verdict.dropped.join("; ")}`);
	return lines;
}

/** The report, in Markdown. */
export function renderReport(run: Run): string {
	const { sessions, scored, meter } = run;
	const replayed = sessions.filter((s) => !s.skipped);
	const skipped = sessions.filter((s) => s.skipped);
	const allCuts = replayed.flatMap((s) => s.cuts);
	const kinds = (["self", "forced", "before-user"] as const).map((kind) => `${allCuts.filter((c) => c.kind === kind).length} ${kind}`).join(", ");
	const declined = allCuts.filter((c) => c.declined).length;
	const inconclusive = [...(run.unfinished ? [run.unfinished] : []), ...scored.inconclusive];
	const result = inconclusive.length ? "INCONCLUSIVE" : scored.pass ? "PASS" : "FAIL";

	const lines = [
		`# Replay check, ${run.startedAt.toISOString()} (${run.mode})`,
		"",
		`**${result}.** ${replayed.length} sessions replayed, ${skipped.length} skipped; ${allCuts.length} cuts (${kinds}${declined ? `; ${declined} Self-compaction cuts compacted as forced` : ""}), ${scored.cuts} scored. Judge: ${run.judge}.`,
		"",
		"The bars hold only once the judge has been checked against hand labels (≥85% agreement on about 30 cuts).",
		"",
		"## Pass bars",
		"",
		"| Check | Bar | Ours | pi's default | Pass |",
		"|---|---|---|---|---|",
		...scored.bars.map((b) => `| ${b.check} | ${b.bar} | ${b.ours} | ${b.pi} | ${b.pass ? "yes" : "**no**"} |`),
	];
	if (inconclusive.length) lines.push("", "## Inconclusive", "", ...inconclusive.map((why) => `- ${why}`));
	lines.push(
		"",
		"## Reported, not gated",
		"",
		`- Recurring-detail retention: ours ${retention(replayed, "ours")}; pi's default ${retention(replayed, "pi")}. Below 70% for ours is the trigger to add an identifier dump.`,
		`- Collapse guard: ours ${collapses(replayed, "ours")}; pi's default ${collapses(replayed, "pi")}.`,
		"",
		"## Spend",
		"",
		"| For | Calls | Input | Output | Cache read | Cache write | Cost |",
		"|---|---|---|---|---|---|---|",
		...meter.rows().map(
			(r) => `| ${SPENDING_LABEL[r.spending]} | ${r.calls} | ${count.format(r.input)} | ${count.format(r.output)} | ${count.format(r.cacheRead)} | ${count.format(r.cacheWrite)} | ${dollars(r.cost)} |`,
		),
		`| **Total** | | | | | | **${dollars(meter.total())}** |`,
		"",
		"## Cuts",
	);
	for (const session of replayed) lines.push("", `### ${session.name} (${session.model ?? "?"})`, "", ...session.cuts.flatMap(cutSection));
	if (skipped.length) lines.push("", "## Skipped", "", ...skipped.map((s) => `- ${s.name}: ${s.skipped}`));
	return `${lines.join("\n")}\n`;
}
