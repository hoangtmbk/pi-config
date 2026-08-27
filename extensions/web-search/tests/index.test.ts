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
		params: { query: string },
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
	try {
		return await body();
	} finally {
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
