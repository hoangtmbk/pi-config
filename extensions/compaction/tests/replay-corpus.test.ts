/**
 * The replay runner's corpus: the local manifest that names the recorded
 * sessions, reading one recording, and where in it the cuts go.
 *
 * Everything here is offline: the manifests are strings and the recordings
 * are small session files written for the purpose (`recordings.ts`), never
 * real transcripts.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Boundary, boundariesOf, type CutKind, kindsFor, parseManifest, planCuts, readRecording } from "../replay/replay-corpus.ts";
import { MODEL } from "./fake-pi.ts";
import { padded, recorder } from "./recordings.ts";

const HOME = "/home/me";
const AT = "/repo/extensions/compaction/replay-manifest.json";

/** A manifest read where every file it could name exists, unless `missing` says otherwise. */
function manifest(value: unknown, missing: string[] = []) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return parseManifest(text, { at: AT, home: HOME, exists: (path) => !missing.includes(path) });
}

describe("the manifest", () => {
	it("names each session by a path, absolute, from home or beside the manifest, with a name to report it by", () => {
		const read = manifest({
			sessions: ["/sessions/a.jsonl", { path: "~/.pi/agent/sessions/b.jsonl", name: "the refactor" }, { path: "local/c.jsonl" }],
		});
		assert.deepEqual(read.problems, []);
		assert.deepEqual(read.sessions, [
			{ path: "/sessions/a.jsonl", name: "a" },
			{ path: "/home/me/.pi/agent/sessions/b.jsonl", name: "the refactor" },
			{ path: "/repo/extensions/compaction/local/c.jsonl", name: "c" },
		]);
	});

	it("says what is wrong with it, all at once, rather than running on half of it", () => {
		const read = manifest(
			{ sessions: ["/s/a.jsonl", 7, { name: "no path" }, "/s/gone.jsonl", "/s/a.jsonl", { path: "/s/x/a.jsonl" }] },
			["/s/gone.jsonl"],
		);
		assert.deepEqual(read.problems, [
			"sessions[1]: expected a path, or { \"path\": …, \"name\": … }",
			"sessions[2]: expected a path, or { \"path\": …, \"name\": … }",
			"sessions[3]: /s/gone.jsonl does not exist",
			"sessions[4]: /s/a.jsonl is named twice",
			"sessions[5]: the name \"a\" is already taken; give it a \"name\" of its own",
		]);
	});

	it("is refused when it isn't JSON, has no sessions list, or names none", () => {
		assert.match(manifest("{ sessions: ").problems[0]!, /not valid JSON/);
		assert.deepEqual(manifest({ session: [] }).problems, ['expected an object with a "sessions" list']);
		assert.deepEqual(manifest({ sessions: [] }).problems, ["it names no sessions"]);
	});
});

describe("a recording", () => {
	it("is read into its active branch, as recorded, without a file of its own", () => {
		const text = recorder("/repo").system().user("Add retries.").turn([{ name: "read", arguments: { path: "src/a.ts" } }]).say("Done.").text();
		const read = readRecording(text);
		assert.ok("branch" in read, "problem" in read ? read.problem : "");
		assert.equal(read.header.cwd, "/repo");
		assert.deepEqual(
			read.branch.map((entry) => (entry.type === "message" ? entry.message.role : entry.type)),
			["system", "user", "assistant", "toolResult", "assistant"],
		);
	});

	it("is refused when it isn't a pi session, or has no system message to replay its tools from", () => {
		assert.deepEqual(readRecording("not a session"), { problem: "it is not a pi session file" });
		const old = recorder().user("Add retries.").say("Done.").text();
		assert.deepEqual(readRecording(old), {
			problem: "it records no system message, so its prompt and tools can't be replayed (recorded before pi kept them in the transcript)",
		});
	});
});

