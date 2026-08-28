/**
 * Agent discovery: turning markdown files into the roster of things that can be
 * run.
 *
 * An Agent is a definition — name, description, tool allowlist, optional model,
 * and a body that becomes the child's system prompt. Adapted from pi's own
 * `examples/extensions/subagent/agents.ts`, with three deliberate departures:
 *
 *  - **Tools are a strict allowlist with no default.** A run is spawned with
 *    `--no-extensions --tools <this list, plus `ask_question`>`, so an Agent
 *    naming no tools would be a session that can only ask questions — never a
 *    full set. That is always a mistake, so it is reported as a config error
 *    naming the file rather than quietly dropped.
 *  - **Every rejection is reported.** pi's example `continue`s past a bad file;
 *    a file that looks like an Agent and is silently absent from the roster is
 *    worse than a loud one. One bad file still never takes down its neighbours.
 *  - **The project scope is held apart from the roster.** An Agent file the
 *    checkout carries is repo-controlled prompt injection with an allowlist, so
 *    a checkout must never be able to steer a session by existing. The nearest
 *    `.pi/agents/` above the working directory is discovered, and everything it
 *    holds comes back as `projectAgents` — never merged into `agents`, which is
 *    the whole of what keeps the default scope user-only. Running one is gated
 *    on a trust confirmation, which is the caller's job rather than this file's.
 */

import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** Where an Agent came from. */
export type AgentSource = "bundled" | "user" | "project";

export interface Agent {
	name: string;
	description: string;
	/** Non-empty: the exact `--tools` allowlist the run is spawned with. */
	tools: string[];
	/** Absent means the run inherits the parent session's model. */
	model?: string;
	/** The frontmatter body, appended to the child's system prompt. */
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

/** A file that looks like an Agent but cannot be run, and why. */
export interface AgentProblem {
	filePath: string;
	reason: string;
}

export interface Roster {
	/** Runnable Agents, sorted by name: the bundled set plus the user's own. */
	agents: Agent[];
	/**
	 * The project scope, sorted by name and deliberately not in `agents`.
	 *
	 * These are defined by the checkout rather than by the user, so nothing may
	 * run one without a trust confirmation first.
	 */
	projectAgents: Agent[];
	/** Where the project Agents were found, when a directory was found at all. */
	projectAgentsDir?: string;
	/** Files rejected on the way, in the order they were read. */
	problems: AgentProblem[];
}

export interface DiscoveryOptions {
	/** Defaults to `~/.pi/agent/agents/`. */
	userAgentsDir?: string;
	/** Defaults to the set shipped beside this file. */
	bundledAgentsDir?: string;
	/** Where the walk up for a project Agent directory starts. Defaults to the process's own. */
	cwd?: string;
}

/** The Agents shipped with this extension. */
export const BUNDLED_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "agents");

/** What a checkout keeps its own Agents in, relative to a directory in it. */
const PROJECT_AGENTS_DIR = join(CONFIG_DIR_NAME, "agents");

type ParseResult = { ok: true; agent: Agent } | { ok: false; reason: string };

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else — a number, a map, a nested list — yields no
 * tools, which the caller turns into the same config error as an absent key:
 * the fix is identical either way.
 */
function parseToolList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return raw
		.filter((tool): tool is string => typeof tool === "string")
		.map((tool) => tool.trim())
		.filter(Boolean);
}

function requiredString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Parse one Agent file. Pure: the caller has already read the bytes. */
function parseAgent(content: string, filePath: string, source: AgentSource): ParseResult {
	let frontmatter: AgentFrontmatter;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content));
	} catch (error) {
		return { ok: false, reason: `frontmatter is not valid YAML: ${errorText(error).split("\n")[0]}` };
	}

	const name = requiredString(frontmatter.name);
	if (!name) return { ok: false, reason: "frontmatter needs a `name` to address the agent by" };

	const description = requiredString(frontmatter.description);
	if (!description) return { ok: false, reason: "frontmatter needs a `description` for the roster" };

	const tools = parseToolList(frontmatter.tools);
	if (tools.length === 0) {
		return {
			ok: false,
			reason: "frontmatter names no `tools`; tool access is a strict allowlist with no default, so list them explicitly",
		};
	}

	if (frontmatter.model !== undefined && typeof frontmatter.model !== "string") {
		return { ok: false, reason: "frontmatter `model` must be a string; omit it to inherit the parent session's model" };
	}

	return {
		ok: true,
		agent: { name, description, tools, model: frontmatter.model, systemPrompt: body, source, filePath },
	};
}

