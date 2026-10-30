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
 *   npm run live:compaction -- --judge <provider>/<model>   # default anthropic/claude-fable-5
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
 * reachable, or nothing runs. What each cut does is in `replay-session.ts`,
 * how cuts are placed in `replay-corpus.ts`, the continuation in
 * `replay-continuation.ts`, the judge in `replay-judge.ts` and the bars in
 * `replay-report.ts` — every one of them tested offline, against a scripted
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
import { kindsFor, parseManifest, readRecording } from "./replay-corpus.ts";
import type { Side } from "./replay-judge.ts";
import { Meter, renderReport, score } from "./replay-report.ts";
import { type SessionResult, replaySession } from "./replay-session.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = join(HERE, "replay-manifest.json");
const REPORTS = join(HERE, "replay-reports");

/** A full run's corpus: ten sessions, cut three times each, as the pass bar is set for. */
const FULL_SESSIONS = 10;
const QUICK_SESSIONS = 1;
const DEFAULT_JUDGE = "anthropic/claude-fable-5";

function flag(name: string): string | undefined {
	const at = process.argv.indexOf(name);
	return at === -1 ? undefined : process.argv[at + 1];
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
	const judgeKey = flag("--judge") ?? DEFAULT_JUDGE;
	const [judgeProvider, ...judgeId] = judgeKey.split("/");
	const judgeModel = reachable(judgeProvider ?? "", judgeId.join("/"));
	if (!judgeModel) fail(`The judge, ${judgeKey}, can't be reached: pi knows no such model, or has no credentials for it. Log in with pi first.`);

	const settingsPath = join(agentDir, "settings.json");
	const settings = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>) : {};

	const meter = new Meter();
	const call = registry.streamSimple.bind(registry);
	const prunedDir = mkdtempSync(join(tmpdir(), "pi-replay-pruned-"));
	const startedAt = new Date();
	const picked = manifest.sessions.slice(0, quick ? QUICK_SESSIONS : FULL_SESSIONS);
	if (!quick && manifest.sessions.length < FULL_SESSIONS) console.log(`The manifest names ${manifest.sessions.length} sessions; a full run is set for ${FULL_SESSIONS}.`);
	if (manifest.sessions.length > picked.length) console.log(`Replaying the first ${picked.length} of ${manifest.sessions.length} sessions.`);

	let judged = 0;
	const sessions: SessionResult[] = [];
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
				// Our Handoff is "A" on every other cut, so that the judge can't learn which is which.
				oursSide: (): Side => (judged++ % 2 === 0 ? "A" : "B"),
				prunedDir,
			});
			sessions.push(result);
			await meter.settled();
			if (result.skipped) console.log(`  skipped: ${result.skipped}`);
			for (const cut of result.cuts) console.log(`  cut ${cut.depth} (${cut.kind}): ${cut.error ?? (cut.verdict ? "judged" : `not judged: ${cut.unjudged}`)}`);
			console.log(`  spent so far: $${meter.total().toFixed(2)}`);
		}
	} finally {
		rmSync(prunedDir, { recursive: true, force: true });
	}

	await meter.settled();
	const scored = score(sessions);
	const report = renderReport({ sessions, scored, meter, mode: quick ? "quick" : "full", startedAt, judge: judgeKey });
	mkdirSync(REPORTS, { recursive: true });
	const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
	const reportPath = join(REPORTS, `${stamp}-${quick ? "quick" : "full"}.md`);
	writeFileSync(reportPath, report);
	writeFileSync(reportPath.replace(/\.md$/, ".json"), JSON.stringify({ startedAt, mode: quick ? "quick" : "full", judge: judgeKey, sessions, spend: meter.rows() }, null, 2));
	console.log(`\n${report}`);
	console.log(`Report: ${reportPath}`);
	return scored.pass ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(error) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)),
);
