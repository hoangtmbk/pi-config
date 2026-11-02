/**
 * The Lead bridge: a localhost listener the hook script rings after each
 * journal line it writes.
 *
 * A doorbell is one JSON line, `{ type: "doorbell", token, teammate }`. It
 * carries nothing of the event: it only says "read this Teammate's journal
 * from its cursor", so a doorbell lost or rung twice changes nothing. One
 * without the bridge's token is ignored.
 *
 * A held PermissionRequest sends `{ type: "held", token, teammate, request }`
 * instead and keeps its socket open: the line rings the doorbell, and the
 * socket is where {@link Bridge.answer} writes the Lead's decision. The
 * request itself is in the journal; the bridge only knows which socket waits
 * on which request id.
 */

import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

export interface Bridge {
	port: number;
	token: string;
	/**
	 * Send the Lead's decision to the hook holding `request`, ending its hold.
	 * False when no hook holds it any more: answered in the terminal, given up,
	 * or held before this bridge opened.
	 */
	answer(request: string, decision: unknown): boolean;
	close(): void;
}

/** Listen on a free port of 127.0.0.1, calling `rung` with the Teammate each doorbell or held request names. */
export async function openBridge(rung: (teammate: string) => void): Promise<Bridge> {
	const token = randomBytes(24).toString("hex");
	const held = new Map<string, Socket>();
	const server: Server = createServer((socket) => {
		// The Lead's process never waits on a Teammate's hook to exit.
		socket.unref();
		socket.setEncoding("utf8");
		let buffered = "";
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				const rang = doorbell(line, token);
				if (rang === undefined) continue;
				if (rang.request !== undefined) held.set(rang.request, socket);
				rung(rang.teammate);
			}
		});
		socket.on("close", () => {
			for (const [request, holder] of held) if (holder === socket) held.delete(request);
		});
		socket.on("error", () => socket.destroy());
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	server.unref();
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("the Lead bridge has no port");
	return {
		port: address.port,
		token,
		answer(request, decision) {
			const socket = held.get(request);
			if (socket === undefined || socket.destroyed) return false;
			held.delete(request);
			socket.end(`${JSON.stringify({ type: "decision", request, decision })}\n`);
			return true;
		},
		close: () => {
			for (const socket of held.values()) socket.destroy();
			held.clear();
			server.close();
		},
	};
}

/** The Teammate a doorbell or held line names, with the held request's id; undefined for anything else, a wrong token included. */
function doorbell(line: string, token: string): { teammate: string; request?: string } | undefined {
	try {
		const parsed = JSON.parse(line) as { type?: unknown; token?: unknown; teammate?: unknown; request?: unknown };
		if (parsed.token !== token || typeof parsed.teammate !== "string") return undefined;
		if (parsed.type === "doorbell") return { teammate: parsed.teammate };
		if (parsed.type === "held" && typeof parsed.request === "string") return { teammate: parsed.teammate, request: parsed.request };
		return undefined;
	} catch {
		return undefined;
	}
}
