/**
 * Guards for the DOM cleanup `extract()` does before Readability runs.
 *
 * These use tiny inline pages rather than captured fixtures: each one isolates a
 * single rule, and each was written because a plausible version of that rule
 * destroyed real content.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extract, type Extracted } from "../extract.ts";
import type { FetchedPage } from "../fetch.ts";
import { headings } from "./helpers.ts";

/** The full extraction result for an inline page body. */
function extractOf(body: string): Extracted {
	const page: FetchedPage = {
		url: "https://example.test/page",
		status: 200,
		contentType: "text/html",
		charset: "utf-8",
		body,
		bytes: Buffer.byteLength(body),
		truncatedAtBytes: false,
	};
	return extract(page, false);
}

/** Article-mode markdown for an inline page body. */
function markdownOf(body: string): string {
	return extractOf(body).markdown;
}

/** The `|`-delimited lines of the markdown — the GFM table, if one was emitted. */
function tableRows(markdown: string): string[] {
	return markdown.split("\n").filter((line) => line.startsWith("|"));
}

/** A whole page around a table, so the fixtures below stay to the point. */
function pageWithTable(table: string): string {
	return `<!doctype html>
<html><head><title>Tables</title></head><body><h1>Tables</h1>${FILLER}${table}</body></html>`;
}

/** Enough prose that Readability returns an article rather than falling back. */
const FILLER =
	"<p>Transport security settings are read once at start-up and cached for the " +
	"lifetime of the process, so a change to any of them needs a restart before it " +
	"takes effect anywhere in the cluster. The defaults are safe for production.</p>";

describe("code-block chrome removal must not touch prose", () => {
	const markdown = markdownOf(`<!doctype html>
<html><head><title>Chrome removal</title></head><body>
<h1>Chrome removal</h1>
${FILLER}
<div class="code-example">
  <div class="example-header"><span class="language-name">js</span></div>
  <span class="copy-button">Copy</span>
  <button class="copy-button">Copy</button>
  <pre class="brush: js"><code>const x = 1;</code></pre>
</div>
<div class="body-copy"><p>Keep me</p></div>
<div class="language-namespace"><p>Keep this namespace note too</p></div>
</body></html>`);

	it("keeps a body-copy block sitting next to a code block", () => {
		assert.ok(markdown.includes("Keep me"), `body-copy prose deleted; got:\n${markdown}`);
	});

	it("keeps a class that merely starts with a label token", () => {
		assert.ok(
			markdown.includes("Keep this namespace note too"),
			`language-namespace prose deleted; got:\n${markdown}`,
		);
	});

	it("drops the copy control and the language label around the code", () => {
		assert.equal(markdown.includes("Copy"), false, `copy control leaked; got:\n${markdown}`);
		const stray = markdown.split("\n").filter((line) => line.trim() === "js");
		assert.deepEqual(stray, [], `language label leaked as a stray line; got:\n${markdown}`);
	});

	it("still fences the code with its language", () => {
		assert.ok(markdown.includes("```js\nconst x = 1;\n```"), `code block mangled; got:\n${markdown}`);
	});
});

