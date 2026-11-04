/**
 * The pi surface: `/team` through a recording fake pi, with every path root a
 * temp folder and `claude` the fake.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, relative } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CLEAR_MARKER, HOOK_SCRIPT, STATUSLINE_SCRIPT } from "../claude.ts";
import { registerTeam } from "../index.ts";
import { commit, type FakeClaude, type FakeHeldHook, type FakeHookStep, fakeClaude, fakeTmux, git, gitRepo, goodTeam, ownStdio, roleMd, type TempRoots, teamMd, tempRoots, writeFiles, writeUserTeam } from "./harness.ts";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

interface SentMessage {
	customType: string;
	content: string;
	display?: boolean;
	triggerTurn?: boolean;
	deliverAs?: string;
}

interface Notification {
	message: string;
	type?: string;
}

/** A dialog the extension opened, and the answer the test played into it. */
interface Dialog {
	kind: "select" | "input" | "editor" | "confirm";
	title: string;
	options?: string[];
	/** A confirm's text. */
	text?: string;
	answer: string | boolean | undefined;
}

interface RegisteredTool {
	name: string;
	defaultActive?: boolean;
	execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown): Promise<ToolResult>;
	renderResult?(result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: unknown, context: unknown): Drawn;
}

/** What a tool returns: `content` is what the Lead reads, `details` only the human's view. */
interface ToolResult {
	content: { type: string; text: string }[];
	details?: unknown;
}

/** Anything pi draws: a tool result's view, or an overlay. */
interface Drawn {
	render(width: number): string[];
	handleInput?(data: string): void;
}

/** An overlay the extension opened, drawn and handed keys as the human would, and whether it has closed. */
interface Overlay {
	view: Drawn;
	options: unknown;
	closed: boolean;
}

/** pi's theme with its colours taken out, so what the extension draws reads as plain text. */
const PLAIN_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

/** A widget the extension set above the editor, or cleared with `lines` undefined. */
interface Widget {
	key: string;
	lines: string[] | undefined;
	placement?: string;
}

/** The tools pi itself has on before the extension changes anything. */
const PI_TOOLS = ["read", "bash", "edit", "write"];

/** The clock the extension reads, fixed so adoption times are known. */
const NOW = new Date("2026-11-02T10:00:00.000Z");

/**
 * A pi that records what the extension registers and says, with a command
 * context whose toasts are recorded too and whose dialogs answer from a queue
 * the test fills, the way the human would.
 */
function fakePi(
	roots: TempRoots,
	options: {
		claudeVersion?: string;
		streaming?: boolean;
		cwd?: string;
		bgExit?: number;
		hooks?: FakeHookStep[];
		replies?: FakeHookStep[];
		settings?: Record<string, unknown>;
		/** The session's file; `session.jsonl` in the scratch folder unless set. */
		sessionFile?: string;
		/** Custom entries the session already carries, as a resumed or forked one does. */
		entries?: { customType: string; data: unknown }[];
		/** The pid the extension takes the Lead as, standing in for another pi process. */
		pid?: number;
		hasUI?: boolean;
		/** pi's mode; `tui` unless set. */
		mode?: "tui" | "rpc" | "json" | "print";
		/** The environment the extension reads, `$TMUX` among it; empty unless set, whatever the test runner's is. */
		env?: Record<string, string | undefined>;
		/** The exit code of the fake `claude attach`. */
		attachExit?: number;
		/** What the fake `get_usage` control request answers; an error response when unset. */
		usage?: Record<string, unknown>;
		/** pi's own entries the session carries, such as the Lead's assistant messages with their usage. */
		sessionEntries?: Record<string, unknown>[];
		/** How long a Teammate's held hook holds before giving the prompt back to its terminal; the hook's own when unset. */
		holdMs?: number;
		/** A command each Teammate's session keeps running as an attached child in its folder, as its Bash tool's shell. */
		sessionChild?: string[];
		/** The fake `claude` an earlier pi ran, whose background sessions outlive it; a new one unless set. */
		claude?: FakeClaude;
	} = {},
) {
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const tools = new Map<string, RegisteredTool>();
	const sent: SentMessage[] = [];
	const notifications: Notification[] = [];
	const dialogs: Dialog[] = [];
	const answers: (string | boolean | undefined)[] = [];
	let activeTools = [...PI_TOOLS];
	const activations: string[][] = [];
	const entries: { customType: string; data: unknown }[] = [];
	const carried = options.entries ?? [];
	const sessionFile = options.sessionFile ?? join(roots.scratch, "session.jsonl");
	const widgets: Widget[] = [];
	const sleeps: number[] = [];
	const overlays: Overlay[] = [];
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const copied: string[] = [];
	const tuiEvents: string[] = [];
	// The clock the extension reads, which only a test moves, and the timers it set, which only a test fires.
	let clock = NOW;
	const tickers: { ms: number; tick: () => Promise<void> | void; stopped: boolean }[] = [];
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
			commands.set(name, command);
		},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
			if (tool.defaultActive !== false) activeTools.push(tool.name);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			activeTools = [...names];
			activations.push([...names]);
		},
		sendMessage(message: { customType: string; content: string; display?: boolean }, sendOptions?: { triggerTurn?: boolean; deliverAs?: string }) {
			sent.push({ ...message, triggerTurn: sendOptions?.triggerTurn, deliverAs: sendOptions?.deliverAs });
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		getSettings: () => structuredClone(options.settings ?? {}),
	};
	const claude =
		options.claude ??
		fakeClaude(roots, {
			version: options.claudeVersion,
			bgExit: options.bgExit,
			hooks: options.hooks,
			replies: options.replies,
			attachExit: options.attachExit,
			holdMs: options.holdMs,
			usage: options.usage,
			sessionChild: options.sessionChild,
		});
	const tmux = fakeTmux(roots);
	registerTeam(pi as unknown as ExtensionAPI, {
		agentDir: roots.agentDir,
		claudeConfigPath: roots.claudeConfigPath,
		claudeDir: roots.claudeDir,
		claudePath: claude.path,
		now: () => clock,
		every(ms, tick) {
			const ticker = { ms, tick, stopped: false };
			tickers.push(ticker);
			return () => {
				ticker.stopped = true;
			};
		},
		pid: options.pid,
		sleep: async (ms: number) => {
			sleeps.push(ms);
		},
		env: options.env ?? {},
		tmuxPath: tmux.path,
		async copy(text) {
			copied.push(text);
		},
	});
	/**
	 * pi's TUI as `ctx.ui.custom` hands it to a factory. Each call is recorded
	 * with how many `claude attach` runs the fake had seen by then, so a test
	 * sees what happened before and after the attach.
	 */
	const tui = {
		stop: () => tuiEvents.push(`stop, ${claude.attaches().length} attached`),
		start: () => tuiEvents.push(`start, ${claude.attaches().length} attached`),
		requestRender: (force?: boolean) => tuiEvents.push(`requestRender(${force === true})`),
		terminal: { rows: 40, columns: 100, write: (data: string) => tuiEvents.push(`write ${JSON.stringify(data)}`) },
	};
	function answer(kind: Dialog["kind"], title: string, choices?: string[], text?: string) {
		assert.ok(answers.length > 0, `the extension opened a ${kind} dialog "${title}" the test has no answer for`);
		const played = answers.shift();
		dialogs.push({ kind, title, options: choices, ...(text === undefined ? {} : { text }), answer: played });
		return played;
	}
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
		cwd: options.cwd ?? roots.scratch,
		isIdle: () => !options.streaming,
		sessionManager: {
			getSessionFile: () => sessionFile,
			getEntries: () => [...(options.sessionEntries ?? []), ...[...carried, ...entries].map((entry, index) => ({ type: "custom", id: `e${index}`, ...entry }))],
		},
		async waitForIdle() {
			throw new Error("a `/team` command waited for the Lead to finish streaming");
		},
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			async select(title: string, choices: string[]) {
				return answer("select", title, choices);
			},
			async input(title: string) {
				return answer("input", title);
			},
			async editor(title: string) {
				return answer("editor", title);
			},
			async confirm(title: string, text?: string) {
				return answer("confirm", title, undefined, text);
			},
			setWidget(key: string, lines: string[] | undefined, widgetOptions?: { placement?: string }) {
				widgets.push({ key, lines, placement: widgetOptions?.placement });
			},
			// As pi does, the promise settles with what `done` is given; a component never shown once `done` has run.
			custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown, customOptions?: unknown): Promise<T> {
				return new Promise<T>((settle, fail) => {
					const overlay: Overlay = { view: { render: () => [] }, options: customOptions, closed: false };
					const made = factory(tui, PLAIN_THEME, {}, (result) => {
						overlay.closed = true;
						settle(result);
					});
					if (made instanceof Promise) {
						made.catch(fail);
						return;
					}
					// A component drawn at once is an overlay a test can read and hand keys to.
					overlay.view = made as Drawn;
					overlays.push(overlay);
				});
			},
		},
	} as unknown as ExtensionCommandContext;

	return {
		commands,
		tools,
		sent,
		notifications,
		dialogs,
		activations,
		/** The custom entries the extension appended to the session, oldest first. */
		entries,
		/** Every widget the extension set or cleared, oldest first. */
		widgets,
		/** Each wait the extension asked for, in ms, oldest first; none really waits. */
		sleeps,
		/** Every overlay the extension opened, oldest first. */
		overlays,
		activeTools: () => [...activeTools],
		claude,
		tmux,
		/** Every command the extension put on the clipboard, oldest first. */
		copied,
		/** What the extension did with pi's TUI, oldest first. */
		tuiEvents,
		/** Move the extension's clock to `at`. */
		travel(at: string) {
			clock = new Date(at);
		},
		/** Move the extension's clock on by `ms`. */
		advance(ms: number) {
			clock = new Date(clock.getTime() + ms);
		},
		/** The repeating timers the extension has running, by period in ms. */
		timers: () => tickers.filter((ticker) => !ticker.stopped).map((ticker) => ticker.ms),
		/** Fire every repeating timer the extension has running, once each, as its period passing would. */
		async tick() {
			for (const ticker of tickers.filter((each) => !each.stopped)) await ticker.tick();
		},
		/** Queue the human's answers to the next dialogs, in order. */
		answer(...played: (string | boolean | undefined)[]) {
			answers.push(...played);
		},
		/** Fire one of pi's events at the extension's handlers, as pi does, returning the last result any handler gave. */
		async emit(event: string, payload: Record<string, unknown> = {}): Promise<unknown> {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = (await handler({ type: event, ...payload }, ctx)) ?? result;
			return result;
		},
		/** The session's custom entries, the ones it carried in included, as the next session in its file sees them. */
		allEntries: () => [...carried, ...entries],
		/** Run `/team <args>` the way pi does when the human types it. */
		async team(args: string): Promise<void> {
			const command = commands.get("team");
			assert.ok(command, "expected a `team` command");
			await command.handler(args, ctx);
			assert.deepEqual(answers, [], "the test queued answers to dialogs the extension never opened");
		},
		/** Call one of the Lead's tools the way pi does; a throw is the error result the Lead sees. */
		async call(name: string, params: Record<string, unknown>): Promise<string> {
			const tool = tools.get(name);
			assert.ok(tool, `expected a \`${name}\` tool`);
			assert.ok(activeTools.includes(name), `\`${name}\` was called while switched off`);
			const result = await tool.execute("call-1", params, undefined, undefined, ctx);
			return result.content.map((part) => part.text).join("\n");
		},
		/** Call one of the Lead's tools and keep its whole result, the human's view of it included. */
		async result(name: string, params: Record<string, unknown>): Promise<ToolResult> {
			const tool = tools.get(name);
			assert.ok(tool, `expected a \`${name}\` tool`);
			return tool.execute("call-1", params, undefined, undefined, ctx);
		},
		/** Draw a tool's result the way pi does in chat, collapsed unless `expanded`, as plain lines. */
		drawResult(name: string, result: ToolResult, expanded: boolean, width = 100): string[] {
			const render = tools.get(name)?.renderResult;
			assert.ok(render, `\`${name}\` draws its result with pi's generic view`);
			return render(result, { expanded, isPartial: false }, PLAIN_THEME, ctx)
				.render(width)
				.map((line) => line.trimEnd());
		},
		/**
		 * Run `/team <args>` while it waits on an overlay: resolves once the
		 * command opened one, with the command still running until it closes.
		 */
		async teamOpening(args: string): Promise<{ overlay: Overlay; done: Promise<void> }> {
			const command = commands.get("team");
			assert.ok(command, "expected a `team` command");
			const before = overlays.length;
			const done = command.handler(args, ctx);
			for (let tick = 0; tick < 200 && overlays.length === before; tick++) await new Promise((resolve) => setImmediate(resolve));
			assert.ok(overlays.length > before, `\`/team ${args}\` opened no overlay`);
			return { overlay: overlays[before], done };
		},
	};
}

describe("/team", () => {
	it("registers one `team` command", () => {
		const pi = fakePi(tempRoots());

		assert.deepEqual([...pi.commands.keys()], ["team"]);
		assert.match(pi.commands.get("team")?.description ?? "", /start/);
	});

	it("names the subcommands when given one it doesn't know, or none while there is nothing to attach to", async () => {
		const pi = fakePi(tempRoots());

		await pi.team("launch software");
		await pi.team("");

		assert.deepEqual(pi.notifications, [
			{ message: "Unknown `/team` subcommand `launch`. Subcommands: `start`, `setup`, `pending`, `pause`, `resume`, `report`, `reports`, `cancel`, `attach`, `handback`.", type: "error" },
			{ message: "No Teammate has a session to attach to: this session holds no Effort. Subcommands: `start`, `setup`, `pending`, `pause`, `resume`, `report`, `reports`, `cancel`, `attach`, `handback`.", type: "info" },
		]);
	});
});

describe("/team start <team>", () => {
	it("picks a Team that loads cleanly, saying what it has and when its Playbook was adopted, and opens its Effort", async () => {
		const roots = tempRoots();
		adopt(roots, "software", "---\nsendBackLimit: 1\n---\n");
		const pi = fakePi(roots, { cwd: gitRepo(roots) });

		await pi.team("start software");

		assert.deepEqual(pi.notifications, [
			{
				message: `Team \`software\` picked: Roles \`architect\`, \`dev\`, \`qa\`. Playbook: adopted 2026-11-01T09:00:00.000Z (${join(playbooksDir(roots), "software.md")}). Effort \`software-2026-11-02\` opened at ${join(roots.agentDir, "team", "efforts", "software-2026-11-02")}; the Lead drafts its Brief with you, and nothing runs until you approve it from \`/team pending\`.`,
				type: "info",
			},
		]);
		assert.deepEqual(
			pi.sent.map((message) => message.customType),
			["team-intake"],
		);
	});

	it("refuses an unknown Team, naming the Teams there are", async () => {
		const roots = tempRoots();
		writeUserTeam(roots, "writing", goodTeam("writing"));
		const pi = fakePi(roots);

		await pi.team("start nope");

		assert.deepEqual(pi.notifications, [{ message: "Unknown Team `nope`. Teams: `software`, `writing`.", type: "error" }]);
	});

	it("refuses a Team with a rejected Role, naming the file and the reason", async () => {
		const roots = tempRoots();
		writeUserTeam(roots, "broken", goodTeam("broken", { "roles/reviewer.md": roleMd("reviewer", "permissionMode: plan") }));
		const pi = fakePi(roots);

		await pi.team("start broken");

		assert.equal(pi.notifications.length, 1);
		assert.equal(pi.notifications[0].type, "error");
		assert.match(pi.notifications[0].message, /^Team `broken` can't start until its config errors are fixed:\n/);
		assert.ok(pi.notifications[0].message.includes(`- ${join(roots.agentDir, "teams", "broken", "roles", "reviewer.md")}: \`permissionMode: plan\` is not allowed`));
		assert.deepEqual(pi.sent, []);
	});

	it("warns first when claude is older than the version the extension was tried on, then still picks the Team", async () => {
		const pi = fakePi(tempRoots(), { claudeVersion: "2.0.5 (Claude Code)" });

		await pi.team("start software");

		assert.deepEqual(
			pi.notifications.map((notification) => notification.type),
			["warning", "info"],
		);
		assert.match(pi.notifications[0].message, /claude 2\.0\.5 is older than 2\.1\.316/);
		assert.deepEqual(pi.claude.calls(), [["--version"]]);
	});
});

describe("/team start with no Team named", () => {
	it("asks the Lead to propose a Team from each Team's description", async () => {
		const roots = tempRoots();
		writeUserTeam(roots, "writing", goodTeam("writing"));
		const pi = fakePi(roots);

		await pi.team("start");

		assert.deepEqual(pi.notifications, []);
		assert.equal(pi.sent.length, 1);
		const [message] = pi.sent;
		assert.equal(message.customType, "team-start");
		assert.equal(message.display, true);
		assert.equal(message.triggerTurn, true);
		assert.equal(message.deliverAs, "followUp");
		const software = readFileSync(join(REPO_ROOT, "extensions", "team", "teams", "software", "team.md"), "utf8").match(/^description: (.*)$/m)?.[1];
		assert.ok(software);
		assert.ok(message.content.includes(`- \`software\`: ${software}`), message.content);
		assert.ok(message.content.includes("- `writing`: The writing Team's own work."), message.content);
		assert.match(message.content, /`\/team start <team>`/);
	});

	it("tells the Lead which Teams can't start and why, so it doesn't propose them", async () => {
		const roots = tempRoots();
		writeUserTeam(roots, "broken", goodTeam("broken", { "roles/worker.md": roleMd("worker", "shell: zsh") }));
		const pi = fakePi(roots);

		await pi.team("start");

		const [message] = pi.sent;
		assert.match(message.content, /Teams that can't start until their config errors are fixed:\n- `broken`: .*roles\/worker\.md: unknown field `shell`/);
		assert.doesNotMatch(message.content.split("can't start")[0], /`broken`/);
	});

	it("reports instead of asking the Lead when no Team can start", async () => {
		const roots = tempRoots();
		writeUserTeam(roots, "software", { "team.md": "---\nname: software\n---\n" });
		const pi = fakePi(roots);

		await pi.team("start");

		assert.deepEqual(pi.sent, []);
		assert.equal(pi.notifications.length, 1);
		assert.equal(pi.notifications[0].type, "error");
		assert.match(pi.notifications[0].message, /^No Team can start until its config errors are fixed:\n/);
		assert.match(pi.notifications[0].message, /team\.md: needs a `description`/);
	});
});

const DEFAULT_PLAYBOOK = join(REPO_ROOT, "extensions", "team", "teams", "software", "default-playbook.md");

function playbooksDir(roots: TempRoots): string {
	return join(roots.agentDir, "team", "playbooks");
}

function draftPath(roots: TempRoots, team: string): string {
	return join(playbooksDir(roots), `${team}.draft.md`);
}

/** A Playbook adopted on 2026-11-01, written the way adoption leaves it. */
function adopt(roots: TempRoots, team: string, content: string): void {
	writeFiles(playbooksDir(roots), {
		[`${team}.md`]: content,
		[`${team}.adopted.json`]: JSON.stringify({ sha256: createHash("sha256").update(content).digest("hex"), adoptedAt: "2026-11-01T09:00:00.000Z" }),
	});
}

describe("/team setup <team>", () => {
	it("starts Team setup for a bundled Team from its default Playbook, switching the Lead's tools on", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots);

		await pi.team("setup software");

		assert.equal(readFileSync(draftPath(roots, "software"), "utf8"), readFileSync(DEFAULT_PLAYBOOK, "utf8"));
		assert.deepEqual(pi.activations, [[...PI_TOOLS, "team_request_approval"]]);
		assert.equal(pi.sent.length, 1);
		const [message] = pi.sent;
		assert.equal(message.customType, "team-setup");
		assert.equal(message.triggerTurn, true);
		assert.equal(message.deliverAs, "followUp");
		assert.ok(message.content.includes(draftPath(roots, "software")), message.content);
		assert.match(message.content, /default Playbook/);
		assert.match(message.content, /`team_request_approval`.*`adopt-playbook`/);
	});

	it("starts a user Team with no default Playbook by asking the Lead to grill the human and draft one", async () => {
		const roots = tempRoots();
		writeUserTeam(roots, "writing", goodTeam("writing", { "roles/editor.md": roleMd("editor") }));
		const pi = fakePi(roots);

		await pi.team("setup writing");

		assert.equal(existsSync(draftPath(roots, "writing")), false);
		assert.deepEqual(pi.activations, [[...PI_TOOLS, "team_request_approval"]]);
		const [message] = pi.sent;
		assert.equal(message.customType, "team-setup");
		assert.match(message.content, /no default Playbook/);
		assert.match(message.content, /[Gg]rill/);
		assert.match(message.content, /Roles: `editor`, `worker`/);
		assert.ok(message.content.includes(`\`${draftPath(roots, "writing")}\``), message.content);
		assert.match(message.content, /sendBackLimit/);
	});

	it("keeps a draft an earlier setup left unadopted rather than reseeding it", async () => {
		const roots = tempRoots();
		writeFiles(playbooksDir(roots), { "software.draft.md": "---\nsendBackLimit: 3\n---\nhalf agreed\n" });
		const pi = fakePi(roots);

		await pi.team("setup software");

		assert.equal(readFileSync(draftPath(roots, "software"), "utf8"), "---\nsendBackLimit: 3\n---\nhalf agreed\n");
		assert.match(pi.sent[0].content, /kept from an earlier Team setup/);
	});

	it("revises an adopted Playbook from what was adopted, not from the default", async () => {
		const roots = tempRoots();
		adopt(roots, "software", "---\nsendBackLimit: 4\n---\n\n- **be-kind** Be kind.\n");
		const pi = fakePi(roots);

		await pi.team("setup software");

		assert.equal(readFileSync(draftPath(roots, "software"), "utf8"), "---\nsendBackLimit: 4\n---\n\n- **be-kind** Be kind.\n");
		assert.match(pi.sent[0].content, /copied from the Playbook adopted 2026-11-01T09:00:00\.000Z/);
	});

	it("refuses an unknown Team, naming the Teams there are, and switches nothing on", async () => {
		const pi = fakePi(tempRoots());

		await pi.team("setup nope");
		await pi.team("setup");

		assert.deepEqual(pi.notifications, [
			{ message: "Unknown Team `nope`. Teams: `software`.", type: "error" },
			{ message: "`/team setup` needs a Team. Teams: `software`.", type: "error" },
		]);
		assert.deepEqual(pi.activations, []);
		assert.deepEqual(pi.sent, []);
	});

	it("refuses a Team whose files have config errors, naming them", async () => {
		const roots = tempRoots();
		writeUserTeam(roots, "broken", goodTeam("broken", { "roles/worker.md": roleMd("worker", "shell: zsh") }));
		const pi = fakePi(roots);

		await pi.team("setup broken");

		assert.equal(pi.notifications.length, 1);
		assert.match(pi.notifications[0].message, /^Team `broken` can't be set up until its config errors are fixed:\n- .*roles\/worker\.md: unknown field `shell`/);
		assert.deepEqual(pi.activations, []);
	});

	it("still sets up a Team whose adoption record is broken, since adopting again is the fix", async () => {
		const roots = tempRoots();
		writeFiles(playbooksDir(roots), { "software.adopted.json": "{not json" });
		const pi = fakePi(roots);

		await pi.team("setup software");

		assert.deepEqual(pi.notifications, []);
		assert.equal(pi.sent[0].customType, "team-setup");
	});
});

function sha(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

describe("team_request_approval during Team setup", () => {
	it("is registered at load but switched off until Team setup starts", () => {
		const pi = fakePi(tempRoots());

		assert.equal(pi.tools.get("team_request_approval")?.defaultActive, false);
		assert.deepEqual(pi.activations, []);
		assert.equal(pi.activeTools().includes("team_request_approval"), false);
	});

	it("validates the draft and adds a pending item showing its path and sha", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots);
		await pi.team("setup software");

		const result = await pi.call("team_request_approval", { checkpoint: "adopt-playbook", path: draftPath(roots, "software") });

		assert.ok(result.includes(draftPath(roots, "software")), result);
		assert.ok(result.includes(sha(readFileSync(DEFAULT_PLAYBOOK))), result);
		assert.match(result, /`\/team pending`/);
	});

	it("takes the draft path relative to the working directory too", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots);
		await pi.team("setup software");

		const result = await pi.call("team_request_approval", { checkpoint: "adopt-playbook", path: relative(roots.scratch, draftPath(roots, "software")) });

		assert.ok(result.includes(sha(readFileSync(DEFAULT_PLAYBOOK))), result);
	});

	it("refuses an invalid draft with its config errors, and adds nothing pending", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots);
		await pi.team("setup software");
		writeFileSync(draftPath(roots, "software"), "---\nsendBackLimit: 0\npermissions:\n  roles:\n    tester: { mode: auto }\n---\n");

		await assert.rejects(pi.call("team_request_approval", { checkpoint: "adopt-playbook", path: draftPath(roots, "software") }), (error: Error) => {
			assert.match(error.message, /can't be adopted until its config errors are fixed/);
			assert.match(error.message, /`sendBackLimit` must be a positive integer/);
			assert.match(error.message, /names `tester`, which is not a Role of this Team/);
			return true;
		});
		await pi.team("pending");
		assert.deepEqual(pi.notifications, [{ message: "Nothing is waiting on you.", type: "info" }]);
	});

	it("refuses a checkpoint other than adopt-playbook during Team setup, naming the one it takes", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots);
		await pi.team("setup software");

		await assert.rejects(pi.call("team_request_approval", { checkpoint: "brief", path: draftPath(roots, "software") }), /checkpoint `brief`.*`adopt-playbook`/);
	});

	it("refuses any file but the setup's own draft, naming the draft", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots);
		await pi.team("setup software");
		const elsewhere = join(roots.scratch, "playbook.md");
		writeFileSync(elsewhere, readFileSync(DEFAULT_PLAYBOOK));

		await assert.rejects(pi.call("team_request_approval", { checkpoint: "adopt-playbook", path: elsewhere }), (error: Error) => {
			assert.ok(error.message.includes(draftPath(roots, "software")), error.message);
			return true;
		});
	});
});

/** Run Team setup for `team` and have the Lead ask to adopt its draft as it stands. */
async function requestAdoption(pi: ReturnType<typeof fakePi>, roots: TempRoots, team: string): Promise<void> {
	await pi.team(`setup ${team}`);
	await pi.call("team_request_approval", { checkpoint: "adopt-playbook", path: draftPath(roots, team) });
}

const ANSWERS = ["Approve", "Send back with a note", "Later"];

describe("/team pending: adopting a Playbook", () => {
	it("shows the draft's path and sha, and approving adopts it with the approved sha", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots);
		await requestAdoption(pi, roots, "software");
		const approved = readFileSync(draftPath(roots, "software"));

		pi.answer("Approve");
		await pi.team("pending");

		assert.equal(pi.dialogs.length, 1);
		assert.equal(pi.dialogs[0].kind, "select");
		assert.deepEqual(pi.dialogs[0].options, ANSWERS);
		assert.ok(pi.dialogs[0].title.includes(draftPath(roots, "software")), pi.dialogs[0].title);
		assert.ok(pi.dialogs[0].title.includes(sha(approved)), pi.dialogs[0].title);
		assert.deepEqual(readFileSync(join(playbooksDir(roots), "software.md")), approved);
		assert.deepEqual(JSON.parse(readFileSync(join(playbooksDir(roots), "software.adopted.json"), "utf8")), {
			sha256: sha(approved),
			adoptedAt: NOW.toISOString(),
		});
		assert.equal(existsSync(draftPath(roots, "software")), false);
	});

	it("adopts the bytes the Lead asked about, not an edit made to the draft since", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots);
		await requestAdoption(pi, roots, "software");
		const asked = readFileSync(draftPath(roots, "software"));
		writeFileSync(draftPath(roots, "software"), "---\nsendBackLimit: 9\n---\nchanged after asking\n");

		pi.answer("Approve");
		await pi.team("pending");

		assert.deepEqual(readFileSync(join(playbooksDir(roots), "software.md")), asked);
	});

	it("switches the Lead's tools off and wakes the Lead once the Playbook is adopted", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots);
		await requestAdoption(pi, roots, "software");

		pi.answer("Approve");
		await pi.team("pending");

		assert.deepEqual(pi.activations.at(-1), PI_TOOLS);
		const woken = pi.sent.at(-1);
		assert.equal(woken?.customType, "team-pending");
		assert.equal(woken?.triggerTurn, true);
		assert.match(woken?.content ?? "", /adopted/);
		assert.deepEqual(pi.notifications.at(-1)?.type, "info");
	});

	it("counts the Playbook as adopted for `/team start` afterwards", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots, { cwd: gitRepo(roots) });
		await requestAdoption(pi, roots, "software");
		pi.answer("Approve");
		await pi.team("pending");

		await pi.team("start software");

		assert.match(pi.notifications.at(-1)?.message ?? "", /Playbook: adopted 2026-11-02T10:00:00\.000Z/);
	});

	it("sends the draft back with the human's note, waking the Lead with it and adopting nothing", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots);
		await requestAdoption(pi, roots, "software");

		pi.answer("Send back with a note", "Add a checkpoint before any release.");
		await pi.team("pending");

		assert.equal(existsSync(join(playbooksDir(roots), "software.md")), false);
		const woken = pi.sent.at(-1);
		assert.equal(woken?.customType, "team-pending");
		assert.equal(woken?.triggerTurn, true);
		assert.match(woken?.content ?? "", /Add a checkpoint before any release\./);
		assert.match(woken?.content ?? "", /`team_request_approval`/);
		assert.equal(pi.activeTools().includes("team_request_approval"), true);
		await pi.team("pending");
		assert.equal(pi.notifications.at(-1)?.message, "Nothing is waiting on you.");
	});

	it("keeps the item waiting when the human answers later, or backs out of the dialog or the note", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots);
		await requestAdoption(pi, roots, "software");
		const sentBefore = pi.sent.length;

		pi.answer("Later");
		await pi.team("pending");
		pi.answer(undefined);
		await pi.team("pending");
		pi.answer("Send back with a note", undefined);
		await pi.team("pending");

		assert.equal(pi.sent.length, sentBefore);
		assert.equal(existsSync(join(playbooksDir(roots), "software.md")), false);
		pi.answer("Approve");
		await pi.team("pending");
		assert.equal(existsSync(join(playbooksDir(roots), "software.md")), true);
	});

	it("shows the draft's warnings in the request and in the dialog", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots);
		await pi.team("setup software");
		writeFileSync(draftPath(roots, "software"), '---\npermissions:\n  roles:\n    dev: { allow: ["Bash(*)"] }\n---\n');

		const result = await pi.call("team_request_approval", { checkpoint: "adopt-playbook", path: draftPath(roots, "software") });
		pi.answer("Later");
		await pi.team("pending");

		assert.match(result, /`Bash\(\*\)`.*won't take effect for `dev`/);
		assert.match(pi.dialogs[0].title, /`Bash\(\*\)`.*won't take effect for `dev`/);
	});
});

