#!/usr/bin/env node
/**
 * The command every Teammate hook runs: `node hook.mjs <effort dir> <teammate id>`,
 * with the hook's JSON payload on stdin.
 *
 * Claude Code runs it with plain Node, outside pi, so it is JavaScript with no
 * dependencies. It appends the event to the Teammate's journal,
 * `teammates/<id>/events.jsonl`, as one line in a single write, then rings the
 * Lead's doorbell from `lead.json`: one line naming the Teammate, sent to the
 * Lead bridge's localhost port with its token. The doorbell is only a nudge;
 * the journal is the record, and the Lead reads it from its cursor, so a Lead
 * that isn't listening misses nothing.
 *
 * For every event but two it prints nothing and exits 0, which lets the event
 * through unchanged.
 *
 * A `PreToolUse` for `Bash` is the floor hook: when the floor classifier
 * (`floor.mjs`) finds an irreversible outward action in the command, the hook
 * prints `permissionDecision: "ask"`, so Claude Code prompts even in `auto`
 * and the prompt arrives as a held `PermissionRequest`. The Workspace it
 * judges deletes against is the hook command's third argument, given only to
 * this hook, and the session's `cwd` when it is missing. A delete in the
 * Teammate's own temp folders (`$CLAUDE_JOB_DIR/tmp`, and the payload's
 * `scratchpad_dir` when it has one) is inside too. It is a guardrail, not a
 * security boundary.
 *
 * A `PermissionRequest` (an AskUserQuestion included) is held instead: the
 * journal line carries a request id, and the hook keeps a socket open to the
 * Lead bridge with a `held` line naming it, which also rings the doorbell. The
 * prompt stays live in the Teammate's terminal meanwhile, and the first answer
 * wins:
 *   - the Lead's `decision` line arrives: the hook prints it as the hook's
 *     decision and exits 0;
 *   - the human answers in the terminal: Claude Code kills the hook with
 *     SIGTERM, journalled as `denied-in-terminal` (the hook can't tell which
 *     answer the human gave; a PostToolUse follows if it was allowed);
 *   - the hold time runs out, or no Lead is listening: journalled as
 *     `hold-expired` with a doorbell, the hook exits 0 printing nothing and
 *     the prompt is the human's alone. The hold time stops short of the hook's own timeout so the
 *     hook, not Claude Code's kill, decides how the hold ended.
 *
 * During a Takeover (`teammates/<id>/takeover` exists) a `PermissionRequest`
 * isn't held: it is journalled without a request id, the doorbell rings, and
 * the hook exits 0 printing nothing, so the prompt is the human's.
 *
 * The Team's mod runs this command too, with `{ mod, payload }` on stdin for
 * what the human does in the terminal: it is journalled as a `mod` line and
 * the doorbell rings, as for any event.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { floorAction } from "./floor.mjs";

/** How long the doorbell may take before the hook gives up on it; the journal line is already written. */
const DOORBELL_TIMEOUT_MS = 2_000;

/**
 * How long a held PermissionRequest waits for the Lead: 30 s short of the
 * hook's 3600 s timeout. `TEAM_HOOK_HOLD_MS` overrides it for tests.
 */
const HOLD_MS = Number(process.env.TEAM_HOOK_HOLD_MS) > 0 ? Number(process.env.TEAM_HOOK_HOLD_MS) : 3_570_000;

/** How often a held request looks at `lead.json` for a new Lead to offer itself to. */
const WATCH_MS = 200;

const [effortDir, teammate, workspace] = process.argv.slice(2);

function readStdin() {
	return new Promise((resolve) => {
		let text = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => (text += chunk));
		process.stdin.on("end", () => resolve(text));
		process.stdin.on("error", () => resolve(text));
	});
}

/** The payload as Claude Code sent it, or the raw text when it isn't JSON. */
function parse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return { unparsed: text };
	}
}

/**
 * One journal line. What the mod hands over, `{ mod, payload }` (the human's
 * input in the Teammate's terminal), is a mod line of that event. A `SessionStart` also carries the inbox socket and token, which reach hooks only through the environment. */
function journalLine(payload, request) {
	if (typeof payload?.mod === "string" && payload.hook_event_name === undefined) return `${JSON.stringify({ from: "mod", at: new Date().toISOString(), event: payload.mod, payload: payload.payload ?? {} })}\n`;
	const line = { from: "hook", at: new Date().toISOString(), event: payload?.hook_event_name, payload };
	if (request) line.request = request;
	const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
	const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
	if (line.event === "SessionStart" && socket && token) line.inbox = { socket, token };
	return `${JSON.stringify(line)}\n`;
}

