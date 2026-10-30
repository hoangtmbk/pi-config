/**
 * Tool names the extension needs to know: its own, and the ones whose results
 * Pruning never touches.
 *
 * A leaf, importing nothing, so that the entry point, Pruning and the forked
 * call can all name `self_compact` without importing each other.
 */

/**
 * The tool the agent Self-compacts with. Exported from the entry point too,
 * for the subagents extension, which gives it to a Run beside the extension
 * itself.
 */
export const SELF_COMPACT_TOOL = "self_compact";

/**
 * Results that are never pruned, whatever their size or age: a Question's
 * answer is the user's words, a Run's result can't be fetched again and is
 * costly to regenerate, and `self_compact`'s line is what the agent carries on
 * from. Names only, so as not to tie this extension to the subagents one.
 */
export const NEVER_PRUNED: ReadonlySet<string> = new Set(["ask_question", "subagent", "subagent_wait", "subagent_answer", SELF_COMPACT_TOOL]);
