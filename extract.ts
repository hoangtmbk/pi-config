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
}

/** Readability output shorter than this means it almost certainly ate the page. */
const MIN_ARTICLE_CHARS = 200;

/** Content types that are text but not HTML — passed through untouched. */
const TEXT_TYPE_PATTERN =
	/^text\/(plain|markdown|csv|tab-separated-values|x-|css|yaml)|^application\/(x-)?(yaml|toml|x-sh|javascript|typescript|xml)$|\+xml$/;

const TRACKING_PARAM_PATTERN = /^(utm_[a-z_]+|fbclid|gclid|mc_[a-z]+|ref|ref_src|source|_hs[a-z]+|igshid|si)$/i;

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

/** Direct children of a table, skipping any nested table's own rows and cells. */
function ownDescendants(table: Element, selector: string): Element[] {
	return Array.from(table.querySelectorAll(selector)).filter((element) => element.closest("table") === table);
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

			const toCells = (row: Element) =>
				Array.from(row.querySelectorAll("th, td"))
					.filter((cell) => cell.closest("tr") === row)
					.map((cell) =>
						cellConverter
							.turndown(cell.innerHTML ?? "")
							.replace(/\|/g, "\\|")
							.replace(/\s*\n+\s*/g, " ")
							.trim(),
					);

			const grid = rows.map(toCells).filter((cells) => cells.length > 0);
			if (grid.length === 0) return "";

			const width = Math.max(...grid.map((cells) => cells.length));
			const pad = (cells: string[]) => [...cells, ...Array(width - cells.length).fill("")];

			const [header, ...body] = grid;
			const lines = [
				`| ${pad(header).join(" | ")} |`,
				`| ${Array(width).fill("---").join(" | ")} |`,
				...body.map((cells) => `| ${pad(cells).join(" | ")} |`),
			];
			return `\n\n${lines.join("\n")}\n\n`;
		},
	});

	return turndown;
}

/**
 * Replace layout tables with their cell contents.
 *
 * Sites like Hacker News build their entire page from nested tables. Rendering
 * those as markdown tables costs more characters than the source HTML and
 * flattens the content inside them. A table with no `<th>` is treated as
 * layout; genuine data tables essentially always mark their headers.
 *
 * Unwrapping innermost-first (tables with no nested table) keeps cell contents
 * in document order.
 */
function unwrapLayoutTables(document: Document): void {
	for (let pass = 0; pass < 100; pass++) {
		const layoutTables = Array.from(document.querySelectorAll("table")).filter(
			(table) => !table.querySelector("th") && !table.querySelector("table"),
		);
		if (layoutTables.length === 0) return;

		for (const table of layoutTables) {
			const holder = document.createElement("div");
			for (const cell of ownDescendants(table, "td")) {
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

/** Regions whose heading names the site, not the article. */
const CHROME_REGIONS = "header, nav, footer, aside";

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
 */
function restoreLeadHeading(content: string, document: Document): string {
	const outsideChrome = (selector: string) =>
		Array.from(document.querySelectorAll(selector)).find(
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

function extractHtml(page: FetchedPage, raw: boolean): Extracted {
	const { document } = parseHTML(page.body);

	stripNonContent(document);
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

	if (!raw) {
		// Readability mutates the document, so hand it a clone.
		const article = (() => {
			try {
				return new Readability(document.cloneNode(true) as Document, {
					charThreshold: 100,
					keepClasses: true,
				}).parse();
			} catch {
				return null;
			}
		})();

		const articleMarkdown = article?.content
			? turndown.turndown(restoreLeadHeading(article.content, document)).trim()
			: "";

		// Fall back when Readability returns nothing usable. This is the main
		// robustness guarantee: listing pages and app shells still produce output.
		if (articleMarkdown.length >= MIN_ARTICLE_CHARS) {
			return {
				title: article?.title?.trim() || documentTitle,
				byline: article?.byline?.trim() || metaContent('meta[name="author"]'),
				publishedTime:
					article?.publishedTime?.trim() ||
					metaContent('meta[property="article:published_time"]'),
				markdown: articleMarkdown,
				mode: "article",
			};
		}
	}

	const body = document.querySelector("body") ?? document.documentElement;
	const markdown = turndown.turndown((body as Element)?.innerHTML ?? page.body).trim();

	return {
		title: documentTitle,
		byline: metaContent('meta[name="author"]'),
		publishedTime: metaContent('meta[property="article:published_time"]'),
		markdown,
		mode: "full-page",
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
		};
	} catch {
		// Malformed or streaming JSON (NDJSON, JSON Lines) — pass it through.
		return {
			title: undefined,
			byline: undefined,
			publishedTime: undefined,
			markdown: page.body.trim(),
			mode: "text",
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
		};
	}

	// Refuse binary rather than dumping it into the context window.
	throw new WebFetchError(
		`Cannot extract text from "${type}" (${page.bytes} bytes) at ${page.url}. ` +
			`web_fetch handles HTML, JSON, and plain text.`,
	);
}
