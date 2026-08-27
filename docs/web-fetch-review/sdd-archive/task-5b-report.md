# Task 5b report — wire rewrite / renderers / pdf into the pipeline

Commit: `af18a1e feat: wire URL rewrites, JSON renderers and PDF text into the pipeline` (branch `fidelity`, on top of `efa018f`).

## What was implemented, per brief section

### 1. fetch.ts — rewrite + fallback
- `FetchedPage` gained `requestedUrl: string` (normalized, pre-rewrite) and `note?: string`.
- `FetchOptions` gained `rewrite?: (url: URL) => Rewrite | undefined` — the test seam, defaulting to the real `rewriteUrl`.
- New exported `resolveRequestUrl(normalized, rewrite = rewriteUrl): { url: string; rewrite: Rewrite | undefined }`. A rule that throws is swallowed (never costs the page).
- `fetchPage` restructured: `send(url, userAgent)` now takes the URL, `attempt(target)` wraps send + the existing 401/403/429/503 UA retry, and `fail(error, phase, failedUrl)` takes the URL it is describing. Behaviour of the retry, the timeout/cancel mapping, the byte ceiling, the binary gate and tracking-param handling is unchanged.
- Flow: fetch `resolved.url`; if the response is non-2xx (after the UA retry) *and* the rewrite declared a `fallback`, cancel that body and fetch the fallback instead, setting `note` to `"<note> failed (<status>); fetched original"`. On success `note` is just the rewrite's own note.
- StackExchange: after a 2xx JSON response whose (rewritten, non-fallback) URL path matches `/questions/\d+$`, `attachAnswers()` issues exactly one extra request to `{questionUrl}/answers?site=…&filter=withbody&order=desc&sort=votes&pagesize=10` (site taken from the question URL's own query, so an injected local rewrite works the same way), parses both documents and re-serialises the question with `answers` = the answers response's `items` into `page.body` (and updates `page.bytes`). Every failure — non-2xx, malformed JSON, dead connection — is swallowed and the question is returned alone. Helper is ~40 lines including its comment.

### 2. extract.ts — renderers + PDF routing
- The seven universal DOM passes were factored into `cleanDocument(document, baseUrl)`; `extractHtml` calls it, and so does the new `fragmentToMarkdown(html, baseUrl)` (parse fragment with linkedom → same cleanup → Turndown). No pass moved or changed order.
- JSON branch: before pretty-printing, `renderKnownJson(new URL(page.url), parsed, html => fragmentToMarkdown(html, page.url))`; when it returns a string it is used with `mode: "json"` and `title` = the first `# ` line (`leadHeading`). An unparseable `page.url` skips rendering instead of throwing.
- PDF: `extract` now checks `page.bytesBody !== undefined || contentType === "application/pdf"` first and calls `extractPdf`, which does `await import("./pdf.ts")` — the 2 MB `unpdf` is loaded only on that branch. Returns `{ mode: "pdf", markdown: text, title, keptRatio: 1 }`, prefixed with `pages: N (showing first M)\n\n` only when `truncatedPages` (M is derived by counting `<!-- page n -->` markers, so pdf.ts's page cap stays private). `pdfToText` failures and a PDF response with no bytes are re-thrown as `WebFetchError`.
- `mode` union gained `"pdf"`; `extract` is now `async`.

### 3. index.ts — minimal wiring
- `fetchPage(params.url, signal, { allowPdf: true })`, `await extract(...)`.
- `buildHeader` takes `note?` and appends one `note: <note>` line directly after `source:`. Header otherwise untouched (Task 6 owns it).
- Tool description now says "Handles HTML, JSON, PDF, and plain text."; the same sentence in extract.ts's unsupported-type error was updated to match.

### 4. Tests
- `tests/fetch.test.ts`: `resolveRequestUrl` unit tests (github blob → raw with the original as fallback; ordinary URL untouched); rewrite applied end-to-end against the local server (only `/rewritten` is requested, `note` and `requestedUrl` set); fallback path end-to-end (`/rewritten` 404 → `/original` 200, note reads `test → rewritten failed (404); fetched original`); a rewrite with no fallback still surfaces its own 404. StackExchange suite: the exact two request URLs (including the full answers query string) are asserted, the merged document keeps both the question and the answers, `page.bytes` follows the merged body, the merged JSON reaches `extract` as one document, a failing answers request leaves the question alone, and a fallback-taken rewrite asks for no answers at all.
- `tests/extract-unit.test.ts`: npm-packument-shaped JSON from `registry.npmjs.org` renders (title `turndown 7.2.0`, version list, README prose, and no `{` or `"dist-tags"` anywhere); an `api.stackexchange.com` payload's HTML bodies go through the page pipeline (answer heading, ```` ```js ```` fence, no markdown escaping in the code); unknown JSON still pretty-prints exactly; PDF bytes through `extract` give `mode: "pdf"`, the metadata title, both pages and the page marker, plus the no-text-layer and no-bytes error paths.
- `makePdf` moved from `tests/pdf.test.ts` to `tests/helpers.ts` (exported); `pdf.test.ts` imports it.
- Mechanical async conversion: `extract` call sites in `tests/extract-unit.test.ts`, `tests/fidelity.test.ts`, `tests/fetch.test.ts`, `test.ts` and `index.ts`; `describe`/`it` callbacks in the two affected suites are now `async` (node:test awaits an async suite body before running its tests — verified). `requestedUrl` added to the three hand-built `FetchedPage` literals.

### 5. test.ts (live, opt-in)
Added `https://github.com/mozilla/readability/blob/main/README.md`, `https://www.npmjs.com/package/turndown`, `https://arxiv.org/pdf/1706.03762` to the URL list, and the runner now passes `{ allowPdf: true }`. Also corrected one stale error-case expectation (`Cannot extract text` → `Refusing binary content`): the binary gate has refused before download since an earlier task, so that case was failing before this work.

## Tests

`npm test` (node:test via tsx): **163 pass / 0 fail before → 182 pass / 0 fail after** (19 new tests, 0 removed). `npm run typecheck` clean.

Live `npx tsx test.ts` (network available, run once manually):

```
ok  article extraction (Wikipedia)          960929B → 193932B (article)
ok  blog post with code blocks (nodejs.org) 519295B →  72590B (article)
ok  repo page (GitHub)                      320872B →   4817B (article)
ok  listing page (Hacker News, raw)          34748B →  14494B (full-page)
ok  JSON API (api.github.com)                 6618B →   6605B (json)
ok  github blob → raw file (rewrite)          7376B →   7375B (text)
ok  npm package → registry (rewrite+render)  84019B →   9853B (json)
ok  PDF text (arXiv 1706.03762)            2215244B →  39933B (pdf)
ok  plain text (RFC 7231)                   235053B → 235044B (text)
--- error cases: 5/5 ok (404, unresolvable host, bad protocol, not a URL, binary) ---
All cases passed.
```

Additional one-off live check of the paths test.ts does not cover:
- `stackoverflow.com/questions/11227809/...` → `api.stackexchange.com/2.3/questions/11227809?site=stackoverflow&filter=withbody`, note `stackoverflow → StackExchange API`, 52 KB JSON → 40 KB markdown, **10 answers rendered**, title from the question.
- `en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)` → Parsoid HTML, note set, `mode: article`.
- `pypi.org/project/requests/` → `pypi.org/pypi/requests/json`, 193 KB → 3.2 KB, `mode: json`, title `requests 2.34.2`.

## Files changed

`fetch.ts`, `extract.ts`, `index.ts`, `test.ts`, `README.md`, `tests/fetch.test.ts`, `tests/extract-unit.test.ts`, `tests/fidelity.test.ts`, `tests/helpers.ts`, `tests/pdf.test.ts` (+743 / −197). No new dependencies; no `node_modules` or `.superpowers` committed.

README: the content-type table listed JSON as pretty-printed only and the "Not included, on purpose" section still named PDF — both were false after this change. Corrected, plus a six-line "URL rewrites" section. Flagged here because the brief did not ask for it.

## Self-review

- **Completeness**: all five sections implemented as specified, with the brief's verbatim values (answers query string, `pages: N (showing first M)`, note wording, commit message).
- **No signature drift**: `rewrite.ts`, `renderers.ts`, `pdf.ts` are byte-identical to HEAD~1 (`git diff` touches none of them).
- **SO helper size**: `attachAnswers` is 40 lines including its doc comment; the fetchPage-side wiring is 4 lines.
- **Fallback really fetches the original**: asserted end-to-end by request path (`["/rewritten", "/original"]`) and by body, not by mock.
- **PDF path lazy**: `await import("./pdf.ts")` inside `extractPdf`; nothing at module scope imports `unpdf`.
- **Tests assert real behaviour**: local `node:http` server, real request paths and query strings, real merged JSON, real PDF bytes through `pdfToText`. No monkeypatching; the only injection is the documented `opts.rewrite` seam.

## Concerns

- The `opts.rewrite` seam is production API surface that exists mainly for tests. It is small and typed, but it is a seam.
- `attachAnswers` mutates the `FetchedPage` it is given (body + bytes) rather than returning a new one; documented, but it is the one mutation in the fetch layer.
- The answers request does not get the plain-UA retry, so a 429 from the API silently costs the answers (the question still comes back). Deliberate: one extra request, not two.
- `fragmentToMarkdown` builds a fresh Turndown per fragment, i.e. up to 11 per StackExchange page. Cheap in practice; hoisting it would mean threading a per-page instance through the renderer callback.
- The rewrite `note` is currently rendered as a header line by index.ts. Task 6 redesigns that header and should decide where it really belongs.

---

## Fix round 1 (review: "Needs fixes")

Commit: `8fcc4b2 fix: report a PDF cut at the byte ceiling, guard the renderer, propagate cancellation`.

### Important — `extractPdf` ignored `page.truncatedAtBytes`
`extract.ts`. A PDF cut off by the fetch layer's 10 MB ceiling is now named as such, because PDF.js reads the cross-reference table at the *end* of the file:
- **Parse succeeds**: `warning: PDF download cut at 10 MB — text below is partial` is prepended. The two notices compose — a document that was both cut and over the 200-page cap gets the warning line and the `pages: N (showing first M)` line, in that order, then a blank line, then the text.
- **Parse fails**: `WebFetchError("PDF download cut at 10 MB and could not be parsed: <url>")`, instead of the generic "Could not read the PDF" that misdiagnosed a size problem as a corrupt file. When nothing was cut, the generic message is unchanged.

Tests (`tests/extract-unit.test.ts`, suite "a PDF cut off at the byte ceiling says so"): the warning line is asserted as the literal first line of the output with the text still present; the failure path feeds the first half of a real `makePdf` document (which genuinely fails to parse — verified, not assumed) and asserts the exact message; a third test pins that an unreadable PDF that was *not* cut still gets the generic message, so the two errors cannot be confused.

### Minors
1. **Renderer guard** (`extract.ts`): the `renderKnownJson` call plus its fragment converter moved into `renderJson()`, with its own `try`/`catch` returning `undefined`. A renderer failure now falls back to pretty-printed JSON (`mode: "json"`) instead of dropping through the parse `catch` to raw `mode: "text"`. On the test: I probed for a payload that makes the renderer throw — a non-string `body` (the reviewer's suggestion) and answer markup nested 2 000 / 10 000 / 50 000 deep — and none of them throw; the renderers defend themselves and linkedom handles the nesting. So per the reviewer's fallback instruction the "make it throw" test is skipped, and instead: one test drives the guard through the one input that *does* throw in that block (an unparseable `page.url`) and asserts `mode: "json"` with the pretty-printed body, and one test pins that the half-recognised payload renders around the field it cannot use rather than throwing. The second test is named for what it actually asserts.
2. **Cancellation in `attachAnswers`** (`fetch.ts`): the catch now rethrows when `signal?.aborted`. It rethrows as `WebFetchError("Cancelled: <requestedUrl>")` rather than the raw `DOMException` the aborted body read produces — the first draft rethrew the original error and the test caught it escaping the layer's "everything is a WebFetchError" contract. Reported against the URL the caller asked for, matching every other abort message. A timeout (as opposed to pi's cancel signal) during the answers request is still absorbed: the question is already in hand. Test: abort mid-read of the answers body, assert `^Cancelled: http://127.0.0.1:\d+/q/1$`.
3. **`classifyContent`** (`fetch.ts`): `application/octet-stream` at a `.pdf` path is now `"pdf"` when `allowPdf`, `"binary"` otherwise. New `PDF_EXTENSION_PATTERN`, checked before the general binary-extension test. Test covers both directions against the local server, including that the refusal still happens before the body is read.
4. **README**: "Hits six real sites and five error cases" → nine real URLs (naming the github blob / npm / arXiv PDF additions) and five error cases.
5. **PDF error tests** now assert `error instanceof WebFetchError` via a local `rejection()` helper, replacing the `{ name: "Error" }` matcher; both PDF error tests were converted.

Left alone as instructed: the 2xx-but-useless rewrite limitation, and the `FetchedPage` mutation in `attachAnswers`.

### Verification
- Covering tests: `npx tsx --test tests/extract-unit.test.ts` → 49 pass / 0 fail; `npx tsx --test tests/fetch.test.ts` → 35 pass / 0 fail.
- Full suite: `npm test` → **189 pass / 0 fail** (182 before this round; 7 new tests, 0 removed, 41 suites).
- `npm run typecheck` clean.
- Live runner not re-run this round: no fetch-path behaviour it exercises changed except the octet-stream classification, which has local-server coverage.
