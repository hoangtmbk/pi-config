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

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Inbox, UsageReading, UsageWindow } from "./core.ts";
import type { PermissionMode, Role } from "./definitions.ts";

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

/** Long enough for `claude --bg` to hand the session to its daemon and return. */
const LAUNCH_TIMEOUT_MS = 60_000;

/**
 * Run a `claude --bg` launch in `cwd`, which returns once the background
 * session is started. `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is
 * removed from its environment, so the Effort directory added with
 * `--add-dir` never contributes a CLAUDE.md. Returns an error to show the
 * Lead when the launch fails.
 */
export function launchBackground(claudePath: string, cwd: string, args: string[]): Promise<{ error: string } | undefined> {
	const env = { ...process.env };
	delete env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD;
	return new Promise((resolve) => {
		execFile(claudePath, args, { cwd, env, timeout: LAUNCH_TIMEOUT_MS, encoding: "utf8" }, (error, _stdout, stderr) => {
			resolve(error ? { error: (stderr.trim() || error.message).split("\n")[0] } : undefined);
		});
	});
}

/** Long enough for `claude stop` to end a background session. */
const STOP_TIMEOUT_MS = 30_000;

/**
 * Stop a background session with `claude stop <short id>`, which keeps its
 * conversation. Returns an error to show the Lead when it fails.
 */
export function stopBackground(claudePath: string, shortId: string): Promise<{ error: string } | undefined> {
	return new Promise((resolve) => {
		execFile(claudePath, ["stop", shortId], { timeout: STOP_TIMEOUT_MS, encoding: "utf8" }, (error, _stdout, stderr) => {
			resolve(error ? { error: (stderr.trim() || error.message).split("\n")[0] } : undefined);
		});
	});
}

/** Long enough for a live session's inbox to take one message. */
const SEND_TIMEOUT_MS = 10_000;

/**
 * Send one user message to a Claude Code session's inbox socket: the auth
 * line with its token, then the message, one JSON object per line. Returns an
 * error to show the Lead when it doesn't get through.
 */
export function sendToInbox(inbox: Inbox, content: string): Promise<{ error: string } | undefined> {
	return new Promise((resolve) => {
		let failure: string | undefined;
		const socket = connect(inbox.socket);
		socket.setTimeout(SEND_TIMEOUT_MS, () => {
			failure = `no answer from ${inbox.socket} within ${SEND_TIMEOUT_MS / 1000}s`;
			socket.destroy();
		});
		socket.on("error", (error) => {
			failure ??= error.message;
		});
		socket.on("data", () => {});
		socket.on("close", () => resolve(failure === undefined ? undefined : { error: failure }));
		socket.on("connect", () => {
			socket.end(
				`${JSON.stringify({ type: "auth", token: inbox.token })}\n${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`,
			);
		});
	});
}

/** What `claude agents --json` says of one live background session. */
export interface AgentStatus {
	status?: string;
	state?: string;
	waitingFor?: string;
}

/** Long enough for `claude agents --json` to list the background sessions. */
const AGENTS_TIMEOUT_MS = 10_000;

/**
 * The live background sessions, from `claude agents --json`, by `--name`: a
 * session missing from it was stopped, idle or not. Its shape is read
 * leniently, as a list of sessions or an object holding one, since Claude
 * Code doesn't document it; a session without a name is left out.
 */
export function agentsList(claudePath: string): Promise<Map<string, AgentStatus> | { error: string }> {
	return new Promise((resolve) => {
		execFile(claudePath, ["agents", "--json"], { timeout: AGENTS_TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) return resolve({ error: (stderr.trim() || error.message).split("\n")[0] });
			let parsed: unknown;
			try {
				parsed = JSON.parse(stdout);
			} catch {
				return resolve({ error: "`claude agents --json` printed something that isn't JSON" });
			}
			const holder = isObject(parsed) ? parsed : {};
			const list = Array.isArray(parsed) ? parsed : [holder.agents, holder.sessions].find(Array.isArray);
			const agents = new Map<string, AgentStatus>();
			for (const entry of (list ?? []) as unknown[]) {
				if (!isObject(entry) || typeof entry.name !== "string") continue;
				const status: AgentStatus = {};
				for (const key of ["status", "state", "waitingFor"] as const) {
					const value = entry[key];
					if (typeof value === "string") status[key] = value;
				}
				agents.set(entry.name, status);
			}
			resolve(agents);
		});
	});
}

