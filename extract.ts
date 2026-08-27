/**
 * Content extraction for web_fetch.
 *
 * Routes by content type, and for HTML runs Readability to drop nav/ads/
 * sidebars before converting to markdown. The cleanup rules afterwards exist
 * because each one was observed wasting real tokens on real pages: tracking
 * query params, image URLs the model can never use, and the empty `[](#anchor)`
 * links GitHub emits next to every heading.
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

function configureBase(turndown: TurndownService): TurndownService {
	// Image URLs are pure cost: the model cannot fetch them and they are often
	// hundreds of characters of CDN parameters. Keep the alt text, drop the URL.
	turndown.addRule("imageAltOnly", {
		filter: "img",
		replacement: (_content, node) => {
			const alt = (node as Element).getAttribute?.("alt")?.trim();
			return alt ? `![${alt}]` : "";
		},
	});

	// Non-content elements Readability sometimes leaves behind.
	turndown.addRule("dropNonContent", {
		filter: ["script", "style", "noscript", "iframe", "form", "button", "svg", "canvas"],
		replacement: () => "",
	});

	return turndown;
}

const TURNDOWN_OPTIONS = {
	headingStyle: "atx",
	codeBlockStyle: "fenced",
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

function cleanMarkdown(markdown: string): string {
	return (
		markdown
			// Links with no visible text carry no information — GitHub emits one
			// per heading, Wikipedia one per citation marker.
			.replace(/\[\s*\]\([^)]*\)/g, "")
			// Anchors whose target we removed above.
			.replace(/\[([^\]]*)\]\(\s*\)/g, "$1")
			.replace(/[ \t]+$/gm, "")
			.replace(/\n{3,}/g, "\n\n")
			// Runs of separators left behind by stripped elements.
			.replace(/^(\s*[-*_]\s*){3,}$/gm, "---")
			.replace(/(\n---\n)+/g, "\n---\n")
			.trim()
	);
}

function extractHtml(page: FetchedPage, raw: boolean): Extracted {
	const { document } = parseHTML(page.body);

	// Strip before parsing so Readability never scores non-content, and so the
	// full-page fallback does not drag in script bodies.
	for (const element of Array.from(
		document.querySelectorAll("script, style, noscript, svg, canvas, iframe, template"),
	)) {
		element.remove();
	}

	absolutizeLinks(document, page.url);
	unwrapLayoutTables(document);

	const documentTitle = document.querySelector("title")?.textContent?.trim() || undefined;
	const metaContent = (selector: string) =>
		document.querySelector(selector)?.getAttribute("content")?.trim() || undefined;

	const turndown = createTurndown();

	if (!raw) {
		// Readability mutates the document, so hand it a clone.
		const article = (() => {
			try {
				return new Readability(document.cloneNode(true) as Document, { charThreshold: 100 }).parse();
			} catch {
				return null;
			}
		})();

		const articleMarkdown = article?.content ? cleanMarkdown(turndown.turndown(article.content)) : "";

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
	const markdown = cleanMarkdown(turndown.turndown((body as Element)?.innerHTML ?? page.body));

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
