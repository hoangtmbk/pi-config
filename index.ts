/**
 * web_fetch — fetch a URL and return clean, context-lean markdown.
 *
 * Output is truncated at pi's standard tool limits so a single fetch cannot
 * flood the context window. When that happens the complete markdown is written
 * to a temp file and the path is reported, so nothing is lost: the model can
 * `read` it with an offset or `grep` it for the part it actually needs.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
	truncateHead,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type Extracted, extract } from "./extract.ts";
import { fetchPage } from "./fetch.ts";

const WebFetchParams = Type.Object({
	url: Type.String({
		description: "Absolute URL to fetch (http or https)",
	}),
	raw: Type.Optional(
		Type.Boolean({
			description:
				"Skip main-content extraction and convert the whole page. Use for index, listing, or search-result pages where the article extractor drops the content you want.",
		}),
	),
});

interface WebFetchDetails {
	url: string;
	status: number;
	contentType: string;
	title?: string;
	mode: Extracted["mode"];
	chars: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

const SCRATCH_ROOT = join(tmpdir(), "pi-web-fetch");

/** Session-scoped scratch directory, tracked so it can be removed at shutdown. */
let scratchDir: string | undefined;
let pageCount = 0;

function safeSegment(value: string, max: number): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "page";
}

/**
 * Keyed on the session id rather than a random suffix so that `/reload`, which
 * tears down and rebuilds the extension without ending the session, lands on
 * the same directory instead of orphaning the previous one.
 */
async function saveFullPage(ctx: ExtensionContext, url: string, markdown: string): Promise<string> {
	if (!scratchDir) {
		const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
		scratchDir = join(SCRATCH_ROOT, safeSegment(sessionId || String(process.pid), 64));
		await mkdir(scratchDir, { recursive: true });
	}

	// Name files after the page so a directory listing stays readable.
	let hint = "page";
	try {
		const parsed = new URL(url);
		const lastPathSegment = parsed.pathname.split("/").filter(Boolean).pop();
		hint = safeSegment(`${parsed.hostname}${lastPathSegment ? `-${lastPathSegment}` : ""}`, 60);
	} catch {
		// Keep the default hint.
	}

	const path = join(scratchDir, `${String(++pageCount).padStart(3, "0")}-${hint}.md`);
	await writeFile(path, markdown, "utf8");
	return path;
}

/** Compact provenance block. Every line here is information the model cannot infer. */
function buildHeader(
	page: { url: string; status: number; contentType: string },
	extracted: Extracted,
	truncation: TruncationResult,
	fullOutputPath: string | undefined,
): string {
	const lines: string[] = [];

	if (extracted.title) lines.push(`# ${extracted.title}`);
	lines.push(`source: ${page.url} (${page.status} · ${page.contentType || "unknown type"})`);
	if (extracted.byline) lines.push(`author: ${extracted.byline}`);
	if (extracted.publishedTime) lines.push(`published: ${extracted.publishedTime}`);

	if (truncation.truncated) {
		lines.push(
			`${truncation.totalLines} lines · ${formatSize(truncation.totalBytes)} → ` +
				`showing ${truncation.outputLines} lines (${formatSize(truncation.outputBytes)})`,
		);
		if (fullOutputPath) lines.push(`full: ${fullOutputPath}`);
	} else {
		lines.push(`${truncation.totalLines} lines · ${formatSize(truncation.totalBytes)}`);
	}

	// Flag it when the article extractor was bypassed — affects how much the
	// model should trust the page structure it is reading.
	if (extracted.mode === "full-page") lines.push("note: whole page (no article extracted)");

	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async (event, _ctx) => {
		// "reload" rebuilds the extension while the conversation continues, and
		// "fork" carries the transcript into a new session. In both cases earlier
		// tool results still reference these paths, so the files must survive.
		if (event.reason === "reload" || event.reason === "fork") return;

		const dir = scratchDir;
		if (!dir) return;

		// Clear first so the handler is idempotent if it fires more than once.
		scratchDir = undefined;
		pageCount = 0;
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL and return its main content as clean markdown. Strips navigation, ads, scripts, and image URLs. " +
			"Handles HTML, JSON, and plain text. " +
			`Output is truncated at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; ` +
			"when truncated, the complete page is saved to a temp file whose path is reported, so it can be read or grepped in full.",
		promptSnippet: "Fetch a URL and read its main content as markdown",
		promptGuidelines: [
			"Use web_fetch to read a URL instead of curl or wget in bash — it returns clean markdown rather than raw HTML.",
			"When web_fetch reports that output was truncated, use grep or read on the reported temp file path rather than fetching the URL again.",
			"If web_fetch returns a page whose main content is missing (a listing, search-results, or index page), retry once with raw set to true.",
		],
		parameters: WebFetchParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const page = await fetchPage(params.url, signal);
			const extracted = extract(page, params.raw === true);

			if (!extracted.markdown.trim()) {
				throw new Error(
					`No readable content at ${page.url} (${page.contentType || "unknown type"}). ` +
						(params.raw ? "" : "The page may require JavaScript; retrying with raw: true may help."),
				);
			}

			const truncation = truncateHead(extracted.markdown, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			// Preserve the full document so truncation never loses information.
			// Removed when the session ends; see the session_shutdown handler.
			const fullOutputPath = truncation.truncated
				? await saveFullPage(ctx, page.url, extracted.markdown)
				: undefined;

			const header = buildHeader(page, extracted, truncation, fullOutputPath);

			const details: WebFetchDetails = {
				url: page.url,
				status: page.status,
				contentType: page.contentType,
				title: extracted.title,
				mode: extracted.mode,
				chars: extracted.markdown.length,
				truncation: truncation.truncated ? truncation : undefined,
				fullOutputPath,
			};

			return {
				content: [{ type: "text", text: `${header}\n\n---\n\n${truncation.content}` }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("web_fetch "));
			text += theme.fg("accent", args.url ?? "");
			if (args.raw) text += theme.fg("dim", " (raw)");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);

			const details = result.details as WebFetchDetails | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}

			let text = theme.fg("success", details.title || details.url);
			text += theme.fg("muted", ` · ${formatSize(details.chars)}`);
			if (details.mode === "full-page") text += theme.fg("dim", " · full page");
			if (details.truncation) text += theme.fg("warning", " · truncated");

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					for (const line of content.text.split("\n").slice(0, 30)) {
						text += `\n${theme.fg("dim", line)}`;
					}
				}
				if (details.fullOutputPath) {
					text += `\n${theme.fg("dim", `Full page: ${details.fullOutputPath}`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
