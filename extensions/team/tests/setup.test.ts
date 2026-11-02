/**
 * Team setup's pure leaves: the warnings a draft earns, and the format example
 * a Lead drafting from nothing is shown. Each Playbook is a real file parsed by
 * the same parser adoption uses.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parsePlaybook, type Role } from "../definitions.ts";
import { playbookExample, playbookWarnings } from "../setup.ts";
import { markdown, tempRoots, writeFiles } from "./harness.ts";

function role(name: string, permissionMode?: Role["permissionMode"]): Role {
	return { name, description: "", allowedTools: [], disallowedTools: [], mcpServers: {}, plugins: [], permissionMode, prompt: "", filePath: `${name}.md` };
}

const ROLES = [role("dev"), role("qa"), role("ops", "acceptEdits")];

function warningsFor(frontmatter: string, roles: Role[] = ROLES): string[] {
	const dir = writeFiles(tempRoots().scratch, { "draft.md": markdown(frontmatter) });
	const { playbook, problems } = parsePlaybook(join(dir, "draft.md"), { source: "user", roleNames: roles.map((each) => each.name) });
	assert.deepEqual(problems, []);
	assert.ok(playbook);
	return playbookWarnings(playbook, roles);
}

describe("Team setup's warnings", () => {
	it("warns of each broad allow rule auto mode drops, for the Roles that run in auto", () => {
		for (const rule of ["Bash", "Bash(*)", "Bash(python:*)", "Bash(node *)", "Bash(npm run:*)", "Bash(pnpm run build)", "Agent", "Monitor"]) {
			const warnings = warningsFor(`permissions:\n  roles:\n    dev: { allow: ["${rule}"] }`);

			assert.equal(warnings.length, 1, `${rule}: ${warnings.join(" | ")}`);
			assert.ok(warnings[0].includes(`\`${rule}\``), warnings[0]);
			assert.match(warnings[0], /`dev`/);
			assert.match(warnings[0], /`auto`/);
		}
	});

	it("doesn't warn of a narrow allow rule, or of a broad one under a mode that keeps it", () => {
		assert.deepEqual(warningsFor('permissions:\n  roles:\n    dev: { allow: ["Bash(git status)", "Bash(npm test)", "Read"] }'), []);
		assert.deepEqual(warningsFor('permissions:\n  roles:\n    ops: { allow: ["Bash(*)"] }'), []);
		assert.deepEqual(warningsFor('permissions:\n  roles:\n    dev: { mode: dontAsk, allow: ["Bash(*)"] }'), []);
	});

	it("takes the mode in force from the Role's own entry, then `*`, then the Role file, then auto", () => {
		const warnings = warningsFor('permissions:\n  roles:\n    "*": { mode: acceptEdits, allow: ["Bash(*)"] }\n    qa: { mode: auto }');

		assert.equal(warnings.length, 1, warnings.join(" | "));
		assert.match(warnings[0], /`roles\.\*`/);
		assert.match(warnings[0], /`qa`/);
		assert.doesNotMatch(warnings[0], /`dev`|`ops`/);
	});

	it("names every auto Role a `*` allow rule won't reach", () => {
		const [warning] = warningsFor('permissions:\n  roles:\n    "*": { allow: ["Agent"] }');

		assert.match(warning, /`dev`, `qa`/);
		assert.doesNotMatch(warning, /`ops`/);
	});

	it("warns of an escalate entry with no `ask:` list", () => {
		const warnings = warningsFor("permissions:\n  escalate:\n    - id: deploys\n      when: Any deploy.\n    - id: pushes\n      when: Any push.\n      ask: [\"Bash(git push:*)\"]");

		assert.equal(warnings.length, 1, warnings.join(" | "));
		assert.match(warnings[0], /`deploys`/);
		assert.match(warnings[0], /`ask:`/);
	});
});

describe("the Playbook format example", () => {
	it("is itself a Playbook the parser accepts, with no warnings", () => {
		const dir = writeFiles(tempRoots().scratch, { "example.md": playbookExample({ name: "writing" }) });

		const { playbook, problems } = parsePlaybook(join(dir, "example.md"), { source: "user", roleNames: ["editor"] });

		assert.deepEqual(problems, []);
		assert.ok(playbook);
		assert.deepEqual(playbookWarnings(playbook, [role("editor")]), []);
	});
});
