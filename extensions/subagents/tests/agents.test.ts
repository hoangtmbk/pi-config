/**
 * Agent discovery: what ends up in the roster, and what is rejected on the way.
 *
 * Every test drives fixture directories, so nothing here reads the developer's
 * own `~/.pi/agent/agents/` — including the tests that exercise the bundled set,
 * which point the user scope at a path that does not exist.
 */

import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Agent, type AgentProblem, BUNDLED_AGENTS_DIR, discoverAgents } from "../agents.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const NO_SUCH_DIR = join(FIXTURES, "does-not-exist");
/** A checkout carrying its own `.pi/agents/`, with somewhere to work from below it. */
const PROJECT_TREE = join(FIXTURES, "project-tree");
const DEEP_IN_PROJECT = join(PROJECT_TREE, "nested", "deep");
/**
 * A working directory with no project scope anywhere above it.
 *
 * A temporary directory rather than a path inside this repo: discovery walks up
 * to the root, so a cwd under the repo would find whatever `.pi/agents/` the
 * machine happens to carry above it and the user-scope tests would read the
 * developer's own checkout.
 */
const NO_PROJECT = mkdtempSync(join(tmpdir(), "pi-subagents-cwd-"));

/** A roster from `dir` alone: the bundled set is pointed somewhere empty. */
function fromUserDir(dir: string) {
	return discoverAgents({ userAgentsDir: dir, bundledAgentsDir: NO_SUCH_DIR, cwd: NO_PROJECT });
}

function byName(agents: Agent[], name: string): Agent {
	const agent = agents.find((a) => a.name === name);
	assert.ok(agent, `expected an agent named ${name}, got ${agents.map((a) => a.name).join(", ") || "none"}`);
	return agent;
}

function problemFor(problems: AgentProblem[], file: string): AgentProblem {
	const problem = problems.find((p) => p.filePath.endsWith(file));
	assert.ok(problem, `expected a problem for ${file}, got ${problems.map((p) => p.filePath).join(", ") || "none"}`);
	return problem;
}

