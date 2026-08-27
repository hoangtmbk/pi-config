/**
 * web_search — turn a query into ranked results with enough text to decide what
 * is worth reading.
 *
 * Search only: reading is `web_fetch`'s job. The model is a better relevance
 * judge than any `top_n` heuristic, and keeping the two tools apart means
 * `web_fetch` still works on a machine with no API key.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { search } from "./brave.ts";
import { formatResults, usableResults } from "./format.ts";
import { resolveApiKey } from "./key.ts";

const WebSearchParams = Type.Object({
	query: Type.String({
		description:
			'Search terms. Brave\'s operators work inside the query: site:example.com, -excluded, "exact phrase", filetype:pdf.',
	}),
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
			"Search the web with Brave and return ranked results: title, host, URL and description for each. " +
			"Results are for triage — pick the promising URLs and read them with web_fetch. " +
			"Requires a Brave Search API key in BRAVE_API_KEY or in a .env beside the extension.",
		promptSnippet: "Search the web and get ranked results with snippets",
		parameters: WebSearchParams,

		async execute(_toolCallId, params, signal) {
			// Resolved per call rather than at load time, so a session without a
			// key still starts — and reports the problem only if a search is run.
			const startedAt = Date.now();
			const key = resolveApiKey();
			const response = await search(params.query, key, signal);

			const details: WebSearchDetails = {
				query: params.query,
				resultCount: usableResults(response).length,
			};

			return { content: [{ type: "text", text: formatResults(params.query, response) }], details };
		},
	});
}
