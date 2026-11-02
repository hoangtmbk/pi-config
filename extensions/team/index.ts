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
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { versionWarning } from "./claude.ts";
import { listTeams, loadTeam, type Team, type TeamRoots } from "./definitions.ts";
import {
	APPROVE,
	adoptedText,
	adoptionRequested,
	adoptPlaybook,
	beginSetup,
	LATER,
	type PendingAdoption,
	pendingAdoptionTitle,
	requestAdoption,
	SEND_BACK,
	sentBackText,
	setupTeam,
	type TeamSetup,
} from "./setup.ts";
import { pickTeam, proposeTeam, type StartOutcome } from "./start.ts";

/** The Lead's tools: registered at load, switched on only while this session runs Team setup. */
const LEAD_TOOLS = ["team_request_approval"];

const RequestApprovalParams = Type.Object({
	checkpoint: Type.String({ description: "Which checkpoint: `adopt-playbook` during Team setup." }),
	path: Type.String({ description: "The draft to approve: for `adopt-playbook`, the Team setup's Playbook draft." }),
});

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
	/** The clock adoption times are read from. Injected by tests, and by nothing else. */
	now?: () => Date;
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
	const now = deps.now ?? (() => new Date());

	// What this session is running, which decides whether the Lead's tools are on.
	let setup: TeamSetup | undefined;
	// What waits on the human in `/team pending`, oldest first.
	let pending: PendingAdoption[] = [];

	function syncLeadTools(): void {
		const others = pi.getActiveTools().filter((name) => !LEAD_TOOLS.includes(name));
		pi.setActiveTools(setup ? [...others, ...LEAD_TOOLS] : others);
	}

	function wakeLead(customType: string, text: string): void {
		pi.sendMessage({ customType, content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
	}

	function runSetup(team: Team, startsTeam: boolean): void {
		const begun = beginSetup(paths.agentDir, team, startsTeam);
		// A setup for another Team ends the one before it, and with it what that one asked.
		pending = pending.filter((item) => item.team === team.name);
		setup = begun.setup;
		syncLeadTools();
		wakeLead("team-setup", begun.prompt);
	}

	function land(outcome: StartOutcome, ctx: ExtensionCommandContext): void {
		switch (outcome.kind) {
			case "notify":
				ctx.ui.notify(outcome.text, outcome.level);
				return;
			case "ask-lead":
				wakeLead("team-start", outcome.text);
				return;
			case "setup":
				ctx.ui.notify(outcome.text, "info");
				runSetup(outcome.team, true);
				return;
		}
	}

	/** One adoption in `/team pending`: approve, send back with a note, or leave it for later. */
	async function answerAdoption(item: PendingAdoption, ctx: ExtensionCommandContext): Promise<void> {
		const answer = await ctx.ui.select(pendingAdoptionTitle(item), [APPROVE, SEND_BACK, LATER]);
		if (answer === APPROVE) {
			const adopted = adoptPlaybook(paths.agentDir, item, now());
			pending = pending.filter((waiting) => waiting !== item);
			const startsTeam = setup?.team === item.team && setup.startsTeam;
			if (setup?.team === item.team) setup = undefined;
			syncLeadTools();
			ctx.ui.notify(`Adopted the \`${item.team}\` Playbook: ${adopted}.`, "info");
			wakeLead("team-pending", adoptedText(item, adopted));
			if (startsTeam) land(pickTeam(listTeams(paths), item.team), ctx);
		} else if (answer === SEND_BACK) {
			const note = (await ctx.ui.input("Note for the Lead: what should change?"))?.trim();
			// Backing out of the note leaves the item waiting, as "later" does.
			if (!note) return;
			pending = pending.filter((waiting) => waiting !== item);
			wakeLead("team-pending", sentBackText(item, note));
		}
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
		setup: {
			async run(args, ctx) {
				const found = setupTeam(listTeams(paths), args[0], paths.agentDir);
				if ("error" in found) {
					ctx.ui.notify(found.error, "error");
					return;
				}
				runSetup(found.team, false);
			},
		},
		pending: {
			async run(_args, ctx) {
				if (pending.length === 0) {
					ctx.ui.notify("Nothing is waiting on you.", "info");
					return;
				}
				for (const item of [...pending]) await answerAdoption(item, ctx);
			},
		},
	};
	const valid = Object.keys(subcommands)
		.map((name) => `\`${name}\``)
		.join(", ");

	pi.registerTool({
		name: "team_request_approval",
		label: "Request approval",
		description: [
			"Ask the human to approve a draft at one of the Team's checkpoints.",
			"Validates the draft, snapshots it with its sha256 and adds a pending item the human answers in `/team pending`; returns at once without waiting for the answer.",
			"Agreement in chat never counts: only the human's approval in `/team pending` does.",
		].join(" "),
		promptSnippet: "Ask the human to approve a draft, such as a Playbook to adopt, from `/team pending`",
		parameters: RequestApprovalParams,
		defaultActive: false,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const team = setup ? loadTeam(paths, setup.team) : undefined;
			const item = requestAdoption(setup, team, params.checkpoint, resolve(ctx.cwd, params.path));
			// A newer request for the same Team replaces the one the human hasn't answered.
			pending = [...pending.filter((waiting) => waiting.team !== item.team), item];
			return { content: [{ type: "text", text: adoptionRequested(item) }], details: undefined };
		},
	});

	pi.registerCommand("team", {
		description: "Run a Team on one Effort: /team start [team], /team setup <team>, /team pending",
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
