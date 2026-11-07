/**
 * Manual test runner: confirms against **real Claude Code** what the fake
 * `claude` in `tests/fake-claude.ts` can only imitate. Each case launches real
 * `claude --bg` Teammate sessions exactly as the extension does (its own
 * `teammateSettings`, `teammateArgs` and bundled mod), with this file standing in
 * for the Lead: a bridge on localhost that rings and answers the hooks, and
 * `lead.json` naming it.
 *
 * Not part of the extension load path and not part of `npm test`: the test
 * script globs `extensions/*\/tests/*.test.ts`, which this file sits beside
 * rather than in (`tests/live.test.ts` asserts it, and tests the pure parts
 * below against the fake `claude`). Everything that needs a real Claude Code, a
 * real account and real usage lives here, where a human runs it deliberately
 * and reads the output.
 *
 * Run with:
 *
 *   npm run live:team                          # every case
 *   npm run live:team -- --only inbox,clear    # these cases (`--list` names them)
 *   npm run live:team -- --model haiku         # sessions on that model
 *   CLAUDE_PATH=/path/to/claude npm run live:team
 *
 * It spends real usage: one short turn per case and a few per resumed session,
 * on tasks written to be as short as a turn can be. It prints `ok` or `FAIL`
 * per case, then what only a human at a terminal can check. Every session it
 * started is stopped (`claude stop`) before it exits, including on the way out
 * of a failure. Two things outside its temp folder are touched, as a real
 * Effort touches them: `claude --bg` registers its sessions with Claude Code,
 * and the throwaway repo's folder is marked trusted in `~/.claude.json`
 * (`trustFolder`), which is the only write to it.
 *
 * Left to the offline suite, which settles them without spending anything: the
 * core's state machine, the Lead's tools and everything pi-side. The pi-side of
 * a restart and a Takeover needs a real pi and a person, so it is the manual
 * list printed at the end.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Bridge, openBridge } from "./bridge.ts";
import {
	agentsList,
	CLEAR_MARKER,
	getUsage,
	humanStatusLine,
	installMod,
	launchBackground,
	MIN_CLAUDE_VERSION,
	sendToInbox,
	statusLineReading,
	stopBackground,
	teammateArgs,
	teammateSettings,
	trustFolder,
	versionWarning,
} from "./claude.ts";
import type { Inbox } from "./core.ts";
import type { Role } from "./definitions.ts";

const THIS_FILE = fileURLToPath(import.meta.url);

/** How long any one step waits on a real model before calling it a failure. */
const STEP_TIMEOUT_MS = 180_000;
const POLL_MS = 200;

/** What the runner was asked to do. */
export interface LiveArgs {
	claude: string;
	only: string[];
	model?: string;
	list: boolean;
}

/** The runner's arguments and environment, or what is wrong with them. */
export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): LiveArgs | { error: string } {
	const args: LiveArgs = { claude: env.CLAUDE_PATH || "claude", only: [], list: false };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--list") args.list = true;
		else if (flag === "--only" || flag === "--model") {
			const value = argv[++index];
			if (value === undefined || value.startsWith("--")) return { error: `\`${flag}\` needs a value` };
			if (flag === "--model") args.model = value;
			else args.only = value.split(",").filter((name) => name !== "");
		} else return { error: `unknown argument \`${flag}\`; known: --only <cases>, --model <id>, --list` };
	}
	return args;
}

/** A journal's lines (`teammates/<id>/events.jsonl`), skipping anything that isn't JSON. */
export function journalLines(text: string): JournalLine[] {
	const lines: JournalLine[] = [];
	for (const each of text.split("\n")) {
		try {
			const parsed: unknown = JSON.parse(each);
			if (typeof parsed === "object" && parsed !== null) lines.push(parsed as JournalLine);
		} catch {
			// A half-written line is read again on the next poll.
		}
	}
	return lines;
}

export interface JournalLine {
	from?: string;
	event?: string;
	request?: string;
	inbox?: Inbox;
	payload?: Record<string, unknown>;
}

/** The hook lines of one event, in the order they were journalled. */
export function hookLines(lines: readonly JournalLine[], event: string): JournalLine[] {
	return lines.filter((line) => line.from === "hook" && line.event === event);
}

/** One case: throws to fail. */
export interface Case {
	name: string;
	about: string;
	run(live: LiveEffort): Promise<void>;
}

