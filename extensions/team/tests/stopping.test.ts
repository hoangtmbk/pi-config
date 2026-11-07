/**
 * Stopping Teammates by short id, and the sessions a worktree check spares
 * because of it (#127, #133), against a tiny scripted `claude`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { EffortState } from "../core.ts";
import { processAlive, removedRunning, STOPPED_RECENTLY_MS, teammateStops } from "../stopping.ts";
import { tempRoots } from "./harness.ts";

/**
 * A `claude` that lists `agents` for `agents --json`, records each `stop`, and
 * fails a stop with `stopExit` when set.
 */
function scriptedClaude(agents: { name: string; pid: number }[], options: { stopExit?: number } = {}): { path: string; stops: string } {
	const { scratch } = tempRoots();
	const path = join(scratch, "claude");
	const stops = join(scratch, "stops.txt");
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			"const [command, id] = process.argv.slice(2);",
			`if (command === "agents") { process.stdout.write(${JSON.stringify(JSON.stringify(agents))}); process.exit(0); }`,
			`if (command === "stop") { fs.appendFileSync(${JSON.stringify(stops)}, id + "\\n"); if (${options.stopExit ?? 0}) { process.stderr.write("no such session"); process.exit(${options.stopExit ?? 0}); } process.exit(0); }`,
			"process.exit(2);",
		].join("\n"),
	);
	chmodSync(path, 0o755);
	return { path, stops };
}

/** Just enough of an Effort's state: its Teammates' ids and names. */
function stateWith(teammates: { id: string; name: string }[]): EffortState {
	return { teammates } as unknown as EffortState;
}

/** The pid a process had once it has exited. */
function deadPid(): number {
	const child = spawnSync(process.execPath, ["-e", ""]);
	assert.ok(child.pid);
	return child.pid;
}

const STOP = { kind: "stop-teammate", teammate: "dev-1", shortId: "abc12345" } as const;

describe("teammateStops", () => {
	it("stops a Teammate by its short id, and a worktree check spares its session while it is still exiting, once", async () => {
		// The test's own process stands in for a session that outlives `claude stop`.
		const claude = scriptedClaude([{ name: "team-dev-1", pid: process.pid }]);
		const stops = teammateStops(claude.path, () => new Date());
		const state = stateWith([{ id: "dev-1", name: "team-dev-1" }]);
		assert.equal(await stops.stop(state, STOP), undefined);
		const notListed = stateWith([]);
		assert.deepEqual(await stops.spared(notListed), [process.pid]);
		assert.deepEqual(await stops.spared(notListed), [], "a stopped session counts for one check");
	});

	it("doesn't spare a session stopped longer ago than STOPPED_RECENTLY_MS, whose pid may be another process's", async () => {
		const claude = scriptedClaude([{ name: "team-dev-1", pid: process.pid }]);
		let at = 0;
		const stops = teammateStops(claude.path, () => new Date(at));
		await stops.stop(stateWith([{ id: "dev-1", name: "team-dev-1" }]), STOP);
		at = STOPPED_RECENTLY_MS + 1;
		assert.deepEqual(await stops.spared(stateWith([])), []);
	});

	it("doesn't spare a stopped session that has exited", async () => {
		const claude = scriptedClaude([{ name: "team-dev-1", pid: deadPid() }]);
		const stops = teammateStops(claude.path, () => new Date());
		await stops.stop(stateWith([{ id: "dev-1", name: "team-dev-1" }]), STOP);
		assert.deepEqual(await stops.spared(stateWith([])), []);
	});

	it("spares the live sessions of the Effort's own Teammates only", async () => {
		const claude = scriptedClaude([
			{ name: "team-dev-1", pid: 101 },
			{ name: "someone-else", pid: 102 },
		]);
		const stops = teammateStops(claude.path, () => new Date());
		assert.deepEqual(await stops.spared(stateWith([{ id: "dev-1", name: "team-dev-1" }])), [101]);
	});

	it("counts a failed stop only while `claude agents --json` still lists the Teammate", async () => {
		const listed = scriptedClaude([{ name: "team-dev-1", pid: 101 }], { stopExit: 1 });
		const failed = await teammateStops(listed.path, () => new Date()).stop(stateWith([{ id: "dev-1", name: "team-dev-1" }]), STOP);
		assert.deepEqual(failed, { error: "no such session" });
		const gone = scriptedClaude([], { stopExit: 1 });
		assert.equal(await teammateStops(gone.path, () => new Date()).stop(stateWith([{ id: "dev-1", name: "team-dev-1" }]), STOP), undefined);
	});
});

describe("processAlive", () => {
	it("tells a live process from one that has exited", () => {
		assert.equal(processAlive(process.pid), true);
		assert.equal(processAlive(deadPid()), false);
	});
});

describe("removedRunning", () => {
	it("says nothing of a worktree removed with nothing running in it", () => {
		assert.equal(removedRunning("/w", []), undefined);
	});

	it("names what still runs in a removed worktree", () => {
		const said = removedRunning("/w", [{ pid: 42, command: "node serve.js" }]);
		assert.ok(said?.startsWith("/w is removed, but "), said);
		assert.ok(said?.includes("42"), said);
	});
});