describe("the article's own top heading survives Readability", () => {
	// Readability deletes the first h1/h2 whose text similarity to the page title
	// exceeds 0.75. A title that is the heading plus a few more words scores 1.0,
	// so the heading goes even though the two are not the same string.
	const markdown = markdownOf(`<!doctype html>
<html><head><title>Configuring TLS for the gateway</title></head><body>
<header><p>Example Docs</p></header>
<main>
<h1>Configuring TLS</h1>
${FILLER}
${FILLER}
</main>
</body></html>`);

	it("keeps the h1 that differs from the page title", () => {
		assert.ok(/^#+ Configuring TLS$/m.test(markdown), `h1 deleted; got:\n${markdown}`);
	});
});

describe("a heading in page chrome is not restored", () => {
	const markdown = markdownOf(`<!doctype html>
<html><head><title>Example Docs — the documentation site</title></head><body>
<header><h1>Example Docs</h1></header>
<main>
${FILLER}
${FILLER}
</main>
</body></html>`);

	it("leaves the site name out of the article", () => {
		assert.equal(markdown.includes("Example Docs"), false, `chrome heading restored; got:\n${markdown}`);
	});
});

describe("tables — layout is unwrapped, data becomes GFM", () => {
	it("unwraps a table nested inside another table into its cell", () => {
		// The outer table is data-shaped and stays one; the inner one is a layout
		// grid whatever its shape, and a GFM cell could not hold a table anyway.
		const markdown = markdownOf(
			pageWithTable(`<table><tr><td>
				<table><tr><td>inner a</td><td>inner b</td></tr><tr><td>inner c</td><td>inner d</td></tr></table>
			</td><td>outer right</td></tr><tr><td>row two</td><td>cell</td></tr></table>`),
		);
		assert.deepEqual(tableRows(markdown), [
			"| inner a inner b inner c inner d | outer right |",
			"| --- | --- |",
			"| row two | cell |",
		]);
	});

	it("unwraps a single-row table", () => {
		const markdown = markdownOf(pageWithTable("<table><tr><td>left</td><td>right</td></tr></table>"));
		assert.ok(markdown.includes("left"), `cell lost; got:\n${markdown}`);
		assert.deepEqual(tableRows(markdown), [], `single-row table rendered as GFM; got:\n${markdown}`);
	});

	it("unwraps a single-column table", () => {
		const markdown = markdownOf(
			pageWithTable("<table><tr><td>one</td></tr><tr><td>two</td></tr><tr><td>three</td></tr></table>"),
		);
		for (const cell of ["one", "two", "three"]) {
			assert.ok(markdown.includes(cell), `cell ${cell} lost; got:\n${markdown}`);
		}
		assert.deepEqual(tableRows(markdown), [], `single-column table rendered as GFM; got:\n${markdown}`);
	});

	it("renders a td-only data table, its first row as the header", () => {
		// GFM has no way to render a table with no header row, and the first row
		// of a td-only table is what a browser shows on top: it is the header.
		const markdown = markdownOf(
			pageWithTable("<table><tr><td>Name</td><td>Port</td></tr><tr><td>http</td><td>80</td></tr></table>"),
		);
		assert.deepEqual(tableRows(markdown), ["| Name | Port |", "| --- | --- |", "| http | 80 |"]);
	});

	it("uses a th row as the header row", () => {
		const markdown = markdownOf(
			pageWithTable("<table><tr><th>Name</th><th>Port</th></tr><tr><td>http</td><td>80</td></tr></table>"),
		);
		assert.deepEqual(tableRows(markdown), ["| Name | Port |", "| --- | --- |", "| http | 80 |"]);
	});

	it("emits an empty header row when the th cells label the rows", () => {
		// `<th>` below the first row means the table labels its rows, so no row of
		// it is a header — and stealing the first one would hide that row's data.
		const markdown = markdownOf(
			pageWithTable("<table><tr><th>Name</th><td>Ada</td></tr><tr><th>Born</th><td>1815</td></tr></table>"),
		);
		assert.deepEqual(tableRows(markdown), [
			"| | |",
			"| --- | --- |",
			"| Name | Ada |",
			"| Born | 1815 |",
		]);
	});

	it("puts the caption on a bold line above the table", () => {
		const markdown = markdownOf(
			pageWithTable(
				"<table><caption>Well-known ports</caption><tr><th>Name</th><th>Port</th></tr>" +
					"<tr><td>http</td><td>80</td></tr></table>",
			),
		);
		assert.ok(markdown.includes("**Well-known ports**"), `caption lost; got:\n${markdown}`);
		assert.deepEqual(tableRows(markdown), ["| Name | Port |", "| --- | --- |", "| http | 80 |"]);
	});

	it("pads a colspan with the empty cells it covers", () => {
		const markdown = markdownOf(
			pageWithTable(
				"<table><tr><th>Name</th><th>Port</th><th>Notes</th></tr>" +
					"<tr><td colspan=\"3\">none of the above</td></tr>" +
					"<tr><td>http</td><td>80</td><td>plaintext</td></tr></table>",
			),
		);
		assert.deepEqual(tableRows(markdown), [
			"| Name | Port | Notes |",
			"| --- | --- | --- |",
			"| none of the above |  |  |",
			"| http | 80 | plaintext |",
		]);
	});

	it("keeps a link inside a cell", () => {
		const markdown = markdownOf(
			pageWithTable(
				'<table><tr><th>Name</th><th>Spec</th></tr>' +
					'<tr><td>http</td><td><a href="/rfc/9110">RFC 9110</a></td></tr></table>',
			),
		);
		assert.ok(
			markdown.includes("[RFC 9110](https://example.test/rfc/9110)"),
			`link in cell lost; got:\n${markdown}`,
		);
	});
});

describe("heading text loses its permalink debris", () => {
	const markdown = markdownOf(`<!doctype html>
<html><head><title>Debris</title></head><body>
<h1>Debris</h1>
${FILLER}
<h2>Hash heading#</h2>
<h2>Pilcrow heading\u00b6</h2>
<h2>Zero width heading\u200b</h2>
<h2>Editable heading<span class="mw-editsection">[edit]</span></h2>
<h2>Sphinx heading<a class="headerlink" href="#sphinx">\u00b6</a></h2>
${FILLER}
</body></html>`);

	for (const text of [
		"Hash heading",
		"Pilcrow heading",
		"Zero width heading",
		"Editable heading",
		"Sphinx heading",
	]) {
		it(`ends "${text}" cleanly`, () => {
			assert.ok(
				headings(markdown).some((heading) => heading.text === text),
				`headings: ${JSON.stringify(headings(markdown))}`,
			);
		});
	}
});

describe("kept ratio", () => {
	it("is 1 when the whole page is converted", () => {
		const extracted = extractOf(
			"<!doctype html><html><head><title>Short</title></head><body><p>Too short for Readability.</p></body></html>",
		);
		assert.equal(extracted.mode, "full-page");
		assert.equal(extracted.keptRatio, 1);
	});

	it("reports the share Readability kept of an article page", () => {
		const extracted = extractOf(`<!doctype html>
<html><head><title>Ratios</title></head><body>
<nav><a href="/a">One</a> <a href="/b">Two</a> <a href="/c">Three</a></nav>
<main><h1>Ratios</h1>${FILLER}${FILLER}</main>
</body></html>`);
		assert.equal(extracted.mode, "article");
		assert.ok(extracted.keptRatio > 0.4 && extracted.keptRatio <= 1, `keptRatio: ${extracted.keptRatio}`);
	});

	it("falls back to the full page when Readability keeps under 40% of an unmarked page", () => {
		// No `<main>`, and the bulk of the text is in a region Readability throws
		// away — exactly the shape that used to return a sidebar as the article.
		const aside = Array.from({ length: 40 }, (_unused, index) => `<li>Related story ${index} about the topic</li>`).join("");
		const extracted = extractOf(`<!doctype html>
<html><head><title>Sidebar wins</title></head><body>
<div class="article"><h1>Sidebar wins</h1>${FILLER}</div>
<div class="sidebar"><ul>${aside}</ul></div>
</body></html>`);
		assert.equal(extracted.mode, "full-page");
		assert.ok(extracted.markdown.includes("Related story 39"), `sidebar text lost; got:\n${extracted.markdown}`);
	});
});

describe("a body-less fragment converts whole", () => {
	const markdown = markdownOf("<h2>Fragment</h2><p>first</p><p>second</p><pre>fragment code</pre>");

	it("keeps every top-level element", () => {
		assert.ok(markdown.includes("## Fragment"), `heading lost; got: ${JSON.stringify(markdown)}`);
		assert.ok(markdown.includes("first"), `first paragraph lost; got: ${JSON.stringify(markdown)}`);
		assert.ok(markdown.includes("second"), `second paragraph lost; got: ${JSON.stringify(markdown)}`);
		assert.ok(markdown.includes("```\nfragment code\n```"), `code lost; got: ${JSON.stringify(markdown)}`);
	});
});
