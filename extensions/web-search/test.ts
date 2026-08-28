/**
 * Manual test runner: exercises the Brave search pipeline against the real
 * service, and captures its responses as the offline suite's fixtures.
 *
 * Not part of the extension load path: `package.json` lists only `index.ts`
 * under `pi.extensions`, and `npm test` globs the `tests` directory, which this
 * file sits beside rather than in. So pi never loads it during a session and
 * the offline suite never runs it — it is the one file in this extension that
 * needs the network and a key.
 *
 * Run with:
 *
 *   npm run live:web-search              # exercise real queries and error cases
 *   npm run live:web-search -- --capture # …and overwrite tests/fixtures/*.json
 *                                        #   with the responses just received
 *
 * A key is required to start: the five error cases need only a *syntactically*
 * present one, so `BRAVE_API_KEY=junk npm run live:web-search` exercises them
 * (a rejected key, a timeout, and three values rejected before a request is
 * spent) without a subscription. The seven query cases need a real key.
 *
 * A case can also come back as `note` rather than ok or FAIL. Two of the things
 * this tool asks Brave for — `extra_snippets` and the `discussions` block — are
 * sold rather than guaranteed, and on a plan that serves neither their absence
 * is the expected outcome, not a regression. Those notes are replayed as a
 * block at the end: it is the runner's answer to "what does this key buy".
 *
 * `--capture` is how the hand-written fixtures get replaced with real ones: it
 * writes the exact JSON Brave answered, pretty-printed, to the files the
 * offline suite reads. Expect to re-pin the assertions that name a specific
 * title or host afterwards — the fixtures change, and the tests that quote them
 * are meant to. A fixture that exists to carry a shape the response does not
 * have is skipped rather than overwritten, so a capture on a thinner plan
 * cannot quietly empty the suite.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import {
	type BraveResponse,
	type SearchParams,
	WebSearchError,
	normalizeCount,
	normalizeFreshness,
	search,
} from "./brave.ts";
import { formatResults } from "./format.ts";
import { resolveApiKey } from "./key.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(EXTENSION_DIR, "tests", "fixtures");

/** Every entry Brave returned, across both blocks. */
function hits(response: BraveResponse) {
	return [...(response.web?.results ?? []), ...(response.discussions?.results ?? [])];
}

function hostOf(url = ""): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/**
 * What a case concluded: a string is a failure, a `note` is a fact about the
 * plan this key is on rather than something wrong with the code.
 *
 * The distinction has to exist because two of the things this tool asks Brave
 * for — `extra_snippets` and the `discussions` block — are sold, not
 * guaranteed. On a plan that does not serve them their absence is the correct
 * outcome and the renderer is meant to degrade, so a runner that scored it as a
 * failure would be permanently red and stop being read at all.
 */
type Verdict = string | { note: string } | undefined;

interface Case {
	name: string;
	query: string;
	params?: SearchParams;
	/** An error string when the case fails, a `note` for a plan fact, nothing when it passes. */
	check: (response: BraveResponse, markdown: string) => Verdict;
}

