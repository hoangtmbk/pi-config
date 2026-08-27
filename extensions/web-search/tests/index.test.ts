/**
 * Registration: the extension loads and hands pi a usable `web_search` tool.
 *
 * The module is imported and its default export invoked exactly as pi does, so
 * a broken import or a malformed tool definition fails here rather than in a
 * session.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type AgentToolResult,
	DEFAULT_MAX_BYTES,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import register from "../index.ts";
import { clearResolvedKey } from "../key.ts";
import { fakeFetch, jsonResponse, rejection } from "./helpers.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(TESTS_DIR, "fixtures");
const REPO_ROOT = join(TESTS_DIR, "..", "..", "..");

/** The one tool the extension registers, with the parts these tests use. */
interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	parameters: { properties: Record<string, { type: string }>; required?: string[] };
	execute: (
		toolCallId: string,
		params: { query: string; count?: number; freshness?: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<{ query: string; resultCount: number }>>;
}

/** The tools the extension registers when loaded. */
function registeredTools(): Record<string, unknown>[] {
	const tools: Record<string, unknown>[] = [];
	const pi = {
		registerTool(tool: unknown) {
			tools.push(tool as Record<string, unknown>);
		},
	};
	register(pi as unknown as ExtensionAPI);
	return tools;
}

/** Nothing in `execute` touches the context, so an empty one is honest. */
const CTX = {} as ExtensionContext;

/** Run `body` with `BRAVE_API_KEY` set (or unset), restoring it afterwards. */
async function withEnvKey<T>(key: string | undefined, body: () => Promise<T>): Promise<T> {
	const saved = process.env.BRAVE_API_KEY;
	if (key === undefined) delete process.env.BRAVE_API_KEY;
	else process.env.BRAVE_API_KEY = key;
	// The resolved key is cached for the life of the process, so each test starts
	// from an unresolved one rather than inheriting the last test's.
	clearResolvedKey();
	try {
		return await body();
	} finally {
		clearResolvedKey();
		if (saved === undefined) delete process.env.BRAVE_API_KEY;
		else process.env.BRAVE_API_KEY = saved;
	}
}

/** Run `body` against a stand-in `fetch`, restoring the real one afterwards. */
async function withFetch<T>(fetch: typeof globalThis.fetch, body: () => Promise<T>): Promise<T> {
	const saved = globalThis.fetch;
	globalThis.fetch = fetch;
	try {
		return await body();
	} finally {
		globalThis.fetch = saved;
	}
}

describe("the web-search extension", () => {
	it("registers a single web_search tool", () => {
		const tools = registeredTools();
		assert.equal(tools.length, 1);
		assert.equal(tools[0]?.name, "web_search");
	});

	it("takes a query string", () => {
		const { parameters } = registeredTools()[0] as unknown as RegisteredTool;
		assert.equal(parameters.properties.query?.type, "string");
		assert.deepEqual(parameters.required, ["query"]);
	});

	it("describes itself to the model, and appears in the tool list", () => {
		const tool = registeredTools()[0] as unknown as RegisteredTool;
		assert.match(tool.description, /search/i);
		assert.ok(tool.label);
		assert.ok(tool.promptSnippet, "a tool with no promptSnippet is left out of the system prompt");
	});

	it("searches with the resolved key and returns the formatted results", async () => {
		const tool = registeredTools()[0] as unknown as RegisteredTool;
		const response = JSON.parse(readFileSync(join(FIXTURE_DIR, "brave-web-search.json"), "utf8")) as unknown;
		const { fetch, calls } = fakeFetch(() => jsonResponse(response));

		const result = await withEnvKey("test-key", () =>
			withFetch(fetch, () => tool.execute("call-1", { query: "go generics" }, undefined, undefined, CTX)),
		);

		// The key reached the request, and the response reached the formatter.
		assert.equal((calls[0]?.init.headers as Record<string, string>)["x-subscription-token"], "test-key");
		assert.equal(new URL(calls[0]?.url ?? "").searchParams.get("q"), "go generics");

		const content = result.content[0];
		assert.equal(content?.type, "text");
		assert.match(content?.type === "text" ? content.text : "", /^search: "go generics" — 3 results \(Brave\)$/m);
		assert.match(content?.type === "text" ? content.text : "", /^1\. An Introduction To Generics/m);
		assert.deepEqual(result.details, { query: "go generics", resultCount: 3 });
	});

	it("renders discussion threads under their own heading, numbered on from the web list", async () => {
		const tool = registeredTools()[0] as unknown as RegisteredTool;
		const response = JSON.parse(readFileSync(join(FIXTURE_DIR, "brave-web-discussions.json"), "utf8")) as unknown;
		const { fetch, calls } = fakeFetch(() => jsonResponse(response));

		const result = await withEnvKey("test-key", () =>
			withFetch(fetch, () =>
				tool.execute("call-1", { query: "rust async fn in traits" }, undefined, undefined, CTX),
			),
		);

		// Discussions were asked for in the same single search.
		assert.equal(calls.length, 1);
		assert.equal(new URL(calls[0]?.url ?? "").searchParams.get("result_filter"), "web,discussions");

		const content = result.content[0];
		const text = content?.type === "text" ? content.text : "";
		assert.match(text, /^search: "rust async fn in traits" — 2 web, 2 discussions \(Brave\)$/m);
		assert.match(text, /^## Discussions$/m);
		assert.match(text, /^3\. Why is async in traits still painful/m);
		assert.deepEqual(result.details, { query: "rust async fn in traits", resultCount: 4 });
	});

	it("keeps a wide search inside pi's tool output limit, whole results only", async () => {
		const tool = registeredTools()[0] as unknown as RegisteredTool;
		// Far more text than one tool result may carry, so the budget has to fire.
		const results = Array.from({ length: 200 }, (_unused, index) => ({
			title: `Result ${index + 1}`,
			url: `https://example.com/${index + 1}`,
			description: "lorem ipsum ".repeat(60).trim(),
		}));
		const { fetch } = fakeFetch(() => jsonResponse({ web: { results } }));

		const result = await withEnvKey("test-key", () =>
			withFetch(fetch, () => tool.execute("call-1", { query: "wide" }, undefined, undefined, CTX)),
		);

		const content = result.content[0];
		const text = content?.type === "text" ? content.text : "";
		assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES, `${Buffer.byteLength(text, "utf8")} bytes`);
		assert.match(text, /^search: "wide" — showing \d+ of 200 results \(Brave\)$/m);
		// Whatever the last entry is, it is a whole one: its description is intact.
		assert.ok(text.endsWith("lorem ipsum ".repeat(60).trim()), text.slice(-40));
	});

	it("fails a search with no key rather than calling Brave", async () => {
		const tool = registeredTools()[0] as unknown as RegisteredTool;
		const { fetch, calls } = fakeFetch(() => jsonResponse({}));

		const error = await withEnvKey(undefined, () =>
			withFetch(fetch, async () =>
				rejection(tool.execute("call-1", { query: "go generics" }, undefined, undefined, CTX)),
			),
		);

		assert.match(error.message, /BRAVE_API_KEY/);
		assert.equal(calls.length, 0);
	});

	it("is listed in the package manifest, so a fresh session loads it", () => {
		const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
			pi: { extensions: string[] };
		};
		assert.ok(manifest.pi.extensions.includes("./extensions/web-search/index.ts"), manifest.pi.extensions.join(", "));
	});
});

