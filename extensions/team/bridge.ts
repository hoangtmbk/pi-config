/**
 * The Lead bridge: a localhost listener the hook script rings after each
 * journal line it writes.
 *
 * A doorbell is one JSON line, `{ type: "doorbell", token, teammate }`. It
 * carries nothing of the event: it only says "read this Teammate's journal
 * from its cursor", so a doorbell lost or rung twice changes nothing. One
 * without the bridge's token is ignored.
 */

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:net";

export interface Bridge {
	port: number;
	token: string;
	close(): void;
}

/** Listen on a free port of 127.0.0.1, calling `rung` with the Teammate each doorbell names. */
export async function openBridge(rung: (teammate: string) => void): Promise<Bridge> {
	const token = randomBytes(24).toString("hex");
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
				const teammate = doorbell(line, token);
				if (teammate !== undefined) rung(teammate);
			}
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
	return { port: address.port, token, close: () => server.close() };
}

/** The Teammate a doorbell line names, or undefined for anything else, a wrong token included. */
function doorbell(line: string, token: string): string | undefined {
	try {
		const parsed = JSON.parse(line) as { type?: unknown; token?: unknown; teammate?: unknown };
		return parsed.type === "doorbell" && parsed.token === token && typeof parsed.teammate === "string" ? parsed.teammate : undefined;
	} catch {
		return undefined;
	}
}
