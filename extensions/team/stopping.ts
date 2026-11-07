/**
 * Stopping Teammates, and the sessions a worktree check spares.
 *
 * A Teammate is stopped only with `claude stop <short id>`, never by name or
 * pattern (#133), and what still runs in a worktree is reported, never killed
 * (#127). `claude stop` can return before the session has exited, so each
 * session stopped here is remembered by pid for a while: a worktree check
 * waits briefly for it, and leaves out one still exiting rather than
 * reporting it as something the Teammate left running.
 */

import { agentPids, agentsList, stillListed, stopBackground } from "./claude.ts";
import { type EffortAction, type EffortState, type RunningProcess, runningClause } from "./core.ts";

/** How long a worktree check waits for the sessions `claude stop` ended to exit, since it can return first. */
export const STOP_SETTLE_MS = 3000;

/** How long after `claude stop` a worktree check still counts that session as exiting, rather than its pid as another process's. */
export const STOPPED_RECENTLY_MS = 30_000;

/** Stopping the held Effort's Teammates, and what a worktree check leaves out because of it. */
export interface TeammateStops {
	/**
	 * Stop a Teammate with `claude stop`, which keeps its conversation for the
	 * human to read. One already idle-stopped needs none: a failed stop counts
	 * only while `claude agents --json` still lists it, or can't be read. Its
	 * session's pid is remembered first, for {@link TeammateStops.spared}.
	 */
	stop(state: EffortState, action: Extract<EffortAction, { kind: "stop-teammate" }>): Promise<{ error: string } | undefined>;
	/**
	 * The sessions a worktree check leaves out, with all they started that is
	 * still attached to them, since stopping the Teammates stops those: each of
	 * the Effort's Teammates `claude agents --json` lists as live, and each
	 * session stopped here that is still exiting, `claude stop` having
	 * returned first. Those get up to {@link STOP_SETTLE_MS} to exit before
	 * the check; only one still there after that is left out. Only a session
	 * stopped within {@link STOPPED_RECENTLY_MS} counts, and each counts for
	 * one check, since a pid an exited session had can go to another process.
	 */
	spared(state: EffortState): Promise<number[]>;
}

/** {@link TeammateStops} through the `claude` at `claudePath`, with `now` the clock a stop is remembered by. */
export function teammateStops(claudePath: string, now: () => Date): TeammateStops {
	// The pid of each Teammate session `claude stop` ended here, with when, until a worktree check uses it.
	const stopped = new Map<number, number>();
	return {
		async stop(state, action) {
			const name = state.teammates.find((teammate) => teammate.id === action.teammate)?.name;
			const pid = name === undefined ? undefined : (await agentPids(claudePath)).get(name);
			const failed = await stopBackground(claudePath, action.shortId);
			if (!failed) {
				if (pid !== undefined) stopped.set(pid, now().getTime());
				return undefined;
			}
			const agents = await agentsList(claudePath);
			return stillListed(agents, name) ? failed : undefined;
		},
		async spared(state) {
			const recent = [...stopped].flatMap(([pid, at]) => (now().getTime() - at <= STOPPED_RECENTLY_MS ? [pid] : []));
			stopped.clear();
			const deadline = Date.now() + STOP_SETTLE_MS;
			while (recent.some(processAlive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
			const names = new Set(state.teammates.map((teammate) => teammate.name));
			const live = [...(await agentPids(claudePath))].flatMap(([name, pid]) => (names.has(name) ? [pid] : []));
			return [...new Set([...live, ...recent.filter(processAlive)])];
		},
	};
}

/** Whether process `pid` is still there, even one pi may not signal. Signal 0 only asks; it never stops anything. */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code === "EPERM";
	}
}

/** What is said of the worktree at `path` once it is removed with processes still running in it: undefined when none are. */
export function removedRunning(path: string, running: readonly RunningProcess[]): string | undefined {
	const clause = runningClause(running);
	return clause === undefined ? undefined : `${path} is removed, but ${clause}.`;
}
