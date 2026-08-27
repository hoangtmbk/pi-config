/**
 * Charset decoding (defect 1.9).
 *
 * `decodeBody` is the one piece of `fetch.ts` that is pure enough to test
 * without a server: bytes in, text out.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeBody } from "../fetch.ts";
import { fixtureBytes } from "./helpers.ts";

/** "日本語テスト" in Shift_JIS. */
const SJIS_TEXT = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67]);

/** "中文" in GB2312. */
const GB2312_TEXT = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);

/** Wrap already-encoded body text in an ASCII HTML skeleton. */
function document(head: string, text: Uint8Array): Uint8Array {
	const prefix = new TextEncoder().encode(`<html><head>${head}</head><body><p>`);
	const suffix = new TextEncoder().encode("</p></body></html>");
	const out = new Uint8Array(prefix.length + text.length + suffix.length);
	out.set(prefix, 0);
	out.set(text, prefix.length);
	out.set(suffix, prefix.length + text.length);
	return out;
}

/** Mojibake shows up as U+FFFD; a correct decode never produces one here. */
function assertDecodesTo(decoded: string, expected: string): void {
	assert.ok(decoded.includes(expected), `expected ${JSON.stringify(expected)} in ${JSON.stringify(decoded)}`);
	assert.ok(!decoded.includes("�"), `replacement characters in ${JSON.stringify(decoded)}`);
}

describe("decodeBody", () => {
	it("honours <meta charset> when the header declares none", () => {
		assertDecodesTo(decodeBody(fixtureBytes("meta-sjis"), undefined), "日本語テスト");
	});

	it("honours <meta http-equiv> content-type charsets", () => {
		const body = document('<meta http-equiv="Content-Type" content="text/html; charset=gb2312">', GB2312_TEXT);
		assertDecodesTo(decodeBody(body, undefined), "中文");
	});

	it("prefers the header charset over the meta tag", () => {
		// The document lies: it claims utf-8 while the bytes are Shift_JIS.
		const body = document('<meta charset="utf-8">', SJIS_TEXT);
		assertDecodesTo(decodeBody(body, "shift_jis"), "日本語テスト");
	});

	it("defaults to utf-8 when nothing declares a charset", () => {
		const body = document("", new TextEncoder().encode("héllo"));
		assertDecodesTo(decodeBody(body, undefined), "héllo");
	});
});
