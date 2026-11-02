/**
 * Definitions: Teams, Roles and Playbooks read from real directories.
 *
 * Every Team here is a real folder in a temp root, written from the table row
 * that describes it, so each row shows the exact file that is good or bad and
 * the test reads it through the same loader `/team start` uses.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { listTeams, loadTeam } from "../definitions.ts";
import { goodTeam, markdown, roleMd, type TeamFiles, type TempRoots, teamMd, tempRoots, writeFiles, writeUserTeam } from "./harness.ts";

describe("the bundled software Team", () => {
	it("loads with no config errors, with its three Roles and its default Playbook", () => {
		const roots = tempRoots();

		const team = loadTeam(roots, "software");

		assert.ok(team, "expected the bundled software Team");
		assert.deepEqual(team.problems, []);
		assert.equal(team.source, "bundled");
		assert.equal(team.workspace, "git-worktree");
		assert.deepEqual(
			team.roles.map((role) => [role.name, role.model, role.effort]),
			[
				["architect", "opus", "high"],
				["dev", "sonnet", "medium"],
				["qa", "sonnet", "high"],
			],
		);
		assert.deepEqual(team.roles[0].disallowedTools, ["Bash(git commit:*)", "Bash(git push:*)"]);
		assert.ok(team.defaultPlaybook, "expected a default Playbook");
		assert.equal(team.defaultPlaybook.sendBackLimit, 2);
		assert.deepEqual(
			team.defaultPlaybook.checkpoints.map((checkpoint) => checkpoint.id),
			["design-review", "new-dependency", "ci-and-release"],
		);
		assert.deepEqual(
			team.defaultPlaybook.escalate.map((entry) => entry.id),
			["history-rewrite"],
		);
		assert.deepEqual(team.defaultPlaybook.grants, []);
		assert.deepEqual(team.defaultPlaybook.roles, {});
		assert.deepEqual(team.defaultPlaybook.rules, [
			"one-architect",
			"parallel-devs-disjoint",
			"design-first",
			"review-against-design",
			"qa-before-signoff",
			"feedback-is-specific",
			"criteria-are-the-humans",
			"scope-creep",
			"one-branch",
		]);
		assert.deepEqual(listTeams(roots).map((listed) => listed.name), ["software"]);
	});
});

describe("where Teams come from", () => {
	it("a user Team with a bundled Team's name replaces it whole, Roles and Playbook included", () => {
		const roots = tempRoots();
		writeUserTeam(roots, "software", goodTeam("software"));

		const team = loadTeam(roots, "software");

		assert.ok(team);
		assert.deepEqual(team.problems, []);
		assert.equal(team.source, "user");
		assert.deepEqual(team.roles.map((role) => role.name), ["worker"]);
		assert.equal(team.defaultPlaybook, undefined);
	});

	it("lists bundled and user Teams together, sorted by name", () => {
		const roots = tempRoots();
		writeUserTeam(roots, "writing", goodTeam("writing"));
		writeUserTeam(roots, "audit", goodTeam("audit"));

		assert.deepEqual(
			listTeams(roots).map((team) => [team.name, team.source]),
			[
				["audit", "user"],
				["software", "bundled"],
				["writing", "user"],
			],
		);
	});

	it("never reads Teams from the checkout pi runs in", () => {
		const roots = tempRoots();
		const previous = process.cwd();
		writeFiles(join(roots.scratch, ".pi", "teams", "repo-team"), goodTeam("repo-team"));
		writeFiles(join(roots.scratch, "teams", "repo-team"), goodTeam("repo-team"));
		process.chdir(roots.scratch);
		try {
			assert.deepEqual(listTeams(roots).map((team) => team.name), ["software"]);
		} finally {
			process.chdir(previous);
		}
	});

	it("is undefined for a name no Team has", () => {
		assert.equal(loadTeam(tempRoots(), "nope"), undefined);
	});
});

/** The reasons a user Team's problems give, each with the file it names relative to the Team's folder. */
function problemsOf(roots: TempRoots, name: string): string[] {
	const team = loadTeam(roots, name);
	assert.ok(team, `expected a Team named ${name}`);
	return team.problems.map((problem) => `${relative(team.dir, problem.filePath)}: ${problem.reason}`);
}

