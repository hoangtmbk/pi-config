/**
 * Where the Brave API key comes from.
 *
 * Three forms, in one precedence order. A `BRAVE_API_KEY` already in the
 * environment wins; failing that, a `.env` beside this file, loaded with Node's
 * built-in `process.loadEnvFile` so there is no `dotenv` dependency — that
 * loader does not overwrite an existing variable, which is exactly the
 * precedence we want.
 *
 * Whichever holds the value, a `!` in front of it means "this is a command, run
 * it and use what it prints". That is what lets the key live in the macOS
 * keychain rather than on disk, which matters because the repo is public and
 * the file it would otherwise sit in is one mistake away from being pushed.
 * `$!` escapes a literal leading `!`, the same convention pi uses for provider
 * keys.
 *
 * The resolved value is cached for the life of the process: a keychain prompt
 * should fire once, not once per search. A failure is not cached, so fixing the
 * key takes effect on the next search rather than needing a restart.
 */

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DASHBOARD_URL, errorText, WebSearchError } from "./brave.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(EXTENSION_DIR, ".env");

/** A keychain lookup answers in milliseconds; anything slower is stuck. */
const COMMAND_TIMEOUT_MS = 10_000;

/** Runs a shell command and returns its stdout, or throws. Injected by the tests. */
export type CommandRunner = (command: string) => string;

export interface KeyDeps {
	/** The `.env` to consult. Defaults to the one beside this file. */
	envFile?: string;
	/** How a `!command` value is run. Defaults to a shell. */
	run?: CommandRunner;
}

/**
 * The resolved key, kept for the life of the process.
 *
 * Only ever written after a successful resolution — a failure must stay
 * repeatable so that setting the key fixes the next search.
 *
 * Keyed on nothing, because there is only ever one key per process: the `deps`
 * a caller passes are a test seam, not a second configuration, and a test that
 * varies them clears the cache first.
 */
let resolved: string | undefined;

/** Forget the cached key. For tests, and for anything that reloads the module. */
export function clearResolvedKey(): void {
	resolved = undefined;
}

/**
 * Load a `.env` if there is one. Its absence is the normal case, not a failure.
 *
 * Note what this costs: the loader writes into `process.env`, so a plain key in
 * the file is inherited by every process pi spawns — an agent that runs `env`
 * in a shell prints it into the transcript. The `!command` form avoids that
 * entirely: only the command string is exported, and the key it prints stays in
 * this module's memory.
 */
function loadEnvFileIfPresent(path: string): void {
	try {
		process.loadEnvFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw new WebSearchError(`Could not read ${path}: ${errorText(error)}`);
	}
}

/** The default runner: a shell, with only stdout read back. */
function runInShell(command: string): string {
	return execSync(command, {
		encoding: "utf-8",
		timeout: COMMAND_TIMEOUT_MS,
		// stdin is closed and stderr is dropped: a key command must never block on
		// input, and its diagnostics are not this tool's output.
		stdio: ["ignore", "pipe", "ignore"],
	});
}

/**
 * The key a `!command` value stands for.
 *
 * The command is named in every failure — it is the user's own text and the
 * only thing that says which lookup went wrong — but its output never is, since
 * that output is the key.
 */
function keyFromCommand(command: string, run: CommandRunner): string {
	// A bare `!` is a value someone started writing and did not finish. Left to
	// the shell it fails as "the argument 'file' cannot be empty", which names
	// nothing the reader can act on.
	if (!command) {
		throw new WebSearchError(
			"BRAVE_API_KEY is just `!`, which names no command to run. " +
				"Write the command after it, or the key itself instead.",
		);
	}

	let output: string;
	try {
		output = run(command);
	} catch (error) {
		throw new WebSearchError(
			`BRAVE_API_KEY runs \`${command}\`, and that command failed: ${errorText(error)}. ` +
				"Check the command, or replace it with the key itself.",
		);
	}

	// A command that exits 0 with nothing to say has still not produced a key,
	// and an empty subscription header fails as an opaque 401 a request later.
	const key = output.trim();
	if (!key) {
		throw new WebSearchError(
			`BRAVE_API_KEY runs \`${command}\`, and that command produced no output. ` +
				"Check that it prints the key on stdout.",
		);
	}
	return key;
}

/**
 * What a configured value actually means: a command to run, or the key itself.
 *
 * `$!` is the escape rather than `\!`, because a backslash in a `.env` file is
 * already the file format's own escape and would not survive the loader. The
 * escape is one level deep and stays that way: a key that genuinely begins with
 * `$!` cannot be written, which costs nothing, because a Brave key is
 * hexadecimal.
 */
function keyFromValue(value: string, run: CommandRunner): string {
	if (value.startsWith("!")) return keyFromCommand(value.slice(1).trim(), run);
	return value.startsWith("$!") ? value.slice(1) : value;
}

/** The key to search with. Throws when none is set anywhere. */
export function resolveApiKey(deps: KeyDeps = {}): string {
	if (resolved !== undefined) return resolved;

	loadEnvFileIfPresent(deps.envFile ?? ENV_FILE);

	const value = process.env.BRAVE_API_KEY?.trim();
	if (!value) {
		throw new WebSearchError(
			"No Brave Search API key: set BRAVE_API_KEY in the environment, or copy " +
				`extensions/web-search/.env.example to extensions/web-search/.env and paste a key from ${DASHBOARD_URL}. ` +
				"A value beginning with ! is run as a command, so the key can live in your keychain instead of on disk.",
		);
	}

	// Assigned only once the value is a key: a failed lookup must be repeatable.
	resolved = keyFromValue(value, deps.run ?? runInShell);
	return resolved;
}