/** The Lead bridge's port and token from `lead.json`, or undefined when there is no Lead to reach. */
function readLead() {
	let lead;
	try {
		lead = JSON.parse(readFileSync(join(effortDir, "lead.json"), "utf8"));
	} catch {
		return undefined;
	}
	return typeof lead?.port === "number" && typeof lead?.token === "string" ? lead : undefined;
}

function ringDoorbell() {
	const lead = readLead();
	if (lead === undefined) return Promise.resolve();
	return new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port: lead.port });
		const done = () => {
			socket.destroy();
			resolve();
		};
		socket.setTimeout(DOORBELL_TIMEOUT_MS, done);
		socket.on("error", done);
		socket.on("close", done);
		socket.on("connect", () => socket.end(`${JSON.stringify({ type: "doorbell", token: lead.token, teammate })}\n`));
	});
}

/** One journal line about a held request's end, which has no payload of its own. */
function heldLine(event, request) {
	return `${JSON.stringify({ from: "hook", at: new Date().toISOString(), event, request })}\n`;
}

/** Hold the request open on the Lead bridge until a Lead decides, the human answers or the hold time runs out. */
function hold(journal, request) {
	let expiring = false;
	const expire = async () => {
		if (expiring) return;
		expiring = true;
		appendFileSync(journal, heldLine("hold-expired", request));
		await ringDoorbell();
		process.exit(0);
	};
	process.on("SIGTERM", () => {
		appendFileSync(journal, heldLine("denied-in-terminal", request));
		process.exit(143);
	});
	setTimeout(expire, HOLD_MS);
	// Offer the request to whichever Lead `lead.json` names, and offer it again,
	// with the same id, whenever another Lead takes its place. A Lead that isn't
	// listening, or goes away, leaves the request held until the hold time runs out.
	let offered;
	let socket;
	const offer = () => {
		const lead = readLead();
		if (lead === undefined || `${lead.port}:${lead.token}` === offered) return;
		offered = `${lead.port}:${lead.token}`;
		socket?.destroy();
		const current = connect({ host: "127.0.0.1", port: lead.port });
		socket = current;
		let buffered = "";
		current.setEncoding("utf8");
		current.on("error", () => current.destroy());
		current.on("connect", () => current.write(`${JSON.stringify({ type: "held", token: lead.token, teammate, request })}\n`));
		current.on("data", (chunk) => {
			buffered += chunk;
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const text of lines) {
				const line = parse(text);
				if (line?.type !== "decision" || line.request !== request || typeof line.decision !== "object") continue;
				process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: line.decision } }), () => process.exit(0));
				return;
			}
		});
	};
	offer();
	setInterval(offer, WATCH_MS);
}

/**
 * The Teammate's own temp folders, where a delete isn't on the floor: its
 * Claude Code job temp folder, `$CLAUDE_JOB_DIR/tmp`, which Claude Code sets
 * for a background session and tells it to keep scratch files in, and the
 * session's scratchpad when the payload names one.
 */
function ownTempFolders(payload) {
	const job = process.env.CLAUDE_JOB_DIR;
	return [...(job ? [join(job, "tmp")] : []), ...(typeof payload.scratchpad_dir === "string" && payload.scratchpad_dir !== "" ? [payload.scratchpad_dir] : [])];
}

/** The floor hook's `ask` for a `PreToolUse` of a floor command, or undefined to let it through. */
function floorAsk(payload) {
	if (payload?.hook_event_name !== "PreToolUse" || payload.tool_name !== "Bash") return undefined;
	const command = payload.tool_input?.command;
	const root = workspace || payload.cwd;
	if (typeof command !== "string" || typeof root !== "string") return undefined;
	const floor = floorAction(command, { workspace: root, cwd: typeof payload.cwd === "string" ? payload.cwd : undefined, roots: ownTempFolders(payload) });
	if (floor === undefined) return undefined;
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "ask",
			permissionDecisionReason: `floor: ${floor.kind} (\`${floor.command}\`), an irreversible outward action, so it always comes to the human`,
		},
	};
}

const payload = parse(await readStdin());
if (effortDir && teammate) {
	const dir = join(effortDir, "teammates", teammate);
	mkdirSync(dir, { recursive: true });
	const journal = join(dir, "events.jsonl");
	// A Takeover (the marker the Lead writes) leaves every prompt with the human: journalled
	// without a request id, so nothing waits on the Lead, and the doorbell rings as for any event.
	if (payload?.hook_event_name === "PermissionRequest" && !existsSync(join(dir, "takeover"))) {
		const request = `req-${randomBytes(4).toString("hex")}`;
		appendFileSync(journal, journalLine(payload, request));
		hold(journal, request);
	} else {
		appendFileSync(journal, journalLine(payload));
		await ringDoorbell();
		const floor = floorAsk(payload);
		if (floor) process.stdout.write(JSON.stringify(floor), () => process.exit(0));
		else process.exit(0);
	}
} else process.exit(0);
