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
import { clearResolvedKey, resolveApiKey } from "../key.ts";
import { thrown } from "./helpers.ts";

const saved = process.env.BRAVE_API_KEY;
process.on("exit", () => {
	if (saved === undefined) delete process.env.BRAVE_API_KEY;
	else process.env.BRAVE_API_KEY = saved;
});

beforeEach(() => {
	delete process.env.BRAVE_API_KEY;
	clearResolvedKey();
});

/** Path to a `.env` holding `contents`, in a directory of its own. */
function envFile(contents: string): string {
	const path = join(mkdtempSync(join(tmpdir(), "pi-web-search-")), ".env");
	writeFileSync(path, contents, "utf8");
	return path;
}

describe("resolveApiKey", () => {
	it("reads the key from the .env file beside the extension", () => {
		assert.equal(resolveApiKey({ envFile: envFile("BRAVE_API_KEY=from-file\n") }), "from-file");
	});

	it("lets a key already in the environment win over the file", () => {
		process.env.BRAVE_API_KEY = "from-env";
		assert.equal(resolveApiKey({ envFile: envFile("BRAVE_API_KEY=from-file\n") }), "from-env");
	});

	it("treats a missing .env as ordinary — the environment alone is enough", () => {
		process.env.BRAVE_API_KEY = "from-env";
		const missing = join(mkdtempSync(join(tmpdir(), "pi-web-search-")), ".env");
		assert.equal(resolveApiKey({ envFile: missing }), "from-env");
	});

	it("ignores surrounding whitespace", () => {
		process.env.BRAVE_API_KEY = "  padded  ";
		assert.equal(resolveApiKey({ envFile: envFile("") }), "padded");
	});

	it("names the variable and the template when no key is set anywhere", () => {
		const missing = join(mkdtempSync(join(tmpdir(), "pi-web-search-")), ".env");
		const error = thrown(() => resolveApiKey({ envFile: missing }));
		assert.match(error.message, /BRAVE_API_KEY/);
		assert.match(error.message, /\.env\.example/);
	});

	it("treats an empty value as no key at all", () => {
		const error = thrown(() => resolveApiKey({ envFile: envFile("BRAVE_API_KEY=\n") }));
		assert.match(error.message, /BRAVE_API_KEY/);
	});
});

describe("a key that lives in a command", () => {
	it("runs a ! value and uses its output as the key", () => {
		process.env.BRAVE_API_KEY = "!security find-generic-password -s brave -w";
		const commands: string[] = [];
		const key = resolveApiKey({
			envFile: envFile(""),
			run: (command) => {
				commands.push(command);
				return "from-keychain\n";
			},
		});

		assert.equal(key, "from-keychain");
		// The `!` is the marker, not part of the command.
		assert.deepEqual(commands, ["security find-generic-password -s brave -w"]);
	});

	it("trims the trailing newline a command line tool leaves behind", () => {
		process.env.BRAVE_API_KEY = "!print-key";
		assert.equal(resolveApiKey({ envFile: envFile(""), run: () => "  spaced-key \n\n" }), "spaced-key");
	});

	it("reads a ! value out of the .env file too", () => {
		const key = resolveApiKey({ envFile: envFile("BRAVE_API_KEY=!print-key\n"), run: () => "from-file-command" });
		assert.equal(key, "from-file-command");
	});

	it("takes $! as an escaped literal !, for a key that really starts with one", () => {
		process.env.BRAVE_API_KEY = "$!literal-key";
		const key = resolveApiKey({
			envFile: envFile(""),
			run: () => assert.fail("an escaped value must not run anything"),
		});
		assert.equal(key, "!literal-key");
	});

	it("reports a command that fails, naming the command but never the key", () => {
		process.env.BRAVE_API_KEY = "!security find-generic-password -s brave -w";
		const error = thrown(() =>
			resolveApiKey({
				envFile: envFile(""),
				run: () => {
					throw new Error("The specified item could not be found in the keychain.");
				},
			}),
		);

		assert.match(error.message, /BRAVE_API_KEY/);
		assert.match(error.message, /security find-generic-password/);
		assert.match(error.message, /could not be found in the keychain/);
	});

	it("reports a command that prints nothing rather than searching with an empty key", () => {
		process.env.BRAVE_API_KEY = "!print-key";
		const error = thrown(() => resolveApiKey({ envFile: envFile(""), run: () => " \n" }));
		assert.match(error.message, /no output/i);
		assert.match(error.message, /print-key/);
	});
});

describe("the resolved key cache", () => {
	it("runs the command once per process, so a keychain prompt appears once", () => {
		process.env.BRAVE_API_KEY = "!print-key";
		let runs = 0;
		const run = () => {
			runs += 1;
			return "cached-key";
		};

		assert.equal(resolveApiKey({ envFile: envFile(""), run }), "cached-key");
		assert.equal(resolveApiKey({ envFile: envFile(""), run }), "cached-key");
		assert.equal(runs, 1);
	});

	it("caches a plain key too, so the .env is read once", () => {
		process.env.BRAVE_API_KEY = "plain-key";
		assert.equal(resolveApiKey({ envFile: envFile("") }), "plain-key");
		delete process.env.BRAVE_API_KEY;
		assert.equal(resolveApiKey({ envFile: envFile("") }), "plain-key");
	});

	it("does not cache a failure, so fixing the key does not need a restart", () => {
		const error = thrown(() => resolveApiKey({ envFile: envFile("") }));
		assert.match(error.message, /BRAVE_API_KEY/);

		process.env.BRAVE_API_KEY = "set-after-the-failure";
		assert.equal(resolveApiKey({ envFile: envFile("") }), "set-after-the-failure");
	});

	it("does not cache a failed command either", () => {
		process.env.BRAVE_API_KEY = "!print-key";
		let runs = 0;
		const run = () => {
			runs += 1;
			if (runs === 1) throw new Error("keychain locked");
			return "second-time-lucky";
		};

		assert.match(thrown(() => resolveApiKey({ envFile: envFile(""), run })).message, /keychain locked/);
		assert.equal(resolveApiKey({ envFile: envFile(""), run }), "second-time-lucky");
		assert.equal(runs, 2);
	});
});
