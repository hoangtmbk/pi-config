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

/** Results per search when the caller names no count. Ten fits a triage list. */
export const DEFAULT_COUNT = 10;

/** The narrowest search worth sending. */
export const MIN_COUNT = 1;

/** Brave's own ceiling for one page of web results. */
export const MAX_COUNT = 20;

/** The relative windows Brave accepts, and what each one means. */
const FRESHNESS_WINDOWS: Record<string, string> = {
	pd: "the past day",
	pw: "the past week",
	pm: "the past month",
	py: "the past year",
};

/** `YYYY-MM-DDtoYYYY-MM-DD`, the only other form Brave takes. */
const DATE_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

/**
 * Every accepted recency value, spelled out.
 *
 * A rejected `freshness` never reaches Brave, so this list is the model's only
 * way to learn what it should have written — every rejection carries it.
 */
const FRESHNESS_FORMS = `${Object.entries(FRESHNESS_WINDOWS)
	.map(([code, meaning]) => `${code} (${meaning})`)
	.join(", ")}, or an explicit range YYYY-MM-DDtoYYYY-MM-DD (for example 2026-01-01to2026-03-31)`;

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

/**
 * The blocks a search asks Brave for.
 *
 * Discussions earn the second slot because web results systematically under-rank
 * them for debugging questions. Of the rest, news is reachable through
 * `freshness`, videos say nothing to a text agent, and an infobox is a Wikipedia
 * summary the model usually already has.
 */
const RESULT_FILTER = "web,discussions";

/** The slice of Brave's response this tool reads. */
export interface BraveResponse {
	web?: { results?: BraveResult[] };
	/**
	 * Forum and Q&A threads, in their own block rather than mixed into `web`.
	 * Brave hangs thread metadata off a `data` object on each result; the fields
	 * this tool renders sit alongside it, exactly as they do on a web result.
	 */
	discussions?: { results?: BraveResult[] };
}

export interface SearchDeps {
	/** Injected by the tests; defaults to the platform `fetch`. */
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}

/** What the model may ask for beyond the query itself. */
export interface SearchParams {
	/** How many results to return, `MIN_COUNT`–`MAX_COUNT`. Defaults to `DEFAULT_COUNT`. */
	count?: number;
	/** How recent a result must be: a window code, or `YYYY-MM-DDtoYYYY-MM-DD`. */
	freshness?: string;
}

/**
 * The count to send, or a `WebSearchError` naming the bounds it fell outside.
 *
 * Brave answers a bad count with a 422 whose body the model has to unpick, so
 * the range is enforced here instead: the message says what was asked for and
 * what the limits are, which is everything needed to retry.
 */
export function normalizeCount(count?: number): number {
	if (count === undefined) return DEFAULT_COUNT;
	if (!Number.isInteger(count)) {
		throw new WebSearchError(
			`Invalid count ${count}: ask for a whole number of results between ${MIN_COUNT} and ${MAX_COUNT}.`,
		);
	}
	if (count < MIN_COUNT || count > MAX_COUNT) {
		throw new WebSearchError(`Invalid count ${count}: ask for between ${MIN_COUNT} and ${MAX_COUNT} results.`);
	}
	return count;
}

/** Whether `text` names a day that exists — `2026-02-30` parses but is not one. */
function isCalendarDate(text: string): boolean {
	const date = new Date(`${text}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

function rejectFreshness(value: string, because: string): never {
	// Quoted back through `clip`, the same way Brave's own error bodies are: the
	// value is the model's text, and a rejection must stay one readable line.
	throw new WebSearchError(`Invalid freshness "${clip(value)}" — ${because}. Use one of: ${FRESHNESS_FORMS}.`);
}

/**
 * The freshness to send, `undefined` for no restriction, or a `WebSearchError`
 * listing every accepted form.
 *
 * Recency is the one filter the query language cannot express, so it is the one
 * parameter the model has to spell — and the one it can spell wrong. Validating
 * here means "last week" fails locally with the vocabulary attached, rather
 * than as an opaque rejection from Brave a request later.
 *
 * Case and surrounding space are normalised rather than rejected: `PW` is not a
 * mistake worth a failed search.
 */
export function normalizeFreshness(freshness?: string): string | undefined {
	if (freshness === undefined) return undefined;
	const value = freshness.trim().toLowerCase();
	// An empty value asks for no restriction, which is the default anyway.
	if (!value) return undefined;
	// `hasOwn` rather than `in`: `constructor` is on every object's prototype and
	// is not a window Brave knows.
	if (Object.hasOwn(FRESHNESS_WINDOWS, value)) return value;

	const range = DATE_RANGE.exec(value);
	if (!range) rejectFreshness(freshness, "it is not a window code or a date range");

	const [, from = "", to = ""] = range;
	if (!isCalendarDate(from) || !isCalendarDate(to)) rejectFreshness(freshness, "it names a date that does not exist");
	if (from > to) rejectFreshness(freshness, "the range ends before it starts");

	return `${from}to${to}`;
}

/**
 * The exact URL a search sends, exported so the request shape can be asserted.
 *
 * Also where `params` are validated: every request goes through here, so a
 * malformed one cannot reach the network by another path.
 */
export function buildSearchUrl(query: string, params: SearchParams = {}): string {
	const count = normalizeCount(params.count);
	const freshness = normalizeFreshness(params.freshness);

	const url = new URL(ENDPOINT);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(count));
	url.searchParams.set("result_filter", RESULT_FILTER);
	// The alternative excerpts a result is triaged on — every one that prevents a
	// wrong `web_fetch` saves 50 KB of context.
	url.searchParams.set("extra_snippets", "true");
	if (freshness) url.searchParams.set("freshness", freshness);
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
	params: SearchParams = {},
	signal?: AbortSignal,
	deps: SearchDeps = {},
): Promise<BraveResponse> {
	const trimmed = query.trim();
	if (!trimmed) throw new WebSearchError("No query provided");

	// Built before anything is sent, so a bad count or freshness costs nothing
	// and is reported as itself rather than as a request failure.
	const url = buildSearchUrl(trimmed, params);

	const send = deps.fetch ?? globalThis.fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// Combine pi's cancellation with our own timeout so either can abort.
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

	let response: Response;
	try {
		response = await send(url, {
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
