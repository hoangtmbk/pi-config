#!/usr/bin/env node
/**
 * A stand-in for the `claude` executable, so no test ever runs the real one.
 *
 * Driven by environment variables the test sets through `fakeClaude()`:
 *
 * - `FAKE_CLAUDE_VERSION`: what `claude --version` prints, as the real one
 *   does (`2.1.316 (Claude Code)`). Unset prints the pinned version.
 * - `FAKE_CLAUDE_ARGV_OUT`: a file each invocation appends its argv to, one
 *   JSON array per line, so a test can see exactly how it was called.
 * - `FAKE_CLAUDE_LAUNCH_OUT`: a file each `--bg` launch appends one JSON line
 *   to: its argv, the folder it ran in, whether
 *   `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` was set, and the contents
 *   of the files its `--settings`, `--append-system-prompt-file` and
 *   `--mcp-config` named, read at launch as the real one reads them.
 * - `FAKE_CLAUDE_BG_EXIT`: the exit code of a `--bg` launch, `0` when unset;
 *   any other code prints a failure to stderr first.
 *
 * Anything else it is asked to do exits 1 with a message saying so, so a test
 * that reaches further than the fake goes is loud about it.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const argvOut = process.env.FAKE_CLAUDE_ARGV_OUT;
if (argvOut) appendFileSync(argvOut, `${JSON.stringify(argv)}\n`);

if (argv[0] === "--version") {
	process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.316 (Claude Code)"}\n`);
	process.exit(0);
}

/** The contents of the file a flag names, or undefined when the flag or the file is absent. */
function fileOf(flag: string): string | undefined {
	const index = argv.indexOf(flag);
	const path = index === -1 ? undefined : argv[index + 1];
	return path !== undefined && existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

if (argv[0] === "--bg") {
	const launchOut = process.env.FAKE_CLAUDE_LAUNCH_OUT;
	const launch = {
		argv,
		cwd: process.cwd(),
		additionalDirectoriesClaudeMd: process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD,
		settings: fileOf("--settings"),
		prompt: fileOf("--append-system-prompt-file"),
		mcpConfig: fileOf("--mcp-config"),
	};
	if (launchOut) appendFileSync(launchOut, `${JSON.stringify(launch)}\n`);
	const exit = Number(process.env.FAKE_CLAUDE_BG_EXIT ?? "0");
	if (exit !== 0) process.stderr.write("fake claude: the background session could not start\n");
	else process.stdout.write("fake claude: background session started\n");
	process.exit(exit);
}

process.stderr.write(`fake claude: no scripted behaviour for ${JSON.stringify(argv)}\n`);
process.exit(1);
