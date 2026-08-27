/**
 * PDF text extraction, against PDFs built here byte by byte.
 *
 * A fixture file would be opaque (and a network fetch is out of the question),
 * so the test writes the smallest document PDF.js will accept: catalog, page
 * tree, one Helvetica font, and a text-showing content stream per page, with a
 * cross-reference table whose offsets are computed from the serialised output.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pdfToText } from "../pdf.ts";

/** A one-line PDF per page, each drawn with `Tj` so it lands in the text layer. */
function makePdf(pageTexts: string[]): Uint8Array {
	// Object ids: 1 catalog, 2 page tree, 3 font, then page/content pairs.
	const pageIds = pageTexts.map((_, index) => 4 + index * 2);
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	for (const [index, text] of pageTexts.entries()) {
		const stream = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`;
		objects.push(
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
				`/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index]! + 1} 0 R >>`,
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		);
	}

	// ASCII only, so string length is the byte offset each xref entry needs.
	let pdf = "%PDF-1.4\n";
	const offsets = objects.map((object, index) => {
		const offset = pdf.length;
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return offset;
	});
	const startxref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
	return new TextEncoder().encode(pdf);
}

const PAGE_ONE = "Hello PDF, this is page one.";
const PAGE_TWO = "And this is page two.";

describe("pdfToText", () => {
	it("extracts the text of a single-page document", async () => {
		const result = await pdfToText(makePdf([PAGE_ONE]));
		assert.ok(result.text.includes("Hello PDF"), result.text);
		assert.equal(result.pages, 1);
		assert.equal(result.truncatedPages, false);
		assert.ok(!result.text.includes("<!-- page"), "a single page needs no page marker");
	});

	it("separates pages with a rule and a page marker", async () => {
		const result = await pdfToText(makePdf([PAGE_ONE, PAGE_TWO]));
		assert.equal(result.pages, 2);
		assert.equal(result.truncatedPages, false);
		assert.match(result.text, /page one\.\n\n---\n\n<!-- page 2 -->\n\nAnd this is page two\./);
	});

	it("stops at maxPages and says so", async () => {
		const result = await pdfToText(makePdf([PAGE_ONE, PAGE_TWO]), { maxPages: 1 });
		assert.equal(result.pages, 2, "the page count is the document's, not the extract's");
		assert.equal(result.truncatedPages, true);
		assert.ok(result.text.includes("Hello PDF"), result.text);
		assert.ok(!result.text.includes("<!-- page 2 -->"), "the dropped page leaves no separator");
		assert.ok(!result.text.includes("page two"), result.text);
	});

	it("rejects a document with no text layer", async () => {
		await assert.rejects(pdfToText(makePdf(["hi"])), /no extractable text/);
	});
});
