/**
 * The provider seam: what a search sends, and what it does with a response that
 * is not a 2xx JSON body.
 *
 * `fetch` is injected throughout, so the suite never touches the network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSearchUrl, search, WebSearchError } from "../brave.ts";
import { fakeFetch, jsonResponse as json, rejection, stalledFetch, thrown } from "./helpers.ts";

const okBody = { web: { results: [{ title: "A", url: "https://a.test/", description: "d" }] } };

describe("buildSearchUrl", () => {
	it("targets Brave's web search endpoint", () => {
		assert.match(buildSearchUrl("hello"), /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/);
	});

	it("carries the query and a result count", () => {
		const url = new URL(buildSearchUrl("rust async fn in traits"));
		assert.equal(url.searchParams.get("q"), "rust async fn in traits");
		assert.equal(url.searchParams.get("count"), "10");
	});

	it("asks for discussion threads alongside the web results, and nothing else", () => {
		const url = new URL(buildSearchUrl("rust async fn in traits"));
		assert.equal(url.searchParams.get("result_filter"), "web,discussions");
	});

	it("asks for the extra snippets, the excerpts a result is triaged on", () => {
		assert.equal(new URL(buildSearchUrl("hello")).searchParams.get("extra_snippets"), "true");
	});

	it("escapes operators and punctuation rather than sending them raw", () => {
		const url = buildSearchUrl('site:rust-lang.org "async fn" -tokio');
		assert.ok(!url.includes(" "), url);
		assert.equal(new URL(url).searchParams.get("q"), 'site:rust-lang.org "async fn" -tokio');
	});
});

describe("search", () => {
	it("sends the key as Brave's subscription header and asks for JSON", async () => {
		const { fetch, calls } = fakeFetch(() => json(okBody));
		await search("hello", "secret-key", {}, undefined, { fetch });

		assert.equal(calls.length, 1);
		const headers = calls[0]?.init.headers as Record<string, string>;
		assert.equal(headers["x-subscription-token"], "secret-key");
		assert.equal(headers.accept, "application/json");
	});

	it("returns the parsed response", async () => {
		const { fetch } = fakeFetch(() => json(okBody));
		const response = await search("hello", "k", {}, undefined, { fetch });
		assert.equal(response.web?.results?.[0]?.url, "https://a.test/");
	});

	it("passes an abort signal so a search can be cancelled in flight", async () => {
		const { fetch, calls } = fakeFetch(() => json(okBody));
		await search("hello", "k", {}, new AbortController().signal, { fetch });
		assert.ok(calls[0]?.init.signal instanceof AbortSignal);
	});

	it("trims the query before sending it", async () => {
		const { fetch, calls } = fakeFetch(() => json(okBody));
		await search("  hello  ", "k", {}, undefined, { fetch });
		assert.equal(new URL(calls[0]?.url ?? "").searchParams.get("q"), "hello");
	});

	it("rejects an empty query without sending anything", async () => {
		const { fetch, calls } = fakeFetch(() => json(okBody));
		const error = await rejection(search("   ", "k", {}, undefined, { fetch }));
		assert.ok(error instanceof WebSearchError);
		assert.equal(calls.length, 0);
	});

	it("fails a non-2xx with the status and the server's own text", async () => {
		const { fetch } = fakeFetch(() => new Response("Subscription token invalid", { status: 401 }));
		const error = await rejection(search("hello", "bad", {}, undefined, { fetch }));

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /401/);
		assert.match(error.message, /Subscription token invalid/);
	});

	it("flattens a multi-line error body onto one line", async () => {
		const { fetch } = fakeFetch(() => new Response('{\n  "error": "quota exceeded"\n}', { status: 402 }));
		const error = await rejection(search("hello", "k", {}, undefined, { fetch }));

		assert.ok(!error.message.includes("\n"), error.message);
		assert.match(error.message, /quota exceeded/);
	});

	it("clips a long error body rather than pasting a whole page", async () => {
		const { fetch } = fakeFetch(() => new Response("x".repeat(5000), { status: 500 }));
		const error = await rejection(search("hello", "k", {}, undefined, { fetch }));
		assert.ok(error.message.length < 700, `message was ${error.message.length} chars`);
	});

	it("still reports a non-2xx that has no body", async () => {
		const { fetch } = fakeFetch(() => new Response(null, { status: 503 }));
		const error = await rejection(search("hello", "k", {}, undefined, { fetch }));
		assert.match(error.message, /503/);
	});

	it("reports a 2xx body that is not JSON", async () => {
		const { fetch } = fakeFetch(() => new Response("<html>nope</html>", { status: 200 }));
		const error = await rejection(search("hello", "k", {}, undefined, { fetch }));
		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /not JSON/);
	});

	it("gives up on a search that never answers", async () => {
		const error = await rejection(search("hello", "k", {}, undefined, { fetch: stalledFetch(), timeoutMs: 20 }));

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /timed out after/i);
	});

	it("reports a search cancelled from pi rather than as a timeout", async () => {
		const controller = new AbortController();
		const search_ = search("hello", "k", {}, controller.signal, { fetch: stalledFetch() });
		controller.abort();
		const error = await rejection(search_);

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /^Cancelled: hello$/);
	});

	it("reports a transport failure with the underlying message", async () => {
		const fetch = (async () => {
			throw new TypeError("fetch failed: ECONNREFUSED");
		}) as typeof globalThis.fetch;
		const error = await rejection(search("hello", "k", {}, undefined, { fetch }));

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /ECONNREFUSED/);
	});
});

describe("the count parameter", () => {
	it("asks for ten results when the caller names no count", () => {
		assert.equal(new URL(buildSearchUrl("hello")).searchParams.get("count"), "10");
	});

	it("asks for the number of results the caller wants", () => {
		assert.equal(new URL(buildSearchUrl("hello", { count: 3 })).searchParams.get("count"), "3");
	});

	it("accepts the ends of the supported range", () => {
		assert.equal(new URL(buildSearchUrl("hello", { count: 1 })).searchParams.get("count"), "1");
		assert.equal(new URL(buildSearchUrl("hello", { count: 20 })).searchParams.get("count"), "20");
	});

	it("rejects a count above the range, naming both bounds", () => {
		const error = thrown(() => buildSearchUrl("hello", { count: 25 }));

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /25/);
		assert.match(error.message, /\b1\b/);
		assert.match(error.message, /\b20\b/);
	});

	it("rejects a count below the range", () => {
		const error = thrown(() => buildSearchUrl("hello", { count: 0 }));

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /\b1\b.*\b20\b/);
	});

	it("rejects a count that is not a whole number", () => {
		const error = thrown(() => buildSearchUrl("hello", { count: 7.5 }));

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /whole number/i);
	});

	it("rejects a count that is not a number at all", () => {
		const error = thrown(() => buildSearchUrl("hello", { count: Number.NaN }));

		assert.ok(error instanceof WebSearchError);
	});
});

describe("the freshness parameter", () => {
	it("is absent from the request when the caller does not restrict recency", () => {
		assert.equal(new URL(buildSearchUrl("hello")).searchParams.get("freshness"), null);
	});

	for (const code of ["pd", "pw", "pm", "py"]) {
		it(`carries the ${code} window`, () => {
			assert.equal(new URL(buildSearchUrl("hello", { freshness: code })).searchParams.get("freshness"), code);
		});
	}

	it("carries an explicit date range", () => {
		const url = new URL(buildSearchUrl("hello", { freshness: "2026-01-01to2026-03-31" }));
		assert.equal(url.searchParams.get("freshness"), "2026-01-01to2026-03-31");
	});

	it("accepts a range of one day, where both ends are the same date", () => {
		const url = new URL(buildSearchUrl("hello", { freshness: "2026-01-01to2026-01-01" }));
		assert.equal(url.searchParams.get("freshness"), "2026-01-01to2026-01-01");
	});

	it("normalises surrounding space and casing rather than rejecting them", () => {
		assert.equal(new URL(buildSearchUrl("hello", { freshness: "  PW " })).searchParams.get("freshness"), "pw");
		assert.equal(
			new URL(buildSearchUrl("hello", { freshness: "2026-01-01TO2026-03-31" })).searchParams.get("freshness"),
			"2026-01-01to2026-03-31",
		);
	});

	it("treats an empty value as no restriction at all", () => {
		assert.equal(new URL(buildSearchUrl("hello", { freshness: "   " })).searchParams.get("freshness"), null);
	});

	it("rejects a value in no accepted form, listing every form it could have taken", () => {
		const error = thrown(() => buildSearchUrl("hello", { freshness: "last week" }));

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /last week/);
		for (const form of ["pd", "pw", "pm", "py", "YYYY-MM-DDtoYYYY-MM-DD"]) {
			assert.ok(error.message.includes(form), `${form} missing from: ${error.message}`);
		}
	});

	it("rejects a window code Brave does not have", () => {
		assert.ok(thrown(() => buildSearchUrl("hello", { freshness: "ph" })) instanceof WebSearchError);
	});

	it("rejects a name that only every object's prototype has", () => {
		assert.ok(thrown(() => buildSearchUrl("hello", { freshness: "constructor" })) instanceof WebSearchError);
		assert.ok(thrown(() => buildSearchUrl("hello", { freshness: "toString" })) instanceof WebSearchError);
	});

	it("rejects a date that is not on the calendar", () => {
		const error = thrown(() => buildSearchUrl("hello", { freshness: "2026-02-30to2026-03-31" }));

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /YYYY-MM-DDtoYYYY-MM-DD/);
	});

	it("rejects a range that ends before it starts", () => {
		const error = thrown(() => buildSearchUrl("hello", { freshness: "2026-03-31to2026-01-01" }));

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /before/i);
		assert.match(error.message, /YYYY-MM-DDtoYYYY-MM-DD/);
	});

	it("keeps a rejection to one readable line, however long the value it quotes", () => {
		const error = thrown(() => buildSearchUrl("hello", { freshness: `${"x".repeat(5000)}\nand more` }));

		assert.ok(!error.message.includes("\n"), error.message);
		assert.ok(error.message.length < 900, `message was ${error.message.length} chars`);
	});

	it("rejects a range written with the wrong separator", () => {
		assert.ok(thrown(() => buildSearchUrl("hello", { freshness: "2026-01-01..2026-03-31" })) instanceof WebSearchError);
	});

	it("rejects a single date given without a range", () => {
		assert.ok(thrown(() => buildSearchUrl("hello", { freshness: "2026-01-01" })) instanceof WebSearchError);
	});
});

describe("search with count and freshness", () => {
	it("sends both to Brave", async () => {
		const { fetch, calls } = fakeFetch(() => json(okBody));
		await search("hello", "k", { count: 5, freshness: "pm" }, undefined, { fetch });

		const url = new URL(calls[0]?.url ?? "");
		assert.equal(url.searchParams.get("count"), "5");
		assert.equal(url.searchParams.get("freshness"), "pm");
	});

	it("rejects a malformed freshness without sending anything", async () => {
		const { fetch, calls } = fakeFetch(() => json(okBody));
		const error = await rejection(search("hello", "k", { freshness: "yesterday" }, undefined, { fetch }));

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /pd/);
		assert.equal(calls.length, 0);
	});

	it("rejects an out-of-range count without sending anything", async () => {
		const { fetch, calls } = fakeFetch(() => json(okBody));
		const error = await rejection(search("hello", "k", { count: 50 }, undefined, { fetch }));

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /\b1\b.*\b20\b/);
		assert.equal(calls.length, 0);
	});
});

describe("what a failed search tells the model to do", () => {
	/** A fetch answering one non-2xx, with a sleep that never actually waits. */
	function failing(status: number, body: string | null, statusText?: string) {
		const { fetch, calls } = fakeFetch(() => new Response(body, { status, statusText }));
		return {
			calls,
			error: () => rejection(search("hello", "k", {}, undefined, { fetch, sleep: async () => {} })),
		};
	}

	it("says the key was rejected, and where to fix it, on a 401", async () => {
		const error = await failing(401, "Subscription token invalid").error();

		assert.match(error.message, /key/i);
		assert.match(error.message, /BRAVE_API_KEY/);
		assert.match(error.message, /Subscription token invalid/);
	});

	it("says the key was rejected on a 403 too", async () => {
		const error = await failing(403, "Forbidden").error();
		assert.match(error.message, /key/i);
		assert.match(error.message, /BRAVE_API_KEY/);
	});

	it("says the credit is spent, quoting Brave's own words, on a 402", async () => {
		const error = await failing(402, '{"error":"plan quota exhausted for this month"}').error();

		assert.match(error.message, /plan quota exhausted for this month/);
		assert.match(error.message, /credit|quota|plan/i);
		assert.match(error.message, /api-dashboard\.search\.brave\.com/);
	});

	it("quotes the parameter Brave objected to on a 422", async () => {
		const error = await failing(422, '{"error":{"detail":"count must be <= 20"}}').error();

		assert.match(error.message, /count must be <= 20/);
		assert.match(error.message, /parameter/i);
	});

	it("says a server error is Brave's end, not the query's, on a 5xx", async () => {
		const error = await failing(503, "upstream unavailable", "Service Unavailable").error();

		assert.match(error.message, /503/);
		assert.match(error.message, /Brave/);
		assert.match(error.message, /again/i);
	});

	it("still names the status when a failure has no body at all", async () => {
		const error = await failing(418, null, "I'm a teapot").error();
		assert.match(error.message, /418/);
	});

	it("says the network never reached Brave when the request itself fails", async () => {
		const fetch = (async () => {
			throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.search.brave.com");
		}) as typeof globalThis.fetch;
		const error = await rejection(search("hello", "k", {}, undefined, { fetch }));

		assert.match(error.message, /ENOTFOUND/);
		assert.match(error.message, /connection|network|reach/i);
	});

	it("never puts the key in a message, whatever went wrong", async () => {
		const { fetch } = fakeFetch(() => new Response("nope", { status: 401 }));
		const error = await rejection(search("hello", "super-secret-key", {}, undefined, { fetch }));
		assert.ok(!error.message.includes("super-secret-key"), error.message);
	});
});

