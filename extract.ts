/**
 * Content extraction for web_fetch.
 *
 * Routes by content type, and for HTML runs Readability to drop nav/ads/
 * sidebars before converting to markdown. The cleanup exists because each rule
 * was observed wasting real tokens on real pages: tracking query params, image
 * URLs the model can never use, and the empty `[](#anchor)` links GitHub emits
 * next to every heading.
 *
 * All of that cleanup happens on the DOM, never on the markdown. A regex over
 * the finished markdown cannot tell prose from the inside of a code fence, and
 * code must come out of this pipeline byte for byte.
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { WebFetchError, type FetchedPage } from "./fetch.ts";

export interface Extracted {
	title: string | undefined;
	byline: string | undefined;
	publishedTime: string | undefined;
	markdown: string;
	/** How the content was obtained — surfaced so the model can judge quality. */
	mode: "article" | "full-page" | "json" | "text";
	/**
	 * Share of the page's text that survived extraction, 0–1. A low value on an
	 * `article` result is the model's warning that Readability was aggressive;
	 * 1 means nothing was dropped.
	 */
	keptRatio: number;
}

/** Readability output shorter than this means it almost certainly ate the page. */
const MIN_ARTICLE_CHARS = 200;

/** Content types that are text but not HTML — passed through untouched. */
const TEXT_TYPE_PATTERN =
	/^text\/|^application\/(x-)?(yaml|toml|x-sh|javascript|typescript|xml)$|\+xml$/;

const TRACKING_PARAM_PATTERN = /^(utm_[a-z_]+|fbclid|gclid|mc_[a-z]+|ref_src|_hs[a-z]+|igshid)$/i;

/** Info-string values that explicitly mean "this block has no language". */
const PLAIN_LANGUAGES = new Set(["default", "text", "none"]);

/**
 * Languages accepted from a bare `hljs <token>` pair. Unlike `language-x`, the
 * token beside `hljs` is only sometimes a language, so it needs a whitelist.
 */
const HLJS_LANGUAGES = new Set(
	`bash c cpp csharp css diff go graphql html ini java javascript js json jsx kotlin less lua makefile
	 markdown md objectivec perl php plaintext python py r ruby rb rust rs scala scss shell sh sql swift
	 toml ts tsx typescript vbnet xml yaml yml`.split(/\s+/),
);

