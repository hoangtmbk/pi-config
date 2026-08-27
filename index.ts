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
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type Extracted, extract } from "./extract.ts";
import { WebFetchError, fetchPage } from "./fetch.ts";
import { buildHeader, safeSegment, sliceBytes, tempFileName } from "./format.ts";

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

/** Metadata only — never the shown markdown, which is already in `content`. */
interface WebFetchDetails {
	finalUrl: string;
	status: number;
	contentType: string;
	mode: Extracted["mode"];
	keptRatio: number;
	totalLines: number;
	totalBytes: number;
	shownLines: number;
	shownBytes: number;
	elapsedMs: number;
	/** Where the complete markdown was saved; absent when nothing was truncated. */
	path?: string;
}

const SCRATCH_ROOT = join(tmpdir(), "pi-web-fetch");

/**
 * Session-scoped scratch directory, derived rather than remembered: pi loads
 * extensions with `moduleCache: false`, so `/reload` re-evaluates this module
 * and any state kept here would be lost while the files stay on disk.
 */
function scratchDir(ctx: ExtensionContext): string {
	const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
	return join(SCRATCH_ROOT, safeSegment(sessionId || String(process.pid), 64, "session"));
}

async function saveFullPage(
	ctx: ExtensionContext,
	toolCallId: string,
	url: string,
	markdown: string,
): Promise<string> {
	const dir = scratchDir(ctx);
	// Unconditional, so parallel tool calls cannot race one another into ENOENT.
	await mkdir(dir, { recursive: true });
	const path = join(dir, tempFileName(toolCallId, url));
	await writeFile(path, markdown, "utf8");
	return path;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async (event, ctx) => {
		// "reload" rebuilds the extension while the conversation continues, and
		// "fork" carries the transcript into a new session. In both cases earlier
		// tool results still reference these paths, so the files must survive.
		if (event.reason === "reload" || event.reason === "fork") return;

		await rm(scratchDir(ctx), { recursive: true, force: true }).catch(() => {});
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL and return it as clean markdown. No JavaScript is executed, so single-page apps may come back empty. " +
			"Extracts the main content by default, dropping navigation, ads, scripts, and image URLs; set raw to convert the whole page instead. " +
			"Handles HTML, JSON, PDF, and plain text. " +
			"GitHub blob, Stack Exchange, npm, Wikipedia, arXiv, and PyPI URLs are fetched from their cleaner machine-readable source, and the swap is reported in the header. " +
			`Output is truncated at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; ` +
			"when truncated, the complete markdown is saved to a session-scoped file whose path is reported, so it can be read with an offset or grepped in full.",
		promptSnippet: "Fetch a URL and read its main content as markdown",
		promptGuidelines: [
			"Use web_fetch instead of curl/bash for web pages, docs, and PDFs.",
			"If web_fetch output is truncated, grep the saved file for headings or keywords before reading it with offset.",
			"For documentation sites try <site>/llms.txt first; for GitHub issues/PRs prefer the gh CLI.",
		],
		parameters: WebFetchParams,

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const startedAt = Date.now();
			const page = await fetchPage(params.url, signal, { allowPdf: true });
			const extracted = await extract(page, params.raw === true);

			if (!extracted.markdown.trim()) {
				throw new WebFetchError(
					`No readable content at ${page.url} (${page.contentType || "unknown type"}). ` +
						(params.raw ? "" : "The page may require JavaScript; retrying with raw: true may help."),
				);
			}

			const truncation = truncateHead(extracted.markdown, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			// pi returns an empty body when line 1 alone busts the byte cap
			// (minified pages). Show the head of that line rather than nothing.
			const shown = truncation.firstLineExceedsLimit
				? sliceBytes(extracted.markdown, DEFAULT_MAX_BYTES)
				: truncation.content;
			const shownBytes = truncation.firstLineExceedsLimit
				? Buffer.byteLength(shown, "utf8")
				: truncation.outputBytes;

			// Preserve the full document so truncation never loses information.
			// Removed when the session ends; see the session_shutdown handler.
			const path = truncation.truncated
				? await saveFullPage(ctx, toolCallId, page.url, extracted.markdown)
				: undefined;

			const header = buildHeader(
				{
					finalUrl: page.url,
					requestedUrl: page.requestedUrl,
					status: page.status,
					contentType: page.contentType,
					note: page.note,
					truncatedAtBytes: page.truncatedAtBytes,
					bytes: page.bytes,
					title: extracted.title,
					byline: extracted.byline,
					publishedTime: extracted.publishedTime,
					mode: extracted.mode,
					keptRatio: extracted.keptRatio,
					truncation,
					fullOutputPath: path,
					shownBytes,
				},
				formatSize,
			);

			const details: WebFetchDetails = {
				finalUrl: page.url,
				status: page.status,
				contentType: page.contentType,
				mode: extracted.mode,
				keptRatio: extracted.keptRatio,
				totalLines: truncation.totalLines,
				totalBytes: truncation.totalBytes,
				shownLines: truncation.firstLineExceedsLimit ? 1 : truncation.outputLines,
				shownBytes,
				elapsedMs: Date.now() - startedAt,
				path,
			};

			return {
				content: [{ type: "text", text: `${header}\n\n---\n\n${shown}` }],
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

			// The saved file exists only when something was cut.
			const truncated = details.path !== undefined;
			let mode = details.mode as string;
			if (details.keptRatio < 1) mode += ` ${Math.round(details.keptRatio * 100)}%`;

			let text = theme.fg("success", mode);
			text += theme.fg(
				"muted",
				truncated
					? ` · ${details.shownLines}/${details.totalLines} lines · ${formatSize(details.shownBytes)}`
					: ` · ${details.totalLines} lines · ${formatSize(details.totalBytes)}`,
			);
			if (truncated) text += theme.fg("warning", " · truncated");

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					for (const line of content.text.split("\n").slice(0, 30)) {
						text += `\n${theme.fg("dim", line)}`;
					}
				}
				if (details.path) text += `\n${theme.fg("dim", `Full page: ${details.path}`)}`;
			}

			return new Text(text, 0, 0);
		},
	});
}
