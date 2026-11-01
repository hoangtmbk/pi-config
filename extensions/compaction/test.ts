/**
 * Manual runner: the replay check, live. It replays recorded main sessions,
 * cut two or three times in a chain, through the compaction extension and
 * through pi's own default summary, on real models, and reports whether our
 * Handoff is "no loss" against the fixed pass bars — with what it actually
 * spent.
 *
 * Not part of the extension load path and not part of `npm test`: the test
 * script globs `tests/*.test.ts`, which this file sits beside rather than in.
 * It spends real tokens deliberately, so a human runs it, by hand:
 *
 *   npm run live:compaction                     # the full run: up to 10 sessions × 3 cuts, about $45
 *   npm run live:compaction -- --quick          # the first session only, about $5
 *   npm run live:compaction -- --manifest <path>
 *   npm run live:compaction -- --judge <provider>/<model>   # default openai-codex/gpt-6.1-sol
 *   npm run live:compaction -- --rejudge <report.json> [--only "<session>#<depth>"]...
 *
 * `--rejudge` runs only the judge again, on a saved report's Handoffs and
 * continuations: a change to the judge is checked against the hand labels
 * for about $1.30 a full report, not $45. Use the manifest the report was run
 * from, and the report's own judge unless `--judge` says otherwise. `--only`
 * picks cuts to judge again; the rest keep their saved verdicts.
 *
 * When it must pass: before the extension is enabled by default, and after any
 * change to the writer's instruction, the Handoff's sections or the Pruning
 * rules. Its bars hold only once the judge has been checked against about 30
 * hand-labelled cuts (≥85% agreement); the JSON beside each report is what to
 * label from.
 *
 * The corpus is named in `replay-manifest.json` beside this file, which is
 * gitignored, as is `replay-reports/`, where every report goes: transcripts
 * never leave the machine except as the model calls themselves send them.
 * The manifest:
 *
 *   { "sessions": [ "~/.pi/agent/sessions/<project>/<session>.jsonl", { "path": "…", "name": "the refactor" } ] }
 *
 * Each session is read without being touched, and replayed on the model it
 * recorded, with the credentials pi has for it; a session whose model can't be
 * reached is skipped, and so is one too short for a chain. The judge must be
 * reachable, or nothing runs. What each cut does is in `replay/replay-session.ts`,
 * how cuts are placed in `replay/replay-corpus.ts`, the continuation in
 * `replay/replay-continuation.ts`, the judge in `replay/replay-judge.ts` and the bars in
 * `replay/replay-report.ts` — every one of them tested offline, against a scripted
 * model, on sessions written for the purpose.
 *
 * Settings are pi's global `settings.json`, as the extension would read them,
 * except that forced compaction is on whatever `compaction.enabled` says: the
 * replay is of the Handoff, not of that switch.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { kindsFor, parseManifest, readRecording } from "./replay/replay-corpus.ts";
import type { Side } from "./replay/replay-judge.ts";
import { Meter, renderReport, score } from "./replay/replay-report.ts";
import { guardCall, rejudgeSession, type SessionResult, replaySession } from "./replay/replay-session.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = join(HERE, "replay-manifest.json");
const REPORTS = join(HERE, "replay-reports");

/** A full run's corpus: ten sessions, cut three times each, as the pass bar is set for. */
const FULL_SESSIONS = 10;
const QUICK_SESSIONS = 1;
/** The judge #48 checked against hand labels and #50 passed with; a re-run must use the same one. */
const DEFAULT_JUDGE = "openai-codex/gpt-6.1-sol";

function flag(name: string): string | undefined {
	const at = process.argv.indexOf(name);
	return at === -1 ? undefined : process.argv[at + 1];
}

