/** Types for `floor.mjs`, the floor classifier, which stays plain JavaScript so the hook script can import it. */

/** The kinds of floor action a command can spell. */
export type FloorKind = "push" | "publish" | "deploy" | "delete" | "send";

/** A floor action, and the simple command that takes it. */
export interface FloorAction {
	kind: FloorKind;
	command: string;
	/** For a delete: true when none of its targets is one the floor read outside, only ones it can't read (a name, `~`, a `cd` or `xargs` it can't follow). */
	unread?: boolean;
}

/** Where a command runs: the Workspace, and its own directory (the Workspace when not given). */
export interface FloorWhere {
	workspace: string;
	cwd?: string;
	/** Other folders that are the Teammate's own, such as its Claude Code job temp folder: a delete under one is inside, as under the Workspace. */
	roots?: string[];
	/** The folder a leading `~` or `$HOME` names; this user's home when not given. */
	home?: string;
	/** The folder a leading `$CLAUDE_JOB_DIR` names, once the caller trusts it ({@link ownFolders}); unknown, so outside, when not given. */
	jobDir?: string;
}

/** The floor action a Bash command takes, or undefined when it takes none. */
export function floorAction(command: string, where: FloorWhere): FloorAction | undefined;

/** Claude Code's config folder: `$CLAUDE_CONFIG_DIR`, else `fallback` (`~/.claude` when not given). */
export function claudeConfigDir(env?: Record<string, string | undefined>, fallback?: string): string;

/** A Teammate's own folders, worked out the same way for the floor hook and `team_answer`; it spreads into {@link FloorWhere}. */
export function ownFolders(from: { config: string; job?: string; scratchpad?: unknown }): { jobDir?: string; roots: string[] };

/** The simple commands in a Bash command, each as its words, past env assignments and wrappers, `sh -c` and `eval` read through. */
export function simpleCommands(command: string): string[][];
