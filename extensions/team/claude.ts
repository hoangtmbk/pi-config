/**
 * The Claude adapter: the one module that knows the `claude` executable exists.
 *
 * Every fact this extension relies on about Claude Code was tried on 2.1.316,
 * so an older `claude` is worth a warning before an Effort leans on it. The
 * warning never stops anything: a newer or differently-built `claude` that
 * prints its version oddly should not lock the human out.
 */

import { execFile } from "node:child_process";

/** The Claude Code version this extension was built and tried against. */
export const MIN_CLAUDE_VERSION = "2.1.316";

/** Long enough for a cold start, short enough that `/team start` never hangs on it. */
const VERSION_TIMEOUT_MS = 10_000;

/** The leading `major.minor.patch` of what `claude --version` prints (`2.1.316 (Claude Code)`). */
const VERSION = /^\s*v?(\d+)\.(\d+)\.(\d+)/;

function parts(version: string): number[] | undefined {
	const match = VERSION.exec(version);
	return match ? match.slice(1, 4).map(Number) : undefined;
}

function older(version: number[], than: number[]): boolean {
	for (let index = 0; index < than.length; index++) {
		if (version[index] !== than[index]) return version[index] < than[index];
	}
	return false;
}

function run(claudePath: string, args: string[]): Promise<{ stdout: string } | { error: string }> {
	return new Promise((resolve) => {
		execFile(claudePath, args, { timeout: VERSION_TIMEOUT_MS, encoding: "utf8" }, (error, stdout) => {
			resolve(error ? { error: error.message.split("\n")[0] } : { stdout });
		});
	});
}

/**
 * What to tell the human about the `claude` at `claudePath`, or undefined when
 * it is at least {@link MIN_CLAUDE_VERSION}.
 */
export async function versionWarning(claudePath: string): Promise<string | undefined> {
	const result = await run(claudePath, ["--version"]);
	if ("error" in result) {
		return `could not run \`${claudePath}\` --version (${result.error}); Teammates need Claude Code ${MIN_CLAUDE_VERSION} or newer on the PATH`;
	}
	const printed = result.stdout.trim();
	const version = parts(printed);
	if (!version) {
		return `could not read a version from \`${claudePath}\` --version: ${JSON.stringify(printed)}; this extension was tried on Claude Code ${MIN_CLAUDE_VERSION}`;
	}
	const minimum = parts(MIN_CLAUDE_VERSION) ?? [];
	if (older(version, minimum)) {
		return `claude ${version.join(".")} is older than ${MIN_CLAUDE_VERSION}, the version this extension was tried on; update Claude Code if Teammates misbehave`;
	}
	return undefined;
}
