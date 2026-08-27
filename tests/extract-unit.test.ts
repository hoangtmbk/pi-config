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

/** Article-mode markdown for an inline page body. */
function markdownOf(body: string): string {
	const page: FetchedPage = {
		url: "https://example.test/page",
		status: 200,
		contentType: "text/html",
		charset: "utf-8",
		body,
		bytes: Buffer.byteLength(body),
		truncatedAtBytes: false,
	};
	const extracted: Extracted = extract(page, false);
	return extracted.markdown;
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
