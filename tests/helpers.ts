/**
 * Shared plumbing for the fidelity suite.
 *
 * Fixtures are real page bodies captured offline, so the tests exercise
 * `extract()` exactly as it runs in production without touching the network.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchedPage } from "../fetch.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Origins the fixtures were captured from, so relative links resolve as they did live. */
const FIXTURE_URLS: Record<string, string> = {
	"python-asyncio": "https://docs.python.org/3/library/asyncio.html",
	"github-readability": "https://github.com/mozilla/readability",
	"react-learn": "https://react.dev/learn",
	"wikipedia-transformer": "https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)",
	"go-tutorial": "https://go.dev/doc/tutorial/getting-started",
	"pypi-requests": "https://pypi.org/project/requests/",
	"hn-front": "https://news.ycombinator.com/",
	"mdn-fetch": "https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch",
	"claude-docs-prompt-caching": "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
};

/** Build the `FetchedPage` that `extract()` would have received for a fixture. */
export function loadFixture(name: string): FetchedPage {
	const buffer = readFileSync(join(FIXTURE_DIR, `${name}.html`));
	return {
		url: FIXTURE_URLS[name] ?? `https://example.test/${name}`,
		status: 200,
		contentType: "text/html",
		charset: "utf-8",
		body: buffer.toString("utf8"),
		bytes: buffer.byteLength,
		truncatedAtBytes: false,
	};
}

/** Raw fixture bytes, for tests that care about decoding rather than extraction. */
export function fixtureBytes(name: string): Uint8Array {
	return readFileSync(join(FIXTURE_DIR, `${name}.html`));
}

export interface Fence {
	/** Info string after the opening backticks, `""` when the block has no language. */
	lang: string;
	/** Body of the fence, without the delimiter lines and without a trailing newline. */
	code: string;
}

/** Fenced code blocks in document order. */
export function fences(markdown: string): Fence[] {
	const blocks: Fence[] = [];
	const lines = markdown.split("\n");

	for (let index = 0; index < lines.length; index++) {
		// A fence inside a list item is indented to the item's content column,
		// and its body is indented with it.
		const open = /^([ \t]*)(```+)(.*)$/.exec(lines[index] ?? "");
		if (!open) continue;

		const indent = open[1] as string;
		const delimiter = open[2] as string;
		const lang = (open[3] as string).trim();
		const close = new RegExp(`^[ \\t]*${delimiter}\\s*$`);
		const body: string[] = [];
		index++;

		while (index < lines.length && !close.test(lines[index] ?? "")) {
			const line = lines[index] as string;
			body.push(line.startsWith(indent) ? line.slice(indent.length) : line);
			index++;
		}
		blocks.push({ lang, code: body.join("\n") });
	}

	return blocks;
}

export interface Heading {
	level: number;
	text: string;
}

/** ATX headings outside fenced blocks (a `#` inside code is not a heading). */
export function headings(markdown: string): Heading[] {
	const found: Heading[] = [];
	let fenceDelimiter: string | undefined;

	for (const line of markdown.split("\n")) {
		const fence = /^(```+)/.exec(line);
		if (fence) {
			const delimiter = fence[1] as string;
			if (fenceDelimiter === undefined) fenceDelimiter = delimiter;
			else if (delimiter === fenceDelimiter) fenceDelimiter = undefined;
			continue;
		}
		if (fenceDelimiter !== undefined) continue;

		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) found.push({ level: (heading[1] as string).length, text: (heading[2] as string).trim() });
	}

	return found;
}

/** Backslash escapes Turndown adds to prose but that must never reach code. */
const ESCAPE_IN_CODE = /\\[[\]>*_]/;

/** True when any fence body contains markdown escaping, i.e. the code was mangled. */
export function hasEscapedMarkdownInFences(markdown: string): boolean {
	return fences(markdown).some((fence) => ESCAPE_IN_CODE.test(fence.code));
}

/** The fence bodies that contain markdown escaping — for readable assertion messages. */
export function escapedFences(markdown: string): string[] {
	return fences(markdown)
		.filter((fence) => ESCAPE_IN_CODE.test(fence.code))
		.map((fence) => fence.code);
}