describe("a rate-limited search", () => {
	const limited = () => new Response('{"error":"rate limit exceeded"}', { status: 429 });

	it("is retried once, and succeeds if the second attempt does", async () => {
		let attempts = 0;
		const { fetch, calls } = fakeFetch(() => {
			attempts += 1;
			return attempts === 1 ? limited() : json(okBody);
		});
		const slept: number[] = [];

		const response = await search("hello", "k", {}, undefined, {
			fetch,
			sleep: async (ms) => {
				slept.push(ms);
			},
		});

		assert.equal(calls.length, 2);
		assert.equal(response.web?.results?.[0]?.url, "https://a.test/");
		// Long enough to clear the free plan's one-request-per-second ceiling.
		assert.equal(slept.length, 1);
		assert.ok((slept[0] ?? 0) >= 1000, `waited ${slept[0]}ms`);
	});

	it("waits before retrying rather than hammering the endpoint", async () => {
		const order: string[] = [];
		const { fetch } = fakeFetch(() => {
			order.push("request");
			return limited();
		});

		await rejection(
			search("hello", "k", {}, undefined, {
				fetch,
				sleep: async () => {
					order.push("wait");
				},
			}),
		);

		assert.deepEqual(order, ["request", "wait", "request"]);
	});

	it("gives up after the second attempt, explaining the limit", async () => {
		const { fetch, calls } = fakeFetch(() => limited());
		const error = await rejection(search("hello", "k", {}, undefined, { fetch, sleep: async () => {} }));

		assert.equal(calls.length, 2);
		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /429|rate/i);
		assert.match(error.message, /rate limit exceeded/);
		assert.match(error.message, /second/i);
	});

	it("does not retry a failure that a second attempt cannot fix", async () => {
		const { fetch, calls } = fakeFetch(() => new Response("Subscription token invalid", { status: 401 }));
		await rejection(search("hello", "k", {}, undefined, { fetch, sleep: async () => {} }));
		assert.equal(calls.length, 1);
	});

	it("abandons the retry when pi cancels the search while it waits", async () => {
		const controller = new AbortController();
		const { fetch, calls } = fakeFetch(() => limited());
		const error = await rejection(
			search("hello", "k", {}, controller.signal, {
				fetch,
				sleep: async () => {
					controller.abort();
				},
			}),
		);

		assert.equal(calls.length, 1);
		assert.match(error.message, /^Cancelled: hello$/);
	});
});