describe("the count and freshness parameters", () => {
	it("offers a bounded count and a freshness, both optional", () => {
		const { parameters } = registeredTools()[0] as unknown as RegisteredTool;

		assert.equal(parameters.properties.count?.type, "integer");
		assert.equal(parameters.properties.freshness?.type, "string");
		assert.deepEqual(parameters.required, ["query"]);
	});

	it("declares the range a count may take, so the model does not have to guess", () => {
		const { parameters } = registeredTools()[0] as unknown as RegisteredTool;
		const count = parameters.properties.count as { minimum?: number; maximum?: number } | undefined;

		assert.equal(count?.minimum, 1);
		assert.equal(count?.maximum, 20);
	});

	it("names every accepted recency form in the freshness description", () => {
		const { parameters } = registeredTools()[0] as unknown as RegisteredTool;
		const freshness = parameters.properties.freshness as { description?: string } | undefined;

		for (const form of ["pd", "pw", "pm", "py", "YYYY-MM-DDtoYYYY-MM-DD"]) {
			assert.ok(freshness?.description?.includes(form), `${form} missing from: ${freshness?.description}`);
		}
	});

	it("sends both to Brave and names the filter in the header", async () => {
		const tool = registeredTools()[0] as unknown as RegisteredTool;
		const found = { web: { results: [{ title: "T", url: "https://a.test/" }] } };
		const { fetch, calls } = fakeFetch(() => jsonResponse(found));

		const result = await withEnvKey("test-key", () =>
			withFetch(fetch, () =>
				tool.execute("call-1", { query: "rust", count: 3, freshness: "PW" }, undefined, undefined, CTX),
			),
		);

		const url = new URL(calls[0]?.url ?? "");
		assert.equal(url.searchParams.get("count"), "3");
		assert.equal(url.searchParams.get("freshness"), "pw");

		const content = result.content[0];
		const text = content?.type === "text" ? content.text : "";
		assert.match(text, /^search: "rust" — 1 result \(Brave · freshness=pw\)$/m);
	});

	it("searches for ten results with no recency filter when neither is given", async () => {
		const tool = registeredTools()[0] as unknown as RegisteredTool;
		const { fetch, calls } = fakeFetch(() => jsonResponse({ web: { results: [] } }));

		await withEnvKey("test-key", () =>
			withFetch(fetch, () => tool.execute("call-1", { query: "rust" }, undefined, undefined, CTX)),
		);

		const url = new URL(calls[0]?.url ?? "");
		assert.equal(url.searchParams.get("count"), "10");
		assert.equal(url.searchParams.get("freshness"), null);
	});

	it("rejects a malformed freshness rather than spending a search on it", async () => {
		const tool = registeredTools()[0] as unknown as RegisteredTool;
		const { fetch, calls } = fakeFetch(() => jsonResponse({}));

		const error = await withEnvKey("test-key", () =>
			withFetch(fetch, async () =>
				rejection(tool.execute("call-1", { query: "rust", freshness: "last tuesday" }, undefined, undefined, CTX)),
			),
		);

		assert.match(error.message, /pd.*pw.*pm.*py/);
		assert.match(error.message, /YYYY-MM-DDtoYYYY-MM-DD/);
		assert.equal(calls.length, 0);
	});

	it("rejects a count outside the supported range, naming the bounds", async () => {
		const tool = registeredTools()[0] as unknown as RegisteredTool;
		const { fetch, calls } = fakeFetch(() => jsonResponse({}));

		const error = await withEnvKey("test-key", () =>
			withFetch(fetch, async () =>
				rejection(tool.execute("call-1", { query: "rust", count: 50 }, undefined, undefined, CTX)),
			),
		);

		assert.match(error.message, /\b1\b.*\b20\b/);
		assert.equal(calls.length, 0);
	});
});

