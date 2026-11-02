/**
 * Records: the Brief a Lead drafts, checked before the human is asked, and the
 * files an Effort keeps on disk.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openEffort, type PendingApproval } from "../core.ts";
import type { Playbook } from "../definitions.ts";
import { appendLines, checkRecords, createEffort, promoteBrief, readLines, validateBrief } from "../records.ts";
import { goodTeam, tempRoots, writeFiles } from "./harness.ts";

const SHA = "a".repeat(64);

const PLAYBOOK: Playbook = {
	filePath: "/agent/team/playbooks/software.md",
	sha256: SHA,
	sendBackLimit: 2,
	checkpoints: [{ id: "design-review", when: "the design is ready" }],
	grants: [{ id: "push-effort-branch", allow: "push the Effort's branch" }],
	escalate: [{ id: "history-rewrite", when: "rewriting history", ask: [] }],
	roles: {},
	rules: ["design-first", "scope-creep"],
	briefSections: ["Constraints", "Context"],
	body: "",
};

const EXPECTED = { team: "software", repo: "/work/app", playbook: PLAYBOOK };

const FRONTMATTER = ["team: software", `playbook: ${SHA}`, "repo: /work/app"];

const SECTIONS: Record<string, string> = {
	Goal: "## Goal\n\nReuse a recent fetch.",
	"Acceptance criteria": "## Acceptance criteria\n\n- **AC1**: a repeat fetch makes no request.\n- **AC2**: the header says `cached`.",
	Scope: "## Scope\n\nIn: `extensions/web-fetch/`.\n\nOut: a shared cache.",
	Constraints: "## Constraints\n\n- No new dependency.",
	Context: "## Context\n\n- See `index.ts`.",
	"Decide for me / Ask me": "## Decide for me / ask me\n\n- **Decide for me**: the key format.\n- **Ask me**: anything else.",
	Delivery: "## Delivery\n\nCommits on the Effort's branch.",
};

/** A Brief that passes, with frontmatter lines and sections swapped by the caller. */
function brief(options: { frontmatter?: string[]; sections?: Record<string, string | undefined> } = {}): string {
	const sections = { ...SECTIONS, ...options.sections };
	const body = Object.values(sections).filter((section) => section !== undefined);
	return `---\n${(options.frontmatter ?? FRONTMATTER).join("\n")}\n---\n\n# web_fetch: reuse a recent fetch\n\n${body.join("\n\n")}\n`;
}

