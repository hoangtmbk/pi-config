/**
 * The pi surface: `/team` through a recording fake pi, with every path root a
 * temp folder and `claude` the fake.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CLEAR_MARKER, HOOK_SCRIPT } from "../claude.ts";
import { registerTeam } from "../index.ts";
import { commit, type FakeHookStep, fakeClaude, git, gitRepo, goodTeam, roleMd, type TempRoots, teamMd, tempRoots, writeFiles, writeUserTeam } from "./harness.ts";

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
	answer: string | boolean | undefined;
}

interface RegisteredTool {
	name: string;
	defaultActive?: boolean;
	execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: { type: string; text: string }[] }>;
}

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
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
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
	const claude = fakeClaude(roots, { version: options.claudeVersion, bgExit: options.bgExit, hooks: options.hooks, replies: options.replies });
	registerTeam(pi as unknown as ExtensionAPI, {
		agentDir: roots.agentDir,
		claudeConfigPath: roots.claudeConfigPath,
		claudePath: claude.path,
		now: () => NOW,
		pid: options.pid,
		sleep: async (ms: number) => {
			sleeps.push(ms);
		},
	});
	function answer(kind: Dialog["kind"], title: string, choices?: string[]) {
		assert.ok(answers.length > 0, `the extension opened a ${kind} dialog "${title}" the test has no answer for`);
		const played = answers.shift();
		dialogs.push({ kind, title, options: choices, answer: played });
		return played;
	}
	const ctx = {
		hasUI: options.hasUI ?? true,
		cwd: options.cwd ?? roots.scratch,
		isIdle: () => !options.streaming,
		sessionManager: {
			getSessionFile: () => sessionFile,
			getEntries: () => [...carried, ...entries].map((entry, index) => ({ type: "custom", id: `e${index}`, ...entry })),
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
			async confirm(title: string) {
				return answer("confirm", title);
			},
			setWidget(key: string, lines: string[] | undefined, widgetOptions?: { placement?: string }) {
				widgets.push({ key, lines, placement: widgetOptions?.placement });
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
		activeTools: () => [...activeTools],
		claude,
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
	};
}

describe("/team", () => {
	it("registers one `team` command", () => {
		const pi = fakePi(tempRoots());

		assert.deepEqual([...pi.commands.keys()], ["team"]);
		assert.match(pi.commands.get("team")?.description ?? "", /start/);
	});

	it("names the subcommands when given one it doesn't know, or none", async () => {
		const pi = fakePi(tempRoots());

		await pi.team("launch software");
		await pi.team("");

		assert.deepEqual(pi.notifications, [
			{ message: "Unknown `/team` subcommand `launch`. Subcommands: `start`, `setup`, `pending`, `resume`.", type: "error" },
			{ message: "`/team` needs a subcommand. Subcommands: `start`, `setup`, `pending`, `resume`.", type: "error" },
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
		assert.deepEqual(pi.activeTools(), [...PI_TOOLS, "team_request_approval", "team_plan", "team_handoff", "team_review", "team_status"]);
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
function intakeSession(roots = tempRoots()) {
	adopt(roots, "software", INTAKE_PLAYBOOK);
	const repo = gitRepo(roots);
	return { roots, repo, pi: fakePi(roots, { cwd: repo }) };
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
		assert.deepEqual(pi.activeTools(), [...PI_TOOLS, "team_request_approval", "team_plan", "team_handoff", "team_review", "team_status"]);
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

/** A Brief for the `crew` Team with criteria `AC1` and `AC2`. */
function crewBrief(repo: string): string {
	return [
		"---",
		"team: crew",
		`playbook: ${sha(CREW_PLAYBOOK)}`,
		`repo: ${repo}`,
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
async function crewApproved(options: { bgExit?: number; hooks?: FakeHookStep[]; replies?: FakeHookStep[]; settings?: Record<string, unknown> } = {}) {
	const roots = tempRoots();
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
	adopt(roots, "crew", CREW_PLAYBOOK);
	const repo = gitRepo(roots);
	const pi = fakePi(roots, { cwd: repo, bgExit: options.bgExit, hooks: options.hooks, replies: options.replies, settings: options.settings });
	await pi.team("start crew");
	const dir = effortDir(roots, CREW_EFFORT_ID);
	writeFileSync(join(dir, "brief.draft.md"), crewBrief(repo));
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

	it("gives the Teammate settings that add the hooks, the Playbook's rules for its Role, every escalate ask and a deny on editing the Effort's records, and nothing that replaces the human's own", async () => {
		const { pi, dir } = await crewApproved();
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
		await pi.call("team_handoff", { slug: "survey", body: "# Survey\n" });

		const hooks = (id: string) => {
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
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }],
			};
		};
		const records = ["brief.md", "clarifications.md", "approvals.jsonl", "playbook.md", "team/**", "effort.jsonl"].map((record) => `Edit(/${dir}/${record})`);
		const ask = ["Bash(git rebase:*)", "Bash(git push --force:*)", "Edit(package-lock.json)"];
		const [builder, scout] = pi.claude.launches().map((launch) => JSON.parse(launch.settings ?? "null"));
		assert.deepEqual(builder, {
			permissions: { allow: ["Bash(npm run build:*)", "Bash(git status)"], deny: ["Bash(npm publish:*)", "Bash(curl:*)", ...records], ask },
			crossSessionInbound: "accept",
			hooks: hooks("builder-1"),
		});
		assert.deepEqual(scout, {
			permissions: { allow: ["Bash(git status)"], deny: ["Bash(curl:*)", ...records], ask },
			crossSessionInbound: "accept",
			hooks: hooks("scout-1"),
		});
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
			join(dir, "brief.md"),
			join(dir, "clarifications.md"),
		];
		for (const fact of facts) assert.ok(prompt.includes(fact), `the preamble should say: ${fact}\n\n${prompt}`);
		assert.ok(prompt.trimEnd().endsWith("You are the builder."), prompt);
		assert.ok(!prompt.includes("Old configs still load"), "the preamble must not copy the Brief");
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

		assert.equal(readFileSync(join(dir, "effort.jsonl"), "utf8"), log);
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## rename-key\n(?:.*\n)*?- Status: planned/);
	});

	it("refuses an isolated Task, which needs a worktree of its own, without launching anything", async () => {
		const { pi, dir } = await crewApproved();
		await pi.call("team_plan", { tasks: CREW_PLAN });

		await assert.rejects(pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n", isolated: true }), /isolated/);

		assert.equal(pi.claude.launches().length, 0);
		assert.equal(existsSync(join(dir, "tasks")), false);
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

/** An approved crew Effort whose `rename-key` Task is handed off to `builder-1`, who has written round 1's result. */
async function renameReported(options: { hooks?: FakeHookStep[]; replies?: FakeHookStep[] } = {}) {
	const crew = await crewApproved({ hooks: options.hooks ?? [{ event: "SessionStart", payload: { source: "startup" } }, ...WORKS], replies: options.replies ?? WORKS });
	await crew.pi.call("team_plan", { tasks: CREW_PLAN });
	await crew.pi.call("team_handoff", { slug: "rename-key", body: "# Rename\n" });
	return crew;
}

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

	it("tells the Lead when the pointer can't reach the Teammate's inbox", async () => {
		const { pi, dir } = await renameReported();
		const [session] = effortLines(dir).filter((line) => line.type === "teammate-session");
		unlinkSync((session.inbox as { socket: string }).socket);

		await assert.rejects(pi.call("team_review", { slug: "rename-key", verdict: "send_back", feedback: "Redo it." }), (error: Error) => {
			assert.match(error.message, /couldn't reach `builder-1`/);
			assert.match(error.message, /tell the human/);
			return true;
		});
		assert.match(readFileSync(join(dir, RENAME_DIR, "feedback-1.md"), "utf8"), /Redo it\./);
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
		assert.equal(pi.claude.launches()[1].argv.at(-1), newTaskPointer(dir, "survey", "002-scout-survey"));
		assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /## survey\n[\s\S]*?- Status: [a-z ]+, with `scout-1` \(tasks\/002-scout-survey\/\)/);
		assert.ok(!(teamBlock(pi) ?? []).some((line) => line.startsWith("│ builder-1")), "a stopped Teammate leaves the block");
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
			"│ builder-1  c0ffee12  busy  001-builder-rename-key  ctx —  auto≠acceptEdits │",
			"│ nothing waiting on you   reports 0                                         │",
			"╰────────────────────────────────────────────────────────────────────────────╯",
		]);
		assert.deepEqual(JSON.parse(await pi.call("team_status", {})), {
			effortId: "crew-2026-11-02",
			team: "crew",
			phase: "working",
			tasks: { accepted: 0, planned: 3 },
			teammates: [{ id: "builder-1", role: "builder", shortId: "c0ffee12", activity: "busy", task: "001-builder-rename-key", mode: "auto", launchMode: "acceptEdits" }],
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
		assert.equal(block.length, 6, block.join("\n"));
		assert.match(block[0], / 3 live ─╮$/);
		assert.match(block[2], /^│ builder-1 /);
		assert.match(block[3], /^│ \+2 more Teammates +│$/);
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
			assert.deepEqual(again.activeTools(), [...PI_TOOLS, "team_request_approval", "team_plan", "team_handoff", "team_review", "team_status"]);
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
