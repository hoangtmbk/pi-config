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
 *  - **Project scope is absent.** A project-local agent file is repo-controlled
 *    prompt injection; it carries a trust decision, and lands behind a trust
 *    confirmation in ticket 10. Discovery here is the user scope plus the set
 *    bundled with this extension.
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** Where an Agent came from. */
export type AgentSource = "bundled" | "user";

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
	/** Runnable Agents, sorted by name. */
	agents: Agent[];
	/** Files rejected on the way, in the order they were read. */
	problems: AgentProblem[];
}

export interface DiscoveryOptions {
	/** Defaults to `~/.pi/agent/agents/`. */
	userAgentsDir?: string;
	/** Defaults to the set shipped beside this file. */
	bundledAgentsDir?: string;
}

/** The Agents shipped with this extension. */
export const BUNDLED_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "agents");

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

/** Every Agent in one directory, plus the files that failed. */
function loadAgentsFromDir(dir: string, source: AgentSource): Roster {
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

/**
 * The Agents available to a session.
 *
 * Bundled first, then the user scope, so a user file named `scout` replaces the
 * bundled `scout` outright: the bundled set is a default, and overriding it must
 * not mean editing this repo.
 */
export function discoverAgents(options: DiscoveryOptions = {}): Roster {
	const bundled = loadAgentsFromDir(options.bundledAgentsDir ?? BUNDLED_AGENTS_DIR, "bundled");
	const user = loadAgentsFromDir(options.userAgentsDir ?? join(getAgentDir(), "agents"), "user");

	const byName = new Map<string, Agent>();
	for (const agent of [...bundled.agents, ...user.agents]) byName.set(agent.name, agent);

	return {
		agents: [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
		problems: [...bundled.problems, ...user.problems],
	};
}
