# Task 4 report — HTTP robustness (fetch.ts)

Branch `task4-fetch`, commit `a3bd3b5` — *fix(fetch): markdown content negotiation, UA retry, precise errors, binary gate, localhost http*

## Files changed

- `fetch.ts` — the bulk of the work (rewritten request path, gate, error mapping).
- `extract.ts` — two constants only, as instructed (`TEXT_TYPE_PATTERN`, `TRACKING_PARAM_PATTERN`).
- `tests/fetch.test.ts` — new, 24 tests, `node:http` on `127.0.0.1:0`, no network.
- `tests/helpers.ts` — one line: `truncatedAtBytes: false` in the fixture `FetchedPage`.
- `index.ts` — untouched.

## Item by item

**1. Request headers.** `ACCEPT = "text/markdown, text/html;q=0.9, application/json;q=0.8, text/plain;q=0.7, */*;q=0.5"`,
`accept-language: en-US,en;q=0.9`, Chrome UA kept. No `sec-ch-ua` / `Sec-Fetch-*` are added.
*Caveat:* Node's `fetch` (undici) forces `sec-fetch-mode: cors` and silently ignores any override — verified
empirically (setting the header, and `mode: "navigate"`, which the Request constructor rejects). The only way to
drop it is abandoning `fetch` for `node:http`, which is out of scope; the code and the test both say so.
`text/markdown` passes through as `mode: "text"` (verified end-to-end through `extract`).

**2. UA retry.** `RETRY_STATUSES = {401, 403, 429, 503}` → cancel the first body, resend once with
`pi-web-fetch/1.0 (+https://pi.dev)`. The retry's response is the one that produces the error if it also fails.
The shared timeout signal covers both attempts (one 30s budget, not two).

**3. Error quality.**
- (a) `describeFailure` walks the `cause` chain (and `AggregateError.errors[0]`) up to 5 levels for the innermost
  coded error → `Could not reach <url>: ECONNREFUSED (connect ECONNREFUSED 127.0.0.1:PORT)`.
- (b) The body read is wrapped in the same mapping as the request: `Cancelled: <url>` / `Timed out after 30s: <url>`
  (`Cancelled` now carries the URL, which it did not before). Non-abort read failures get
  `Connection failed while reading <url>: <code> (<message>)`.
- (c) Non-2xx: `HTTP <status> <statusText> for <url> — <detail>`, detail = body with `<script>`/`<style>` blocks
  removed, tags stripped, whitespace collapsed, first 300 chars.
- (d) Every echoed URL goes through `shortUrl()` (200 chars + `…`).
- (e) `FetchedPage.truncatedAtBytes: boolean`, set from `readBoundedBody`.
- (f) `status === 204 || bytes === 0` → `Empty response (204/no body): <url>`.
- (g) `normalizeUrl` recognises a leading `scheme:` not followed by a digit (so `localhost:8080` is still host:port)
  and reports `Unsupported protocol "javascript:" in …` rather than "Not a valid URL".

**4. Content-type gate.** `classifyContent()` runs before the body is read:
`image|video|audio|font/*`, `application/zip|gzip|x-tar` → binary; `application/pdf` → binary unless
`allowPdf`, in which case the body is returned as `bytesBody: Uint8Array` with `body: ""`;
`application/octet-stream` → binary only when the (post-redirect) URL path has a binary extension, otherwise
unknown; `text/*`, `*+xml`, `*+json`, `application/json|xml|xhtml+xml|javascript|ecmascript|x-yaml|yaml|toml`
→ text. Binary refusals cancel the body first and report type + `Content-Length`. Unknown types are read, then
sniffed over the first 1 KB: any NUL, or >10% control bytes (excluding tab/LF/CR/FF), is binary. Bytes ≥ 0x80
count as text so UTF-8 pages are not misjudged.
New signature: `fetchPage(url, signal?, options?: { allowPdf?: boolean; timeoutMs?: number })`.

