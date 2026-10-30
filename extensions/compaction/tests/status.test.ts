/**
 * The status codec: the footer text a session shows, and what the parent of a
 * Run reads back out of that same text. One codec serves both, so what a child
 * formats is exactly what its parent parses.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatStatus, parseStatus } from "../status.ts";

describe("the status codec", () => {
	it("writes the token count in thousands with a lowercase k", () => {
		assert.equal(formatStatus({ level: "notice", tokens: 124_000 }), "ctx notice · 124k");
		assert.equal(formatStatus({ level: "warning", tokens: 152_400 }), "ctx warning · 152k");
		assert.equal(formatStatus({ level: "warning", tokens: 151_500 }), "ctx warning · 152k");
		assert.equal(formatStatus("compacting"), "ctx compacting");
	});

	it("reads back every status it writes", () => {
		for (const status of [{ level: "notice", tokens: 124_000 }, { level: "warning", tokens: 152_000 }, "compacting"] as const) {
			assert.deepEqual(parseStatus(formatStatus(status)), status);
		}
	});

	it("reads a status through the colour a terminal theme put on it", () => {
		assert.deepEqual(parseStatus("\x1b[38;5;244mctx notice · 131k\x1b[39m"), { level: "notice", tokens: 131_000 });
	});

	it("reads nothing out of a cleared status or someone else's text", () => {
		assert.equal(parseStatus(undefined), undefined);
		assert.equal(parseStatus(""), undefined);
		assert.equal(parseStatus("ctx forced · 172k"), undefined);
		assert.equal(parseStatus("ctx notice · lots"), undefined);
		assert.equal(parseStatus("git main · 3 ahead"), undefined);
	});
});
