/**
 * Asking the operating system whether a child process is really gone.
 *
 * The one thing an orphaned pi child cannot hide from: whatever the extension
 * believes about a Run, the kernel knows whether its process is still there.
 *
 * Not a `.test.ts` file, so `npm test` never runs it directly.
 */

import { existsSync, readFileSync } from "node:fs";

/** How long either question is asked for before it gives up. */
const ATTEMPTS = 300;
const EVERY_MS = 10;

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, EVERY_MS));
}

/**
 * The pid a child wrote for itself, waited for.
 *
 * The file appears when the child does, which is the moment a test that is
 * about a child still starting up has something to ask the kernel about.
 */
export async function pidFrom(path: string): Promise<number> {
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		if (existsSync(path)) return Number(readFileSync(path, "utf-8"));
		await tick();
	}
	throw new Error(`no child wrote its pid to ${path} in time`);
}

/**
 * Whether a process has gone, waited on rather than sampled.
 *
 * A SIGKILLed child dies a moment after the signal is sent, and a dead one
 * lingers as a zombie until its parent reaps it, so the honest question is
 * whether it goes — not whether it has gone by the next line of the test.
 */
export async function reaped(pid: number): Promise<boolean> {
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await tick();
	}
	return false;
}