describe("two searches in one turn", () => {
	/** A fetch that hangs until it is released, so overlap is observable. */
	function gatedFetch() {
		const started: string[] = [];
		const gates: (() => void)[] = [];
		const fetch = (async (input: RequestInfo | URL) => {
			started.push(new URL(String(input)).searchParams.get("q") ?? "");
			await new Promise<void>((resolve) => gates.push(resolve));
			return json(okBody);
		}) as typeof globalThis.fetch;
		return { fetch, started, release: () => gates.shift()?.() };
	}

	/** Let every queued microtask and timer callback run. */
	const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

	it("run one after another, so the plan's one-per-second ceiling is not tripped", async () => {
		const gate = gatedFetch();

		const first = search("first", "k", {}, undefined, { fetch: gate.fetch });
		const second = search("second", "k", {}, undefined, { fetch: gate.fetch });
		await settle();

		// The second search has not touched the network while the first is open.
		assert.deepEqual(gate.started, ["first"]);

		gate.release();
		await first;
		await settle();
		assert.deepEqual(gate.started, ["first", "second"]);

		gate.release();
		await second;
	});

	it("lets the next search through even when the one before it failed", async () => {
		const gate = gatedFetch();
		const failed = rejection(search("   ", "k", {}, undefined, { fetch: gate.fetch }));
		const next = search("after", "k", {}, undefined, { fetch: gate.fetch });
		await failed;
		await settle();

		assert.deepEqual(gate.started, ["after"]);
		gate.release();
		await next;
	});
});
