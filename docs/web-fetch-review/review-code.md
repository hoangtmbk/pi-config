# Code review: pi `web_fetch` extension

Reviewed: `/Users/hoangta/.pi/agent/extensions/web-fetch/{index.ts,fetch.ts,extract.ts,test.ts,README.md,package.json}`
Against: `@earendil-works/pi-coding-agent` 0.84.3 at
`/Users/hoangta/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent` (referred to as `$PI` below).

Every claim marked **[verified]** was reproduced by running the extension's real `extract.ts`/`fetch.ts` under Node 22.22.2 (scripts in this scratchpad: `probe-extract.mjs`, `probe-fetch.mjs`, `tscheck/`). No files in the extension directory were modified.

---

## 0. pi API usage in index.ts — verdict: correct

All pi-facing code is right. Evidence:

| Usage in index.ts | Proof in pi 0.84.3 |
|---|---|
| `import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, TruncationResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"` (index.ts:13-21) | `$PI/dist/index.d.ts:24` re-exports all truncation symbols; `:7` exports `ExtensionAPI`, `ExtensionContext`, `ToolDefinition`, `ToolRenderResultOptions` |
| `import { Text } from "@earendil-works/pi-tui"`; `new Text(str, 0, 0)` (index.ts:22,195,224) | `$PI/node_modules/@earendil-works/pi-tui/dist/components/text.d.ts:13` `constructor(text?, paddingX?, paddingY?, customBgFn?)`; docs/extensions.md:2258-2270 use the same form. Aliases for `pi-tui`/`typebox` documented at docs/extensions.md:143-146 |
| `pi.on("session_shutdown", ...)`, `event.reason === "reload" \|\| "fork"` (index.ts:119-123) | `$PI/dist/core/extensions/types.d.ts:478-483`: `reason: "quit" \| "reload" \| "new" \| "resume" \| "fork"`; docs/extensions.md:516-524 |
| `pi.registerTool({ name, label, description, promptSnippet, promptGuidelines, parameters, execute, renderCall, renderResult })` | `types.d.ts:344-377` (`ToolDefinition`), `:927` (`registerTool`) |
| `execute(_toolCallId, params, signal, _onUpdate, ctx)` | `types.d.ts:372` exact signature |
| `renderCall(args, theme, ctx)` / `renderResult(result, { expanded, isPartial }, theme, ctx)` | `types.d.ts:374-376`, `ToolRenderResultOptions` at `:308-313`; docs/extensions.md:2277 |
| Throwing from `execute` to get `isError` | docs/extensions.md:1997 "throw an error from `execute` ... Returning a value never sets the error flag" |
| `ctx.sessionManager.getSessionId()` (index.ts:67) | `types.d.ts:140` (`ReadonlySessionManager` picks `getSessionId`), `:207` `getSessionId(): string`; docs/extensions.md:678 |
| `truncateHead(md, { maxLines, maxBytes })` | `$PI/dist/core/tools/truncate.d.ts:53`; identical to docs/extensions.md:2173-2176 |
| "full: <abs path>" hint consumable by `read` | `$PI/dist/core/tools/read.js:160` -> `resolveReadPathAsync(path, cwd)` -> `path-utils.js:42-44` `resolvePath(filePath, cwd, { stripAtPrefix: true })`; absolute paths resolve to themselves. `read` supports `offset`/`limit` (read.js:200-247) |
| Truncation-notice style | Built-ins put the notice *after* the content in `[...]` (bash.js:314-320 `[Showing lines a-b of N. Full output: <path>]`, grep.js:280 `[... limit reached]`, read.js:243). web_fetch puts it in a header before the content. Not wrong, just a different convention; header is arguably better because it is never cut off |
| Extension discovery | `$PI/dist/core/extensions/loader.js:535-559,625-634`: `~/.pi/agent/extensions/<dir>/package.json` with `pi.extensions` is honoured, else `index.ts`. package.json's `"pi": {"extensions": ["./index.ts"]}` is valid (and redundant) |

