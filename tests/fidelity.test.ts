/**
 * Content-fidelity invariants for `extract()`.
 *
 * Every fixture is a real (or hand-built) page body, and every assertion below
 * describes information that must survive the HTML → markdown conversion.
 * Counts and verbatim strings were measured from the fixture HTML, not guessed.
 *
 * Most of these fail against the current implementation; each failure maps to a
 * numbered defect in web-fetch-review/ACTION-PLAN.md Phase 1.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extract } from "../extract.ts";
import { escapedFences, fences, hasEscapedMarkdownInFences, headings, loadFixture } from "./helpers.ts";

/** Article-mode markdown for a fixture — the default path `web_fetch` takes. */
function markdownOf(name: string): string {
	return extract(loadFixture(name), false).markdown;
}

/** Assert no fence body carries markdown escaping, naming the offenders on failure. */
function assertNoEscapesInFences(markdown: string): void {
	assert.equal(
		hasEscapedMarkdownInFences(markdown),
		false,
		`escaped markdown inside fences:\n${escapedFences(markdown).join("\n---\n")}`,
	);
}

/** Assert every line of a snippet survives as its own line inside a single fence. */
function assertFenceHasLines(markdown: string, lines: string[]): void {
	const match = fences(markdown).find((fence) => fence.code.includes(lines[0] as string));
	assert.ok(match, `no fence contains ${JSON.stringify(lines[0])}`);
	const body = match.code.split("\n");
	for (const line of lines) {
		assert.ok(
			body.some((candidate) => candidate.trimEnd() === line.trimEnd()),
			`fence line ${JSON.stringify(line)} missing or merged; fence was:\n${match.code}`,
		);
	}
}

describe("code-regex — markdown post-processing must not rewrite code (defects 1.1, 1.2)", () => {
	const markdown = markdownOf("code-regex");

	for (const snippet of [
		"auto f = [](int a) { return a; };",
		"arr[i]();",
		"// -----",
		"let v = vec![1, 2];",
		'>>> print("hi")',
	]) {
		it(`keeps ${JSON.stringify(snippet)} verbatim`, () => {
			assert.ok(markdown.includes(snippet), `missing verbatim; got:\n${markdown}`);
		});
	}

	it("keeps the blank line inside the first code block", () => {
		const [first] = fences(markdown);
		assert.ok(first, "no fenced code block");
		assert.ok(/\n\n/.test(first.code), `blank line collapsed; fence was:\n${first.code}`);
	});

	it("labels the first fence cpp from the language-cpp class", () => {
		const [first] = fences(markdown);
		assert.ok(first, "no fenced code block");
		assert.equal(first.lang, "cpp");
	});

	it("fences both pre blocks, including the one with no code child", () => {
		assert.equal(fences(markdown).length, 2);
	});

	it("adds no markdown escaping inside fences", () => {
		assertNoEscapesInFences(markdown);
	});
});

describe("python-asyncio — Sphinx pre blocks (defects 1.2, 1.3)", () => {
	const markdown = markdownOf("python-asyncio");

	it("produces at least one fenced code block", () => {
		assert.ok(fences(markdown).length >= 1, `fences: ${fences(markdown).length}`);
	});

	it("keeps the first code example, the one in the Sphinx sidebar", () => {
		// The page's first `<pre>` sits in `<aside class="sidebar">`, which
		// Readability deletes outright unless the aside is unwrapped first.
		assertFenceHasLines(markdown, ["import asyncio", "asyncio.run(main())"]);
	});

	it("keeps the REPL session verbatim", () => {
		// Text of the fixture's `highlight-pycon` <pre>.
		assert.ok(markdown.includes(">>> import asyncio"), "REPL prompt missing or escaped");
		assert.ok(markdown.includes(">>> await asyncio.sleep(10, result='hello')"), "REPL line rewritten");
	});

	it("keeps a language on at least one fence", () => {
		// The fixture's only language signal is the Sphinx wrapper class:
		// `highlight-python3` and `highlight-pycon`. Readability strips it today.
		const labelled = fences(markdown).filter((fence) => fence.lang !== "");
		assert.ok(labelled.length >= 1, `no fence carries a language: ${JSON.stringify(fences(markdown))}`);
	});

	it("adds no markdown escaping inside fences", () => {
		assertNoEscapesInFences(markdown);
	});
});