const cases: Case[] = [
	{
		name: "ordinary query",
		query: "go generics",
		check: (response, markdown) => {
			const web = response.web?.results ?? [];
			if (web.length < 3) return `expected several web results, got ${web.length}`;
			const unusable = web.find((result) => !result.url || !result.title);
			if (unusable) return `a result arrived without a url or title: ${JSON.stringify(unusable).slice(0, 120)}`;
			return markdown.includes("1. ") ? undefined : "the rendered list has no numbered entries";
		},
	},
	{
		name: "extra_snippets, the triage signal the design is built on",
		query: "rust async fn in traits",
		check: (response) => {
			const withSnippets = hits(response).filter((result) => (result.extra_snippets?.length ?? 0) > 0);
			// Historically a paid-plan field. Its absence is not a bug — the
			// renderer degrades to description-only — but it is the single fact
			// this runner exists to establish, so say which way it went.
			if (withSnippets.length === 0) {
				return { note: "no result carried extra_snippets: this plan does not serve them, and triage is description-only" };
			}
			const overlong = withSnippets.find((result) => (result.extra_snippets?.length ?? 0) > 5);
			return overlong ? "a result carried more than the documented 5 extra_snippets" : undefined;
		},
	},
	{
		name: "discussions block, requested alongside web",
		query: "rust async fn in traits",
		check: (response) => {
			// `result_filter` is honoured whether or not the plan sells
			// discussions, and this is how to see it: the blocks it excludes must
			// not come back. Sent without the filter this same query returns a
			// `videos` block, so their absence here is the filter working rather
			// than the query having nothing else to offer.
			const blocks = response as Record<string, unknown>;
			const excluded = ["videos", "news", "faq", "infobox"].filter((name) => blocks[name] !== undefined);
			if (excluded.length > 0) {
				return `result_filter is not being honoured: ${excluded.join(", ")} came back despite web,discussions`;
			}

			// Sold, not guaranteed. An absent block on a plan that does not serve
			// one is expected; a malformed block never is.
			if (response.discussions === undefined) {
				return { note: "no discussions block at all: this plan does not serve one, so every list is web-only" };
			}
			const discussions = response.discussions.results ?? [];
			return discussions.some((result) => !result.url) ? "a discussion arrived without a url" : undefined;
		},
	},
	{
		name: "site: operator, which the prompt guidelines tell the model to prefer",
		query: "site:go.dev generics",
		check: (response) => {
			const web = response.web?.results ?? [];
			if (web.length === 0) return "the operator narrowed the search to nothing";
			const stray = web.find((result) => !hostOf(result.url).endsWith("go.dev"));
			return stray ? `site: leaked a foreign host: ${hostOf(stray.url)}` : undefined;
		},
	},
	{
		name: "recency filter",
		query: "typescript release notes",
		params: { freshness: "pm" },
		check: (response, markdown) => {
			if (hits(response).length === 0) return "a month of results is empty, which is suspicious for this query";
			return markdown.includes("freshness=pm") ? undefined : "the header does not say the list was narrowed";
		},
	},
	{
		name: "count bounds the web block, and discussions are added to it",
		query: "postgres jsonb index",
		params: { count: 3 },
		check: (response) => {
			const web = response.web?.results ?? [];
			if (web.length > 3) return `count: 3 returned ${web.length} web results`;
			// The note this tool's schema description now carries. Printed by the
			// stats line either way; only a broken web bound fails the case.
			return undefined;
		},
	},
	{
		name: "a query with no results is an answer, not an error",
		// Deliberately unsearchable: an improbable string of real words, so this
		// stays a zero-result search rather than a typo Brave helpfully corrects.
		query: '"zylphagoric" "quembleton" internals',
		check: (response, markdown) => {
			const found = hits(response).length;
			if (found > 0) return `expected nothing, got ${found} — pick a stranger query`;
			return /no results/i.test(markdown) ? undefined : `expected a no-results message, got: ${markdown.slice(0, 120)}`;
		},
	},
];

interface ErrorCase {
	name: string;
	expect: RegExp;
	run: (key: string) => Promise<unknown>;
}

const errorCases: ErrorCase[] = [
	{
		name: "rejected key",
		// Observed, not assumed: Brave answers a bad subscription token with 422
		// and a `SUBSCRIPTION_TOKEN_INVALID` body, not with 401 or 403. The
		// mapping in `brave.ts` therefore calls it "rejected a search parameter",
		// which is where a reader has to fall back on the body text.
		expect: /SUBSCRIPTION_TOKEN_INVALID|subscription token/i,
		run: () => search("go generics", "not-a-real-brave-key"),
	},
	{
		name: "timeout",
		expect: /timed out|abort|timeout/i,
		// One millisecond of budget: the request is cut off before the service can
		// answer, which is the shape of a real network stall.
		run: (key) => search("go generics", key, {}, undefined, { timeoutMs: 1 }),
	},
	{
		name: "empty query",
		expect: /No query provided/,
		run: (key) => search("   ", key),
	},
	{
		name: "count out of range",
		expect: /between 1 and 20/,
		run: async () => normalizeCount(50),
	},
	{
		name: "malformed freshness",
		expect: /pd|pw|pm|py/,
		run: async () => normalizeFreshness("last tuesday"),
	},
];

/** A fixture the offline suite reads, and the search that would refresh it. */
interface CaptureSpec {
	file: string;
	query: string;
	params?: SearchParams;
	/**
	 * The shape this fixture exists to carry. A response that lacks it is not
	 * written: overwriting would leave the offline suite green while covering
	 * nothing, which is worse than a hand-written stand-in that still covers it.
	 */
	requires?: { name: string; present: (response: BraveResponse) => boolean };
}

const captures: CaptureSpec[] = [
	{ file: "brave-web-search.json", query: "go generics", params: { count: 5 } },
	{
		file: "brave-web-search-snippets.json",
		query: "rust async fn in traits",
		params: { count: 3 },
		requires: { name: "extra_snippets", present: (r) => hits(r).some((h) => (h.extra_snippets?.length ?? 0) > 0) },
	},
	{
		file: "brave-web-discussions.json",
		query: "rust async fn in traits",
		params: { count: 5 },
		requires: { name: "discussions block", present: (r) => (r.discussions?.results?.length ?? 0) > 0 },
	},
];

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

