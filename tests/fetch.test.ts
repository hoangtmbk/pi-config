/**
 * HTTP layer behaviour (phases 2.1, 2.2, 2.5, 2.6, 2.7).
 *
 * Everything runs against a `node:http` server on an ephemeral loopback port,
 * so the suite never touches the network.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { extract } from "../extract.ts";
import { type FetchedPage, fetchPage, WebFetchError } from "../fetch.ts";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run `body` against a throwaway server; `base` is `127.0.0.1:<port>`, scheme-less on purpose. */
async function withServer<T>(handler: Handler, body: (base: string) => Promise<T>): Promise<T> {
	const open: http.ServerResponse[] = [];
	const server = http.createServer((req, res) => {
		// Aborted clients make writes fail; that is expected, not a test failure.
		req.on("error", () => {});
		res.on("error", () => {});
		open.push(res);
		handler(req, res);
	});
	server.on("clientError", () => {});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	try {
		return await body(`127.0.0.1:${port}`);
	} finally {
		for (const res of open) res.destroy();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

/** A port nothing is listening on, for connection-refused cases. */
async function closedPort(): Promise<number> {
	const server = http.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/** The error a promise rejects with — assertions read better than `assert.rejects` matchers. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected the call to reject");
}

function text(status: number, contentType: string, payload: string): Handler {
	return (_req, res) => {
		res.writeHead(status, { "content-type": contentType });
		res.end(payload);
	};
}

/** Send headers and one chunk, then hold the connection open forever. */
const stall = (started: { resolve: () => void }): Handler => {
	return (_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.write("partial body ");
		started.resolve();
	};
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("request headers", () => {
	it("negotiates markdown first and keeps the browser identity", async () => {
		let headers: http.IncomingHttpHeaders = {};
		await withServer(
			(req, res) => {
				headers = req.headers;
				text(200, "text/plain", "ok")(req, res);
			},
			async (base) => {
				assert.equal((await fetchPage(`http://${base}/`)).body, "ok");
			},
		);

		assert.equal(
			headers.accept,
			"text/markdown, text/html;q=0.9, application/json;q=0.8, text/plain;q=0.7, */*;q=0.5",
		);
		assert.equal(headers["accept-language"], "en-US,en;q=0.9");
		assert.match(String(headers["user-agent"]), /Chrome\/126/);
		// No client hints: a Chrome UA carrying half a hint set is what bot walls look for.
		// `sec-fetch-mode` is the one exception — Node's fetch forces it and ignores overrides.
		const hints = Object.keys(headers).filter((key) => /^sec-/i.test(key) && key !== "sec-fetch-mode");
		assert.deepEqual(hints, []);
	});

	it("passes text/markdown through as text", async () => {
		const page = await withServer(text(200, "text/markdown; charset=utf-8", "# Title\n\nBody text.\n"), (base) =>
			fetchPage(`http://${base}/readme.md`),
		);

		assert.equal(page.contentType, "text/markdown");
		const extracted = extract(page, false);
		assert.equal(extracted.mode, "text");
		assert.equal(extracted.markdown, "# Title\n\nBody text.");
	});
});

describe("user-agent retry", () => {
	it("retries once with the plain UA when the browser UA is blocked", async () => {
		const agents: string[] = [];
		const page = await withServer(
			(req, res) => {
				agents.push(String(req.headers["user-agent"]));
				if (/Chrome/.test(String(req.headers["user-agent"]))) {
					res.writeHead(403, { "content-type": "text/html" });
					res.end("<p>bot wall</p>");
					return;
				}
				text(200, "text/plain", "let in")(req, res);
			},
			(base) => fetchPage(`http://${base}/`),
		);

		assert.equal(page.body, "let in");
		assert.equal(agents.length, 2);
		assert.match(agents[1] as string, /^pi-web-fetch\/1\.0 \(\+https:\/\/pi\.dev\)$/);
	});

	it("reports the retry's failure when both attempts are blocked", async () => {
		let requests = 0;
		const error = await withServer(
			(req, res) => {
				requests++;
				res.writeHead(429, { "content-type": "text/plain" });
				res.end("rate limited, come back later");
			},
			(base) => rejection(fetchPage(`http://${base}/`)),
		);

		assert.equal(requests, 2);
		assert.match(error.message, /HTTP 429/);
		assert.match(error.message, /rate limited, come back later/);
	});

	it("does not retry statuses that are a real answer", async () => {
		let requests = 0;
		await withServer(
			(req, res) => {
				requests++;
				res.writeHead(404, { "content-type": "text/plain" });
				res.end("nope");
			},
			(base) => rejection(fetchPage(`http://${base}/`)),
		);

		assert.equal(requests, 1);
	});
});

describe("error quality", () => {
	it("surfaces the underlying network error code and the URL", async () => {
		const port = await closedPort();
		const error = await rejection(fetchPage(`127.0.0.1:${port}/page`));

		assert.ok(error instanceof WebFetchError);
		assert.match(error.message, /ECONNREFUSED/);
		assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
	});

	it("maps cancellation during the body read", async () => {
		const started = deferred();
		const error = await withServer(stall(started), async (base) => {
			const controller = new AbortController();
			const pending = rejection(fetchPage(`http://${base}/slow`, controller.signal));
			await started.promise;
			await delay(50);
			controller.abort();
			return pending;
		});

		assert.ok(error instanceof WebFetchError);
		assert.match(error.message, /^Cancelled: http:\/\/127\.0\.0\.1:\d+\/slow$/);
	});

	it("maps a timeout during the body read", async () => {
		const started = deferred();
		const error = await withServer(stall(started), async (base) => {
			const pending = rejection(fetchPage(`http://${base}/slow`, undefined, { timeoutMs: 150 }));
			await started.promise;
			return pending;
		});

		assert.ok(error instanceof WebFetchError);
		assert.match(error.message, /^Timed out after 0\.15s: http:\/\/127\.0\.0\.1:\d+\/slow$/);
	});

	it("strips scripts, styles, and tags out of a 4xx body", async () => {
		const page =
			"<html><head><style>.x{color:red}</style><script>var secret=1</script></head>" +
			"<body><h1>Gone</h1>\n\n<p>The page   moved permanently away.</p></body></html>";
		const error = await withServer(text(410, "text/html", page), (base) => rejection(fetchPage(`http://${base}/`)));

		assert.match(error.message, /HTTP 410 Gone for http:/);
		assert.match(error.message, /Gone The page moved permanently away\./);
		assert.ok(!error.message.includes("secret"), error.message);
		assert.ok(!error.message.includes("color:red"), error.message);
	});

	it("caps the error detail at 300 characters", async () => {
		const error = await withServer(text(500, "text/plain", "x".repeat(5000)), (base) =>
			rejection(fetchPage(`http://${base}/`)),
		);

		assert.equal(/x+/.exec(error.message)?.[0].length, 300);
	});

	it("truncates echoed URLs at 200 characters", async () => {
		const path = `/${"p".repeat(400)}`;
		const error = await withServer(text(404, "text/plain", "missing"), (base) =>
			rejection(fetchPage(`http://${base}${path}`)),
		);

		assert.ok(!error.message.includes(path), "full URL leaked into the message");
		assert.match(error.message, /p{100}…/);
	});

	it("flags a body cut at the byte ceiling", async () => {
		const megabyte = Buffer.alloc(1024 * 1024, 0x61);
		const page = await withServer(
			(_req, res) => {
				res.writeHead(200, { "content-type": "text/plain" });
				let sent = 0;
				const pump = () => {
					while (sent < 11) {
						sent++;
						if (!res.write(megabyte)) {
							res.once("drain", pump);
							return;
						}
					}
					res.end();
				};
				pump();
			},
			(base) => fetchPage(`http://${base}/big.txt`),
		);

		assert.equal(page.bytes, 10 * 1024 * 1024);
		assert.equal(page.body.length, 10 * 1024 * 1024);
		assert.equal(page.truncatedAtBytes, true);
	});

	it("does not flag a body that fits", async () => {
		const page = await withServer(text(200, "text/plain", "small"), (base) => fetchPage(`http://${base}/`));
		assert.equal(page.truncatedAtBytes, false);
	});

	it("rejects a 204 and an empty 200 alike", async () => {
		const noContent = await withServer(
			(_req, res) => {
				res.writeHead(204);
				res.end();
			},
			(base) => rejection(fetchPage(`http://${base}/`)),
		);
		assert.match(noContent.message, /^Empty response \(204\/no body\): http:/);

		const empty = await withServer(text(200, "text/html", ""), (base) => rejection(fetchPage(`http://${base}/`)));
		assert.match(empty.message, /^Empty response \(204\/no body\): http:/);
	});

	it("names the protocol for schemes it cannot fetch", async () => {
		for (const url of ["javascript:alert(1)", "data:text/html,<p>hi</p>", "file:///etc/passwd", "mailto:a@b.c"]) {
			const error = await rejection(fetchPage(url));
			assert.ok(error instanceof WebFetchError);
			assert.match(error.message, /Unsupported protocol/, url);
			assert.ok(!/Not a valid URL/.test(error.message), url);
		}
	});
});

describe("content-type gate", () => {
	it("refuses declared binary families before downloading", async () => {
		let bodyRequests = 0;
		const error = await withServer(
			(_req, res) => {
				bodyRequests++;
				res.writeHead(200, { "content-type": "image/png", "content-length": "4096" });
				res.end(Buffer.alloc(4096));
			},
			(base) => rejection(fetchPage(`http://${base}/logo.png`)),
		);

		assert.equal(bodyRequests, 1);
		assert.match(error.message, /Refusing binary content \(image\/png, 4096 bytes\)/);
	});

	it("refuses octet-stream only when the path looks binary", async () => {
		const payload = "id,name\n1,ada\n";
		const error = await withServer(text(200, "application/octet-stream", payload), (base) =>
			rejection(fetchPage(`http://${base}/archive.zip`)),
		);
		assert.match(error.message, /Refusing binary content \(application\/octet-stream/);

		const page = await withServer(text(200, "application/octet-stream", payload), (base) =>
			fetchPage(`http://${base}/data.csv`),
		);
		assert.equal(page.body, payload);
	});

	it("accepts text-ish types without sniffing", async () => {
		for (const type of ["text/x-rst", "application/json", "application/atom+xml", "application/toml"]) {
			const page = await withServer(text(200, type, "value = 1\n"), (base) => fetchPage(`http://${base}/`));
			assert.equal(page.contentType, type);
			assert.equal(page.body, "value = 1\n");
		}
	});

	it("sniffs undeclared bodies and refuses the binary ones", async () => {
		const binary = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
		const error = await withServer(
			(_req, res) => {
				res.writeHead(200, { "content-type": "application/x-unknown" });
				res.end(binary);
			},
			(base) => rejection(fetchPage(`http://${base}/thing`)),
		);
		assert.match(error.message, /Refusing binary content \(application\/x-unknown/);
		assert.match(error.message, /the body is not text/);

		const page = await withServer(text(200, "application/x-unknown", "plain enough\n"), (base) =>
			fetchPage(`http://${base}/thing`),
		);
		assert.equal(page.body, "plain enough\n");
	});

	it("refuses a NUL-bearing body even when most of it is printable", async () => {
		const sneaky = Buffer.concat([Buffer.from("mostly text but "), Buffer.from([0x00]), Buffer.from(" not")]);
		const error = await withServer(
			(_req, res) => {
				res.writeHead(200, { "content-type": "application/x-unknown" });
				res.end(sneaky);
			},
			(base) => rejection(fetchPage(`http://${base}/thing`)),
		);
		assert.match(error.message, /Refusing binary content/);
	});

	it("refuses PDFs unless the caller opts in, and then returns bytes", async () => {
		const pdf = Buffer.from("%PDF-1.4\n%âãÏÓ\n1 0 obj\n");
		const serve: Handler = (_req, res) => {
			res.writeHead(200, { "content-type": "application/pdf", "content-length": String(pdf.length) });
			res.end(pdf);
		};

		const error = await withServer(serve, (base) => rejection(fetchPage(`http://${base}/paper.pdf`)));
		assert.match(error.message, /Refusing binary content \(application\/pdf, \d+ bytes\)/);

		const page = await withServer(serve, (base) => fetchPage(`http://${base}/paper.pdf`, undefined, { allowPdf: true }));
		assert.equal(page.body, "");
		assert.equal(page.contentType, "application/pdf");
		assert.deepEqual(Buffer.from(page.bytesBody as Uint8Array), pdf);
		assert.equal(page.bytes, pdf.length);
	});

	it("leaves bytesBody unset for ordinary pages", async () => {
		const page = await withServer(text(200, "text/plain", "hello"), (base) => fetchPage(`http://${base}/`));
		assert.equal(page.bytesBody, undefined);
	});
});

describe("URL normalization", () => {
	it("uses http for loopback and explicit-port hosts", async () => {
		const page = await withServer(text(200, "text/plain", "local"), (base) => fetchPage(`${base}/page`));
		assert.match(page.url, /^http:\/\/127\.0\.0\.1:\d+\/page$/);
		assert.equal(page.body, "local");
	});
});

describe("tracking parameters", () => {
	function htmlPage(body: string): FetchedPage {
		return {
			url: "https://example.test/",
			status: 200,
			contentType: "text/html",
			charset: "utf-8",
			body,
			bytes: body.length,
			truncatedAtBytes: false,
		};
	}

	it("strips analytics parameters but keeps meaningful ones", () => {
		const link = "https://example.com/a?utm_source=x&fbclid=y&ref_src=z&ref=keep&source=keep&si=keep&id=7";
		const { markdown } = extract(htmlPage(`<html><body><p><a href="${link}">link</a></p></body></html>`), true);

		assert.ok(!markdown.includes("utm_source"), markdown);
		assert.ok(!markdown.includes("fbclid"), markdown);
		assert.ok(!markdown.includes("ref_src"), markdown);
		assert.match(markdown, /ref=keep/);
		assert.match(markdown, /source=keep/);
		assert.match(markdown, /si=keep/);
		assert.match(markdown, /id=7/);
	});
});
