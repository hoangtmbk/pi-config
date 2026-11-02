/**
 * The hook script, run as Claude Code runs it: a real `node` process with the
 * hook's JSON payload on stdin, against a temp Effort dir and a tiny fake Lead
 * listener standing in for the Lead bridge.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HOOK_SCRIPT } from "../claude.ts";
import { tempRoots } from "./harness.ts";

/** A fake Lead: a localhost listener that records every line it is sent. */
async function fakeLead(): Promise<{ server: Server; port: number; lines: () => string[]; settled: () => Promise<void> }> {
	const lines: string[] = [];
	let open = 0;
	let idle: (() => void) | undefined;
	const server = createServer((socket) => {
		open++;
		let buffered = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffered += chunk;
		});
		socket.on("close", () => {
			lines.push(...buffered.split("\n").filter(Boolean));
			open--;
			if (open === 0) idle?.();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("the fake Lead has no port");
	return {
		server,
		port: address.port,
		lines: () => lines,
		settled: () => (open === 0 ? Promise.resolve() : new Promise((resolve) => (idle = resolve))),
	};
}

/** Run the hook script for `teammate` with `payload` on stdin; resolves with its exit code and output. */
function runHook(effortDir: string, teammate: string, payload: unknown, env: Record<string, string> = {}): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [HOOK_SCRIPT, effortDir, teammate], { env: { ...process.env, ...env } });
		let output = "";
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, output }));
		child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
	});
}

function effortDir(): string {
	const dir = join(tempRoots().scratch, "effort");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function journal(dir: string, teammate: string): Record<string, unknown>[] {
	const file = join(dir, "teammates", teammate, "events.jsonl");
	return existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
		: [];
}

const STOP = { session_id: "8f3c2a1b-0000-4000-8000-000000000001", hook_event_name: "Stop", last_assistant_message: "Done: renamed the key." };

describe("the hook script", () => {
	it("appends the event to the Teammate's journal as one line, then rings the Lead's doorbell with its token", async () => {
		const dir = effortDir();
		const lead = await fakeLead();
		writeFileSync(join(dir, "lead.json"), JSON.stringify({ pid: process.pid, port: lead.port, token: "t0ken", sessionFile: "/s.jsonl", startedAt: "2026-11-02T10:00:00.000Z" }));

		const first = await runHook(dir, "builder-1", { session_id: STOP.session_id, hook_event_name: "UserPromptSubmit", prompt: "New Task" });
		const second = await runHook(dir, "builder-1", STOP);
		await lead.settled();
		lead.server.close();

		assert.deepEqual([first, second], [
			{ code: 0, output: "" },
			{ code: 0, output: "" },
		]);
		const lines = journal(dir, "builder-1");
		assert.equal(lines.length, 2);
		assert.equal(lines[0].event, "UserPromptSubmit");
		assert.deepEqual(lines[1].payload, STOP);
		assert.equal(lines[1].event, "Stop");
		assert.equal(typeof lines[1].at, "string");
		assert.deepEqual(
			lead.lines().map((line) => JSON.parse(line)),
			[
				{ type: "doorbell", token: "t0ken", teammate: "builder-1" },
				{ type: "doorbell", token: "t0ken", teammate: "builder-1" },
			],
		);
	});

	it("journals a SessionStart with the inbox socket and token Claude Code gives the hook", async () => {
		const dir = effortDir();

		await runHook(
			dir,
			"builder-1",
			{ session_id: STOP.session_id, hook_event_name: "SessionStart", source: "startup" },
			{ CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/4242.sock", CLAUDE_CODE_MESSAGING_TOKEN: "inbox-token" },
		);

		const [line] = journal(dir, "builder-1");
		assert.equal(line.event, "SessionStart");
		assert.deepEqual(line.inbox, { socket: "/tmp/cc-socks/4242.sock", token: "inbox-token" });
	});

	it("still journals the event and exits 0 when no Lead is listening", async () => {
		const dir = effortDir();
		const lead = await fakeLead();
		const port = lead.port;
		await new Promise((resolve) => lead.server.close(resolve));
		writeFileSync(join(dir, "lead.json"), JSON.stringify({ pid: 1, port, token: "t0ken", sessionFile: "/s.jsonl", startedAt: "2026-11-02T10:00:00.000Z" }));

		const closed = await runHook(dir, "builder-1", STOP);
		const missing = await runHook(effortDir(), "builder-1", STOP);

		assert.deepEqual([closed, missing], [
			{ code: 0, output: "" },
			{ code: 0, output: "" },
		]);
		assert.equal(journal(dir, "builder-1").length, 1);
	});
});
