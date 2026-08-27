/**
 * HTTP layer for web_fetch.
 *
 * Responsibilities: sane defaults that make real-world sites work (browser UA,
 * content negotiation that prefers markdown), hard bounds on time and size, a
 * content-type gate so binaries are never downloaded into the context window,
 * and wiring pi's cancellation signal through to the socket so Esc actually
 * aborts an in-flight request.
 *
 * It also owns the *where*: `rewrite.ts` decides that a human-facing page has a
 * machine-readable twin, and this layer fetches it — falling back to the
 * original when the guess misses, so a rewrite can never lose a page.
 */

import { type Rewrite, rewriteUrl } from "./rewrite.ts";

/** Many sites 403 a bare Node fetch. Present as a normal browser. */
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Some sites block the browser UA for non-browser traffic (bot walls keyed on
 * the missing client hints) but serve an honest crawler fine. Used for one retry.
 */
const PLAIN_USER_AGENT = "pi-web-fetch/1.0 (+https://pi.dev)";

/**
 * Prefer markdown: a growing number of docs sites serve a hand-written markdown
 * variant of the page, which beats anything extraction can recover from HTML.
 */
const ACCEPT = "text/markdown, text/html;q=0.9, application/json;q=0.8, text/plain;q=0.7, */*;q=0.5";

const ACCEPT_LANGUAGE = "en-US,en;q=0.9";

/** Statuses that plausibly mean "we do not like your client", not "no". */
const RETRY_STATUSES = new Set([401, 403, 429, 503]);

const DEFAULT_TIMEOUT_MS = 30_000;

/** Stop reading a response body past this. Guards against multi-GB downloads. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Error pages only need enough body to explain themselves. */
const ERROR_BODY_BYTES = 64 * 1024;

/** URLs echoed into error messages are truncated to this, so a data-ish URL cannot flood the output. */
const MAX_URL_IN_MESSAGE = 200;

/** How much of an undeclared body to inspect before deciding it is binary. */
const SNIFF_BYTES = 1024;

/** Fraction of non-text bytes in the sniffed prefix above which a body is binary. */
const MAX_NON_TEXT_RATIO = 0.1;

/** Types that are always binary, whatever the URL looks like. */
const BINARY_TYPE_PATTERN = /^(image|video|audio|font)\//;
const BINARY_EXACT_TYPES = new Set(["application/zip", "application/gzip", "application/x-tar"]);

/** `application/octet-stream` is a shrug; trust the path extension instead. */
const BINARY_EXTENSION_PATTERN =
	/\.(zip|gz|tgz|tar|rar|7z|bz2|xz|exe|dmg|pkg|deb|rpm|iso|bin|so|dylib|dll|class|wasm|png|jpe?g|gif|webp|avif|bmp|ico|tiff?|mp[34]|m4a|wav|flac|ogg|opus|webm|mov|avi|mkv|woff2?|ttf|otf|eot|pdf|docx?|xlsx?|pptx?)$/i;

/** A path that names a PDF, for the servers that declare `application/octet-stream`. */
const PDF_EXTENSION_PATTERN = /\.pdf$/i;

/**
 * Types we are happy to decode as text even when the body looks unusual.
 *
 * The source-file types are named explicitly rather than left to the sniff:
 * a `.ts` file saying `a < p`, a JSX sample, an HTML heredoc in a shell script
 * are all text a server *declared*, and passing them through verbatim is the
 * whole point of accepting them.
 */
const TEXT_TYPE_PATTERN =
	/^text\/|\+xml$|\+json$|^application\/(json|x-ndjson|xml|xhtml\+xml|(x-)?javascript|ecmascript|(x-)?typescript|x-sh|(x-)?yaml|(x-)?toml)$/;

/** Enough of a body to tell markup from prose. */
const HTML_SNIFF_BYTES = 2000;

const HTML_SNIFF_PATTERN = /<\s*(!doctype\s+html|html|head|body|div|p)\b/i;

/**
 * Which extractor a fetched body belongs to.
 *
 * This is the *only* place that decision is made. It used to be made twice —
 * once here to decide what was worth downloading, once in `extract()` against a
 * narrower pattern — and the two disagreed: `application/octet-stream` with a
 * text body, `application/ecmascript` and `application/x-ndjson` were all
 * fetched, decoded, and then refused. Anything that survives the binary gate
 * below is text as far as this module is concerned, so `extract()` only has to
 * route on the answer it is given.
 */