let key: string;
try {
	key = resolveApiKey();
} catch (error) {
	console.error(messageOf(error));
	process.exit(1);
}

let failures = 0;
/** Plan facts observed along the way, replayed as a block at the end. */
const notes: string[] = [];

console.log("--- live queries ---");

for (const testCase of cases) {
	try {
		const startedAt = Date.now();
		const params: SearchParams = {
			count: normalizeCount(testCase.params?.count),
			freshness: normalizeFreshness(testCase.params?.freshness),
		};
		const response = await search(testCase.query, key, params);
		const elapsed = Date.now() - startedAt;

		// Rendered under the same budget `index.ts` applies, so the size this
		// prints is the size a session would have paid.
		const { text, shown, total } = formatResults(testCase.query, response, {
			maxBytes: DEFAULT_MAX_BYTES,
			freshness: params.freshness,
		});
		const problem = testCase.check(response, text);

		const web = response.web?.results?.length ?? 0;
		const discussions = response.discussions?.results?.length ?? 0;
		const snippets = hits(response).filter((result) => (result.extra_snippets?.length ?? 0) > 0).length;
		// Counted in bytes rather than in characters, because the budget is.
		const size = Buffer.byteLength(text, "utf8");
		const stats =
			`${web} web + ${discussions} discussions, ${snippets} with extra_snippets, ` +
			`${shown}/${total} rendered, ${size}B (~${Math.round(size / 4)} tok), ${elapsed}ms`;

		if (typeof problem === "string") {
			failures++;
			console.log(`FAIL  ${testCase.name}\n      ${problem}\n      ${stats}`);
		} else if (problem) {
			notes.push(problem.note);
			console.log(`note  ${testCase.name}\n      ${problem.note}\n      ${stats}`);
		} else {
			console.log(`ok    ${testCase.name}\n      ${stats}`);
		}
	} catch (error) {
		failures++;
		console.log(`FAIL  ${testCase.name}\n      threw: ${messageOf(error)}`);
	}
}

console.log("\n--- error cases ---");
for (const testCase of errorCases) {
	try {
		await testCase.run(key);
		failures++;
		console.log(`FAIL  ${testCase.name}\n      expected a throw, got success`);
	} catch (error) {
		const message = messageOf(error);
		if (!(error instanceof WebSearchError)) {
			failures++;
			console.log(`FAIL  ${testCase.name}\n      expected a WebSearchError, got ${error?.constructor?.name}: ${message}`);
		} else if (testCase.expect.test(message)) {
			console.log(`ok    ${testCase.name}\n      ${message.slice(0, 120)}`);
		} else {
			failures++;
			console.log(`FAIL  ${testCase.name}\n      expected ${testCase.expect}, got: ${message.slice(0, 150)}`);
		}
	}
}

if (process.argv.includes("--capture")) {
	console.log("\n--- capturing fixtures ---");
	for (const spec of captures) {
		try {
			const response = await search(spec.query, key, {
				count: normalizeCount(spec.params?.count),
				freshness: normalizeFreshness(spec.params?.freshness),
			});

			// Checked before the write, not warned about after it. A fixture that
			// no longer carries its shape is a silently empty test.
			if (spec.requires && !spec.requires.present(response)) {
				console.log(
					`skip  ${spec.file}\n      nothing came back carrying ${spec.requires.name}, which is the whole reason\n` +
						"      this fixture exists — keeping the hand-written one rather than emptying the suite",
				);
				continue;
			}

			const path = join(FIXTURE_DIR, spec.file);
			// Pretty-printed and newline-terminated, so a fixture diff reads as one.
			writeFileSync(path, `${JSON.stringify(response, null, 2)}\n`, "utf8");
			const web = response.web?.results?.length ?? 0;
			const discussions = response.discussions?.results?.length ?? 0;
			console.log(`wrote ${spec.file}\n      "${spec.query}" → ${web} web + ${discussions} discussions`);
		} catch (error) {
			failures++;
			console.log(`FAIL  capture ${spec.file}\n      ${messageOf(error)}`);
		}
	}
	console.log(
		"\nCaptured responses replace the hand-written fixtures. Run `npm test` next:\n" +
			"the assertions that quote a specific title, host or snippet are pinned to the\n" +
			"old fixtures and are meant to be re-pinned to the new ones.",
	);
}

if (notes.length > 0) {
	console.log("\n--- what this key's plan serves ---");
	for (const note of notes) console.log(`  · ${note}`);
}

console.log(failures === 0 ? "\nAll cases passed." : `\n${failures} case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
