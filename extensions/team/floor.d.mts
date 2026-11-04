/** Types for `floor.mjs`, the floor classifier, which stays plain JavaScript so the hook script can import it. */

/** The kinds of floor action a command can spell. */
export type FloorKind = "push" | "publish" | "deploy" | "delete" | "send";

/** A floor action, and the simple command that takes it. */
export interface FloorAction {
	kind: FloorKind;
	command: string;
}

/** Where a command runs: the Workspace, and its own directory (the Workspace when not given). */
export interface FloorWhere {
	workspace: string;
	cwd?: string;
	/** Other folders that are the Teammate's own, such as its Claude Code job temp folder: a delete under one is inside, as under the Workspace. */
	roots?: string[];
	/** The folder a leading `~` or `$HOME` names; this user's home when not given. */
	home?: string;
}

/** The floor action a Bash command takes, or undefined when it takes none. */
export function floorAction(command: string, where: FloorWhere): FloorAction | undefined;

/** The simple commands in a Bash command, each as its words, past env assignments and wrappers, `sh -c` and `eval` read through. */
export function simpleCommands(command: string): string[][];