describe("/team start on a Team with no adopted Playbook", () => {
	it("starts Team setup first, then continues to intake once the Playbook is adopted", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots, { cwd: gitRepo(roots) });

		await pi.team("start software");

		assert.equal(pi.notifications.length, 1);
		assert.equal(pi.notifications[0].type, "info");
		assert.match(pi.notifications[0].message, /Team `software` has no adopted Playbook, so Team setup runs first/);
		assert.equal(pi.sent.at(-1)?.customType, "team-setup");
		assert.deepEqual(pi.activations, [[...PI_TOOLS, "team_request_approval"]]);

		await pi.call("team_request_approval", { checkpoint: "adopt-playbook", path: draftPath(roots, "software") });
		pi.answer("Approve");
		await pi.team("pending");

		assert.match(pi.notifications.at(-1)?.message ?? "", /^Team `software` picked: .*Playbook: adopted 2026-11-02T10:00:00\.000Z.* Effort `software-2026-11-02` opened/);
		assert.equal(pi.sent.at(-1)?.customType, "team-intake");
		assert.deepEqual(pi.activeTools(), [...PI_TOOLS, "team_request_approval", "team_plan", "team_handoff", "team_review", "team_status", "team_report", "team_pause", "team_resume", "team_answer", "team_escalate", "team_send"]);
	});

	it("goes back through setup when the adopted Playbook was edited by hand", async () => {
		const roots = tempRoots();
		adopt(roots, "software", "---\nsendBackLimit: 1\n---\n");
		writeFileSync(join(playbooksDir(roots), "software.md"), "---\nsendBackLimit: 1\n---\nedited\n");
		const pi = fakePi(roots);

		await pi.team("start software");

		assert.match(pi.notifications[0].message, /software\.md was edited after it was adopted, so Team setup runs first/);
		assert.equal(pi.sent.at(-1)?.customType, "team-setup");
		assert.equal(readFileSync(draftPath(roots, "software"), "utf8"), "---\nsendBackLimit: 1\n---\nedited\n");
	});

	it("doesn't continue to start a Team when the human adopts from a plain `/team setup`", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots);
		await requestAdoption(pi, roots, "software");

		pi.answer("Approve");
		await pi.team("pending");

		assert.doesNotMatch(pi.notifications.map((notification) => notification.message).join("\n"), /picked/);
	});
});

/** An adopted Playbook that adds a Brief section and has one rule, for intake. */
const INTAKE_PLAYBOOK = [
	"---",
	"sendBackLimit: 1",
	"permissions:",
	"  roles:",
	"    dev: { mode: acceptEdits }",
	"---",
	"",
	"## Brief sections",
	"",
	"- **Constraints**: what the change must keep true.",
	"",
	"## Rules",
	"",
	"- **small-diffs**: keep each Task's diff small.",
	"",
].join("\n");

const EFFORT_ID = "software-2026-11-02";

function effortDir(roots: TempRoots, effortId = EFFORT_ID): string {
	return join(roots.agentDir, "team", "efforts", effortId);
}

/** A session in a git repo whose `software` Team has {@link INTAKE_PLAYBOOK} adopted. */
function intakeSession(roots = tempRoots(), options: Pick<NonNullable<Parameters<typeof fakePi>[1]>, "hasUI"> = {}) {
	adopt(roots, "software", INTAKE_PLAYBOOK);
	const repo = gitRepo(roots);
	return { roots, repo, pi: fakePi(roots, { cwd: repo, ...options }) };
}

describe("intake: `/team start` on a Team with an adopted Playbook", () => {
	it("opens an Effort: its own directory and effort.jsonl, a `team-effort` entry, and the Lead woken to draft the Brief", async () => {
		const { roots, repo, pi } = intakeSession();

		await pi.team("start software");

		const dir = effortDir(roots);
		const lines = readFileSync(join(dir, "effort.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as unknown);
		assert.deepEqual(lines, [{ type: "effort-opened", effortId: EFFORT_ID, team: "software", repo, playbook: sha(INTAKE_PLAYBOOK), at: NOW.toISOString() }]);
		assert.deepEqual(pi.entries, [{ customType: "team-effort", data: { effortId: EFFORT_ID, effortDir: dir } }]);
		assert.equal(pi.notifications.length, 1);
		assert.equal(pi.notifications[0].type, "info");
		assert.match(pi.notifications[0].message, /^Team `software` picked: Roles `architect`, `dev`, `qa`\. Playbook: adopted 2026-11-01T09:00:00\.000Z/);
		assert.ok(pi.notifications[0].message.includes(`Effort \`${EFFORT_ID}\` opened at ${dir}`), pi.notifications[0].message);
		const woken = pi.sent.at(-1);
		assert.equal(woken?.customType, "team-intake");
		assert.equal(woken?.triggerTurn, true);
		for (const needed of [join(dir, "brief.draft.md"), sha(INTAKE_PLAYBOOK), `repo: ${repo}`, "Constraints", "small-diffs", "**AC1**", "`team_request_approval`", "`brief`"]) {
			assert.ok(woken?.content.includes(needed), `the intake prompt doesn't mention ${needed}:\n${woken?.content}`);
		}
		assert.deepEqual(pi.activeTools(), [...PI_TOOLS, "team_request_approval", "team_plan", "team_handoff", "team_review", "team_status", "team_report", "team_pause", "team_resume", "team_answer", "team_escalate", "team_send"]);
	});

	it("tells the Lead to check each Rule against what its tools can do, a Role's model for the Effort among them, and to flag one it can't carry out as a `skip` override, never skipping it silently", async () => {
		const { pi } = intakeSession();

		await pi.team("start software");

		const woken = pi.sent.at(-1)?.content ?? "";
		for (const needed of [
			"Before you write the Brief, check each of the Playbook's rules against what your tools can do",
			"unless the Brief's `roles:` frontmatter sets another",
			"there is no per-Task choice",
			"a Playbook change can't create a Role file",
			"`{ rule: <its id>, change: skip",
			"Never skip a rule silently",
		]) {
			assert.ok(woken.includes(needed), `the intake prompt doesn't say ${needed}:\n${woken}`);
		}
	});

	it("gives each Effort its own id, so a second one the same day is numbered", async () => {
		const { roots, repo, pi } = intakeSession();
		await pi.team("start software");

		const other = fakePi(roots, { cwd: repo });
		await other.team("start software");

		assert.deepEqual(other.entries, [{ customType: "team-effort", data: { effortId: `${EFFORT_ID}-2`, effortDir: effortDir(roots, `${EFFORT_ID}-2`) } }]);
		assert.equal(existsSync(join(effortDir(roots, `${EFFORT_ID}-2`), "effort.jsonl")), true);
	});

	it("refuses to open an Effort outside a git repo, since the Brief records the repo", async () => {
		const roots = tempRoots();
		adopt(roots, "software", INTAKE_PLAYBOOK);
		const pi = fakePi(roots);

		await pi.team("start software");

		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.match(pi.notifications.at(-1)?.message ?? "", /not inside a git repo/);
		assert.equal(existsSync(join(roots.agentDir, "team", "efforts")), false);
		assert.deepEqual(pi.entries, []);
		assert.deepEqual(pi.sent, []);
	});

	it("refuses a second Effort while this session holds one, naming it", async () => {
		const { pi } = intakeSession();
		await pi.team("start software");

		await pi.team("start software");

		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.ok(pi.notifications.at(-1)?.message.includes(`\`${EFFORT_ID}\``), pi.notifications.at(-1)?.message);
		assert.equal(pi.entries.length, 1);
	});
});

/** A Brief for the intake session that passes, with `swap` applied to its text. */
function brief(repo: string, swap: (text: string) => string = (text) => text): string {
	return swap(
		[
			"---",
			"team: software",
			`playbook: ${sha(INTAKE_PLAYBOOK)}`,
			`repo: ${repo}`,
			"overrides:",
			"  - { rule: small-diffs, change: skip, reason: The rename touches every file. }",
			"---",
			"",
			"# Rename the config key",
			"",
			"## Goal",
			"",
			"Rename `colour` to `color` everywhere.",
			"",
			"## Acceptance criteria",
			"",
			"- **AC1** No file mentions `colour`.",
			"- **AC2** Old configs still load.",
			"",
			"## Scope",
			"",
			"In: the config loader and its docs.",
			"Out: the CLI.",
			"",
			"## Decide for me / Ask me",
			"",
			"Decide test names; ask before changing the public API.",
			"",
			"## Delivery",
			"",
			"One branch, ready to merge.",
			"",
			"## Constraints",
			"",
			"Old configs keep loading.",
			"",
		].join("\n"),
	);
}

/** An intake session whose Lead has written `text` as the Brief draft and asked for its approval. */
async function briefAsked(text?: (repo: string) => string) {
	const session = intakeSession();
	await session.pi.team("start software");
	const draft = join(effortDir(session.roots), "brief.draft.md");
	writeFileSync(draft, text ? text(session.repo) : brief(session.repo));
	const reply = await session.pi.call("team_request_approval", { checkpoint: "brief", path: draft });
	return { ...session, draft, reply };
}

describe("intake: asking the human to approve the Brief", () => {
	it("refuses a Brief missing a skeleton section, repeating an acceptance-criterion id or overriding an unknown rule, naming each problem", async () => {
		const { roots, repo, pi } = intakeSession();
		await pi.team("start software");
		const draft = join(effortDir(roots), "brief.draft.md");
		writeFileSync(
			draft,
			brief(repo, (text) => text.replace("## Delivery\n\nOne branch, ready to merge.\n\n", "").replace("**AC2**", "**AC1**").replace("rule: small-diffs", "rule: tiny-diffs")),
		);

		await assert.rejects(pi.call("team_request_approval", { checkpoint: "brief", path: draft }), (error: Error) => {
			assert.match(error.message, /no `Delivery` section/);
			assert.match(error.message, /`AC1` is used more than once/);
			assert.match(error.message, /`tiny-diffs`.*`small-diffs`/);
			return true;
		});
		await pi.team("pending");
		assert.equal(pi.notifications.at(-1)?.message, "Nothing is waiting on you.");
	});

	it("refuses a Brief that doesn't record the Effort's repo and Playbook sha", async () => {
		const { roots, repo, pi } = intakeSession();
		await pi.team("start software");
		const draft = join(effortDir(roots), "brief.draft.md");
		writeFileSync(draft, brief(repo, (text) => text.replace(`repo: ${repo}`, "repo: /elsewhere").replace(sha(INTAKE_PLAYBOOK), "b".repeat(64))));

		await assert.rejects(pi.call("team_request_approval", { checkpoint: "brief", path: draft }), (error: Error) => {
			assert.ok(error.message.includes(`\`repo\` must be the Effort's repo, ${repo}`), error.message);
			assert.ok(error.message.includes(`\`playbook\` must be the sha256 of the Playbook in force, ${sha(INTAKE_PLAYBOOK)}`), error.message);
			return true;
		});
	});

	it("refuses any file but the Effort's own Brief draft, naming the draft", async () => {
		const { roots, repo, pi } = intakeSession();
		await pi.team("start software");
		const elsewhere = join(repo, "brief.md");
		writeFileSync(elsewhere, brief(repo));

		await assert.rejects(pi.call("team_request_approval", { checkpoint: "brief", path: elsewhere }), (error: Error) => {
			assert.ok(error.message.includes(join(effortDir(roots), "brief.draft.md")), error.message);
			return true;
		});
	});

	it("adds the Brief to `/team pending`, whose dialog lists each Role with the mode it runs in", async () => {
		const { draft, reply, pi } = await briefAsked();
		const asked = readFileSync(draft);

		pi.answer("Later");
		await pi.team("pending");

		assert.ok(reply.includes(sha(asked)), reply);
		assert.match(reply, /`\/team pending`/);
		const [dialog] = pi.dialogs;
		assert.deepEqual(dialog.options, ANSWERS);
		assert.ok(dialog.title.includes(draft) && dialog.title.includes(sha(asked)), dialog.title);
		assert.match(dialog.title, /- `architect`: auto\n- `dev`: acceptEdits\n- `qa`: auto/);
	});

	it("shows in the dialog each Playbook entry the Brief skips, with its reason, so the human sees it before work starts", async () => {
		const { pi } = await briefAsked();

		pi.answer("Later");
		await pi.team("pending");

		assert.match(pi.dialogs[0].title, /Playbook entries this Brief skips:\n- `small-diffs`: The rename touches every file\./);
	});

	it("keeps Teammates from starting until the Brief is approved: `team_plan` and `team_handoff` refuse", async () => {
		const { pi } = await briefAsked();

		await assert.rejects(pi.call("team_plan", { tasks: [] }), /No Teammate starts before the human approves the Brief/);
		await assert.rejects(pi.call("team_handoff", { slug: "design", body: "Design it." }), /No Teammate starts before the human approves the Brief/);
	});
});

describe("intake: the human's answer to the Brief", () => {
	it("approving writes the snapshot asked about as brief.md, snapshots the Playbook and the Team, records their shas, and wakes the Lead", async () => {
		const { roots, draft, pi } = await briefAsked();
		const asked = readFileSync(draft);
		writeFileSync(draft, "changed after asking\n");

		pi.answer("Approve");
		await pi.team("pending");

		const dir = effortDir(roots);
		assert.deepEqual(readFileSync(join(dir, "brief.md")), asked);
		assert.equal(readFileSync(join(dir, "playbook.md"), "utf8"), INTAKE_PLAYBOOK);
		const bundled = join(REPO_ROOT, "extensions", "team", "teams", "software");
		assert.deepEqual(readFileSync(join(dir, "team", "roles", "dev.md")), readFileSync(join(bundled, "roles", "dev.md")));
		const approvals = readFileSync(join(dir, "approvals.jsonl"), "utf8").trim().split("\n");
		assert.equal(approvals.length, 1);
		const record = JSON.parse(approvals[0]) as Record<string, string>;
		assert.equal(record.act, "brief");
		assert.equal(record.brief, sha(asked));
		assert.equal(record.playbook, sha(INTAKE_PLAYBOOK));
		assert.match(record.team, /^[0-9a-f]{64}$/);
		assert.equal(record.at, NOW.toISOString());
		const woken = pi.sent.at(-1);
		assert.equal(woken?.customType, "team-pending");
		assert.equal(woken?.triggerTurn, true);
		assert.match(woken?.content ?? "", /approved the Brief/);
		await pi.team("pending");
		assert.equal(pi.notifications.at(-1)?.message, "Nothing is waiting on you.");
	});

	it("lets the Effort past the Brief once approved, and edits to the human's own Team or Playbook change nothing in it", async () => {
		const { roots, pi } = await briefAsked();
		pi.answer("Approve");
		await pi.team("pending");
		const dir = effortDir(roots);
		const before = [readFileSync(join(dir, "playbook.md")), readFileSync(join(dir, "team", "team.md"))];

		writeFileSync(join(playbooksDir(roots), "software.md"), `${INTAKE_PLAYBOOK}\n- **new-rule**: added later.\n`);
		writeUserTeam(roots, "software", goodTeam("software"));

		assert.deepEqual([readFileSync(join(dir, "playbook.md")), readFileSync(join(dir, "team", "team.md"))], before);
		await assert.rejects(pi.call("team_plan", { tasks: [] }), (error: Error) => {
			assert.doesNotMatch(error.message, /No Teammate starts|changed since/);
			return true;
		});
	});

	it("reports a record whose sha no longer matches its approval, and never uses it", async () => {
		const { roots, pi } = await briefAsked();
		pi.answer("Approve");
		await pi.team("pending");
		const tampered = join(effortDir(roots), "brief.md");
		writeFileSync(tampered, "edited after approval\n");

		await assert.rejects(pi.call("team_handoff", { slug: "design", body: "Design it." }), (error: Error) => {
			assert.ok(error.message.includes(`${tampered} has sha256 ${sha("edited after approval\n")}`), error.message);
			return true;
		});
		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.ok(pi.notifications.at(-1)?.message.includes(tampered), pi.notifications.at(-1)?.message);
	});

	it("sending back wakes the Lead with the note and approves nothing, and the Lead can ask again", async () => {
		const { roots, draft, pi } = await briefAsked();

		pi.answer("Send back with a note", "AC2 needs a version range.");
		await pi.team("pending");

		assert.equal(existsSync(join(effortDir(roots), "brief.md")), false);
		const woken = pi.sent.at(-1);
		assert.equal(woken?.customType, "team-pending");
		assert.match(woken?.content ?? "", /AC2 needs a version range\./);
		await assert.rejects(pi.call("team_plan", { tasks: [] }), /No Teammate starts/);
		const again = await pi.call("team_request_approval", { checkpoint: "brief", path: draft });
		assert.match(again, /request `r2`/);
	});

	it("keeps the Brief waiting when the human answers later or backs out of the note", async () => {
		const { roots, pi } = await briefAsked();
		const sentBefore = pi.sent.length;

		pi.answer("Later");
		await pi.team("pending");
		pi.answer("Send back with a note", undefined);
		await pi.team("pending");

		assert.equal(pi.sent.length, sentBefore);
		assert.equal(existsSync(join(effortDir(roots), "brief.md")), false);
		pi.answer("Approve");
		await pi.team("pending");
		assert.equal(existsSync(join(effortDir(roots), "brief.md")), true);
	});

	it("won't approve a Brief once the Playbook it was agreed under is adopted again, and says why", async () => {
		const { roots, pi } = await briefAsked();
		adopt(roots, "software", `${INTAKE_PLAYBOOK}\n- **new-rule**: added later.\n`);

		await pi.team("pending");

		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.match(pi.notifications.at(-1)?.message ?? "", /can't be approved: the `software` Playbook .* is now [0-9a-f]{64}/);
		assert.equal(existsSync(join(effortDir(roots), "brief.md")), false);
	});
});

/** Where the software Team's Workspace for {@link EFFORT_ID} goes in `repo`. */
function workspaceOf(repo: string, effortId = EFFORT_ID): string {
	return join(repo, ".claude", "worktrees", `team-${effortId}`);
}

describe("the software Workspace at Brief approval", () => {
	it("cuts `team/<effort-id>` from the local default branch's tip into a worktree under `.claude/worktrees/`, leaving the human's checkout as it was", async () => {
		const { repo, pi } = await briefAsked();
		const base = git(repo, "rev-parse", "main");
		git(repo, "switch", "-q", "-c", "feature");
		commit(repo, { "feature.txt": "mine\n" }, "work in progress");
		writeFileSync(join(repo, "README.md"), "# edited, not committed\n");
		writeFileSync(join(repo, "notes.txt"), "untracked\n");
		const statusBefore = git(repo, "status", "--porcelain");

		pi.answer("Approve");
		await pi.team("pending");

		const workspace = workspaceOf(repo);
		assert.equal(git(repo, "rev-parse", `team/${EFFORT_ID}`), base);
		assert.equal(git(workspace, "rev-parse", "--abbrev-ref", "HEAD"), `team/${EFFORT_ID}`);
		assert.equal(git(workspace, "status", "--porcelain"), "");
		assert.equal(readFileSync(join(workspace, "README.md"), "utf8"), "# repo\n");
		assert.equal(existsSync(join(workspace, "feature.txt")), false);
		assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
		assert.equal(git(repo, "status", "--porcelain"), statusBefore);
		assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# edited, not committed\n");
	});

	it("records the commit the Effort starts from with the Brief approval, and tells the Lead and the human where the Workspace is", async () => {
		const { roots, repo, pi } = await briefAsked();
		const base = git(repo, "rev-parse", "main");

		pi.answer("Approve");
		await pi.team("pending");

		const workspace = { kind: "git-worktree", path: workspaceOf(repo), branch: `team/${EFFORT_ID}`, base, from: "main" };
		const dir = effortDir(roots);
		const record = JSON.parse(readFileSync(join(dir, "approvals.jsonl"), "utf8").trim()) as { workspace?: unknown };
		assert.deepEqual(record.workspace, workspace);
		const approved = readFileSync(join(dir, "effort.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; answer?: string; workspace?: unknown })
			.find((line) => line.type === "approval-answered" && line.answer === "approved");
		assert.deepEqual(approved?.workspace, workspace);
		for (const told of [pi.sent.at(-1)?.content ?? "", pi.notifications.at(-1)?.message ?? ""]) {
			for (const needed of [workspaceOf(repo), `team/${EFFORT_ID}`, base]) assert.ok(told.includes(needed), `${needed} missing from:\n${told}`);
		}
	});

	it("cuts from the branch `origin/HEAD` names when the repo has a remote", async () => {
		const { repo, pi } = await briefAsked();
		git(repo, "switch", "-q", "-c", "trunk");
		const base = commit(repo, { "trunk.txt": "shipped\n" }, "on trunk");
		git(repo, "switch", "-q", "main");
		git(repo, "update-ref", "refs/remotes/origin/trunk", base);
		git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");

		pi.answer("Approve");
		await pi.team("pending");

		assert.equal(git(repo, "rev-parse", `team/${EFFORT_ID}`), base);
		assert.equal(readFileSync(join(workspaceOf(repo), "trunk.txt"), "utf8"), "shipped\n");
	});

	it("adds `.claude/worktrees/` to the repo's local exclude when nothing ignores it yet, so the worktree never shows in `git status`", async () => {
		const { repo, pi } = await briefAsked();

		pi.answer("Approve");
		await pi.team("pending");

		assert.match(readFileSync(join(repo, ".git", "info", "exclude"), "utf8"), /^\.claude\/worktrees\/$/m);
		assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), "");
	});

	it("leaves the local exclude alone when the repo already ignores the worktrees folder", async () => {
		const { repo, pi } = await briefAsked();
		commit(repo, { ".gitignore": ".claude/\n" }, "ignore .claude");
		const exclude = join(repo, ".git", "info", "exclude");
		const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : undefined;

		pi.answer("Approve");
		await pi.team("pending");

		assert.equal(existsSync(exclude) ? readFileSync(exclude, "utf8") : undefined, before);
		assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), "");
		assert.equal(existsSync(workspaceOf(repo)), true);
	});

	it("copies what `.worktreeinclude` lists into the worktree, as Claude Code does: only files git ignores, never tracked or merely untracked ones", async () => {
		const { repo, pi } = await briefAsked();
		commit(repo, { ".gitignore": ".env\nsecrets/\nbuild/\n", ".worktreeinclude": ".env\nsecrets/\nloose.txt\nconfig.json\n", "config.json": "{}\n" }, "ignores");
		writeFileSync(join(repo, ".env"), "TOKEN=1\n");
		mkdirSync(join(repo, "secrets", "deep"), { recursive: true });
		writeFileSync(join(repo, "secrets", "deep", "key.pem"), "key\n");
		mkdirSync(join(repo, "build"));
		writeFileSync(join(repo, "build", "out.js"), "built\n");
		writeFileSync(join(repo, "loose.txt"), "untracked, not ignored\n");
		writeFileSync(join(repo, "config.json"), "{ \"edited\": true }\n");

		pi.answer("Approve");
		await pi.team("pending");

		const workspace = workspaceOf(repo);
		assert.equal(readFileSync(join(workspace, ".env"), "utf8"), "TOKEN=1\n");
		assert.equal(readFileSync(join(workspace, "secrets", "deep", "key.pem"), "utf8"), "key\n");
		assert.equal(existsSync(join(workspace, "build")), false);
		assert.equal(existsSync(join(workspace, "loose.txt")), false);
		assert.equal(readFileSync(join(workspace, "config.json"), "utf8"), "{}\n");
		assert.equal(git(workspace, "status", "--porcelain"), "");
	});

	it("trusts the repo's folder in Claude Code's config, keeping everything already in it", async () => {
		const { roots, repo, pi } = await briefAsked();
		const config = {
			numStartups: 7,
			projects: { "/elsewhere": { hasTrustDialogAccepted: false, allowedTools: ["Bash"] }, [repo]: { lastCost: 1.5 } },
			oauthAccount: { emailAddress: "someone@example.com" },
		};
		writeFileSync(roots.claudeConfigPath, `${JSON.stringify(config, null, 2)}\n`);

		pi.answer("Approve");
		await pi.team("pending");

		const written = JSON.parse(readFileSync(roots.claudeConfigPath, "utf8")) as unknown;
		assert.deepEqual(written, { ...config, projects: { ...config.projects, [repo]: { lastCost: 1.5, hasTrustDialogAccepted: true } } });
	});

	it("creates Claude Code's config with the trust when there is none yet", async () => {
		const { roots, repo, pi } = await briefAsked();

		pi.answer("Approve");
		await pi.team("pending");

		assert.deepEqual(JSON.parse(readFileSync(roots.claudeConfigPath, "utf8")), { projects: { [repo]: { hasTrustDialogAccepted: true } } });
	});

	it("approves nothing and cuts no branch when Claude Code's config can't be read, naming the file", async () => {
		const { roots, repo, pi } = await briefAsked();
		writeFileSync(roots.claudeConfigPath, "{ not json");

		pi.answer("Approve");
		await pi.team("pending");

		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.ok(pi.notifications.at(-1)?.message.includes(roots.claudeConfigPath), pi.notifications.at(-1)?.message);
		assert.equal(readFileSync(roots.claudeConfigPath, "utf8"), "{ not json");
		assert.equal(existsSync(join(effortDir(roots), "brief.md")), false);
		assert.equal(git(repo, "branch", "--list", `team/${EFFORT_ID}`), "");
		assert.equal(existsSync(workspaceOf(repo)), false);
	});

	it("approves nothing while the Effort's branch already exists, and approves once it is gone", async () => {
		const { roots, repo, pi } = await briefAsked();
		git(repo, "branch", `team/${EFFORT_ID}`);

		pi.answer("Approve");
		await pi.team("pending");

		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.match(pi.notifications.at(-1)?.message ?? "", new RegExp(`branch \`team/${EFFORT_ID}\` already exists`));
		assert.equal(existsSync(join(effortDir(roots), "brief.md")), false);
		assert.equal(existsSync(workspaceOf(repo)), false);

		git(repo, "branch", "-D", `team/${EFFORT_ID}`);
		pi.answer("Approve");
		await pi.team("pending");

		assert.equal(existsSync(join(effortDir(roots), "brief.md")), true);
		assert.equal(git(workspaceOf(repo), "rev-parse", "--abbrev-ref", "HEAD"), `team/${EFFORT_ID}`);
	});

	it("approves nothing in a repo with no commits to cut the Effort's branch from", async () => {
		const roots = tempRoots();
		adopt(roots, "software", INTAKE_PLAYBOOK);
		const repo = gitRepo(roots, "repo", { empty: true });
		const pi = fakePi(roots, { cwd: repo });
		await pi.team("start software");
		const draft = join(effortDir(roots), "brief.draft.md");
		writeFileSync(draft, brief(repo));
		await pi.call("team_request_approval", { checkpoint: "brief", path: draft });

		pi.answer("Approve");
		await pi.team("pending");

		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.match(pi.notifications.at(-1)?.message ?? "", /no commits yet/);
		assert.equal(existsSync(join(effortDir(roots), "brief.md")), false);
	});
});

/** A Playbook for the `crew` Team: an escalation with `ask` rules, and per-Role settings. */
const CREW_PLAYBOOK = [
	"---",
	"permissions:",
	"  escalate:",
	"    - id: history-rewrite",
	"      when: Any rebase or force-push.",
	'      ask: ["Bash(git rebase:*)", "Bash(git push --force:*)"]',
	"    - id: lockfile",
	"      when: Any edit to the lockfile.",
	'      ask: ["Edit(package-lock.json)", "Bash(git rebase:*)"]',
	"  roles:",
	'    builder: { mode: acceptEdits, allow: ["Bash(npm run build:*)"], deny: ["Bash(npm publish:*)"] }',
	'    "*": { allow: ["Bash(git status)"], deny: ["Bash(curl:*)"] }',
	"---",
	"",
	"## Rules",
	"",
	"- **small-diffs**: keep each Task's diff small.",
	"",
].join("\n");

const CREW_EFFORT_ID = "crew-2026-11-02";

/** A Brief for the `crew` Team with criteria `AC1` and `AC2`, on `playbook` and with any `overrides` lines. */
function crewBrief(repo: string, playbook = CREW_PLAYBOOK, overrides: string[] = []): string {
	return [
		"---",
		"team: crew",
		`playbook: ${sha(playbook)}`,
		`repo: ${repo}`,
		...overrides,
		"---",
		"",
		"# Rename the config key",
		"",
		"## Goal",
		"",
		"Rename `colour` to `color` everywhere.",
		"",
		"## Acceptance criteria",
		"",
		"- **AC1** No file mentions `colour`.",
		"- **AC2** Old configs still load.",
		"",
		"## Scope",
		"",
		"In: the config loader.",
		"Out: the CLI.",
		"",
		"## Decide for me / Ask me",
		"",
		"Decide test names.",
		"",
		"## Delivery",
		"",
		"One branch, ready to merge.",
		"",
	].join("\n");
}

/**
 * A session whose `crew` Effort has its Brief approved: a user Team whose
 * Roles set every launch flag between them, on {@link CREW_PLAYBOOK}.
 */
async function crewApproved(
	options: { bgExit?: number; hooks?: FakeHookStep[]; replies?: FakeHookStep[]; settings?: Record<string, unknown>; playbook?: string; overrides?: string[]; roots?: TempRoots } & Pick<
		NonNullable<Parameters<typeof fakePi>[1]>,
		"mode" | "env" | "attachExit" | "holdMs" | "usage" | "sessionEntries" | "sessionChild"
	> = {},
) {
	const roots = options.roots ?? tempRoots();
	const plugin = join(roots.scratch, "plugins", "lint");
	writeUserTeam(roots, "crew", {
		"team.md": teamMd("crew"),
		"roles/builder.md": roleMd(
			"builder",
			[
				"model: opus",
				"effort: high",
				'allowedTools: ["Read", "Bash(npm test:*)"]',
				"disallowedTools: [WebFetch]",
				"mcpServers:",
				"  docs:",
				"    command: docs-server",
				`plugins: [${JSON.stringify(plugin)}]`,
				"permissionMode: manual",
			].join("\n"),
		),
		"roles/reviewer.md": roleMd("reviewer", "permissionMode: dontAsk"),
		"roles/scout.md": roleMd("scout"),
	});
	adopt(roots, "crew", options.playbook ?? CREW_PLAYBOOK);
	const repo = gitRepo(roots);
	const pi = fakePi(roots, {
		cwd: repo,
		bgExit: options.bgExit,
		hooks: options.hooks,
		replies: options.replies,
		settings: options.settings,
		mode: options.mode,
		env: options.env,
		attachExit: options.attachExit,
		usage: options.usage,
		sessionEntries: options.sessionEntries,
		holdMs: options.holdMs,
		sessionChild: options.sessionChild,
	});
	await pi.team("start crew");
	const dir = effortDir(roots, CREW_EFFORT_ID);
	writeFileSync(join(dir, "brief.draft.md"), crewBrief(repo, options.playbook, options.overrides));
	await pi.call("team_request_approval", { checkpoint: "brief", path: join(dir, "brief.draft.md") });
	pi.answer("Approve");
	await pi.team("pending");
	return { roots, repo, pi, dir, plugin, workspace: workspaceOf(repo, CREW_EFFORT_ID) };
}

/** A plan covering both of {@link crewBrief}'s criteria, one Task per Role. */
const CREW_PLAN = [
	{ slug: "rename-key", role: "builder", goal: "Rename the key.", criteria: ["AC1"] },
	{ slug: "check-old-configs", role: "reviewer", goal: "Check old configs load.", dependsOn: ["rename-key"], criteria: ["AC2"] },
	{ slug: "survey", role: "scout", goal: "Find every use of the key." },
];

describe("planning: team_plan", () => {
	it("refuses a plan that leaves an acceptance criterion uncovered or names a Role the Team lacks, writing nothing", async () => {
		const { pi, dir } = await crewApproved();

		await assert.rejects(
			pi.call("team_plan", { tasks: [{ slug: "rename-key", role: "builder", goal: "Rename it.", criteria: ["AC1"] }, { slug: "docs", role: "writer", goal: "Docs." }] }),
			(error: Error) => {
				assert.match(error.message, /no Task covers `AC2`/);
				assert.match(error.message, /Task `docs` names the Role `writer`, which Team `crew` doesn't have; its Roles are `builder`, `reviewer`, `scout`/);
				return true;
			},
		);
		assert.equal(existsSync(join(dir, "plan.md")), false);
	});

	it("writes plan.md with every Task, and a re-plan while the Brief is unchanged replaces it", async () => {
		const { pi, dir } = await crewApproved();

		const reply = await pi.call("team_plan", { tasks: CREW_PLAN });

		assert.match(reply, /^Wrote the plan of Effort `crew-2026-11-02`: 3 Tasks, covering `AC1`, `AC2`\./);
		const written = readFileSync(join(dir, "plan.md"), "utf8");
		for (const needed of ["rename-key", "check-old-configs", "survey", "Rename the key.", "AC2", "builder"]) {
			assert.ok(written.includes(needed), `plan.md doesn't mention ${needed}:\n${written}`);
		}

		const again = await pi.call("team_plan", { tasks: [{ slug: "do-it-all", role: "builder", goal: "Everything at once.", criteria: ["AC1", "AC2"] }] });

		assert.match(again, /^Replaced the plan/);
		const replaced = readFileSync(join(dir, "plan.md"), "utf8");
		assert.ok(replaced.includes("do-it-all"), replaced);
		assert.equal(replaced.includes("rename-key"), false, replaced);
	});
});

describe("handing off: team_handoff", () => {
	it("writes the Task folder and task.md, launches a Teammate of the Task's Role in the Workspace, and says which one started", async () => {
		const { pi, dir, workspace } = await crewApproved();
		await pi.call("team_plan", { tasks: CREW_PLAN });

		const reply = await pi.call("team_handoff", { slug: "rename-key", body: "# Rename the key\n\nRename `colour` to `color`.\n" });

		assert.match(reply, /^started builder-1 on Task `rename-key`/);
		assert.equal(readFileSync(join(dir, "tasks", "001-builder-rename-key", "task.md"), "utf8"), "# Rename the key\n\nRename `colour` to `color`.\n");
		const launches = pi.claude.launches();
		assert.equal(launches.length, 1);
		assert.equal(launches[0].cwd, workspace);
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /running, with `builder-1` \(tasks\/001-builder-rename-key\/\)/);
	});

	it("launches `claude --bg` with the Role's flags, the mode in force, the generated files, the Effort dir, the Team's mod and the first handoff pointer as the prompt, about 5 s apart", async () => {
		const { pi, dir, plugin, roots } = await crewApproved();
		const mod = join(roots.agentDir, "team", "mod");
		await pi.call("team_plan", { tasks: CREW_PLAN });

		for (const slug of ["rename-key", "check-old-configs", "survey"]) await pi.call("team_handoff", { slug, body: `# ${slug}\n` });

		const teammate = (id: string) => join(dir, "teammates", id);
		const pointer = (folder: string) =>
			`New Task \`${folder.slice(folder.indexOf("-", 4) + 1)}\`: read ${join(dir, "tasks", folder, "task.md")} and do what it asks. When it is done, write your result to ${join(dir, "tasks", folder, "result-1.md")}.`;
		assert.deepEqual(
			pi.claude.launches().map((launch) => launch.argv),
			[
				[
					"--bg",
					"--model",
					"opus",
					"--effort",
					"high",
					"--permission-mode",
					"acceptEdits",
					"--settings",
					join(teammate("builder-1"), "settings.json"),
					"--append-system-prompt-file",
					join(teammate("builder-1"), "prompt.md"),
					"--add-dir",
					dir,
					"--allowedTools",
					"Read",
					"Bash(npm test:*)",
					"--disallowedTools",
					"WebFetch",
					"EnterPlanMode",
					"--mcp-config",
					join(teammate("builder-1"), "mcp.json"),
					"--plugin-dir",
					mod,
					"--plugin-dir",
					plugin,
					"--name",
					"team-crew-2026-11-02-builder-1",
					pointer("001-builder-rename-key"),
				],
				[
					"--bg",
					"--permission-mode",
					"dontAsk",
					"--settings",
					join(teammate("reviewer-1"), "settings.json"),
					"--append-system-prompt-file",
					join(teammate("reviewer-1"), "prompt.md"),
					"--add-dir",
					dir,
					"--disallowedTools",
					"EnterPlanMode",
					"--plugin-dir",
					mod,
					"--name",
					"team-crew-2026-11-02-reviewer-1",
					pointer("002-reviewer-check-old-configs"),
				],
				[
					"--bg",
					"--permission-mode",
					"auto",
					"--settings",
					join(teammate("scout-1"), "settings.json"),
					"--append-system-prompt-file",
					join(teammate("scout-1"), "prompt.md"),
					"--add-dir",
					dir,
					"--disallowedTools",
					"EnterPlanMode",
					"--plugin-dir",
					mod,
					"--name",
					"team-crew-2026-11-02-scout-1",
					pointer("003-scout-survey"),
				],
			],
		);
		assert.deepEqual(JSON.parse(pi.claude.launches()[0].mcpConfig ?? "null"), { mcpServers: { docs: { command: "docs-server" } } });
		assert.ok(existsSync(join(mod, "hooks", "register.ts")), "the mod isn't copied under pi's agent folder");
		// Claude Code's limit on how fast background sessions start: each launch waits until 5 s after the last.
		assert.deepEqual(pi.sleeps, [5000, 10000]);
	});

	it("gives the Teammate settings that add the hooks, the env its mod journals by, the Playbook's rules for its Role, every escalate ask and a deny on editing the Effort's records, and nothing that replaces the human's own; the floor hook also names the folder the Teammate works in", async () => {
		const { pi, dir } = await crewApproved();
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" });

		const hooks = (id: string, workspace: string) => {
			const command = `'${process.execPath}' '${HOOK_SCRIPT}' '${dir}' '${id}'`;
			const entry = { hooks: [{ type: "command", command }] };
			return {
				SessionStart: [entry],
				SessionEnd: [entry],
				UserPromptSubmit: [entry],
				Stop: [entry],
				StopFailure: [entry],
				PermissionRequest: [{ hooks: [{ type: "command", command, timeout: 3600 }] }],
				PermissionDenied: [entry],
				Notification: [entry],
				PostToolUse: [entry],
				PostToolUseFailure: [entry],
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${command} '${workspace}'` }] }],
			};
		};
		const records = ["brief.md", "clarifications.md", "approvals.jsonl", "playbook.md", "team/**", "effort.jsonl"].map((record) => `Edit(/${dir}/${record})`);
		const ask = ["Bash(git rebase:*)", "Bash(git push --force:*)", "Edit(package-lock.json)"];
		const [builder, scout] = pi.claude.launches().map((launch) => JSON.parse(launch.settings ?? "null"));
		const [builderCwd, scoutCwd] = pi.claude.launches().map((launch) => launch.cwd);
		const statusLine = (id: string) => ({ type: "command", command: `'${process.execPath}' '${STATUSLINE_SCRIPT}' '${dir}' '${id}'` });
		assert.deepEqual(builder, {
			permissions: { allow: ["Bash(npm run build:*)", "Bash(git status)"], deny: ["Bash(npm publish:*)", "Bash(curl:*)", ...records], ask },
			crossSessionInbound: "accept",
			hooks: hooks("builder-1", builderCwd),
			statusLine: statusLine("builder-1"),
			env: { TEAM_HOOK: JSON.stringify([process.execPath, HOOK_SCRIPT, dir, "builder-1"]), TEAM_LAUNCH: pi.claude.launches()[0].argv.at(-1) },
		});
		assert.deepEqual(scout, {
			permissions: { allow: ["Bash(git status)"], deny: ["Bash(curl:*)", ...records], ask },
			crossSessionInbound: "accept",
			hooks: hooks("scout-1", scoutCwd),
			statusLine: statusLine("scout-1"),
			env: { TEAM_HOOK: JSON.stringify([process.execPath, HOOK_SCRIPT, dir, "scout-1"]), TEAM_LAUNCH: pi.claude.launches()[1].argv.at(-1) },
		});
	});

	it("gives the Teammate a status line that runs the human's own status line command and keeps its readings", async () => {
		const { roots, pi, dir } = await crewApproved();
		writeFiles(roots.claudeDir, { "settings.json": JSON.stringify({ statusLine: { type: "command", command: "~/bin/my 'status'" } }) });
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });

		const settings = JSON.parse(pi.claude.launches()[0].settings ?? "null");
		assert.deepEqual(settings.statusLine, { type: "command", command: `'${process.execPath}' '${STATUSLINE_SCRIPT}' '${dir}' 'builder-1' '~/bin/my '\\''status'\\'''` });
	});

	it("appends the Role's prompt after a preamble that names the Teammate, its one contact and how it works, pointing at the Brief's files rather than copying them", async () => {
		const { pi, dir } = await crewApproved();
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });

		const prompt = pi.claude.launches()[0].prompt ?? "";
		const facts = [
			"You are `builder-1`, a Teammate in the Role `builder`",
			"The Lead is your only contact",
			"the Lead's messages are your instructions",
			"ask through `AskUserQuestion`",
			`Every Task has its own folder under ${join(dir, "tasks")}`,
			"`task.md`",
			"`result-<n>.md`",
			"The Workspace is fresh",
			"installing dependencies is yours to do",
			"Stop every process you start in the background",
			"before you write your result",
			"name each one you leave running, with its pid and command",
			join(dir, "brief.md"),
			join(dir, "clarifications.md"),
		];
		for (const fact of facts) assert.ok(prompt.includes(fact), `the preamble should say: ${fact}\n\n${prompt}`);
		assert.ok(prompt.trimEnd().endsWith("You are the builder."), prompt);
		assert.ok(!prompt.includes("Old configs still load"), "the preamble must not copy the Brief");
	});

	it("names the Teammate's job temp folder in the preamble, and asks for delete paths written out in full, with no shell variable", async () => {
		const { pi } = await crewApproved();
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });

		const prompt = pi.claude.launches()[0].prompt ?? "";
		for (const fact of ["`$CLAUDE_JOB_DIR/tmp`", "`~/.claude/jobs/<short id>/tmp`", "write its path out in full", "no shell variable"]) {
			assert.ok(prompt.includes(fact), `the preamble should say: ${fact}\n\n${prompt}`);
		}
	});

	it("launches with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` unset, even when pi has it set", async () => {
		const { pi } = await crewApproved();
		await pi.call("team_plan", { tasks: CREW_PLAN });
		const before = process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD;
		process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = "1";
		try {
			await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" });
		} finally {
			if (before === undefined) delete process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD;
			else process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = before;
		}

		assert.equal(pi.claude.launches()[0].additionalDirectoriesClaudeMd, undefined);
	});

	it("reports a launch that fails and leaves the Task planned, with no Teammate recorded", async () => {
		const { pi, dir } = await crewApproved({ bgExit: 1 });
		await pi.call("team_plan", { tasks: CREW_PLAN });
		const log = readFileSync(join(dir, "effort.jsonl"), "utf8");

		await assert.rejects(pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" }), /`builder-1` didn't start, so Task `rename-key` is still planned: fake claude: the background session could not start/);

		// Only the launch written ahead and its abandonment follow: no Teammate, no handoff.
		const after = readFileSync(join(dir, "effort.jsonl"), "utf8");
		assert.ok(after.startsWith(log));
		assert.deepEqual(
			after.slice(log.length).split("\n").filter(Boolean).map((line) => [JSON.parse(line).type, JSON.parse(line).teammate]),
			[
				["launch-intended", "builder-1"],
				["launch-abandoned", "builder-1"],
			],
		);
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## rename-key\n(?:.*\n)*?- Status: planned/);
	});
});

/** The `effort.jsonl` lines of an Effort, parsed. */
function effortLines(dir: string): Record<string, unknown>[] {
	return readFileSync(join(dir, "effort.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Ring the Lead bridge's doorbell as the hook script does, resolving once the Lead has closed the connection. */
function ringDoorbell(port: number, line: Record<string, unknown>): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port }, () => socket.end(`${JSON.stringify(line)}\n`));
		socket.on("error", reject);
		socket.on("close", () => resolve());
	});
}

/** What woke the Lead about its Teammates. */
function teammateWakes(sent: SentMessage[]): SentMessage[] {
	return sent.filter((message) => message.customType === "team-teammate");
}

const RENAME_RESULT = join("tasks", "001-builder-rename-key", "result-1.md");

describe("a Teammate's events reach the Lead", () => {
	it("records the Teammate's session id, short id and inbox socket from its SessionStart, with the journal cursor it consumed", async () => {
		const { pi, dir } = await crewApproved({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }] });
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });

		const journal = readFileSync(join(dir, "teammates", "builder-1", "events.jsonl"), "utf8").split("\n").filter(Boolean);
		assert.equal(journal.length, 1);
		const sessions = effortLines(dir).filter((line) => line.type === "teammate-session");
		assert.equal(sessions.length, 1);
		const [session] = sessions;
		assert.equal(session.teammate, "builder-1");
		assert.equal(session.cursor, 1);
		assert.equal(session.source, "startup");
		assert.match(String(session.sessionId), /^[0-9a-f]{8}-/);
		assert.equal(session.shortId, String(session.sessionId).slice(0, 8));
		const socket = (session.inbox as { socket: string }).socket;
		assert.match(socket, /\.sock$/);
		assert.ok(lstatSync(socket).isSocket(), `${socket} is a listening socket`);
		assert.deepEqual(teammateWakes(pi.sent), []);
	});

	it("wakes the Lead once when a Stop follows the round's result, naming the Teammate, the Task and the result", async () => {
		const { pi, dir } = await crewApproved({
			hooks: [
				{ event: "SessionStart", payload: { source: "startup" } },
				{ event: "UserPromptSubmit", payload: { prompt: "New Task `rename-key`" } },
				{ write: "result" },
				{ event: "Stop", payload: { last_assistant_message: "Renamed it." } },
			],
		});
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });

		const wakes = teammateWakes(pi.sent);
		assert.equal(wakes.length, 1);
		assert.equal(wakes[0].triggerTurn, true);
		assert.equal(wakes[0].deliverAs, "followUp");
		assert.match(wakes[0].content, /`builder-1`.*`rename-key`/);
		assert.ok(wakes[0].content.includes(join(dir, RENAME_RESULT)), wakes[0].content);
		const applied = effortLines(dir)
			.filter((line) => typeof line.cursor === "number")
			.map((line) => [line.type, line.cursor]);
		assert.deepEqual(applied, [
			["teammate-session", 1],
			["prompt-landed", 2],
			["task-done", 3],
		]);
	});

	it("wakes the Lead with \"stopped short\" and the last assistant message when a Stop comes without a new result", async () => {
		const { pi, dir } = await crewApproved({
			hooks: [
				{ event: "SessionStart", payload: { source: "startup" } },
				{ event: "Stop", payload: { last_assistant_message: "I need the old config format before I can start." } },
			],
		});
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });

		const wakes = teammateWakes(pi.sent);
		assert.equal(wakes.length, 1);
		assert.match(wakes[0].content, /`builder-1` stopped short on Task `rename-key`/);
		assert.ok(wakes[0].content.includes("I need the old config format before I can start."), wakes[0].content);
		assert.ok(wakes[0].content.includes(join(dir, RENAME_RESULT)), wakes[0].content);
		assert.equal(effortLines(dir).filter((line) => line.type === "teammate-stopped").length, 1);
	});

	it("drops an idle Notification and logs a PermissionDenied, waking nobody", async () => {
		const { pi, dir } = await crewApproved({
			hooks: [
				{ event: "Notification", payload: { notification_type: "idle_prompt", message: "Claude is waiting for your input" } },
				{ event: "PermissionDenied", payload: { tool_name: "Bash", reason: "denied by rule" } },
			],
		});
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });

		const applied = effortLines(dir)
			.filter((line) => typeof line.cursor === "number")
			.map((line) => [line.type, line.cursor, line.tool]);
		assert.deepEqual(applied, [["permission-denied", 2, "Bash"]]);
		assert.deepEqual(teammateWakes(pi.sent), []);
	});

	it("batches what finishes while the Lead is streaming into one follow-up, sent when its run settles", async () => {
		const { pi } = await crewApproved({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }, { write: "result" }, { event: "Stop", payload: { last_assistant_message: "Done." } }] });
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.emit("agent_start");

		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" });

		assert.deepEqual(teammateWakes(pi.sent), []);
		await pi.emit("agent_settled", { aborted: false });
		const wakes = teammateWakes(pi.sent);
		assert.equal(wakes.length, 1);
		assert.equal(wakes[0].triggerTurn, true);
		assert.equal(wakes[0].deliverAs, "followUp");
		assert.match(wakes[0].content, /`builder-1`.*`rename-key`/);
		assert.match(wakes[0].content, /`scout-1`.*`survey`/);
		await pi.emit("agent_settled", { aborted: false });
		assert.equal(teammateWakes(pi.sent).length, 1);
	});

	it("writes lead.json with the bridge's port and token, ignores a doorbell without the token, and applies a line rung twice once", async () => {
		const { pi, dir, roots } = await crewApproved();
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		const lead = JSON.parse(readFileSync(join(dir, "lead.json"), "utf8")) as { pid: number; port: number; token: string; sessionFile: string; startedAt: string };
		assert.equal(lead.pid, process.pid);
		assert.equal(typeof lead.port, "number");
		assert.match(lead.token, /^[0-9a-f]{16,}$/);
		assert.equal(lead.startedAt, NOW.toISOString());
		assert.equal(lead.sessionFile, join(roots.scratch, "session.jsonl"));

		// The Teammate finishes, its hook journals the Stop, and only then does a doorbell ring.
		writeFileSync(join(dir, RENAME_RESULT), "# Result\n");
		const stop = { session_id: "8f3c2a1b-0000-4000-8000-000000000001", hook_event_name: "Stop", last_assistant_message: "Renamed it." };
		writeFileSync(join(dir, "teammates", "builder-1", "events.jsonl"), `${JSON.stringify({ from: "hook", at: NOW.toISOString(), event: "Stop", payload: stop })}\n`);
		const before = effortLines(dir).length;

		await ringDoorbell(lead.port, { type: "doorbell", token: "not-the-token", teammate: "builder-1" });
		await ringDoorbell(lead.port, { type: "doorbell", teammate: "builder-1" });

		assert.equal(effortLines(dir).length, before);
		assert.deepEqual(teammateWakes(pi.sent), []);

		await ringDoorbell(lead.port, { type: "doorbell", token: lead.token, teammate: "builder-1" });
		await ringDoorbell(lead.port, { type: "doorbell", token: lead.token, teammate: "builder-1" });
		await pi.emit("agent_settled", { aborted: false });

		assert.deepEqual(
			effortLines(dir)
				.slice(before)
				.map((line) => [line.type, line.cursor]),
			[["task-done", 1]],
		);
		assert.equal(teammateWakes(pi.sent).length, 1);
	});

	it("stops listening when the session shuts down", async () => {
		const { pi, dir } = await crewApproved();
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		const { port } = JSON.parse(readFileSync(join(dir, "lead.json"), "utf8")) as { port: number };

		await pi.emit("session_shutdown", { reason: "quit" });

		await assert.rejects(ringDoorbell(port, { type: "doorbell" }), /ECONNREFUSED/);
	});
});

