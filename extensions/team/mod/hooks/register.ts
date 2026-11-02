/**
 * The team extension's mod, loaded into every Teammate with `--plugin-dir`
 * from a per-user copy (Claude Code writes a tsconfig.json into the folder it
 * loads a mod from).
 *
 * A Teammate reused for a new Task starts it in a fresh context: the Lead
 * sends the clear marker over the Teammate's inbox, and this turns it into a
 * `/clear` instead of a turn. Clear-then-send, step by step, is in spec #93.
 *
 * The types are written out here rather than imported from `claude-code`,
 * which only Claude Code resolves.
 */

/** Must match `CLEAR_MARKER` in `../../claude.ts`. */
const CLEAR_MARKER = "__TEAM_CLEAR__";

interface Received {
	text: string;
}

interface Session {
	command: { run(input: { command: string }): Promise<unknown> };
}

type Receive = ($: Session, event: Received, next: (event: Received) => unknown) => unknown;

export const register = (on: (event: "session.receive", handler: Receive) => void): void => {
	on("session.receive", ($, event, next) => {
		if (event.text.includes(CLEAR_MARKER)) {
			void $.command.run({ command: "clear" });
			return { consumed: "team: the Lead cleared this Teammate's context for its next Task" };
		}
		return next(event);
	});
};
