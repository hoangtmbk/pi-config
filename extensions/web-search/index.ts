/**
 * web_search — turn a query into ranked results with enough text to decide what
 * is worth reading.
 *
 * Search only: reading is `web_fetch`'s job. The model is a better relevance
 * judge than any `top_n` heuristic, and keeping the two tools apart means
 * `web_fetch` still works on a machine with no API key.
 */

import { DEFAULT_MAX_BYTES, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	DEFAULT_COUNT,
	MAX_COUNT,
	MIN_COUNT,
	describeFreshness,
	normalizeCount,
	normalizeFreshness,
	search,
} from "./brave.ts";
import { type KindCount, MAX_EXCERPTS, countPhrase, formatResults, hitLines } from "./format.ts";
import { resolveApiKey } from "./key.ts";

const WebSearchParams = Type.Object({
	query: Type.String({
		description:
			'Search terms. Brave\'s operators work inside the query: site:example.com, -excluded, "exact phrase", filetype:pdf.',
	}),
	// `Type.Integer` rather than a number: half a result does not exist, and the
	// bounds are declared so the model reads them off the schema.
	count: Type.Optional(
		Type.Integer({
			minimum: MIN_COUNT,
			maximum: MAX_COUNT,
			description: `How many results to return, ${MIN_COUNT}–${MAX_COUNT}. Defaults to ${DEFAULT_COUNT}.`,
		}),
	),
	// A plain string rather than an enum: the date range cannot be spelled as
	// one, and the shape is validated in code, which can say what went wrong.
	freshness: Type.Optional(
		Type.String({
			description:
				"Only return results from the last day (pd), week (pw), month (pm) or year (py), " +
				"or from an explicit range YYYY-MM-DDtoYYYY-MM-DD (for example 2026-01-01to2026-03-31). " +
				"Set this only when recency matters.",
		}),
	),
});

/**
 * What the transcript renderer needs, and the model does not.
 *
 * Metadata only — never the rendered markdown, which is already in `content`,
 * and never the query, which a renderer reads off the call's own arguments.
 * Everything here is a number the markdown either states in prose or does not
 * state at all: how big the search was, how much of it survived the budget, and
 * how long it took. The model reads the header; the reader reads these.
 */
export interface WebSearchDetails {
	/** How many hits of each kind were shown, and how many there were. */
	counts: KindCount[];
	/** Entries the list carries, across every kind. */
	shown: number;
	/** Entries Brave returned, across every kind. Above `shown` when the budget fired. */
	total: number;
	/** Wall-clock time for the whole search, queueing and any retry included. */
	elapsedMs: number;
}

/** A duration as a reader scans it: sub-second searches in milliseconds, the rest in seconds. */
function formatElapsed(ms: number): string {
	return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			`Search the web with Brave and return ranked results: title, host, URL, description and up to ${MAX_EXCERPTS} extra excerpts for each. ` +
			"Results are for triage — pick the promising URLs and read them with web_fetch. " +
			"Requires a Brave Search API key in BRAVE_API_KEY or in a .env beside the extension.",
		promptSnippet: "Search the web and get ranked results with snippets",
		parameters: WebSearchParams,
		// pi runs tools in parallel by default, and two concurrent searches on a
		// plan that allows one request per second is a guaranteed 429.
		//
		// Read what this really costs before copying it: pi serialises the *whole*
		// batch when any tool in it is sequential, so a turn that searches also
		// runs its reads and fetches one at a time. `brave.ts` already queues
		// searches against each other in-process, so this flag is the belt to that
		// braces — kept because the design asks for it, and because a search shares
		// a turn with other tools rarely enough for the latency not to show.
		executionMode: "sequential",

		async execute(_toolCallId, params, signal) {
			// Started before the first thing that can take time: the queue ahead of
			// this search is part of what the reader waited for.
			const startedAt = Date.now();

			// Checked before the key is looked up: a bad count or recency value is
			// the model's to fix, and saying so costs neither a keychain prompt nor
			// a request. The normalised freshness is what the header will report.
			const count = normalizeCount(params.count);
			const freshness = normalizeFreshness(params.freshness);

			// Resolved per call rather than at load time, so a session without a
			// key still starts — and reports the problem only if a search is run.
			// After the first success this is a cached read, not a keychain prompt.
			const key = resolveApiKey();
			const response = await search(params.query, key, { count, freshness }, signal);

			// The budget is pi's tool output limit, applied whole result by whole
			// result — a wide search must not flood the context window, and half an
			// entry is a URL the model cannot fetch.
			const { text, counts, shown, total } = formatResults(params.query, response, {
				maxBytes: DEFAULT_MAX_BYTES,
				freshness,
			});

			// Counted from the render rather than from the response: once the budget
			// fires, the number of hits Brave found is not the number the reader can
			// see, and reporting the first as the second overstates every wide search.
			const details: WebSearchDetails = { counts, shown, total, elapsedMs: Date.now() - startedAt };

			return { content: [{ type: "text", text }], details };
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("web_search "));
			text += theme.fg("accent", args.query ?? "");
			// The one filter that changes which results exist: a list read without
			// knowing it was narrowed is a list read wrong.
			const window = describeFreshness(args.freshness);
			if (window) text += theme.fg("dim", ` · ${window}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);

			const details = result.details as WebSearchDetails | undefined;
			// No metadata means a failed search or a result from before this renderer
			// existed; the raw output is still the truth about what happened.
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}

			const dropped = details.total - details.shown;
			let text = theme.fg("success", countPhrase(details.counts));
			text += theme.fg("muted", ` · ${formatElapsed(details.elapsedMs)}`);
			// The count phrase already says "showing 8 of 200"; this says why.
			if (dropped > 0) text += theme.fg("warning", ` · ${dropped} dropped to fit the budget`);

			if (expanded) {
				const content = result.content[0];
				const hits = hitLines(content?.type === "text" ? content.text : "");
				for (const hit of hits) text += `\n${theme.fg("dim", hit)}`;
				// Counted against the hits, not the search: what is missing from the
				// screen is what the cap cut, and the budget already spoke for itself.
				const rest = details.shown - hits.length;
				if (rest > 0) text += `\n${theme.fg("muted", `… and ${rest} more`)}`;
			}

			return new Text(text, 0, 0);
		},
	});
}