**5. URL normalization.** Scheme-less input gets `http://` when the authority has an explicit port or the host is
`localhost` / `127.0.0.1` / `[::1]` / `::1` / `*.local` / `*.localhost`; `https://` otherwise.
`TRACKING_PARAM_PATTERN` is now `/^(utm_[a-z_]+|fbclid|gclid|mc_[a-z]+|ref_src|_hs[a-z]+|igshid)$/i` —
`ref`, `source`, `si` are kept.

**6. Minor.** `readBoundedBody` returns `{ bytes: Uint8Array; truncated: boolean }` and concatenates chunks into a
single pre-sized `Uint8Array` (no Buffer round-trip, no double copy); decoding is a separate `decodeCharset()`
step, so a later `decodeBody(buffer, headerCharset)` slots straight in. Error paths read at most 64 KB
(`ERROR_BODY_BYTES`).

`extract.ts` `TEXT_TYPE_PATTERN` widened to `^text\/` (universal `text/*`), matching the gate; the
`application/...` and `+xml` alternatives are unchanged.

## Verification

- `npm run typecheck` — clean.
- `npx tsx --test tests/fetch.test.ts` — 24/24 pass (~0.6s).
- `npm test` — 67 tests, 41 pass, 26 fail. Baseline (`git archive 2e62505` into a scratch dir, same
  `node_modules`) is 43 tests, 17 pass, 26 fail. The sorted list of failing test names is byte-identical before
  and after, i.e. the 26 red fidelity/charset tests are exactly the pre-existing ones and nothing regressed.

Test coverage: headers sent + no client hints, markdown passthrough, 403→plain-UA retry, retry-also-fails,
no-retry on 404, ECONNREFUSED with code + URL, cancel during body read, timeout during body read, 4xx
script/style/tag stripping, 300-char detail cap, 200-char URL truncation, real 10 MB cut with
`truncatedAtBytes`, no false truncation flag, 204 and empty 200, four unsupported protocols, image/png refusal
with Content-Length, octet-stream by path extension (both ways), four text-ish types accepted, sniffed binary
refusal + NUL-only case, PDF refused/allowed with `bytesBody`, `bytesBody` unset otherwise, bare
`127.0.0.1:port` → http, tracking params kept/stripped.

## Self-review notes

- **Servers/readers**: `withServer` destroys open responses, calls `closeAllConnections()` and awaits `close()`;
  `readBoundedBody` cancels the reader in a `finally`; refused-binary and retried responses have their bodies
  cancelled explicitly. No leaked handles — the test process exits on its own.
- **`timeoutMs` option**: added so the timeout branch is testable in 150 ms rather than 30 s. It is one field on
  an options object that had to exist anyway for `allowPdf`; the default keeps the brief's exact
  `Timed out after 30s: <url>` message. Flagging it as the one thing I added beyond the literal brief.
- **Known imprecision**: a body whose length is exactly `MAX_BODY_BYTES` is reported as `truncatedAtBytes: true`,
  because we stop at the ceiling without seeing the stream's `done`. Detecting it would cost an extra read of a
  chunk we would then have to drop; not worth it.
- **Not covered by a test**: "bare host → https" (the complement of the localhost rule). Any test of it would
  need a DNS lookup, and the suite is required to be network-free. The rule is a two-line branch reviewed by
  hand and exercised for the `http` side.
- `truncatedAtBytes` is a required field, so `tests/helpers.ts` needed one added line. If the concurrent
  `extract.ts` work also touches `helpers.ts`, that is the only overlap and it is a single-line addition.

## Concerns / handoff

- `sec-fetch-mode: cors` is unavoidable with Node's `fetch` (see item 1). If a bot wall is later traced to it,
  the fix is a `node:http`-based client, not a header tweak.
- Task 5 (PDF): `bytesBody` is capped by `MAX_BODY_BYTES` like everything else, so a >10 MB PDF arrives
  truncated with `truncatedAtBytes: true` — it should check that flag before parsing.
- Task 6 (index.ts) needs to render `truncatedAtBytes`; nothing in `index.ts` was changed here, and its
  `fetchPage(url, signal)` call still typechecks.
- `decodeBody` was deliberately **not** added (later task); the local `decodeCharset(bytes, charset)` is the seam
  it replaces. `tests/charset.test.ts` therefore still fails at import, as before.
