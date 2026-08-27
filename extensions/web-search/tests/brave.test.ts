/**
 * The provider seam: what a search sends, and what it does with a response that
 * is not a 2xx JSON body.
 *
 * `fetch` is injected throughout, so the suite never touches the network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSearchUrl, search, WebSearchError } from "../brave.ts";
import { fakeFetch, jsonResponse as json, rejection, stalledFetch } from "./helpers.ts";

const okBody = { web: { results: [{ title: "A", url: "https://a.test/", description: "d" }] } };

describe("buildSearchUrl", () => {
	it("targets Brave's web search endpoint", () => {
		assert.match(buildSearchUrl("hello"), /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/);
	});

	it("carries the query, a result count, and the web filter", () => {
		const url = new URL(buildSearchUrl("rust async fn in traits"));
		assert.equal(url.searchParams.get("q"), "rust async fn in traits");
		assert.equal(url.searchParams.get("count"), "10");
		assert.equal(url.searchParams.get("result_filter"), "web");
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
		await search("hello", "secret-key", undefined, { fetch });

		assert.equal(calls.length, 1);
		const headers = calls[0]?.init.headers as Record<string, string>;
		assert.equal(headers["x-subscription-token"], "secret-key");
		assert.equal(headers.accept, "application/json");
	});

	it("returns the parsed response", async () => {
		const { fetch } = fakeFetch(() => json(okBody));
		const response = await search("hello", "k", undefined, { fetch });
		assert.equal(response.web?.results?.[0]?.url, "https://a.test/");
	});

	it("passes an abort signal so a search can be cancelled in flight", async () => {
		const { fetch, calls } = fakeFetch(() => json(okBody));
		await search("hello", "k", new AbortController().signal, { fetch });
		assert.ok(calls[0]?.init.signal instanceof AbortSignal);
	});

	it("trims the query before sending it", async () => {
		const { fetch, calls } = fakeFetch(() => json(okBody));
		await search("  hello  ", "k", undefined, { fetch });
		assert.equal(new URL(calls[0]?.url ?? "").searchParams.get("q"), "hello");
	});

	it("rejects an empty query without sending anything", async () => {
		const { fetch, calls } = fakeFetch(() => json(okBody));
		const error = await rejection(search("   ", "k", undefined, { fetch }));
		assert.ok(error instanceof WebSearchError);
		assert.equal(calls.length, 0);
	});

	it("fails a non-2xx with the status and the server's own text", async () => {
		const { fetch } = fakeFetch(() => new Response("Subscription token invalid", { status: 401 }));
		const error = await rejection(search("hello", "bad", undefined, { fetch }));

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /401/);
		assert.match(error.message, /Subscription token invalid/);
	});

	it("flattens a multi-line error body onto one line", async () => {
		const { fetch } = fakeFetch(() => new Response('{\n  "error": "quota exceeded"\n}', { status: 429 }));
		const error = await rejection(search("hello", "k", undefined, { fetch }));

		assert.ok(!error.message.includes("\n"), error.message);
		assert.match(error.message, /quota exceeded/);
	});

	it("clips a long error body rather than pasting a whole page", async () => {
		const { fetch } = fakeFetch(() => new Response("x".repeat(5000), { status: 500 }));
		const error = await rejection(search("hello", "k", undefined, { fetch }));
		assert.ok(error.message.length < 700, `message was ${error.message.length} chars`);
	});

	it("still reports a non-2xx that has no body", async () => {
		const { fetch } = fakeFetch(() => new Response(null, { status: 503 }));
		const error = await rejection(search("hello", "k", undefined, { fetch }));
		assert.match(error.message, /503/);
	});

	it("reports a 2xx body that is not JSON", async () => {
		const { fetch } = fakeFetch(() => new Response("<html>nope</html>", { status: 200 }));
		const error = await rejection(search("hello", "k", undefined, { fetch }));
		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /not JSON/);
	});

	it("gives up on a search that never answers", async () => {
		const error = await rejection(search("hello", "k", undefined, { fetch: stalledFetch(), timeoutMs: 20 }));

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /timed out after/i);
	});

	it("reports a search cancelled from pi rather than as a timeout", async () => {
		const controller = new AbortController();
		const search_ = search("hello", "k", controller.signal, { fetch: stalledFetch() });
		controller.abort();
		const error = await rejection(search_);

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /^Cancelled: hello$/);
	});

	it("reports a transport failure with the underlying message", async () => {
		const fetch = (async () => {
			throw new TypeError("fetch failed: ECONNREFUSED");
		}) as typeof globalThis.fetch;
		const error = await rejection(search("hello", "k", undefined, { fetch }));

		assert.ok(error instanceof WebSearchError);
		assert.match(error.message, /ECONNREFUSED/);
	});
});
