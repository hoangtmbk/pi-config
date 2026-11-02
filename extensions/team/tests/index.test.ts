/**
 * The pi surface: `/team` through a recording fake pi, with every path root a
 * temp folder and `claude` the fake.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * A pi that records what the extension registers and says, with a command
 * context whose toasts are recorded too.
 */
function fakePi(roots: TempRoots, options: { claudeVersion?: string } = {}) {
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const sent: SentMessage[] = [];
	const notifications: Notification[] = [];
	const pi = {
		registerCommand(name: string, command: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
			commands.set(name, command);
		},
		sendMessage(message: { customType: string; content: string; display?: boolean }, sendOptions?: { triggerTurn?: boolean; deliverAs?: string }) {
			sent.push({ ...message, triggerTurn: sendOptions?.triggerTurn, deliverAs: sendOptions?.deliverAs });
		},
	};
	const claude = fakeClaude(roots, { version: options.claudeVersion });
	registerTeam(pi as unknown as ExtensionAPI, { agentDir: roots.agentDir, claudeConfigPath: roots.claudeConfigPath, claudePath: claude.path });
	const ctx = {
		hasUI: true,
		isIdle: () => true,
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
		},
	} as unknown as ExtensionCommandContext;

	return {
		commands,
		sent,
		notifications,
		claude,
		/** Run `/team <args>` the way pi does when the human types it. */
		async team(args: string): Promise<void> {
			const command = commands.get("team");
			assert.ok(command, "expected a `team` command");
			await command.handler(args, ctx);
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
			{ message: "Unknown `/team` subcommand `launch`. Subcommands: `start`.", type: "error" },
			{ message: "`/team` needs a subcommand. Subcommands: `start`.", type: "error" },
		]);
	});
});

describe("/team start <team>", () => {
	it("picks a Team that loads cleanly, saying what it has and whether its Playbook is adopted", async () => {
		const pi = fakePi(tempRoots());

		await pi.team("start software");

		assert.deepEqual(pi.notifications, [
			{
				message:
					"Team `software` picked: Roles `architect`, `dev`, `qa`. Playbook: not adopted yet, so the Team's default Playbook is what setup would start from.",
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

	it("says a Playbook edited after adoption no longer counts as adopted", async () => {
		const roots = tempRoots();
		const playbooks = writeFiles(join(roots.agentDir, "team", "playbooks"), {
			"software.md": "---\nsendBackLimit: 1\n---\nedited\n",
			"software.adopted.json": JSON.stringify({ sha256: "0".repeat(64), adoptedAt: "2026-11-01T09:00:00.000Z" }),
		});
		const pi = fakePi(roots);

		await pi.team("start software");

		assert.equal(
			pi.notifications[0].message,
			`Team \`software\` picked: Roles \`architect\`, \`dev\`, \`qa\`. Playbook: ${join(playbooks, "software.md")} was edited after it was adopted, so it counts as not adopted until it is adopted again.`,
		);
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

describe("the package manifest", () => {
	it("loads the team extension beside the others", () => {
		const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { pi: { extensions: string[] } };

		assert.ok(manifest.pi.extensions.includes("./extensions/team/index.ts"), manifest.pi.extensions.join(", "));
	});
});