describe("a search that goes wrong, and one that simply finds nothing", () => {
	it("runs one search at a time, so the plan's rate limit cannot be tripped", () => {
		const tool = registeredTools()[0] as unknown as { executionMode?: string };
		assert.equal(tool.executionMode, "sequential");
	});

	it("returns an ordinary result when there are no matches, not an error", async () => {
		const tool = registeredTools()[0] as unknown as RegisteredTool;
		const { fetch } = fakeFetch(() => jsonResponse({ web: { results: [] } }));

		const result = await withEnvKey("test-key", () =>
			withFetch(fetch, () => tool.execute("call-1", { query: "quorble frimbus" }, undefined, undefined, CTX)),
		);

		const content = result.content[0];
		const text = content?.type === "text" ? content.text : "";
		assert.match(text, /^No results for "quorble frimbus"\./m);
		assert.deepEqual(result.details, { query: "quorble frimbus", resultCount: 0 });
	});

	it("tells the model what to do about a rejected key", async () => {
		const tool = registeredTools()[0] as unknown as RegisteredTool;
		const { fetch } = fakeFetch(() => new Response("Subscription token invalid", { status: 401 }));

		const error = await withEnvKey("stale-key", () =>
			withFetch(fetch, async () =>
				rejection(tool.execute("call-1", { query: "go generics" }, undefined, undefined, CTX)),
			),
		);

		assert.match(error.message, /BRAVE_API_KEY/);
		assert.match(error.message, /Subscription token invalid/);
		assert.ok(!error.message.includes("stale-key"), error.message);
	});
});
