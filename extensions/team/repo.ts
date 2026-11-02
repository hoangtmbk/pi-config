/**
 * The repo an Effort works on: the git root of the folder pi runs in.
 *
 * The Brief records it, so it is fixed once, when the Effort is opened, and
 * read from `git` itself rather than guessed from a `.git` folder, which a
 * worktree or a submodule has as a file.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** The git root holding `cwd`, by its real path, or why there is none. */
export function repoRoot(cwd: string): { root: string } | { error: string } {
	try {
		const printed = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { root: realpathSync(printed.trim()) };
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		const reason = stderr || (error instanceof Error ? error.message : String(error));
		return { error: `${cwd} is not inside a git repo (git: ${reason.split("\n")[0]})` };
	}
}