/**
 * The command that attaches a terminal to a Teammate's session, as the human
 * types it: `claude attach <short id>`, the executable quoted only when it
 * needs to be.
 */
export function attachCommand(claudePath: string, shortId: string): string {
	const claude = /^[\w@%+=:,./-]+$/.test(claudePath) ? claudePath : shellQuote(claudePath);
	return `${claude} attach ${shortId}`;
}

/**
 * Run `claude attach <short id>` on pi's own terminal, its stdio inherited,
 * until the human leaves it. Resolves with its exit code, or an error when it
 * couldn't start.
 */
export function attachHere(claudePath: string, shortId: string): Promise<{ code: number | null } | { error: string }> {
	return new Promise((resolve) => {
		const child = spawn(claudePath, ["attach", shortId], { stdio: "inherit" });
		child.on("error", (error) => resolve({ error: error.message }));
		child.on("exit", (code) => resolve({ code }));
	});
}

/** What a Teammate's `claude --bg` launch is made from. */
export interface TeammateLaunch {
	/** `--name`, `team-<effort-id>-<teammate-id>`, which is how `claude agents --json` finds it. */
	name: string;
	role: Role;
	/** The `--permission-mode` in force, always passed so the human's default never decides it. */
	mode: PermissionMode;
	/** Added with `--add-dir`, so reading the Brief and writing the Task folder never prompts. */
	effortDir: string;
	/** The Teammate's own folder, which the launch files are written to. */
	dir: string;
	/** The `--settings` file's object, added to the human's own settings. */
	settings: Record<string, unknown>;
	/** The `--append-system-prompt-file` text. */
	prompt: string;
	/** The first handoff pointer, run as the first turn. */
	pointer: string;
	/** The per-user copy of the Team's mod ({@link installMod}), loaded with `--plugin-dir` before the Role's own plugins. */
	mod?: string;
}

/**
 * Write the launch files into `launch.dir` and return the `claude` argv.
 * `--name` and the prompt come last: `--add-dir`, `--allowedTools`,
 * `--disallowedTools`, `--mcp-config` and `--plugin-dir` each take any number
 * of values, and would otherwise swallow the prompt as one more.
 */
export function teammateArgs(launch: TeammateLaunch): string[] {
	const { role } = launch;
	mkdirSync(launch.dir, { recursive: true });
	const settings = join(launch.dir, "settings.json");
	const prompt = join(launch.dir, "prompt.md");
	writeFileSync(settings, `${JSON.stringify(launch.settings, null, 2)}\n`);
	writeFileSync(prompt, launch.prompt);
	const args = ["--bg"];
	if (role.model !== undefined) args.push("--model", role.model);
	if (role.effort !== undefined) args.push("--effort", role.effort);
	args.push("--permission-mode", launch.mode, "--settings", settings, "--append-system-prompt-file", prompt, "--add-dir", launch.effortDir);
	if (role.allowedTools.length > 0) args.push("--allowedTools", ...role.allowedTools);
	args.push("--disallowedTools", ...role.disallowedTools.filter((tool) => tool !== "EnterPlanMode"), "EnterPlanMode");
	if (Object.keys(role.mcpServers).length > 0) {
		// Never `--strict-mcp-config`: the Role's servers add to the human's own.
		const mcp = join(launch.dir, "mcp.json");
		writeFileSync(mcp, `${JSON.stringify({ mcpServers: role.mcpServers }, null, 2)}\n`);
		args.push("--mcp-config", mcp);
	}
	if (launch.mod !== undefined) args.push("--plugin-dir", launch.mod);
	for (const plugin of role.plugins) args.push("--plugin-dir", plugin);
	args.push("--name", launch.name, launch.pointer);
	return args;
}

