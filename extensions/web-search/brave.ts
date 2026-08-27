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

/**
 * How long a rate-limited search waits before its one retry.
 *
 * The free plan allows one request per second, so a shade over a second is the
 * shortest wait that can actually clear the window that rejected us.
 */
export const RETRY_DELAY_MS = 1_100;

/** Where a key is issued, checked and topped up — every key failure points here. */
export const DASHBOARD_URL = "https://api-dashboard.search.brave.com/";

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
	/**
	 * How the retry waits. Injected by the tests so a rate-limit case costs no
	 * wall-clock time; defaults to a real timer.
	 */
	sleep?: (ms: number) => Promise<void>;
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

/**
 * What a failed status means, and what the reader should do about it.
 *
 * A bare `429` or `402` tells the model nothing it can act on: the useful part
 * is which of the four things went wrong — the key is missing, the key is
 * refused, the credit is gone, or the request itself was malformed — and where
 * the remedy lives. Brave's own body is quoted rather than paraphrased wherever
 * it carries the reason, because on a quota or a parameter failure that text
 * names the plan or the offending field and a paraphrase would lose it.
 */
function failureMessage(status: number, statusText: string, body: string): string {
	const quoted = body ? ` — ${body}` : "";
	const label = `${status}${statusText ? ` ${statusText}` : ""}`;

	if (status === 401 || status === 403) {
		return (
			`Brave rejected the API key (${label})${quoted}. ` +
			`Check BRAVE_API_KEY against the key at ${DASHBOARD_URL} — a key is also refused once its subscription lapses.`
		);
	}
	if (status === 402) {
		return (
			`Brave has no credit left for this key (${label})${quoted}. ` +
			`Check the plan and top it up at ${DASHBOARD_URL}; searches keep failing until then.`
		);
	}
	if (status === 429) {
		return (
			`Brave is rate-limiting this key (${label})${quoted}. ` +
			"The free plan allows one search per second and 2,000 a month; wait a moment before searching again."
		);
	}
	if (status === 422 || status === 400) {
		return `Brave rejected a search parameter (${label})${quoted}. Fix the query, count or freshness and search again.`;
	}
	if (status >= 500) {
		return (
			`Brave's search service failed (${label})${quoted}. ` +
			"This is Brave's end, not the query's — try again shortly."
		);
	}
	return `Brave search failed: ${label}${quoted}`;
}

/**
 * Searches, in the order they were asked for, one at a time.
 *
 * pi runs tools in parallel, and two concurrent searches on a plan that allows
 * one request per second is a guaranteed 429. The tool declares itself
 * sequential so pi does not start them together, and this queue is the same
 * promise for anything that reaches the module by another path. A failed search
 * must not block the next one, so the chain swallows its own outcome.
 */
let pending: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
	const result = pending.then(work);
	// The queue tracks only when the search ahead finished, never how it went:
	// a rejected search that stayed on the chain would reject every search behind
	// it with someone else's error.
	pending = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

/** The default wait: a real timer. */
function realSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One request and the reading of its response. Throws `WebSearchError`. */
async function attempt(
	url: string,
	query: string,
	key: string,
	signal: AbortSignal | undefined,
	deps: SearchDeps,
): Promise<{ ok: true; body: BraveResponse } | { ok: false; status: number; message: string }> {
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
		if (signal?.aborted) throw new WebSearchError(`Cancelled: ${query}`);
		if (timeout.aborted) throw new WebSearchError(`Search timed out after ${timeoutMs / 1000}s: ${query}`);
		// Nothing reached Brave at all: a DNS failure, a refused connection, a
		// proxy in the way. Saying so separates it from a search Brave answered.
		throw new WebSearchError(`Could not reach Brave: the network connection failed — ${errorText(error)}`);
	}

	if (!response.ok) {
		const body = clip(await response.text().catch(() => ""));
		return {
			ok: false,
			status: response.status,
			message: failureMessage(response.status, response.statusText, body),
		};
	}

	try {
		return { ok: true, body: (await response.json()) as BraveResponse };
	} catch (error) {
		throw new WebSearchError(`Brave returned a body that is not JSON: ${errorText(error)}`);
	}
}

/**
 * Run one search. Throws `WebSearchError` for anything that is not a 2xx JSON
 * body — an empty result set is a valid answer, not a failure, and is the
 * renderer's to explain.
 *
 * A rate-limited search is retried once after `RETRY_DELAY_MS`: on the free
 * plan a 429 usually means only that the previous request was less than a
 * second ago, which one short wait fixes. Nothing else is retried — a rejected
 * key or a spent quota answers the same way however many times it is asked.
 */
export async function search(
	query: string,
	key: string,
	params: SearchParams = {},
	signal?: AbortSignal,
	deps: SearchDeps = {},
): Promise<BraveResponse> {
	const trimmed = query.trim();
	if (!trimmed) throw new WebSearchError("No query provided");

	// Built before anything is sent, so a bad count or freshness costs nothing,
	// is reported as itself rather than as a request failure, and never takes a
	// turn in the queue.
	const url = buildSearchUrl(trimmed, params);
	const sleep = deps.sleep ?? realSleep;

	return serialized(async () => {
		const first = await attempt(url, trimmed, key, signal, deps);
		if (first.ok) return first.body;
		if (first.status !== 429) throw new WebSearchError(first.message);

		await sleep(RETRY_DELAY_MS);
		// The wait is the longest part of a search; a cancellation during it must
		// not be spent on a second request nobody is waiting for.
		if (signal?.aborted) throw new WebSearchError(`Cancelled: ${trimmed}`);

		const second = await attempt(url, trimmed, key, signal, deps);
		if (second.ok) return second.body;
		throw new WebSearchError(second.message);
	});
}