describe("github-readability — README code and headings (defects 1.2, 1.7)", () => {
	const markdown = markdownOf("github-readability");

	it("keeps the README's own heading", () => {
		assert.ok(
			headings(markdown).some((heading) => heading.text === "Readability.js"),
			`headings: ${JSON.stringify(headings(markdown))}`,
		);
	});

	it("fences all six README code blocks", () => {
		// Six <pre> blocks in the README; all six already reach the markdown.
		assert.ok(fences(markdown).length >= 6, `fences: ${fences(markdown).length}`);
	});

	it("keeps README code lines verbatim", () => {
		assert.ok(markdown.includes("npm install @mozilla/readability"), "install line missing");
		assert.ok(
			markdown.includes("var article = new Readability(document).parse();"),
			"usage line rewritten (markdown escaping)",
		);
	});

	it("adds no markdown escaping inside fences", () => {
		assertNoEscapesInFences(markdown);
	});
});

describe("react-learn — per-line <div> code markup (defect 1.4)", () => {
	const markdown = markdownOf("react-learn");

	it("keeps the MyButton example on separate lines in one fence", () => {
		assertFenceHasLines(markdown, [
			"function MyButton() {",
			"  return (",
			"    <button>I'm a button</button>",
			"  );",
			"}",
		]);
	});
});

describe("div-code — per-line block markup inside <pre> (defects 1.2, 1.4)", () => {
	const markdown = markdownOf("div-code");

	it("fences the <div>-per-line block with its lines intact", () => {
		assertFenceHasLines(markdown, ["line one div", "line two div", "line three div"]);
	});

	it("fences the <br>-separated block with its lines intact", () => {
		assertFenceHasLines(markdown, ["line one br", "line two br", "line three br"]);
	});

	it("fences the <span class=line> block with its lines intact", () => {
		assertFenceHasLines(markdown, ["line one span", "line two span", "line three span"]);
	});

	it("produces one fence per pre block", () => {
		assert.equal(fences(markdown).length, 3);
	});
});

describe("go-tutorial — bare <pre> shell transcripts (defect 1.2)", () => {
	const markdown = markdownOf("go-tutorial");

	it("fences all ten pre blocks", () => {
		// Ten <pre> blocks in the fixture; all ten already reach the markdown.
		assert.ok(fences(markdown).length >= 10, `fences: ${fences(markdown).length}`);
	});

	it("keeps the go mod init command verbatim", () => {
		assert.ok(markdown.includes("$ go mod init example/hello"), "command line missing or rewritten");
	});

	it("adds no markdown escaping inside fences", () => {
		assertNoEscapesInFences(markdown);
	});
});

describe("pypi-requests — doctest prompts (defect 1.2)", () => {
	const markdown = markdownOf("pypi-requests");

	it("puts the doctest session in a fence with unescaped prompts", () => {
		const fence = fences(markdown).find((candidate) => candidate.code.includes(">>> import requests"));
		assert.ok(fence, `no fence contains the doctest session; markdown:\n${markdown.slice(0, 800)}`);
		assert.ok(!fence.code.includes("\\>"), `prompt escaped; fence was:\n${fence.code}`);
	});

	it("adds no markdown escaping inside fences", () => {
		assertNoEscapesInFences(markdown);
	});
});