/**
 * Filenames in codepoint order.
 *
 * Deliberately not `localeCompare`, which reorders across cases and accents by
 * the machine's ICU data and `LANG`: `Z-a.md` sorts before `a-b.md` here and
 * after it under an en-US collation. The documented precedence rule below has to
 * hold on every machine, so it is settled by the bytes.
 */
function byFilename(a: Dirent, b: Dirent): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** What one directory held: the Agents that parsed, and the files that did not. */
interface Scan {
	agents: Agent[];
	problems: AgentProblem[];
}

/** Every Agent in one directory, plus the files that failed. */
function loadAgentsFromDir(dir: string, source: AgentSource): Scan {
	const agents: Agent[] = [];
	const problems: AgentProblem[] = [];

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		// A user who has never written an agent has no directory. Normal, not a problem.
		return { agents, problems };
	}

	const claimed = new Map<string, string>();

	for (const entry of entries.sort(byFilename)) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = join(dir, entry.name);

		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch (error) {
			problems.push({ filePath, reason: `could not be read: ${errorText(error)}` });
			continue;
		}

		const result = parseAgent(content, filePath, source);
		if (!result.ok) {
			problems.push({ filePath, reason: result.reason });
			continue;
		}

		// Two files in one directory claiming one name: the first by filename wins,
		// and the shadowed one is reported — unlike a user file shadowing a bundled
		// one, which is the whole point of the user scope, this is always a mistake.
		const winner = claimed.get(result.agent.name);
		if (winner) {
			problems.push({
				filePath,
				reason: `claims the name \`${result.agent.name}\`, already taken by ${basename(winner)}`,
			});
			continue;
		}

		claimed.set(result.agent.name, filePath);
		agents.push(result.agent);
	}

	return { agents, problems };
}

function byAgentName(a: Agent, b: Agent): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The nearest `.pi/agents/` at or above `from`, if a checkout carries one.
 *
 * Nearest rather than every one on the way up: an inner project's Agents are the
 * ones its working directory means, and merging an outer checkout's in would
 * make what a session can run depend on where the tree happens to sit.
 */
function findProjectAgentsDir(from: string): string | undefined {
	let dir = from;
	for (;;) {
		const candidate = join(dir, PROJECT_AGENTS_DIR);
		try {
			if (statSync(candidate).isDirectory()) return candidate;
		} catch {
			// Nothing there, which is the normal case for almost every directory.
		}

		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * The Agents available to a session, and the ones a checkout would like it to
 * have.
 *
 * Bundled first, then the user scope, so a user file named `scout` replaces the
 * bundled `scout` outright: the bundled set is a default, and overriding it must
 * not mean editing this repo.
 *
 * The project scope does not take part in that: it comes back separately, and a
 * project Agent claiming a name the user or bundled scopes already use is
 * dropped and reported. The precedence runs one way only — a repo cannot quietly
 * replace an Agent the user trusts, because the thing that would then be running
 * behind a familiar name is a file the repo wrote.
 */
export function discoverAgents(options: DiscoveryOptions = {}): Roster {
	const bundled = loadAgentsFromDir(options.bundledAgentsDir ?? BUNDLED_AGENTS_DIR, "bundled");
	const user = loadAgentsFromDir(options.userAgentsDir ?? join(getAgentDir(), "agents"), "user");

	const byName = new Map<string, Agent>();
	for (const agent of [...bundled.agents, ...user.agents]) byName.set(agent.name, agent);

	const projectAgentsDir = findProjectAgentsDir(options.cwd ?? process.cwd());
	const project: Scan = projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : { agents: [], problems: [] };

	const projectAgents: Agent[] = [];
	const shadowed: AgentProblem[] = [];
	for (const agent of project.agents) {
		const taken = byName.get(agent.name);
		if (taken) {
			shadowed.push({
				filePath: agent.filePath,
				reason: `claims the name \`${agent.name}\`, already taken by the ${taken.source} agent ${basename(taken.filePath)}; a project agent never replaces one of those`,
			});
			continue;
		}
		projectAgents.push(agent);
	}

	return {
		agents: [...byName.values()].sort(byAgentName),
		projectAgents: projectAgents.sort(byAgentName),
		projectAgentsDir,
		problems: [...bundled.problems, ...user.problems, ...project.problems, ...shadowed],
	};
}
