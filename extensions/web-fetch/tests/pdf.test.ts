/**
 * PDF text extraction, against PDFs built byte by byte by `makePdf` (helpers.ts).
 *
 * A fixture file would be opaque, and a network fetch is out of the question.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pdfToText } from "../pdf.ts";
import { makePdf } from "./helpers.ts";

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

	it("reports the document title when the metadata carries one", async () => {
		const titled = await pdfToText(makePdf([PAGE_ONE], "My Title"));
		assert.equal(titled.title, "My Title");
		const untitled = await pdfToText(makePdf([PAGE_ONE]));
		assert.equal(untitled.title, undefined);
	});

	it("rejects a document with no text layer", async () => {
		await assert.rejects(pdfToText(makePdf(["hi"])), /no extractable text/);
	});
});