describe("wikipedia-transformer — section headings (defect 1.7)", () => {
	const markdown = markdownOf("wikipedia-transformer");

	/** The article's <h2> sections, minus the "Contents" table-of-contents heading. */
	const SECTIONS = [
		"History",
		"Training",
		"Architecture",
		"Full transformer architecture",
		"Subsequent work",
		"Applications",
		"See also",
		"Notes",
		"References",
		"Further reading",
	];

	it("keeps at least eight of the ten section headings at level 2", () => {
		const kept = SECTIONS.filter((section) =>
			headings(markdown).some((heading) => heading.level === 2 && heading.text === section),
		);
		assert.ok(kept.length >= 8, `only kept ${JSON.stringify(kept)}`);
	});

	it("drops the [edit] section links", () => {
		assert.ok(!markdown.includes("[edit]"), `[edit] appears ${markdown.split("[edit]").length - 1} times`);
	});

	it("leaves no anchor debris on headings", () => {
		const debris = headings(markdown).filter((heading) => /[#¶​]$/.test(heading.text));
		assert.deepEqual(debris, []);
	});
});

describe("claude-docs-prompt-caching — Readability picked the sidebar (defect 1.6)", () => {
	const extracted = extract(loadFixture("claude-docs-prompt-caching"), false);

	it("returns the article, not the navigation sidebar", () => {
		// Full-page conversion of this fixture yields ~55k chars.
		assert.ok(
			extracted.markdown.length >= 20_000,
			`only ${extracted.markdown.length} chars — sidebar-only extraction`,
		);
	});

	it("contains the article's own content", () => {
		assert.ok(extracted.markdown.includes("cache_control"), "cache_control never appears");
	});
});

describe("table-td-only — data table without <th> (defect 1.5)", () => {
	const markdown = markdownOf("table-td-only");

	it("renders a GFM table with three data rows", () => {
		const rows = markdown.split("\n").filter((line) => line.startsWith("|"));
		// header + separator + 3 data rows
		assert.equal(rows.length, 5, `table rows: ${JSON.stringify(rows)}`);
	});

	it("keeps each row's cells together on one line", () => {
		assert.ok(markdown.includes("| 1.0 | 2023-01-01 | end of life |"), "row 1 split apart");
		assert.ok(markdown.includes("| 3.0 | 2025-11-30 | supported |"), "row 3 split apart");
	});

	it("keeps the caption", () => {
		assert.ok(markdown.includes("Versions"), "caption dropped");
	});

	it("unwraps the nested single-row layout table", () => {
		const paragraph = "Layout cell paragraph that must survive as plain text.";
		assert.ok(markdown.includes(paragraph), "layout paragraph lost");
		const line = markdown.split("\n").find((candidate) => candidate.includes(paragraph)) as string;
		assert.ok(!line.includes("|"), `layout table rendered as a GFM row: ${line}`);
	});
});

describe("fragment — HTML with no <html> or <body> (defect 1.8)", () => {
	const markdown = markdownOf("fragment");

	it("converts every top-level element, not just the first", () => {
		assert.ok(markdown.includes("# Title"), `heading missing; got: ${JSON.stringify(markdown)}`);
		assert.ok(markdown.includes("one"), `first paragraph missing; got: ${JSON.stringify(markdown)}`);
		assert.ok(markdown.includes("two"), `second paragraph missing; got: ${JSON.stringify(markdown)}`);
		assert.ok(
			fences(markdown).some((fence) => fence.code === "code"),
			`code block missing; got: ${JSON.stringify(markdown)}`,
		);
	});
});

describe("hn-front — layout tables and links (regression guard)", () => {
	const markdown = markdownOf("hn-front");

	it("emits no GFM table", () => {
		const rows = markdown.split("\n").filter((line) => line.startsWith("|"));
		assert.deepEqual(rows, []);
	});

	it("keeps the story links", () => {
		// Measured: 181 absolute links across the 30 front-page stories.
		const links = markdown.match(/\]\(https:\/\//g) ?? [];
		assert.ok(links.length >= 150, `only ${links.length} absolute links`);
	});
});

describe("mdn-fetch — reference code samples (defects 1.2, 1.3)", () => {
	const markdown = markdownOf("mdn-fetch");

	it("keeps all five code samples fenced", () => {
		assert.ok(fences(markdown).length >= 5, `fences: ${fences(markdown).length}`);
	});

	it("keeps the syntax block verbatim", () => {
		assert.ok(markdown.includes("fetch(resource, options)"), "syntax line missing");
		assert.ok(markdown.includes(".fetch(myRequest)"), "example line missing");
	});

	it("adds no markdown escaping inside fences", () => {
		assertNoEscapesInFences(markdown);
	});
});