/** Wait for `condition`, which a Teammate's session makes true from another process. */
async function until(condition: () => boolean, what: string): Promise<void> {
	for (let tries = 0; tries < 250; tries++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(`gave up waiting until ${what}`);
}

/** A Teammate that takes its pointer, writes the result it asks for and stops: at launch, and for each message in its inbox. */
const WORKS: FakeHookStep[] = [{ event: "UserPromptSubmit" }, { write: "result" }, { event: "Stop", payload: { last_assistant_message: "Done." } }];
const RENAME_DIR = join("tasks", "001-builder-rename-key");
/** `builder-1`'s `--name`, which `claude agents --json` knows it by. */
const BUILDER_1 = "team-crew-2026-11-02-builder-1";

/** An approved crew Effort whose `rename-key` Task is handed off to `builder-1`, who has written round 1's result. */
async function renameReported(options: { hooks?: FakeHookStep[]; replies?: FakeHookStep[] } = {}) {
	const crew = await crewApproved({ hooks: options.hooks ?? [{ event: "SessionStart", payload: { source: "startup" } }, ...WORKS], replies: options.replies ?? WORKS });
	await crew.pi.call("team_plan", { tasks: CREW_PLAN });
	await crew.pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
	return crew;
}

/** The fakes whose Teammates hold hooks open, released after each test so no hook outlives it. */
const holding: { release(): void }[] = [];

const PUBLISH = { tool_name: "Bash", tool_input: { command: "npm publish --dry-run", description: "See what would publish" } };
const FORMAT_QUESTIONS = {
	tool_name: "AskUserQuestion",
	tool_input: {
		questions: [
			{ question: "Which format should old configs load from?", header: "Format", multiSelect: false, options: [{ label: "YAML", description: "As today" }, { label: "JSON", description: "As the new key" }] },
			{ question: "Which checks should run?", header: "Checks", multiSelect: true, options: [{ label: "lint", description: "" }, { label: "test", description: "" }, { label: "build", description: "" }] },
		],
	},
};

/**
 * An approved crew Effort whose `builder-1`, handed `rename-key` in session
 * `c0ffee12`, asks `asked` through its held PermissionRequest hook, once the
 * Lead was woken about it.
 */
async function asking(asked: Record<string, unknown>, options: { holdMs?: number } = {}) {
	const crew = await crewApproved({
		holdMs: options.holdMs,
		hooks: [
			{ event: "SessionStart", payload: { source: "startup", session_id: "c0ffee12-0000-4000-8000-000000000001" } },
			{ event: "UserPromptSubmit", payload: { prompt: "New Task `rename-key`" } },
			{ event: "PermissionRequest", payload: asked, hold: true },
		],
	});
	holding.push(crew.pi.claude);
	await crew.pi.call("team_plan", { tasks: CREW_PLAN });
	await crew.pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
	await until(() => effortLines(crew.dir).some((line) => line.type === "request-held"), "the Lead holds builder-1's request");
	const request = String(effortLines(crew.dir).find((line) => line.type === "request-held")?.request);
	const [hook] = crew.pi.claude.held();
	return { ...crew, request, hook };
}

/** The decision a held hook printed, once it exited. */
async function printed(hook: FakeHeldHook): Promise<unknown> {
	await until(() => hook.exitCode() !== undefined, "the held hook exits");
	assert.equal(hook.exitCode(), 0);
	return JSON.parse(hook.output() ?? "");
}

function journalled(dir: string, event: string): boolean {
	return readFileSync(join(dir, "teammates", "builder-1", "events.jsonl"), "utf8").includes(`"event":"${event}"`);
}

/** `builder-1` on `rename-key` runs out on the session limit, which resets at `reset`; any other Task's Teammate works it. */
function sessionOut(reset: Date): FakeHookStep[] {
	const hours = reset.getUTCHours();
	const clock = `${hours % 12 || 12}:${String(reset.getUTCMinutes()).padStart(2, "0")}${hours < 12 ? "am" : "pm"}`;
	return [
		{ event: "SessionStart", payload: { source: "startup" } },
		{ event: "UserPromptSubmit" },
		{ event: "StopFailure", payload: { error: "rate_limit", last_assistant_message: `You've hit your session limit · resets ${clock} (UTC)` }, when: "rename-key" },
		{ write: "result", when: "survey" },
		{ event: "Stop", payload: { last_assistant_message: "Done." }, when: "survey" },
	];
}

describe("usage limits: a Teammate's StopFailure", () => {
	it("pauses the Effort on a session limit, queues new Tasks, then at the reset starts them and sends the limited Teammate `continue`", async () => {
		// The hook stamps journal lines with the real time, which the reset is read after: the clock is set to it.
		const started = new Date();
		const reset = new Date(Math.floor(started.getTime() / 60_000) * 60_000 + 61 * 60_000);
		const hhmm = reset.toISOString().slice(11, 16);
		const crew = await crewApproved({ hooks: sessionOut(reset), replies: [{ event: "UserPromptSubmit" }, { event: "Stop", payload: { last_assistant_message: "Renamed." } }] });
		const { pi, dir } = crew;
		pi.travel(started.toISOString());
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		await until(() => effortLines(dir).some((line) => line.type === "paused" && line.by === "usage"), "the session limit paused the Effort");

		assert.deepEqual(teammateWakes(pi.sent), [], "the Lead's turns spend the same account, so a limit wakes nobody");
		assert.ok(pi.timers().length > 0, "the Lead ticks a clock while it holds the Effort");
		const block = pi.widgets.at(-1)?.lines ?? [];
		assert.ok(block.some((line) => new RegExp(`by a usage limit since \\d\\d:\\d\\d UTC: session limit, resets (\\S+ )?${hhmm} UTC`).test(line)), block.join("\n"));
		const queued = await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" });
		assert.match(queued, new RegExp(`queued Task \`survey\`.*paused by a usage limit since .*: session limit, until (\\S+ )?${hhmm} UTC`, "s"));
		assert.equal(pi.claude.launches().length, 1, "no new Task starts while paused");

		// At the reset the pause lifts and the queued Task starts; the limited Teammate waits out the grace.
		pi.travel(new Date(reset.getTime() + 30_000).toISOString());
		await pi.tick();
		assert.ok(!effortLines(dir).some((line) => line.type === "teammate-continued"));
		assert.equal(pi.claude.launches().length, 2, "the queued Task starts once the pause lifts");
		assert.deepEqual(pi.claude.inbox(), []);

		pi.travel(new Date(reset.getTime() + 120_000).toISOString());
		await pi.tick();
		await until(() => pi.claude.inbox().length > 0, "continue reached builder-1's inbox");
		const [connection] = pi.claude.inbox();
		assert.equal(connection.lines[1], JSON.stringify({ type: "user", message: { role: "user", content: "continue" } }));
		await until(() => effortLines(dir).some((line) => line.type === "teammate-continued"), "the continue is on record");
		await pi.tick();
		assert.equal(effortLines(dir).filter((line) => line.type === "teammate-continued").length, 1, "continue is sent once");
		await pi.emit("session_shutdown");
		assert.deepEqual(pi.timers(), [], "the clock stops with the session");
	});

	it("asks the human about a weekly limit that resets more than a day away, in `/team pending`, and cancelling ends the Effort as `/team cancel` does", async () => {
		const weekly: FakeHookStep[] = [
			{ event: "SessionStart", payload: { source: "startup" } },
			{ event: "UserPromptSubmit" },
			{ event: "StopFailure", payload: { error: "rate_limit", last_assistant_message: "You've hit your weekly limit · resets Mon 12:00am (UTC)" } },
		];
		const { pi, dir } = await crewApproved({ hooks: weekly });
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		await until(() => effortLines(dir).some((line) => line.type === "usage-escalated"), "the weekly limit waits on the human");
		const [session] = effortLines(dir).filter((line) => line.type === "teammate-session");

		pi.answer("Cancel the Effort: stop every Teammate and end it without sign-off");
		await pi.team("pending");
		const asked = pi.dialogs.at(-1);
		assert.match(asked?.title ?? "", /weekly limit/);
		assert.deepEqual(asked?.options, ["Stay paused until it resets", "Cancel the Effort: stop every Teammate and end it without sign-off", "Later"]);
		assert.ok(pi.claude.calls().some((argv) => argv[0] === "stop" && argv[1] === session.shortId), JSON.stringify(pi.claude.calls()));
		assert.ok(effortLines(dir).some((line) => line.type === "usage-answered" && line.choice === "cancel"));
		assert.ok(effortLines(dir).some((line) => line.type === "effort-ended" && line.how === "cancelled"));
		assert.match(pi.sent.at(-1)?.content ?? "", /Cancelled Effort .* holds no Effort now/s);
	});
});

describe("a Teammate's held requests: team_answer", () => {
	afterEach(() => {
		for (const fake of holding.splice(0)) fake.release();
	});

	it("wakes the Lead with the request, and turns its allow, with a session rule, into the hook's decision", async () => {
		const { pi, request, hook } = await asking(PUBLISH);

		const [wake] = teammateWakes(pi.sent);
		assert.ok(wake.content.includes(`\`builder-1\` asks permission to use \`Bash\` on Task \`rename-key\` (\`${request}\`)`), wake.content);
		assert.ok(wake.content.includes("npm publish --dry-run"), wake.content);
		assert.equal(hook.exitCode(), undefined, "the hook holds until the Lead answers");

		const reply = await pi.call("team_answer", { request, decision: "allow", reason: "A dry run publishes nothing.", rule: "Bash(npm publish --dry-run)", grant: "dry-runs" });

		assert.match(reply, new RegExp(`Answered \`${request}\``));
		assert.deepEqual(await printed(hook), {
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: {
					behavior: "allow",
					updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm publish --dry-run" }], behavior: "allow", destination: "session" }],
				},
			},
		});
	});

	it("marks a Teammate holding a session rule for a fresh session once an approved Brief change alters what the Lead answers under, and not for one that doesn't", async () => {
		const { pi, dir, repo, request, hook } = await asking(PUBLISH);
		await pi.call("team_answer", { request, decision: "allow", reason: "A dry run publishes nothing.", rule: "Bash(npm publish --dry-run)" });
		await printed(hook);
		const ask = async (text: string) => {
			writeFileSync(join(dir, "brief.draft.md"), text);
			await pi.call("team_request_approval", { checkpoint: "brief-change", path: join(dir, "brief.draft.md"), affects: [] });
			const woken = pi.sent.length;
			pi.answer("Approve");
			await pi.team("pending");
			return pi.sent.slice(woken).find((message) => message.customType === "team-pending")?.content ?? "";
		};

		assert.doesNotMatch(await ask(changedBrief(repo)), /session rules/, "a criterion change leaves the terms alone");
		assert.equal(approvals(dir).at(-1)?.terms, undefined);

		const wake = await ask(changedBrief(repo).replace("One branch, ready to merge.", "One branch, pushed for review."));
		assert.match(wake, /`builder-1` holds session rules you added under the old terms, so it starts in a fresh session at its next Task/);
		assert.equal(approvals(dir).at(-1)?.terms, true);
		assert.deepEqual(effortLines(dir).filter((line) => line.type === "approval-answered").at(-1)?.renew, ["builder-1"]);
	});

	it("turns a deny into the hook's decision with the reason, and refuses a second answer", async () => {
		const { pi, request, hook } = await asking(PUBLISH);

		await pi.call("team_answer", { request, decision: "deny", reason: "Publishing is the human's call." });

		assert.deepEqual(await printed(hook), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Publishing is the human's call." } } });
		await assert.rejects(pi.call("team_answer", { request, decision: "allow", reason: "On second thought." }), /already answered: you answered it/);
	});

	it("answers an AskUserQuestion with every original field and the answers keyed by each question's text", async () => {
		const { pi, request, hook } = await asking(FORMAT_QUESTIONS);
		assert.ok(teammateWakes(pi.sent)[0].content.includes('"Which checks should run?"'), teammateWakes(pi.sent)[0].content);

		await pi.call("team_answer", { request, answers: { "Which format should old configs load from?": "YAML", "Which checks should run?": ["lint", "test"] }, reason: "The Brief keeps YAML." });

		assert.deepEqual(await printed(hook), {
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: {
					behavior: "allow",
					updatedInput: {
						...FORMAT_QUESTIONS.tool_input,
						answers: { "Which format should old configs load from?": "YAML", "Which checks should run?": ["lint", "test"] },
					},
				},
			},
		});
	});

	it("logs the answers in the next Report's Decided for you, with the Task", async () => {
		const { pi, dir, request } = await asking(PUBLISH);
		await pi.call("team_answer", { request, decision: "allow", reason: "A dry run publishes nothing.", rule: "Bash(npm publish --dry-run)", grant: "dry-runs" });

		await pi.call("team_report", { headline: "builder-1 is renaming." });

		const report = readFileSync(join(dir, "reports", "001.md"), "utf8");
		for (const needed of ["## Decided for you", "allowed builder-1's `Bash`", "A dry run publishes nothing.", "added session rule `Bash(npm publish --dry-run)` for builder-1", "used grant `dry-runs` for builder-1's `Bash` (Task `rename-key`)"]) {
			assert.ok(report.includes(needed), `reports/001.md doesn't say ${needed}:\n${report}`);
		}
	});

	it("journals the hook's kill as denied in the terminal, then a PostToolUse as answered there, refusing the Lead's answer after either", async () => {
		const { pi, dir, request, hook } = await asking(PUBLISH);

		hook.terminate();
		await until(() => journalled(dir, "denied-in-terminal"), "the killed hook journals it");

		await assert.rejects(pi.call("team_answer", { request, decision: "allow", reason: "ok" }), /already answered: the human denied it in builder-1's terminal/);
		const ran = { session_id: "c0ffee12-0000-4000-8000-000000000001", hook_event_name: "PostToolUse", ...PUBLISH, tool_response: { stdout: "" } };
		appendFileSync(join(dir, "teammates", "builder-1", "events.jsonl"), `${JSON.stringify({ from: "hook", at: NOW.toISOString(), event: "PostToolUse", payload: ran })}\n`);
		await assert.rejects(pi.call("team_answer", { request, decision: "allow", reason: "ok" }), /already answered: the human answered it in builder-1's terminal/);
	});

	it("leaves a request its hook gave up on to the terminal: refused to the Lead, and a `/team pending` item that attaches", async () => {
		const { pi, dir, request, hook } = await asking(PUBLISH, { holdMs: 300 });

		await until(() => effortLines(dir).some((line) => line.type === "request-settled" && line.how === "expired"), "the hook's hold runs out");
		await until(() => hook.exitCode() !== undefined, "the hook exits");
		assert.deepEqual([hook.exitCode(), hook.output()], [0, ""]);
		await assert.rejects(pi.call("team_answer", { request, decision: "allow", reason: "ok" }), /only the human can answer it now, in builder-1's terminal/);
		assert.equal(JSON.parse(await pi.call("team_status", {})).waitingOnYou, 1);

		pi.answer("Attach to builder-1", "Attach here");
		await pi.team("pending");

		assert.deepEqual(pi.dialogs.slice(-2), [
			{
				kind: "select",
				title: `\`${request}\` waited past its hook's hold: answer builder-1's \`Bash\` prompt in builder-1's terminal (\`/team attach builder-1\`)`,
				options: ["Attach to builder-1", "Later"],
				answer: "Attach to builder-1",
			},
			{ kind: "select", title: "builder-1 (c0ffee12)", options: ["Attach here", "Copy the command"], answer: "Attach here" },
		]);
		assert.deepEqual(
			pi.claude.attaches().map((attach) => attach.argv),
			[["attach", "c0ffee12"]],
		);
	});

	it("refuses a request no hook holds, naming the ones that are", async () => {
		const { pi, request } = await asking(PUBLISH);

		await assert.rejects(pi.call("team_answer", { request: "req-00000000", decision: "allow", reason: "ok" }), new RegExp(`No request \`req-00000000\` waits on you.*\`${request}\``, "s"));
		await assert.rejects(pi.call("team_answer", { request, decision: "maybe", reason: "ok" }), /`decision` is `allow` or `deny`/);
	});
});

describe("escalating to the human: team_escalate and /team pending", () => {
	afterEach(() => {
		for (const fake of holding.splice(0)) fake.release();
	});

	it("moves a held permission to /team pending, where only the human's answer reaches the hook, and wakes the Lead with it", async () => {
		const { pi, request, hook } = await asking(PUBLISH);

		const reply = await pi.call("team_escalate", { request, summary: "Publishing is outside the Brief." });

		assert.match(reply, /Only Task `rename-key` waits on it/);
		assert.equal(JSON.parse(await pi.call("team_status", {})).waitingOnYou, 1);
		await assert.rejects(pi.call("team_answer", { request, decision: "allow", reason: "The human said so." }), /only the human can answer it, in `\/team pending`/);
		assert.equal(hook.exitCode(), undefined, "the hook still holds");

		pi.answer("Deny", "Not this release.");
		await pi.team("pending");

		const [asked, why] = pi.dialogs.slice(-2);
		assert.deepEqual([asked.kind, asked.options, why.kind], ["select", ["Allow", "Deny", "Later"], "input"]);
		for (const needed of [request, "builder-1's `Bash` prompt on Task `rename-key`", "npm publish --dry-run", "Publishing is outside the Brief."]) assert.ok(asked.title.includes(needed), asked.title);
		assert.deepEqual(await printed(hook), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Not this release." } } });
		const woken = pi.sent.at(-1);
		assert.equal(woken?.customType, "team-pending");
		assert.match(woken?.content ?? "", new RegExp(`The human denied \`${request}\`.*Not this release\\.`));
		assert.equal(JSON.parse(await pi.call("team_status", {})).waitingOnYou, 0);
	});

	it("shows the human the whole multi-line command an escalated permission would run, not its first line (#122)", async () => {
		const script = ["set -euo pipefail", "npm version patch", "npm publish", "git push --follow-tags"].join("\n");
		const { pi, request, hook } = await asking({ tool_name: "Bash", tool_input: { command: script, description: "Release" } });
		await pi.call("team_escalate", { request, summary: "Publishing is outside the Brief." });

		pi.answer("Deny", "Not this release.");
		await pi.team("pending");

		const [asked] = pi.dialogs.slice(-2);
		assert.equal(asked.kind, "select");
		assert.ok(asked.title.includes(script), asked.title);
		await printed(hook);
	});

	it("asks the human an escalated AskUserQuestion's own options, and keeps the answer in clarifications.md beside an unchanged brief.md", async () => {
		const { pi, dir, request, hook } = await asking(FORMAT_QUESTIONS);
		const brief = sha(readFileSync(join(dir, "brief.md")));
		await pi.call("team_escalate", { request, summary: "The Brief names no format.", brief: "AC1 only says the key is renamed." });

		pi.answer("YAML", "test", "lint", "Done");
		await pi.team("pending");

		assert.deepEqual(
			pi.dialogs.slice(-4).map((dialog) => dialog.options),
			[
				["YAML", "JSON", "Later"],
				["lint", "test", "build", "Later"],
				["lint", "build", "Done", "Later"],
				["build", "Done", "Later"],
			],
		);
		const answers = { "Which format should old configs load from?": "YAML", "Which checks should run?": ["lint", "test"] };
		assert.deepEqual(await printed(hook), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { ...FORMAT_QUESTIONS.tool_input, answers } } } });
		const clarifications = readFileSync(join(dir, "clarifications.md"), "utf8");
		for (const needed of [
			`## \`${request}\`: builder-1, Task \`rename-key\``,
			"- Lead's summary: The Brief names no format.",
			"- The Brief says: AC1 only says the key is renamed.",
			`- The human's answer (in \`/team pending\`): "Which format should old configs load from?": YAML; "Which checks should run?": lint, test`,
		]) {
			assert.ok(clarifications.includes(needed), clarifications);
		}
		assert.equal(sha(readFileSync(join(dir, "brief.md"))), brief);
		assert.equal(pi.sent.at(-1)?.customType, "team-pending");
	});

	it("takes the human's answer to an escalated question from chat through team_answer, as theirs in clarifications.md", async () => {
		const { pi, dir, request, hook } = await asking(FORMAT_QUESTIONS);
		await pi.call("team_escalate", { request, summary: "The Brief names no format." });

		const reply = await pi.call("team_answer", { request, answers: { "Which format should old configs load from?": "JSON", "Which checks should run?": ["build"] } });

		assert.match(reply, /clarifications\.md/);
		assert.equal(((await printed(hook)) as { hookSpecificOutput: { decision: { behavior: string } } }).hookSpecificOutput.decision.behavior, "allow");
		assert.ok(readFileSync(join(dir, "clarifications.md"), "utf8").includes("- The human's answer (in chat, relayed by the Lead): "));
	});

	it("leaves an escalated item for later, still waiting on the human", async () => {
		const { pi, request, hook } = await asking(PUBLISH);
		await pi.call("team_escalate", { request, summary: "Publishing is outside the Brief." });

		pi.answer("Later");
		await pi.team("pending");

		assert.equal(hook.exitCode(), undefined);
		assert.equal(JSON.parse(await pi.call("team_status", {})).waitingOnYou, 1);
	});

	it("escalates a stopped-short Teammate's prose question: the human's words go to its inbox and into clarifications.md", async () => {
		const { pi, dir } = await crewApproved({
			hooks: [
				{ event: "SessionStart", payload: { source: "startup" } },
				{ event: "Stop", payload: { last_assistant_message: "Should the old key keep working for a release?" } },
			],
			replies: [],
		});
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		await until(() => effortLines(dir).some((line) => line.type === "teammate-stopped"), "builder-1 stops short");

		const reply = await pi.call("team_escalate", { teammate: "builder-1", question: "Should the old key keep working for a release?", summary: "Deprecation isn't in the Brief." });
		assert.match(reply, /`q1`/);

		pi.answer("Yes, for one release.");
		await pi.team("pending");

		const asked = pi.dialogs.at(-1);
		assert.equal(asked?.kind, "input");
		assert.ok(asked?.title.includes("Should the old key keep working for a release?"), asked?.title);
		await until(() => pi.claude.inbox().length > 0, "the answer reached builder-1's inbox");
		const message = JSON.parse(pi.claude.inbox()[0].lines[1]) as { message: { content: string } };
		assert.match(message.message.content, /Yes, for one release\./);
		assert.match(message.message.content, /clarifications\.md/);
		assert.ok(readFileSync(join(dir, "clarifications.md"), "utf8").includes("## `q1`: builder-1, Task `rename-key`"));
		assert.equal(JSON.parse(await pi.call("team_status", {})).waitingOnYou, 0);
	});
});

describe("messaging a Teammate: team_send", () => {
	it("sends a short prose message to a Teammate's inbox, on record", async () => {
		const { pi, dir } = await renameReported({ replies: [] });

		const reply = await pi.call("team_send", { teammate: "builder-1", message: "Rename it in docs/config.md too." });

		assert.match(reply, /Sent builder-1/);
		await until(() => pi.claude.inbox().length > 0, "the message reached the inbox");
		const [connection] = pi.claude.inbox();
		assert.equal(connection.lines[1], JSON.stringify({ type: "user", message: { role: "user", content: "Rename it in docs/config.md too." } }));
		assert.equal(effortLines(dir).filter((line) => line.type === "message-sent").length, 1);
	});

	it("refuses a Teammate the Effort doesn't have, sending nothing", async () => {
		const { pi } = await renameReported({ replies: [] });

		await assert.rejects(pi.call("team_send", { teammate: "qa-1", message: "hi" }), /no Teammate `qa-1`/);
		assert.deepEqual(pi.claude.inbox(), []);
	});
});

/** {@link CREW_PLAYBOOK} with a grant that lets the Lead allow a push of the Effort's branch. */
const FLOOR_PLAYBOOK = CREW_PLAYBOOK.replace("permissions:\n", "permissions:\n  grants:\n    - id: push-effort-branch\n      allow: Push the Effort's branch to origin, never with force.\n");

/**
 * An approved crew Effort on {@link FLOOR_PLAYBOOK}, whose Brief adds the
 * grant `open-pr`, and whose `builder-1` runs each of `commands` in Bash: the
 * floor hook makes each floor one a prompt, and the fake plays the held
 * `PermissionRequest` that follows, as Claude Code does. Waits until `floors`
 * requests are held. `roots` are the temp folders to use, when a command names one,
 * and `sessionId` the session's id, whose first eight characters are its short id.
 */
async function floorAsking(commands: string[], floors = commands.length, roots?: TempRoots, sessionId = "c0ffee12-0000-4000-8000-000000000001") {
	const crew = await crewApproved({
		roots,
		playbook: FLOOR_PLAYBOOK,
		overrides: ["overrides:", "  - rule: open-pr", '    change: "add grant: open the pull request the Delivery asks for"', "    reason: The human reviews every change as a PR."],
		hooks: [
			{ event: "SessionStart", payload: { source: "startup", session_id: sessionId } },
			{ event: "UserPromptSubmit", payload: { prompt: "New Task `rename-key`" } },
			...commands.map((command): FakeHookStep => ({ event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command } } })),
		],
	});
	holding.push(crew.pi.claude);
	await crew.pi.call("team_plan", { tasks: CREW_PLAN });
	await crew.pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
	const held = () => effortLines(crew.dir).filter((line) => line.type === "request-held");
	await until(() => held().length === floors, "the Lead holds a request for each floor command");
	const request = (command: string): string => {
		const found = held().find((line) => (line as { input?: { command?: unknown } }).input?.command === command);
		assert.ok(found, `no request holds \`${command}\``);
		return String(found.request);
	};
	return { ...crew, request };
}

