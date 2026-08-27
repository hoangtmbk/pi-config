/**
 * PDF → text, via unpdf (a packaged PDF.js).
 *
 * Page boundaries are kept as markers rather than flattened: a citation of
 * "page 34" is worthless once the pages are glued together, and the model needs
 * to be able to say where something came from.
 */

import { extractText, getDocumentProxy, getMeta } from "unpdf";

/** A book-length PDF would swamp the context window; 200 pages is already generous. */
const DEFAULT_MAX_PAGES = 200;

/** Below this, the "text" is page furniture — a scan with no text layer. */
const MIN_TEXT_CHARS = 20;

export interface PdfText {
	/** Extracted pages, joined by a horizontal rule and a page marker. */
	text: string;
	/** Pages in the document — not the number rendered; see `truncatedPages`. */
	pages: number;
	/** True when the document has more pages than `maxPages`, so `text` is partial. */
	truncatedPages: boolean;
	/** Document title from the PDF metadata, when it declares one. */
	title?: string;
}

/**
 * Extract text from PDF `bytes`. Throws when the document carries no text
 * layer, which is the common failure and needs to be said plainly.
 */
export async function pdfToText(bytes: Uint8Array, opts?: { maxPages?: number }): Promise<PdfText> {
	const maxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;
	const document = await getDocumentProxy(bytes);
	const { totalPages, text } = await extractText(document, { mergePages: false });

	const kept = text.slice(0, Math.max(maxPages, 0)).map((page) => page.trim());
	if (kept.join("").length < MIN_TEXT_CHARS) throw new Error("PDF has no extractable text (scanned image?)");

	let joined = kept[0] ?? "";
	for (let index = 1; index < kept.length; index++) joined += `\n\n---\n\n<!-- page ${index + 1} -->\n\n${kept[index]}`;

	const title = await documentTitle(document);
	return { text: joined, pages: totalPages, truncatedPages: totalPages > maxPages, ...(title ? { title } : {}) };
}

/** Metadata is optional and frequently malformed; never let it fail the extraction. */
async function documentTitle(document: Parameters<typeof getMeta>[0]): Promise<string | undefined> {
	try {
		const { info } = await getMeta(document);
		const title: unknown = info?.Title;
		return typeof title === "string" && title.trim() !== "" ? title.trim() : undefined;
	} catch {
		return undefined;
	}
}