describe("planning a chain of cuts", () => {
	/** A boundary at `tokens`, with `users` user turns recorded after it. */
	function at(kind: Boundary["kind"], tokens: number, users = 5): Boundary {
		return { kind, at: tokens, end: tokens, tokens, userTurnsAfter: users, model: { provider: "anthropic", id: "fable-5" } };
	}
	const KINDS: CutKind[] = ["self", "forced", "before-user"];
	const plan = (boundaries: Boundary[], kinds = KINDS, gap = 1_000) =>
		planCuts(boundaries, { kinds, gap }).map(({ boundary, kind, requested }) => ({ tokens: boundary.tokens, kind, requested }));

	it("spreads the cuts evenly over the session, each the kind asked for", () => {
		const boundaries = [2_000, 2_500, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000].flatMap((tokens) => [at("mid-run", tokens), at("before-user", tokens + 100)]);
		assert.deepEqual(plan(boundaries), [
			{ tokens: 2_000, kind: "self", requested: "self" },
			{ tokens: 5_000, kind: "forced", requested: "forced" },
			{ tokens: 8_100, kind: "before-user", requested: "before-user" },
		]);
	});

	it("leaves a removed span of at least the gap before each cut, and three user turns after it", () => {
		const boundaries = [at("mid-run", 1_500), at("mid-run", 2_200), at("mid-run", 2_900), at("mid-run", 3_300), at("mid-run", 4_400), at("mid-run", 9_000, 2)];
		assert.deepEqual(plan(boundaries, ["forced", "forced", "forced"]), [
			{ tokens: 2_200, kind: "forced", requested: "forced" },
			{ tokens: 3_300, kind: "forced", requested: "forced" },
			{ tokens: 4_400, kind: "forced", requested: "forced" },
		]);
	});

	it("takes a boundary of the other kind when none of the kind asked for fits, and says what was asked", () => {
		const boundaries = [at("mid-run", 2_000), at("mid-run", 5_000), at("mid-run", 8_000)];
		assert.deepEqual(plan(boundaries), [
			{ tokens: 2_000, kind: "self", requested: "self" },
			{ tokens: 5_000, kind: "forced", requested: "forced" },
			{ tokens: 8_000, kind: "forced", requested: "before-user" },
		]);
		assert.deepEqual(plan([at("before-user", 2_000), at("before-user", 5_000)], ["self", "forced"]), [
			{ tokens: 2_000, kind: "before-user", requested: "self" },
			{ tokens: 5_000, kind: "before-user", requested: "forced" },
		]);
	});

	it("chains two cuts where three don't fit, and none where two don't", () => {
		assert.deepEqual(plan([at("mid-run", 2_000), at("mid-run", 3_500)]), [
			{ tokens: 2_000, kind: "self", requested: "self" },
			{ tokens: 3_500, kind: "forced", requested: "forced" },
		]);
		assert.deepEqual(plan([at("mid-run", 2_000), at("mid-run", 2_500)]), []);
		assert.deepEqual(plan([at("mid-run", 2_000)]), []);
	});
});

describe("the kinds each session is cut with", () => {
	it("rotate, so that over the run every depth sees each kind, and mid-run cuts split evenly between Self-compaction and forced", () => {
		const sessions = [0, 1, 2].map((s) => kindsFor(s));
		assert.deepEqual(sessions, [
			["self", "forced", "before-user"],
			["forced", "before-user", "self"],
			["before-user", "self", "forced"],
		]);
	});
});

describe("the live runner", () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
	const runner = "extensions/compaction/test.ts";

	it("is reached by `npm run live:compaction`, and by nothing `npm test` runs", () => {
		const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
		assert.ok(existsSync(join(root, runner)), `expected the manual runner at ${runner}`);
		assert.ok((scripts["live:compaction"] ?? "").includes(runner), `live:compaction runs: ${scripts["live:compaction"] ?? "nothing"}`);
		const globs = scripts.test!.split(/\s+/).filter((argument) => argument.includes("*"));
		const suite = globs.flatMap((glob) => globSync(glob, { cwd: root }));
		assert.ok(suite.length > 0, `the test script's globs (${globs.join(", ")}) match nothing at all`);
		assert.ok(!suite.includes(runner), `${runner} is in what \`npm test\` runs`);
	});

	it("keeps the manifest and the reports out of git, so no transcript reaches the public repo", () => {
		for (const path of ["extensions/compaction/replay-manifest.json", "extensions/compaction/replay-reports/2026-10-31.md"]) {
			assert.doesNotThrow(() => execFileSync("git", ["check-ignore", "-q", path], { cwd: root }), `${path} is not gitignored`);
		}
	});
});