describe("the floor: irreversible outward actions reach the human", () => {
	afterEach(() => {
		for (const fake of holding.splice(0)) fake.release();
	});

	it("holds a floor command the hook asks about, and takes an allow only citing a Playbook grant, a Brief override grant or the Delivery, logging each", async () => {
		const { pi, dir, request } = await floorAsking(["git push origin HEAD", "gh pr create --fill", "git -C . push origin HEAD:refs/heads/review", "npm test"], 3);
		const push = request("git push origin HEAD");

		await assert.rejects(pi.call("team_answer", { request: push, decision: "allow", reason: "The Delivery wants a branch." }), (error: Error) => {
			assert.match(error.message, /floor push `git push origin HEAD`/);
			assert.match(error.message, /`push-effort-branch`, `open-pr`, `delivery`/);
			assert.match(error.message, /team_escalate/);
			return true;
		});
		await pi.call("team_answer", { request: push, decision: "allow", reason: "The Effort's branch, no force.", grant: "push-effort-branch" });
		await pi.call("team_answer", { request: request("gh pr create --fill"), decision: "allow", reason: "The PR the human reviews.", grant: "open-pr" });
		await pi.call("team_answer", { request: request("git -C . push origin HEAD:refs/heads/review"), decision: "allow", reason: "One branch, ready to merge.", grant: "delivery" });

		for (const hook of pi.claude.held()) {
			await until(() => hook.exitCode() !== undefined, "each held hook exits");
			assert.deepEqual(JSON.parse(hook.output() ?? ""), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
		}
		await pi.call("team_report", { headline: "builder-1 delivered." });
		const report = readFileSync(join(dir, "reports", "001.md"), "utf8");
		for (const needed of [
			"used grant `push-effort-branch` (Playbook: Push the Effort's branch to origin, never with force.) for builder-1's floor push `git push origin HEAD` (Task `rename-key`)",
			"used grant `open-pr` (Brief override: open the pull request the Delivery asks for) for builder-1's floor send `gh pr create --fill` (Task `rename-key`)",
			"used the Brief's Delivery (One branch, ready to merge.) for builder-1's floor push `git -C . push origin HEAD:refs/heads/review` (Task `rename-key`)",
		]) {
			assert.ok(report.includes(needed), `reports/001.md doesn't say ${needed}:\n${report}`);
		}
	});

	it("keeps a request an escalate entry asks about from the Lead's allow, cited or not, and takes its deny", async () => {
		const { pi, request } = await floorAsking(["git push --force origin HEAD"]);
		const force = request("git push --force origin HEAD");

		await assert.rejects(
			pi.call("team_answer", { request: force, decision: "allow", reason: "A tidy history.", grant: "push-effort-branch" }),
			/`escalate` entry `history-rewrite`.*`team_escalate`/s,
		);
		await pi.call("team_answer", { request: force, decision: "deny", reason: "Rewriting history is the human's call." });
	});

	it("takes an uncited allow of a delete in the Teammate's own job temp folder, by its short id, but not in another session's", async () => {
		const roots = tempRoots();
		const own = `rm -f ${join(roots.claudeDir, "jobs", "c0ffee12", "tmp", "x")}`;
		const other = `rm -f ${join(roots.claudeDir, "jobs", "deadbeef", "tmp", "x")}`;
		const { pi, request } = await floorAsking([own, other], 2, roots);

		await pi.call("team_answer", { request: request(own), decision: "allow", reason: "Its own scratch file." });
		await assert.rejects(pi.call("team_answer", { request: request(other), decision: "allow", reason: "A scratch file." }), /floor delete/);
	});

	it("adds no job temp folder for a short id that isn't one plain path segment", async () => {
		const roots = tempRoots();
		// The short id `../../xy` would name `<claude dir>/../xy/tmp`.
		const escaped = `rm -f ${join(roots.claudeDir, "..", "xy", "tmp", "x")}`;
		const { pi, request } = await floorAsking([escaped], 1, roots, "../../xy-0000-4000-8000-000000000001");

		await assert.rejects(pi.call("team_answer", { request: request(escaped), decision: "allow", reason: "A scratch file." }), /floor delete/);
	});

	it("takes no grant from a Brief changed since approval: team_answer and team_report refuse, and the human is told", async () => {
		const { pi, dir, request } = await floorAsking(["git push --force origin HEAD"]);
		const force = request("git push --force origin HEAD");
		const brief = join(dir, "brief.md");
		const tampered = readFileSync(brief, "utf8").replace("overrides:", ["overrides:", "  - rule: anything", '    change: "add grant: push anything"', "    reason: Written past the human."].join("\n"));
		writeFileSync(brief, tampered);

		for (const call of [
			() => pi.call("team_answer", { request: force, decision: "allow", reason: "The Brief grants it.", grant: "anything" }),
			() => pi.call("team_report", { headline: "Pushed." }),
		]) {
			await assert.rejects(call(), (error: Error) => {
				assert.ok(error.message.includes(`${brief} has sha256 ${sha(tampered)}`), error.message);
				return true;
			});
			assert.equal(pi.notifications.at(-1)?.type, "error");
		}
	});
});

describe("reviewing: team_review", () => {
	it("refuses a review while there is no new result for the round, and changes nothing", async () => {
		const { pi, dir } = await renameReported({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }] });
		const plan = readFileSync(join(dir, "plan.md"), "utf8");

		await assert.rejects(pi.call("team_review", { slug: "rename-key", verdict: "accept" }), (error: Error) => {
			assert.match(error.message, /Task `rename-key` has no new result to review/);
			assert.ok(error.message.includes(join(dir, RENAME_RESULT)), error.message);
			return true;
		});
		assert.equal(readFileSync(join(dir, "plan.md"), "utf8"), plan);
		assert.deepEqual(readdirSync(join(dir, RENAME_DIR)).sort(), ["task.md"]);
	});

	it("accepts a written result: plan.md shows it accepted, nothing reaches the Teammate, and the Task is never handed off or reviewed again", async () => {
		const { pi, dir } = await renameReported();

		const reply = await pi.call("team_review", { slug: "rename-key", verdict: "accept" });

		assert.match(reply, /^Accepted Task `rename-key` at round 1/);
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## rename-key\n[\s\S]*?- Status: accepted, with `builder-1` \(tasks\/001-builder-rename-key\/\)/);
		assert.deepEqual(pi.claude.inbox(), []);
		await assert.rejects(pi.call("team_handoff", { slug: "rename-key", body: "# Again\n" }), /Task `rename-key` is accepted/);
		await assert.rejects(pi.call("team_review", { slug: "rename-key", verdict: "accept" }), /already accepted/);
		assert.equal(readFileSync(join(dir, RENAME_DIR, "task.md"), "utf8"), "# Rename\n");
	});

	it("sends a Task back: writes feedback-1.md, sends the Teammate a pointer to it after the auth line and no clear, and wakes the Lead on result-2.md", async () => {
		const { pi, dir } = await renameReported();
		const [session] = effortLines(dir).filter((line) => line.type === "teammate-session");
		const inbox = session.inbox as { socket: string; token: string };
		const result1 = readFileSync(join(dir, RENAME_RESULT), "utf8");

		const reply = await pi.call("team_review", { slug: "rename-key", verdict: "send_back", feedback: "Also rename it in docs/config.md." });

		assert.match(reply, /Sent Task `rename-key` back to `builder-1` \(send-back 1 of 2\)/);
		const feedback = join(dir, RENAME_DIR, "feedback-1.md");
		assert.match(readFileSync(feedback, "utf8"), /Also rename it in docs\/config\.md\./);
		await until(() => pi.claude.inbox().length > 0, "the pointer reached the inbox");
		const [connection, ...more] = pi.claude.inbox();
		assert.deepEqual(more, []);
		assert.equal(connection.socket, inbox.socket);
		assert.equal(connection.authorized, true);
		assert.equal(connection.lines.length, 2, "an auth line and one message: no clear");
		assert.equal(connection.lines[0], JSON.stringify({ type: "auth", token: inbox.token }));
		const message = JSON.parse(connection.lines[1]) as { type: string; message: { role: string; content: string } };
		assert.equal(message.type, "user");
		assert.equal(message.message.role, "user");
		const pointer = message.message.content;
		assert.equal(connection.lines[1], JSON.stringify({ type: "user", message: { role: "user", content: pointer } }));
		assert.ok(pointer.includes(feedback), pointer);
		assert.ok(pointer.includes(join(dir, RENAME_DIR, "result-2.md")), pointer);
		assert.ok(!pointer.includes("docs/config.md"), "the pointer points at the feedback rather than carrying it");
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /- Status: sent back, with `builder-1`/);

		await until(() => teammateWakes(pi.sent).length === 2, "the Lead is woken on round 2's result");
		assert.ok(teammateWakes(pi.sent)[1].content.includes(join(dir, RENAME_DIR, "result-2.md")), teammateWakes(pi.sent)[1].content);
		assert.equal(pi.claude.launches().length, 1, "the same session works round 2");
		assert.deepEqual(readdirSync(join(dir, RENAME_DIR)).sort(), ["feedback-1.md", "result-1.md", "result-2.md", "task.md"]);
		assert.equal(readFileSync(join(dir, RENAME_RESULT), "utf8"), result1);
		await assert.rejects(pi.call("team_handoff", { slug: "rename-key", body: "# Again\n" }), /`team_review` sends it back/);
	});

	it("refuses a third send-back at the Playbook's sendBackLimit of 2, telling the Lead to escalate, and keeps every round's files", async () => {
		const { pi, dir } = await renameReported();
		for (const round of [1, 2]) {
			await pi.call("team_review", { slug: "rename-key", verdict: "send_back", feedback: `Round ${round} is not there yet.` });
			await until(() => teammateWakes(pi.sent).length === round + 1, `round ${round + 1}'s result wakes the Lead`);
		}

		await assert.rejects(pi.call("team_review", { slug: "rename-key", verdict: "send_back", feedback: "Still not." }), (error: Error) => {
			assert.match(error.message, /sent back 2 times, the Playbook's `sendBackLimit` of 2/);
			assert.match(error.message, /Escalate to the human/);
			return true;
		});
		assert.equal(pi.claude.inbox().length, 2);
		assert.deepEqual(readdirSync(join(dir, RENAME_DIR)).sort(), ["feedback-1.md", "feedback-2.md", "result-1.md", "result-2.md", "result-3.md", "task.md"]);
		assert.match(readFileSync(join(dir, RENAME_DIR, "feedback-1.md"), "utf8"), /Round 1 is not there yet\./);
		assert.match(readFileSync(join(dir, RENAME_DIR, "feedback-2.md"), "utf8"), /Round 2 is not there yet\./);
		assert.match(await pi.call("team_review", { slug: "rename-key", verdict: "accept" }), /Accepted Task `rename-key` at round 3/);
	});

	it("refuses a send-back whose feedback file is already there, overwriting and sending nothing", async () => {
		const { pi, dir } = await renameReported();
		const feedback = join(dir, RENAME_DIR, "feedback-1.md");
		writeFileSync(feedback, "someone else's\n");

		await assert.rejects(pi.call("team_review", { slug: "rename-key", verdict: "send_back", feedback: "Redo it." }), /feedback-1\.md is already there/);

		assert.equal(readFileSync(feedback, "utf8"), "someone else's\n");
		assert.deepEqual(pi.claude.inbox(), []);
		assert.equal(effortLines(dir).filter((line) => line.type === "task-sent-back").length, 0);
	});

	it("resumes the Teammate's session with the pointer when its inbox refuses the send, and works round 2 there", async () => {
		const { pi, dir } = await renameReported();
		const [session] = effortLines(dir).filter((line) => line.type === "teammate-session");
		pi.claude.refuseSends(BUILDER_1);

		await pi.call("team_review", { slug: "rename-key", verdict: "send_back", feedback: "Redo it." });

		const resume = pi.claude.calls().find((argv) => argv.includes("--resume")) ?? [];
		assert.deepEqual(resume.slice(0, 3), ["--bg", "--resume", session.sessionId]);
		assert.ok(resume[3]?.includes(join(dir, RENAME_DIR, "feedback-1.md")), resume.join(" "));
		await until(() => teammateWakes(pi.sent).length === 2, "the Lead is woken on round 2's result");
		assert.ok(existsSync(join(dir, RENAME_DIR, "result-2.md")));
	});

	it("tells the Lead to stop and tell the human when the pointer can't reach the Teammate and its session can't be resumed", async () => {
		const { pi, dir } = await renameReported();
		pi.claude.forget(BUILDER_1);

		await assert.rejects(pi.call("team_review", { slug: "rename-key", verdict: "send_back", feedback: "Redo it." }), (error: Error) => {
			assert.match(error.message, /couldn't reach `builder-1`/);
			assert.match(error.message, /tell the human/);
			return true;
		});
		assert.match(readFileSync(join(dir, RENAME_DIR, "feedback-1.md"), "utf8"), /Redo it\./);
	});
});