export type PageKind = "html" | "json" | "pdf" | "text";

/**
 * The kind of a body the fetch layer accepted.
 *
 * Sniffing is limited to the two ways a server declares nothing at all: no
 * header, or the `application/octet-stream` shrug. Every other type is taken at
 * its word — `text/plain`, `application/typescript` and `application/x-ndjson`
 * bodies contain `<div` and `<p ` for reasons of their own, and running one of
 * those through Readability would return a fraction of the file.
 */
export function classifyPage(contentType: string, body: string): PageKind {
	if (contentType === "application/pdf") return "pdf";
	if (contentType === "text/html" || contentType === "application/xhtml+xml") return "html";
	if (contentType === "application/json" || contentType === "text/json" || contentType.endsWith("+json")) {
		return "json";
	}
	const undeclared = contentType === "" || contentType === "application/octet-stream";
	if (undeclared && HTML_SNIFF_PATTERN.test(body.slice(0, HTML_SNIFF_BYTES))) return "html";
	return "text";
}

/** Hosts that are almost never reachable over https, so `https://` would just fail. */
function isLocalHost(host: string): boolean {
	return (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "[::1]" ||
		host === "::1" ||
		host.endsWith(".local") ||
		host.endsWith(".localhost")
	);
}

export interface FetchedPage {
	/** URL after redirects — used as the base for resolving relative links. */
	url: string;
	/** What the caller asked for, normalized and before any rewrite. */
	requestedUrl: string;
	/** Set when the URL fetched was not the URL asked for, so the swap is never silent. */
	note?: string;
	status: number;
	/** Lowercased content type, parameters stripped. Empty string if absent. */
	contentType: string;
	/** Which extractor this body belongs to. Decided here and nowhere else. */
	kind: PageKind;
	/** Charset from the Content-Type header, if the server declared one. */
	charset: string | undefined;
	body: string;
	bytes: number;
	/** True when the body hit `MAX_BODY_BYTES` and the rest was dropped. */
	truncatedAtBytes: boolean;
	/** Undecoded body, set instead of `body` for formats that are not text (PDF). */
	bytesBody?: Uint8Array;
}

export interface FetchOptions {
	/** Accept `application/pdf` and return it undecoded in `bytesBody`. */
	allowPdf?: boolean;
	/** Deadline for the whole request including the body read. Defaults to 30s. */
	timeoutMs?: number;
	/**
	 * The rewrite table to consult. Defaults to the real one; a test injects its
	 * own so the fallback and answer-merging paths can run against a local server.
	 */
	rewrite?: (url: URL) => Rewrite | undefined;
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
	return { type: (rawType ?? "").trim().toLowerCase(), charset };
}

/** Keep error messages readable when the URL is pathological. */
function shortUrl(url: string): string {
	return url.length > MAX_URL_IN_MESSAGE ? `${url.slice(0, MAX_URL_IN_MESSAGE)}…` : url;
}

/**
 * `fetch` reports every transport problem as `TypeError: fetch failed`; the
 * actionable part (ENOTFOUND, ECONNREFUSED, CERT_HAS_EXPIRED) is buried in the
 * cause chain. Dig out the innermost coded error.
 */
function describeFailure(error: unknown): string {
	let current: unknown = error;
	let message = error instanceof Error ? error.message : String(error);
	let code: string | undefined;

	for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
		const candidate = (current as { code?: unknown }).code;
		if (typeof candidate === "string") {
			code = candidate;
			message = current.message;
		}
		const nested = (current as { cause?: unknown }).cause;
		const siblings = (current as { errors?: unknown }).errors;
		current = nested ?? (Array.isArray(siblings) ? siblings[0] : undefined);
	}

	return code ? `${code} (${message})` : message;
}

