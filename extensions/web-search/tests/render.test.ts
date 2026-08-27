/**
 * What a search looks like in the transcript.
 *
 * The renderers are driven exactly as pi drives them — the registered tool's
 * own `renderCall` and `renderResult`, a stand-in theme that adds no colour, and
 * a `Text` component read back as lines — so what is asserted here is the text a
 * reader actually sees, not an intermediate string.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import register from "../index.ts";
import type { WebSearchDetails } from "../index.ts";

/** Wide enough that nothing under test wraps, so a line is a line. */
const WIDTH = 200;

/** A theme that colours nothing: what is under test is the words, not the ANSI. */
const THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

interface Renderers {
	renderCall: (args: { query: string; count?: number; freshness?: string }, theme: Theme, context: unknown) => Component;
	renderResult: (
		result: AgentToolResult<WebSearchDetails>,
		options: { expanded: boolean; isPartial: boolean },
		theme: Theme,
		context: unknown,
	) => Component;
}

/** The renderers pi would call, taken off the registered tool. */
function renderers(): Renderers {
	const tools: unknown[] = [];
	register({ registerTool: (tool: unknown) => tools.push(tool) } as unknown as ExtensionAPI);
	return tools[0] as Renderers;
}

function lines(component: Component): string[] {
	return component.render(WIDTH).map((line) => line.trimEnd());
}

function call(args: { query: string; count?: number; freshness?: string }): string[] {
	return lines(renderers().renderCall(args, THEME, {}));
}

function result(
	details: WebSearchDetails | undefined,
	text: string,
	options: { expanded?: boolean; isPartial?: boolean } = {},
): string[] {
	const payload = { content: [{ type: "text" as const, text }], details } as AgentToolResult<WebSearchDetails>;
	return lines(
		renderers().renderResult(
			payload,
			{ expanded: options.expanded ?? false, isPartial: options.isPartial ?? false },
			THEME,
			{},
		),
	);
}

/** A finished search, with whatever of it a case cares about. */
function details(overrides: Partial<WebSearchDetails> = {}): WebSearchDetails {
	return {
		counts: [{ kind: "results", shown: 3, total: 3 }],
		shown: 3,
		total: 3,
		elapsedMs: 412,
		...overrides,
	};
}

describe("a search as it runs", () => {
	it("names the tool and the query", () => {
		assert.deepEqual(call({ query: "go generics" }), ["web_search go generics"]);
	});

	it("names the recency filter the search is narrowed by", () => {
		assert.deepEqual(call({ query: "go generics", freshness: "pw" }), ["web_search go generics · the past week"]);
	});

	it("spells out a date range rather than repeating Brave's wire form", () => {
		assert.deepEqual(call({ query: "rust", freshness: "2026-01-01to2026-03-31" }), [
			"web_search rust · 2026-01-01 to 2026-03-31",
		]);
	});

	it("says nothing about recency when the search is not narrowed", () => {
		assert.deepEqual(call({ query: "rust", freshness: "  " }), ["web_search rust"]);
	});

	it("says it is searching while the result is still partial", () => {
		assert.deepEqual(result(undefined, "", { isPartial: true }), ["Searching…"]);
	});
});

describe("a finished search", () => {
	it("reports how many results came back and how long it took", () => {
		assert.deepEqual(result(details(), "search: \"go\" — 3 results (Brave)"), ["3 results · 412ms"]);
	});

	it("reports each kind of hit separately when discussions are in play", () => {
		const summary = result(
			details({
				counts: [
					{ kind: "web", shown: 2, total: 2 },
					{ kind: "discussions", shown: 2, total: 2 },
				],
				shown: 4,
				total: 4,
				elapsedMs: 1_234,
			}),
			"",
		);
		assert.deepEqual(summary, ["2 web, 2 discussions · 1.2s"]);
	});

	it("says so when results were dropped to stay inside the budget", () => {
		const summary = result(
			details({ counts: [{ kind: "results", shown: 8, total: 200 }], shown: 8, total: 200 }),
			"",
		);
		assert.deepEqual(summary, ["showing 8 of 200 results · 412ms · 192 dropped to fit the budget"]);
	});

	it("reports a search that matched nothing as the ordinary answer it is", () => {
		assert.deepEqual(result(details({ counts: [], shown: 0, total: 0 }), ""), ["no results · 412ms"]);
	});

	it("falls back to the raw output when there is no metadata to render", () => {
		assert.deepEqual(result(undefined, "search: \"go\" — 3 results (Brave)"), ['search: "go" — 3 results (Brave)']);
	});
});

/** One rendered entry as `formatResults` writes it. */
function entry(index: number): string {
	return `${index}. Result ${index} — example.com\n   https://example.com/${index}\n   Something about it.`;
}

function list(count: number): string {
	const entries = Array.from({ length: count }, (_unused, index) => entry(index + 1));
	return `search: "wide" — ${count} results (Brave)\n\n---\n\n${entries.join("\n\n")}`;
}

describe("an expanded search", () => {
	it("shows the hit list under the summary", () => {
		const shown = result(details(), list(3), { expanded: true });
		assert.deepEqual(shown, [
			"3 results · 412ms",
			"1. Result 1 — example.com",
			"2. Result 2 — example.com",
			"3. Result 3 — example.com",
		]);
	});

	it("caps the hit list so one search cannot fill the transcript", () => {
		const shown = result(
			details({ counts: [{ kind: "results", shown: 20, total: 20 }], shown: 20, total: 20 }),
			list(20),
			{ expanded: true },
		);

		assert.equal(shown.length, 12, shown.join("\n"));
		assert.equal(shown[1], "1. Result 1 — example.com");
		assert.equal(shown[10], "10. Result 10 — example.com");
		assert.equal(shown[11], "… and 10 more");
	});

	it("shows what a search that found nothing said instead of a list", () => {
		const shown = result(details({ counts: [], shown: 0, total: 0 }), 'No results for "quorble".\nTry broader terms.', {
			expanded: true,
		});

		assert.deepEqual(shown, ["no results · 412ms", 'No results for "quorble".', "Try broader terms."]);
	});
});