describe("a Teammate's lifecycle", () => {
	it("leaves an idle-stopped Teammate stopped until a send, which resumes its session with the pointer; the next send goes to its new socket", async () => {
		const { pi, dir } = await renameReported();
		const [session] = effortLines(dir).filter((line) => line.type === "teammate-session");
		pi.claude.idleStop(BUILDER_1);

		await pi.call("team_status", {});
		assert.ok(!pi.claude.calls().some((argv) => argv.includes("--resume")), "only a send wakes a Teammate");

		const reply = await pi.call("team_review", { slug: "rename-key", verdict: "send_back", feedback: "Also the docs." });

		assert.match(reply, /Sent Task `rename-key` back to `builder-1`/);
		const resume = pi.claude.calls().find((argv) => argv.includes("--resume")) ?? [];
		assert.deepEqual(resume.slice(0, 3), ["--bg", "--resume", session.sessionId]);
		assert.ok(resume[3]?.includes(join(dir, RENAME_DIR, "result-2.md")), resume.join(" "));
		assert.deepEqual(pi.claude.inbox(), [], "the pointer went with the resume");
		assert.equal(pi.claude.launches().length, 1, "the same session works round 2");
		await until(() => teammateWakes(pi.sent).length === 2, "the Lead is woken on round 2's result");
		const resumed = effortLines(dir).filter((line) => line.type === "teammate-session" && line.source === "resume");
		assert.equal(resumed.length, 1);
		const inbox = resumed[0].inbox as { socket: string; token: string };
		assert.notEqual(inbox.socket, (session.inbox as { socket: string }).socket);

		await pi.call("team_review", { slug: "rename-key", verdict: "send_back", feedback: "And the changelog." });

		await until(() => pi.claude.inbox().length === 1, "the pointer reached the new inbox");
		assert.equal(pi.claude.inbox()[0].socket, inbox.socket);
		assert.equal(pi.claude.inbox()[0].authorized, true);
		await until(() => teammateWakes(pi.sent).length === 3, "the Lead is woken on round 3's result");
		assert.equal(pi.claude.calls().filter((argv) => argv.includes("--resume")).length, 1);
	});

	it("wakes the Lead once when a Teammate's session crashes, and a send-back then starts another Teammate of the Role on the Task's folder", async () => {
		const { pi, dir } = await renameReported({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }, ...WORKS, { event: "SessionEnd", payload: { reason: "other" } }] });
		await until(() => teammateWakes(pi.sent).some((wake) => wake.content.includes("ended")), "the Lead is woken about the crash");
		const crashes = (): SentMessage[] => teammateWakes(pi.sent).filter((wake) => /`builder-1`'s session ended/.test(wake.content));
		assert.equal(crashes().length, 1);
		assert.match(crashes()[0].content, /round 1 of Task `rename-key`/);
		await pi.call("team_status", {});
		assert.equal(crashes().length, 1, "the crash wakes the Lead once");

		const reply = await pi.call("team_review", { slug: "rename-key", verdict: "send_back", feedback: "Also the docs." });

		assert.match(reply, /`builder-1` has ended, so this started `builder-2` on it/);
		const [first, second, ...more] = pi.claude.launches();
		assert.deepEqual(more, []);
		assert.ok(first);
		const name = second?.argv[second.argv.indexOf("--name") + 1];
		assert.equal(name, "team-crew-2026-11-02-builder-2");
		const pointer = second?.argv.at(-1) ?? "";
		for (const file of ["task.md", "result-1.md", "feedback-1.md", "result-2.md"]) assert.ok(pointer.includes(join(dir, RENAME_DIR, file)), pointer);
		await until(() => existsSync(join(dir, RENAME_DIR, "result-2.md")), "builder-2 writes round 2's result");
		await until(() => teammateWakes(pi.sent).some((wake) => wake.content.includes(join(dir, RENAME_DIR, "result-2.md"))), "the Lead is woken on round 2's result");
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /- Status: sent back, with `builder-2`/);
	});

	it("queues a send-back whose Teammate crashed while the Effort is at `maxTeammates`, and staffs it through the ladder once a Teammate frees up", async () => {
		const crash: FakeHookStep = { event: "SessionEnd", payload: { reason: "other" }, when: "New Task `rename-key`" };
		const { pi, dir } = await crewApproved({ settings: { maxTeammates: 1 }, hooks: [{ event: "SessionStart", payload: { source: "startup" } }, ...WORKS, crash], replies: WORKS });
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		await until(() => teammateWakes(pi.sent).some((wake) => /`builder-1`'s session ended/.test(wake.content)), "the Lead is woken about the crash");
		assert.match(await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" }), /started scout-1/);
		await until(() => existsSync(join(dir, "tasks", "002-scout-survey", "result-1.md")), "scout-1 writes its result");
		await until(() => teammateWakes(pi.sent).some((wake) => wake.content.includes("002-scout-survey/result-1.md")), "the Lead is woken on scout-1's result");

		const queued = await pi.call("team_review", { slug: "rename-key", verdict: "send_back", feedback: "Also the docs." });

		assert.match(queued, /`builder-1` has ended, and no Teammate can take it now \(cap 1 reached; waits for 002\), so it is queued/);
		assert.equal(pi.claude.launches().length, 2, "no Teammate starts past the cap");
		assert.ok(existsSync(join(dir, RENAME_DIR, "feedback-1.md")));
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## rename-key\n[\s\S]*?- Status: queued/);

		const accepted = await pi.call("team_review", { slug: "survey", verdict: "accept" });

		assert.match(accepted, /Queued Task `rename-key` started builder-2/);
		assert.match(accepted, /stopped idle `scout-1`/);
		const launches = pi.claude.launches();
		assert.equal(launches.length, 3);
		const pointer = launches[2]?.argv.at(-1) ?? "";
		for (const file of ["task.md", "result-1.md", "feedback-1.md", "result-2.md"]) assert.ok(pointer.includes(join(dir, RENAME_DIR, file)), pointer);
		await until(() => existsSync(join(dir, RENAME_DIR, "result-2.md")), "builder-2 writes round 2's result");
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## rename-key\n[\s\S]*?- Status: sent back, with `builder-2`/);
	});

	it("starts a Task queued at `maxTeammates` once a Teammate's crash frees room under the cap", async () => {
		const { pi } = await crewApproved({ settings: { maxTeammates: 1 }, hooks: [{ event: "SessionStart", payload: { source: "startup" } }, { event: "UserPromptSubmit" }], replies: WORKS });
		await pi.call("team_plan", { tasks: CREW_PLAN });
		assert.match(await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" }), /started builder-1/);
		assert.match(await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" }), /queued/);
		assert.equal(pi.claude.launches().length, 1);

		await pi.claude.terminal(BUILDER_1, [{ event: "SessionEnd", payload: { reason: "other" } }]);

		await until(() => pi.claude.launches().length === 2, "the queued Task starts once the crash frees room");
		await until(() => teammateWakes(pi.sent).some((wake) => /Queued Task `survey` started scout-1/.test(wake.content)), "the Lead hears the queued Task started");
	});

	it("drops a handed-off Task left out of a re-plan, stopping its Teammate with `claude stop` and listing it under Dropped in plan.md", async () => {
		const { pi, dir } = await renameReported();
		const [session] = effortLines(dir).filter((line) => line.type === "teammate-session");

		const replan = [
			{ slug: "rename-key-everywhere", role: "builder", goal: "Rename the key, docs too.", criteria: ["AC1"] },
			{ ...CREW_PLAN[1], dependsOn: ["rename-key-everywhere"] },
			CREW_PLAN[2],
		];

		const reply = await pi.call("team_plan", { tasks: replan });

		assert.match(reply, /Dropped Task `rename-key`, and stopped `builder-1` with `claude stop`/);
		assert.ok(pi.claude.calls().some((argv) => argv[0] === "stop" && argv[1] === session.shortId), JSON.stringify(pi.claude.calls()));
		assert.equal(pi.claude.agents().find((agent) => agent.name === BUILDER_1)?.live, false);
		await pi.call("team_status", {});
		assert.deepEqual(effortLines(dir).filter((line) => line.type === "teammate-crashed"), [], "the SessionEnd of its own `claude stop` is no crash");
		assert.deepEqual(effortLines(dir).filter((line) => line.type === "teammate-ended").map((line) => line.how), ["stopped"]);
		assert.ok(!teammateWakes(pi.sent).some((wake) => /session ended/.test(wake.content)), "nobody is woken about the stop");
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## Dropped\n+- rename-key: was with `builder-1` \(tasks\/001-builder-rename-key\/\)/);
		await assert.rejects(pi.call("team_review", { slug: "rename-key", verdict: "accept" }), /rename-key/);
	});

	it("starts a queued Task once a re-plan's drop stops the Teammate it waited for", async () => {
		const { pi, dir } = await crewApproved({ settings: { maxTeammates: 1 }, hooks: [{ event: "SessionStart", payload: { source: "startup" } }] });
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		assert.match(await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" }), /^queued Task `survey`/);

		const reply = await pi.call("team_plan", {
			tasks: [{ slug: "rename-key-everywhere", role: "builder", goal: "Rename the key, docs too.", criteria: ["AC1"] }, { ...CREW_PLAN[1], dependsOn: ["rename-key-everywhere"] }, CREW_PLAN[2]],
		});

		assert.match(reply, /Dropped Task `rename-key`, and stopped `builder-1`/);
		assert.match(reply, /Queued Task `survey` started scout-1 \(tasks\/002-scout-survey\/task\.md\)/);
		assert.equal(pi.claude.launches().length, 2);
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## survey\n[\s\S]*?- Status: running, with `scout-1`/);
	});

	it("gives each Teammate's status, state and what it waits for in `team_status`, as `claude agents --json` has them, and leaves out a Teammate that ended", async () => {
		const { pi } = await renameReported();
		pi.claude.setAgent(BUILDER_1, { state: "waiting", waitingFor: "permission" });
		const rows = async () => (JSON.parse(await pi.call("team_status", {})) as { teammates: Record<string, unknown>[] }).teammates;

		assert.deepEqual((await rows()).map((row) => row.agent), [{ status: "running", state: "waiting", waitingFor: "permission" }]);
		pi.claude.idleStop(BUILDER_1);
		assert.deepEqual((await rows()).map((row) => row.agent), ["missing"]);

		await pi.call("team_plan", {
			tasks: [{ slug: "rename-key-everywhere", role: "builder", goal: "Rename it, docs too.", criteria: ["AC1"] }, { ...CREW_PLAN[1], dependsOn: ["rename-key-everywhere"] }, CREW_PLAN[2]],
		});
		assert.deepEqual(await rows(), []);
	});
});

/** The crew plan with a second `builder` Task, which `builder-1` can be reused for once `rename-key` is accepted. */
const STAFF_PLAN = [...CREW_PLAN, { slug: "update-docs", role: "builder", goal: "Update the docs for the new key.", dependsOn: ["rename-key"] }];

/** The first handoff pointer of the Task in `folder`, written out from the spec rather than from the extension. */
function newTaskPointer(dir: string, slug: string, folder: string): string {
	return `New Task \`${slug}\`: read ${join(dir, "tasks", folder, "task.md")} and do what it asks. When it is done, write your result to ${join(dir, "tasks", folder, "result-1.md")}.`;
}

/** The content of the user message in an inbox connection's second line. */
function sentContent(connection: { lines: string[] }): string {
	return (JSON.parse(connection.lines[1] ?? "{}") as { message?: { content?: string } }).message?.content ?? "";
}

describe("staffing: the ladder and clearing between Tasks", () => {
	it("reuses idle `builder-1` for its Role's next Task: the clear marker, then SessionStart clear, then the pointer, recording the new session id under the same short id", async () => {
		const { pi, dir } = await crewApproved({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }, ...WORKS], replies: WORKS });
		await pi.call("team_plan", { tasks: STAFF_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		await pi.call("team_review", { slug: "rename-key", verdict: "accept" });
		const [first] = effortLines(dir).filter((line) => line.type === "teammate-session");

		const reply = await pi.call("team_handoff", { slug: "update-docs", body: "# Docs\n" });

		assert.match(reply, /^reused builder-1 on Task `update-docs` \(tasks\/002-builder-update-docs\/task\.md\)\. Its context is cleared first/);
		await until(() => teammateWakes(pi.sent).length === 2, "the Lead is woken on the new Task's result");
		assert.ok(teammateWakes(pi.sent)[1].content.includes(join(dir, "tasks", "002-builder-update-docs", "result-1.md")), teammateWakes(pi.sent)[1].content);
		assert.equal(pi.claude.launches().length, 1, "no new session starts");
		const inbox = pi.claude.inbox();
		assert.deepEqual(
			inbox.map((connection) => [connection.authorized, sentContent(connection)]),
			[
				[true, CLEAR_MARKER],
				[true, newTaskPointer(dir, "update-docs", "002-builder-update-docs")],
			],
		);
		const journal = readFileSync(join(dir, "teammates", "builder-1", "events.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { event: string; payload: { session_id: string; source?: string; reason?: string; prompt?: string } });
		assert.deepEqual(
			journal.slice(3).map(({ event, payload }) => [event, payload.source ?? payload.reason ?? payload.prompt ?? ""]),
			[
				["SessionEnd", "clear"],
				["SessionStart", "clear"],
				["UserPromptSubmit", newTaskPointer(dir, "update-docs", "002-builder-update-docs")],
				["Stop", ""],
			],
		);
		const sessions = effortLines(dir).filter((line) => line.type === "teammate-session");
		assert.equal(sessions.length, 2);
		assert.equal(sessions[1].source, "clear");
		assert.equal(sessions[1].sessionId, journal[4].payload.session_id);
		assert.notEqual(sessions[1].sessionId, first.sessionId);
		assert.equal(sessions[1].shortId, first.shortId);
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## update-docs\n[\s\S]*?- Status: running, with `builder-1` \(tasks\/002-builder-update-docs\/\)/);
	});

	it("starts an idle-stopped `builder-1` afresh for its Role's next Task, since a clear can't reach a session `claude agents --json` doesn't list", async () => {
		const { pi, dir } = await crewApproved({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }, ...WORKS], replies: WORKS });
		await pi.call("team_plan", { tasks: STAFF_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		await pi.call("team_review", { slug: "rename-key", verdict: "accept" });
		pi.claude.idleStop(BUILDER_1);

		const reply = await pi.call("team_handoff", { slug: "update-docs", body: "# Docs\n" });

		assert.match(reply, /^started builder-1 afresh on Task `update-docs` \(tasks\/002-builder-update-docs\/task\.md\)\. It had idle-stopped/);
		assert.equal(pi.claude.launches().length, 2);
		const argv = pi.claude.launches()[1]?.argv ?? [];
		assert.equal(argv[argv.indexOf("--name") + 1], BUILDER_1);
		assert.equal(argv.at(-1), newTaskPointer(dir, "update-docs", "002-builder-update-docs"));
		assert.deepEqual(pi.claude.inbox(), [], "no clear marker goes to a closed inbox");
		await until(() => teammateWakes(pi.sent).length === 2, "the Lead is woken on the new Task's result");
		assert.equal(effortLines(dir).filter((line) => line.type === "teammate-started").length, 1, "the id is kept");
	});

	it("tells the human once when pi's `maxTeammates` isn't a whole number of 1 or more, and staffs under the default of 3", async () => {
		const { pi } = await crewApproved({ settings: { maxTeammates: "1" }, hooks: [{ event: "SessionStart", payload: { source: "startup" } }] });
		await pi.call("team_plan", { tasks: STAFF_PLAN });

		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" });

		assert.equal(pi.claude.launches().length, 2);
		const told = pi.notifications.filter((each) => each.message.includes("maxTeammates"));
		assert.deepEqual(told, [{ message: 'pi\'s `maxTeammates` setting is "1", which isn\'t a whole number of 1 or more, so the default of 3 live Teammates is used. Fix it in pi\'s settings and `/reload`.', type: "error" }]);
	});

	it("queues a Task at pi's `maxTeammates`, saying why in the reply and the Team block, and starts it when an acceptance frees room", async () => {
		const { pi, dir } = await crewApproved({ settings: { maxTeammates: 1 }, hooks: [{ event: "SessionStart", payload: { source: "startup" } }, ...WORKS], replies: WORKS });
		await pi.call("team_plan", { tasks: STAFF_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });

		const reply = await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" });

		assert.match(reply, /^queued Task `survey` \(tasks\/002-scout-survey\/task\.md\): cap 1 reached; waits for 001\./);
		assert.equal(pi.claude.launches().length, 1);
		assert.equal(readFileSync(join(dir, "tasks", "002-scout-survey", "task.md"), "utf8"), "# Survey\n");
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## survey\n[\s\S]*?- Status: queued\n/);
		assert.ok(
			(teamBlock(pi) ?? []).some((line) => line.includes("queued  002-scout-survey (scout): cap 1 reached; waits for 001")),
			(teamBlock(pi) ?? []).join("\n"),
		);
		await assert.rejects(pi.call("team_handoff", { slug: "survey", body: "# Again\n" }), /already queued/);
		const [session] = effortLines(dir).filter((line) => line.type === "teammate-session");

		const accepted = await pi.call("team_review", { slug: "rename-key", verdict: "accept" });

		assert.match(accepted, /^Accepted Task `rename-key` at round 1/);
		assert.match(accepted, /Queued Task `survey` started scout-1 \(tasks\/002-scout-survey\/task\.md\)\. It stopped idle `builder-1`/);
		assert.deepEqual(
			pi.claude.calls().filter((call) => call[0] === "stop"),
			[["stop", session.shortId]],
		);
		assert.equal(pi.claude.launches().length, 2);
		// The stopped Teammate's SessionEnd lands while the swap is under way: it frees no room the swap hasn't taken already.
		await new Promise((resolve) => setTimeout(resolve, 300));
		await pi.call("team_status", {});
		assert.equal(pi.claude.launches().length, 2, "the queued Task starts once, within the cap");
		assert.deepEqual(effortLines(dir).filter((line) => line.type === "teammate-started").map((line) => line.id), ["builder-1", "scout-1"]);
		assert.deepEqual(effortLines(dir).filter((line) => line.type === "teammate-crashed"), []);
		assert.ok(!teammateWakes(pi.sent).some((wake) => /session ended/.test(wake.content)), "nobody is woken about the stop");
		assert.equal(pi.claude.launches()[1].argv.at(-1), newTaskPointer(dir, "survey", "002-scout-survey"));
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## survey\n[\s\S]*?- Status: [a-z ]+, with `scout-1` \(tasks\/002-scout-survey\/\)/);
		assert.ok(!(teamBlock(pi) ?? []).some((line) => line.startsWith("│ builder-1")), "a stopped Teammate leaves the block");
	});
});

/** `builder-1` takes `rename-key`'s pointer in session `c0ffee12`, then the human types a prompt of their own in its terminal. */
const TAKEN: FakeHookStep[] = [
	{ event: "SessionStart", payload: { source: "startup", session_id: "c0ffee12-0000-4000-8000-000000000001" } },
	{ event: "UserPromptSubmit" },
	{ mod: "prompt.submit", input: { text: "Use snake_case for the new key.", origin: { kind: "composer" } } },
];
const TAKEOVER_MARKER = join("teammates", "builder-1", "takeover");
const HANDBACK_TITLE = "Hand `builder-1` back to the Lead?";
const HANDBACK_TEXT =
	"Any send held for it while you had it is dropped, and the Lead reviews what you did in its terminal like any result. The next new Task it gets starts with a clear of its context.";

/** An approved crew Effort on {@link STAFF_PLAN} whose `builder-1`, handed `rename-key`, the human has taken over in its terminal. */
async function takenOver() {
	const crew = await crewApproved({ hooks: TAKEN, replies: WORKS });
	await crew.pi.call("team_plan", { tasks: STAFF_PLAN });
	await crew.pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
	await until(() => effortLines(crew.dir).some((line) => line.type === "takeover-started"), "the Lead records the Takeover");
	await until(() => teammateWakes(crew.pi.sent).some((wake) => wake.content.includes("The human took over `builder-1`")), "the Lead is woken about the Takeover");
	crew.pi.dialogs.length = 0;
	crew.pi.notifications.length = 0;
	return crew;
}

describe("taking a Teammate over: the human at its terminal", () => {
	it("holds the Lead's sends and the result while the human has `builder-1`, then the mod's `/handback` ends it with a summary wake, and the next new Task clears it", async () => {
		const { pi, dir } = await takenOver();

		assert.ok(existsSync(join(dir, TAKEOVER_MARKER)), "the hook's takeover marker is written");
		assert.deepEqual(effortLines(dir).find((line) => line.type === "takeover-started")?.trigger, { kind: "prompt" });
		const sendReply = await pi.call("team_send", { teammate: "builder-1", message: "Rename it in docs/config.md too." });
		assert.match(sendReply, /held/);
		assert.deepEqual(pi.claude.inbox(), [], "a held send reaches no inbox");
		writeFileSync(join(dir, RENAME_RESULT), "Renamed by hand.\n");
		await pi.claude.terminal(BUILDER_1, [{ event: "Stop", payload: { last_assistant_message: "Done." } }]);
		await until(() => journalled(dir, "Stop"), "the Stop is journalled");
		await assert.rejects(pi.call("team_review", { slug: "rename-key", verdict: "accept" }), /taken `builder-1` over/);
		assert.ok(!effortLines(dir).some((line) => line.type === "task-done"), "a Stop during a Takeover isn't done");

		await pi.claude.terminal(BUILDER_1, [{ mod: "command.run", input: { command: "handback", args: "renamed by hand", origin: { kind: "composer" } } }]);

		await until(() => effortLines(dir).some((line) => line.type === "takeover-ended"), "the Lead records the hand-back");
		const ended = effortLines(dir).find((line) => line.type === "takeover-ended");
		assert.equal(ended?.by, "terminal");
		assert.equal(ended?.note, "renamed by hand");
		assert.ok(effortLines(dir).some((line) => line.type === "task-done" && line.slug === "rename-key"), "the result written meanwhile is done at the hand-back");
		assert.ok(!existsSync(join(dir, TAKEOVER_MARKER)), "the marker is removed");
		await until(() => teammateWakes(pi.sent).some((wake) => wake.content.includes("handed `builder-1` back from its terminal")), "the Lead is woken at the hand-back");
		const summary = teammateWakes(pi.sent).find((wake) => wake.content.includes("handed `builder-1` back"))?.content ?? "";
		for (const part of ['"Use snake_case for the new key."', '"Rename it in docs/config.md too."', "Their note: renamed by hand", join(dir, RENAME_RESULT)]) {
			assert.ok(summary.includes(part), `the summary has ${part}:\n${summary}`);
		}
		assert.match(await pi.call("team_review", { slug: "rename-key", verdict: "accept" }), /^Accepted Task `rename-key`/);

		await pi.call("team_handoff", { slug: "update-docs", body: "# Docs\n" });

		await until(() => pi.claude.inbox().length === 2, "the clear and the pointer reach the inbox");
		assert.deepEqual(pi.claude.inbox().map(sentContent), [CLEAR_MARKER, newTaskPointer(dir, "update-docs", "002-builder-update-docs")]);
	});

	it("`/team handback` asks first, then ends the Takeover in pi, dropping the held send and waking the Lead with the note", async () => {
		const { pi, dir } = await takenOver();
		await pi.call("team_send", { teammate: "builder-1", message: "Rename it in docs/config.md too." });
		pi.answer(true);

		await pi.team("handback builder-1 done by hand");

		assert.deepEqual(pi.dialogs, [{ kind: "confirm", title: HANDBACK_TITLE, options: undefined, text: HANDBACK_TEXT, answer: true }]);
		assert.deepEqual(pi.notifications, [{ message: "Handed `builder-1` back: 1 held send is dropped, and the Lead reviews what you did.", type: "info" }]);
		const ended = effortLines(dir).find((line) => line.type === "takeover-ended");
		assert.equal(ended?.by, "pi");
		assert.equal(ended?.note, "done by hand");
		assert.ok(!existsSync(join(dir, TAKEOVER_MARKER)));
		const summary = teammateWakes(pi.sent).at(-1)?.content ?? "";
		assert.ok(summary.includes("handed `builder-1` back in pi"), summary);
		assert.ok(summary.includes("Their note: done by hand"), summary);
		assert.deepEqual(pi.claude.inbox(), [], "the held send is dropped, not sent");
	});

	it("`/team handback` changes nothing when the human declines", async () => {
		const { pi, dir } = await takenOver();
		pi.answer(false);

		await pi.team("handback builder-1");

		assert.equal(pi.dialogs.length, 1);
		assert.ok(!effortLines(dir).some((line) => line.type === "takeover-ended"));
		assert.ok(existsSync(join(dir, TAKEOVER_MARKER)));
	});

	it("`/team handback` refuses a Teammate nobody holds without asking, and names the taken-over ones when given none", async () => {
		const { pi } = await renameReported({ replies: [] });
		pi.dialogs.length = 0;
		pi.notifications.length = 0;

		await pi.team("handback builder-1");
		await pi.team("handback");

		assert.deepEqual(pi.dialogs, []);
		assert.deepEqual(pi.notifications, [
			{ message: "Nobody holds `builder-1`: it isn't taken over, so there is nothing to hand back.", type: "error" },
			{ message: "Name the Teammate to hand back: `/team handback <teammate> [note]`. Taken over now: none.", type: "error" },
		]);
	});

	it("the attach menu offers \"Hand back\" during a Takeover, which asks as `/team handback` does and records no attach", async () => {
		const { pi, dir } = await takenOver();
		pi.answer("Hand back", true);

		await pi.team("attach builder-1");

		assert.deepEqual(pi.dialogs, [
			{ kind: "select", title: "builder-1 (c0ffee12)", options: ["Attach here", "Copy the command", "Hand back"], answer: "Hand back" },
			{ kind: "confirm", title: HANDBACK_TITLE, options: undefined, text: HANDBACK_TEXT, answer: true },
		]);
		assert.deepEqual(pi.claude.attaches(), []);
		assert.deepEqual(attachedLines(dir), []);
		assert.equal(effortLines(dir).find((line) => line.type === "takeover-ended")?.by, "pi");
	});
});

describe("/team while the Lead is streaming", () => {
	it("runs setup and pending without waiting for the Lead to go idle", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots, { streaming: true });

		await requestAdoption(pi, roots, "software");
		pi.answer("Approve");
		await pi.team("pending");

		assert.equal(pi.sent[0].deliverAs, "followUp");
		assert.equal(existsSync(join(playbooksDir(roots), "software.md")), true);
	});
});

/** The Team block as last shown above the editor, or undefined once it was taken away. */
function teamBlock(pi: ReturnType<typeof fakePi>): string[] | undefined {
	const set = pi.widgets.filter((widget) => widget.key === "team");
	assert.ok(set.length > 0, "the extension never set the `team` widget");
	assert.ok(
		set.every((widget) => widget.placement === "aboveEditor"),
		"the Team block goes above the editor",
	);
	return set.at(-1)?.lines;
}

describe("the Team block", () => {
	it("shows above the editor once the session holds an Effort, and goes when the session ends", async () => {
		const { pi } = intakeSession();

		await pi.team("start software");

		assert.deepEqual(teamBlock(pi), [
			"╭─ Team · software · software-2026-11-02 ─ 0 live ─╮",
			"│ ● running  ·  intake                             │",
			"│ 5h n/a · week n/a  · no reading yet              │",
			"│ nothing waiting on you   reports 0               │",
			"╰──────────────────────────────────────────────────╯",
		]);

		await pi.emit("session_shutdown");

		assert.equal(teamBlock(pi), undefined);
	});

	it("rows a handed-off Teammate with the mode it got against the one it launched in, and `team_status` returns the block's data", async () => {
		const { pi } = await crewApproved({
			hooks: [
				{ event: "SessionStart", payload: { source: "startup", session_id: "c0ffee12-0000-4000-8000-000000000001", permission_mode: "acceptEdits" } },
				{ event: "UserPromptSubmit", payload: { prompt: "New Task `rename-key`", permission_mode: "auto" } },
			],
		});
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });

		assert.deepEqual(teamBlock(pi), [
			"╭─ Team · crew · crew-2026-11-02 ─────────────────────────────────── 1 live ─╮",
			"│ ● running  ·  working · 0/3 Tasks accepted                                 │",
			"│ 5h n/a · week n/a  · no reading yet                                        │",
			"│ builder-1  c0ffee12  busy  001-builder-rename-key  ctx —  auto≠acceptEdits │",
			"│ nothing waiting on you   reports 0   attach  /team                         │",
			"╰────────────────────────────────────────────────────────────────────────────╯",
		]);
		assert.deepEqual(JSON.parse(await pi.call("team_status", {})), {
			effortId: "crew-2026-11-02",
			team: "crew",
			phase: "working",
			tasks: { accepted: 0, planned: 3 },
			teammates: [
				{
					id: "builder-1",
					role: "builder",
					shortId: "c0ffee12",
					activity: "busy",
					task: "001-builder-rename-key",
					mode: "auto",
					launchMode: "acceptEdits",
					agent: { status: "running", state: "idle" },
				},
			],
			queued: [],
			waitingOnYou: 0,
			reports: 0,
		});
	});

	it("is never taller than pi's `maxTeammates` setting allows, counting the Teammates it has no row for", async () => {
		const settings = { maxTeammates: 3 };
		const { pi } = await crewApproved({ settings });
		await pi.call("team_plan", { tasks: CREW_PLAN });
		for (const slug of ["rename-key", "check-old-configs", "survey"]) await pi.call("team_handoff", { slug, body: `# ${slug}\n` });

		// The human lowers the setting and runs `/reload`, while three Teammates still live.
		settings.maxTeammates = 2;
		await pi.call("team_plan", { tasks: CREW_PLAN });

		const block = teamBlock(pi) ?? [];
		assert.equal(block.length, 7, block.join("\n"));
		assert.match(block[0], / 3 live ─╮$/);
		assert.match(block[2], /no reading yet/);
		assert.match(block[3], /^│ builder-1 /);
		assert.match(block[4], /^│ \+2 more Teammates +│$/);
	});
});

/** What a Teammate's status line gets on stdin: a subscription's, with the weekly window only. */
const STATUS_LINE = {
	context_window: { total_input_tokens: 410_000, total_output_tokens: 2_000, used_percentage: 21 },
	rate_limits: { seven_day: { used_percentage: 73, resets_at: Date.parse("2026-11-05T09:00:00.000Z") / 1000 } },
	cost: { total_cost_usd: 3.1 },
};

/** What `get_usage` answers for the same account a little later. */
const GET_USAGE = {
	subscription_type: "max",
	rate_limits_available: true,
	rate_limits: { five_hour: { utilization: 12, resets_at: "2026-11-02T13:00:00.000Z" }, seven_day: { utilization: 74, resets_at: "2026-11-05T09:00:00.000Z" } },
	session: { total_cost_usd: 0 },
};

/** The crew Effort with `rename-key` handed off to builder-1, whose status line has run once, `ago` ms before the clock. */
async function statusLineRan(ago: number, options: Pick<NonNullable<Parameters<typeof fakePi>[1]>, "sessionEntries"> = {}) {
	const crew = await crewApproved({
		hooks: [{ event: "SessionStart", payload: { source: "startup", session_id: "c0ffee12-0000-4000-8000-000000000001" } }, { statusLine: STATUS_LINE }],
		usage: GET_USAGE,
		...options,
	});
	await crew.pi.call("team_plan", { tasks: CREW_PLAN });
	await crew.pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
	const file = join(crew.dir, "teammates", "builder-1", "statusline.json");
	// The reading's time is the file's: set it against the test's clock.
	const taken = new Date(NOW.getTime() - ago);
	utimesSync(file, taken, taken);
	return { ...crew, file };
}

describe("usage readings", () => {
	it("reads each live Teammate's status line into the block once a minute while it shows, its context into the Teammate's row", async () => {
		const { pi, file } = await statusLineRan(12_000);
		// The real wrapper wrote it, run by the fake `claude` as Claude Code runs a status line.
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).rate_limits, STATUS_LINE.rate_limits);
		assert.deepEqual(pi.timers(), [60_000]);

		await pi.tick();

		const block = teamBlock(pi) ?? [];
		assert.match(block[2], /^│ 5h n\/a · week 73% ↻Thu 09:00  · builder-1's status line, 12s ago +│$/);
		assert.match(block[3], /^│ builder-1  c0ffee12  starting  001-builder-rename-key  ctx 21% /);
		assert.equal(pi.claude.usageCalls(), 0, "a status line under a minute old means no get_usage");
	});

	it("asks get_usage when no status line is under a minute old, at most once a minute", async () => {
		const { pi } = await statusLineRan(12_000);
		await pi.tick();

		pi.advance(50_000);
		await pi.tick();
		assert.equal(pi.claude.usageCalls(), 1);
		assert.match(teamBlock(pi)?.[2] ?? "", /^│ 5h 12% ↻13:00 · week 74% ↻Thu 09:00  · get_usage, 1s ago +│$/);

		pi.advance(30_000);
		await pi.tick();
		assert.equal(pi.claude.usageCalls(), 1, "asked again within the minute");

		pi.advance(30_000);
		await pi.tick();
		assert.equal(pi.claude.usageCalls(), 2);
	});

	it("asks get_usage with no Teammate live, and never once the block is gone", async () => {
		const roots = tempRoots();
		const { pi } = intakeSession(roots);
		pi.claude.setUsage(GET_USAGE);
		await pi.team("start software");

		await pi.tick();

		assert.equal(pi.claude.usageCalls(), 1);
		assert.match(teamBlock(pi)?.[2] ?? "", /^│ 5h 12% ↻13:00 · week 74% ↻Thu 09:00  · get_usage \(no Teammate live\), 1s ago +│$/);

		await pi.emit("session_shutdown");
		pi.advance(120_000);
		await pi.tick();
		assert.deepEqual(pi.timers(), []);
		assert.equal(pi.claude.usageCalls(), 1);
	});

	it("sets no timer and asks nothing in a session with no UI, where there is no block", async () => {
		const roots = tempRoots();
		const { pi } = intakeSession(roots, { hasUI: false });
		pi.claude.setUsage(GET_USAGE);
		await pi.team("start software");

		assert.deepEqual(pi.timers(), []);
		assert.equal(pi.claude.usageCalls(), 0);
	});

	it("gives the Report the account's usage, each Role's estimate from its status lines, and the Lead's own cost as pi reports it", async () => {
		const assistant = (total: number) => ({ type: "message", id: `m${total}`, message: { role: "assistant", usage: { cost: { total } } } });
		const { pi } = await statusLineRan(12_000, { sessionEntries: [assistant(0.25), assistant(0.18), { type: "message", id: "u1", message: { role: "user" } }] });

		const result = await pi.result("team_report", { headline: "Planned.", coverage: [{ criterion: "AC1", note: "`rename-key` covers it." }] });
		const markdown = (result.details as { markdown: string }).markdown;

		assert.match(markdown, /## Usage\n\n/);
		assert.match(markdown, /Account, from builder-1's status line at 09:59 UTC: 5h n\/a · week 73% \(\+0 since the Effort began\)/);
		assert.match(markdown, /By Role: builder 412k tokens ≈ \$3\.10\. \*API-price equivalent, not your bill\.\*/);
		assert.match(markdown, /The Lead: \$0\.43, as pi reports it\./);
		assert.equal(pi.claude.usageCalls(), 0, "the Report reads the status lines; it never asks get_usage");
	});
});

/** The crew Effort planned, its plan Report written, and `rename-key` handed off. */
async function crewReported() {
	const crew = await crewApproved({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }] });
	await crew.pi.call("team_plan", { tasks: CREW_PLAN });
	await crew.pi.call("team_report", { headline: "Planned three Tasks.", coverage: [{ criterion: "AC1", note: "`rename-key` covers it." }] });
	await crew.pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
	return crew;
}

describe("reporting: team_report", () => {
	it("writes the plan Report as reports/001.md with the logged sections, and tells the Lead only where it went", async () => {
		const { pi, dir } = await crewApproved();
		await pi.call("team_plan", { tasks: CREW_PLAN });

		const reply = await pi.call("team_report", {
			headline: "Planned three Tasks.",
			coverage: [
				{ criterion: "AC1", note: "`rename-key` covers it." },
				{ criterion: "AC2", note: "`check-old-configs` covers it." },
			],
		});

		assert.equal(reply, "Report 1 of Effort `crew-2026-11-02` is written as reports/001.md. The human sees it in chat, so don't repeat it.");
		const written = readFileSync(join(dir, "reports", "001.md"), "utf8");
		for (const needed of [
			"# Report 1 · Effort `crew-2026-11-02`",
			"Planned three Tasks.",
			"## Brief coverage",
			"- AC1: `rename-key` covers it.",
			"## Since the last Report",
			"planned 3 Tasks",
			"## Plan",
			"## Teammate modes",
			"- builder: acceptEdits",
			"- reviewer: dontAsk",
		]) {
			assert.ok(written.includes(needed), `reports/001.md doesn't say ${needed}:\n${written}`);
		}
		assert.equal(written.includes("## Waiting on you"), false, `an empty section is left out:\n${written}`);
		assert.equal(written.includes("## Playbook entries the Brief skips"), false, `a Brief that skips none leaves it out:\n${written}`);
	});

	it("lists in the plan Report each Playbook entry the Brief skips, with its reason, and in no later Report", async () => {
		const { pi, dir } = await crewApproved({ overrides: ["overrides:", "  - rule: small-diffs", "    change: skip", "    reason: The rename touches every file."] });
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await pi.call("team_report", { headline: "Planned three Tasks." });
		await pi.call("team_report", { headline: "Nothing has moved." });

		const first = readFileSync(join(dir, "reports", "001.md"), "utf8");
		assert.ok(first.includes("## Playbook entries the Brief skips\n\n- `small-diffs`: The rename touches every file."), first);
		const second = readFileSync(join(dir, "reports", "002.md"), "utf8");
		assert.equal(second.includes("Playbook entries the Brief skips"), false, second);
	});

	it("writes the next Report as reports/002.md, covering only what happened since the first", async () => {
		const { pi, dir } = await crewReported();

		await pi.call("team_report", { headline: "`rename-key` is with builder-1." });

		assert.deepEqual(readdirSync(join(dir, "reports")).sort(), ["001.md", "002.md"]);
		const second = readFileSync(join(dir, "reports", "002.md"), "utf8");
		assert.ok(second.includes("# Report 2"), second);
		assert.ok(second.includes("handed Task `rename-key` to builder-1"), second);
		assert.equal(second.includes("planned 3 Tasks"), false, second);
		assert.equal(second.includes("## Teammate modes"), false, second);
		assert.equal(second.includes("## Brief coverage"), false, `no coverage was given:\n${second}`);
	});

	it("shows in chat collapsed to its headline, and whole when expanded", async () => {
		const { pi } = await crewApproved();
		await pi.call("team_plan", { tasks: CREW_PLAN });

		const result = await pi.result("team_report", { headline: "Planned three Tasks.", coverage: [{ criterion: "AC1", note: "`rename-key` covers it." }] });

		const collapsed = pi.drawResult("team_report", result, false);
		assert.equal(collapsed.length, 1, collapsed.join("\n"));
		assert.match(collapsed[0], /Report 1 · Planned three Tasks\./);
		const expanded = pi.drawResult("team_report", result, true).join("\n");
		for (const needed of ["Planned three Tasks.", "AC1: `rename-key` covers it.", "Teammate modes", "builder: acceptEdits"]) {
			assert.ok(expanded.includes(needed), `the expanded Report doesn't say ${needed}:\n${expanded}`);
		}
	});

	it("is refused before the human approves the Brief, writing nothing", async () => {
		const { roots, pi } = intakeSession();
		await pi.team("start software");

		await assert.rejects(pi.call("team_report", { headline: "Nothing yet." }), /no approved Brief yet/);
		assert.equal(existsSync(join(effortDir(roots), "reports")), false);
	});

	it("counts the Reports in the Team block and in `team_status`", async () => {
		const { pi } = await crewReported();

		assert.match(teamBlock(pi)?.at(-2) ?? "", /reports 1 {2}\/team reports/);
		assert.equal(JSON.parse(await pi.call("team_status", {})).reports, 1);
	});
});

describe("/team report", () => {
	it("wakes the Lead to write a Report covering everything since the last one", async () => {
		const { pi } = await crewReported();

		await pi.team("report");

		const woken = pi.sent.at(-1);
		assert.equal(woken?.customType, "team-report-request");
		assert.equal(woken?.triggerTurn, true);
		assert.match(woken?.content ?? "", /`team_report`/);
		assert.match(woken?.content ?? "", /since the last Report/);
	});

	it("says there is nothing to report on without an Effort whose Brief is approved", async () => {
		const pi = fakePi(tempRoots());

		await pi.team("report");

		assert.deepEqual(pi.sent, []);
		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.match(pi.notifications.at(-1)?.message ?? "", /No Effort/);
	});
});

describe("/team reports", () => {
	it("lists the Reports newest first and opens the chosen one in an overlay, closed with escape", async () => {
		const { pi } = await crewReported();
		await pi.call("team_report", { headline: "`rename-key` is with builder-1." });
		pi.answer("Report 1 · 10:00 · Planned three Tasks.");

		const { overlay, done } = await pi.teamOpening("reports");

		assert.deepEqual(pi.dialogs.at(-1)?.options, ["Report 2 · 10:00 · `rename-key` is with builder-1.", "Report 1 · 10:00 · Planned three Tasks."]);
		const drawn = overlay.view.render(100).join("\n");
		assert.ok(drawn.includes("# Report 1 · Effort `crew-2026-11-02`"), drawn);
		assert.ok(drawn.includes("builder: acceptEdits"), drawn);
		assert.equal(overlay.closed, false);
		overlay.view.handleInput?.("\x1b");
		await done;
		assert.equal(overlay.closed, true);
	});

	it("says when there are none yet", async () => {
		const { pi } = await crewApproved();

		await pi.team("reports");

		assert.deepEqual(pi.notifications.at(-1), { message: "No Reports yet for Effort `crew-2026-11-02`.", type: "info" });
	});

	it("names the chosen Report's file outside pi's terminal, where there is no overlay to open", async () => {
		const { pi, dir } = await crewApproved({ mode: "rpc" });
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.call("team_report", { headline: "Planned three Tasks." });
		pi.answer("Report 1 · 10:00 · Planned three Tasks.");

		await pi.team("reports");

		assert.deepEqual(pi.overlays, []);
		assert.deepEqual(pi.notifications.at(-1), { message: `Report 1 is ${join(dir, "reports", "001.md")}.`, type: "info" });
	});
});

describe("the package manifest", () => {
	it("loads the team extension beside the others", () => {
		const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { pi: { extensions: string[] } };

		assert.ok(manifest.pi.extensions.includes("./extensions/team/index.ts"), manifest.pi.extensions.join(", "));
	});
});

/** A pid no process has any more: a child that has already exited. */
function deadPid(): number {
	const pid = spawnSync(process.execPath, ["-e", ""]).pid;
	assert.ok(pid !== undefined, "expected the child to have a pid");
	return pid;
}

interface LeadFile {
	pid: number;
	port?: number;
	token?: string;
	sessionFile?: string;
	startedAt: string;
	stoppedAt?: string;
}

function leadOf(dir: string): LeadFile {
	return JSON.parse(readFileSync(join(dir, "lead.json"), "utf8")) as LeadFile;
}

describe("leading an Effort: the lock", () => {
	it("refuses a second session that tries to lead a held Effort, naming the session that holds it", async () => {
		const { roots, repo, pi } = intakeSession();
		await pi.team("start software");
		const dir = effortDir(roots);
		const held = leadOf(dir);
		const other = fakePi(roots, { cwd: repo, sessionFile: join(roots.scratch, "other.jsonl"), pid: process.ppid });

		await other.team(`resume ${EFFORT_ID}`);

		assert.equal(other.notifications.length, 1);
		assert.equal(other.notifications[0].type, "error");
		assert.ok(other.notifications[0].message.includes(join(roots.scratch, "session.jsonl")), other.notifications[0].message);
		assert.ok(other.notifications[0].message.includes(`pid ${process.pid}`), other.notifications[0].message);
		assert.deepEqual(leadOf(dir), held);
		assert.deepEqual(other.entries, []);
		assert.ok(!other.activeTools().includes("team_plan"));
	});

	it("takes over a lock and a Lead whose pid has died", async () => {
		const { roots, repo } = intakeSession();
		const crashed = deadPid();
		const crashedPi = fakePi(roots, { cwd: repo, pid: crashed });
		await crashedPi.team("start software");
		const dir = effortDir(roots);
		writeFileSync(join(dir, "lead.lock"), `${crashed}\n`);
		const other = fakePi(roots, { cwd: repo, sessionFile: join(roots.scratch, "other.jsonl") });

		await other.team(`resume ${EFFORT_ID}`);

		const lead = leadOf(dir);
		assert.equal(lead.pid, process.pid);
		assert.equal(lead.sessionFile, join(roots.scratch, "other.jsonl"));
		assert.equal(typeof lead.port, "number");
		assert.equal(existsSync(join(dir, "lead.lock")), false);
		assert.deepEqual(other.entries, [{ customType: "team-effort", data: { effortId: EFFORT_ID, effortDir: dir } }]);
		assert.ok(other.activeTools().includes("team_plan"));
		assert.equal(other.notifications.length, 1);
		assert.equal(other.notifications[0].type, "info");
		assert.ok(other.notifications[0].message.includes(dir), other.notifications[0].message);
	});
});

describe("adopting an Effort: `/team resume` in a session holding none", () => {
	it("lists the Efforts with no live Lead and adopts the one chosen", async () => {
		const { roots, repo, pi } = intakeSession();
		await pi.team("start software");
		const crashed = fakePi(roots, { cwd: repo, sessionFile: join(roots.scratch, "crashed.jsonl"), pid: deadPid() });
		await crashed.team("start software");
		const other = fakePi(roots, { cwd: repo, sessionFile: join(roots.scratch, "other.jsonl") });

		other.answer(`${EFFORT_ID}-2`);
		await other.team("resume");

		assert.equal(other.dialogs.length, 1);
		assert.deepEqual(other.dialogs[0].options, [`${EFFORT_ID}-2`]);
		const dir = effortDir(roots, `${EFFORT_ID}-2`);
		assert.equal(leadOf(dir).sessionFile, join(roots.scratch, "other.jsonl"));
		assert.deepEqual(other.entries, [{ customType: "team-effort", data: { effortId: `${EFFORT_ID}-2`, effortDir: dir } }]);
		assert.ok(other.activeTools().includes("team_handoff"));
	});

	it("says so when no Effort is without a live Lead, and names the candidates for an Effort that doesn't exist", async () => {
		const { roots, repo, pi } = intakeSession();
		const other = fakePi(roots, { cwd: repo, sessionFile: join(roots.scratch, "other.jsonl") });
		await other.team("resume");
		await pi.team("start software");
		const crashed = fakePi(roots, { cwd: repo, sessionFile: join(roots.scratch, "crashed.jsonl"), pid: deadPid() });
		await crashed.team("start software");

		await other.team("resume software-2026-10-01");

		assert.deepEqual(other.notifications, [
			{ message: "No Effort is without a live Lead, so there is nothing to adopt; `/team start` opens a new one.", type: "info" },
			{ message: `There is no Effort \`software-2026-10-01\` to adopt. Efforts without a live Lead: \`${EFFORT_ID}-2\`.`, type: "error" },
		]);
		assert.deepEqual(other.entries, []);
	});
});

describe("`/team resume` in a session holding an Effort", () => {
	it("is about the human's pause, not adoption: with none to lift it says so and leaves the Lead as it is", async () => {
		const { roots, pi } = intakeSession();
		await pi.team("start software");
		const lead = leadOf(effortDir(roots));

		await pi.team("resume");

		assert.deepEqual(pi.notifications.at(-1), { message: `Effort \`${EFFORT_ID}\` isn't paused by you, so there is nothing to resume.`, type: "info" });
		assert.equal(pi.entries.length, 1);
		assert.deepEqual(leadOf(effortDir(roots)), lead);
	});
});

describe("pausing: /team pause, /team resume, team_pause, team_resume", () => {
	it("holds new Tasks while the human's pause holds: a handoff queues `paused`, the running Teammate isn't stopped, the block shows the pause, and only `/team resume` lifts it, starting the queued Task through the ladder", async () => {
		const { pi, dir } = await crewApproved({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }] });
		await pi.call("team_plan", { tasks: STAFF_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });

		await pi.team("pause lunch break");

		assert.deepEqual(pi.notifications.at(-1), {
			message: `Effort \`${CREW_EFFORT_ID}\` is paused: no new Task starts and handoffs queue, while running Teammates finish their Task.`,
			type: "info",
		});
		const queued = await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" });
		assert.match(
			queued,
			/^queued Task `survey` \(tasks\/002-scout-survey\/task\.md\): paused by the human since \d\d:\d\d UTC: lunch break\. It starts by itself once every pause is lifted \(only the human lifts it, with `\/team resume`\)\./,
		);
		assert.equal(pi.claude.launches().length, 1);
		assert.deepEqual(
			pi.claude.calls().filter((call) => call[0] === "stop"),
			[],
			"the running Teammate finishes its Task",
		);
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## survey\n[\s\S]*?- Status: queued\n/);
		const block = teamBlock(pi) ?? [];
		assert.ok(block.some((line) => line.includes("⏸ paused")), block.join("\n"));
		assert.ok(block.some((line) => /by you since \d\d:\d\d UTC: lunch break {3}\/team resume/.test(line)), block.join("\n"));
		assert.ok(block.some((line) => line.includes("queued  002-scout-survey (scout): paused")), block.join("\n"));
		await assert.rejects(
			pi.call("team_resume", {}),
			/isn't paused by you, so there is nothing for you to resume\. It is paused by the human since \d\d:\d\d UTC: lunch break; only the human lifts it, with `\/team resume`/,
		);
		await pi.team("pause again");
		assert.match(pi.notifications.at(-1)?.message ?? "", /is already paused by you since \d\d:\d\d UTC: lunch break\.$/);
		const woken = pi.sent.length;

		await pi.team("resume");

		assert.equal(pi.notifications.at(-1)?.type, "info");
		assert.match(
			pi.notifications.at(-1)?.message ?? "",
			/^Effort `crew-2026-11-02` runs again: queued Tasks start through the staffing ladder\. Queued Task `survey` started scout-1 \(tasks\/002-scout-survey\/task\.md\)/,
		);
		assert.equal(pi.claude.launches().length, 2);
		assert.equal(pi.claude.launches()[1].argv.at(-1), newTaskPointer(dir, "survey", "002-scout-survey"));
		assert.equal(pi.sent[woken]?.customType, "team-resumed");
		assert.match(pi.sent[woken]?.content ?? "", /The human lifted their pause[\s\S]*Queued Task `survey` started scout-1/);
		const after = teamBlock(pi) ?? [];
		assert.ok(after.some((line) => line.includes("● running")), after.join("\n"));
		assert.ok(!after.some((line) => line.includes("by you since")), after.join("\n"));
		assert.deepEqual(
			effortLines(dir)
				.filter((line) => line.type === "paused" || line.type === "resumed")
				.map((line) => [line.type, line.by, line.reason]),
			[
				["paused", "human", "lunch break"],
				["resumed", "human", undefined],
			],
		);
	});

	it("lets the Lead pause with a reason and lift only its own pause, which `/team resume` leaves alone", async () => {
		const { pi } = await crewApproved();

		await assert.rejects(pi.call("team_pause", { reason: "  " }), /`team_pause` needs a `reason`/);
		const paused = await pi.call("team_pause", { reason: "checking the API" });
		assert.match(paused, /is paused: no new Task starts and handoffs queue/);
		assert.ok((teamBlock(pi) ?? []).some((line) => /by the Lead since \d\d:\d\d UTC: checking the API/.test(line)), (teamBlock(pi) ?? []).join("\n"));
		const status = JSON.parse(await pi.call("team_status", {})) as { pauses?: { by: string; reason?: string }[] };
		assert.deepEqual(
			status.pauses?.map(({ by, reason }) => [by, reason]),
			[["lead", "checking the API"]],
		);

		await pi.team("resume");

		assert.deepEqual(pi.notifications.at(-1)?.type, "info");
		assert.match(
			pi.notifications.at(-1)?.message ?? "",
			/isn't paused by you, so there is nothing for you to resume\. It is paused by the Lead since \d\d:\d\d UTC: checking the API; only the Lead lifts it, with `team_resume`\.$/,
		);
		assert.match(await pi.call("team_resume", {}), /^Effort `crew-2026-11-02` runs again: queued Tasks start through the staffing ladder\.$/);
		await assert.rejects(pi.call("team_resume", {}), /isn't paused by you, so there is nothing to resume\./);
		assert.ok(!(teamBlock(pi) ?? []).some((line) => line.includes("⏸")), (teamBlock(pi) ?? []).join("\n"));
	});

	it("refuses `/team pause` in a session holding no Effort, naming how to open one", async () => {
		const pi = fakePi(tempRoots());

		await pi.team("pause");

		assert.deepEqual(pi.notifications, [{ message: "This session holds no Effort, so there is nothing to pause; `/team start` opens one, and `/team resume` adopts one without a live Lead.", type: "error" }]);
	});
});