function normalizeUrl(input: string): string {
	// Some models pass an @-prefixed path out of habit; built-in tools strip it too.
	const trimmed = input.trim().replace(/^@/, "");
	if (!trimmed) throw new WebFetchError("No URL provided");

	// A leading `scheme:` not followed by a digit is a real scheme, not `host:port`.
	const scheme = /^([a-z][a-z0-9+.-]*):(?![0-9])/i.exec(trimmed)?.[1]?.toLowerCase();
	if (scheme && scheme !== "http" && scheme !== "https") {
		throw new WebFetchError(
			`Unsupported protocol "${scheme}:" in ${shortUrl(trimmed)} — only http and https are supported`,
		);
	}

	// Bare hosts default to https, except loopback/`.local`/explicit-port hosts,
	// which are development servers that almost never speak TLS.
	const withScheme = (() => {
		if (scheme) return trimmed;
		const authority = (trimmed.split(/[/?#]/)[0] ?? "").toLowerCase();
		const host = authority.replace(/:\d+$/, "");
		const hasPort = authority !== host;
		return `${hasPort || isLocalHost(host) ? "http" : "https"}://${trimmed}`;
	})();

	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		throw new WebFetchError(`Not a valid URL: ${shortUrl(input)}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new WebFetchError(
			`Unsupported protocol "${parsed.protocol}" in ${shortUrl(input)} — only http and https are supported`,
		);
	}
	return parsed.toString();
}

/**
 * Read the body with a hard byte ceiling. Stops (and cancels the transfer) once
 * the ceiling is reached rather than buffering the whole thing. Decoding is a
 * separate step so callers that want raw bytes can have them.
 */
async function readBoundedBody(response: Response, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!response.body) return { bytes: new Uint8Array(0), truncated: false };

	const chunks: Uint8Array[] = [];
	let total = 0;
	let complete = false;

	const reader = response.body.getReader();
	try {
		while (total < limit) {
			const { done, value } = await reader.read();
			if (done) {
				complete = true;
				break;
			}
			if (!value) continue;
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		// Cancelling stops the transfer for oversize bodies.
		reader.cancel().catch(() => {});
	}

	const size = Math.min(total, limit);
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= size) break;
		const slice = chunk.subarray(0, size - offset);
		bytes.set(slice, offset);
		offset += slice.length;
	}

	return { bytes, truncated: !complete };
}

/**
 * `<meta charset=x>` and `<meta http-equiv="Content-Type" content="...; charset=x">`.
 * One pattern covers both: the label is whatever follows the first `charset=` in
 * the tag, quoted or not.
 */
const META_CHARSET_PATTERN = /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([\w:.+-]+)/i;

/** How much of the body to search for a `<meta charset>`, per the HTML spec's own prescan. */
const CHARSET_SNIFF_BYTES = 2048;

/** The charset the document declares about itself, if any. */
function sniffCharset(buffer: Uint8Array): string | undefined {
	// latin1 because the prescan must not fail on bytes that are not yet known to
	// be valid in any encoding — every byte maps to a character, and the ASCII
	// markup we are looking for survives unchanged.
	const prefix = Buffer.from(
		buffer.buffer,
		buffer.byteOffset,
		Math.min(buffer.byteLength, CHARSET_SNIFF_BYTES),
	).toString("latin1");
	return META_CHARSET_PATTERN.exec(prefix)?.[1]?.toLowerCase();
}

/**
 * Decode a body as text.
 *
 * The `Content-Type` header wins when it declares a charset; otherwise the
 * document's own `<meta charset>` decides. Plenty of legacy pages — Shift_JIS
 * and GB2312 docs especially — declare their encoding only in the markup, and
 * decoding those as utf-8 turns the whole page into replacement characters.
 */
export function decodeBody(buffer: Uint8Array, headerCharset: string | undefined): string {
	const label = headerCharset || sniffCharset(buffer) || "utf-8";
	try {
		return new TextDecoder(label, { fatal: false }).decode(buffer);
	} catch {
		// A label Node does not know. utf-8 is the web's default and the best guess left.
		return new TextDecoder("utf-8").decode(buffer);
	}
}

/** Bytes that never appear in text: control characters other than the whitespace ones. */
function isNonTextByte(byte: number): boolean {
	return byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f;
}

/** Last-resort check for servers that declare nothing useful. */
function looksBinary(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, SNIFF_BYTES);
	if (sample.length === 0) return false;

	let nonText = 0;
	for (const byte of sample) {
		if (byte === 0) return true;
		if (isNonTextByte(byte)) nonText++;
	}
	return nonText / sample.length > MAX_NON_TEXT_RATIO;
}

type ContentKind = "text" | "pdf" | "binary" | "unknown";

function classifyContent(type: string, url: string, allowPdf: boolean): ContentKind {
	if (type === "application/pdf") return allowPdf ? "pdf" : "binary";
	if (BINARY_TYPE_PATTERN.test(type) || BINARY_EXACT_TYPES.has(type)) return "binary";
	if (type === "application/octet-stream") {
		const path = (() => {
			try {
				return new URL(url).pathname;
			} catch {
				return url;
			}
		})();
		// Servers that shrug about the type still name the file: a `.pdf` path is
		// as good a declaration as the header would have been.
		if (PDF_EXTENSION_PATTERN.test(path)) return allowPdf ? "pdf" : "binary";
		return BINARY_EXTENSION_PATTERN.test(path) ? "binary" : "unknown";
	}
	if (TEXT_TYPE_PATTERN.test(type)) return "text";
	return "unknown";
}

function binaryError(type: string, url: string, size: string | null, why: string): WebFetchError {
	const described = type || "unknown type";
	const bytes = size ? `, ${size} bytes` : "";
	return new WebFetchError(`Refusing binary content (${described}${bytes}) at ${shortUrl(url)} — ${why}`);
}

/** Turn an error page into one readable line: no scripts, no tags, no runs of whitespace. */
function summarizeErrorBody(body: string): string {
	return body
		.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 300);
}

/**
 * Where a request should actually go: the machine-readable twin when a rule
 * knows of one, the URL itself otherwise. Exported so the rewrite decision can
 * be tested without a round trip.
 */
export function resolveRequestUrl(
	normalized: string,
	rewrite: (url: URL) => Rewrite | undefined = rewriteUrl,
): { url: string; rewrite: Rewrite | undefined } {
	let applied: Rewrite | undefined;
	try {
		applied = rewrite(new URL(normalized));
	} catch {
		// A rule that throws must not cost us the page.
		applied = undefined;
	}
	return { url: (applied?.url ?? normalized).toString(), rewrite: applied };
}

/** The API document for a single question — the one rewrite that needs a second request. */
const QUESTION_PATH_PATTERN = /\/questions\/\d+$/;

/** Answers per question. The API allows 100; ten is what a reader will read. */
const MAX_ANSWERS = 10;

/**
 * Splice a question's answers into the question document.
 *
 * The questions endpoint returns the question alone, and the answers are the
 * reason anyone opened the page. They arrive as a second document, merged into
 * the first under `answers` so `extract` still sees a single JSON payload.
 * Every failure here is survivable: the question by itself is still the page.
 */
async function attachAnswers(
	questionUrl: URL,
	page: FetchedPage,
	get: (url: string) => Promise<Response>,
	signal: AbortSignal | undefined,
): Promise<void> {
	const site = questionUrl.searchParams.get("site");
	if (site === null) return;

	const url = new URL(questionUrl);
	url.pathname = `${url.pathname}/answers`;
	url.search = new URLSearchParams({
		site,
		filter: "withbody",
		order: "desc",
		sort: "votes",
		pagesize: String(MAX_ANSWERS),
	}).toString();

	try {
		const response = await get(url.toString());
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			return;
		}
		const { bytes } = await readBoundedBody(response, MAX_BODY_BYTES);
		const { charset } = parseContentType(response.headers.get("content-type"));
		const items: unknown = JSON.parse(decodeBody(bytes, charset)).items;
		const question: unknown = JSON.parse(page.body);
		if (!Array.isArray(items) || typeof question !== "object" || question === null) return;

		page.body = JSON.stringify({ ...question, answers: items });
		page.bytes = Buffer.byteLength(page.body);
	} catch {
		// Esc means stop, not "stop after one more document": a cancellation here
		// ends the whole fetch rather than being absorbed as a missing extra. It is
		// reported against the URL the caller asked for, as every other abort is.
		if (signal?.aborted) throw new WebFetchError(`Cancelled: ${shortUrl(page.requestedUrl)}`);
		// Rate limit, malformed JSON, dead connection — proceed with the question.
	}
}

export async function fetchPage(rawUrl: string, signal?: AbortSignal, options: FetchOptions = {}): Promise<FetchedPage> {
	const requestedUrl = normalizeUrl(rawUrl);
	const resolved = resolveRequestUrl(requestedUrl, options.rewrite);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// Combine pi's cancellation with our own timeout so either can abort.
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

	/** Map a transport/abort failure — from the request or from the body read — onto a readable error. */
	const fail = (error: unknown, phase: "reach" | "read", failed: string): WebFetchError => {
		const shown = shortUrl(failed);
		if (signal?.aborted) return new WebFetchError(`Cancelled: ${shown}`);
		if (timeout.aborted) return new WebFetchError(`Timed out after ${timeoutMs / 1000}s: ${shown}`);
		const reason = describeFailure(error);
		return new WebFetchError(
			phase === "reach" ? `Could not reach ${shown}: ${reason}` : `Connection failed while reading ${shown}: ${reason}`,
		);
	};

	const send = async (url: string, userAgent: string): Promise<Response> => {
		try {
			return await fetch(url, {
				redirect: "follow",
				signal: combined,
				headers: {
					// Deliberately no `sec-ch-ua` / `Sec-Fetch-*`: a browser UA arriving with a
					// partial client-hint set is exactly what bot walls score on. (Node's fetch
					// forces `sec-fetch-mode` and ignores any override, so that one is unavoidable.)
					"user-agent": userAgent,
					accept: ACCEPT,
					"accept-language": ACCEPT_LANGUAGE,
				},
			});
		} catch (error) {
			throw fail(error, "reach", url);
		}
	};

	/** One URL, including the bot-wall retry. */
	const attempt = async (target: string): Promise<Response> => {
		const first = await send(target, USER_AGENT);
		// Bot walls key on the browser UA arriving without client hints. An honest
		// crawler UA gets through often enough to be worth exactly one retry.
		if (!RETRY_STATUSES.has(first.status)) return first;
		await first.body?.cancel().catch(() => {});
		return await send(target, PLAIN_USER_AGENT);
	};

	let url = resolved.url;
	let note = resolved.rewrite?.note;
	let response = await attempt(url);

	// A rewrite is a guess about where the content lives: an API can rate-limit,
	// a raw-file address can be wrong. When the guess misses, the page the user
	// actually asked for is still there.
	const fallback = resolved.rewrite?.fallback;
	if (!response.ok && fallback) {
		await response.body?.cancel().catch(() => {});
		note = `${resolved.rewrite?.note} failed (${response.status}); fetched original`;
		url = fallback.toString();
		response = await attempt(url);
	}

	const shown = shortUrl(url);
	const { type, charset } = parseContentType(response.headers.get("content-type"));

	if (!response.ok) {
		// Give the model the server's own explanation — error pages often say why.
		const read = await readBoundedBody(response, ERROR_BODY_BYTES).catch(() => ({
			bytes: new Uint8Array(0),
			truncated: false,
		}));
		const detail = summarizeErrorBody(decodeBody(read.bytes, charset));
		throw new WebFetchError(
			`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""} for ${shown}` +
				(detail ? ` — ${detail}` : ""),
		);
	}

	const kind = classifyContent(type, response.url || url, options.allowPdf === true);
	if (kind === "binary") {
		// Refuse before downloading: the header is enough to know it is hopeless.
		await response.body?.cancel().catch(() => {});
		throw binaryError(type, url, response.headers.get("content-length"), "web_fetch returns text");
	}

	let read: { bytes: Uint8Array; truncated: boolean };
	try {
		read = await readBoundedBody(response, MAX_BODY_BYTES);
	} catch (error) {
		throw fail(error, "read", url);
	}

	if (response.status === 204 || read.bytes.length === 0) {
		throw new WebFetchError(`Empty response (204/no body): ${shown}`);
	}

	// Nothing declared this as text, so make sure it reads as text before decoding it.
	if (kind === "unknown" && looksBinary(read.bytes)) {
		throw binaryError(type, url, response.headers.get("content-length"), "the body is not text");
	}

	const body = kind === "pdf" ? "" : decodeBody(read.bytes, charset);
	const page: FetchedPage = {
		url: response.url || url,
		requestedUrl,
		status: response.status,
		contentType: type,
		// A `.pdf` behind `application/octet-stream` is still a PDF, so the gate's
		// verdict wins over the header here.
		kind: kind === "pdf" ? "pdf" : classifyPage(type, body),
		charset,
		body,
		bytes: read.bytes.length,
		truncatedAtBytes: read.truncated,
	};
	if (note !== undefined) page.note = note;
	if (kind === "pdf") page.bytesBody = read.bytes;

	// A StackExchange question document is only half the page; the answers are a
	// second request. Skipped when the rewrite was abandoned for its fallback.
	const rewritten = resolved.rewrite !== undefined && url === resolved.url ? new URL(url) : undefined;
	if (rewritten && type.includes("json") && QUESTION_PATH_PATTERN.test(rewritten.pathname)) {
		await attachAnswers(rewritten, page, (target) => send(target, USER_AGENT), signal);
	}
	return page;
}