describe("a Brief draft", () => {
	it("passes with the skeleton, the Playbook's sections, unique criteria and overrides naming known rules", () => {
		const overrides = [
			"overrides:",
			"  - rule: design-review",
			"    change: skip",
			"    reason: I've seen the only interface change.",
			"  - rule: httpbin-checks",
			'    change: "add grant: send test requests to https://httpbin.org"',
			"    reason: QA checks real status codes.",
		];

		assert.deepEqual(validateBrief(brief({ frontmatter: [...FRONTMATTER, ...overrides] }), EXPECTED), []);
	});

	const cases: { name: string; text: string; expect: RegExp[] }[] = [
		{
			name: "missing a skeleton section",
			text: brief({ sections: { Delivery: undefined } }),
			expect: [/no `Delivery` section/],
		},
		{
			name: "missing a section the Playbook adds",
			text: brief({ sections: { Constraints: undefined } }),
			expect: [/no `Constraints` section.*the software Team's Playbook adds it/],
		},
		{
			name: "a Scope without its Out line",
			text: brief({ sections: { Scope: "## Scope\n\nIn: `extensions/web-fetch/`." } }),
			expect: [/`Scope` needs an `Out:` line/],
		},
		{
			name: "duplicate criterion ids",
			text: brief({ sections: { "Acceptance criteria": "## Acceptance criteria\n\n- **AC1**: one.\n- **AC2**: two.\n- **AC1**: one again." } }),
			expect: [/`AC1` is used more than once/],
		},
		{
			name: "a criterion with no id",
			text: brief({ sections: { "Acceptance criteria": "## Acceptance criteria\n\n- **AC1**: one.\n- two, unnumbered." } }),
			expect: [/every criterion starts with its id.*`- two, unnumbered\.`/],
		},
		{
			name: "no criteria at all",
			text: brief({ sections: { "Acceptance criteria": "## Acceptance criteria\n\nTo be decided." } }),
			expect: [/`Acceptance criteria` lists no criteria/],
		},
		{
			name: "an override skipping a rule the Playbook doesn't have",
			text: brief({ frontmatter: [...FRONTMATTER, "overrides:", "  - rule: design-reviews", "    change: skip", "    reason: seen it."] }),
			expect: [/override `design-reviews`.*no rule, checkpoint, grant or escalate entry `design-reviews`.*`design-first`, `scope-creep`, `design-review`, `push-effort-branch`, `history-rewrite`/],
		},
		{
			name: "an added grant reusing an id the Playbook has",
			text: brief({ frontmatter: [...FRONTMATTER, "overrides:", "  - rule: scope-creep", '    change: "add grant: anything"', "    reason: why not."] }),
			expect: [/`add grant` override `scope-creep` needs a new id; the Playbook already has `scope-creep`/],
		},
		{
			name: "an override with an unknown change",
			text: brief({ frontmatter: [...FRONTMATTER, "overrides:", "  - rule: design-review", "    change: relax", "    reason: seen it."] }),
			expect: [/override `design-review` has change `relax`; the changes are `skip` and `add grant: <what it allows>`/],
		},
		{
			name: "an override with no reason",
			text: brief({ frontmatter: [...FRONTMATTER, "overrides:", "  - rule: design-review", "    change: skip"] }),
			expect: [/override `design-review` needs a `reason`/],
		},
		{
			name: "the same rule overridden twice",
			text: brief({
				frontmatter: [...FRONTMATTER, "overrides:", "  - rule: design-review", "    change: skip", "    reason: a.", "  - rule: design-review", "    change: skip", "    reason: b."],
			}),
			expect: [/`design-review` is overridden more than once/],
		},
		{
			name: "the wrong Team",
			text: brief({ frontmatter: ["team: research", `playbook: ${SHA}`, "repo: /work/app"] }),
			expect: [/`team: research`.*Effort's Team is `software`/],
		},
		{
			name: "a Playbook sha that isn't the one in force",
			text: brief({ frontmatter: ["team: software", `playbook: ${"b".repeat(64)}`, "repo: /work/app"] }),
			expect: [new RegExp(`\`playbook\` must be the sha256 of the Playbook in force, ${SHA}`)],
		},
		{
			name: "no repo",
			text: brief({ frontmatter: ["team: software", `playbook: ${SHA}`] }),
			expect: [/`repo` must be the Effort's repo, \/work\/app/],
		},
		{
			name: "an unknown frontmatter field",
			text: brief({ frontmatter: [...FRONTMATTER, "owner: me"] }),
			expect: [/unknown field `owner`.*the fields are `team`, `playbook`, `repo`, `overrides`/],
		},
		{
			name: "no frontmatter at all",
			text: "# A Brief\n\n## Goal\n\nSomething.\n",
			expect: [/frontmatter/],
		},
	];

	for (const { name, text, expect } of cases) {
		it(`is refused for ${name}, naming the problem`, () => {
			const problems = validateBrief(text, EXPECTED);

			assert.equal(problems.length, expect.length, problems.join("\n"));
			expect.forEach((pattern, index) => assert.match(problems[index], pattern));
		});
	}
});

function sha(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

const NOW = new Date("2026-11-02T10:00:00.000Z");

describe("an Effort on disk", () => {
	it("opens each Effort in its own directory, named by Team and day, numbered when the name is taken", () => {
		const roots = tempRoots();

		const first = createEffort(roots.agentDir, "software", NOW);
		const second = createEffort(roots.agentDir, "software", NOW);

		assert.equal(first.effortId, "software-2026-11-02");
		assert.equal(second.effortId, "software-2026-11-02-2");
		assert.equal(first.paths.dir, join(roots.agentDir, "team", "efforts", "software-2026-11-02"));
		assert.ok(existsSync(first.paths.dir) && existsSync(second.paths.dir));
		assert.equal(first.paths.draft, join(first.paths.dir, "brief.draft.md"));
	});

	it("keeps effort.jsonl as one JSON line per entry, read back in order", () => {
		const roots = tempRoots();
		const { effortId, paths } = createEffort(roots.agentDir, "software", NOW);
		const opened = openEffort({ effortId, team: "software", repo: "/work/app", playbook: SHA, at: NOW.toISOString() });
		const answered = { type: "approval-answered" as const, id: "r1", answer: "sent-back" as const, note: "Split AC3.", at: NOW.toISOString() };

		appendLines(paths, [opened]);
		appendLines(paths, [answered]);

		assert.deepEqual(readLines(paths), [opened, answered]);
		assert.equal(readFileSync(paths.log, "utf8").split("\n").filter(Boolean).length, 2);
	});
});

describe("approving the Brief", () => {
	/** An Effort with a draft asked about, an adopted Playbook and a Team folder, all on disk. */
	function asked() {
		const roots = tempRoots();
		const { paths } = createEffort(roots.agentDir, "software", NOW);
		const snapshot = "---\nteam: software\n---\n\n## Goal\n\nAs asked.\n";
		writeFileSync(paths.draft, `${snapshot}\nEdited after the request.\n`);
		const playbookFile = join(roots.scratch, "software.md");
		writeFileSync(playbookFile, "the adopted Playbook\n");
		const teamDir = writeFiles(join(roots.scratch, "teams", "software"), goodTeam("software"));
		const approval: PendingApproval = { id: "r2", checkpoint: "brief", path: paths.draft, sha256: sha(snapshot), snapshot, at: NOW.toISOString() };
		return { paths, snapshot, playbookFile, teamDir, approval };
	}

	it("writes the snapshot the human saw, the Playbook and the Team as copies, and records each sha", () => {
		const { paths, snapshot, playbookFile, teamDir, approval } = asked();

		const record = promoteBrief(paths, { approval, playbookFile, teamDir, at: "2026-11-02T11:00:00.000Z" });

		assert.equal(readFileSync(paths.brief, "utf8"), snapshot);
		assert.equal(readFileSync(paths.playbook, "utf8"), "the adopted Playbook\n");
		assert.equal(readFileSync(join(paths.team, "roles", "worker.md"), "utf8"), readFileSync(join(teamDir, "roles", "worker.md"), "utf8"));
		const lines = readFileSync(paths.approvals, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(lines, [record]);
		assert.equal(record.act, "brief");
		assert.equal(record.request, "r2");
		assert.equal(record.brief, sha(snapshot));
		assert.equal(record.playbook, sha("the adopted Playbook\n"));
		assert.match(record.team, /^[0-9a-f]{64}$/);
		assert.equal(record.at, "2026-11-02T11:00:00.000Z");
		assert.deepEqual(checkRecords(paths), []);
	});

	it("leaves the Effort's copies alone when the human edits their Team or Playbook afterwards", () => {
		const { paths, playbookFile, teamDir, approval } = asked();
		promoteBrief(paths, { approval, playbookFile, teamDir, at: "2026-11-02T11:00:00.000Z" });

		writeFileSync(playbookFile, "edited by hand\n");
		writeFileSync(join(teamDir, "roles", "worker.md"), "edited by hand\n");

		assert.equal(readFileSync(paths.playbook, "utf8"), "the adopted Playbook\n");
		assert.notEqual(readFileSync(join(paths.team, "roles", "worker.md"), "utf8"), "edited by hand\n");
		assert.deepEqual(checkRecords(paths), []);
	});

	it("reports each record whose sha no longer matches its approval", () => {
		const { paths, playbookFile, teamDir, approval } = asked();
		promoteBrief(paths, { approval, playbookFile, teamDir, at: "2026-11-02T11:00:00.000Z" });

		writeFileSync(paths.brief, "tampered\n");
		writeFileSync(join(paths.team, "roles", "extra.md"), "added\n");

		const problems = checkRecords(paths);

		assert.equal(problems.length, 2, problems.join("\n"));
		assert.match(problems[0], new RegExp(`brief\\.md.*${sha("tampered\n")}.*approved.*${approval.sha256}`));
		assert.match(problems[1], /team\/.*approved/);
	});

	it("reports an Effort with no recorded approval", () => {
		const { paths } = asked();

		assert.match(checkRecords(paths)[0] ?? "", /approvals\.jsonl/);
	});
});