describe("leaving the session", () => {
	it("marks no live Lead on shutdown, keeping the record, so another session can adopt the Effort", async () => {
		const { roots, repo, pi } = intakeSession();
		await pi.team("start software");
		const dir = effortDir(roots);

		await pi.emit("session_shutdown", { reason: "quit" });

		assert.deepEqual(leadOf(dir), { pid: process.pid, sessionFile: join(roots.scratch, "session.jsonl"), startedAt: NOW.toISOString(), stoppedAt: NOW.toISOString() });
		const other = fakePi(roots, { cwd: repo, sessionFile: join(roots.scratch, "other.jsonl") });
		other.answer(EFFORT_ID);
		await other.team("resume");
		assert.equal(leadOf(dir).sessionFile, join(roots.scratch, "other.jsonl"));
	});
});

describe("re-attaching: `pi -c`, `/resume` back and `/reload`", () => {
	for (const [left, started] of [
		["quit", "startup"],
		["resume", "resume"],
		["reload", "reload"],
	] as const) {
		it(`re-attaches on session_start (${started}) a session carrying the pointer whose file lead.json names`, async () => {
			const { roots, repo, pi } = intakeSession();
			await pi.team("start software");
			await pi.emit("session_shutdown", { reason: left });
			const dir = effortDir(roots);

			const again = fakePi(roots, { cwd: repo, entries: pi.allEntries() });
			await again.emit("session_start", { reason: started });

			const lead = leadOf(dir);
			assert.equal(lead.stoppedAt, undefined);
			assert.equal(typeof lead.port, "number");
			assert.equal(lead.sessionFile, join(roots.scratch, "session.jsonl"));
			assert.deepEqual(again.activeTools(), [...PI_TOOLS, "team_request_approval", "team_plan", "team_handoff", "team_review", "team_status", "team_report", "team_pause", "team_resume", "team_answer", "team_escalate", "team_send"]);
			assert.deepEqual(again.entries, []);
			assert.deepEqual(again.notifications, [{ message: `This session leads Effort \`${EFFORT_ID}\` (${dir}) again.`, type: "info" }]);
			assert.deepEqual(again.sent, []);
		});
	}

	it("leaves the Effort alone when lead.json names another session, saying which", async () => {
		const { roots, repo, pi } = intakeSession();
		await pi.team("start software");
		await pi.emit("session_shutdown", { reason: "quit" });
		const other = fakePi(roots, { cwd: repo, sessionFile: join(roots.scratch, "other.jsonl") });
		other.answer(EFFORT_ID);
		await other.team("resume");
		const lead = leadOf(effortDir(roots));

		const again = fakePi(roots, { cwd: repo, entries: pi.allEntries(), pid: process.ppid });
		await again.emit("session_start", { reason: "startup" });

		assert.deepEqual(leadOf(effortDir(roots)), lead);
		assert.ok(!again.activeTools().includes("team_plan"));
		assert.deepEqual(again.notifications, [
			{ message: `This session led Effort \`${EFFORT_ID}\`, which is now led from the pi session ${join(roots.scratch, "other.jsonl")} (pid ${process.pid}); \`/team resume ${EFFORT_ID}\` adopts it here once that session leaves it.`, type: "info" },
		]);
	});

	it("does nothing for a session that carries no pointer", async () => {
		const { roots, repo, pi } = intakeSession();
		await pi.team("start software");
		await pi.emit("session_shutdown", { reason: "quit" });

		const fresh = fakePi(roots, { cwd: repo, sessionFile: join(roots.scratch, "fresh.jsonl") });
		await fresh.emit("session_start", { reason: "startup" });

		assert.deepEqual(fresh.notifications, []);
		assert.equal(leadOf(effortDir(roots)).stoppedAt, NOW.toISOString());
	});
});

describe("moving the Effort: `/fork` and `/clone`", () => {
	it("names the new session file in lead.json, and the new session leads it", async () => {
		const { roots, repo, pi } = intakeSession();
		await pi.team("start software");
		const fork = join(roots.scratch, "fork.jsonl");
		await pi.emit("session_shutdown", { reason: "fork", targetSessionFile: fork });
		const dir = effortDir(roots);
		assert.equal(leadOf(dir).sessionFile, fork);
		assert.equal(leadOf(dir).stoppedAt, NOW.toISOString());

		const moved = fakePi(roots, { cwd: repo, sessionFile: fork, entries: pi.allEntries() });
		await moved.emit("session_start", { reason: "fork", previousSessionFile: join(roots.scratch, "session.jsonl") });

		assert.equal(leadOf(dir).sessionFile, fork);
		assert.equal(leadOf(dir).stoppedAt, undefined);
		assert.ok(moved.activeTools().includes("team_plan"));
		assert.deepEqual(moved.entries, []);
	});

	it("re-attaches a fork made before the Lead's first message, writing the pointer it lacks", async () => {
		const { roots, repo, pi } = intakeSession();
		await pi.team("start software");
		const fork = join(roots.scratch, "fork.jsonl");
		await pi.emit("session_shutdown", { reason: "fork", targetSessionFile: fork });
		const dir = effortDir(roots);

		const moved = fakePi(roots, { cwd: repo, sessionFile: fork });
		await moved.emit("session_start", { reason: "fork" });

		assert.equal(leadOf(dir).stoppedAt, undefined);
		assert.deepEqual(moved.entries, [{ customType: "team-effort", data: { effortId: EFFORT_ID, effortDir: dir } }]);
		assert.deepEqual(moved.notifications, [{ message: `This session leads Effort \`${EFFORT_ID}\` (${dir}) again.`, type: "info" }]);
	});
});

describe("switching away: `/new` and `/resume` elsewhere", () => {
	for (const [reason, extra] of [
		["new", {}],
		["resume", { targetSessionFile: "/elsewhere/other.jsonl" }],
	] as const) {
		it(`asks first on \`${reason}\`, and cancels on "no", the Effort still led`, async () => {
			const { roots, pi } = intakeSession();
			await pi.team("start software");
			pi.answer(false);

			const result = await pi.emit("session_before_switch", { reason, ...extra });

			assert.deepEqual(result, { cancel: true });
			assert.deepEqual(
				pi.dialogs.map(({ kind, title }) => ({ kind, title })),
				[{ kind: "confirm", title: `Leave Effort \`${EFFORT_ID}\`?` }],
			);
			assert.equal(leadOf(effortDir(roots)).stoppedAt, undefined);
		});
	}

	it("lets the switch go ahead on \"yes\"", async () => {
		const { pi } = intakeSession();
		await pi.team("start software");
		pi.answer(true);

		assert.equal(await pi.emit("session_before_switch", { reason: "new" }), undefined);
		assert.equal(pi.dialogs.length, 1);
	});

	it("doesn't ask in a session leading no Effort", async () => {
		const { pi } = intakeSession();

		assert.equal(await pi.emit("session_before_switch", { reason: "new" }), undefined);
		assert.deepEqual(pi.dialogs, []);
	});
});

describe("moving in the tree: `/tree`", () => {
	it("queues the Effort's status for the Lead's next turn, starting none", async () => {
		const { roots, pi } = intakeSession();
		await pi.team("start software");
		const before = pi.sent.length;

		await pi.emit("session_tree", { newLeafId: "e1", oldLeafId: "e2" });

		const queued = pi.sent.slice(before);
		assert.deepEqual(
			queued.map(({ customType, display, triggerTurn, deliverAs }) => ({ customType, display, triggerTurn, deliverAs })),
			[{ customType: "team-status", display: true, triggerTurn: undefined, deliverAs: "nextTurn" }],
		);
		const [intro, status] = queued[0].content.split("\n\n");
		assert.equal(intro, `This session still leads Effort \`${EFFORT_ID}\` (${effortDir(roots)}), whichever branch of the tree you are on: its state lives in its files. Its status, as \`team_status\` gives it:`);
		assert.deepEqual(JSON.parse(status), {
			effortId: EFFORT_ID,
			team: "software",
			phase: "intake",
			tasks: { accepted: 0, planned: 0 },
			teammates: [],
			queued: [],
			waitingOnYou: 0,
			reports: 0,
		});
	});

	it("says nothing in a session leading no Effort", async () => {
		const { pi } = intakeSession();

		await pi.emit("session_tree", { newLeafId: "e1" });

		assert.deepEqual(pi.sent, []);
	});
});

/** The menu entry, and the picker row, of the Teammate {@link attachable} hands off. */
const BUILDER_ROW = "builder-1  c0ffee12  busy  001-builder-rename-key";

/** A crew Effort with `builder-1` handed `rename-key` and its session started as short id `c0ffee12`. */
async function attachable(options: Pick<NonNullable<Parameters<typeof fakePi>[1]>, "mode" | "env" | "attachExit"> = {}) {
	const approved = await crewApproved({
		...options,
		hooks: [
			{ event: "SessionStart", payload: { source: "startup", session_id: "c0ffee12-0000-4000-8000-000000000001", permission_mode: "acceptEdits" } },
			{ event: "UserPromptSubmit", payload: { prompt: "New Task `rename-key`", permission_mode: "acceptEdits" } },
		],
	});
	await approved.pi.call("team_plan", { tasks: CREW_PLAN });
	await approved.pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
	approved.pi.dialogs.length = 0;
	approved.pi.notifications.length = 0;
	return approved;
}

function attachedLines(dir: string): Record<string, unknown>[] {
	return effortLines(dir).filter((line) => line.type === "teammate-attached");
}

describe("/team attach [id]", () => {
	it("picks a live Teammate, then attaches here: the TUI stops, the Ctrl+Z hint, `claude attach` on pi's own terminal, the TUI back and a toast", async () => {
		const { pi, dir } = await attachable();
		pi.answer(BUILDER_ROW, "Attach here");

		await pi.team("");

		assert.deepEqual(pi.dialogs, [
			{ kind: "select", title: "Attach to which Teammate?", options: [BUILDER_ROW], answer: BUILDER_ROW },
			{ kind: "select", title: "builder-1 (c0ffee12)", options: ["Attach here", "Copy the command"], answer: "Attach here" },
		]);
		assert.deepEqual(pi.tuiEvents, [
			"stop, 0 attached",
			`write ${JSON.stringify("\nAttaching to builder-1 (c0ffee12). Ctrl+Z returns to pi.\n\n")}`,
			"start, 1 attached",
			"requestRender(true)",
		]);
		assert.deepEqual(pi.claude.attaches(), [{ argv: ["attach", "c0ffee12"], stdio: ownStdio() }]);
		assert.deepEqual(pi.notifications, [{ message: "Back in pi from `builder-1` (c0ffee12).", type: "info" }]);
		assert.deepEqual(attachedLines(dir), [{ type: "teammate-attached", teammate: "builder-1", shortId: "c0ffee12", at: NOW.toISOString() }]);
	});

	it("skips the picker for a Teammate it is given, and says so when `claude attach` fails", async () => {
		const { pi } = await attachable({ attachExit: 1 });
		pi.answer("Attach here");

		await pi.team("attach builder-1");

		assert.deepEqual(
			pi.dialogs.map((dialog) => dialog.title),
			["builder-1 (c0ffee12)"],
		);
		assert.deepEqual(pi.tuiEvents.slice(-2), ["start, 1 attached", "requestRender(true)"]);
		assert.deepEqual(pi.notifications, [{ message: "`claude attach c0ffee12` exited with code 1; back in pi.", type: "warning" }]);
	});

	it("opens a tmux window running `claude attach` only inside tmux, and copies the exact command", async () => {
		const { pi, dir } = await attachable({ env: { TMUX: "/tmp/tmux-501/default,4242,0" } });
		const command = `${pi.claude.path} attach c0ffee12`;
		pi.answer("Open in a tmux window");

		await pi.team("attach builder-1");

		assert.deepEqual(pi.dialogs[0]?.options, ["Attach here", "Open in a tmux window", "Copy the command"]);
		assert.deepEqual(pi.tmux.calls(), [["new-window", "-n", "builder-1", command]]);
		assert.deepEqual(pi.tuiEvents, []);
		assert.deepEqual(pi.notifications, [{ message: "Opened `builder-1` in a new tmux window.", type: "info" }]);

		pi.answer(BUILDER_ROW, "Copy the command");
		await pi.team("attach");

		assert.deepEqual(pi.copied, [command]);
		assert.deepEqual(pi.notifications.at(-1), { message: `Copied \`${command}\`.`, type: "info" });
		assert.equal(pi.claude.attaches().length, 0);
		// The same short id twice is one record.
		assert.equal(attachedLines(dir).length, 1);
	});

	it("shows the command instead outside the TUI, and still records it", async () => {
		const { pi, dir } = await attachable({ mode: "rpc" });

		await pi.team("attach builder-1");

		assert.deepEqual(pi.dialogs, []);
		assert.deepEqual(pi.notifications, [{ message: `Attach to \`builder-1\` from a terminal: ${pi.claude.path} attach c0ffee12`, type: "info" }]);
		assert.equal(pi.claude.attaches().length, 0);
		assert.equal(attachedLines(dir).length, 1);
	});

	it("clears a Teammate's `(new)` mark once the human uses the menu on it", async () => {
		const { pi, dir } = await attachable();
		appendFileSync(
			join(dir, "effort.jsonl"),
			`${JSON.stringify({ type: "teammate-session", teammate: "builder-1", cursor: 3, source: "startup", sessionId: "k3l4m5n6-0000", shortId: "k3l4m5n6", at: NOW.toISOString() })}\n`,
		);
		assert.equal(JSON.parse(await pi.call("team_status", {})).teammates[0].newShortId, true);
		pi.answer("builder-1  k3l4m5n6 (new)  busy  001-builder-rename-key", "Copy the command");

		await pi.team("");

		assert.deepEqual(pi.copied, [`${pi.claude.path} attach k3l4m5n6`]);
		assert.equal(JSON.parse(await pi.call("team_status", {})).teammates[0].newShortId, undefined);
		assert.equal(teamBlock(pi)?.some((line) => line.includes("(new)")), false);
		assert.deepEqual(attachedLines(dir).at(-1), { type: "teammate-attached", teammate: "builder-1", shortId: "k3l4m5n6", at: NOW.toISOString() });
	});

	it("records nothing when the human backs out of the picker or the menu", async () => {
		const { pi, dir } = await attachable();
		pi.answer(undefined);
		await pi.team("");
		pi.answer(undefined);
		await pi.team("attach builder-1");

		assert.equal(attachedLines(dir).length, 0);
		assert.deepEqual(pi.claude.attaches(), []);
		assert.deepEqual(pi.notifications, []);
	});

	it("names what there is to attach to when there is nothing, or no such Teammate", async () => {
		const pi = fakePi(tempRoots());
		await pi.team("");
		await pi.team("attach builder-1");
		const { pi: leading } = await attachable();
		await leading.team("attach qa-1");

		assert.deepEqual(pi.notifications, [
			{ message: "No Teammate has a session to attach to: this session holds no Effort. Subcommands: `start`, `setup`, `pending`, `pause`, `resume`, `report`, `reports`, `cancel`, `attach`, `handback`.", type: "info" },
			{ message: "No Teammate has a session to attach to: this session holds no Effort. Subcommands: `start`, `setup`, `pending`, `pause`, `resume`, `report`, `reports`, `cancel`, `attach`, `handback`.", type: "info" },
		]);
		assert.deepEqual(leading.notifications, [{ message: "There is no Teammate `qa-1` with a session to attach to. Teammates with one: `builder-1`.", type: "error" }]);
	});
});