/** A recording, read; a test fails on one that can't be. */
function read(text: string) {
	const recording = readRecording(text);
	if ("problem" in recording) throw new Error(recording.problem);
	return recording;
}

const READ = { name: "read", arguments: { path: "src/a.ts" } };

describe("the turn boundaries a recording offers", () => {
	it("are mid-run after a turn the run went on from, and before a user message after the turn that ended a run", () => {
		const recording = read(
			recorder()
				.system()
				.user("Add retries.")
				.turn([READ]) // 2, 3: the run goes on
				.turn([READ, READ]) // 4, 5, 6: the run goes on
				.say("Done.") // 7: the run ends, and the user speaks next
				.user("Now the tests.")
				.say("Which ones?") // 9
				.user("The unit tests.")
				.turn([READ]) // 11, 12
				.say("Done.") // 13: the session's last word, with nobody after it
				.text(),
		);
		const boundaries = boundariesOf(recording);
		assert.deepEqual(
			boundaries.map(({ kind, at, end, userTurnsAfter }) => ({ kind, at, end, userTurnsAfter })),
			[
				{ kind: "mid-run", at: 2, end: 3, userTurnsAfter: 2 },
				{ kind: "mid-run", at: 4, end: 6, userTurnsAfter: 2 },
				{ kind: "before-user", at: 7, end: 7, userTurnsAfter: 2 },
				{ kind: "before-user", at: 9, end: 9, userTurnsAfter: 1 },
				{ kind: "mid-run", at: 11, end: 12, userTurnsAfter: 0 },
			],
		);
		assert.deepEqual(boundaries[0]!.model, { provider: MODEL.provider, id: MODEL.id });
	});

	it("count the context's tokens as pi estimates them, from the newest recorded compaction's kept tail on, but for the system prompt", () => {
		const recording = read(
			recorder()
				.system(padded("You are a coding agent.", 10_000))
				.user("Old work.", 5_000)
				.say("Done.")
				.user("Add retries.", 1_000) // 3: the compaction keeps this on
				.compaction("Summary of the old work.", 1)
				.turn([READ], { tokens: 2_000 }) // 5
				.turn([READ]) // 7
				.say("Done.")
				.user("Thanks.")
				.text(),
		);
		const [first, second] = boundariesOf(recording);
		assert.equal(first!.at, 5, "nothing before the compaction is a boundary");
		assert.ok(first!.tokens >= 3_000 && first!.tokens < 3_100, `kept tail and the turn, but not the old work or the system prompt: ${first!.tokens}`);
		assert.ok(second!.tokens > first!.tokens && second!.tokens < first!.tokens + 100, `${second!.tokens}`);
	});

	it("leave out a turn cut short, failed, or with a tool call that has no result", () => {
		const unanswered = read(recorder().system().user("Add retries.").turn([READ]).say("Done.").user("Thanks.").text());
		unanswered.branch.splice(3, 1); // the read's result never landed
		assert.deepEqual(
			boundariesOf(unanswered).map(({ kind, at }) => ({ kind, at })),
			[{ kind: "before-user", at: 3 }],
		);
		for (const stopReason of ["aborted", "error"] as const) {
			const cut = read(recorder().system().user("Add retries.").say("Halfway").user("Stop.").text());
			const turn = cut.branch[2]!;
			if (turn.type === "message" && turn.message.role === "assistant") turn.message.stopReason = stopReason;
			assert.deepEqual(boundariesOf(cut), [], stopReason);
		}
	});
});
