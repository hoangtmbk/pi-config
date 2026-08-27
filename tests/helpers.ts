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
	const url = FIXTURE_URLS[name] ?? `https://example.test/${name}`;
	return {
		url,
		requestedUrl: url,
		status: 200,
		contentType: "text/html",
		kind: "html",
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

/**
 * The smallest PDF PDF.js accepts, one line of text per page, built byte by
 * byte: catalog, page tree, one Helvetica font, and a text-showing content
 * stream per page, with a cross-reference table whose offsets are computed from
 * the serialised output. Each line is drawn with `Tj` so it lands in the text layer.
 */
export function makePdf(pageTexts: string[], title?: string): Uint8Array {
	// Object ids: 1 catalog, 2 page tree, 3 font, then page/content pairs.
	const pageIds = pageTexts.map((_, index) => 4 + index * 2);
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	for (const [index, text] of pageTexts.entries()) {
		const stream = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`;
		objects.push(
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
				`/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index]! + 1} 0 R >>`,
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		);
	}

	if (title !== undefined) objects.push(`<< /Title (${title}) >>`);
	const infoId = title === undefined ? undefined : objects.length;

	// ASCII only, so string length is the byte offset each xref entry needs.
	let pdf = "%PDF-1.4\n";
	const offsets = objects.map((object, index) => {
		const offset = pdf.length;
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return offset;
	});
	const startxref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	const info = infoId === undefined ? "" : ` /Info ${infoId} 0 R`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${info} >>\nstartxref\n${startxref}\n%%EOF\n`;
	return new TextEncoder().encode(pdf);
}