/** Print `ok` / `FAIL` per case, then reap: whatever a case threw, every session it started is stopped. */
export async function runCases(cases: readonly Case[], live: LiveEffort, print: (line: string) => void): Promise<number> {
	let failures = 0;
	for (const each of cases) {
		try {
			await each.run(live);
			print(`ok    ${each.name}: ${each.about}`);
		} catch (error) {
			failures++;
			print(`FAIL  ${each.name}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			for (const problem of await live.reap()) {
				failures++;
				print(`FAIL  ${each.name}: ${problem}`);
			}
		}
	}
	return failures;
}

/** A session this runner launched, which it must stop. */
interface Launched {
	id: string;
	name: string;
}

/** The throwaway Effort every case launches into, and the Lead's side of it. */
export class LiveEffort {
	readonly effortDir: string;
	readonly repo: string;
	private readonly agentDir: string;
	private readonly launched: Launched[] = [];
	private bridge?: Bridge;
	private counter = 0;
	private readonly run = Math.random().toString(36).slice(2, 8);

	constructor(
		readonly claude: string,
		readonly model: string | undefined,
		private readonly claudeConfigPath: string,
		private readonly claudeDir: string,
		readonly root = mkdtempSync(join(tmpdir(), "team-live-")),
	) {
		this.effortDir = join(root, "effort");
		this.agentDir = join(root, "agent");
		mkdirSync(this.effortDir, { recursive: true });
		mkdirSync(this.agentDir, { recursive: true });
		const repo = join(root, "repo");
		mkdirSync(repo);
		execFileSync("git", ["init", "-q", "-b", "main", repo]);
		this.repo = realpathSync(repo);
		for (const [key, value] of [["user.name", "Live"], ["user.email", "live@example.com"], ["commit.gpgsign", "false"]]) execFileSync("git", ["config", key, value], { cwd: this.repo });
		writeFileSync(join(this.repo, "README.md"), "# live\n");
		execFileSync("git", ["add", "."], { cwd: this.repo });
		execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: this.repo });
	}

	/** Open the Lead's bridge and name it in `lead.json`, as an Effort's Lead does before its first launch. */
	async open(): Promise<void> {
		const trusted = trustFolder(this.claudeConfigPath, this.repo);
		if (trusted) throw new Error(trusted.error);
		this.bridge = await openBridge(() => {});
		writeFileSync(join(this.effortDir, "lead.json"), JSON.stringify({ port: this.bridge.port, token: this.bridge.token }));
	}

	/** Start a Teammate in `auto` the way the extension does, running `pointer` as its first turn. */
	async launch(pointer: string): Promise<Teammate> {
		const id = `live-${++this.counter}`;
		const name = `team-${this.run}-${id}`;
		const role: Role = { name: "live", description: "live runner", allowedTools: [], disallowedTools: [], mcpServers: {}, plugins: [], prompt: "", filePath: THIS_FILE, ...(this.model === undefined ? {} : { model: this.model }) };
		const args = teammateArgs({
			name,
			role,
			mode: "auto",
			effortDir: this.effortDir,
			dir: join(this.effortDir, "teammates", id),
			settings: teammateSettings({ effortDir: this.effortDir, teammateId: id, allow: [], deny: [], ask: [], records: [], workspace: this.repo, humanStatusLine: humanStatusLine(this.repo, this.claudeDir) }),
			prompt: "You are a test Teammate of a live runner. Do exactly what each message says, briefly, and nothing else.",
			pointer,
			mod: installMod(this.agentDir),
		});
		this.launched.push({ id, name });
		const failed = await launchBackground(this.claude, this.repo, args);
		if (failed) throw new Error(`\`claude --bg\` failed: ${failed.error}`);
		return new Teammate(this, id, name);
	}

	get bridgeOrThrow(): Bridge {
		if (!this.bridge) throw new Error("the Lead's bridge is not open");
		return this.bridge;
	}

	/** Stop every session this run launched, and say what would not stop. */
	async reap(): Promise<string[]> {
		const problems: string[] = [];
		const listed = await agentsList(this.claude);
		for (const each of this.launched.splice(0)) {
			const lines = journalLines(this.read(each.id));
			const sessions = lines.flatMap((line) => (typeof line.payload?.session_id === "string" ? [line.payload.session_id] : []));
			// A cleared or resumed session keeps its short id, which is the first session's; the newest is tried too.
			const shorts = [...new Set([sessions[0], sessions.at(-1)].filter((id): id is string => id !== undefined).map((id) => id.slice(0, 8)))];
			if (listed instanceof Map && !listed.has(each.name)) continue;
			let stopped = false;
			for (const target of shorts.length === 0 ? [each.name] : [...shorts, each.name]) if (!(await stopBackground(this.claude, target))) stopped = true;
			if (!stopped) problems.push(`could not stop ${each.name} (tried ${shorts.join(", ") || "its name"}); stop it with \`claude stop\``);
		}
		return problems;
	}

	private read(id: string): string {
		const file = join(this.effortDir, "teammates", id, "events.jsonl");
		return existsSync(file) ? readFileSync(file, "utf8") : "";
	}

	journal(id: string): JournalLine[] {
		return journalLines(this.read(id));
	}

	finish(): void {
		this.bridge?.close();
		rmSync(this.root, { recursive: true, force: true });
	}
}

/** One launched session, seen through its journal. */
export class Teammate {
	constructor(
		private readonly live: LiveEffort,
		readonly id: string,
		readonly name: string,
	) {}

	lines(): JournalLine[] {
		return this.live.journal(this.id);
	}

	/** Wait until `find` returns something from the journal. */
	async wait<T>(what: string, find: (lines: JournalLine[]) => T | undefined, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = find(this.lines());
			if (found !== undefined) return found;
			if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}; journal: ${this.lines().map((line) => `${line.from}:${line.event}`).join(" ")}`);
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
	}

	/** The first SessionStart's session id and inbox. */
	async started(): Promise<{ sessionId: string; inbox: Inbox }> {
		const line = await this.wait("SessionStart", (lines) => hookLines(lines, "SessionStart")[0]);
		const sessionId = line.payload?.session_id;
		if (typeof sessionId !== "string") throw new Error("SessionStart carried no session_id");
		if (!line.inbox) throw new Error("SessionStart carried no inbox: CLAUDE_CODE_MESSAGING_SOCKET and _TOKEN did not reach the hook");
		return { sessionId, inbox: line.inbox };
	}

	/** Wait for the n-th Stop (1-based), the turn that many turns in being done. */
	stop(nth = 1): Promise<JournalLine> {
		return this.wait(`Stop #${nth}`, (lines) => hookLines(lines, "Stop")[nth - 1]);
	}
}

