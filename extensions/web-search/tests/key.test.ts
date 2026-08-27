/**
 * Key resolution: the `.env` beside the extension, and the precedence between
 * that file and a variable already in the environment.
 *
 * Every test drives a temp `.env` path, so nothing here reads the developer's
 * own key — and `process.env` is restored afterwards because `loadEnvFile`
 * writes into it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { resolveApiKey } from "../key.ts";
import { thrown } from "./helpers.ts";

const saved = process.env.BRAVE_API_KEY;
process.on("exit", () => {
	if (saved === undefined) delete process.env.BRAVE_API_KEY;
	else process.env.BRAVE_API_KEY = saved;
});

beforeEach(() => {
	delete process.env.BRAVE_API_KEY;
});

/** Path to a `.env` holding `contents`, in a directory of its own. */
function envFile(contents: string): string {
	const path = join(mkdtempSync(join(tmpdir(), "pi-web-search-")), ".env");
	writeFileSync(path, contents, "utf8");
	return path;
}

describe("resolveApiKey", () => {
	it("reads the key from the .env file beside the extension", () => {
		assert.equal(resolveApiKey(envFile("BRAVE_API_KEY=from-file\n")), "from-file");
	});

	it("lets a key already in the environment win over the file", () => {
		process.env.BRAVE_API_KEY = "from-env";
		assert.equal(resolveApiKey(envFile("BRAVE_API_KEY=from-file\n")), "from-env");
	});

	it("treats a missing .env as ordinary — the environment alone is enough", () => {
		process.env.BRAVE_API_KEY = "from-env";
		const missing = join(mkdtempSync(join(tmpdir(), "pi-web-search-")), ".env");
		assert.equal(resolveApiKey(missing), "from-env");
	});

	it("ignores surrounding whitespace", () => {
		process.env.BRAVE_API_KEY = "  padded  ";
		assert.equal(resolveApiKey(envFile("")), "padded");
	});

	it("names the variable and the template when no key is set anywhere", () => {
		const missing = join(mkdtempSync(join(tmpdir(), "pi-web-search-")), ".env");
		const error = thrown(() => resolveApiKey(missing));
		assert.match(error.message, /BRAVE_API_KEY/);
		assert.match(error.message, /\.env\.example/);
	});

	it("treats an empty value as no key at all", () => {
		const error = thrown(() => resolveApiKey(envFile("BRAVE_API_KEY=\n")));
		assert.match(error.message, /BRAVE_API_KEY/);
	});
});
