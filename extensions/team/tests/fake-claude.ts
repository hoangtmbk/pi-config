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
 * - `FAKE_CLAUDE_HOOKS`: a JSON file of steps a started `--bg` session plays
 *   before the launch returns, in order: `{ event, payload? }` runs every hook
 *   command its `--settings` file gives for that event, as Claude Code does,
 *   with the payload on stdin and the inbox socket and token in the
 *   environment; `{ write: "result" }` writes the result its handoff pointer
 *   asks for. Each session gets a session id of its own unless a payload
 *   names one.
 *
 * Anything else it is asked to do exits 1 with a message saying so, so a test
 * that reaches further than the fake goes is loud about it.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

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
	else {
		play(launch.settings, argv.at(-1) ?? "");
		process.stdout.write("fake claude: background session started\n");
	}
	process.exit(exit);
}

/** One scripted step of a started session. */
type HookStep = { event: string; payload?: Record<string, unknown> } | { write: "result" };

/** Play the scripted steps of `FAKE_CLAUDE_HOOKS` against the session's settings and pointer. */
function play(settingsText: string | undefined, pointer: string): void {
	const script = process.env.FAKE_CLAUDE_HOOKS;
	if (!script) return;
	const steps = JSON.parse(readFileSync(script, "utf8")) as HookStep[];
	const settings = JSON.parse(settingsText ?? "{}") as { hooks?: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
	const sessionId = randomUUID();
	const inbox = { CLAUDE_CODE_MESSAGING_SOCKET: `/tmp/cc-socks/${process.pid}.sock`, CLAUDE_CODE_MESSAGING_TOKEN: `inbox-${sessionId.slice(0, 8)}` };
	for (const step of steps) {
		if ("write" in step) {
			const result = /write your result to (\S+\.md)\./.exec(pointer)?.[1];
			if (result === undefined) throw new Error(`fake claude: the pointer names no result to write: ${pointer}`);
			writeFileSync(result, "# Result\n\nDone.\n");
			continue;
		}
		const payload: Record<string, unknown> = { session_id: sessionId, cwd: process.cwd(), hook_event_name: step.event, ...step.payload };
		for (const group of settings.hooks?.[step.event] ?? []) {
			if (group.matcher !== undefined && group.matcher !== payload.tool_name) continue;
			for (const hook of group.hooks) {
				execFileSync("sh", ["-c", hook.command], { input: JSON.stringify(payload), env: { ...process.env, ...inbox }, stdio: ["pipe", "ignore", "inherit"] });
			}
		}
	}
}

process.stderr.write(`fake claude: no scripted behaviour for ${JSON.stringify(argv)}\n`);
process.exit(1);
