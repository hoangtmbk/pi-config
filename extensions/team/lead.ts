/**
 * Leading an Effort across pi sessions: the lock, the session pointer, and
 * the mark a Lead leaves behind.
 *
 * An Effort has at most one Lead. `lead.json` names it: its pid, its bridge
 * and its session file. Taking the Lead holds `lead.lock`, created
 * exclusively, around reading `lead.json` and writing it again, so two
 * sessions taking it at once can't both win. The lock lives only that long; a
 * lock left behind by a pid that has died is taken over. A Lead that leaves
 * marks `lead.json` with `stoppedAt` and drops its bridge, so the record of
 * which session led it is never deleted.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fold } from "./core.ts";
import { type EffortPaths, effortPaths, effortsDir, type LeadRecord, type NoLiveLead, readLead, readLines, writeLead } from "./records.ts";

/** The session taking or leaving the Lead: the pi process it runs in, and its session file. */
export interface Leader {
	pid: number;
	/** Absent for a session kept in memory, which nothing can re-attach to. */
	sessionFile?: string;
}

/** The session pointer, a `team-effort` custom entry: the Effort the session leads. */
export interface EffortPointer {
	effortId: string;
	effortDir: string;
}

/** The custom type of the session pointer. */
export const POINTER = "team-effort";

/** How long a lock held by a live pid is waited for before the Lead is refused. */
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 25;

/** Whether a process with this pid is running. One owned by another user counts. */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The Lead `lead.json` names while it is live: not marked, and its pid running. */
export function liveLead(paths: EffortPaths): LeadRecord | undefined {
	const lead = readLead(paths);
	return lead && !("stoppedAt" in lead) && isAlive(lead.pid) ? lead : undefined;
}

/** The session a Lead runs in, as the human reads it. */
export function holderText(lead: { pid: number; sessionFile?: string }): string {
	return lead.sessionFile ? `the pi session ${lead.sessionFile} (pid ${lead.pid})` : `a pi session kept in memory (pid ${lead.pid})`;
}

/**
 * Take the Lead of an Effort for `me`, listening on `bridge`: refused while
 * another session is its live Lead, naming that session. `me` taking it again
 * is no refusal.
 */
export async function takeLead(paths: EffortPaths, me: Leader, bridge: { port: number; token: string }, startedAt: string): Promise<{ refusal: string } | undefined> {
	const effortId = effortIdOf(paths);
	const locked = await lock(paths, me.pid);
	if (locked) return { refusal: `Effort \`${effortId}\` can't be led from here: ${locked}` };
	try {
		const live = liveLead(paths);
		if (live && !(live.pid === me.pid && live.sessionFile === me.sessionFile)) {
			return { refusal: `Effort \`${effortId}\` already has a live Lead: ${holderText(live)}. Lead it from that session, or quit it there first.` };
		}
		writeLead(paths, { pid: me.pid, port: bridge.port, token: bridge.token, sessionFile: me.sessionFile, startedAt });
		return undefined;
	} finally {
		rmSync(lockPath(paths), { force: true });
	}
}

/**
 * Leave the Lead: mark `lead.json` as no live Lead, when `me` is the Lead it
 * names. `moveTo` is the session the Effort moves to, which re-attaches to it.
 */
export async function leaveLead(paths: EffortPaths, me: Leader, stoppedAt: string, moveTo?: string): Promise<void> {
	const locked = await lock(paths, me.pid);
	if (locked) throw new Error(`Effort \`${effortIdOf(paths)}\` couldn't be marked as having no live Lead: ${locked}`);
	try {
		const lead = readLead(paths);
		if (!lead || "stoppedAt" in lead || lead.pid !== me.pid || lead.sessionFile !== me.sessionFile) return;
		const left: NoLiveLead = { pid: lead.pid, sessionFile: moveTo ?? lead.sessionFile, startedAt: lead.startedAt, stoppedAt };
		writeLead(paths, left);
	} finally {
		rmSync(lockPath(paths), { force: true });
	}
}

/** The last session pointer among a session's entries: the Effort it leads. */
export function pointerIn(entries: readonly unknown[]): EffortPointer | undefined {
	let found: EffortPointer | undefined;
	for (const entry of entries) {
		const { type, customType, data } = (entry ?? {}) as { type?: unknown; customType?: unknown; data?: Partial<EffortPointer> };
		if (type === "custom" && customType === POINTER && typeof data?.effortId === "string" && typeof data.effortDir === "string") {
			found = { effortId: data.effortId, effortDir: data.effortDir };
		}
	}
	return found;
}

/** Every Effort under the agent dir, oldest id first. */
function effortIds(agentDir: string): string[] {
	const dir = effortsDir(agentDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "effort.jsonl")))
		.map((entry) => entry.name)
		.sort();
}

/** The Efforts `/team resume` can adopt: those not yet ended, with no live Lead. */
export function adoptable(agentDir: string): string[] {
	return effortIds(agentDir).filter((id) => !liveLead(effortPaths(agentDir, id)) && !hasEnded(effortPaths(agentDir, id)));
}

/** Whether the Effort is over, signed off or cancelled: one that has ended is never led again. */
export function hasEnded(paths: EffortPaths): boolean {
	return existsSync(paths.log) && fold(readLines(paths)).ended !== undefined;
}

/** The Effort whose `lead.json` names this session file, for a session that carries no pointer to it: a fork of its Lead's first entries. */
export function ledFrom(agentDir: string, sessionFile: string): string | undefined {
	return effortIds(agentDir).find((id) => readLead(effortPaths(agentDir, id))?.sessionFile === sessionFile);
}

function lockPath(paths: EffortPaths): string {
	return join(paths.dir, "lead.lock");
}

function effortIdOf(paths: EffortPaths): string {
	return paths.dir.split(/[\\/]/).pop() ?? paths.dir;
}

/**
 * Create `lead.lock` exclusively, holding `pid`. A lock whose pid has died is
 * taken over; one held by a live pid is waited for, then refused with why.
 */
async function lock(paths: EffortPaths, pid: number): Promise<string | undefined> {
	const path = lockPath(paths);
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			const fd = openSync(path, "wx");
			try {
				writeSync(fd, `${pid}\n`);
			} finally {
				closeSync(fd);
			}
			return undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const holder = lockHolder(path);
		if (holder !== undefined && !isAlive(holder)) {
			rmSync(path, { force: true });
			continue;
		}
		if (Date.now() >= deadline) {
			// A lock that never came to name its pid was left half made, and is taken over too.
			if (holder === undefined) {
				rmSync(path, { force: true });
				continue;
			}
			return `${path} is held by pid ${holder}, a live process, which is taking or leaving the Lead`;
		}
		await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
	}
}

/** The pid a lock holds, or undefined for one gone, or not yet naming its pid. */
function lockHolder(path: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}