One important loader fact used by findings M7/L8 below: **`$PI/dist/core/extensions/loader.js:417-418` creates jiti with `moduleCache: false`**, so `/reload` re-evaluates `index.ts` and module-level `scratchDir`/`pageCount` reset to `undefined`/`0`.

---

## 1. Findings

Severity legend: **Critical** = silently corrupts content the owner explicitly wants preserved; **High** = drops real information on common page types or makes common fetches fail; **Medium** = robustness/UX defects with a clear trigger; **Low** = polish, simplicity, docs.

### CRITICAL

#### C1. `cleanMarkdown` regexes rewrite text inside code blocks and inline code — deletes C++/JS lambdas, mangles indexers
`extract.ts:172-187` (applied at `:219` and `:237`)

The post-conversion regexes run over the whole markdown string, including fenced and inline code. **[verified]** with `<code>[](int a){ return a; }</code>` and `<pre><code>auto f = [](int a) { return arr[i](); };</code></pre>`:

```
Lambda: `{ return a; }` and index `arri`
```
```
auto f =  { return arri; };
```

- `:177` `/\[\s*\]\([^)]*\)/g` deletes every `[](...)` — the C++ lambda capture list, `[](x) => ...` in TS/JS, Rust `[]( )`-like macros.
- `:179` `/\[([^\]]*)\]\(\s*\)/g` turns `arr[i]()` into `arri`, `fns[0]()` into `fns0`, Python `d[k]()`.
- `:183` `/^(\s*[-*_]\s*){3,}$/gm` rewrites `-----`, `- - -`, `***`, `___` lines inside `<pre>` (ASCII tables, diff separators, RFC/man-page rulers, YAML `---` stacks). Because `\s*` matches newlines under `/m`, it also merges *consecutive* such lines: `---\n-----` became a single `---` **[verified]**.
- `:181` `/\n{3,}/g` collapses blank-line runs in code; `:180` strips trailing whitespace (which also erases turndown's `  \n` hard line breaks from `<br>`).

For a tool whose stated goal is "loses no information" and targets coding, this is the most damaging issue: it corrupts exactly the samples a developer fetches a page for, with no indication anything happened.

**Fix:** Do the cleanup at the DOM level before turndown, and delete the markdown-level regexes:
```ts
// in extractHtml, after absolutizeLinks:
for (const a of Array.from(document.querySelectorAll("a"))) {
  if (!a.textContent?.trim()) a.remove();           // [](#anchor)
  else if (!a.getAttribute("href")) a.replaceWith(...Array.from(a.childNodes)); // [text]()
}
```
Then `cleanMarkdown` reduces to `.replace(/\n{3,}/g, "\n\n").trim()` at most — and even that should skip fenced blocks (split on ```` ``` ```` fences, or accept the extra blank lines). Drop the `---` collapsing entirely; turndown already emits one `---` per `<hr>`.

### HIGH

#### H1. Bare `<pre>` (no `<code>` as *first child*) is not fenced and its contents are markdown-escaped
`extract.ts:54-60,67-68` (turndown defaults), turndown rule at `node_modules/turndown/lib/turndown.cjs.js:127-129`

Turndown's `fencedCodeBlock` filter requires `node.nodeName === 'PRE' && node.firstChild.nodeName === 'CODE'`. Anything else falls to the default rule and text nodes are escaped (`turndown.cjs.js:726`: `node.isCode ? nodeValue : escape(nodeValue)`, where `isCode` is only set under a `CODE` ancestor, `:531`). **[verified]**:

| Input | Output |
|---|---|
| `<pre>bare_pre *not* code</pre>` | `bare\_pre \*not\* code` (no fence) |
| `<div class="highlight highlight-source-rust"><pre>let v: Vec<i32> = vec![];</pre></div>` (GitHub README/blob markup) | `let v: Vec<i32> = vec!\[\];` |
| `<pre>\n<code class="language-py">...` (whitespace text node first) | fenced, but language lost |

This hits GitHub-rendered code (`div.highlight > pre`), Python docs, pkg.go.dev, Doxygen/Javadoc, many Sphinx/MkDocs themes, and any page where `<pre>` holds `<span>` tokens directly.

**Fix:** Replace turndown's rule with one that fences every `<pre>`:
```ts
turndown.addRule("pre", {
  filter: "pre",
  replacement: (_c, node) => {
    const el = node as Element;
    const code = el.querySelector("code");
    const cls = [el, code, el.parentElement].map(e => e?.getAttribute("class") ?? "").join(" ");
    const lang = cls.match(/(?:language-|lang-|highlight-source-|brush:\s*)([\w+#-]+)/)?.[1] ?? "";
    const text = el.textContent ?? "";
    const fence = "`".repeat(Math.max(3, ...(text.match(/`{3,}/g) ?? []).map(m => m.length + 1)));
    return `\n\n${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}\n\n`;
  },
});
```
Also set `preformattedCode: true` in `TURNDOWN_OPTIONS` so whitespace inside `<code>` is preserved.

#### H2. Readability strips `class` attributes, so article mode loses every code-block language tag
`extract.ts:213` `new Readability(clone, { charThreshold: 100 })`; Readability at `node_modules/@mozilla/readability/Readability.js:287-289` (`if (!this._keepClasses) this._cleanClasses(articleContent)`)

**[verified]**: the same `<pre><code class="language-js">` yields ```` ```js ```` in raw mode but a bare ```` ``` ```` in article mode. Language tags matter to a coding agent (and to any renderer).

**Fix:** `new Readability(clone, { charThreshold: 100, keepClasses: true })` (option declared in `node_modules/@mozilla/readability/index.d.ts:26`). Combined with H1's rule this restores language detection.

#### H3. Tables without `<th>` are flattened into a paragraph per cell — row/column association destroyed
`extract.ts:125-142` (`unwrapLayoutTables`), `:75-109` (`dataTable` rule)

**[verified]**: a 3-row parameter table `name/type`, `id/string`, `limit/number` with only `<td>` becomes six stacked paragraphs `name`, `type`, `id`, `string`, ... — the reader can no longer tell which type belongs to which parameter. Many API reference pages, changelogs, and comparison tables use `<td>` + bold first row; Markdown-rendered tables always have `<th>` but hand-written HTML docs frequently do not. Additional losses in the table rule: `<caption>` text is discarded **[verified]**; `colspan` is ignored (cells shift left); `<pre>` inside cells is squashed to one line (`:91`).

**Fix:** Treat a table as layout only when it *contains another table*, or has a single row, or a single column, or is the HN-style outer shell (all cells wrap block content and there is exactly one `<td>` per row). Otherwise render it as a GFM table even without `<th>` (use an empty header row). Emit the caption as a bold line above the table. Honour `colspan` by padding with empty cells.

#### H4. `TEXT_TYPE_PATTERN` refuses common textual content types; unknown types are refused without sniffing
`extract.ts:29-30,279-306`

**[verified]** thrown as "Cannot extract text": `text/xml`, `text/javascript` (the IANA-registered JS type, used by jsDelivr/unpkg/many CDNs), `text/vtt`, `text/calendar`, `video/mp2t` (how many static servers label `.ts` source files), `application/octet-stream` with a plain-text body (raw files on many hosts). The regex only whitelists a few `text/*` subtypes.

**Fix:**
```ts
if (type.startsWith("text/")) return passthrough(page);          // all text/* is text by definition
if (/^application\/(x-)?(yaml|toml|sh|javascript|ecmascript|typescript|xml|sql|x-httpd-php)$|\+xml$/.test(type)) return passthrough(page);
// unknown / octet-stream: sniff instead of refusing
const head = page.body.slice(0, 4096);
const looksBinary = / /.test(head) || (head.replace(/[\x09\x0a\x0d\x20-\x7e -￿]/g, "").length / head.length) > 0.1;
if (!looksBinary) return looksHtml ? extractHtml(page, raw) : passthrough(page);
throw new WebFetchError(...)
```
(`passthrough` = the repeated `{title: undefined, ..., mode: "text"}` literal — see L-simplicity.)

### MEDIUM

#### M1. Abort/timeout during the body phase surfaces a raw `DOMException`
`fetch.ts:106-125` wraps only `fetch()`; `readBoundedBody` at `:138` is outside the `try`.

**[verified]**: aborting while the body is streaming throws `[DOMException] This operation was aborted` — not "Cancelled"/"Timed out". The 30s timeout also covers the body read (signal is shared), so a slow, trickling server ends with the same opaque error.

**Fix:** move the `signal?.aborted` / `timeout.aborted` translation into a helper and apply it around both `fetch()` and `readBoundedBody()`; e.g. wrap the whole function body in one `try/catch` that checks `signal?.aborted` and `timeout.aborted` first.

#### M2. Network errors are reported as "fetch failed" — the real cause is in `error.cause`
`fetch.ts:123-124`

**[verified]**: `Could not reach https://127.0.0.1:55315/final: fetch failed`. undici puts `ENOTFOUND`, `ECONNREFUSED`, `CERT_HAS_EXPIRED`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, etc. in `error.cause`. The model cannot distinguish DNS failure from TLS failure from refused connection.

**Fix:**
```ts
const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
const reason = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
```

#### M3. Binary responses are fully downloaded (up to 10 MB) before being refused
`fetch.ts:127-138` reads the body for every 2xx; `extract.ts:303` refuses afterwards.

**[verified]**: a 3 MB `image/png` was read completely (`bytes=3145728`) and then rejected. A PDF/zip/ISO link costs up to 10 MB of transfer and 10 MB of memory to produce an error. `content-length` is also never consulted.

**Fix:** decide text-ness from the content type *before* reading (`isTextualType(type)`, sharing the logic from H4); for non-textual types call `response.body?.cancel()` and throw immediately with `content-length` in the message. Keep the sniff path for empty/`octet-stream` types (read only the first chunk, then decide).

#### M4. `<meta charset>` is ignored; header-less legacy-encoded pages decode to U+FFFD
`fetch.ts:91-97`

**[verified]**: `<meta charset="windows-1252">` + byte `0x93` -> `quote: �hello�`. Many CJK and older European sites declare charset only in `<meta>`. Node 22 (full ICU) can decode Shift_JIS/GBK/EUC-KR/windows-125x via `TextDecoder`.

**Fix:** when the header has no charset and the type is HTML, decode the first ~2 KB as latin1, match `/<meta[^>]+charset=["']?\s*([\w-]+)/i` or `http-equiv` content-type, then decode the whole buffer with that label (fallback utf-8).

#### M5. Oversize bodies are silently cut at 10 MB with no signal to the model
`fetch.ts:77-87`, `FetchedPage` has no flag; `index.ts` header never mentions it.

**[verified]**: 12 MB body -> `bytes=10550124`, same `body.length`, no indication. A truncated HTML document parses fine and looks complete.

**Fix:** return `bodyTruncated: bytes >= MAX_BODY_BYTES` from `readBoundedBody`, propagate it into `FetchedPage`, and add `note: response truncated at 10MB` to the header (and `details`).

#### M6. `firstLineExceedsLimit` is not handled — the tool returns an empty body, and `read` on the saved file is empty too
`index.ts:161-170,186`; `$PI/dist/core/tools/truncate.js:64-79` (returns `content: ""` when line 1 > 50 KB); `$PI/dist/core/tools/read.js:220-224` (read tool does the same).

**[verified]**: a 60 KB single-line `text/plain` response yields `truncated=true, firstLineExceedsLimit=true, content.length=0`. The model sees the header ("showing 0 lines") and a path; `read` of that path also returns nothing, so the content is only reachable via `grep`/`bash`. Triggers: minified JS/CSS, single-line JSON that failed `JSON.parse` (NDJSON is fine, but a minified non-JSON blob is not), long base64/data blobs, some `text/plain` API responses.

**Fix:** after truncation, `if (truncation.firstLineExceedsLimit) { content = markdown.slice(0, DEFAULT_MAX_BYTES); note = "first line exceeds 50KB; showing its first 50KB" }`. Optionally soft-wrap pass-through text at ~4 KB per line before truncation so `read` offsets remain usable.

#### M7. `/reload` resets `pageCount` while the directory persists — later saves can overwrite files earlier tool results cite
`index.ts:53-54,82`; `$PI/dist/core/extensions/loader.js:417-418` (`moduleCache: false` -> module re-evaluated on reload)

After `/reload`, `scratchDir` is recomputed to the *same* directory (by design) but `pageCount` restarts at 0, so the next save is `001-<host>-<segment>.md`. Fetching the same URL (or any URL with the same host + last path segment, e.g. `.../README.md`) overwrites a file the transcript still references. The README's stated reason for session-keyed dirs ("earlier tool results still cite these paths") is undermined.

**Fix:** make the name unique without module state: `${Date.now().toString(36)}-${hint}.md`, or use the `toolCallId` argument that `execute` already receives (`index.ts:150`), which is unique per call. That also removes the `pageCount` variable.

#### M8. `mkdir` race under parallel tool execution
`index.ts:66-70`; parallel execution is the default in `$PI/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:289-293` (sequential only if `config.toolExecution === "sequential"` or a tool sets `executionMode: "sequential"`).

When the model issues several `web_fetch` calls in one turn, call A sets `scratchDir` synchronously then awaits `mkdir`; call B sees `scratchDir` set, skips `mkdir`, and can hit `ENOENT` in `writeFile`.

**Fix:** `await mkdir(scratchDir, { recursive: true })` unconditionally before `writeFile` (idempotent, ~0.1 ms). Drop the `if (!scratchDir)` guard entirely by computing `scratchDir` as a pure function of the session id.

#### M9. Tracking-parameter list strips legitimate query parameters (`ref`, `source`, `si`)
`extract.ts:32,162-164`

**[verified]**: `https://api.github.com/repos/a/b/contents/p?ref=dev` -> `.../contents/p` (branch selector removed; GitHub UI also uses `?ref=` in some links). `source` is a real parameter on many sites (Wikipedia `?source=...`, Google Books, docs viewers); `si` is a two-letter key that collides with legitimate short params. A researcher clicking through these links gets different content.

**Fix:** keep only unambiguous trackers: `/^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_[a-z]+|_hs\w+|igshid|ref_src|yclid)$/i`. Drop `ref`, `source`, `si`.

#### M10. Partial article extraction is accepted silently; the model has no way to judge how much of the page was kept
`extract.ts:209-234`; fallback only when markdown < 200 chars (`:26`)

Readability keeps the top-scoring block plus siblings; on documentation pages it routinely drops parameter tables, "See also" sections, version selectors, and any section with low text density. Anything over 200 chars is returned as `mode: "article"` with no hint. The `raw` escape hatch exists, but the model only learns it needs it after noticing something is missing (which it cannot, by construction).

**Fix (two parts):**
1. Prefer structural extraction when the page provides it: if `document.querySelector("main, [role=main], article")` exists and its text is >= ~40% of body text, convert *that* element (no Readability). This preserves headings/tables/code order exactly. Use Readability only when no such landmark exists.
2. Always compute `kept = articleText.length / bodyText.length` and put `extracted: 62% of page text (raw: true for all)` in the header, and auto-fall back to full page when `kept < 0.4`.

#### M11. Bare `host:port` is upgraded to `https://`, which breaks the localhost use case the README advertises
`fetch.ts:50`; README:111-112 ("fetching `localhost:3000` docs is a thing you want")

**[verified]**: `127.0.0.1:<port>/final` -> `Could not reach https://127.0.0.1:...: fetch failed`.

**Fix:** `const scheme = /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(trimmed) ? "http" : "https"`; or on a TLS/ECONNREFUSED failure for a scheme-less input, retry once over http.

### LOW

#### L1. Type errors / no type-check setup
- `extract.ts:47`: `"svg"` is not a `keyof HTMLElementTagNameMap` -> `TS2322` (with `@types/turndown`). `svg`/`canvas` were already removed at `:195`, so simply drop `"svg", "canvas"` from that array, or use a filter function.
- `@types/turndown` is not a devDependency and there is no `tsconfig.json`, so `tsc`/`tsx --check` cannot be run from the extension directory; `turndown` resolves as implicit `any` (`TS7016`, `TS7006` x4). Add `devDependencies: { "@types/turndown", "typescript" }` and a minimal `tsconfig.json` with `paths` aliases for `@earendil-works/*` and `typebox` pointing at pi's global install (see `tscheck/tsconfig.json` in this scratchpad for a working one).

`tsc` output with a correct alias setup: only the `svg` error above; index.ts and fetch.ts are clean.

#### L2. `Accept` header offers `application/json` at q=1
`fetch.ts:116`. Content-negotiating endpoints (Rails, DRF, some docs sites, GitHub API-vs-HTML on the same URL) may pick JSON over HTML. Use `application/json;q=0.9`.

#### L3. Per-chunk buffer copy
`fetch.ts:89` `Buffer.concat(chunks.map(c => Buffer.from(c)))` copies every chunk twice; `Buffer.concat(chunks)` accepts `Uint8Array[]` directly.

#### L4. Error pages read up to 10 MB to produce a 300-char detail
`fetch.ts:131`. Read at most ~64 KB for the error branch.

#### L5. Hard line breaks and code blank lines lost
`extract.ts:180-181`. Trailing-space strip erases turndown's `  \n` (`<br>`), and `\n{3,}` collapses blank-line runs inside code. Covered by C1's fix (no markdown-level regexes).

#### L6. `(\n---\n)+` only collapses separators that have a blank line between them
`extract.ts:184`. After `\n---\n` is consumed the next char is `-`, not `\n`, so `---\n---` is not collapsed; only `---\n\n---` is. Dead-ish rule; delete with C1.

#### L7. Readability demotes `<h1>` to `<h2>`
`Readability.js:828-831`. Heading levels inside the article shift by one relative to the page; harmless since the title is in the header, but worth knowing when comparing against raw mode (which keeps `#`).

#### L8. Temp-dir lifecycle: orphan on `fork`, orphan on crash; simpler to not clean at all
`index.ts:119-132`. On `fork`, the old instance skips `rm`, and the new instance keys on the *new* session id, so the old dir is never removed by anyone. SIGKILL/crash leaves dirs too. pi's own bash tool never cleans its temp files (`$PI/dist/core/tools/output-accumulator.js:8` `join(tmpdir(), "pi-bash-<id>.log")`). Options: (a) accept the same policy and delete the handler + `scratchDir`/`pageCount` state (~35 lines), naming files `pi-web-fetch/<sessionId>/<toolCallId>-<hint>.md`; or (b) keep cleanup and add a startup sweep of dirs older than N days. (a) is more in the spirit of "minimal".

#### L9. `formatSize(details.chars)` labels a character count as bytes
`index.ts:208`. Use `Buffer.byteLength` or label it `chars`.

#### L10. `details.truncation` embeds the 50 KB `content` string, duplicating output in the session file
`index.ts:181`; `TruncationResult.content` (`truncate.d.ts:14`). Built-ins do the same (`bash.js:309`), so it is consistent, but `const { content: _, ...meta } = truncation` would halve the persisted size.

#### L11. Readability output is serialized to HTML then re-parsed by turndown's bundled domino
`extract.ts:219`. Two parsers, two DOM models. Readability accepts `serializer: (n) => n` (`index.d.ts:27`) and turndown accepts a DOM node; passing the node avoids the round-trip. Optional; only matters for very large pages.

#### L12. README drift
- README:37 example path `pi-web-fetch-GDGPza/page.md` does not match the actual `pi-web-fetch/<session>/001-<host>-<segment>.md` naming (README:54 is correct).
- README:102 "aborted mid-stream rather than buffered" — it buffers up to 10 MB, then cancels; and the truncation is invisible (M5).
- README:107 "Charset ... honoured" — header only (M4).

#### L13. Tool description could say a bit more
`index.ts:137-147`. Add: "does not execute JavaScript (SPA shells return little)", "a bare domain is accepted", "the saved full-page file lives only for this session", and (after M10) "header reports what fraction of the page was kept". Consider `executionMode: "parallel"` explicitly (it is the default, but documents intent).

#### L14. `![alt]` is not valid Markdown
`extract.ts:41`. Renders literally; `[image: alt]` is unambiguous for a model and for renderers. Cosmetic.

---

## 2. Simplicity / dead code

- `fetch.ts:24-25,144` `FetchedPage.charset` is never read by `extract.ts`; drop it (or use it for M4).
- `extract.ts:248-268,279-300` the `{ title: undefined, byline: undefined, publishedTime: undefined, markdown, mode }` literal is repeated four times; a `text(page)` helper removes ~20 lines.
- `extract.ts:126` `for (let pass = 0; pass < 100; pass++)` — a `while (true)` with the existing `return` is clearer; or sort tables by depth once and unwrap in one pass.
- `extract.ts:45-49` `dropNonContent` rule: `script/style/noscript/iframe/svg/canvas` are already removed at `:195`; only `form`/`button` are still needed here (and after H1, none of it needs `svg`).
- `index.ts:67` `ctx.sessionManager?.getSessionId?.()` — both are non-optional in the types (`types.d.ts:140,207`); write `ctx.sessionManager.getSessionId()`.
- `index.ts:52-54,119-132` per L8, the whole shutdown/cleanup machinery can go if pi-bash's no-cleanup policy is acceptable.
- `test.ts:16,106` `contentType` is passed into `check` but no case uses it.
- `fetch.ts:30` `WebFetchError` adds nothing over `Error` (no `name`, no fields); fine to keep as a marker, but it is never checked anywhere.

---

## 3. Things that are fine (checked, no action)

- gzip/deflate/brotli: Node's undici fetch decodes all three transparently **[verified]** (`/br`, `/gz` probes).
- Redirects: `redirect: "follow"`, `response.url` is the final URL **[verified]**; used as link base.
- `AbortSignal.any` / `AbortSignal.timeout` compose correctly (Node 22); the timeout timer is unref'd.
- Body-size guard actually cancels the stream (`reader.cancel()` in `finally`) rather than buffering to completion **[verified]** (12 MB server, 10.55 MB received).
- HTTP error path includes the server's own text **[verified]** (`HTTP 500 ... — Boom db down`).
- Readability + linkedom: `document.cloneNode(true)`, scoring, `parse()` all work; article mode is reached on synthetic and (per README) real pages. `isProbablyReaderable` is not used and is not needed.
- Nested lists, inline code with backticks, entity decoding (`&nbsp;`, `&amp;`, `&lt;`), heading conversion, relative-link resolution against the post-redirect URL all behave **[verified]**.
- Errors thrown from `execute` are surfaced as `isError` (docs/extensions.md:1997) and `renderResult` handles the no-`details` case by printing the message (`index.ts:202-205`).
- `renderResult` shows "Fetching..." while `isPartial`; correct since no `onUpdate` is ever called.

---

## 4. Suggested order of work

1. C1 (DOM-level link cleanup, delete regexes) + H1 (universal `<pre>` rule) + H2 (`keepClasses`) — these three together make code samples round-trip faithfully; ~40 lines net.
2. H4 + M3 (one `isTextualType` used by both files; refuse binary before download; sniff unknown).
3. M1/M2/M5/M11 in fetch.ts — all small.
4. M6/M7/M8 in index.ts — all small; M7+M8 are fixed together by naming files with `toolCallId` and always calling `mkdir`.
5. H3/M9/M10 — the extraction-policy changes; M10's "kept %" header line is the cheapest big win for "loses no information".
6. L-items and README sync.
