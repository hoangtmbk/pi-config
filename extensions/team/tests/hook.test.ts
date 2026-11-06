/**
 * The hook script, run as Claude Code runs it: a real `node` process with the
 * hook's JSON payload on stdin, against a temp Effort dir and a tiny fake Lead
 * listener standing in for the Lead bridge.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
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
function runHook(
	effortDir: string,
	teammate: string,
	payload: unknown,
	env: Record<string, string> = {},
	args: string[] = [],
): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [HOOK_SCRIPT, effortDir, teammate, ...args], { env: { ...process.env, ...env } });
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

	it("journals what the mod hands it as a mod line, ringing the doorbell, so the Lead hears the human's input in the terminal", async () => {
		const dir = effortDir();
		const lead = await fakeLead();
		writeFileSync(join(dir, "lead.json"), JSON.stringify({ pid: process.pid, port: lead.port, token: "t0ken", sessionFile: "/s.jsonl", startedAt: "2026-11-02T10:00:00.000Z" }));

		const ran = await runHook(dir, "builder-1", { mod: "prompt.submit", payload: { text: "try the other key" } });
		await lead.settled();
		lead.server.close();

		assert.deepEqual(ran, { code: 0, output: "" });
		const [line, ...rest] = journal(dir, "builder-1");
		assert.deepEqual(rest, []);
		assert.equal(typeof line.at, "string");
		assert.deepEqual({ ...line, at: undefined }, { from: "mod", at: undefined, event: "prompt.submit", payload: { text: "try the other key" } });
		assert.deepEqual(lead.lines().map((each) => JSON.parse(each)), [{ type: "doorbell", token: "t0ken", teammate: "builder-1" }]);
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

describe("the hook script as the PreToolUse floor hook", () => {
	const WORKSPACE = "/work/effort";
	const bash = (command: string, cwd = WORKSPACE) => ({
		session_id: STOP.session_id,
		hook_event_name: "PreToolUse",
		cwd,
		tool_name: "Bash",
		tool_input: { command },
		tool_use_id: "toolu_01",
	});

	it("returns `ask` for a floor command, naming the kind, so the human is prompted even in auto", async () => {
		const dir = effortDir();

		const push = await runHook(dir, "builder-1", bash("npm test && git -C . push origin main"), {}, [WORKSPACE]);

		assert.equal(push.code, 0);
		const output = JSON.parse(push.output) as { hookSpecificOutput: Record<string, string> };
		assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
		assert.equal(output.hookSpecificOutput.permissionDecision, "ask");
		assert.match(output.hookSpecificOutput.permissionDecisionReason, /floor: push \(`git -C \. push origin main`\)/);
		assert.equal(journal(dir, "builder-1")[0].event, "PreToolUse");
	});

	it("returns nothing for a command off the floor, or a tool that isn't Bash", async () => {
		const dir = effortDir();

		const results = [
			await runHook(dir, "builder-1", bash("npm test"), {}, [WORKSPACE]),
			await runHook(dir, "builder-1", bash("rm -rf build"), {}, [WORKSPACE]),
			await runHook(dir, "builder-1", bash("curl https://example.com"), {}, [WORKSPACE]),
			await runHook(dir, "builder-1", { ...bash("git push"), tool_name: "Edit", tool_input: { file_path: "a.ts" } }, {}, [WORKSPACE]),
		];

		assert.deepEqual(results, Array(4).fill({ code: 0, output: "" }));
		assert.equal(journal(dir, "builder-1").length, 4);
	});

	it("judges a delete against the Workspace it is given, falling back to the session's cwd", async () => {
		const dir = effortDir();

		const outside = await runHook(dir, "builder-1", bash("rm -rf ../shared", `${WORKSPACE}/pkg`), {}, [`${WORKSPACE}/pkg`]);
		const inside = await runHook(dir, "builder-1", bash("rm -rf ../shared", `${WORKSPACE}/pkg`), {}, [WORKSPACE]);
		const fallback = await runHook(dir, "builder-1", bash("rm -rf /tmp/x"));

		assert.match(outside.output, /"permissionDecision":"ask"/);
		assert.deepEqual(inside, { code: 0, output: "" });
		assert.match(fallback.output, /floor: delete/);
	});

	it("lets through a delete in the Teammate's own job temp folder, `$CLAUDE_JOB_DIR/tmp`, or the payload's scratchpad_dir", async () => {
		const dir = effortDir();
		const job = { HOME: "/home/qa", CLAUDE_CONFIG_DIR: "", CLAUDE_JOB_DIR: "/home/qa/.claude/jobs/bad941c8" };
		const scratch = { ...bash("rm -rf /tmp/claude-501/p/s-1/scratchpad/clone"), scratchpad_dir: "/tmp/claude-501/p/s-1/scratchpad" };

		const results = [
			await runHook(dir, "builder-1", bash("rm -f ~/.claude/jobs/bad941c8/tmp/x"), job, [WORKSPACE]),
			await runHook(dir, "builder-1", bash("rm -rf /home/qa/.claude/jobs/bad941c8/tmp/clone"), job, [WORKSPACE]),
			await runHook(dir, "builder-1", scratch, { CLAUDE_JOB_DIR: "" }, [WORKSPACE]),
		];
		const escape = await runHook(dir, "builder-1", bash("rm -rf ~/.claude/jobs/bad941c8/tmp/../state.json"), job, [WORKSPACE]);
		const variable = await runHook(dir, "builder-1", bash("J=~/.claude/jobs/bad941c8/tmp; rm -rf $J/clone"), job, [WORKSPACE]);
		const noJob = await runHook(dir, "builder-1", bash("rm -f /home/qa/.claude/jobs/bad941c8/tmp/x"), { HOME: "/home/qa", CLAUDE_JOB_DIR: "" }, [WORKSPACE]);

		assert.deepEqual(results, Array(3).fill({ code: 0, output: "" }));
		assert.match(escape.output, /floor: delete/);
		assert.match(variable.output, /floor: delete/);
		assert.match(noJob.output, /floor: delete/);
	});

	it("trusts `$CLAUDE_JOB_DIR` only directly under the Claude Code config folder's `jobs`, and no scratchpad_dir that is `/` or relative", async () => {
		const dir = effortDir();
		const home = { HOME: "/home/qa", CLAUDE_CONFIG_DIR: "" };
		const cases: [Record<string, string>, unknown][] = [
			[{ ...home, CLAUDE_JOB_DIR: "/" }, bash("rm -rf /tmp/important")],
			[{ ...home, CLAUDE_JOB_DIR: "." }, bash(`rm -rf ${join(process.cwd(), "tmp", "x")}`)],
			[{ ...home, CLAUDE_JOB_DIR: "/elsewhere/jobs/bad941c8" }, bash("rm -f /elsewhere/jobs/bad941c8/tmp/x")],
			[{ ...home, CLAUDE_JOB_DIR: "/home/qa/.claude/jobs/bad941c8/deeper" }, bash("rm -f /home/qa/.claude/jobs/bad941c8/deeper/tmp/x")],
			[{ ...home, CLAUDE_JOB_DIR: "/home/qa/.claude/jobs" }, bash("rm -f /home/qa/.claude/jobs/tmp/x")],
			[{ ...home, CLAUDE_JOB_DIR: "/home/qa/.claude/jobs/../x" }, bash("rm -f /home/qa/.claude/x/tmp/y")],
			[{ HOME: "/home/qa", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_JOB_DIR: "/home/qa/.claude/jobs/bad941c8" }, bash("rm -f /home/qa/.claude/jobs/bad941c8/tmp/x")],
			[{ ...home, CLAUDE_JOB_DIR: "" }, { ...bash("find / -delete"), scratchpad_dir: "/" }],
			[{ ...home, CLAUDE_JOB_DIR: "" }, { ...bash(`rm -rf ${join(process.cwd(), "x")}`), scratchpad_dir: "." }],
		];

		for (const [env, payload] of cases) {
			const ran = await runHook(dir, "builder-1", payload, env, [WORKSPACE]);
			assert.match(ran.output, /floor: delete/, JSON.stringify({ env, payload }));
		}
		const configured = await runHook(dir, "builder-1", bash("rm -f /cfg/jobs/bad941c8/tmp/x"), { HOME: "/home/qa", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_JOB_DIR: "/cfg/jobs/bad941c8" }, [WORKSPACE]);
		assert.deepEqual(configured, { code: 0, output: "" });
	});

	it("reads `$CLAUDE_JOB_DIR` in a delete as the job folder once it is trusted, `cd` included, but never the folder itself or a reassigned one", async () => {
		const dir = effortDir();
		const job = { HOME: "/home/qa", CLAUDE_CONFIG_DIR: "", CLAUDE_JOB_DIR: "/home/qa/.claude/jobs/02878adf" };

		for (const command of ["cd $CLAUDE_JOB_DIR/tmp/qa-gg && rm -rf mut && mkdir mut", "rm -rf $CLAUDE_JOB_DIR/tmp/old", 'rm -rf "${CLAUDE_JOB_DIR}/tmp/old"']) {
			assert.deepEqual(await runHook(dir, "builder-1", bash(command), job, [WORKSPACE]), { code: 0, output: "" }, command);
		}
		for (const command of ["rm -rf $CLAUDE_JOB_DIR", "rm -rf $CLAUDE_JOB_DIR/tmp", "CLAUDE_JOB_DIR=/etc; rm -rf $CLAUDE_JOB_DIR/tmp/x", "export CLAUDE_JOB\\_DIR=/etc; rm -rf $CLAUDE_JOB_DIR/tmp/x"]) {
			assert.match((await runHook(dir, "builder-1", bash(command), job, [WORKSPACE])).output, /floor: delete/, command);
		}
		// Untrusted, or not set: the variable is unknown.
		for (const env of [{ ...job, CLAUDE_JOB_DIR: "/elsewhere/jobs/02878adf" }, { ...job, CLAUDE_JOB_DIR: "" }]) {
			assert.match((await runHook(dir, "builder-1", bash("rm -rf /elsewhere/jobs/02878adf/tmp/x $CLAUDE_JOB_DIR/tmp/x"), env, [WORKSPACE])).output, /floor: delete/, env.CLAUDE_JOB_DIR);
		}
	});

	it("with `CLAUDE_CONFIG_DIR=/x`, reads a delete under `/x/jobs/<id>/tmp` as inside and one under `~/.claude/jobs/<id>/tmp` as a floor delete", async () => {
		const dir = effortDir();
		const env = { HOME: "/home/qa", CLAUDE_CONFIG_DIR: "/x", CLAUDE_JOB_DIR: "/x/jobs/02878adf" };

		assert.deepEqual(await runHook(dir, "builder-1", bash("rm -rf /x/jobs/02878adf/tmp/a"), env, [WORKSPACE]), { code: 0, output: "" });
		assert.match((await runHook(dir, "builder-1", bash("rm -rf ~/.claude/jobs/02878adf/tmp/a"), env, [WORKSPACE])).output, /floor: delete/);
	});
});

/**
 * A fake Lead that answers held requests: every `held` line it is sent gets
 * `answer(line)` written back on the same socket, unless that returns undefined.
 */