/** `language-js`, `lang-js`, `highlight-python3`, `highlight-source-shell`. */
const LANGUAGE_CLASS_PATTERN = /^(?:language|lang|highlight-source|highlight)-([\w+#.]+)$/i;

/** A plausible info string — guards against class soup being emitted as a language. */
const LANGUAGE_PATTERN = /^[\w+#.]+$/;

/** Common `lang` attribute values that name a human language and nothing else. */
const NATURAL_LANGUAGE_TAGS = new Set(
	"ar bg de el en es fa fi fr he hi hu id it ja ko ms nl no pt ro ru sv th tr uk vi zh".split(" "),
);

/** The language a single `class` attribute declares, if any. */
function languageFromClass(className: string | null | undefined): string | undefined {
	const tokens = (className ?? "").split(/\s+/).filter(Boolean);

	for (const [index, token] of tokens.entries()) {
		// `class="brush: js"` (MDN, SyntaxHighlighter) and `class="sourceCode python"`
		// (Pandoc) both name the language in the *next* token.
		if (/^brush:?$/i.test(token) || token === "sourceCode") {
			const next = tokens[index + 1];
			if (next) return next;
			continue;
		}
		const brush = /^brush:(.+)$/i.exec(token);
		if (brush) return brush[1];

		if (token === "hljs") {
			const next = tokens[index + 1]?.toLowerCase();
			if (next && HLJS_LANGUAGES.has(next)) return next;
			continue;
		}

		const match = LANGUAGE_CLASS_PATTERN.exec(token);
		if (match) return match[1];
	}

	return undefined;
}

/**
 * The info string for a `<pre>`, from wherever the page happens to declare it:
 * the `<pre>` itself, its `<code>` child, or the wrapper Sphinx, GitHub and
 * Docusaurus put the class on instead.
 */
function fenceLanguage(pre: Element): string {
	const sources = [pre, pre.querySelector("code"), pre.parentNode, pre.parentNode?.parentNode];

	for (const source of sources) {
		const declared = languageFromClass((source as Element | null | undefined)?.getAttribute?.("class"));
		if (!declared) continue;
		const language = declared.toLowerCase();
		if (PLAIN_LANGUAGES.has(language)) return "";
		if (LANGUAGE_PATTERN.test(language)) return language;
	}

	// `<pre lang=python>`, which is what GitHub-flavoured markdown renders to and
	// therefore what PyPI, GitLab and countless READMEs ship. `lang` is a natural
	// language everywhere else on the web, so the common tags are refused — but
	// only the ones no language is named after (`r`, `ts`, `sh`, `go` and `pl`
	// are all both).
	const attribute = pre.getAttribute("lang")?.toLowerCase();
	if (
		attribute &&
		LANGUAGE_PATTERN.test(attribute) &&
		!PLAIN_LANGUAGES.has(attribute) &&
		!NATURAL_LANGUAGE_TAGS.has(attribute)
	) {
		return attribute;
	}

	return "";
}

/** Elements that end a line of code when a highlighter uses one per line. */
const LINE_BREAKING_TAGS = new Set(["DIV", "P", "LI", "TR"]);

/** `class="line"`, `class="cm-line"` — a highlighter's per-line wrapper. */
const LINE_CLASS_PATTERN = /(?:^|\s)(?:\w+-)*line(?:\s|$)/;

/**
 * The text of a `<pre>`, with its line structure intact.
 *
 * Syntax highlighters rebuild code as one element per line — `<div class="cm-line">`
 * on react.dev, `<span class="line">` under Shiki, bare `<br>` elsewhere — and
 * `textContent` alone collapses the whole block onto a single line.
 */
function preText(pre: Element): string {
	let out = "";
	let pendingNewline = false;

	const push = (text: string) => {
		if (!text) return;
		if (pendingNewline) {
			if (!text.startsWith("\n")) out += "\n";
			pendingNewline = false;
		}
		out += text;
	};

	const walk = (parent: Node) => {
		for (const child of Array.from(parent.childNodes)) {
			if (child.nodeType === 3) {
				push(child.nodeValue ?? "");
				continue;
			}
			if (child.nodeType !== 1) continue;

			const element = child as Element;
			if (element.nodeName === "BR") {
				push("\n");
				continue;
			}

			walk(element);

			// Defer the newline: the markup often supplies its own right after, and
			// two would turn every line of code into a paragraph.
			const breaksLine =
				LINE_BREAKING_TAGS.has(element.nodeName) ||
				LINE_CLASS_PATTERN.test(element.getAttribute("class") ?? "");
			if (breaksLine && !out.endsWith("\n")) pendingNewline = true;
		}
	};

	walk(pre);
	return out;
}

/**
 * Reduce every `<pre>` to its text, and record the language it declared.
 *
 * This runs before Readability because Readability rewrites markup it considers
 * layout: react.dev's per-line `<div class="cm-line">` become `<p>`, and the
 * whitespace-only text nodes holding the indentation are dropped on the way.
 * Flattening first means the code is a single text node it cannot restructure,
 * and re-stamping the language keeps it from depending on wrapper elements
 * surviving.
 */
function flattenPreBlocks(document: Document): void {
	for (const pre of Array.from(document.querySelectorAll("pre"))) {
		// An image-only `<pre>` has no text to preserve and everything to lose.
		if ((pre.textContent ?? "").trim() === "" && pre.querySelector("img")) continue;

		const language = fenceLanguage(pre);
		pre.textContent = preText(pre);
		if (language) pre.setAttribute("class", `language-${language}`);
	}
}

function configureBase(turndown: TurndownService): TurndownService {
	// Every `<pre>` becomes a fence, whether or not it has a `<code>` child, and
	// its body is the text `flattenPreBlocks` left behind, returned raw so that
	// Turndown's markdown escaping never sees it. Turndown's own fenced-code rule
	// only handles `<pre><code>` and hands the text through the escaper, which
	// rewrites `[`, `*`, `>` and `_` inside code.
	turndown.addRule("preBlock", {
		filter: "pre",
		replacement: (content, node) => {
			const pre = node as unknown as Element;
			const code = (pre.textContent ?? "").replace(/^\n+/, "").replace(/\s+$/, "");
			// No code to fence: a `<pre>` holding only a diagram image still has
			// its alt text to give, so hand back what the child rules made of it.
			if (!code) return content;

			// A fence has to outrun any backtick run in the code it wraps.
			const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
			const fence = "`".repeat(Math.max(3, longestRun + 1));
			return `\n\n${fence}${fenceLanguage(pre)}\n${code}\n${fence}\n\n`;
		},
	});

	// Image URLs are pure cost: the model cannot fetch them and they are often
	// hundreds of characters of CDN parameters. Keep the alt text, drop the URL.
	turndown.addRule("imageAltOnly", {
		filter: "img",
		replacement: (_content, node) => {
			const alt = (node as Element).getAttribute?.("alt")?.trim();
			return alt ? `![${alt}]` : "";
		},
	});

	return turndown;
}

const TURNDOWN_OPTIONS = {
	headingStyle: "atx",
	bulletListMarker: "-",
	hr: "---",
	emDelimiter: "*",
} as const;

/** Descendants belonging to a table, skipping any nested table's own rows and cells. */
function ownDescendants(table: Element, selector: string): Element[] {
	return Array.from(table.querySelectorAll(selector)).filter((element) => element.closest("table") === table);
}

/** The cells belonging to a row, skipping any nested table's cells. */
function ownCells(row: Element): Element[] {
	return Array.from(row.querySelectorAll("th, td")).filter((cell) => cell.closest("tr") === row);
}

/** Widest `colspan` honoured — past this a page is padding, not spanning. */
const MAX_COLSPAN = 32;

/** A row's cells, each spanning cell followed by the empty columns it covers. */
function expandCells(row: Element, render: (cell: Element) => string): string[] {
	const cells: string[] = [];
	for (const cell of ownCells(row)) {
		cells.push(render(cell));
		const span = Number.parseInt(cell.getAttribute("colspan") ?? "", 10);
		for (let covered = 1; covered < Math.min(span || 1, MAX_COLSPAN); covered++) cells.push("");
	}
	return cells;
}

function createTurndown(): TurndownService {
	const turndown = configureBase(new TurndownService(TURNDOWN_OPTIONS));

	// A separate instance for cell contents: recursing through the main instance
	// while it is mid-conversion is not safe, and cells never contain tables by
	// the time this runs (layout tables are unwrapped during preprocessing).
	const cellConverter = configureBase(new TurndownService(TURNDOWN_OPTIONS));

	// Turndown passes tables through as raw HTML by default, which is expensive.
	// Convert each cell's markup rather than its text so links and emphasis survive.
	turndown.addRule("dataTable", {
		filter: "table",
		replacement: (_content, node) => {
			const table = node as Element;
			const rows = ownDescendants(table, "tr");
			if (rows.length === 0) return "";

			// A cell's markup, flattened onto one line: a newline inside a GFM cell
			// ends the row, and an unescaped pipe adds a column that is not there.
			const render = (cell: Element) =>
				cellConverter
					.turndown(cell.innerHTML ?? "")
					.replace(/\|/g, "\\|")
					.replace(/\s*\n+\s*/g, " ")
					.trim();

			const grid = rows
				.map((row) => ({
					cells: expandCells(row, render),
					labels: ownCells(row).some((cell) => cell.nodeName === "TH"),
				}))
				.filter((row) => row.cells.length > 0);
			if (grid.length === 0) return "";

			// The first row is the column header unless `<th>` shows up further
			// down — that means the table labels its *rows*, so no row is a header
			// row and GFM needs an empty one to render any of the data at all.
			const header = grid.slice(1).some((row) => row.labels) ? undefined : grid[0];
			const body = header ? grid.slice(1) : grid;

			const width = Math.max(...grid.map((row) => row.cells.length));
			const line = (cells: string[]) =>
				`| ${[...cells, ...Array(width - cells.length).fill("")].join(" | ")} |`;

			const caption = ownDescendants(table, "caption")[0];
			const lines = [
				header ? line(header.cells) : `|${" |".repeat(width)}`,
				line(Array(width).fill("---")),
				...body.map((row) => line(row.cells)),
			];
			// The caption names the table; a bold line above it is the closest
			// markdown has, and GFM has nowhere to put it inside the table.
			const title = caption ? render(caption) : "";
			return `\n\n${title ? `**${title}**\n\n` : ""}${lines.join("\n")}\n\n`;
		},
	});

	return turndown;
}

/**
 * A table that cannot be holding tabular data.
 *
 * Three shapes qualify, and each is a certainty rather than a guess: a table
 * inside another table is a layout grid, and a table with one row — or with one
 * cell in every row — has no second dimension to tabulate.
 *
 * `<th>` deliberately plays no part. It was the old test, and it is wrong in
 * both directions: plenty of real data tables mark their header row with `<td>`
 * (they get flattened), and layout tables occasionally carry a stray `<th>`.
 */
function isLayoutTable(table: Element): boolean {
	if (table.parentElement?.closest("table")) return true;
	const rows = ownDescendants(table, "tr");
	return rows.length <= 1 || rows.every((row) => ownCells(row).length <= 1);
}

/**
 * Replace layout tables with their cell contents.
 *
 * Sites like Hacker News build their entire page from nested tables. Rendering
 * those as markdown tables costs more characters than the source HTML and
 * flattens the content inside them.
 *
 * Unwrapping innermost-first (tables with no nested table) keeps cell contents
 * in document order, and re-testing after each pass lets an outer table be
 * judged on the rows it has left. Every pass removes at least one table, so the
 * loop ends.
 */
function unwrapLayoutTables(document: Document): void {
	for (;;) {
		const layoutTables = Array.from(document.querySelectorAll("table"))
			.filter((table) => !table.querySelector("table"))
			.filter(isLayoutTable);
		if (layoutTables.length === 0) return;

		for (const table of layoutTables) {
			const holder = document.createElement("div");
			// The caption comes along: it is the only text a one-row table has that
			// is not in a cell, and dropping it would lose it outright.
			for (const cell of ownDescendants(table, "caption, td, th")) {
				const wrapper = document.createElement("div");
				while (cell.firstChild) wrapper.appendChild(cell.firstChild);
				holder.appendChild(wrapper);
			}
			table.replaceWith(holder);
		}
	}
}

/**
 * Rewrite every href to an absolute URL and strip tracking parameters.
 * Without this, relative links come out unusable — Hacker News yields bare
 * `vote?id=123` hrefs that mean nothing outside the page.
 */
function absolutizeLinks(document: Document, baseUrl: string): void {
	for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
		const href = anchor.getAttribute("href");
		if (!href) continue;

		// Leave in-page anchors and non-navigational schemes alone.
		if (href.startsWith("#") || /^(javascript|data):/i.test(href)) {
			anchor.removeAttribute("href");
			continue;
		}

		try {
			const resolved = new URL(href, baseUrl);
			for (const key of Array.from(resolved.searchParams.keys())) {
				if (TRACKING_PARAM_PATTERN.test(key)) resolved.searchParams.delete(key);
			}
			anchor.setAttribute("href", resolved.toString());
		} catch {
			anchor.removeAttribute("href");
		}
	}
}

/**
 * Drop links that would render as nothing, and unwrap the ones defused above.
 *
 * GitHub emits an empty anchor beside every heading and Wikipedia one per
 * citation marker; both come out as `[](…)`. Cleaning them here rather than in
 * the markdown also means Readability scores the real link density.
 *
 * An image with no alt text counts as nothing to render, because `imageAltOnly`
 * drops it — otherwise Wikipedia's figures leave twenty bare `[](…)` behind.
 */
function cleanLinks(document: Document): void {
	for (const anchor of Array.from(document.querySelectorAll("a"))) {
		const showsImage = Array.from(anchor.querySelectorAll("img")).some(
			(image) => (image.getAttribute("alt") ?? "").trim() !== "",
		);
		if (anchor.textContent?.trim() === "" && !showsImage) {
			anchor.remove();
			continue;
		}
		if (anchor.hasAttribute("href")) continue;
		while (anchor.firstChild) anchor.parentNode?.insertBefore(anchor.firstChild, anchor);
		anchor.remove();
	}
}

/**
 * Class tokens that only ever name a control beside a code block: copy buttons,
 * language labels, block titles.
 *
 * Every alternative has to be a whole class token, and every alternative has to
 * be unmistakably a control. A bare `copy` was tried and is wrong: `copy`,
 * `body-copy` and `hero-copy` are how CMS and marketing templates name body
 * text, and this sweep runs over the whole document, so matching them deletes
 * prose outright.
 */
const CODE_CHROME_CLASS_PATTERN =
	/(?:^|[\s_-])(?:copy[-_]?(?:button|btn|icon|code|link)|copy[-_]to[-_]clipboard|clipboard|lang(?:uage)?[-_](?:label|name)|code[-_]?block[-_]?title)(?:[\s_-]|$)/i;

/**
 * Remove everything that is markup rather than content.
 *
 * Doing it before Readability keeps it from scoring nav and script bodies, and
 * keeps the copy-button labels sites put next to a `<pre>` from surfacing as a
 * stray `js` or `bash` line above the code.
 */
function stripNonContent(document: Document): void {
	for (const element of Array.from(
		document.querySelectorAll("script, style, noscript, svg, canvas, iframe, template, form, button"),
	)) {
		element.remove();
	}

	for (const element of Array.from(document.querySelectorAll("[class]"))) {
		if (!CODE_CHROME_CLASS_PATTERN.test(element.getAttribute("class") ?? "")) continue;
		// A wrapper holding the code block is content; only the controls go.
		if (element.querySelector("pre")) continue;
		element.remove();
	}
}

/**
 * Controls documentation generators hang off a heading: Wikipedia's `[edit]`
 * link, Sphinx's `¶` permalink, GitHub's anchor icon.
 */
const HEADING_CONTROL_SELECTOR = ".mw-editsection, a.headerlink, a.anchor";

/** Keyboard-only jump links, which are markup for screen readers and noise here. */
const SKIP_LINK_SELECTOR = '.mw-jump-link, [class*="skip-to"]';

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

/** Permalink glyphs and zero-width padding left at the end of a heading's text. */
const HEADING_SUFFIX_PATTERN = /[\s#¶\u200b\ufeff]+$/;
const ZERO_WIDTH_PATTERN = /[\u200b\ufeff]/g;

/** Every text node under an element, in document order. */
function textNodesOf(root: Element): Text[] {
	const found: Text[] = [];
	const walk = (parent: Node) => {
		for (const child of Array.from(parent.childNodes)) {
			if (child.nodeType === 3) found.push(child as Text);
			else if (child.nodeType === 1) walk(child);
		}
	};
	walk(root);
	return found;
}

/**
 * Strip the anchor debris documentation sites attach to their headings.
 *
 * This is worth more than the characters it saves. Wikipedia wraps every section
 * heading as `<div class="mw-heading"><h2>History</h2><span class="mw-editsection">[edit]</span></div>`,
 * and Readability's `_cleanConditionally` deletes that div — 13 characters of
 * text at link density 0.31 trips both its "suspiciously short" and its "low
 * weight and a little linky" rules — taking the `<h2>` inside it with it. That
 * is why ten of the eleven section headings never reached the markdown: not the
 * `<div>` wrapper, but the `[edit]` link sharing it. Removing the control first
 * leaves the div with no links at all, and the heading survives.
 */
function cleanHeadings(document: Document): void {
	for (const control of Array.from(
		document.querySelectorAll(`${HEADING_CONTROL_SELECTOR}, ${SKIP_LINK_SELECTOR}`),
	)) {
		control.remove();
	}

	for (const heading of Array.from(document.querySelectorAll(HEADING_SELECTOR))) {
		// A heading anchor hidden from assistive tech is decoration by definition.
		for (const decoration of Array.from(heading.querySelectorAll('a[aria-hidden="true"]'))) {
			decoration.remove();
		}

		const texts = textNodesOf(heading);
		for (const text of texts) text.nodeValue = (text.nodeValue ?? "").replace(ZERO_WIDTH_PATTERN, "");

		const last = texts.filter((text) => (text.nodeValue ?? "").trim() !== "").pop();
		if (!last) continue;
		// A heading that *is* a `#` keeps it — there would be nothing left otherwise.
		if ((heading.textContent ?? "").replace(HEADING_SUFFIX_PATTERN, "").trim() === "") continue;
		last.nodeValue = (last.nodeValue ?? "").replace(HEADING_SUFFIX_PATTERN, "");
	}
}

/**
 * Hoist the contents of any `<aside>` that holds a code block.
 *
 * Readability deletes every `<aside>` outright — `_prepArticle` ends with
 * `_clean(articleContent, "aside")`, no scoring involved — and drops anything
 * classed `sidebar` before it even starts scoring. Sphinx puts worked examples
 * in `<aside class="sidebar">`, which on docs.python.org's asyncio page is the
 * *first* code example on the page, so both rules fired and the example was
 * gone. An aside holding a `<pre>` is a worked example rather than navigation:
 * unwrapping it puts the code in the flow, where neither rule can reach it.
 */
function hoistCodeAsides(document: Document): void {
	for (const aside of Array.from(document.querySelectorAll("aside"))) {
		if (!aside.querySelector("pre")) continue;
		while (aside.firstChild) aside.parentNode?.insertBefore(aside.firstChild, aside);
		aside.remove();
	}
}

/** Regions whose heading names the site, not the article. */
const CHROME_REGIONS = "header, nav, footer, aside";

/**
 * Drop site chrome, for the full-page path only.
 *
 * On the article path Readability has already scored these out, and running
 * this there would be a net loss: an `<aside>` holds a documentation sidebar
 * with worked examples at least as often as it holds navigation.
 */
function stripChromeRegions(root: Element): void {
	for (const region of Array.from(root.querySelectorAll(CHROME_REGIONS))) region.remove();
}

/** Text of a heading, whitespace-normalised, for comparing one against another. */
function headingText(html: string): string {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Put back the article's own top heading when Readability deleted it.
 *
 * Readability drops the first `<h1>`/`<h2>` whose text resembles the page title
 * (Readability.js `_headerDuplicatesTitle`), on the assumption that the reader
 * UI shows the title separately. The resemblance test is loose — mozilla's
 * README loses its `<h1>Readability.js</h1>` to the GitHub page title — and the
 * heading is unrecoverable afterwards, so we re-insert it whenever no heading of
 * that text survived. Headings inside page chrome are skipped: those name the
 * site, and Readability dropped them for the right reason.
 *
 * `root` is the region the article was extracted from, so that "the first
 * heading" means the first heading of the content and not of some sidebar that
 * happens to come earlier in the document.
 */
function restoreLeadHeading(content: string, root: ParentNode): string {
	const outsideChrome = (selector: string) =>
		Array.from(root.querySelectorAll(selector)).find(
			(heading) => !heading.closest(CHROME_REGIONS) && (heading.textContent?.trim() ?? "") !== "",
		);
	const lead = outsideChrome("h1") ?? outsideChrome("h2");
	if (!lead) return content;

	const wanted = headingText(lead.innerHTML ?? "");
	const survives = (content.match(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi) ?? []).some(
		(heading) => headingText(heading) === wanted,
	);
	return survives ? content : `<h1>${lead.innerHTML}</h1>${content}`;
}

/** Elements a page uses to mark where its own content is. */
const MAIN_CONTENT_SELECTOR = "main, article, [role=main]";

/** Below this share of the page's text, a `<main>` is a shell, not the content. */
const MIN_MAIN_RATIO = 0.4;

/** Below this share kept, Readability picked something other than the article. */
const MIN_KEPT_RATIO = 0.4;

/** Length of a piece of text with runs of whitespace counted as one character. */
function textLength(text: string | null | undefined): number {
	return (text ?? "").replace(/\s+/g, " ").trim().length;
}

/**
 * The element holding the page's own content, when the page marks one convincingly.
 *
 * The largest match wins rather than the first: docs sites nest the real
 * `<article>` inside a `<main>` scroll container that holds nothing itself (the
 * Claude docs do exactly this), and news sites nest teaser `<article>`s inside
 * the real `<main>`. A region under 40% of the page's text is not the content —
 * it is a shell whose content arrives by script — and trusting it would throw
 * the rest of the page away.
 */
function mainContentRegion(document: Document, pageChars: number): Element | undefined {
	if (pageChars === 0) return undefined;

	let best: Element | undefined;
	let bestChars = 0;
	for (const candidate of Array.from(document.querySelectorAll(MAIN_CONTENT_SELECTOR))) {
		const chars = textLength(candidate.textContent);
		if (chars <= bestChars) continue;
		best = candidate;
		bestChars = chars;
	}

	return bestChars / pageChars >= MIN_MAIN_RATIO ? best : undefined;
}

/**
 * The document Readability parses.
 *
 * When the page marks its own content region, Readability sees only that.
 * Its scoring is per-element, so a large enough navigation tree can outscore
 * the article — the Claude docs sidebar beat the page it belongs to. The head
 * comes along so the title and metadata Readability reads are still there.
 */
function readabilityInput(document: Document, region: Element | undefined): Document {
	if (!region) return document.cloneNode(true) as Document;
	const head = document.querySelector("head")?.innerHTML ?? "";
	return parseHTML(`<html><head>${head}</head><body>${region.outerHTML}</body></html>`).document;
}

/**
 * Give the document a `<body>` holding everything, when the source had none.
 *
 * linkedom does no tree fixup, so a bare fragment (`<h1>…</h1><p>…</p>`) parses
 * into a document whose *first element* is the document element and whose body
 * is empty: converting the body then yields nothing at all, and converting the
 * document element yields only the first of the fragment's elements.
 */
function adoptStrayNodes(document: Document): void {
	const strays = Array.from(document.childNodes).filter(
		(node) => node.nodeType === 1 && (node as Element).nodeName !== "HTML",
	);
	if (strays.length === 0) return;

	const body = document.querySelector("body") ?? document.createElement("body");
	for (const stray of strays) body.appendChild(stray);
	if (!body.parentNode) document.appendChild(body);
}

function extractHtml(page: FetchedPage, raw: boolean): Extracted {
	const { document } = parseHTML(page.body);

	adoptStrayNodes(document);
	stripNonContent(document);
	cleanHeadings(document);
	hoistCodeAsides(document);
	flattenPreBlocks(document);
	absolutizeLinks(document, page.url);
	cleanLinks(document);
	unwrapLayoutTables(document);

	const documentTitle =
		document.querySelector("title")?.textContent?.trim() ||
		document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
		undefined;
	const metaContent = (selector: string) =>
		document.querySelector(selector)?.getAttribute("content")?.trim() || undefined;

	const turndown = createTurndown();
	// `documentElement` covers a document with no `<body>`; the cast is because a
	// degenerate page can leave even that undefined, whatever the DOM types say.
	const body = (document.querySelector("body") ?? document.documentElement) as Element | undefined;
	const pageChars = textLength(body?.textContent);
	const region = mainContentRegion(document, pageChars);

	if (!raw) {
		// Readability mutates whatever it is given, so it never gets the original.
		const article = (() => {
			try {
				return new Readability(readabilityInput(document, region), {
					charThreshold: 100,
					keepClasses: true,
				}).parse();
			} catch {
				return null;
			}
		})();

		const articleMarkdown = article?.content
			? turndown.turndown(restoreLeadHeading(article.content, region ?? document)).trim()
			: "";
		const keptRatio = pageChars ? Math.min(1, textLength(article?.textContent) / pageChars) : 1;

		// Two ways to reject the article. Too short means Readability returned
		// nothing usable; too little of the page kept means it picked the wrong
		// element entirely — but only when the page never told us where its
		// content was, since if it did, Readability only ever saw the content.
		const trustworthy = region !== undefined || keptRatio >= MIN_KEPT_RATIO;
		if (articleMarkdown.length >= MIN_ARTICLE_CHARS && trustworthy) {
			return {
				title: article?.title?.trim() || documentTitle,
				byline: article?.byline?.trim() || metaContent('meta[name="author"]'),
				publishedTime:
					article?.publishedTime?.trim() ||
					metaContent('meta[property="article:published_time"]'),
				markdown: articleMarkdown,
				mode: "article",
				keptRatio,
			};
		}
	}

	// Convert the page itself. This is the robustness guarantee: listing pages,
	// app shells and anything Readability mishandled still produce output. The
	// page's own content region is preferred when it marked one.
	const source = region ?? body;
	if (source) stripChromeRegions(source);
	const markdown = turndown.turndown(source?.innerHTML || page.body).trim();

	return {
		title: documentTitle,
		byline: metaContent('meta[name="author"]'),
		publishedTime: metaContent('meta[property="article:published_time"]'),
		markdown,
		mode: "full-page",
		keptRatio: pageChars ? Math.min(1, textLength(source?.textContent) / pageChars) : 1,
	};
}

function extractJson(page: FetchedPage): Extracted {
	try {
		const parsed = JSON.parse(page.body);
		return {
			title: undefined,
			byline: undefined,
			publishedTime: undefined,
			markdown: JSON.stringify(parsed, null, 2),
			mode: "json",
			keptRatio: 1,
		};
	} catch {
		// Malformed or streaming JSON (NDJSON, JSON Lines) — pass it through.
		return {
			title: undefined,
			byline: undefined,
			publishedTime: undefined,
			markdown: page.body.trim(),
			mode: "text",
			keptRatio: 1,
		};
	}
}

export function extract(page: FetchedPage, raw: boolean): Extracted {
	const type = page.contentType;

	if (type === "text/html" || type === "application/xhtml+xml") {
		return extractHtml(page, raw);
	}
	if (type === "application/json" || type.endsWith("+json") || type === "text/json") {
		return extractJson(page);
	}
	if (TEXT_TYPE_PATTERN.test(type)) {
		return {
			title: undefined,
			byline: undefined,
			publishedTime: undefined,
			markdown: page.body.trim(),
			mode: "text",
			keptRatio: 1,
		};
	}

	// No declared type: sniff, since plenty of servers omit the header.
	if (!type) {
		const looksHtml = /<\s*(!doctype\s+html|html|head|body|div|p)\b/i.test(page.body.slice(0, 2000));
		if (looksHtml) return extractHtml(page, raw);
		return {
			title: undefined,
			byline: undefined,
			publishedTime: undefined,
			markdown: page.body.trim(),
			mode: "text",
			keptRatio: 1,
		};
	}

	// Refuse binary rather than dumping it into the context window.
	throw new WebFetchError(
		`Cannot extract text from "${type}" (${page.bytes} bytes) at ${page.url}. ` +
			`web_fetch handles HTML, JSON, and plain text.`,
	);
}