/**
 * The hook script every Teammate hook runs, which writes the Teammate's
 * journal. Claude Code runs hook commands with a shell, outside pi, so the
 * command names the Node that runs pi.
 */
export const HOOK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "hook.mjs");

/**
 * Every Teammate's status line command: it runs the human's own and keeps the
 * JSON Claude Code gave it as the Teammate's `statusline.json`, the freshest
 * usage reading there is.
 */
export const STATUSLINE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "statusline.mjs");

/**
 * The status line command Claude Code would run for the human in `workspace`:
 * the first `statusLine.command` in its local settings, its project settings,
 * then the human's own `<claudeDir>/settings.json`. Only read, never written.
 * A file that is missing or isn't JSON is skipped.
 */
export function humanStatusLine(workspace: string, claudeDir: string): string | undefined {
	for (const file of [join(workspace, ".claude", "settings.local.json"), join(workspace, ".claude", "settings.json"), join(claudeDir, "settings.json")]) {
		let settings: unknown;
		try {
			settings = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		const statusLine = (settings as { statusLine?: { command?: unknown } } | null)?.statusLine;
		if (typeof statusLine?.command === "string" && statusLine.command.trim() !== "") return statusLine.command;
	}
	return undefined;
}

/** A number, or undefined for anything else, `null` included: a window not given is never 0. */
function numberOr(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectOr(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A window from its percent and reset, or undefined when the percent isn't given. */
function usageWindow(percent: unknown, resetsAt: string | undefined): UsageWindow | undefined {
	const used = numberOr(percent);
	return used === undefined ? undefined : { percent: used, ...(resetsAt === undefined ? {} : { resetsAt }) };
}

/** Only the keys whose values are given. */
function given<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined)) as T;
}

/**
 * A Teammate's `statusline.json`, as Claude Code gave it to the status line,
 * read `at` its modification time; undefined when it isn't a JSON object.
 * `rate_limits` is absent with an API key (and before the first call), and
 * `resets_at` there is in epoch seconds.
 */
export function statusLineReading(text: string, teammate: string, at: string): UsageReading | undefined {
	let json: Record<string, unknown> | undefined;
	try {
		json = objectOr(JSON.parse(text));
	} catch {
		return undefined;
	}
	if (json === undefined) return undefined;
	const limits = objectOr(json.rate_limits);
	const window = (name: string): UsageWindow | undefined => {
		const each = objectOr(limits?.[name]);
		const resets = numberOr(each?.resets_at);
		return usageWindow(each?.used_percentage, resets === undefined ? undefined : new Date(resets * 1000).toISOString());
	};
	const context = objectOr(json.context_window);
	const input = numberOr(context?.total_input_tokens);
	const output = numberOr(context?.total_output_tokens);
	return given<UsageReading>({
		source: "status-line",
		at,
		teammate,
		sessionId: typeof json.session_id === "string" ? json.session_id : undefined,
		rateLimits: limits !== undefined,
		fiveHour: window("five_hour"),
		sevenDay: window("seven_day"),
		tokens: input === undefined && output === undefined ? undefined : (input ?? 0) + (output ?? 0),
		costUsd: numberOr(objectOr(json.cost)?.total_cost_usd),
		ctx: numberOr(context?.used_percentage),
	});
}

/** A `claude -p` that loads in a few seconds; one that doesn't answer is given up on. */
const GET_USAGE_TIMEOUT_MS = 15_000;

/**
 * The account's usage windows from the undocumented `get_usage` control
 * request: `claude -p` over stream-json, sent no prompt, so it spends no
 * usage. Read `at` when it answers. The reply is read leniently, since the
 * request is undocumented: a window it doesn't give is left out.
 */
