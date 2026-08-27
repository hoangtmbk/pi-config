/**
 * Where the Brave API key comes from.
 *
 * A `.env` beside this file, loaded with Node's built-in `process.loadEnvFile`
 * so there is no `dotenv` dependency. That loader does not overwrite a variable
 * already in the environment, which is exactly the precedence we want: a real
 * `BRAVE_API_KEY` beats the file, and the file is only a convenience.
 *
 * The repo is public, so `.env` is git-ignored and `.env.example` is the
 * committed template the error message points at.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorText, WebSearchError } from "./brave.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(EXTENSION_DIR, ".env");

const DASHBOARD_URL = "https://api-dashboard.search.brave.com/";

/** Load a `.env` if there is one. Its absence is the normal case, not a failure. */
function loadEnvFileIfPresent(path: string): void {
	try {
		process.loadEnvFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw new WebSearchError(`Could not read ${path}: ${errorText(error)}`);
	}
}

/** The key to search with. Throws when none is set anywhere. */
export function resolveApiKey(envFile: string = ENV_FILE): string {
	loadEnvFileIfPresent(envFile);

	const key = process.env.BRAVE_API_KEY?.trim();
	if (key) return key;

	throw new WebSearchError(
		"No Brave Search API key: set BRAVE_API_KEY in the environment, or copy " +
			`extensions/web-search/.env.example to extensions/web-search/.env and paste a key from ${DASHBOARD_URL}`,
	);
}
