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
 *
 * Anything else it is asked to do exits 1 with a message saying so, so a test
 * that reaches further than the fake goes is loud about it.
 */

import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const argvOut = process.env.FAKE_CLAUDE_ARGV_OUT;
if (argvOut) appendFileSync(argvOut, `${JSON.stringify(argv)}\n`);

if (argv[0] === "--version") {
	process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.316 (Claude Code)"}\n`);
	process.exit(0);
}

process.stderr.write(`fake claude: no scripted behaviour for ${JSON.stringify(argv)}\n`);
process.exit(1);