export function getUsage(claudePath: string, at: string, timeoutMs = GET_USAGE_TIMEOUT_MS): Promise<UsageReading | { error: string }> {
	const id = `team-usage-${Math.random().toString(36).slice(2, 10)}`;
	return new Promise((resolve) => {
		let settled = false;
		let buffered = "";
		const child = spawn(claudePath, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], { stdio: ["pipe", "pipe", "ignore"] });
		const finish = (result: UsageReading | { error: string }): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.stdin.end();
			if (child.exitCode === null) child.kill();
			resolve(result);
		};
		const timer = setTimeout(() => finish({ error: `get_usage: \`${claudePath} -p\` didn't answer in ${timeoutMs / 1000}s` }), timeoutMs);
		child.on("error", (error) => finish({ error: `get_usage: could not run \`${claudePath}\`: ${error.message}` }));
		child.on("close", () => finish({ error: `get_usage: \`${claudePath} -p\` ended without answering` }));
		child.stdin.on("error", () => {});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffered += chunk;
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				let message: Record<string, unknown> | undefined;
				try {
					message = objectOr(JSON.parse(line));
				} catch {
					continue;
				}
				const response = objectOr(message?.response);
				if (message?.type !== "control_response" || response?.request_id !== id) continue;
				if (response.subtype !== "success") {
					finish({ error: `get_usage failed: ${typeof response.error === "string" ? response.error : "no reason given"}` });
					return;
				}
				finish(usageReply(objectOr(response.response) ?? {}, at));
				return;
			}
		});
		child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "get_usage", skip_behaviors: true } })}\n`);
	});
}

/** A `get_usage` reply's windows: `utilization` 0 to 100, `resets_at` ISO, either `null` when not known. */
function usageReply(reply: Record<string, unknown>, at: string): UsageReading {
	const limits = objectOr(reply.rate_limits);
	const window = (name: string): UsageWindow | undefined => {
		const each = objectOr(limits?.[name]);
		return usageWindow(each?.utilization, typeof each?.resets_at === "string" ? each.resets_at : undefined);
	};
	return given<UsageReading>({ source: "get-usage", at, rateLimits: limits !== undefined && reply.rate_limits_available !== false, fiveHour: window("five_hour"), sevenDay: window("seven_day") });
}

/**
 * The hook events a Teammate reports, each to {@link HOOK_SCRIPT}. Beyond the
 * spec's list, `PostToolUseFailure` is here too: a call that ran and then
 * failed was still allowed, so it settles a held request as answered in the
 * terminal, as `PostToolUse` does, and a killed hook that looked like a No
 * is known for the Yes it was rather than starting a Takeover.
 */
const HOOK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "StopFailure", "PermissionRequest", "PermissionDenied", "Notification", "PostToolUse", "PostToolUseFailure", "PreToolUse"];

/** A `PermissionRequest` holds the request open while the Lead or the human answers it. */
const PERMISSION_REQUEST_TIMEOUT_S = 3600;

/** What a Teammate's `--settings` are made from. */
export interface SettingsFrom {
	effortDir: string;
	teammateId: string;
	/** Added as `permissions.allow` and `permissions.deny`: the Playbook's rules for the Teammate's Role, then for every Role. */
	allow: readonly string[];
	deny: readonly string[];
	/** Added as `permissions.ask`: every rule of the Playbook's `escalate` entries. */
	ask: readonly string[];
	/** Absolute paths (a folder as `<folder>/**`) the Teammate may never edit: the Effort's records. */
	records: readonly string[];
	/**
	 * The folder the Teammate works in (its isolated Task's worktree, else the
	 * Effort's Workspace). The `PreToolUse` floor hook gets it as a third
	 * argument and judges deletes against it.
	 */
	workspace?: string;
	/** The human's own status line command ({@link humanStatusLine}), which the Teammate's status line runs first. */
	humanStatusLine?: string;
}

/**
 * A Teammate's `--settings`. Claude Code adds these to the human's own
 * settings, merging `permissions` and `hooks`, so they hold only keys that
 * add: the hooks, the permission rules and `crossSessionInbound`, which lets
 * the Lead's messages in, and `env`, which tells the mod how to journal. The one key that replaces is `statusLine.command`
 * (the rest of the human's `statusLine` still applies), and its command,
 * {@link STATUSLINE_SCRIPT}, runs the human's own and prints what it prints.
 */