/** The task worktree and branch of Task `nnn` in the crew Effort's repo. */
function crewTask(repo: string, nnn: string): { path: string; branch: string } {
	return { path: `${workspaceOf(repo, CREW_EFFORT_ID)}-task-${nnn}`, branch: `team/${CREW_EFFORT_ID}-task-${nnn}` };
}

/** Whether `git` succeeds in `dir`. */
function gitOk(dir: string, ...args: string[]): boolean {
	return spawnSync("git", args, { cwd: dir, stdio: "ignore" }).status === 0;
}

/** A Teammate that commits its edit in its working directory, then writes its result and stops. */
const COMMITS: FakeHookStep[] = [
	{ event: "SessionStart", payload: { source: "startup" } },
	{ event: "UserPromptSubmit" },
	{ edit: "{task}.txt", commit: "Do the Task" },
	{ write: "result" },
	{ event: "Stop", payload: { last_assistant_message: "Done." } },
];

/** An approved crew Effort whose `rename-key` Task is handed off isolated to `builder-1`, who has written round 1's result. */
async function isolatedReported(hooks: FakeHookStep[] = COMMITS) {
	const crew = await crewApproved({ hooks });
	await crew.pi.call("team_plan", { tasks: CREW_PLAN });
	await crew.pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n", isolated: true });
	await until(() => existsSync(join(crew.dir, RENAME_RESULT)), "builder-1 writes its result");
	return { ...crew, task: crewTask(crew.repo, "001") };
}

describe("an isolated Task in a worktree of its own", () => {
	it("cuts a worktree and branch beside the Workspace from the Effort branch's tip, copying `.worktreeinclude`, and launches its Teammate there", async () => {
		const { pi, repo, workspace } = await crewApproved({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }] });
		const tip = commit(workspace, { "effort.txt": "on the Effort branch\n", ".gitignore": ".env\n" }, "Effort work");
		commit(repo, { ".gitignore": ".env\n" }, "ignore .env");
		writeFileSync(join(repo, ".worktreeinclude"), ".env\n");
		writeFileSync(join(repo, ".env"), "SECRET=1\n");
		await pi.call("team_plan", { tasks: CREW_PLAN });

		const reply = await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n", isolated: true });

		const task = crewTask(repo, "001");
		assert.match(reply, /started builder-1 .*`team\/crew-2026-11-02-task-001`/);
		assert.match(reply, /commits/);
		assert.equal(pi.claude.launches()[0].cwd, task.path);
		assert.ok(relative(workspace, task.path).startsWith(".."), "the task worktree is not nested in the Workspace");
		assert.equal(git(task.path, "branch", "--show-current"), task.branch);
		assert.equal(git(task.path, "rev-parse", "HEAD"), tip);
		assert.equal(readFileSync(join(task.path, ".env"), "utf8"), "SECRET=1\n");
		assert.equal(git(task.path, "status", "--porcelain"), "");
	});

	it("gives two isolated Tasks worked in parallel a worktree each, so each Teammate sees only its own uncommitted files", async () => {
		const { pi, repo, workspace } = await crewApproved({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }, { event: "UserPromptSubmit" }, { edit: "{task}.txt" }] });
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n", isolated: true });
		await pi.call("team_handoff", { slug: "survey", body: "# Survey\n", isolated: true });

		const [first, second] = [crewTask(repo, "001"), crewTask(repo, "002")];
		assert.deepEqual(
			pi.claude.launches().map((launch) => launch.cwd),
			[first.path, second.path],
		);
		assert.equal(git(first.path, "status", "--porcelain"), "?? 001-builder-rename-key.txt");
		assert.equal(git(second.path, "status", "--porcelain"), "?? 002-scout-survey.txt");
		assert.equal(git(workspace, "status", "--porcelain"), "");
	});

	it("merges an accepted Task's branch into the Effort branch with `--no-ff`, recording the intent first, then removes its worktree and branch", async () => {
		const { pi, repo, dir, workspace, task } = await isolatedReported();

		const reply = await pi.call("team_review", { slug: "rename-key", verdict: "accept" });

		assert.match(reply, /^Accepted Task `rename-key` at round 1.*merged `team\/crew-2026-11-02-task-001` into `team\/crew-2026-11-02`/);
		const parents = git(workspace, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
		assert.equal(parents.length, 3, "a merge commit, never a fast-forward");
		assert.equal(readFileSync(join(workspace, "001-builder-rename-key.txt"), "utf8"), "edited for 001-builder-rename-key\n");
		assert.equal(existsSync(task.path), false);
		assert.equal(git(repo, "branch", "--list", task.branch), "");
		const types = effortLines(dir).map((line) => line.type);
		assert.ok(types.indexOf("merge-intended") !== -1 && types.indexOf("merge-intended") < types.indexOf("task-accepted"), types.join(", "));
		assert.equal(effortLines(dir).find((line) => line.type === "task-accepted")?.merge, parents[0]);
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## rename-key\n[\s\S]*?- Status: accepted/);
		assert.ok(pi.claude.calls().some((argv) => argv[0] === "stop"), "its Teammate is stopped");
	});

	it("removes a dropped isolated Task's worktree and branch once its Teammate is stopped, when nothing of it is unmerged", async () => {
		const { pi, repo } = await crewApproved({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }] });
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n", isolated: true });
		const task = crewTask(repo, "001");
		assert.ok(existsSync(task.path));

		const reply = await pi.call("team_plan", { tasks: [{ ...CREW_PLAN[0], slug: "rename-key-everywhere" }, { ...CREW_PLAN[1], dependsOn: ["rename-key-everywhere"] }, CREW_PLAN[2]] });

		assert.match(reply, /Dropped Task `rename-key`, and stopped `builder-1`/);
		assert.equal(existsSync(task.path), false);
		assert.equal(git(repo, "branch", "--list", task.branch), "");
		assert.doesNotMatch(reply, /still running/);
	});

	it("tells the Lead, by pid and command, of a process its Teammate left running in an accepted Task's worktree, removing the worktree without stopping it", async (t) => {
		const { pi, task } = await isolatedReported([...COMMITS.slice(0, 3), { background: ["sleep", "300"] }, ...COMMITS.slice(3)]);
		t.after(() => pi.claude.killBackground());
		const [pid] = pi.claude.background();

		const reply = await pi.call("team_review", { slug: "rename-key", verdict: "accept" });

		assert.ok(reply.includes(`${task.path} is removed, but pid ${pid} (\`sleep 300\`) is still running in it, and the Team doesn't stop it: \`kill ${pid}\` does.`), reply);
		assert.equal(existsSync(task.path), false);
		assert.doesNotThrow(() => process.kill(pid, 0), "accepting doesn't stop it");
	});

	it("tells the Lead of a process left running in a dropped Task's worktree as it removes it", async (t) => {
		const { pi, repo } = await crewApproved({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }, { background: ["sleep", "300"] }] });
		t.after(() => pi.claude.killBackground());
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n", isolated: true });
		const task = crewTask(repo, "001");
		const [pid] = pi.claude.background();

		const reply = await pi.call("team_plan", { tasks: [{ ...CREW_PLAN[0], slug: "rename-key-everywhere" }, { ...CREW_PLAN[1], dependsOn: ["rename-key-everywhere"] }, CREW_PLAN[2]] });

		assert.ok(reply.includes(`${task.path} is removed, but pid ${pid} (\`sleep 300\`) is still running in it`), reply);
		assert.equal(existsSync(task.path), false);
	});

	it("keeps a dropped isolated Task's branch when it has commits the Effort branch lacks, telling the Lead", async () => {
		const { pi, repo, task } = await isolatedReported();

		const reply = await pi.call("team_plan", { tasks: [{ ...CREW_PLAN[0], slug: "rename-key-everywhere" }, { ...CREW_PLAN[1], dependsOn: ["rename-key-everywhere"] }, CREW_PLAN[2]] });

		assert.match(reply, /Dropped Task `rename-key`/);
		assert.match(reply, /`team\/crew-2026-11-02-task-001`.*left in place/);
		assert.ok(gitOk(repo, "rev-parse", "--verify", task.branch), "the unmerged branch is kept");
	});

	it("refuses to accept while the Effort's Workspace has uncommitted changes, leaving the Task in review and its branch intact", async () => {
		const { pi, dir, workspace, task } = await isolatedReported();
		const head = git(workspace, "rev-parse", "HEAD");
		writeFileSync(join(workspace, "wip.txt"), "the Lead's own edit\n");

		await assert.rejects(pi.call("team_review", { slug: "rename-key", verdict: "accept" }), /uncommitted changes/);

		assert.equal(git(workspace, "rev-parse", "HEAD"), head);
		assert.equal(gitOk(workspace, "rev-parse", "-q", "--verify", "MERGE_HEAD"), false);
		assert.ok(gitOk(task.path, "rev-parse", "--verify", task.branch));
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## rename-key\n[\s\S]*?- Status: in review/);
		assert.deepEqual(
			effortLines(dir)
				.map((line) => line.type)
				.filter((type) => type === "merge-intended" || type === "merge-failed"),
			["merge-intended", "merge-failed"],
		);

		unlinkSync(join(workspace, "wip.txt"));
		assert.match(await pi.call("team_review", { slug: "rename-key", verdict: "accept" }), /^Accepted Task `rename-key`/);
	});

	it("refuses a merge that conflicts, aborting it so nothing is half-merged, and leaves the Task in review with its branch intact", async () => {
		const { pi, dir, workspace, task } = await isolatedReported();
		const head = commit(workspace, { "001-builder-rename-key.txt": "the Effort's own\n" }, "Clash");
		const tip = git(task.path, "rev-parse", "HEAD");

		await assert.rejects(pi.call("team_review", { slug: "rename-key", verdict: "accept" }), /conflict.*001-builder-rename-key\.txt/);

		assert.equal(git(workspace, "rev-parse", "HEAD"), head);
		assert.equal(git(workspace, "status", "--porcelain"), "");
		assert.equal(gitOk(workspace, "rev-parse", "-q", "--verify", "MERGE_HEAD"), false);
		assert.equal(git(task.path, "rev-parse", task.branch), tip);
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## rename-key\n[\s\S]*?- Status: in review/);
	});

	it("refuses to accept work its Teammate left uncommitted, which wouldn't merge, telling the Lead to send it back", async () => {
		const { pi, task } = await isolatedReported([
			{ event: "SessionStart", payload: { source: "startup" } },
			{ event: "UserPromptSubmit" },
			{ edit: "{task}.txt" },
			{ write: "result" },
			{ event: "Stop", payload: { last_assistant_message: "Done." } },
		]);

		await assert.rejects(pi.call("team_review", { slug: "rename-key", verdict: "accept" }), /uncommitted.*send it back/s);

		assert.ok(existsSync(join(task.path, "001-builder-rename-key.txt")));
	});

	it("restaffs a crashed Teammate's isolated Task in the same worktree", async () => {
		const { pi, task } = await isolatedReported([...COMMITS, { event: "SessionEnd", payload: { reason: "other" } }]);
		await until(() => teammateWakes(pi.sent).some((wake) => wake.content.includes("ended")), "the Lead is woken about the crash");

		await pi.call("team_review", { slug: "rename-key", verdict: "send_back", feedback: "Also the docs." });

		assert.equal(pi.claude.launches()[1]?.cwd, task.path);
	});
});

/** The criteria of {@link crewBrief}, each with its evidence, as the final Report maps them. */
const FINAL_COVERAGE = [
	{ criterion: "AC1", note: "`rename-key` accepted: no file mentions `colour`." },
	{ criterion: "AC2", note: "`check-old-configs` accepted: old configs load." },
];

/**
 * A crew Effort at its end: two isolated Tasks with their Teammates running,
 * `survey`'s worktree left with an uncommitted file, and the final Report
 * written with `changes`, which asks the human to sign off.
 */
async function finalReported(changes?: Record<string, unknown>[]) {
	const crew = await crewApproved({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }] });
	await crew.pi.call("team_plan", { tasks: CREW_PLAN });
	await crew.pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n", isolated: true });
	await crew.pi.call("team_handoff", { slug: "survey", body: "# Survey\n", isolated: true });
	await until(() => effortLines(crew.dir).filter((line) => line.type === "teammate-session").length === 2, "both Teammates start");
	const [clean, dirty] = [crewTask(crew.repo, "001"), crewTask(crew.repo, "002")];
	writeFileSync(join(dirty.path, "notes.txt"), "not committed\n");
	const reply = await crew.pi.call("team_report", { headline: "Both criteria are met.", coverage: FINAL_COVERAGE, final: true, ...(changes ? { changes } : {}) });
	return { ...crew, clean, dirty, reply, report: join(crew.dir, "reports", "001.md") };
}

function approvals(dir: string): Record<string, unknown>[] {
	return readFileSync(join(dir, "approvals.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const EFFORT_TOOL_NAMES = ["team_request_approval", "team_plan", "team_handoff", "team_review", "team_status", "team_report", "team_pause", "team_resume", "team_answer"];

describe("ending an Effort: the final Report and sign-off", () => {
	it("writes the final Report mapping each criterion to its evidence, with the checkpoints and the worktrees, and asks the human to sign it off", async () => {
		const { pi, reply, report, clean, dirty } = await finalReported();

		assert.match(reply, /^The final Report 1 of Effort `crew-2026-11-02` is written as reports\/001\.md/);
		assert.match(reply, /sign off .*`r2`/);
		const written = readFileSync(report, "utf8");
		for (const needed of [
			"# Final Report 1 · Effort `crew-2026-11-02`",
			"- AC1: `rename-key` accepted: no file mentions `colour`.",
			"## Tasks",
			"- `rename-key` (builder, on `opus`): running",
			"- `check-old-configs` (reviewer): planned",
			"- `survey` (scout, on Claude Code's default model): running",
			"## Checkpoints",
			"- Brief: `r1` approved at 10:00 UTC",
			"## Found work",
			"## Worktrees",
			`- ${clean.path} (\`${clean.branch}\`): clean, removed at sign-off; the branch is kept`,
			`- ${dirty.path} (\`${dirty.branch}\`): has uncommitted changes, so it is kept; the branch is kept`,
		]) {
			assert.ok(written.includes(needed), `reports/001.md doesn't say ${needed}:\n${written}`);
		}
		assert.match(teamBlock(pi)?.join("\n") ?? "", /pending/);
	});

	it("refuses a final Report that leaves a criterion without evidence, writing nothing", async () => {
		const { pi, dir } = await crewApproved();
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await assert.rejects(pi.call("team_report", { headline: "Done.", coverage: [FINAL_COVERAGE[0]], final: true }), /AC2/);
		assert.equal(existsSync(join(dir, "reports")), false);
	});

	it("refuses Playbook changes in a Report that isn't final, writing nothing, rather than dropping them", async () => {
		const { pi, dir } = await crewApproved();
		await pi.call("team_plan", { tasks: CREW_PLAN });
		const changes = [{ id: "qa-first", summary: "QA first.", oldText: "a", newText: "b" }];

		await assert.rejects(pi.call("team_report", { headline: "Planned.", changes }), /Playbook changes go in the final Report/);
		assert.equal(existsSync(join(dir, "reports")), false);
	});

	it("signing off records the act with the Report's sha, stops every Teammate, removes the clean worktrees, keeps the dirty one and every branch, and ends the Effort", async () => {
		const { pi, dir, repo, report, workspace, clean, dirty } = await finalReported();
		const shortIds = effortLines(dir)
			.filter((line) => line.type === "teammate-session")
			.map((line) => line.shortId);

		pi.answer("Approve");
		await pi.team("pending");

		assert.match(pi.dialogs.at(-1)?.title ?? "", /[Ss]ign off.*reports\/001\.md/s);
		const signed = approvals(dir).at(-1);
		assert.equal(signed?.act, "sign-off");
		assert.equal(signed?.request, "r2");
		assert.equal(signed?.report, sha(readFileSync(report)));
		const stops = pi.claude.calls().filter((argv) => argv[0] === "stop").map((argv) => argv[1]);
		assert.deepEqual(stops.sort(), [...shortIds].sort());
		assert.deepEqual(effortLines(dir).at(-1), { type: "effort-ended", how: "signed-off", at: NOW.toISOString() });
		assert.deepEqual(effortLines(dir).filter((line) => line.type === "teammate-crashed"), [], "the SessionEnds of the sign-off's own stops are no crash");
		assert.ok(!teammateWakes(pi.sent).some((wake) => /session ended/.test(wake.content)), "nobody is woken about the stops");
		assert.equal(existsSync(workspace), false);
		assert.equal(existsSync(clean.path), false);
		assert.ok(existsSync(join(dirty.path, "notes.txt")));
		for (const branch of [`team/${CREW_EFFORT_ID}`, clean.branch, dirty.branch]) assert.ok(gitOk(repo, "rev-parse", "--verify", branch), `${branch} is kept`);
		const said = pi.notifications.at(-1)?.message ?? "";
		assert.match(said, /[Ss]igned off/);
		assert.ok(said.includes(dirty.path), said);
		assert.doesNotMatch(said, /still running/, "nothing was left running in a worktree");
		assert.doesNotMatch(readFileSync(report, "utf8"), /still running/);
		assert.deepEqual(
			pi.activeTools().filter((name) => EFFORT_TOOL_NAMES.includes(name)),
			[],
		);
		assert.equal(teamBlock(pi), undefined);
	});

	it("names a process a Teammate left running in its worktree, by pid and command, in the final Report and as sign-off removes the worktree, and leaves it running", async (t) => {
		// Each live session sits in its worktree with a child still attached to it, as a Bash tool's shell: sign-off stops those.
		const { pi, dir, repo, workspace } = await crewApproved({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }, { background: ["sleep", "300"] }], sessionChild: ["sleep", "301"] });
		t.after(() => pi.claude.killBackground());
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n", isolated: true });
		await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" });
		const [inTask, inWorkspace] = pi.claude.background();
		const task = crewTask(repo, "001");
		const sessions = [...pi.claude.agents().map((agent) => agent.pid), ...pi.claude.sessionChildren()];
		assert.equal(sessions.filter((pid) => pid !== undefined).length, 4, "two sessions, each with its child");
		await pi.call("team_report", { headline: "Both criteria are met.", coverage: FINAL_COVERAGE, final: true });

		const written = readFileSync(join(dir, "reports", "001.md"), "utf8");
		for (const [path, branch, pid] of [
			[task.path, task.branch, inTask],
			[workspace, `team/${CREW_EFFORT_ID}`, inWorkspace],
		] as const) {
			assert.ok(
				written.includes(
					`- ${path} (\`${branch}\`): clean, removed at sign-off; the branch is kept; pid ${pid} (\`sleep 300\`) is still running in it, and the Team doesn't stop it: \`kill ${pid}\` does (found as this Report was written; sign-off checks again)\n`,
				),
				written,
			);
		}
		for (const pid of sessions) assert.doesNotMatch(written, new RegExp(`(?<!\\d)${pid} \\(`), `the live session process ${pid} isn't named:\n${written}`);

		pi.answer("Approve");
		await pi.team("pending");

		const said = pi.notifications.at(-1)?.message ?? "";
		for (const pid of sessions) assert.doesNotMatch(said, new RegExp(`(?<!\\d)${pid} \\(`), `the stopped session process ${pid} isn't named: ${said}`);
		for (const [path, pid] of [
			[task.path, inTask],
			[workspace, inWorkspace],
		] as const) {
			assert.ok(said.includes(`${path} is removed, but pid ${pid} (\`sleep 300\`) is still running in it, and the Team doesn't stop it: \`kill ${pid}\` does.`), said);
			assert.equal(existsSync(path), false);
			assert.doesNotThrow(() => process.kill(pid, 0), "sign-off doesn't stop it");
		}
	});

	it("doesn't spare a process by the pid of a session stopped long before, which the system may have handed on", async (t) => {
		const { pi, dir, workspace } = await crewApproved({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }] });
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		const orphan = spawn("sleep", ["300"], { cwd: workspace, detached: true, stdio: "ignore" });
		orphan.unref();
		const pid = orphan.pid ?? 0;
		t.after(() => {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Gone already.
			}
		});
		// The session builder-1 had goes by the pid the orphan has now.
		const [session] = pi.claude.agents();
		pi.claude.setAgent(session?.name ?? "", { pid });
		// A re-plan drops its Task and stops it, and no worktree check follows.
		await pi.call("team_plan", { tasks: [{ ...CREW_PLAN[0], slug: "rename-key-everywhere" }, { ...CREW_PLAN[1], dependsOn: ["rename-key-everywhere"] }, CREW_PLAN[2]] });
		pi.advance(60 * 60_000);

		await pi.call("team_report", { headline: "Both criteria are met.", coverage: FINAL_COVERAGE, final: true });

		const written = readFileSync(join(dir, "reports", "001.md"), "utf8");
		assert.ok(written.includes(`pid ${pid} (\`sleep 300\`) is still running in it`), written);
	});

	it("leaves nothing waiting once signed off, and adopts nothing ended with `/team resume`", async () => {
		const { pi } = await finalReported();
		pi.answer("Approve");
		await pi.team("pending");

		await pi.team("pending");
		await pi.team("resume");

		assert.equal(pi.notifications.at(-2)?.message, "Nothing is waiting on you.");
		assert.match(pi.notifications.at(-1)?.message ?? "", /nothing to adopt/);
	});

	it("refuses to adopt a signed-off Effort by name, and a new session leading it doesn't take it back", async () => {
		const { pi, roots, repo } = await finalReported();
		pi.answer("Approve");
		await pi.team("pending");

		await pi.team(`resume ${CREW_EFFORT_ID}`);
		assert.match(pi.notifications.at(-1)?.message ?? "", /`crew-2026-11-02` was signed off, so there is nothing to adopt/);
		const again = fakePi(roots, { cwd: repo, entries: pi.allEntries() });
		await again.emit("session_start", { reason: "startup" });
		assert.deepEqual(
			again.activeTools().filter((name) => EFFORT_TOOL_NAMES.includes(name)),
			[],
		);
		assert.deepEqual(again.notifications, []);
	});

	it("a send-back of the final Report wakes the Lead with the note and leaves the Teammates running", async () => {
		const { pi, dir } = await finalReported();
		const woken = pi.sent.length;

		pi.answer("Send back with a note", "AC2 needs a test.");
		await pi.team("pending");

		assert.equal(pi.claude.calls().filter((argv) => argv[0] === "stop").length, 0);
		const wake = pi.sent.slice(woken).find((message) => message.customType === "team-pending");
		assert.match(wake?.content ?? "", /sent back the final Report .*AC2 needs a test\..*still running/s);
		assert.equal(effortLines(dir).some((line) => line.type === "effort-ended"), false);
		assert.equal(approvals(dir).some((record) => record.act === "sign-off"), false);
		assert.ok(pi.activeTools().includes("team_report"));
		await pi.team("pending");
		assert.equal(pi.notifications.at(-1)?.message, "Nothing is waiting on you.");
	});

	it("asks about each proposed Playbook change on its own: an adopted one changes the Team's adopted Playbook for the next Effort, never this Effort's snapshot", async () => {
		const changes = [
			{ id: "tiny-diffs", summary: "Diffs were still too big.", oldText: "keep each Task's diff small.", newText: "keep each Task's diff under 200 lines." },
			{ id: "no-curl", summary: "Nobody needed curl.", oldText: "## Rules", newText: "## Rules\n\n- **no-curl**: never fetch with curl." },
		];
		const { pi, roots, dir } = await finalReported(changes);
		const adopted = join(playbooksDir(roots), "crew.md");
		const snapshot = readFileSync(join(dir, "playbook.md"), "utf8");
		const asked = pi.dialogs.length;

		pi.answer("Adopt for the next Effort", "Decline", "Approve");
		await pi.team("pending");

		const titles = pi.dialogs.slice(asked).map((dialog) => dialog.title);
		assert.match(titles[0], /`tiny-diffs`.*under 200 lines/s);
		assert.match(titles[1], /`no-curl`/);
		assert.match(titles[2], /[Ss]ign off/);
		const now = readFileSync(adopted, "utf8");
		assert.ok(now.includes("keep each Task's diff under 200 lines."));
		assert.ok(!now.includes("no-curl"));
		assert.equal(readFileSync(join(dir, "playbook.md"), "utf8"), snapshot);
		const record = approvals(dir).find((each) => each.act === "playbook-change");
		assert.deepEqual(record && { request: record.request, change: record.change, playbook: record.playbook }, { request: "r3", change: "tiny-diffs", playbook: sha(Buffer.from(now)) });
		const json = JSON.parse(readFileSync(join(playbooksDir(roots), "crew.adopted.json"), "utf8")) as { sha256: string };
		assert.equal(json.sha256, sha(Buffer.from(now)));
		assert.equal(effortLines(dir).at(-1)?.type, "effort-ended");
	});

	it("waits to sign off until each proposed change is answered", async () => {
		const changes = [{ id: "tiny-diffs", summary: "Smaller.", oldText: "keep each Task's diff small.", newText: "keep each Task's diff tiny." }];
		const { pi, dir } = await finalReported(changes);

		pi.answer("Later", "Approve");
		await pi.team("pending");

		assert.match(pi.notifications.at(-1)?.message ?? "", /Adopt or decline each proposed Playbook change before signing off.*`tiny-diffs`/);
		assert.equal(effortLines(dir).some((line) => line.type === "effort-ended"), false);
	});

	it("refuses a final Report whose Playbook change doesn't apply to the Effort's Playbook, writing nothing", async () => {
		const { pi, dir } = await crewApproved();
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await assert.rejects(
			pi.call("team_report", { headline: "Done.", coverage: FINAL_COVERAGE, final: true, changes: [{ id: "nope", summary: "x", oldText: "not in it", newText: "y" }] }),
			/`nope`: its `oldText` isn't in the Playbook/,
		);
		assert.equal(existsSync(join(dir, "reports")), false);
	});

	it("`/team cancel`, confirmed, stops every Teammate and ends the Effort without sign-off; declined, it changes nothing", async () => {
		const { pi, dir, workspace, clean, dirty } = await finalReported();

		pi.answer(false);
		await pi.team("cancel");
		assert.equal(pi.claude.calls().filter((argv) => argv[0] === "stop").length, 0);
		assert.ok(pi.activeTools().includes("team_report"));

		pi.answer(true);
		await pi.team("cancel");

		assert.match(pi.dialogs.at(-1)?.title ?? "", /Cancel Effort `crew-2026-11-02`\?/);
		assert.equal(pi.claude.calls().filter((argv) => argv[0] === "stop").length, 2);
		assert.deepEqual(effortLines(dir).at(-1), { type: "effort-ended", how: "cancelled", at: NOW.toISOString() });
		assert.equal(approvals(dir).some((record) => record.act === "sign-off"), false);
		assert.equal(existsSync(workspace), false);
		assert.equal(existsSync(clean.path), false);
		assert.ok(existsSync(dirty.path));
		assert.match(pi.notifications.at(-1)?.message ?? "", /Cancelled Effort/);
		assert.deepEqual(
			pi.activeTools().filter((name) => EFFORT_TOOL_NAMES.includes(name)),
			[],
		);
		assert.equal(teamBlock(pi), undefined);
		await pi.team("cancel");
		assert.match(pi.notifications.at(-1)?.message ?? "", /holds no Effort, so there is nothing to cancel/);
	});
});

/** Cut `effort.jsonl` back to its first line of `type`, as a pi killed just after writing it leaves it. */
function killedAfter(dir: string, type: string): void {
	const lines = readFileSync(join(dir, "effort.jsonl"), "utf8").split("\n").filter(Boolean);
	const at = lines.findIndex((line) => JSON.parse(line).type === type);
	assert.ok(at !== -1, `effort.jsonl has a ${type} line`);
	writeFileSync(join(dir, "effort.jsonl"), `${lines.slice(0, at + 1).join("\n")}\n`);
}

/** The Lead's "while you were away" wakes. */
function awayWakes(sent: SentMessage[]): SentMessage[] {
	return sent.filter((message) => message.customType === "team-away");
}

/** The count of `effort.jsonl` lines of `type`. */
function counted(dir: string, type: string): number {
	return effortLines(dir).filter((line) => line.type === type).length;
}

