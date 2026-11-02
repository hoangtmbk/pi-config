/**
 * The pi surface: `/team` through a recording fake pi, with every path root a
 * temp folder and `claude` the fake.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerTeam } from "../index.ts";
import { fakeClaude, gitRepo, goodTeam, roleMd, type TempRoots, tempRoots, writeFiles, writeUserTeam } from "./harness.ts";

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

/** The tools pi itself has on before the extension changes anything. */
const PI_TOOLS = ["read", "bash", "edit", "write"];

/** The clock the extension reads, fixed so adoption times are known. */
const NOW = new Date("2026-11-02T10:00:00.000Z");

/**
 * A pi that records what the extension registers and says, with a command
 * context whose toasts are recorded too and whose dialogs answer from a queue
 * the test fills, the way the human would.
 */
function fakePi(roots: TempRoots, options: { claudeVersion?: string; streaming?: boolean; cwd?: string } = {}) {
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const tools = new Map<string, RegisteredTool>();
	const sent: SentMessage[] = [];
	const notifications: Notification[] = [];
	const dialogs: Dialog[] = [];
	const answers: (string | boolean | undefined)[] = [];
	let activeTools = [...PI_TOOLS];
	const activations: string[][] = [];
	const entries: { customType: string; data: unknown }[] = [];
	const pi = {
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
	};
	const claude = fakeClaude(roots, { version: options.claudeVersion });
	registerTeam(pi as unknown as ExtensionAPI, {
		agentDir: roots.agentDir,
		claudeConfigPath: roots.claudeConfigPath,
		claudePath: claude.path,
		now: () => NOW,
	});
	function answer(kind: Dialog["kind"], title: string, choices?: string[]) {
		assert.ok(answers.length > 0, `the extension opened a ${kind} dialog "${title}" the test has no answer for`);
		const played = answers.shift();
		dialogs.push({ kind, title, options: choices, answer: played });
		return played;
	}
	const ctx = {
		hasUI: true,
		cwd: options.cwd ?? roots.scratch,
		isIdle: () => !options.streaming,
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
		activeTools: () => [...activeTools],
		claude,
		/** Queue the human's answers to the next dialogs, in order. */
		answer(...played: (string | boolean | undefined)[]) {
			answers.push(...played);
		},
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
			{ message: "Unknown `/team` subcommand `launch`. Subcommands: `start`, `setup`, `pending`.", type: "error" },
			{ message: "`/team` needs a subcommand. Subcommands: `start`, `setup`, `pending`.", type: "error" },
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
		assert.deepEqual(pi.activeTools(), [...PI_TOOLS, "team_request_approval", "team_plan", "team_handoff"]);
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
		assert.deepEqual(pi.activeTools(), [...PI_TOOLS, "team_request_approval", "team_plan", "team_handoff"]);
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

describe("the package manifest", () => {
	it("loads the team extension beside the others", () => {
		const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { pi: { extensions: string[] } };

		assert.ok(manifest.pi.extensions.includes("./extensions/team/index.ts"), manifest.pi.extensions.join(", "));
	});
});