async function answeringLead(
	answer: (held: { request: string }) => unknown,
): Promise<{ server: Server; port: number; held: () => Record<string, unknown>[]; doorbells: () => Record<string, unknown>[]; stop: () => Promise<void> }> {
	const held: Record<string, unknown>[] = [];
	const doorbells: Record<string, unknown>[] = [];
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		let buffered = "";
		socket.setEncoding("utf8");
		socket.on("error", () => socket.destroy());
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const text of lines) {
				const line = JSON.parse(text) as { type: string; request: string };
				if (line.type === "doorbell") doorbells.push(line);
				if (line.type !== "held") continue;
				held.push(line);
				const reply = answer(line);
				if (reply !== undefined) socket.write(`${JSON.stringify(reply)}\n`);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("the fake Lead has no port");
	/** Stop listening and drop every connection, as a Lead whose pi process dies does. */
	const stop = () => {
		for (const socket of sockets) socket.destroy();
		return new Promise<void>((resolve) => server.close(() => resolve()));
	};
	return { server, port: address.port, held: () => held, doorbells: () => doorbells, stop };
}

function writeLead(dir: string, port: number): void {
	writeFileSync(join(dir, "lead.json"), JSON.stringify({ pid: process.pid, port, token: "t0ken", sessionFile: "/s.jsonl", startedAt: "2026-11-02T10:00:00.000Z" }));
}