describe("restarting: picking an Effort up after pi comes back", () => {
	afterEach(() => {
		for (const fake of holding.splice(0)) fake.release();
	});

	it("finds a Teammate launched just before pi died, replays its journal once and wakes the Lead once, doorbell or not", async () => {
		const { roots, repo, pi, dir } = await renameReported();
		await until(() => counted(dir, "task-done") === 1, "builder-1 reports round 1");
		await pi.emit("session_shutdown", { reason: "quit" });
		killedAfter(dir, "launch-intended");

		const again = fakePi(roots, { cwd: repo, entries: pi.allEntries(), claude: pi.claude });
		await again.emit("session_start", { reason: "startup" });

		assert.equal(pi.claude.launches().length, 1, "no second Teammate");
		assert.equal(counted(dir, "teammate-started"), 1);
		assert.equal(counted(dir, "task-handed-off"), 1);
		assert.equal(counted(dir, "task-done"), 1);
		assert.equal(again.sent.length, 1, again.sent.map((message) => message.content).join("\n---\n"));
		const [wake] = awayWakes(again.sent);
		assert.match(wake.content, new RegExp(`^While you were away, Effort \`${CREW_EFFORT_ID}\`:\\n- `));
		assert.match(wake.content, /rename-key/);
		assert.doesNotMatch(wake.content, /Read its records first/);

		const lead = JSON.parse(readFileSync(join(dir, "lead.json"), "utf8")) as { port: number; token: string };
		await ringDoorbell(lead.port, { type: "doorbell", token: lead.token, teammate: "builder-1" });
		await again.emit("agent_settled", { aborted: false });

		assert.equal(counted(dir, "task-done"), 1, "the doorbell after the replay applies nothing again");
		assert.equal(again.sent.length, 1);
	});

	it("replays the SessionEnd of a Teammate it stopped to make room as no crash: no wake, and no Task starts past the cap", async () => {
		const { roots, repo, pi, dir } = await crewApproved({ settings: { maxTeammates: 1 }, hooks: [{ event: "SessionStart", payload: { source: "startup" } }, ...WORKS], replies: WORKS });
		await pi.call("team_plan", { tasks: STAFF_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" });
		assert.match(await pi.call("team_review", { slug: "rename-key", verdict: "accept" }), /stopped idle `builder-1`/);
		await pi.emit("session_shutdown", { reason: "quit" });

		const again = fakePi(roots, { cwd: repo, entries: pi.allEntries(), claude: pi.claude });
		await again.emit("session_start", { reason: "startup" });

		assert.equal(counted(dir, "teammate-crashed"), 0);
		assert.equal(pi.claude.launches().length, 2, "no Teammate starts past the cap");
		assert.ok(!again.sent.some((message) => /session ended/.test(message.content)), again.sent.map((message) => message.content).join("\n---\n"));
	});

	it("reads the SessionEnd of a `claude stop` pi died during, before the drop it was for went on record, as the end it is", async () => {
		const { roots, repo, pi, dir } = await renameReported();
		await until(() => counted(dir, "task-done") === 1, "builder-1 reports round 1");
		await pi.call("team_plan", { tasks: [{ slug: "rename-key-everywhere", role: "builder", goal: "Rename the key, docs too.", criteria: ["AC1"] }, { ...CREW_PLAN[1], dependsOn: ["rename-key-everywhere"] }, CREW_PLAN[2]] });
		await pi.emit("session_shutdown", { reason: "quit" });
		// pi died once `claude stop` was done, before the re-plan's lines went on record.
		const lines = readFileSync(join(dir, "effort.jsonl"), "utf8").split("\n").filter(Boolean);
		const replanned = lines.map((line) => JSON.parse(line).type).lastIndexOf("plan-written");
		writeFileSync(join(dir, "effort.jsonl"), `${lines.slice(0, replanned).join("\n")}\n`);

		const again = fakePi(roots, { cwd: repo, entries: pi.allEntries(), claude: pi.claude });
		await again.emit("session_start", { reason: "startup" });

		assert.equal(counted(dir, "teammate-crashed"), 1, "nothing on record claims the stop, and builder-1 is gone");
		assert.equal(counted(dir, "task-dropped"), 0, "the drop never happened: the Lead re-plans again");
		const [wake] = awayWakes(again.sent);
		assert.match(wake?.content ?? "", /`builder-1`'s session ended \(other\) during round 1 of Task `rename-key`/);
	});

	it("abandons a launch that never got in, leaving the Task planned and saying so once", async () => {
		const { roots, repo, pi, dir } = await crewApproved({ hooks: [] });
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		pi.claude.forget(BUILDER_1);
		await pi.emit("session_shutdown", { reason: "quit" });
		killedAfter(dir, "launch-intended");

		const again = fakePi(roots, { cwd: repo, entries: pi.allEntries(), claude: pi.claude });
		await again.emit("session_start", { reason: "startup" });

		assert.equal(pi.claude.launches().length, 1, "it isn't launched again");
		assert.equal(counted(dir, "launch-abandoned"), 1);
		assert.equal(counted(dir, "teammate-started"), 0);
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## rename-key\n(?:.*\n)*?- Status: planned/);
		assert.equal(again.sent.length, 1);
		assert.match(awayWakes(again.sent)[0].content, /builder-1/);
	});

	it("finishes an accept whose merge landed just before pi died: one merge commit, one accept, its worktree gone, one wake", async () => {
		const { roots, repo, pi, dir, workspace, task } = await isolatedReported();
		appendFileSync(join(dir, "effort.jsonl"), `${JSON.stringify({ type: "merge-intended", slug: "rename-key", branch: task.branch, into: `team/${CREW_EFFORT_ID}`, at: NOW.toISOString() })}\n`);
		git(workspace, "merge", "--no-ff", "-m", "Merge the Task", task.branch);
		const merged = git(workspace, "rev-parse", "HEAD");
		await pi.emit("session_shutdown", { reason: "quit" });

		const again = fakePi(roots, { cwd: repo, entries: pi.allEntries(), claude: pi.claude });
		await again.emit("session_start", { reason: "startup" });

		assert.equal(git(workspace, "rev-list", "--merges", "--count", "HEAD"), "1");
		assert.equal(git(workspace, "rev-parse", "HEAD"), merged);
		assert.equal(counted(dir, "task-accepted"), 1);
		assert.equal(effortLines(dir).find((line) => line.type === "task-accepted")?.merge, merged);
		assert.equal(existsSync(task.path), false);
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## rename-key\n[\s\S]*?- Status: accepted/);
		assert.equal(again.sent.length, 1);
		assert.match(awayWakes(again.sent)[0].content, /rename-key/);
	});

	it("finishes a sign-off `approvals.jsonl` records but the log doesn't: every Teammate stopped, the Effort ended once, and the session holds none", async () => {
		const { roots, repo, pi, dir, report, workspace } = await finalReported();
		const shortIds = effortLines(dir)
			.filter((line) => line.type === "teammate-session")
			.map((line) => line.shortId);
		appendFileSync(join(dir, "approvals.jsonl"), `${JSON.stringify({ act: "sign-off", request: "r2", report: sha(readFileSync(report)), at: NOW.toISOString() })}\n`);
		await pi.emit("session_shutdown", { reason: "quit" });

		const again = fakePi(roots, { cwd: repo, entries: pi.allEntries(), claude: pi.claude });
		await again.emit("session_start", { reason: "startup" });

		assert.equal(counted(dir, "effort-ended"), 1);
		assert.equal(approvals(dir).filter((record) => record.act === "sign-off").length, 1, "the sign-off isn't recorded again");
		const stops = pi.claude.calls().filter((argv) => argv[0] === "stop").map((argv) => argv[1]);
		assert.deepEqual(stops.sort(), [...shortIds].sort());
		assert.equal(existsSync(workspace), false);
		assert.deepEqual(
			again.activeTools().filter((name) => EFFORT_TOOL_NAMES.includes(name)),
			[],
		);
		assert.match(again.sent.map((message) => message.content).join("\n"), /[Ss]igned off.*holds no Effort now/s);
	});

	it("finishes a Brief change `approvals.jsonl` records whose brief.md a restart cut short", async () => {
		const { roots, repo, pi, dir } = await crewApproved();
		const draft = changedBrief(repo);
		writeFileSync(join(dir, "brief.draft.md"), draft);
		await pi.call("team_request_approval", { checkpoint: "brief-change", path: join(dir, "brief.draft.md"), affects: [] });
		const asked = effortLines(dir).filter((line) => line.type === "approval-requested").at(-1);
		appendFileSync(join(dir, "approvals.jsonl"), `${JSON.stringify({ act: "brief-change", request: asked?.id, brief: sha(draft), affects: [], at: NOW.toISOString() })}\n`);
		await pi.emit("session_shutdown", { reason: "quit" });

		const again = fakePi(roots, { cwd: repo, entries: pi.allEntries(), claude: pi.claude });
		await again.emit("session_start", { reason: "startup" });

		assert.equal(readFileSync(join(dir, "brief.md"), "utf8"), draft);
		assert.equal(effortLines(dir).filter((line) => line.type === "approval-answered").at(-1)?.id, asked?.id);
		assert.equal(approvals(dir).filter((record) => record.act === "brief-change").length, 1);
		assert.match(await again.call("team_status", {}), /crew-2026-11-02/);
	});

	it("names the Effort's records in the wake when another session adopts it", async () => {
		const { roots, repo, pi, dir } = await renameReported();
		await until(() => counted(dir, "task-done") === 1, "builder-1 reports round 1");
		await pi.emit("session_shutdown", { reason: "quit" });
		killedAfter(dir, "launch-intended");

		const other = fakePi(roots, { cwd: repo, sessionFile: join(roots.scratch, "other.jsonl"), claude: pi.claude });
		other.answer(CREW_EFFORT_ID);
		await other.team("resume");

		const [wake] = awayWakes(other.sent);
		assert.match(wake.content, new RegExp(`\\n\\nRead its records first: .*${join(dir, "brief.md").replaceAll("/", "\\/")}`));
		assert.ok(wake.content.includes(join(dir, "plan.md")), wake.content);
	});

	it("hands a request a Teammate held across the restart to the new Lead, whose answer reaches the hook", async () => {
		const { roots, repo, pi, request, hook } = await asking(PUBLISH);
		await pi.emit("session_shutdown", { reason: "quit" });

		const again = fakePi(roots, { cwd: repo, entries: pi.allEntries(), claude: pi.claude });
		await again.emit("session_start", { reason: "startup" });
		let answered = false;
		for (let tries = 0; tries < 250 && !answered; tries++) {
			answered = await again.call("team_answer", { request, decision: "deny", reason: "Not across a restart." }).then(
				() => true,
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return false;
				},
			);
		}

		assert.ok(answered, "the new Lead's answer reached the hook");
		assert.deepEqual(await printed(hook), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Not across a restart." } } });
		assert.deepEqual(again.sent, [], "nothing new to wake the Lead about");
	});

	it("rebuilds each Teammate's `takeover` marker from effort.jsonl, which pi may have stopped short of", async () => {
		const { roots, repo, pi, dir } = await renameReported();
		await until(() => counted(dir, "task-done") === 1, "builder-1 reports round 1");
		await pi.emit("session_shutdown", { reason: "quit" });
		const marker = join(dir, "teammates", "builder-1", "takeover");
		appendFileSync(join(dir, "effort.jsonl"), `${JSON.stringify({ type: "takeover-started", teammate: "builder-1", cursor: 99, trigger: { kind: "prompt" }, at: NOW.toISOString() })}\n`);

		const again = fakePi(roots, { cwd: repo, entries: pi.allEntries(), claude: pi.claude });
		await again.emit("session_start", { reason: "startup" });
		assert.ok(existsSync(marker), "the hook leaves its prompts to the human again");

		await again.emit("session_shutdown", { reason: "quit" });
		appendFileSync(join(dir, "effort.jsonl"), `${JSON.stringify({ type: "takeover-ended", teammate: "builder-1", by: "pi", at: NOW.toISOString() })}\n`);
		const third = fakePi(roots, { cwd: repo, entries: again.allEntries(), claude: pi.claude });
		await third.emit("session_start", { reason: "startup" });
		assert.equal(existsSync(marker), false, "the hand-back's marker removal is finished");
	});

	/** builder-1 started afresh on `update-docs` after a Brief change, and pi killed just after writing that launch's intent; with the journal's line count before it. */
	async function relaunchKilled() {
		const crew = await crewPlanned();
		const { pi, dir, repo } = crew;
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		writeFileSync(join(dir, "brief.draft.md"), changedBrief(repo, BUILDER_ON_SONNET));
		await pi.call("team_request_approval", { checkpoint: "brief-change", path: join(dir, "brief.draft.md"), affects: [] });
		pi.answer("Approve");
		await pi.team("pending");
		await until(() => teammateWakes(pi.sent).length === 1, "rename-key has a result");
		await pi.call("team_review", { slug: "rename-key", verdict: "accept" });
		const journal = join(dir, "teammates", "builder-1", "events.jsonl");
		const before = readFileSync(journal, "utf8").split("\n").filter(Boolean).length;
		await pi.call("team_handoff", { slug: "update-docs", body: "# Docs\n" });
		await until(() => teammateWakes(pi.sent).length === 2, "update-docs has a result");
		await pi.emit("session_shutdown", { reason: "quit" });
		const lines = readFileSync(join(dir, "effort.jsonl"), "utf8").split("\n").filter(Boolean);
		const last = lines.map((line) => JSON.parse(line).type).lastIndexOf("launch-intended");
		writeFileSync(join(dir, "effort.jsonl"), `${lines.slice(0, last + 1).join("\n")}\n`);
		return { ...crew, journal, before };
	}

	it("takes a Teammate started afresh in from its new session's SessionStart, once, and doesn't start it again", async () => {
		const { roots, repo, pi, dir } = await relaunchKilled();

		const again = fakePi(roots, { cwd: repo, entries: pi.allEntries(), claude: pi.claude });
		await again.emit("session_start", { reason: "startup" });

		assert.equal(pi.claude.launches().length, 2, "no third session");
		assert.equal(counted(dir, "teammate-relaunched"), 1);
		assert.equal(counted(dir, "launch-abandoned"), 0);
		assert.equal(counted(dir, "teammate-session"), 2);
		assert.equal(counted(dir, "task-done"), 2, "its new session's journal is replayed: update-docs has its result");
	});

	it("abandons a fresh start its new session never journaled, though `claude agents --json` lists the name its old session had too", async () => {
		const { roots, repo, pi, dir, journal, before } = await relaunchKilled();
		writeFileSync(journal, `${readFileSync(journal, "utf8").split("\n").filter(Boolean).slice(0, before).join("\n")}\n`);
		assert.ok(pi.claude.agents().some((agent) => agent.name === BUILDER_1));

		const again = fakePi(roots, { cwd: repo, entries: pi.allEntries(), claude: pi.claude });
		await again.emit("session_start", { reason: "startup" });

		assert.equal(counted(dir, "launch-abandoned"), 1);
		assert.equal(counted(dir, "teammate-relaunched"), 0);
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## update-docs\n(?:.*\n)*?- Status: planned/);
		assert.match(awayWakes(again.sent)[0]?.content ?? "", /`builder-1` wasn't started afresh before pi stopped/);
	});
});

/** {@link crewBrief} with AC2 changed, and `frontmatter` lines added: a Brief change the Lead drafts. */
function changedBrief(repo: string, frontmatter: string[] = [], playbook = CREW_PLAYBOOK): string {
	return crewBrief(repo, playbook, frontmatter).replace("Old configs still load.", "Old configs still load, with a warning.");
}

/** The crew Effort, approved and planned, with every Teammate working each Task it gets. */
async function crewPlanned(options: Parameters<typeof crewApproved>[0] = {}) {
	const crew = await crewApproved({ hooks: [{ event: "SessionStart", payload: { source: "startup" } }, ...WORKS], replies: WORKS, ...options });
	await crew.pi.call("team_plan", { tasks: STAFF_PLAN });
	return crew;
}

describe("Brief changes: team_request_approval at `brief-change`", () => {
	it("holds only the Tasks it affects: a handoff of one queues until the human answers, while the others hand off", async () => {
		const { pi, dir, repo } = await crewPlanned();
		writeFileSync(join(dir, "brief.draft.md"), changedBrief(repo));

		const asked = await pi.call("team_request_approval", { checkpoint: "brief-change", path: join(dir, "brief.draft.md"), affects: ["survey"] });

		assert.match(asked, /Brief change of Effort `crew-2026-11-02` as request `r2`/);
		assert.match(asked, /holds Task `survey`/);
		const held = await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" });
		assert.match(held, /^queued Task `survey` \(tasks\/001-scout-survey\/task\.md\): held by Brief change `r2`/);
		const started = await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		assert.match(started, /^started builder-1 on Task `rename-key`/);
		assert.equal(pi.claude.launches().length, 1);
		await until(() => teammateWakes(pi.sent).length === 1, "the unaffected Task runs to its result");
	});

	it("shows in the dialog each Playbook entry the change newly skips, with its reason on one line, and not those the approved Brief already skips", async () => {
		const lockfile = ["  - rule: lockfile", "    change: skip", "    reason: The lockfile is regenerated."];
		const { pi, dir, repo } = await crewPlanned({ overrides: ["overrides:", ...lockfile] });
		const added = ["  - rule: small-diffs", "    change: skip", "    reason: |", "      The rename", "      touches every file."];
		writeFileSync(join(dir, "brief.draft.md"), changedBrief(repo, ["overrides:", ...lockfile, ...added]));
		await pi.call("team_request_approval", { checkpoint: "brief-change", path: join(dir, "brief.draft.md"), affects: [] });

		pi.answer("Later");
		await pi.team("pending");

		const title = pi.dialogs.at(-1)?.title ?? "";
		assert.match(title, /Playbook entries this change newly skips:\n- `small-diffs`: The rename touches every file\.\n/);
		assert.equal(title.includes("`lockfile`"), false, title);
	});

	it("approval promotes the draft to brief.md, records it with its sha and releases the held Tasks", async () => {
		const { pi, dir, repo } = await crewPlanned();
		const text = changedBrief(repo);
		writeFileSync(join(dir, "brief.draft.md"), text);
		await pi.call("team_request_approval", { checkpoint: "brief-change", path: join(dir, "brief.draft.md"), affects: ["survey"] });
		await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" });
		const woken = pi.sent.length;

		pi.answer("Approve");
		await pi.team("pending");

		assert.equal(readFileSync(join(dir, "brief.md"), "utf8"), text);
		const record = approvals(dir).at(-1);
		assert.deepEqual({ act: record?.act, request: record?.request, brief: record?.brief, affects: record?.affects }, { act: "brief-change", request: "r2", brief: sha(text), affects: ["survey"] });
		const wake = pi.sent.slice(woken).find((message) => message.customType === "team-pending");
		assert.match(wake?.content ?? "", /approved the Brief change of Effort `crew-2026-11-02` \(request `r2`, sha256 [0-9a-f]{64}\)/);
		assert.match(wake?.content ?? "", /Task `survey` is released/);
		assert.equal(pi.claude.launches().length, 1);
		assert.match(pi.claude.launches()[0]?.argv.join(" ") ?? "", /--name team-crew-2026-11-02-scout-1/);
		// The Effort's records still check: a later Lead tool reads them.
		assert.match(await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" }), /^started builder-1/);
	});

	it("a held Task's result waits for the answer: team_review is refused until the change is approved", async () => {
		const { pi, dir, repo } = await renameReported();
		await until(() => teammateWakes(pi.sent).length === 1, "rename-key has a result");
		writeFileSync(join(dir, "brief.draft.md"), changedBrief(repo));
		await pi.call("team_request_approval", { checkpoint: "brief-change", path: join(dir, "brief.draft.md"), affects: ["rename-key"] });

		await assert.rejects(pi.call("team_review", { slug: "rename-key", verdict: "accept" }), /Task `rename-key` is held by Brief change `r2`/);

		pi.answer("Approve");
		await pi.team("pending");
		assert.match(await pi.call("team_review", { slug: "rename-key", verdict: "accept" }), /^Accepted Task `rename-key`/);
	});

	it("a send-back wakes the Lead with the note and keeps the Tasks held", async () => {
		const { pi, dir, repo } = await crewPlanned();
		writeFileSync(join(dir, "brief.draft.md"), changedBrief(repo));
		await pi.call("team_request_approval", { checkpoint: "brief-change", path: join(dir, "brief.draft.md"), affects: ["survey"] });
		const woken = pi.sent.length;

		pi.answer("Send back with a note", "Keep AC2 as it was.");
		await pi.team("pending");

		const wake = pi.sent.slice(woken).find((message) => message.customType === "team-pending");
		assert.match(wake?.content ?? "", /sent back the Brief change of Effort `crew-2026-11-02` \(request `r2`\) with this note:\n\nKeep AC2 as it was\./);
		assert.match(wake?.content ?? "", /Task `survey` stays held/);
		assert.match(await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" }), /held by Brief change `r2`/);
		assert.equal(approvals(dir).some((record) => record.act === "brief-change"), false);
		assert.notEqual(readFileSync(join(dir, "brief.md"), "utf8"), changedBrief(repo));
	});
});

describe("Brief changes: overrides", () => {
	afterEach(() => {
		for (const fake of holding.splice(0)) fake.release();
	});

	it("a grant an approved Brief change adds can be cited by team_answer for a floor request", async () => {
		const crew = await crewApproved({
			playbook: FLOOR_PLAYBOOK,
			hooks: [
				{ event: "SessionStart", payload: { source: "startup", session_id: "c0ffee12-0000-4000-8000-000000000001" } },
				{ event: "UserPromptSubmit", payload: { prompt: "New Task `rename-key`" } },
				{ event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "gh pr create --fill" } } },
			],
		});
		const { pi, dir, repo } = crew;
		holding.push(pi.claude);
		await pi.call("team_plan", { tasks: CREW_PLAN });
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		const held = () => effortLines(dir).filter((line) => line.type === "request-held");
		await until(() => held().length === 1, "the Lead holds the floor request");
		const request = String(held()[0]?.request);
		await assert.rejects(pi.call("team_answer", { request, decision: "allow", reason: "The PR the human reviews.", grant: "open-pr" }), /`push-effort-branch`, `delivery`/);

		const grant = ["overrides:", "  - rule: open-pr", '    change: "add grant: open the pull request the Delivery asks for"', "    reason: The human reviews every change as a PR."];
		writeFileSync(join(dir, "brief.draft.md"), changedBrief(repo, grant, FLOOR_PLAYBOOK));
		await pi.call("team_request_approval", { checkpoint: "brief-change", path: join(dir, "brief.draft.md"), affects: [] });
		pi.answer("Approve");
		await pi.team("pending");

		await pi.call("team_answer", { request, decision: "allow", reason: "The PR the human reviews.", grant: "open-pr" });
		const [hook] = pi.claude.held();
		await until(() => hook?.exitCode() !== undefined, "the held hook exits");
		assert.deepEqual(JSON.parse(hook?.output() ?? ""), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
	});

	it("refuses a Brief change whose override names a rule id the Effort's Playbook lacks, and nothing reaches the human", async () => {
		const { pi, dir, repo } = await crewPlanned();
		const unknown = ["overrides:", "  - rule: no-such-rule", "    change: skip", "    reason: It never fits."];
		writeFileSync(join(dir, "brief.draft.md"), changedBrief(repo, unknown));

		await assert.rejects(pi.call("team_request_approval", { checkpoint: "brief-change", path: join(dir, "brief.draft.md"), affects: ["survey"] }), /Brief change [\s\S]* can't be asked about[\s\S]*`no-such-rule`/);

		await pi.team("pending");
		assert.equal(pi.notifications.at(-1)?.message, "Nothing is waiting on you.");
		assert.match(await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" }), /^started scout-1/);
	});
});

describe("approvals at a Playbook checkpoint or `escalate` id", () => {
	const CHECKPOINT_PLAYBOOK = CREW_PLAYBOOK.replace("---\npermissions:", "---\ncheckpoints:\n  - id: design-review\n    when: the design is written\npermissions:");

	it("records an approved checkpoint with the sha of the file asked about, and wakes the Lead", async () => {
		const { pi, dir } = await crewPlanned({ playbook: CHECKPOINT_PLAYBOOK });
		const design = join(dir, "design.md");
		writeFileSync(design, "# Design\n\nRename in place.\n");
		await assert.rejects(pi.call("team_request_approval", { checkpoint: "no-such-checkpoint", path: design }), /no checkpoint `no-such-checkpoint`.*`brief-change`, `design-review`, `history-rewrite`, `lockfile`/s);
		await assert.rejects(pi.call("team_request_approval", { checkpoint: "design-review", path: design, affects: [] }), /`affects` .* only with checkpoint `brief-change`/);
		assert.match(await pi.call("team_request_approval", { checkpoint: "design-review", path: design }), /checkpoint `design-review` of Effort `crew-2026-11-02` as request `r2`/);
		const woken = pi.sent.length;

		pi.answer("Approve");
		await pi.team("pending");

		const record = approvals(dir).at(-1);
		assert.deepEqual({ ...record, at: undefined }, { act: "checkpoint", checkpoint: "design-review", request: "r2", path: design, sha256: sha("# Design\n\nRename in place.\n"), at: undefined });
		const wake = pi.sent.slice(woken).find((message) => message.customType === "team-pending");
		assert.match(wake?.content ?? "", /approved checkpoint `design-review`/);
	});

	it("an `escalate` id is asked like a checkpoint, and a send-back wakes the Lead with the note and records nothing", async () => {
		const { pi, dir } = await crewPlanned({ playbook: CHECKPOINT_PLAYBOOK });
		const plan = join(dir, "rebase-plan.md");
		writeFileSync(plan, "# Rebase onto main\n");
		await pi.call("team_request_approval", { checkpoint: "history-rewrite", path: plan });
		const woken = pi.sent.length;

		pi.answer("Send back with a note", "Merge instead.");
		await pi.team("pending");

		const wake = pi.sent.slice(woken).find((message) => message.customType === "team-pending");
		assert.match(wake?.content ?? "", /sent back checkpoint `history-rewrite` .*with this note:\n\nMerge instead\./s);
		assert.equal(approvals(dir).some((record) => record.act === "checkpoint"), false);
	});
});

/** The Brief change that gives Role `builder` model `sonnet`: a change to its launch options. */
const BUILDER_ON_SONNET = ["roles:", "  builder:", "    model: sonnet"];

describe("Brief changes: fresh sessions", () => {
	it("a change to a Role's launch options starts its Teammate afresh at its next Task, never mid-Task, keeping its id and marking its short id (new)", async () => {
		const { pi, dir, repo } = await crewPlanned();
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		const [first] = effortLines(dir).filter((line) => line.type === "teammate-session");
		writeFileSync(join(dir, "brief.draft.md"), changedBrief(repo, BUILDER_ON_SONNET));
		await pi.call("team_request_approval", { checkpoint: "brief-change", path: join(dir, "brief.draft.md"), affects: [] });
		const woken = pi.sent.length;

		pi.answer("Approve");
		await pi.team("pending");

		const wake = pi.sent.slice(woken).find((message) => message.customType === "team-pending");
		assert.match(wake?.content ?? "", /`builder-1` starts in a fresh session at its next Task/);
		assert.equal(pi.claude.launches().length, 1, "nothing restarts mid-Task");
		assert.deepEqual(pi.claude.calls().filter((argv) => argv[0] === "stop"), []);

		await until(() => teammateWakes(pi.sent).length === 1, "rename-key has a result");
		await pi.call("team_review", { slug: "rename-key", verdict: "accept" });
		const reply = await pi.call("team_handoff", { slug: "update-docs", body: "# Docs\n" });

		assert.match(reply, /^started builder-1 afresh on Task `update-docs` \(tasks\/002-builder-update-docs\/task\.md\)/);
		assert.deepEqual(pi.claude.calls().filter((argv) => argv[0] === "stop"), [["stop", first.shortId]]);
		assert.equal(pi.claude.launches().length, 2);
		const argv = pi.claude.launches()[1]?.argv ?? [];
		assert.equal(argv[argv.indexOf("--model") + 1], "sonnet");
		assert.equal(argv[argv.indexOf("--effort") + 1], "high", "what the change leaves alone stays");
		assert.equal(argv[argv.indexOf("--name") + 1], BUILDER_1);
		await until(() => teammateWakes(pi.sent).length === 2, "update-docs has a result");
		const sessions = effortLines(dir).filter((line) => line.type === "teammate-session");
		assert.equal(sessions.length, 2);
		assert.notEqual(sessions[1].shortId, first.shortId);
		assert.equal(effortLines(dir).filter((line) => line.type === "teammate-started").length, 1, "the id is kept");
		assert.ok(
			teamBlock(pi)?.some((line) => line.includes("builder-1") && line.includes(`${sessions[1].shortId} (new)`)),
			JSON.stringify(teamBlock(pi)),
		);
		assert.equal(effortLines(dir).some((line) => line.type === "teammate-crashed"), false);
	});

	it("the final Report names the model each Task's Teammate was launched on, not the Role's model after a Brief change", async () => {
		const { pi, dir, repo } = await crewPlanned();
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		const first = pi.claude.launches()[0]?.argv ?? [];
		assert.equal(first[first.indexOf("--model") + 1], "opus");
		writeFileSync(join(dir, "brief.draft.md"), changedBrief(repo, BUILDER_ON_SONNET));
		await pi.call("team_request_approval", { checkpoint: "brief-change", path: join(dir, "brief.draft.md"), affects: [] });
		pi.answer("Approve");
		await pi.team("pending");
		await until(() => teammateWakes(pi.sent).length === 1, "rename-key has a result");
		await pi.call("team_review", { slug: "rename-key", verdict: "accept" });
		// builder-1 starts afresh on the new model for its next Task.
		await pi.call("team_handoff", { slug: "update-docs", body: "# Docs\n" });

		await pi.call("team_report", { headline: "Both criteria are met.", coverage: FINAL_COVERAGE, final: true });

		const written = readFileSync(join(dir, "reports", "001.md"), "utf8");
		for (const needed of ["- `rename-key` (builder, on `opus`): accepted", "- `update-docs` (builder, on `sonnet`): in review", "- `survey` (scout): planned"]) {
			assert.ok(written.includes(needed), `reports/001.md doesn't say ${needed}:\n${written}`);
		}
	});

	it("a Brief change that leaves the launch options alone reuses the Teammate with a clear", async () => {
		const { pi, dir, repo } = await crewPlanned();
		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		writeFileSync(join(dir, "brief.draft.md"), changedBrief(repo, ["roles:", "  builder:", "    model: opus"]));
		await pi.call("team_request_approval", { checkpoint: "brief-change", path: join(dir, "brief.draft.md"), affects: [] });
		pi.answer("Approve");
		await pi.team("pending");
		await until(() => teammateWakes(pi.sent).length === 1, "rename-key has a result");
		await pi.call("team_review", { slug: "rename-key", verdict: "accept" });

		assert.match(await pi.call("team_handoff", { slug: "update-docs", body: "# Docs\n" }), /^reused builder-1 on Task `update-docs`/);
		assert.equal(pi.claude.launches().length, 1);
	});

	it("a Brief that sets launch options for a Role the Team doesn't have is refused at the request", async () => {
		const { pi, dir, repo } = await crewPlanned();
		writeFileSync(join(dir, "brief.draft.md"), changedBrief(repo, ["roles:", "  tester:", "    model: sonnet"]));

		await assert.rejects(
			pi.call("team_request_approval", { checkpoint: "brief-change", path: join(dir, "brief.draft.md"), affects: [] }),
			/`roles` names `tester`, which isn't a Role of the Team; the Roles are `builder`, `reviewer`, `scout`/,
		);
	});
});