const REPLY = (token: string): string => `Reply with exactly ${token} and nothing else, then stop. Use no tools.`;

function expect(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** Every case, in the order they run. */
export const CASES: Case[] = [
	{
		name: "inbox",
		about: "the SessionStart hook is handed an inbox socket and token, and a message sent as the extension sends one runs as a turn",
		async run(live) {
			const teammate = await live.launch(REPLY("LIVE-ONE"));
			const { inbox } = await teammate.started();
			expect(typeof inbox.socket === "string" && existsSync(inbox.socket) && statSync(inbox.socket).isSocket(), `inbox.socket ${inbox.socket} is not a socket that exists`);
			expect(typeof inbox.token === "string" && inbox.token.length > 0, "inbox.token is empty");
			await teammate.stop(1);
			const sent = await sendToInbox(inbox, REPLY("LIVE-TWO"));
			expect(!sent, `sendToInbox failed: ${sent?.error}`);
			await teammate.wait("the inbox message as a UserPromptSubmit", (lines) => hookLines(lines, "UserPromptSubmit").find((line) => String(line.payload?.prompt ?? "").includes("LIVE-TWO")));
			await teammate.stop(2);
			// What the clear case's mod relies on: the launch prompt and the inbox message are not the human's composer.
			const human = teammate.lines().filter((line) => line.from === "mod");
			expect(human.length === 0, `the launch prompt or inbox message was journalled as the human's: ${JSON.stringify(human)}`);
		},
	},
	{
		name: "clear",
		about: "the bundled mod turns the clear marker into /clear: SessionEnd clear, then SessionStart clear with a new session id, and no turn for the marker",
		async run(live) {
			const teammate = await live.launch(REPLY("LIVE-ONE"));
			const first = await teammate.started();
			await teammate.stop(1);
			expect(!(await sendToInbox(first.inbox, CLEAR_MARKER)), "sendToInbox of the clear marker failed");
			const ended = await teammate.wait("SessionEnd with reason clear", (lines) => hookLines(lines, "SessionEnd").find((line) => line.payload?.reason === "clear"));
			const restarted = await teammate.wait("SessionStart with source clear", (lines) => hookLines(lines, "SessionStart").find((line) => line.payload?.source === "clear"));
			expect(ended.payload?.session_id === first.sessionId, "the SessionEnd was not the first session's");
			expect(typeof restarted.payload?.session_id === "string" && restarted.payload.session_id !== first.sessionId, "the cleared session kept its session id");
			expect(!teammate.lines().some((line) => line.event === "UserPromptSubmit" && String(line.payload?.prompt ?? "").includes(CLEAR_MARKER)), "the marker ran as a turn instead of being consumed");
			// The cleared session is the Teammate still: its (possibly new) inbox takes the next pointer.
			const inbox = restarted.inbox ?? first.inbox;
			expect(!(await sendToInbox(inbox, REPLY("LIVE-AFTER"))), "the inbox after the clear refused a message");
			await teammate.wait("a turn after the clear", (lines) => hookLines(lines, "UserPromptSubmit").find((line) => String(line.payload?.prompt ?? "").includes("LIVE-AFTER")));
		},
	},
	{
		name: "ask",
		about: "an AskUserQuestion is held by the PermissionRequest hook and answered through it by the Lead's bridge",
		async run(live) {
			const teammate = await live.launch("Call the AskUserQuestion tool once with the single question `Which colour?` (header `Colour`, options `red` and `green`). Then reply COLOUR= and the answer you were given, and stop.");
			const held = await teammate.wait("a held PermissionRequest for AskUserQuestion", (lines) => hookLines(lines, "PermissionRequest").find((line) => line.payload?.tool_name === "AskUserQuestion" && line.request));
			const input = (held.payload?.tool_input ?? {}) as Record<string, unknown>;
			const questions = Array.isArray(input.questions) ? (input.questions as { question?: string }[]) : [];
			expect(questions.length > 0 && typeof questions[0].question === "string", `the held request has no questions: ${JSON.stringify(input)}`);
			const answered = live.bridgeOrThrow.answer(held.request as string, { behavior: "allow", updatedInput: { ...input, answers: { [questions[0].question as string]: "green" } } });
			expect(answered, "the hook was not holding its request open on the bridge");
			const stopped = await teammate.stop(1);
			expect(hookLines(teammate.lines(), "PostToolUse").some((line) => line.payload?.tool_name === "AskUserQuestion"), "the answered AskUserQuestion has no PostToolUse");
			expect(/green/i.test(String(stopped.payload?.last_assistant_message ?? "")), `the answer did not reach the model: ${String(stopped.payload?.last_assistant_message)}`);
		},
	},
	{
		name: "floor",
		about: "the floor hook's `ask` on a `git push` raises a held PermissionRequest even in auto, and a deny stops the call",
		async run(live) {
			const teammate = await live.launch("Run exactly this one Bash command and then stop, whatever it says: `git push origin main`. If it is refused, say REFUSED.");
			await teammate.wait("the PreToolUse for git push", (lines) => hookLines(lines, "PreToolUse").find((line) => String((line.payload?.tool_input as { command?: string } | undefined)?.command ?? "").includes("git push")));
			const held = await teammate.wait("a held PermissionRequest for the push", (lines) => hookLines(lines, "PermissionRequest").find((line) => line.payload?.tool_name === "Bash" && line.request));
			expect(String((held.payload?.tool_input as { command?: string } | undefined)?.command ?? "").includes("git push"), "the held request is not for the push");
			expect(live.bridgeOrThrow.answer(held.request as string, { behavior: "deny", message: "live runner: nothing is pushed" }), "the hook was not holding its request open on the bridge");
			await teammate.stop(1);
			expect(!hookLines(teammate.lines(), "PostToolUse").some((line) => line.payload?.tool_name === "Bash"), "the denied push ran");
		},
	},
	{
		name: "statusline",
		about: "the status line wrapper writes statusline.json for an unattached session, and the extension reads it",
		async run(live) {
			const teammate = await live.launch(REPLY("LIVE-ONE"));
			const { sessionId } = await teammate.started();
			await teammate.stop(1);
			const file = join(live.effortDir, "teammates", teammate.id, "statusline.json");
			await teammate.wait("statusline.json", () => (existsSync(file) ? true : undefined), 30_000);
			const reading = statusLineReading(readFileSync(file, "utf8"), teammate.id, new Date().toISOString());
			expect(reading !== undefined, "statusline.json is not a JSON object");
			expect(reading.sessionId === sessionId, `statusline.json is of session ${reading.sessionId}, not ${sessionId}`);
		},
	},
	{
		name: "wake",
		about: "after `claude stop`, the session is gone from `claude agents --json` and `--bg --resume` wakes it with a new socket and a resume SessionStart",
		async run(live) {
			const teammate = await live.launch(REPLY("LIVE-ONE"));
			const first = await teammate.started();
			await teammate.stop(1);
			const listed = await agentsList(live.claude);
			expect(listed instanceof Map && listed.has(teammate.name), `claude agents --json does not list ${teammate.name}: ${listed instanceof Map ? [...listed.keys()].join(", ") : listed.error}`);
			const stopped = await stopBackground(live.claude, first.sessionId.slice(0, 8));
			expect(!stopped, `claude stop ${first.sessionId.slice(0, 8)} failed: ${stopped?.error}`);
			const after = await agentsList(live.claude);
			expect(after instanceof Map && !after.has(teammate.name), "a stopped session is still listed by claude agents --json");
			const resumed = await launchBackground(live.claude, live.repo, ["--bg", "--resume", first.sessionId, REPLY("LIVE-WOKEN")]);
			expect(!resumed, `claude --bg --resume failed: ${resumed?.error}`);
			const start = await teammate.wait("a SessionStart with source resume", (lines) => hookLines(lines, "SessionStart").find((line) => line.payload?.source === "resume"));
			expect(start.inbox !== undefined, "the resumed session's SessionStart carried no inbox");
			await teammate.stop(2);
		},
	},
	{
		name: "fragile",
		about: "the dependencies on undocumented behaviour: the pinned version, get_usage's reply, and the registry listing",
		async run(live) {
			const warning = await versionWarning(live.claude);
			expect(warning === undefined, `${warning} (pinned ${MIN_CLAUDE_VERSION})`);
			const usage = await getUsage(live.claude, new Date().toISOString());
			expect("error" in usage ? false : true, `get_usage: ${"error" in usage ? usage.error : ""}`);
			if (!("error" in usage)) expect(!usage.rateLimits || usage.fiveHour !== undefined || usage.sevenDay !== undefined, "get_usage reported rate limits but no window");
		},
	},
];

/** What only a person at a terminal, or a real pi, can check. */
export const MANUAL = [
	"settings env reaching the mod: launch a Teammate from pi, attach (`/team attach`), type a prompt in its terminal; events.jsonl must gain a `from: mod`, `prompt.submit` line (TEAM_HOOK reached $.env.get and $.process.run ran the hook).",
	"/handback in the attached Teammate: it must be in the slash menu (registered in session.start) and journal a `handback` mod line; /team pending then shows the Takeover handed back.",
	"Takeover: Esc during a turn journals a `turn.complete` mod line, and the Team block shows the Teammate as taken over.",
	"a fresh start across a restart: with an Effort running, quit pi, start pi again and `/team resume`; the Teammate keeps its row, and a sign-off that was pending is asked again.",
	"the limit-message wording (limits.ts) can only be seen when an account hits a limit; compare the StopFailure text in a Teammate's events.jsonl with limits.test.ts's samples then.",
];

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2), process.env);
	if ("error" in args) {
		console.error(args.error);
		process.exit(2);
	}
	if (args.list) {
		for (const each of CASES) console.log(`${each.name.padEnd(11)} ${each.about}`);
		return;
	}
	const unknown = args.only.filter((name) => !CASES.some((each) => each.name === name));
	if (unknown.length > 0) {
		console.error(`unknown case: ${unknown.join(", ")}; known: ${CASES.map((each) => each.name).join(", ")}`);
		process.exit(2);
	}
	const chosen = args.only.length === 0 ? CASES : CASES.filter((each) => args.only.includes(each.name));
	const live = new LiveEffort(args.claude, args.model, join(homedir(), ".claude.json"), join(homedir(), ".claude"));
	let failures = 0;
	try {
		await live.open();
		console.log(`claude: ${args.claude}; effort folder: ${live.root}`);
		failures = await runCases(chosen, live, (line) => console.log(line));
	} finally {
		for (const problem of await live.reap()) {
			failures++;
			console.log(`FAIL  reap: ${problem}`);
		}
		live.finish();
	}
	console.log("\nManual, not covered here:");
	for (const each of MANUAL) console.log(`  - ${each}`);
	console.log(failures === 0 ? "\nall cases ok" : `\n${failures} failure${failures === 1 ? "" : "s"}`);
	process.exit(failures === 0 ? 0 : 1);
}

if (process.argv[1] === THIS_FILE) await main();
