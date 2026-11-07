/**
 * What an Effort's end, sign-off or cancel, does with its worktrees, and what
 * the Lead is told of it (#132). Every branch stays and a clean worktree
 * goes, unless a Teammate didn't stop: then every worktree is left in place.
 * What still runs in a worktree is named, never stopped (#127).
 */

import type { EffortLine, EndedWorktree } from "./core.ts";
import { type EffortWorktree, effortWorktrees, endWorktrees } from "./workspace.ts";

/** The `worktrees-ended` line: what became of each worktree, and what still runs in it. */
export type WorktreesEnded = Extract<EffortLine, { type: "worktrees-ended" }>;

/**
 * End Effort `effortId`'s worktrees in `repo` and say what became of them:
 * the clean ones removed, the rest kept with why; all kept while a Teammate
 * in `unstopped` didn't stop. `spared` gives the sessions the check of what
 * still runs leaves out. A git failure is the line's `error`, not a throw.
 */
export async function endEffortWorktrees(repo: string, effortId: string, unstopped: readonly string[], spared: () => Promise<number[]>, at: string): Promise<WorktreesEnded> {
	const ended: WorktreesEnded = { type: "worktrees-ended", removed: [], kept: [], at };
	const shown = (each: EffortWorktree): EndedWorktree => ({ path: each.path, branch: each.branch, running: each.running });
	try {
		if (unstopped.length > 0) {
			const why = `${unstopped.length === 1 ? "a Teammate" : "Teammates"} didn't stop, so every worktree is left in place`;
			ended.kept = effortWorktrees(repo, effortId, await spared()).map((each) => ({ ...shown(each), why }));
		} else {
			const { removed, kept } = endWorktrees(repo, effortId, await spared());
			ended.removed = removed.map(shown);
			ended.kept = kept.map((each) => ({ ...shown(each), why: each.why }));
		}
	} catch (error) {
		ended.error = error instanceof Error ? error.message : String(error);
	}
	return ended;
}

/**
 * The Lead's end-of-Effort message: what the end step said, what became of
 * the worktrees (`told`, from {@link WorktreesEnded}), and the warnings that
 * keep it from using a removed worktree or stopping a process itself.
 */
export function endedLeadText(said: string, told: readonly string[], ended: WorktreesEnded): string {
	const lead = [said, ...told];
	if (ended.removed.length > 0) lead.push("A removed worktree is gone: don't `cd` into it or run anything there; its branch keeps the work.");
	if ([...ended.removed, ...ended.kept].some((each) => each.running.length > 0)) lead.push("Never stop a process named here yourself: tell the human, who decides.");
	return `${lead.join(" ")} This session holds no Effort now, so the Team tools are off.`;
}