export function teammateSettings(from: SettingsFrom): Record<string, unknown> {
	const command = [process.execPath, HOOK_SCRIPT, from.effortDir, from.teammateId].map(shellQuote).join(" ");
	const hooks: Record<string, unknown[]> = {};
	for (const event of HOOK_EVENTS) {
		const hook = event === "PermissionRequest" ? { type: "command", command, timeout: PERMISSION_REQUEST_TIMEOUT_S } : { type: "command", command };
		// The floor is about commands, so only `Bash` reaches the `PreToolUse` hook.
		const floor = from.workspace === undefined ? hook : { type: "command", command: `${command} ${shellQuote(from.workspace)}` };
		hooks[event] = [event === "PreToolUse" ? { matcher: "Bash", hooks: [floor] } : { hooks: [hook] }];
	}
	const unique = (rules: readonly string[]) => [...new Set(rules)];
	return {
		permissions: {
			allow: unique(from.allow),
			// `Edit(//abs/path)` is how Claude Code spells an absolute path in a rule.
			deny: unique([...from.deny, ...from.records.map((record) => `Edit(/${record})`)]),
			ask: unique(from.ask),
		},
		crossSessionInbound: "accept",
		hooks,
		statusLine: {
			type: "command",
			command: [process.execPath, STATUSLINE_SCRIPT, from.effortDir, from.teammateId, ...(from.humanStatusLine === undefined ? [] : [from.humanStatusLine])].map(shellQuote).join(" "),
		},
		// The hook command's argv, which the mod runs to journal what the human does in the Teammate's terminal (a Takeover).
		env: { TEAM_HOOK: JSON.stringify([process.execPath, HOOK_SCRIPT, from.effortDir, from.teammateId]) },
	};
}

/** The Team's mod as this extension ships it; Claude Code loads a copy ({@link installMod}). */
export const BUNDLED_MOD = join(dirname(fileURLToPath(import.meta.url)), "mod");

/**
 * The inbox message the mod turns into a `/clear` rather than a turn. Its
 * hooks module, `mod/hooks/register.ts`, spells it out too.
 */
export const CLEAR_MARKER = "__TEAM_CLEAR__";

/** Claude Code writes this into a mod's folder when loading it, so it is never the bundle's content. */
const WRITTEN_BY_LOADING = "tsconfig.json";

/** The hash of the bundled content the copy was made from, kept in the copy. */
const STAMP = ".bundled-sha256";

/** Every file under `dir` but what loading writes, by path relative to it, sorted. */
function modFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name !== WRITTEN_BY_LOADING && entry.name !== STAMP)
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)))
		.sort();
}

/**
 * Make the per-user copy of the Team's mod, `<agentDir>/team/mod`, and return
 * its path for `--plugin-dir`. Loading a mod writes a tsconfig.json into its
 * folder, which the extension's own folder may not allow, so Teammates load
 * the copy. It is made again only when the bundled content's hash differs
 * from the one stamped in it.
 */
export function installMod(agentDir: string, bundled = BUNDLED_MOD): string {
	const copy = join(agentDir, "team", "mod");
	const hash = createHash("sha256");
	for (const file of modFiles(bundled)) hash.update(`${file}\0`).update(readFileSync(join(bundled, file))).update("\0");
	const stamp = hash.digest("hex");
	const stampPath = join(copy, STAMP);
	if (existsSync(stampPath) && readFileSync(stampPath, "utf8") === stamp) return copy;
	rmSync(copy, { recursive: true, force: true });
	mkdirSync(copy, { recursive: true });
	for (const file of modFiles(bundled)) {
		mkdirSync(dirname(join(copy, file)), { recursive: true });
		cpSync(join(bundled, file), join(copy, file));
	}
	writeFileSync(stampPath, stamp);
	return copy;
}

function shellQuote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}
