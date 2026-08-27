/**
 * Brave Web Search: the provider seam.
 *
 * Everything that knows the API is a Brave API lives here — the endpoint, the
 * query parameters, the auth header, and the mapping from a failed response to
 * a message the model can act on. `format.ts` never sees an HTTP concern and
 * this module never renders anything.
 *
 * `fetch` is injectable so the suite can assert the exact request without a
 * network, and pi's abort signal is combined with our own timeout so Esc
 * cancels a search in flight.
 */

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/** Results per search. A parameter in a later ticket; fixed for now. */
const DEFAULT_COUNT = 10;

/** Searches answer in well under a second; 30s would be a page-fetch budget. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Enough of an error body to explain itself, without pasting a whole HTML page. */
const MAX_ERROR_BODY_CHARS = 500;

export class WebSearchError extends Error {}

/**
 * One web result.
 *
 * Every field is optional on purpose: Brave omits what a page has none of, and
 * a missing description must degrade the entry rather than fail the search.
 */
export interface BraveResult {
	title?: string;
	url?: string;
	description?: string;
	meta_url?: { hostname?: string };
	/**
	 * Alternative excerpts from the page, up to 5. Historically a paid-plan
	 * field, so its absence is ordinary and must degrade the entry to its
	 * description rather than fail the search.
	 */
	extra_snippets?: string[];
}

/** The slice of Brave's response this tool reads. */
export interface BraveResponse {
	web?: { results?: BraveResult[] };
}

export interface SearchDeps {
	/** Injected by the tests; defaults to the platform `fetch`. */
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}

/** The exact URL a search sends, exported so the request shape can be asserted. */
export function buildSearchUrl(query: string): string {
	const url = new URL(ENDPOINT);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(DEFAULT_COUNT));
	url.searchParams.set("result_filter", "web");
	// The alternative excerpts a result is triaged on — every one that prevents a
	// wrong `web_fetch` saves 50 KB of context.
	url.searchParams.set("extra_snippets", "true");
	return url.toString();
}

/** What a caught value has to say for itself. */
export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Collapse an error body to one readable line. */
function clip(body: string): string {
	const flat = body.replace(/\s+/g, " ").trim();
	return flat.length > MAX_ERROR_BODY_CHARS ? `${flat.slice(0, MAX_ERROR_BODY_CHARS)}…` : flat;
}

/** Run one search. Throws `WebSearchError` for anything that is not a 2xx JSON body. */
export async function search(
	query: string,
	key: string,
	signal?: AbortSignal,
	deps: SearchDeps = {},
): Promise<BraveResponse> {
	const trimmed = query.trim();
	if (!trimmed) throw new WebSearchError("No query provided");

	const send = deps.fetch ?? globalThis.fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// Combine pi's cancellation with our own timeout so either can abort.
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

	let response: Response;
	try {
		response = await send(buildSearchUrl(trimmed), {
			headers: {
				accept: "application/json",
				"x-subscription-token": key,
			},
			signal: combined,
		});
	} catch (error) {
		if (signal?.aborted) throw new WebSearchError(`Cancelled: ${trimmed}`);
		if (timeout.aborted) throw new WebSearchError(`Search timed out after ${timeoutMs / 1000}s: ${trimmed}`);
		throw new WebSearchError(`Search request failed: ${errorText(error)}`);
	}

	if (!response.ok) {
		// Brave's own text names the reason — a bad key, exhausted credit, a
		// rejected parameter — so it is quoted rather than paraphrased.
		const body = clip(await response.text().catch(() => ""));
		const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
		throw new WebSearchError(`Brave search failed: ${status}${body ? ` — ${body}` : ""}`);
	}

	try {
		return (await response.json()) as BraveResponse;
	} catch (error) {
		throw new WebSearchError(`Brave returned a body that is not JSON: ${errorText(error)}`);
	}
}
