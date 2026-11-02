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
import { fakeClaude, goodTeam, roleMd, type TempRoots, tempRoots, writeFiles, writeUserTeam } from "./harness.ts";

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
function fakePi(roots: TempRoots, options: { claudeVersion?: string; streaming?: boolean } = {}) {
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const tools = new Map<string, RegisteredTool>();
	const sent: SentMessage[] = [];
	const notifications: Notification[] = [];
	const dialogs: Dialog[] = [];
	const answers: (string | boolean | undefined)[] = [];
	let activeTools = [...PI_TOOLS];
	const activations: string[][] = [];
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
		cwd: roots.scratch,
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
	it("picks a Team that loads cleanly, saying what it has and when its Playbook was adopted", async () => {
		const roots = tempRoots();
		adopt(roots, "software", "---\nsendBackLimit: 1\n---\n");
		const pi = fakePi(roots);

		await pi.team("start software");

		assert.deepEqual(pi.notifications, [
			{
				message: `Team \`software\` picked: Roles \`architect\`, \`dev\`, \`qa\`. Playbook: adopted 2026-11-01T09:00:00.000Z (${join(playbooksDir(roots), "software.md")}).`,
				type: "info",
			},
		]);
		assert.deepEqual(pi.sent, []);
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
		const pi = fakePi(roots);
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
	it("starts Team setup first, then continues once the Playbook is adopted", async () => {
		const roots = tempRoots();
		const pi = fakePi(roots);

		await pi.team("start software");

		assert.equal(pi.notifications.length, 1);
		assert.equal(pi.notifications[0].type, "info");
		assert.match(pi.notifications[0].message, /Team `software` has no adopted Playbook, so Team setup runs first/);
		assert.equal(pi.sent.at(-1)?.customType, "team-setup");
		assert.deepEqual(pi.activations, [[...PI_TOOLS, "team_request_approval"]]);

		await pi.call("team_request_approval", { checkpoint: "adopt-playbook", path: draftPath(roots, "software") });
		pi.answer("Approve");
		await pi.team("pending");

		assert.match(pi.notifications.at(-1)?.message ?? "", /^Team `software` picked: .*Playbook: adopted 2026-11-02T10:00:00\.000Z/);
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
