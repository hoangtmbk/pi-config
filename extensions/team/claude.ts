/**
 * The Claude adapter: the one module that knows the `claude` executable exists.
 *
 * Every fact this extension relies on about Claude Code was tried on 2.1.316,
 * so an older `claude` is worth a warning before an Effort leans on it. The
 * warning never stops anything: a newer or differently-built `claude` that
 * prints its version oddly should not lock the human out.
 *
 * It also pre-accepts the folder-trust dialog for the human's repo, which a
 * Teammate's `claude` would otherwise stop on with nobody there to answer.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

/**
 * Mark `repo` trusted in Claude Code's config at `configPath`
 * (`projects[repo].hasTrustDialogAccepted`), so a Teammate's `claude` in the
 * repo or any of its worktrees starts without the trust dialog. Everything
 * else in the config is kept, and the file is left untouched when the trust
 * is already there. Running Claude Code sessions rewrite this file too, so
 * the change is one quick read and an atomic replace. Returns an error to
 * show the human when the config isn't JSON this can safely add to.
 */
export function trustFolder(configPath: string, repo: string): { error: string } | undefined {
	const target = existsSync(configPath) ? realpathSync(configPath) : configPath;
	let config: unknown = {};
	if (existsSync(target)) {
		try {
			config = JSON.parse(readFileSync(target, "utf8"));
		} catch (error) {
			return { error: `Claude Code's config ${configPath} isn't valid JSON (${error instanceof Error ? error.message : String(error)}), so the repo's folder can't be marked trusted; fix or move that file` };
		}
	}
	if (!isObject(config) || (config.projects !== undefined && !isObject(config.projects))) {
		return { error: `Claude Code's config ${configPath} doesn't hold a \`projects\` object where expected, so the repo's folder can't be marked trusted; fix or move that file` };
	}
	const projects = config.projects ?? {};
	const project = projects[repo] ?? {};
	if (!isObject(project)) return { error: `Claude Code's config ${configPath} has a \`projects\` entry for ${repo} that isn't an object; fix or move that file` };
	if (project.hasTrustDialogAccepted === true) return undefined;
	const updated = { ...config, projects: { ...projects, [repo]: { ...project, hasTrustDialogAccepted: true } } };
	const temporary = join(dirname(target), `.${basename(target)}.team-${process.pid}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: existsSync(target) ? statSync(target).mode & 0o777 : 0o600 });
	renameSync(temporary, target);
	return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> & { projects?: Record<string, unknown> } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
