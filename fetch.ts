/**
 * HTTP layer for web_fetch.
 *
 * Responsibilities: sane defaults that make real-world sites work (browser UA),
 * hard bounds on time and size, and wiring pi's cancellation signal through to
 * the socket so Esc actually aborts an in-flight request.
 */

/** Many sites 403 a bare Node fetch. Present as a normal browser. */
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Stop reading a response body past this. Guards against multi-GB downloads. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface FetchedPage {
	/** URL after redirects — used as the base for resolving relative links. */
	url: string;
	status: number;
	/** Lowercased content type, parameters stripped. Empty string if absent. */
	contentType: string;
	/** Charset from the Content-Type header, if the server declared one. */
	charset: string | undefined;
	body: string;
	bytes: number;
}

export class WebFetchError extends Error {}

function parseContentType(header: string | null): { type: string; charset: string | undefined } {
	if (!header) return { type: "", charset: undefined };
	const [rawType, ...params] = header.split(";");
	let charset: string | undefined;
	for (const param of params) {
		const [key, value] = param.split("=");
		if (key?.trim().toLowerCase() === "charset") {
			charset = value?.trim().replace(/^["']|["']$/g, "").toLowerCase();
		}
	}
	return { type: rawType.trim().toLowerCase(), charset };
}

function normalizeUrl(input: string): string {
	// Some models pass an @-prefixed path out of habit; built-in tools strip it too.
	const trimmed = input.trim().replace(/^@/, "");
	if (!trimmed) throw new WebFetchError("No URL provided");

	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		throw new WebFetchError(`Not a valid URL: ${input}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new WebFetchError(`Unsupported protocol "${parsed.protocol}" — only http and https are supported`);
	}
	return parsed.toString();
}

/**
 * Read the body with a hard byte ceiling, decoding with the server's charset
 * when it declared one. Returns early (and reports fewer bytes) on oversize
 * responses rather than buffering the whole thing.
 */
async function readBoundedBody(response: Response, charset: string | undefined): Promise<{ body: string; bytes: number }> {
	if (!response.body) return { body: "", bytes: 0 };

	const chunks: Uint8Array[] = [];
	let bytes = 0;

	const reader = response.body.getReader();
	try {
		while (bytes < MAX_BODY_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			chunks.push(value);
			bytes += value.byteLength;
		}
	} finally {
		// Releasing the lock and cancelling stops the transfer for oversize bodies.
		reader.cancel().catch(() => {});
	}

	const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));

	// Fall back to utf-8 for charsets Node's decoder does not know.
	let decoded: string;
	try {
		decoded = new TextDecoder(charset || "utf-8").decode(buffer);
	} catch {
		decoded = buffer.toString("utf-8");
	}

	return { body: decoded, bytes };
}

export async function fetchPage(rawUrl: string, signal?: AbortSignal): Promise<FetchedPage> {
	const url = normalizeUrl(rawUrl);

	// Combine pi's cancellation with our own timeout so either can abort.
	const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

	let response: Response;
	try {
		response = await fetch(url, {
			redirect: "follow",
			signal: combined,
			headers: {
				"user-agent": USER_AGENT,
				accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
				"accept-language": "en-US,en;q=0.9",
			},
		});
	} catch (error) {
		if (signal?.aborted) throw new WebFetchError("Cancelled");
		if (timeout.aborted) throw new WebFetchError(`Timed out after ${DEFAULT_TIMEOUT_MS / 1000}s: ${url}`);
		const reason = error instanceof Error ? error.message : String(error);
		throw new WebFetchError(`Could not reach ${url}: ${reason}`);
	}

	const { type, charset } = parseContentType(response.headers.get("content-type"));

	if (!response.ok) {
		// Give the model the server's own explanation — error pages often say why.
		const { body } = await readBoundedBody(response, charset).catch(() => ({ body: "", bytes: 0 }));
		const detail = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
		throw new WebFetchError(
			`HTTP ${response.status} ${response.statusText} for ${url}${detail ? ` — ${detail}` : ""}`,
		);
	}

	const { body, bytes } = await readBoundedBody(response, charset);

	return {
		url: response.url || url,
		status: response.status,
		contentType: type,
		charset,
		body,
		bytes,
	};
}
