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
 * It prints nothing and exits 0, which lets every event through unchanged.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

/** How long the doorbell may take before the hook gives up on it; the journal line is already written. */
const DOORBELL_TIMEOUT_MS = 2_000;

const [effortDir, teammate] = process.argv.slice(2);

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

/** One journal line. A `SessionStart` also carries the inbox socket and token, which reach hooks only through the environment. */
function journalLine(payload) {
	const line = { from: "hook", at: new Date().toISOString(), event: payload?.hook_event_name, payload };
	const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
	const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
	if (line.event === "SessionStart" && socket && token) line.inbox = { socket, token };
	return `${JSON.stringify(line)}\n`;
}

function ringDoorbell() {
	let lead;
	try {
		lead = JSON.parse(readFileSync(join(effortDir, "lead.json"), "utf8"));
	} catch {
		return Promise.resolve();
	}
	if (typeof lead?.port !== "number" || typeof lead?.token !== "string") return Promise.resolve();
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

const payload = parse(await readStdin());
if (effortDir && teammate) {
	const dir = join(effortDir, "teammates", teammate);
	mkdirSync(dir, { recursive: true });
	appendFileSync(join(dir, "events.jsonl"), journalLine(payload));
	await ringDoorbell();
}
process.exit(0);