describe("a Team that is wrong is listed with its problems, each naming the file", () => {
	const cases: { name: string; files: TeamFiles; expect: RegExp[] }[] = [
		{
			name: "team.md is missing",
			files: { "roles/worker.md": roleMd("worker") },
			expect: [/^team\.md: is missing/],
		},
		{
			name: "team.md's name differs from its folder",
			files: goodTeam("broken", { "team.md": teamMd("other") }),
			expect: [/^team\.md: `name: other` must match the Team's folder, `broken`/],
		},
		{
			name: "team.md has an unknown field",
			files: goodTeam("broken", { "team.md": teamMd("broken", "colour: blue") }),
			expect: [/^team\.md: unknown field `colour`.*`name`, `description`, `workspace`/],
		},
		{
			name: "team.md asks for a Workspace kind that doesn't exist",
			files: goodTeam("broken", {
				"team.md": markdown("name: broken\ndescription: A Team.\nworkspace: docker"),
			}),
			expect: [/^team\.md: `workspace` must be one of `git-worktree`, not `docker`/],
		},
		{
			name: "team.md has no description",
			files: goodTeam("broken", { "team.md": markdown("name: broken\nworkspace: git-worktree") }),
			expect: [/^team\.md: needs a `description`/],
		},
		{
			name: "there are no Roles",
			files: { "team.md": teamMd("broken") },
			expect: [/^roles: holds no Roles/],
		},
		{
			name: "a Role has an unknown field",
			files: goodTeam("broken", { "roles/worker.md": roleMd("worker", "temperature: 0.2") }),
			expect: [/^roles\/worker\.md: unknown field `temperature`.*`permissionMode`/],
		},
		{
			name: "a Role lacks a name",
			files: goodTeam("broken", { "roles/worker.md": markdown("description: Works."), }),
			expect: [/^roles\/worker\.md: needs a `name` matching the file name, `worker`/],
		},
		{
			name: "a Role's name differs from its file",
			files: goodTeam("broken", { "roles/worker.md": roleMd("builder") }),
			expect: [/^roles\/worker\.md: `name: builder` must match the file name, `worker`/],
		},
		{
			name: "a Role lacks a description",
			files: goodTeam("broken", { "roles/worker.md": markdown("name: worker") }),
			expect: [/^roles\/worker\.md: needs a `description`/],
		},
		{
			name: "a Role asks for plan mode",
			files: goodTeam("broken", { "roles/worker.md": roleMd("worker", "permissionMode: plan") }),
			expect: [/^roles\/worker\.md: `permissionMode: plan` is not allowed.*a Task whose result is the plan/],
		},
		{
			name: "a Role asks for a permission mode that doesn't exist",
			files: goodTeam("broken", { "roles/worker.md": roleMd("worker", "permissionMode: yolo") }),
			expect: [/^roles\/worker\.md: `permissionMode` must be one of `auto`, `acceptEdits`, `manual`, `dontAsk`, `bypassPermissions`, not `yolo`/],
		},
		{
			name: "a Role's tools are not a list",
			files: goodTeam("broken", { "roles/worker.md": roleMd("worker", "allowedTools: Bash") }),
			expect: [/^roles\/worker\.md: `allowedTools` must be a YAML list/],
		},
		{
			name: "a Role's MCP servers are not a map of servers",
			files: goodTeam("broken", { "roles/worker.md": roleMd("worker", "mcpServers: [github]") }),
			expect: [/^roles\/worker\.md: `mcpServers` must be a mapping of server name to server config/],
		},
		{
			name: "a Role's frontmatter is not YAML",
			files: goodTeam("broken", { "roles/worker.md": "---\nname: [worker\n---\n" }),
			expect: [/^roles\/worker\.md: frontmatter is not valid YAML/],
		},
		{
			name: "a Role has several mistakes, all reported",
			files: goodTeam("broken", { "roles/worker.md": markdown("name: worker\npermissionMode: plan\nshell: zsh") }),
			expect: [/unknown field `shell`/, /needs a `description`/, /`permissionMode: plan` is not allowed/],
		},
	];

	for (const { name, files, expect } of cases) {
		it(name, () => {
			const roots = tempRoots();
			writeUserTeam(roots, "broken", files);

			const problems = problemsOf(roots, "broken");

			assert.equal(problems.length, expect.length, problems.join("\n"));
			expect.forEach((pattern, index) => assert.match(problems[index], pattern));
		});
	}

	it("one bad Role leaves the Team listed but short of nothing: the good Roles parse, the problem refuses it", () => {
		const roots = tempRoots();
		writeUserTeam(roots, "broken", goodTeam("broken", { "roles/reviewer.md": roleMd("reviewer", "permissionMode: plan") }));

		const team = loadTeam(roots, "broken");

		assert.ok(team);
		assert.deepEqual(team.roles.map((role) => role.name), ["worker"]);
		assert.equal(team.problems.length, 1);
	});

	it("a broken user Team doesn't hide the other Teams", () => {
		const roots = tempRoots();
		writeUserTeam(roots, "broken", { "team.md": "---\n: :\n---\n" });

		const teams = listTeams(roots);

		assert.deepEqual(teams.map((team) => [team.name, team.problems.length > 0]), [
			["broken", true],
			["software", false],
		]);
	});
});

describe("a Role's launch settings", () => {
	it("reads every field a Role may set", () => {
		const roots = tempRoots();
		writeUserTeam(
			roots,
			"full",
			goodTeam("full", {
				"roles/worker.md": roleMd(
					"worker",
					[
						"model: opus",
						"effort: max",
						'allowedTools: ["Bash(npm test:*)", "Read"]',
						'disallowedTools: ["WebFetch"]',
						"mcpServers:",
						"  github:",
						"    command: gh-mcp",
						"    args: [serve]",
						'plugins: ["/opt/plugins/lint"]',
						"permissionMode: acceptEdits",
					].join("\n"),
				),
			}),
		);

		const [role] = loadTeam(roots, "full")?.roles ?? [];

		assert.deepEqual(role, {
			name: "worker",
			description: "The worker on this Team.",
			model: "opus",
			effort: "max",
			allowedTools: ["Bash(npm test:*)", "Read"],
			disallowedTools: ["WebFetch"],
			mcpServers: { github: { command: "gh-mcp", args: ["serve"] } },
			plugins: ["/opt/plugins/lint"],
			permissionMode: "acceptEdits",
			prompt: "You are the worker.",
			filePath: join(roots.agentDir, "teams", "full", "roles", "worker.md"),
		});
	});

	it("accepts bypassPermissions in the human's own Team", () => {
		const roots = tempRoots();
		writeUserTeam(roots, "mine", goodTeam("mine", { "roles/worker.md": roleMd("worker", "permissionMode: bypassPermissions") }));

		const team = loadTeam(roots, "mine");

		assert.deepEqual(team?.problems, []);
		assert.equal(team?.roles[0].permissionMode, "bypassPermissions");
	});

	it("refuses bypassPermissions in a bundled Team", () => {
		const roots = tempRoots();
		const bundledTeamsDir = join(roots.scratch, "bundled");
		writeFiles(join(bundledTeamsDir, "shipped"), goodTeam("shipped", { "roles/worker.md": roleMd("worker", "permissionMode: bypassPermissions") }));

		const team = loadTeam({ ...roots, bundledTeamsDir }, "shipped");

		assert.equal(team?.problems.length, 1);
		assert.match(team?.problems[0].reason ?? "", /`permissionMode: bypassPermissions` is refused in a bundled Team/);
	});
});

describe("a Playbook", () => {
	const body = [
		"## Rules",
		"",
		"- **one-architect**: one design per Effort.",
		"* **scope-creep**: say so.",
		"1. **design-first**: design before code.",
		"2) **qa-last**: QA at the end.",
		"- **A design** is done when it names the files. (Guidance, not a rule.)",
		"- **Non-goals**: guidance too, hyphen and all.",
		"Not a list item: **not-a-rule**.",
	].join("\n");

	function teamWithPlaybook(frontmatter: string, playbookBody = body): TeamFiles {
		return goodTeam("pb", { "default-playbook.md": markdown(frontmatter, playbookBody) });
	}

	it("reads its fields, its rule ids in order, and the sha256 of its bytes", () => {
		const roots = tempRoots();
		const content = markdown(
			[
				"sendBackLimit: 3",
				"checkpoints:",
				"  - id: design-review",
				"    when: the design is ready",
				"permissions:",
				"  grants:",
				"    - id: network",
				"      allow: WebFetch for docs",
				"  escalate:",
				"    - id: history-rewrite",
				"      when: rewriting pushed history",
				'      ask: ["Bash(git push --force:*)"]',
				"  roles:",
				'    "*":',
				'      deny: ["Bash(rm -rf:*)"]',
				"    worker:",
				"      mode: acceptEdits",
				'      allow: ["Bash(npm test:*)"]',
			].join("\n"),
			body,
		);
		writeUserTeam(roots, "pb", goodTeam("pb", { "default-playbook.md": content }));

		const team = loadTeam(roots, "pb");

		assert.deepEqual(team?.problems, []);
		const playbook = team?.defaultPlaybook;
		assert.ok(playbook);
		assert.equal(playbook.sendBackLimit, 3);
		assert.deepEqual(playbook.checkpoints, [{ id: "design-review", when: "the design is ready" }]);
		assert.deepEqual(playbook.grants, [{ id: "network", allow: "WebFetch for docs" }]);
		assert.deepEqual(playbook.escalate, [{ id: "history-rewrite", when: "rewriting pushed history", ask: ["Bash(git push --force:*)"] }]);
		assert.deepEqual(playbook.roles, {
			"*": { mode: undefined, allow: [], deny: ["Bash(rm -rf:*)"] },
			worker: { mode: "acceptEdits", allow: ["Bash(npm test:*)"], deny: [] },
		});
		assert.deepEqual(playbook.rules, ["one-architect", "scope-creep", "design-first", "qa-last"]);
		assert.equal(playbook.sha256, createHash("sha256").update(content).digest("hex"));
	});

	it("sends back twice when it doesn't say", () => {
		const roots = tempRoots();
		writeUserTeam(roots, "pb", teamWithPlaybook("checkpoints: []"));

		assert.equal(loadTeam(roots, "pb")?.defaultPlaybook?.sendBackLimit, 2);
	});

	const cases: { name: string; frontmatter: string; body?: string; expect: RegExp[] }[] = [
		{
			name: "an unknown top-level field",
			frontmatter: "sendBacklimit: 3",
			expect: [/unknown field `sendBacklimit` in a Playbook's frontmatter; the fields are `sendBackLimit`, `checkpoints`, `permissions`/],
		},
		{
			name: "a send-back limit that isn't a positive integer",
			frontmatter: "sendBackLimit: 0",
			expect: [/`sendBackLimit` must be a positive integer, not `0`/],
		},
		{
			name: "an unknown field in a checkpoint",
			frontmatter: "checkpoints:\n  - id: design-review\n    when: ready\n    who: human",
			expect: [/unknown field `who` in a checkpoint/],
		},
		{
			name: "a checkpoint id that isn't kebab-case",
			frontmatter: "checkpoints:\n  - id: Design_Review\n    when: ready",
			expect: [/a checkpoint needs an `id` in kebab-case.*not `Design_Review`/],
		},
		{
			name: "an unknown field under permissions",
			frontmatter: "permissions:\n  allow: []",
			expect: [/unknown field `allow` in `permissions`; the fields are `grants`, `escalate`, `roles`/],
		},
		{
			name: "an escalate entry with no when",
			frontmatter: "permissions:\n  escalate:\n    - id: deploys",
			expect: [/needs a `when` on escalate entry `deploys`/],
		},
		{
			name: "role settings for a Role the Team doesn't have",
			frontmatter: "permissions:\n  roles:\n    tester:\n      mode: auto",
			expect: [/`permissions.roles` names `tester`, which is not a Role of this Team; the Roles are `\*`, `worker`/],
		},
		{
			name: "a Role mode of plan",
			frontmatter: "permissions:\n  roles:\n    worker:\n      mode: plan",
			expect: [/`permissions.roles.worker.mode: plan` is not allowed/],
		},
		{
			name: "an id used twice across rules, checkpoints and escalate entries",
			frontmatter: "checkpoints:\n  - id: one-architect\n    when: ready",
			expect: [/the id `one-architect` is used more than once \(rule, checkpoint\)/],
		},
		{
			name: "a rule id with an apostrophe",
			frontmatter: "checkpoints: []",
			body: "- **criteria-are-the-human's**: the human owns the criteria.",
			expect: [/the rule id `criteria-are-the-human's` must be kebab-case/],
		},
	];

	for (const { name, frontmatter, body: caseBody, expect } of cases) {
		it(`is refused for ${name}, naming default-playbook.md`, () => {
			const roots = tempRoots();
			writeUserTeam(roots, "pb", teamWithPlaybook(frontmatter, caseBody));

			const team = loadTeam(roots, "pb");

			assert.ok(team);
			assert.equal(team.defaultPlaybook, undefined);
			assert.equal(team.problems.length, expect.length, team.problems.map((problem) => problem.reason).join("\n"));
			expect.forEach((pattern, index) => {
				assert.equal(relative(team.dir, team.problems[index].filePath), "default-playbook.md");
				assert.match(team.problems[index].reason, pattern);
			});
		});
	}

	it("may set bypassPermissions for a Role in the human's own Team", () => {
		const roots = tempRoots();
		writeUserTeam(roots, "pb", teamWithPlaybook("permissions:\n  roles:\n    worker:\n      mode: bypassPermissions"));

		assert.deepEqual(loadTeam(roots, "pb")?.problems, []);
	});

	it("may not set bypassPermissions as a bundled Team's default", () => {
		const roots = tempRoots();
		const bundledTeamsDir = join(roots.scratch, "bundled");
		writeFiles(join(bundledTeamsDir, "pb"), teamWithPlaybook("permissions:\n  roles:\n    worker:\n      mode: bypassPermissions"));

		const team = loadTeam({ ...roots, bundledTeamsDir }, "pb");

		assert.equal(team?.problems.length, 1);
		assert.match(team?.problems[0].reason ?? "", /`permissions.roles.worker.mode: bypassPermissions` is refused in a bundled Team/);
	});
});

describe("adopting a Playbook", () => {
	const adopted = markdown("sendBackLimit: 1\npermissions:\n  roles:\n    architect:\n      mode: bypassPermissions", "- **ship-small**: small commits.");

	function adopt(roots: TempRoots, content: string, recordedSha = createHash("sha256").update(content).digest("hex")): void {
		writeFiles(join(roots.agentDir, "team", "playbooks"), {
			"software.md": content,
			"software.adopted.json": JSON.stringify({ sha256: recordedSha, adoptedAt: "2026-11-01T09:00:00.000Z" }),
		});
	}

	it("is not adopted when nothing has been adopted", () => {
		assert.deepEqual(loadTeam(tempRoots(), "software")?.adoption, { state: "not-adopted" });
	});

	it("is adopted when the file's sha256 matches the record, and parsed as the human's own", () => {
		const roots = tempRoots();
		adopt(roots, adopted);

		const team = loadTeam(roots, "software");

		assert.deepEqual(team?.problems, []);
		assert.equal(team?.adoption.state, "adopted");
		if (team?.adoption.state !== "adopted") return;
		assert.equal(team.adoption.adoptedAt, "2026-11-01T09:00:00.000Z");
		assert.equal(team.adoption.playbook.sendBackLimit, 1);
		assert.deepEqual(team.adoption.playbook.rules, ["ship-small"]);
		assert.equal(team.adoption.playbook.roles.architect.mode, "bypassPermissions");
	});

	it("counts as edited, not adopted, once the file's bytes change after adoption", () => {
		const roots = tempRoots();
		adopt(roots, adopted);
		writeFiles(join(roots.agentDir, "team", "playbooks"), { "software.md": `${adopted}\nOne more line.\n` });

		const adoption = loadTeam(roots, "software")?.adoption;

		assert.equal(adoption?.state, "edited");
		if (adoption?.state !== "edited") return;
		assert.equal(adoption.adoptedSha256, createHash("sha256").update(adopted).digest("hex"));
		assert.equal(adoption.sha256, createHash("sha256").update(`${adopted}\nOne more line.\n`).digest("hex"));
	});

	it("is not adopted, with a problem naming the record, when the record is not JSON", () => {
		const roots = tempRoots();
		writeFiles(join(roots.agentDir, "team", "playbooks"), { "software.md": adopted, "software.adopted.json": "{ nope" });

		const team = loadTeam(roots, "software");

		assert.deepEqual(team?.adoption, { state: "not-adopted" });
		assert.equal(team?.problems.length, 1);
		assert.equal(team?.problems[0].filePath, join(roots.agentDir, "team", "playbooks", "software.adopted.json"));
		assert.match(team?.problems[0].reason ?? "", /is not valid JSON/);
	});

	it("refuses the Team when the adopted Playbook itself is wrong", () => {
		const roots = tempRoots();
		adopt(roots, markdown("sendBackLimit: -1"));

		const team = loadTeam(roots, "software");

		assert.equal(team?.problems.length, 1);
		assert.equal(team?.problems[0].filePath, join(roots.agentDir, "team", "playbooks", "software.md"));
	});
});
