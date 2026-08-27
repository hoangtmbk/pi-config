## Task 5b: Wire rewrite/pdf/renderers into fetch → extract → index

Modules already exist and are unit-tested (do not change their public signatures):
- `rewrite.ts`: `rewriteUrl(url: URL): { url: URL; note: string; fallback?: URL } | undefined` — every rule sets `fallback` (the original URL) except none; github blob→raw, SO/SE → api.stackexchange.com questions endpoint, npm → registry.npmjs.org, wikipedia → rest_v1/page/html, arxiv abs → html, pypi → /pypi/{name}/json.
- `renderers.ts`: `renderKnownJson(finalUrl: URL, json: unknown, htmlToMarkdown: (html: string) => string): string | undefined` — StackExchange (expects `json.answers` = the answers request's `items` if available), npm packument, PyPI JSON.
- `pdf.ts`: `pdfToText(bytes: Uint8Array, opts?: { maxPages?: number }): Promise<{ text; pages; truncatedPages; title? }>` — imports `unpdf` (~2 MB) at module scope.

Existing interfaces: `fetchPage(url: string, signal?: AbortSignal, opts?: { allowPdf?: boolean; timeoutMs?: number }): Promise<FetchedPage>`; `FetchedPage` has `url` (final URL), `status`, `contentType`, `charset`, `body`, `bytes`, `truncatedAtBytes`, `bytesBody?`. `extract(page, raw): Extracted` with `mode: "article" | "full-page" | "json" | "text"` and `keptRatio`. `index.ts` calls `fetchPage(params.url, signal)` then `extract(page, params.raw)`.

### 1. fetch.ts — rewrite + fallback
In `fetchPage`, after `normalizeUrl` and before the request: `const rw = rewriteUrl(new URL(normalized))`. If set, fetch `rw.url`; on a non-2xx response (after the existing UA retry) AND `rw.fallback` set, fetch the fallback (original) URL instead and note it. Add to `FetchedPage`: `requestedUrl: string` (what the caller asked for, normalized), `note?: string` (e.g. `"github blob → raw"` or `"github blob → raw failed (404); fetched original"`). Tracking-param stripping and everything else unchanged. For StackExchange rewrites ONLY: after a 2xx question response, issue ONE extra request to `https://api.stackexchange.com/2.3/questions/{id}/answers?site={site}&filter=withbody&order=desc&sort=votes&pagesize=10` (derive from `rw.url`) and attach its `items` to the question JSON as `answers` (parse both, re-serialize into `body` as JSON text so `extract` sees one JSON document); if the answers request fails, proceed with the question alone. Keep this ≤ ~40 lines; put StackExchange-specific code in a small helper.

### 2. extract.ts — renderers + PDF routing
- In the JSON branch: before pretty-printing, try `renderKnownJson(new URL(page.url), parsed, html => <the existing HTML→markdown conversion of a fragment string>)`; if it returns a string use it with `mode: "json"` (title = first `# ` line if any). Expose the fragment converter as a small internal function (parse fragment with linkedom → same universal cleanup passes that raw mode uses → Turndown).
- PDF: when `page.bytesBody` is set (or contentType is `application/pdf`), `await import("./pdf.ts")` lazily and return `{ mode: "pdf", markdown: text, title, keptRatio: 1 }` plus a leading line `pages: N (showing first M)` only when `truncatedPages`. Add `"pdf"` to the `mode` union. `extract` becomes `async` — update all call sites and tests (`extract-unit`, `fidelity` helpers) accordingly; keep the change mechanical.
- `pdfToText` errors (no extractable text) propagate as `WebFetchError`.

### 3. index.ts — minimal wiring only
`fetchPage(params.url, signal, { allowPdf: true })`; `await extract(...)`. Do NOT redesign the header (Task 6 does) — but if `page.note` is set, append one line `note: <note>` after the `source:` line so the rewrite is visible now. Update the tool description's one sentence about supported content to mention PDF.

### 4. Tests
- `tests/fetch.test.ts`: local-server tests for (a) rewrite applied (monkeypatch not allowed — instead export a tiny `resolveRequestUrl(normalized: string)` helper from fetch.ts that returns `{ url, rewrite }` and unit-test it for a github blob URL; and test the fallback path end-to-end with the local server by adding a test-only option `opts.rewrite?: (url: URL) => Rewrite | undefined` defaulting to `rewriteUrl` so a test can inject a rewrite pointing at a 404 route with fallback to a 200 route); (b) StackExchange answers attachment via injected rewrite to local routes `/questions/1` and `/questions/1/answers`.
- `tests/extract-unit.test.ts`: JSON from an npm-registry-shaped URL renders via renderer (title line present, no raw JSON braces); unknown JSON still pretty-prints; PDF bytes (reuse the `makePdf` helper from `tests/pdf.test.ts` — move it to `tests/helpers.ts`) through `extract` gives `mode: "pdf"` and the text.
- Keep all 163 existing tests green; `npm run typecheck` clean.

### 5. test.ts (live, opt-in) — add `https://github.com/mozilla/readability/blob/main/README.md`, `https://arxiv.org/pdf/1706.03762`, `https://www.npmjs.com/package/turndown` to its URL list. Do not run it in CI; you may run it once manually and paste a 5-line summary in the report if network is available.

Commit: `feat: wire URL rewrites, JSON renderers and PDF text into the pipeline`.