/** Every value given for a flag that can repeat. */
function flags(name: string): string[] {
	return process.argv.flatMap((arg, i) => (arg === name && process.argv[i + 1] !== undefined ? [process.argv[i + 1]!] : []));
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

async function main(): Promise<number> {
	const quick = process.argv.includes("--quick");
	const manifestPath = flag("--manifest") ?? DEFAULT_MANIFEST;
	if (!existsSync(manifestPath)) {
		fail(
			[
				`No manifest at ${manifestPath}.`,
				"Name the recorded sessions to replay in it (it is gitignored; never commit transcripts):",
				'  { "sessions": [ "~/.pi/agent/sessions/<project>/<session>.jsonl", { "path": "…", "name": "the refactor" } ] }',
			].join("\n"),
		);
	}
	const manifest = parseManifest(readFileSync(manifestPath, "utf8"), { at: manifestPath, home: homedir(), exists: existsSync });
	if (manifest.problems.length) fail([`The manifest at ${manifestPath} can't be used:`, ...manifest.problems.map((p) => `  - ${p}`)].join("\n"));

	const agentDir = getAgentDir();
	const registry = new ModelRegistry(await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") }));
	const reachable = (provider: string, id: string) => {
		const model = registry.find(provider, id);
		return model && registry.hasConfiguredAuth(model) ? model : undefined;
	};
	const rejudging = flag("--rejudge");
	const saved = rejudging ? (JSON.parse(readFileSync(rejudging, "utf8")) as { judge?: string; sessions: SessionResult[] }) : undefined;
	const judgeKey = flag("--judge") ?? saved?.judge ?? DEFAULT_JUDGE;
	const [judgeProvider, ...judgeId] = judgeKey.split("/");
	const judgeModel = reachable(judgeProvider ?? "", judgeId.join("/"));
	if (!judgeModel) fail(`The judge, ${judgeKey}, can't be reached: pi knows no such model, or has no credentials for it. Log in with pi first.`);

	const settingsPath = join(agentDir, "settings.json");
	const settings = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>) : {};

	const meter = new Meter();
	// No call can hang the run: a stalled or endless one fails its cut (see `guardCall`).
	const call = guardCall(registry.streamSimple.bind(registry));
	const prunedDir = mkdtempSync(join(tmpdir(), "pi-replay-pruned-"));
	const startedAt = new Date();
	const picked = manifest.sessions.slice(0, quick ? QUICK_SESSIONS : FULL_SESSIONS);
	if (!quick && manifest.sessions.length < FULL_SESSIONS) console.log(`The manifest names ${manifest.sessions.length} sessions; a full run is set for ${FULL_SESSIONS}.`);
	if (manifest.sessions.length > picked.length) console.log(`Replaying the first ${picked.length} of ${manifest.sessions.length} sessions.`);

	let judged = 0;
	// Our Handoff is "A" on every other cut, so that the judge can't learn which is which.
	const oursSide = (): Side => (judged++ % 2 === 0 ? "A" : "B");
	const sessions: SessionResult[] = [];
	const mode = saved ? "rejudge" : quick ? "quick" : "full";
	const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
	const reportPath = join(REPORTS, `${stamp}-${mode}.md`);
	/** Write the report on what is done so far, over the last one: a run stopped short keeps what it paid for. */
	const write = (unfinished?: string): string => {
		const report = renderReport({ sessions, scored: score(sessions), meter, mode, startedAt, judge: judgeKey, unfinished });
		mkdirSync(REPORTS, { recursive: true });
		writeFileSync(reportPath, report);
		const of = rejudging ? { rejudged: rejudging } : {};
		writeFileSync(reportPath.replace(/\.md$/, ".json"), JSON.stringify({ startedAt, mode, judge: judgeKey, ...of, ...(unfinished ? { unfinished } : {}), sessions, spend: meter.rows() }, null, 2));
		return report;
	};
	const stopped = () => `stopped after ${sessions.length} of ${picked.length} sessions`;
	process.once("SIGINT", () => {
		write(`${stopped()} (interrupted)`);
		console.log(`\nInterrupted. Report so far (spend counted for finished calls only): ${reportPath}`);
		rmSync(prunedDir, { recursive: true, force: true });
		process.exit(130);
	});
	if (saved) {
		const only = flags("--only");
		const pick = (name: string) => (cut: { depth: number }) => only.length === 0 || only.includes(`${name}#${cut.depth}`);
		for (const result of saved.sessions) {
			// A session none of `--only` picks is reported as saved, so the bars still score the whole run.
			if (only.length > 0 && !only.some((at) => at.startsWith(`${result.name}#`))) {
				sessions.push(result);
				continue;
			}
			const at = manifest.sessions.findIndex((entry) => entry.name === result.name);
			const recording = at === -1 ? undefined : readRecording(readFileSync(manifest.sessions[at]!.path, "utf8"), "judging");
			if (!recording || "problem" in recording) {
				sessions.push({ name: result.name, skipped: recording ? recording.problem : "the manifest doesn't name it", cuts: [] });
				continue;
			}
			console.log(`${result.name}…`);
			const deps = { settings, kinds: kindsFor(at), findModel: reachable, judge: { model: judgeModel, stream: meter.metered("judge", call) }, oursSide };
			sessions.push(await rejudgeSession(recording, result, deps, pick(result.name)));
			await meter.settled();
			console.log(`  spent so far: $${meter.total().toFixed(2)}`);
		}
		const report = write();
		console.log(`\n${report}`);
		console.log(`Report: ${reportPath}`);
		rmSync(prunedDir, { recursive: true, force: true });
		return 0;
	}
	try {
		for (const [i, entry] of picked.entries()) {
			console.log(`[${i + 1}/${picked.length}] ${entry.name}…`);
			const recording = readRecording(readFileSync(entry.path, "utf8"));
			if ("problem" in recording) {
				sessions.push({ name: entry.name, skipped: recording.problem, cuts: [] });
				console.log(`  skipped: ${recording.problem}`);
				continue;
			}
			const result = await replaySession(recording, entry.name, {
				settings,
				kinds: kindsFor(i),
				findModel: reachable,
				stream: (spending) => meter.metered(spending, call),
				judge: { model: judgeModel, stream: meter.metered("judge", call) },
				oursSide,
				prunedDir,
			});
			sessions.push(result);
			await meter.settled();
			if (result.skipped) console.log(`  skipped: ${result.skipped}`);
			for (const cut of result.cuts) {
				const declined = cut.declinedWith ? ` (steered to Self-compact, the agent ${cut.declinedWith})` : "";
				console.log(`  cut ${cut.depth} (${cut.kind}${declined}): ${cut.error ?? (cut.verdict ? "judged" : `not judged: ${cut.unjudged}`)}`);
			}
			console.log(`  spent so far: $${meter.total().toFixed(2)}`);
			if (sessions.length < picked.length) write(stopped());
		}
	} finally {
		rmSync(prunedDir, { recursive: true, force: true });
	}

	await meter.settled();
	const report = write();
	console.log(`\n${report}`);
	console.log(`Report: ${reportPath}`);
	return score(sessions).pass ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(error) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)),
);
