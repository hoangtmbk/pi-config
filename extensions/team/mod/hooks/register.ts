/**
 * The team extension's mod, loaded into every Teammate with `--plugin-dir`
 * from a per-user copy (Claude Code writes a tsconfig.json into the folder it
 * loads a mod from).
 *
 * A Teammate reused for a new Task starts it in a fresh context: the Lead
 * sends the clear marker over the Teammate's inbox, and this turns it into a
 * `/clear` instead of a turn. Clear-then-send, step by step, is in spec #93.
 *
 * It also journals what the human does in the Teammate's own terminal, which
 * starts a Takeover: a prompt they type, a slash command they run, a turn they
 * interrupt, and `/handback`, which ends it. Each goes to the Team's hook
 * command (its argv in the `TEAM_HOOK` variable the Teammate's settings set),
 * which writes the mod line and rings the Lead's doorbell. Only the human's own
 * input counts: the Lead's inbox messages and plugins' runs don't come from
 * the composer. Journalling is best effort and never stands in the human's way.
 *
 * The types are written out here rather than imported from `claude-code`,
 * which only Claude Code resolves.
 */

/** Must match `CLEAR_MARKER` in `../../claude.ts`. */
const CLEAR_MARKER = "__TEAM_CLEAR__";

/** The command the human runs in the terminal to give the Teammate back to the Lead. */
const HANDBACK = "handback";

interface Origin {
	kind: string;
}

interface Received {
	text: string;
}

interface Submitted {
	text: string;
	command?: unknown;
	isMeta?: true;
	origin: Origin;
}

interface CommandRun {
	command: string;
	args: string;
	origin: Origin;
}

interface TurnComplete {
	isAborted: boolean;
	agentId?: string;
}

interface Session {
	command: {
		run(input: { command: string }): Promise<unknown>;
		register(command: { name: string; description: string; argumentHint?: string }): Promise<unknown>;
	};
	env: { get(name: "TEAM_HOOK"): Promise<string | undefined> };
	process: { run(argv: readonly string[], init?: { stdin?: string }): Promise<unknown> };
}

type Hook<E> = ($: Session, event: E, next: (event: E) => unknown) => unknown;

interface On {
	(event: "session.receive", hook: Hook<Received>): void;
	(event: "session.start", hook: Hook<unknown>): void;
	(event: "prompt.submit", hook: Hook<Submitted>): void;
	(event: "command.run", hook: Hook<CommandRun>): void;
	(event: "turn.complete", hook: Hook<TurnComplete>): void;
}

/** Hand one mod line to the Team's hook command, which journals it and rings the doorbell. */
async function journal($: Session, event: string, payload: Record<string, unknown>): Promise<void> {
	try {
		const argv = JSON.parse((await $.env.get("TEAM_HOOK")) ?? "null") as unknown;
		if (!Array.isArray(argv) || argv.length === 0 || !argv.every((each) => typeof each === "string")) return;
		await $.process.run(argv, { stdin: JSON.stringify({ mod: event, payload }) });
	} catch {
		// Best effort: the Lead also hears of the Teammate through its hooks.
	}
}

export const register = (on: On): void => {
	on("session.receive", ($, event, next) => {
		if (event.text.includes(CLEAR_MARKER)) {
			void $.command.run({ command: "clear" });
			return { consumed: "team: the Lead cleared this Teammate's context for its next Task" };
		}
		return next(event);
	});

	on("session.start", async ($, event, next) => {
		const started = await next(event);
		await $.command.register({ name: HANDBACK, description: "Give this Teammate back to the Team's Lead", argumentHint: "[note for the Lead]" }).catch(() => undefined);
		return started;
	});

	// A slash command raises `command.run` as well, so the prompt is journalled only when it is one.
	on("prompt.submit", async ($, event, next) => {
		if (event.origin.kind === "composer" && event.command === undefined && event.isMeta !== true) await journal($, "prompt.submit", { text: event.text });
		return next(event);
	});

	on("command.run", async ($, event, next) => {
		if (event.command === HANDBACK) {
			const note = event.args.trim();
			await journal($, "handback", note === "" ? {} : { note });
			return { text: "team: handed back to the Lead, which reviews what you did here." };
		}
		if (event.origin.kind === "composer") await journal($, "command.run", { command: event.command, args: event.args });
		return next(event);
	});

	// The main loop's turn only: a subagent's interrupted turn is the Teammate's own business.
	on("turn.complete", async ($, event, next) => {
		if (event.isAborted && event.agentId === undefined) await journal($, "turn.complete", { aborted: true });
		return next(event);
	});
};
