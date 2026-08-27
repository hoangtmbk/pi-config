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
import { classifyPage, type FetchedPage, WebFetchError } from "../fetch.ts";
import { headings, makePdf } from "./helpers.ts";

/** The error a promise rejects with, so the assertion can be about the error itself. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected the call to reject");
}

/** The full extraction result for an inline page body. */
async function extractOf(body: string, raw = false): Promise<Extracted> {
	const page: FetchedPage = {
		url: "https://example.test/page",
		requestedUrl: "https://example.test/page",
		status: 200,
		contentType: "text/html",
		kind: "html",
		charset: "utf-8",
		body,
		bytes: Buffer.byteLength(body),
		truncatedAtBytes: false,
	};
	return await extract(page, raw);
}

/** Article-mode markdown for an inline page body. */
async function markdownOf(body: string): Promise<string> {
	return (await extractOf(body)).markdown;
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

describe("code-block chrome removal must not touch prose", async () => {
	const markdown = await markdownOf(`<!doctype html>
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

	it("keeps a body-copy block sitting next to a code block", async () => {
		assert.ok(markdown.includes("Keep me"), `body-copy prose deleted; got:\n${markdown}`);
	});

	it("keeps a class that merely starts with a label token", async () => {
		assert.ok(
			markdown.includes("Keep this namespace note too"),
			`language-namespace prose deleted; got:\n${markdown}`,
		);
	});

	it("drops the copy control and the language label around the code", async () => {
		assert.equal(markdown.includes("Copy"), false, `copy control leaked; got:\n${markdown}`);
		const stray = markdown.split("\n").filter((line) => line.trim() === "js");
		assert.deepEqual(stray, [], `language label leaked as a stray line; got:\n${markdown}`);
	});

	it("still fences the code with its language", async () => {
		assert.ok(markdown.includes("```js\nconst x = 1;\n```"), `code block mangled; got:\n${markdown}`);
	});
});

describe("the article's own top heading survives Readability", async () => {
	// Readability deletes the first h1/h2 whose text similarity to the page title
	// exceeds 0.75. A title that is the heading plus a few more words scores 1.0,
	// so the heading goes even though the two are not the same string.
	const markdown = await markdownOf(`<!doctype html>
<html><head><title>Configuring TLS for the gateway</title></head><body>
<header><p>Example Docs</p></header>
<main>
<h1>Configuring TLS</h1>
${FILLER}
${FILLER}
</main>
</body></html>`);

	it("keeps the h1 that differs from the page title", async () => {
		assert.ok(/^#+ Configuring TLS$/m.test(markdown), `h1 deleted; got:\n${markdown}`);
	});
});

describe("a heading in page chrome is not restored", async () => {
	const markdown = await markdownOf(`<!doctype html>
<html><head><title>Example Docs — the documentation site</title></head><body>
<header><h1>Example Docs</h1></header>
<main>
${FILLER}
${FILLER}
</main>
</body></html>`);

	it("leaves the site name out of the article", async () => {
		assert.equal(markdown.includes("Example Docs"), false, `chrome heading restored; got:\n${markdown}`);
	});
});

describe("tables — layout is unwrapped, data becomes GFM", async () => {
	it("unwraps a table nested inside another table into its cell", async () => {
		// The outer table is data-shaped and stays one; the inner one is a layout
		// grid whatever its shape, and a GFM cell could not hold a table anyway.
		const markdown = await markdownOf(
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

	it("unwraps a single-row table", async () => {
		const markdown = await markdownOf(pageWithTable("<table><tr><td>left</td><td>right</td></tr></table>"));
		assert.ok(markdown.includes("left"), `cell lost; got:\n${markdown}`);
		assert.deepEqual(tableRows(markdown), [], `single-row table rendered as GFM; got:\n${markdown}`);
	});

	it("unwraps a single-column table", async () => {
		const markdown = await markdownOf(
			pageWithTable("<table><tr><td>one</td></tr><tr><td>two</td></tr><tr><td>three</td></tr></table>"),
		);
		for (const cell of ["one", "two", "three"]) {
			assert.ok(markdown.includes(cell), `cell ${cell} lost; got:\n${markdown}`);
		}
		assert.deepEqual(tableRows(markdown), [], `single-column table rendered as GFM; got:\n${markdown}`);
	});

	it("renders a td-only data table, its first row as the header", async () => {
		// GFM has no way to render a table with no header row, and the first row
		// of a td-only table is what a browser shows on top: it is the header.
		const markdown = await markdownOf(
			pageWithTable("<table><tr><td>Name</td><td>Port</td></tr><tr><td>http</td><td>80</td></tr></table>"),
		);
		assert.deepEqual(tableRows(markdown), ["| Name | Port |", "| --- | --- |", "| http | 80 |"]);
	});

	it("uses a th row as the header row", async () => {
		const markdown = await markdownOf(
			pageWithTable("<table><tr><th>Name</th><th>Port</th></tr><tr><td>http</td><td>80</td></tr></table>"),
		);
		assert.deepEqual(tableRows(markdown), ["| Name | Port |", "| --- | --- |", "| http | 80 |"]);
	});

	it("emits an empty header row when the th cells label the rows", async () => {
		// `<th>` below the first row means the table labels its rows, so no row of
		// it is a header — and stealing the first one would hide that row's data.
		const markdown = await markdownOf(
			pageWithTable("<table><tr><th>Name</th><td>Ada</td></tr><tr><th>Born</th><td>1815</td></tr></table>"),
		);
		assert.deepEqual(tableRows(markdown), [
			"| | |",
			"| --- | --- |",
			"| Name | Ada |",
			"| Born | 1815 |",
		]);
	});

	it("puts the caption on a bold line above the table", async () => {
		const markdown = await markdownOf(
			pageWithTable(
				"<table><caption>Well-known ports</caption><tr><th>Name</th><th>Port</th></tr>" +
					"<tr><td>http</td><td>80</td></tr></table>",
			),
		);
		assert.ok(markdown.includes("**Well-known ports**"), `caption lost; got:\n${markdown}`);
		assert.deepEqual(tableRows(markdown), ["| Name | Port |", "| --- | --- |", "| http | 80 |"]);
	});

	it("pads a colspan with the empty cells it covers", async () => {
		const markdown = await markdownOf(
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

	it("keeps a link inside a cell", async () => {
		const markdown = await markdownOf(
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

describe("heading text loses its permalink debris but keeps its own punctuation", async () => {
	const markdown = await markdownOf(`<!doctype html>
<html><head><title>Debris</title></head><body>
<h1>Debris</h1>
${FILLER}
<h2>C#</h2>
<h2>F#</h2>
<h2>C# #</h2>
<h2>Issue#</h2>
<h2>Spaced hash #</h2>
<h2>Spaced pilcrow \u00b6</h2>
<h2>Zero width heading\u200b</h2>
<h2>Anchored heading<a class="anchor" href="#anchored">#</a></h2>
<h2>Spanned heading<span class="permalink">#</span></h2>
<h2>Editable heading<span class="mw-editsection">[edit]</span></h2>
<h2>Sphinx heading<a class="headerlink" href="#sphinx">\u00b6</a></h2>
${FILLER}
</body></html>`);

	// A `#` welded to a word is part of the word. A `#` the text sets off with a
	// space, or one sitting alone in its own element, is a permalink label.
	for (const [source, expected] of [
		["C#", "C#"],
		["F#", "F#"],
		["C# #", "C#"],
		["Issue#", "Issue#"],
		["Spaced hash #", "Spaced hash"],
		["Spaced pilcrow \u00b6", "Spaced pilcrow"],
		["Zero width heading\u200b", "Zero width heading"],
		["Anchored heading#", "Anchored heading"],
		["Spanned heading#", "Spanned heading"],
		["Editable heading[edit]", "Editable heading"],
		["Sphinx heading\u00b6", "Sphinx heading"],
	] as const) {
		it(`renders ${JSON.stringify(source)} as ${JSON.stringify(expected)}`, async () => {
			assert.ok(
				headings(markdown).some((heading) => heading.text === expected),
				`headings: ${JSON.stringify(headings(markdown))}`,
			);
		});
	}

	it("invents no heading that lost its text", async () => {
		const empty = headings(markdown).filter((heading) => heading.text === "");
		assert.deepEqual(empty, []);
	});
});

describe("kept ratio", async () => {
	it("is 1 when the whole page is converted", async () => {
		const extracted = await extractOf(
			"<!doctype html><html><head><title>Short</title></head><body><p>Too short for Readability.</p></body></html>",
		);
		assert.equal(extracted.mode, "full-page");
		assert.equal(extracted.keptRatio, 1);
	});

	it("reports the share Readability kept of an article page", async () => {
		const extracted = await extractOf(`<!doctype html>
<html><head><title>Ratios</title></head><body>
<nav><a href="/a">One</a> <a href="/b">Two</a> <a href="/c">Three</a></nav>
<main><h1>Ratios</h1>${FILLER}${FILLER}</main>
</body></html>`);
		assert.equal(extracted.mode, "article");
		assert.ok(extracted.keptRatio > 0.4 && extracted.keptRatio <= 1, `keptRatio: ${extracted.keptRatio}`);
	});

	it("falls back to the full page when Readability keeps under 40% of an unmarked page", async () => {
		// No `<main>`, and the bulk of the text is in a region Readability throws
		// away — exactly the shape that used to return a sidebar as the article.
		const aside = Array.from({ length: 40 }, (_unused, index) => `<li>Related story ${index} about the topic</li>`).join("");
		const extracted = await extractOf(`<!doctype html>
<html><head><title>Sidebar wins</title></head><body>
<div class="article"><h1>Sidebar wins</h1>${FILLER}</div>
<div class="sidebar"><ul>${aside}</ul></div>
</body></html>`);
		assert.equal(extracted.mode, "full-page");
		assert.ok(extracted.markdown.includes("Related story 39"), `sidebar text lost; got:\n${extracted.markdown}`);
	});
});

describe("raw mode converts the whole body", async () => {
	// An index page: the navigation *is* the content, which is the case `raw`
	// exists for. The automatic fallback is allowed to drop it; `raw` is not.
	const INDEX_PAGE = `<!doctype html>
<html><head><title>Directory</title></head><body>
<header><p>Example Directory</p></header>
<nav><a href="/pages/alpha">Alpha page</a> <a href="/pages/beta">Beta page</a></nav>
<main><p>Two pages are listed.</p></main>
<footer><p>Footer contact line.</p></footer>
</body></html>`;

	it("keeps the nav links and the footer", async () => {
		const extracted = await extractOf(INDEX_PAGE, true);
		assert.equal(extracted.mode, "full-page");
		assert.ok(
			extracted.markdown.includes("[Alpha page](https://example.test/pages/alpha)"),
			`nav link lost; got:\n${extracted.markdown}`,
		);
		assert.ok(extracted.markdown.includes("Footer contact line."), `footer lost; got:\n${extracted.markdown}`);
		assert.ok(extracted.markdown.includes("Example Directory"), `header lost; got:\n${extracted.markdown}`);
		assert.equal(extracted.keptRatio, 1);
	});

	it("still cleans what is markup rather than content", async () => {
		const extracted = await extractOf(
			`<!doctype html><html><head><title>Raw</title></head><body>
<script>var tracking = 1;</script><h1>Raw</h1><pre class="language-js">const x = 1;</pre>
<a href="/docs?utm_source=news">Docs</a></body></html>`,
			true,
		);
		assert.equal(extracted.markdown.includes("var tracking"), false, `script leaked; got:\n${extracted.markdown}`);
		assert.ok(extracted.markdown.includes("```js\nconst x = 1;\n```"), `code mangled; got:\n${extracted.markdown}`);
		assert.ok(
			extracted.markdown.includes("[Docs](https://example.test/docs)"),
			`link not cleaned; got:\n${extracted.markdown}`,
		);
	});

	it("is the only path that keeps chrome — the automatic fallback drops it", async () => {
		const extracted = await extractOf(INDEX_PAGE);
		assert.equal(extracted.mode, "full-page");
		assert.ok(extracted.markdown.includes("Two pages are listed."), `content lost; got:\n${extracted.markdown}`);
		assert.equal(extracted.markdown.includes("Alpha page"), false, `nav kept; got:\n${extracted.markdown}`);
		assert.equal(extracted.markdown.includes("Footer contact"), false, `footer kept; got:\n${extracted.markdown}`);
	});
});

describe("a body-less fragment converts whole", async () => {
	const markdown = await markdownOf("<h2>Fragment</h2><p>first</p><p>second</p><pre>fragment code</pre>");

	it("keeps every top-level element", async () => {
		assert.ok(markdown.includes("## Fragment"), `heading lost; got: ${JSON.stringify(markdown)}`);
		assert.ok(markdown.includes("first"), `first paragraph lost; got: ${JSON.stringify(markdown)}`);
		assert.ok(markdown.includes("second"), `second paragraph lost; got: ${JSON.stringify(markdown)}`);
		assert.ok(markdown.includes("```\nfragment code\n```"), `code lost; got: ${JSON.stringify(markdown)}`);
	});
});

/** A `FetchedPage` for a payload that is not HTML. */
function pageOf(url: string, contentType: string, body: string, bytesBody?: Uint8Array): FetchedPage {
	return {
		url,
		requestedUrl: url,
		status: 200,
		contentType,
		kind: classifyPage(contentType, body),
		charset: "utf-8",
		body,
		bytes: bytesBody?.byteLength ?? Buffer.byteLength(body),
		truncatedAtBytes: false,
		...(bytesBody ? { bytesBody } : {}),
	};
}

describe("JSON from a host with a renderer is rendered, not dumped", async () => {
	const packument = {
		name: "turndown",
		"dist-tags": { latest: "7.2.0" },
		description: "A library that converts HTML to Markdown",
		license: "MIT",
		versions: { "7.1.1": { version: "7.1.1" }, "7.2.0": { version: "7.2.0" } },
		time: { "7.1.1": "2022-06-11T00:00:00.000Z", "7.2.0": "2024-11-05T00:00:00.000Z" },
		readme: "# Turndown\n\nConverts HTML into markdown.",
	};
	const extracted = await extract(
		pageOf("https://registry.npmjs.org/turndown", "application/json", JSON.stringify(packument)),
		false,
	);

	it("keeps the mode json and titles the page from the rendered heading", () => {
		assert.equal(extracted.mode, "json");
		assert.equal(extracted.title, "turndown 7.2.0");
	});

	it("renders the fields a reader wants", () => {
		assert.match(extracted.markdown, /^# turndown 7\.2\.0/);
		assert.match(extracted.markdown, /A library that converts HTML to Markdown/);
		assert.match(extracted.markdown, /- 7\.2\.0 — 2024-11-05/);
		assert.match(extracted.markdown, /Converts HTML into markdown\./);
	});

	it("leaves the raw JSON out entirely", () => {
		assert.ok(!extracted.markdown.includes('"dist-tags"'), extracted.markdown);
		assert.ok(!extracted.markdown.includes("{"), extracted.markdown);
	});
});

describe("a StackExchange payload's HTML bodies go through the page pipeline", async () => {
	const question = {
		items: [{ title: "How do I read a file?", score: 3, answer_count: 1, body: "<p>I have a <em>file</em>.</p>" }],
		answers: [
			{
				score: 12,
				is_accepted: true,
				body: '<p>Like this:</p><pre class="lang-js"><code>const x = fs.readFileSync("f");</code></pre>',
			},
		],
	};
	const extracted = await extract(
		pageOf("https://api.stackexchange.com/2.3/questions/1", "application/json", JSON.stringify(question)),
		false,
	);

	it("converts the answer body to markdown, fenced with its language", () => {
		assert.equal(extracted.mode, "json");
		assert.equal(extracted.title, "How do I read a file?");
		assert.match(extracted.markdown, /## Answer \(score 12, accepted\)/);
		assert.match(extracted.markdown, /```js\nconst x = fs\.readFileSync\("f"\);\n```/);
	});

	it("does not escape the code it converted", () => {
		assert.ok(!extracted.markdown.includes('\\"'), extracted.markdown);
	});
});

describe("JSON no renderer knows still pretty-prints", async () => {
	const extracted = await extract(
		pageOf("https://example.test/data.json", "application/json", '{"b":[1,2],"a":{"deep":true}}'),
		false,
	);

	it("keeps the document, indented", () => {
		assert.equal(extracted.mode, "json");
		assert.equal(extracted.title, undefined);
		assert.equal(extracted.markdown, '{\n  "b": [\n    1,\n    2\n  ],\n  "a": {\n    "deep": true\n  }\n}');
	});
});

describe("PDF bytes become text", async () => {
	const bytes = makePdf(["Hello PDF, this is page one.", "And this is page two."], "The Paper");
	const extracted = await extract(pageOf("https://example.test/paper.pdf", "application/pdf", "", bytes), false);

	it("reports the pdf mode and the document's own title", () => {
		assert.equal(extracted.mode, "pdf");
		assert.equal(extracted.title, "The Paper");
		assert.equal(extracted.keptRatio, 1);
	});

	it("returns every page, separated by a page marker", () => {
		assert.match(extracted.markdown, /Hello PDF, this is page one\./);
		assert.match(extracted.markdown, /<!-- page 2 -->/);
		assert.match(extracted.markdown, /And this is page two\./);
		// Nothing was dropped, so nothing is announced.
		assert.ok(!extracted.markdown.startsWith("pages:"), extracted.markdown);
	});

	it("reports a PDF with no text layer as a fetch error", async () => {
		const blank = makePdf(["hi"]);
		const error = await rejection(
			extract(pageOf("https://example.test/scan.pdf", "application/pdf", "", blank), false),
		);
		assert.ok(error instanceof WebFetchError, `expected a WebFetchError, got ${error.constructor.name}`);
		assert.match(error.message, /Could not read the PDF at https:\/\/example\.test\/scan\.pdf: .*no extractable text/);
	});

	it("refuses a PDF response that carried no bytes", async () => {
		const error = await rejection(extract(pageOf("https://example.test/empty.pdf", "application/pdf", ""), false));
		assert.ok(error instanceof WebFetchError, `expected a WebFetchError, got ${error.constructor.name}`);
		assert.match(error.message, /No PDF data at https:\/\/example\.test\/empty\.pdf/);
	});
});

describe("a PDF cut off at the byte ceiling says so", async () => {
	/** A page whose download hit the 10 MB ceiling, so the bytes are a prefix of the document. */
	function cutPage(bytes: Uint8Array): FetchedPage {
		const page = pageOf("https://example.test/huge.pdf", "application/pdf", "", bytes);
		page.truncatedAtBytes = true;
		return page;
	}

	it("warns above the text when the prefix still parses", async () => {
		const extracted = await extract(cutPage(makePdf(["Hello PDF, this is page one."])), false);

		assert.equal(extracted.mode, "pdf");
		assert.equal(
			extracted.markdown.split("\n")[0],
			"warning: PDF download cut at 10 MB — text below is partial",
		);
		assert.match(extracted.markdown, /Hello PDF, this is page one\./);
	});

	it("blames the size, not the file, when the prefix cannot be parsed", async () => {
		// PDF.js reads the cross-reference table at the end of the file, which is
		// exactly what a truncated download is missing.
		const whole = makePdf(["Hello PDF, this is page one."]);
		const error = await rejection(extract(cutPage(whole.subarray(0, Math.floor(whole.length / 2))), false));

		assert.ok(error instanceof WebFetchError, `expected a WebFetchError, got ${error.constructor.name}`);
		assert.equal(error.message, "PDF download cut at 10 MB and could not be parsed: https://example.test/huge.pdf");
	});

	it("still says the file is unreadable when nothing was cut", async () => {
		const whole = makePdf(["Hello PDF, this is page one."]);
		const half = pageOf("https://example.test/broken.pdf", "application/pdf", "", whole.subarray(0, 40));
		const error = await rejection(extract(half, false));

		assert.match(error.message, /^Could not read the PDF at https:\/\/example\.test\/broken\.pdf/);
	});
});

describe("a renderer that fails costs only the rendering", async () => {
	it("pretty-prints rather than dropping to text mode", async () => {
		// The renderer stage is reached with the page's own URL; when anything in
		// it throws — here, a URL that cannot be parsed at all — the document is
		// still JSON and must still be presented as JSON.
		const extracted = await extract(pageOf("not a url", "application/json", '{"name":"turndown"}'), false);

		assert.equal(extracted.mode, "json");
		assert.equal(extracted.markdown, '{\n  "name": "turndown"\n}');
	});

	it("renders around a field it cannot use rather than throwing", async () => {
		// StackExchange host and shape, but the body is an object where the
		// renderer expects HTML. The field is dropped; the question is not.
		const payload = { items: [{ title: "Half a question", body: { not: "html" } }] };
		const extracted = await extract(
			pageOf("https://api.stackexchange.com/2.3/questions/1", "application/json", JSON.stringify(payload)),
			false,
		);

		assert.equal(extracted.mode, "json");
		assert.equal(extracted.title, "Half a question");
		assert.ok(!extracted.markdown.includes("[object Object]"), extracted.markdown);
	});
});

describe("every body the fetch layer accepted is extractable", async () => {
	// `fetchPage` refuses binaries by header before the download and by sniffing
	// the first kilobyte after it, so whatever reaches `extract()` is text. A
	// second, narrower content-type list here used to fetch these, decode them,
	// and then throw `Cannot extract text from …`.
	for (const type of ["application/octet-stream", "application/ecmascript", "application/x-ndjson", ""]) {
		it(`extracts a text body declared ${JSON.stringify(type) || "with no type"} as text`, async () => {
			const body = 'export const answer = 42;\n{"line":1}\n';
			const extracted = await extract(pageOf("https://example.test/raw/file", type, body), false);

			assert.equal(extracted.mode, "text");
			assert.equal(extracted.markdown, body.trim());
		});
	}

	it("still treats an octet-stream page that is HTML as HTML", async () => {
		const body = `<!doctype html><html><head><title>Shrug</title></head><body><h1>Shrug</h1>${FILLER}</body></html>`;
		const extracted = await extract(pageOf("https://example.test/page", "application/octet-stream", body), false);

		assert.ok(extracted.markdown.includes("# Shrug"), `not parsed as HTML; got:\n${extracted.markdown}`);
	});

	it("does not sniff a body the server declared as plain text", async () => {
		const body = "<p>This is a snippet of HTML, quoted verbatim in a .txt file.</p>";
		const extracted = await extract(pageOf("https://example.test/notes.txt", "text/plain", body), false);

		assert.equal(extracted.mode, "text");
		assert.equal(extracted.markdown, body);
	});
});

describe("a form is a container, not a control", async () => {
	// Classic ASP.NET WebForms: the whole page body lives inside one `<form>`.
	const extracted = await extractOf(`<!doctype html>
<html><head><title>WebForms</title></head><body>
<form method="post" action="/Default.aspx" id="aspnetForm">
<h1>Release notes</h1>
${FILLER}
<label>Search</label><input type="text" name="q"><select name="v"><option>3.1</option></select>
<textarea name="notes">draft</textarea><button type="submit">Go</button>
</form>
</body></html>`);

	it("keeps the prose the form wrapped", async () => {
		assert.ok(extracted.markdown.includes("Transport security settings"), `body lost; got:\n${extracted.markdown}`);
		assert.ok(/^#+ Release notes$/m.test(extracted.markdown), `heading lost; got:\n${extracted.markdown}`);
	});

	it("drops the interactive controls", async () => {
		for (const control of ["Go", "draft", "3.1"]) {
			assert.equal(extracted.markdown.includes(control), false, `${control} leaked; got:\n${extracted.markdown}`);
		}
	});
});

describe("the kept ratio counts what the DOM cleanup removed", async () => {
	it("falls below 1 when cleanup deleted text, not just when Readability did", async () => {
		// Measured before the cleanup, so a deletion is visible; scripts are not,
		// since their bodies are not text anyone reads.
		const extracted = await extractOf(`<!doctype html>
<html><head><title>Cleanup</title></head><body>
<script>var noise = "${"x".repeat(400)}";</script>
<p>${"Kept prose. ".repeat(20)}</p>
<nav class="skip-to-content"><a href="#main">Skip to content</a></nav>
<div class="copy-button">${"Discarded control text. ".repeat(5)}</div>
</body></html>`);

		// 240 characters of prose against 120 of deleted control text and a 15
		// character jump link: ~0.64. Were the 400 characters of script counted in
		// the denominator too, it would be ~0.31.
		assert.ok(extracted.keptRatio < 0.9, `cleanup losses invisible: keptRatio ${extracted.keptRatio}`);
		assert.ok(extracted.keptRatio > 0.5, `script text counted against the page: ${extracted.keptRatio}`);
	});
});

describe("anchor-classed links in prose keep their text", async () => {
	const markdown = await markdownOf(`<!doctype html>
<html><head><title>Anchors</title></head><body>
<h1>Anchors</h1>
${FILLER}
<p>See <a class="anchor" href="/x">the linked docs</a> for more, plus
<a class="headerlink" href="/y">important text</a>.</p>
<p class="skip-top">Prose in a class that merely starts with skip-to.</p>
<p class="skip-toggle">More prose in a lookalike class.</p>
<nav class="js-skip-to-content"><a href="#main">Skip to content</a></nav>
</body></html>`);

	it("keeps the label of a prose anchor", async () => {
		assert.ok(markdown.includes("the linked docs"), `anchor label deleted; got:\n${markdown}`);
		assert.ok(markdown.includes("important text"), `headerlink label deleted; got:\n${markdown}`);
	});

	it("keeps prose whose class merely starts with a jump-link token", async () => {
		assert.ok(markdown.includes("merely starts with skip-to"), `skip-top prose deleted; got:\n${markdown}`);
		assert.ok(markdown.includes("lookalike class"), `skip-toggle prose deleted; got:\n${markdown}`);
	});

	it("still drops the jump link itself", async () => {
		assert.equal(markdown.includes("Skip to content"), false, `jump link kept; got:\n${markdown}`);
	});
});

describe("code chrome is matched by whole class token", async () => {
	const markdown = await markdownOf(`<!doctype html>
<html><head><title>Tokens</title></head><body>
<h1>Tokens</h1>
${FILLER}
<div class="clipboard-api-example"><p>Reading from the clipboard requires permission.</p></div>
<div class="copy-link-guide"><p>How to copy a link to a section.</p></div>
<div class="language-label-explainer"><p>What the language label above a block means.</p></div>
<div class="wrapper">
  <span class="language-name">js</span>
  <clipboard-copy class="ClipboardButton js-clipboard-copy">Copy code</clipboard-copy>
  <button class="copybtn">Copy this</button>
  <pre class="language-js"><code>const x = 1;</code></pre>
</div>
</body></html>`);

	for (const kept of [
		"Reading from the clipboard requires permission.",
		"How to copy a link to a section.",
		"What the language label above a block means.",
	]) {
		it(`keeps ${JSON.stringify(kept.slice(0, 24))}…`, async () => {
			assert.ok(markdown.includes(kept), `prose deleted; got:\n${markdown}`);
		});
	}

	it("still removes the controls the tokens name exactly", async () => {
		assert.equal(markdown.includes("Copy code"), false, `js-clipboard-copy kept; got:\n${markdown}`);
		assert.equal(markdown.includes("Copy this"), false, `copybtn kept; got:\n${markdown}`);
		const stray = markdown.split("\n").filter((line) => line.trim() === "js");
		assert.deepEqual(stray, [], `language-name label kept; got:\n${markdown}`);
	});

	it("keeps the code the controls sat beside", async () => {
		assert.ok(markdown.includes("```js\nconst x = 1;\n```"), `code lost; got:\n${markdown}`);
	});
});