const PERMISSION = {
	session_id: STOP.session_id,
	hook_event_name: "PermissionRequest",
	tool_name: "Bash",
	tool_input: { command: "npm publish", description: "Publish the package" },
};

describe("the hook script holding a PermissionRequest", () => {
	it("journals the request with an id, holds it open on the Lead bridge and prints the Lead's decision", async () => {
		const dir = effortDir();
		const lead = await answeringLead(({ request }) => ({ type: "decision", request, decision: { behavior: "allow" } }));
		writeLead(dir, lead.port);

		const result = await runHook(dir, "builder-1", PERMISSION);
		lead.server.close();

		const [line] = journal(dir, "builder-1");
		assert.equal(line.event, "PermissionRequest");
		assert.match(String(line.request), /^req-[0-9a-f]{8}$/);
		assert.deepEqual(lead.held(), [{ type: "held", token: "t0ken", teammate: "builder-1", request: line.request }]);
		assert.equal(result.code, 0);
		assert.deepEqual(JSON.parse(result.output), {
			hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
		});
	});

	it("journals 'denied in terminal' when Claude Code kills the held hook, as it does when the human answers in the terminal", async () => {
		const dir = effortDir();
		const lead = await answeringLead(() => undefined);
		writeLead(dir, lead.port);

		const child = spawn(process.execPath, [HOOK_SCRIPT, dir, "builder-1"]);
		child.stdin.end(JSON.stringify(PERMISSION));
		while (lead.held().length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
		const closed = new Promise((resolve) => child.on("close", resolve));
		child.kill("SIGTERM");
		await closed;
		lead.server.close();

		const lines = journal(dir, "builder-1");
		assert.deepEqual(
			lines.map((line) => [line.event, line.request]),
			[
				["PermissionRequest", lead.held()[0].request],
				["denied-in-terminal", lead.held()[0].request],
			],
		);
	});

	it("gives up holding after its hold time, journalling that, ringing the doorbell and printing nothing, so the prompt stays with the human", async () => {
		const dir = effortDir();
		const lead = await answeringLead(() => undefined);
		writeLead(dir, lead.port);

		const result = await runHook(dir, "builder-1", PERMISSION, { TEAM_HOOK_HOLD_MS: "200" });
		lead.server.close();

		assert.deepEqual(result, { code: 0, output: "" });
		const lines = journal(dir, "builder-1");
		assert.deepEqual(lines.map((line) => line.event), ["PermissionRequest", "hold-expired"]);
		assert.equal(lines[1].request, lines[0].request);
		assert.deepEqual(lead.doorbells(), [{ type: "doorbell", token: "t0ken", teammate: "builder-1" }]);
	});

	it("exits at once with no decision during a Takeover, journalling the prompt without a request id and ringing the doorbell", async () => {
		const dir = effortDir();
		const lead = await answeringLead(({ request }) => ({ type: "decision", request, decision: { behavior: "allow" } }));
		writeLead(dir, lead.port);
		mkdirSync(join(dir, "teammates", "builder-1"), { recursive: true });
		writeFileSync(join(dir, "teammates", "builder-1", "takeover"), "");

		const result = await runHook(dir, "builder-1", PERMISSION);
		lead.server.close();

		assert.deepEqual(result, { code: 0, output: "" });
		const lines = journal(dir, "builder-1");
		assert.deepEqual(lines.map((line) => [line.event, line.request]), [["PermissionRequest", undefined]]);
		assert.deepEqual(lead.held(), []);
		assert.deepEqual(lead.doorbells(), [{ type: "doorbell", token: "t0ken", teammate: "builder-1" }]);
	});

	it("keeps holding with no Lead listening and offers the same request to a new Lead once lead.json names one", async () => {
		const dir = effortDir();
		const gone = await answeringLead(() => undefined);
		await new Promise((resolve) => gone.server.close(resolve));
		writeLead(dir, gone.port);
		const lead = await answeringLead(({ request }) => ({ type: "decision", request, decision: { behavior: "deny", message: "not now" } }));

		const result = runHook(dir, "builder-1", PERMISSION, { TEAM_HOOK_HOLD_MS: "10000" });
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.deepEqual(journal(dir, "builder-1").map((line) => line.event), ["PermissionRequest"]);
		writeLead(dir, lead.port);
		const { code, output } = await result;
		lead.server.close();

		const lines = journal(dir, "builder-1");
		assert.deepEqual(lines.map((line) => line.event), ["PermissionRequest"]);
		assert.deepEqual(lead.held(), [{ type: "held", token: "t0ken", teammate: "builder-1", request: lines[0].request }]);
		assert.equal(code, 0);
		assert.deepEqual(JSON.parse(output), {
			hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "not now" } },
		});
	});

	it("re-sends the same request when the Lead it reached goes away and another takes its place", async () => {
		const dir = effortDir();
		const first = await answeringLead(() => undefined);
		writeLead(dir, first.port);

		const result = runHook(dir, "builder-1", PERMISSION, { TEAM_HOOK_HOLD_MS: "10000" });
		while (first.held().length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
		await first.stop();
		const second = await answeringLead(({ request }) => ({ type: "decision", request, decision: { behavior: "allow" } }));
		writeFileSync(join(dir, "lead.json"), JSON.stringify({ pid: process.pid, port: second.port, token: "n3w", sessionFile: "/s.jsonl", startedAt: "2026-11-02T11:00:00.000Z" }));
		const { code, output } = await result;
		second.server.close();

		assert.deepEqual(second.held(), [{ type: "held", token: "n3w", teammate: "builder-1", request: first.held()[0].request }]);
		assert.equal(code, 0);
		assert.deepEqual(JSON.parse(output).hookSpecificOutput.decision, { behavior: "allow" });
	});

	it("with no Lead at all, holds until its hold time and only then gives the prompt back to the terminal", async () => {
		const dir = effortDir();
		const started = Date.now();

		const result = await runHook(dir, "builder-1", PERMISSION, { TEAM_HOOK_HOLD_MS: "700" });

		assert.ok(Date.now() - started >= 700);
		assert.deepEqual(result, { code: 0, output: "" });
		assert.deepEqual(journal(dir, "builder-1").map((line) => line.event), ["PermissionRequest", "hold-expired"]);
	});
});
