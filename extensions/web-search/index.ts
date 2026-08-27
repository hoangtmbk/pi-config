/**
 * web_search — turn a query into ranked results with enough text to decide what
 * is worth reading.
 *
 * Search only: reading is `web_fetch`'s job. The model is a better relevance
 * judge than any `top_n` heuristic, and keeping the two tools apart means
 * `web_fetch` still works on a machine with no API key.
 */

import { DEFAULT_MAX_BYTES, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_COUNT, MAX_COUNT, MIN_COUNT, normalizeCount, normalizeFreshness, search } from "./brave.ts";
import { MAX_EXCERPTS, formatResults, usableResults } from "./format.ts";
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

/** Metadata only — never the rendered markdown, which is already in `content`. */
interface WebSearchDetails {
	query: string;
	resultCount: number;
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
		// plan that allows one request per second is a guaranteed 429. Serialising
		// costs a few hundred milliseconds on the rare double search and removes a
		// whole class of flaky failure.
		executionMode: "sequential",

		async execute(_toolCallId, params, signal) {
			// Checked before the key is looked up: a bad count or recency value is
			// the model's to fix, and saying so costs neither a keychain prompt nor
			// a request. The normalised freshness is what the header will report.
			const count = normalizeCount(params.count);
			const freshness = normalizeFreshness(params.freshness);

			// Resolved per call rather than at load time, so a session without a
			// key still starts — and reports the problem only if a search is run.
			const startedAt = Date.now();
			const key = resolveApiKey();
			const response = await search(params.query, key, { count, freshness }, signal);

			const details: WebSearchDetails = {
				query: params.query,
				resultCount: usableResults(response).length,
			};

			// The budget is pi's tool output limit, applied whole result by whole
			// result — a wide search must not flood the context window, and half an
			// entry is a URL the model cannot fetch.
			const text = formatResults(params.query, response, { maxBytes: DEFAULT_MAX_BYTES, freshness });

			return { content: [{ type: "text", text }], details };
		},
	});
}