describe("discoverAgents", () => {
	it("parses name, description, tools, model and the body as the system prompt", () => {
		const { agents, problems } = fromUserDir(join(FIXTURES, "user-agents"));

		assert.deepEqual(problems, []);
		assert.deepEqual(
			agents.map((a) => a.name),
			["alpha", "beta"],
		);

		const alpha = byName(agents, "alpha");
		assert.equal(alpha.description, "Names its tools as a comma-separated string, and pins a model");
		assert.equal(alpha.model, "some-provider/some-model");
		assert.equal(alpha.systemPrompt, "Alpha's system prompt.\n\nIt runs to several lines.");
		assert.equal(alpha.source, "user");
		assert.ok(alpha.filePath.endsWith("alpha.md"));
	});

	it("accepts both spellings of tools — the comma-separated string and the YAML list", () => {
		const { agents } = fromUserDir(join(FIXTURES, "user-agents"));

		assert.deepEqual(byName(agents, "alpha").tools, ["read", "grep", "find"]);
		assert.deepEqual(byName(agents, "beta").tools, ["read", "bash"]);
	});

	it("leaves model undefined when the frontmatter pins none", () => {
		assert.equal(byName(fromUserDir(join(FIXTURES, "user-agents")).agents, "beta").model, undefined);
	});

	it("ignores files that are not markdown", () => {
		const { agents, problems } = fromUserDir(join(FIXTURES, "user-agents"));

		assert.deepEqual(problems, []);
		assert.equal(agents.length, 2);
	});

	it("treats a missing directory as an empty one, not a failure", () => {
		assert.deepEqual(discoverAgents({ userAgentsDir: NO_SUCH_DIR, bundledAgentsDir: NO_SUCH_DIR, cwd: NO_PROJECT }), {
			agents: [],
			projectAgents: [],
			projectAgentsDir: undefined,
			problems: [],
		});
	});

	describe("config errors", () => {
		it("rejects an agent that names no tools, and says which file", () => {
			const { agents, problems } = fromUserDir(join(FIXTURES, "mixed"));

			assert.equal(
				agents.find((a) => a.name === "no-tools"),
				undefined,
			);
			assert.match(problemFor(problems, "no-tools.md").reason, /tools/);
		});

		it("rejects a tools key that resolves to nothing", () => {
			const { problems } = fromUserDir(join(FIXTURES, "mixed"));

			assert.match(problemFor(problems, "empty-tools.md").reason, /tools/);
		});

		it("rejects an agent with no name and one with no description", () => {
			const { problems } = fromUserDir(join(FIXTURES, "mixed"));

			assert.match(problemFor(problems, "no-name.md").reason, /name/);
			assert.match(problemFor(problems, "no-description.md").reason, /description/);
		});

		it("rejects a model that is not a string rather than silently dropping it", () => {
			const { problems } = fromUserDir(join(FIXTURES, "mixed"));

			assert.match(problemFor(problems, "bad-model.md").reason, /model/);
		});

		it("reports unparseable frontmatter instead of throwing", () => {
			const { problems } = fromUserDir(join(FIXTURES, "mixed"));

			assert.match(problemFor(problems, "bad-yaml.md").reason, /YAML/);
		});

		it("keeps discovering the rest of the directory around a broken file", () => {
			const { agents, problems } = fromUserDir(join(FIXTURES, "mixed"));

			assert.deepEqual(
				agents.map((a) => a.name),
				["survivor"],
			);
			assert.equal(problems.length, 6);
		});
	});

	describe("precedence between two agents of the same name", () => {
		it("lets a user agent replace a bundled one of the same name", () => {
			const { agents, problems } = discoverAgents({ userAgentsDir: join(FIXTURES, "user-override"), cwd: NO_PROJECT });

			const scout = byName(agents, "scout");
			assert.equal(scout.source, "user");
			assert.equal(scout.description, "A user's own scout, replacing the bundled one");
			// An override is the point of the user scope, so it is not a problem…
			assert.deepEqual(problems, []);
			// …and it replaces only the agent it names.
			assert.equal(byName(agents, "worker").source, "bundled");
		});

		it("breaks a tie inside one directory by filename, first wins, and says so", () => {
			const { agents, problems } = fromUserDir(join(FIXTURES, "duplicates"));

			assert.deepEqual(
				agents.map((a) => a.description),
				["First by filename"],
			);
			assert.match(problemFor(problems, "z-second.md").reason, /a-first\.md/);
		});

		// `Z-first.md` sorts first by codepoint and last under an en-US collation, so
		// this fails on some machines and not others the moment the tie-break reaches
		// for `localeCompare` — which is exactly the regression worth catching.
		it("breaks that tie the same way whatever the machine's locale", () => {
			const { agents } = fromUserDir(join(FIXTURES, "duplicates-case"));

			assert.deepEqual(
				agents.map((a) => a.description),
				["First in codepoint order, last under an en-US collation"],
			);
		});
	});

	it("reports a file it cannot read rather than throwing", () => {
		// A symlink pointing at a directory: it passes the dirent check, then fails
		// to be read. Built here rather than committed — git cannot carry it.
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-"));
		writeFileSync(join(dir, "readable.md"), "---\nname: readable\ndescription: Fine\ntools: read\n---\n\nBody.\n");
		symlinkSync(dir, join(dir, "unreadable.md"), "dir");

		const { agents, problems } = fromUserDir(dir);

		assert.deepEqual(
			agents.map((a) => a.name),
			["readable"],
		);
		assert.match(problemFor(problems, "unreadable.md").reason, /could not be read/);
	});

	describe("the bundled roster", () => {
		it("ships scout and worker, and they parse cleanly", () => {
			const { agents, problems } = discoverAgents({ userAgentsDir: NO_SUCH_DIR, cwd: NO_PROJECT });

			assert.deepEqual(problems, []);
			assert.deepEqual(
				agents.map((a) => a.name),
				["scout", "worker"],
			);
			for (const agent of agents) {
				assert.equal(agent.source, "bundled");
				assert.ok(agent.description.length > 0);
				assert.ok(agent.tools.length > 0);
				assert.ok(agent.systemPrompt.length > 0);
				assert.ok(agent.filePath.startsWith(BUNDLED_AGENTS_DIR));
			}
		});

		it("gives scout a read-only allowlist — no bash, no edit, no write", () => {
			const { agents } = discoverAgents({ userAgentsDir: NO_SUCH_DIR, cwd: NO_PROJECT });

			assert.deepEqual(byName(agents, "scout").tools, ["read", "grep", "find", "ls"]);
		});

		it("pins no model on either, so a run inherits the parent session's", () => {
			const { agents } = discoverAgents({ userAgentsDir: NO_SUCH_DIR, cwd: NO_PROJECT });

			assert.deepEqual(
				agents.map((a) => a.model),
				[undefined, undefined],
			);
		});
	});

	describe("the project scope", () => {
		/** A roster discovered from `cwd`, with the user and bundled scopes pointed somewhere empty. */
		function fromCwd(cwd: string) {
			return discoverAgents({ userAgentsDir: NO_SUCH_DIR, bundledAgentsDir: NO_SUCH_DIR, cwd });
		}

		it("walks up from the working directory for a project agent directory", () => {
			const { projectAgents, projectAgentsDir } = fromCwd(DEEP_IN_PROJECT);

			assert.equal(projectAgentsDir, join(PROJECT_TREE, ".pi", "agents"));
			const prospector = byName(projectAgents, "prospector");
			assert.equal(prospector.source, "project");
			assert.equal(prospector.description, "A project's own agent, defined by the repository it lives in");
		});

		it("keeps what it finds out of the roster, so a checkout is never silently runnable", () => {
			const { agents, projectAgents } = fromCwd(DEEP_IN_PROJECT);

			assert.deepEqual(agents, [], "the default scope is the user's and the bundled set, and nothing else");
			assert.ok(projectAgents.length > 0, "the project agents are discovered, just held apart");
		});

		it("finds no project scope above a directory that has none", () => {
			const { projectAgents, projectAgentsDir } = fromCwd(NO_PROJECT);

			assert.deepEqual(projectAgents, []);
			assert.equal(projectAgentsDir, undefined);
		});

		it("holds a project agent to the same strict allowlist — no tools, no agent", () => {
			const { projectAgents, problems } = fromCwd(DEEP_IN_PROJECT);

			assert.equal(
				projectAgents.find((a) => a.name === "toolless"),
				undefined,
			);
			assert.match(problemFor(problems, "no-tools.md").reason, /tools/);
		});

		describe("a project agent and a user agent sharing a name", () => {
			it("keeps the user's and drops the project's, saying which file lost", () => {
				const { agents, projectAgents, problems } = discoverAgents({
					userAgentsDir: join(FIXTURES, "user-agents"),
					bundledAgentsDir: NO_SUCH_DIR,
					cwd: DEEP_IN_PROJECT,
				});

				assert.equal(byName(agents, "alpha").source, "user");
				assert.equal(
					projectAgents.find((a) => a.name === "alpha"),
					undefined,
					"a repo cannot put itself behind a name the user already trusts",
				);
				// The project scope keeps everything it does not collide on.
				assert.deepEqual(
					projectAgents.map((a) => a.name),
					["prospector"],
				);
				assert.match(problemFor(problems, join("project-tree", ".pi", "agents", "alpha.md")).reason, /alpha/);
			});
		});
	});
});
