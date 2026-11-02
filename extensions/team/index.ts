/**
 * team — a Lead in pi running a Team of Claude Code Teammates on one Effort.
 *
 * This file is wiring and nothing else. Teams, Roles and Playbooks are read
 * and checked by `definitions.ts`; what `/team start` says is decided by
 * `start.ts`; the `claude` executable is known only to `claude.ts`.
 *
 * Every path root is injected through {@link TeamDeps}, so tests point the
 * extension at temp folders and a fake `claude`, and nothing reaches the
 * human's real agent dir or Claude Code config.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { versionWarning } from "./claude.ts";
import { listTeams, type TeamRoots } from "./definitions.ts";
import { pickTeam, proposeTeam, type StartOutcome } from "./start.ts";

/** Where the extension finds everything outside itself. Each defaults to the real thing. */
export interface TeamDeps {
	/** pi's agent dir, `~/.pi/agent`. Injected by tests, and by nothing else. */
	agentDir?: string;
	/** Claude Code's config file, `~/.claude.json`. Injected by tests, and by nothing else. */
	claudeConfigPath?: string;
	/** The `claude` executable. Injected by tests, and by nothing else. */
	claudePath?: string;
	/** The bundled Teams. Injected by tests, and by nothing else. */
	bundledTeamsDir?: string;
}

/** The paths the extension runs against once defaults are filled in. */
interface Paths extends TeamRoots {
	claudeConfigPath: string;
	claudePath: string;
}

/** One `/team` subcommand. */
interface Subcommand {
	run(args: string[], ctx: ExtensionCommandContext): Promise<void>;
}

export function registerTeam(pi: ExtensionAPI, deps: TeamDeps = {}): void {
	const paths: Paths = {
		agentDir: deps.agentDir ?? getAgentDir(),
		bundledTeamsDir: deps.bundledTeamsDir,
		claudeConfigPath: deps.claudeConfigPath ?? join(homedir(), ".claude.json"),
		claudePath: deps.claudePath ?? "claude",
	};

	function land(outcome: StartOutcome, ctx: ExtensionCommandContext): void {
		if (outcome.kind === "notify") ctx.ui.notify(outcome.text, outcome.level);
		else pi.sendMessage({ customType: "team-start", content: outcome.text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
	}

	// Each subcommand is one row, so later ones are added without touching the rest.
	const subcommands: Record<string, Subcommand> = {
		start: {
			async run(args, ctx) {
				const warning = await versionWarning(paths.claudePath);
				if (warning) ctx.ui.notify(warning, "warning");
				// Read fresh every time, so a fixed file is picked up without `/reload`.
				const teams = listTeams(paths);
				land(args[0] === undefined ? proposeTeam(teams) : pickTeam(teams, args[0]), ctx);
			},
		},
	};
	const valid = Object.keys(subcommands)
		.map((name) => `\`${name}\``)
		.join(", ");

	pi.registerCommand("team", {
		description: "Run a Team on one Effort: /team start [team]",
		async handler(args, ctx) {
			const [name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (name === undefined) {
				ctx.ui.notify(`\`/team\` needs a subcommand. Subcommands: ${valid}.`, "error");
				return;
			}
			const subcommand = Object.hasOwn(subcommands, name) ? subcommands[name] : undefined;
			if (!subcommand) {
				ctx.ui.notify(`Unknown \`/team\` subcommand \`${name}\`. Subcommands: ${valid}.`, "error");
				return;
			}
			await subcommand.run(rest, ctx);
		},
	});
}

export default function (pi: ExtensionAPI): void {
	registerTeam(pi);
}
