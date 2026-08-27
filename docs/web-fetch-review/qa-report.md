# web-fetch extension — QA report (2026-08-27)

Extension: `/Users/hoangta/.pi/agent/extensions/web-fetch` (index.ts, fetch.ts, extract.ts, test.ts). Not modified.
Harness + outputs: `<scratch>/qa-harness.mts`, `qa-edge.mts`, `qa-charset.mts`, `qa-size.mts`, `qa-index.mts`, `qa-one.mts`;
outputs in `<scratch>/qa-out/` (`NN-host.md` = full markdown, `NN-host.raw.txt` = raw body, `NN-host.shown.md` = what the
model sees after `truncateHead`, `results.json`, `harness.log`, `edge.log`, `charset.log`, `size.log`, `slow.log`, `index.log`).
`<scratch>` = `/private/tmp/claude-501/-Users-hoangta--pi-agent/3c4b50e6-f0a2-4e6a-8a84-e798e027111c/scratchpad`.

Note on environment: `www.reddit.com` and `medium.com` resolve to 127.0.0.1 on this machine (hosts-file block), so those
cases are environment failures, not tool failures. `npmjs.com` and `stackoverflow.com` return Cloudflare 403 to the tool's UA.

## 1. Existing test runner

`npx tsx test.ts` — **11/11 passed** (6 content, 5 error cases), 12.4s wall.

## 2. Results table

Grades: A = faithful & clean, B = usable with junk/minor loss, C = notable loss, D = mostly lost, F = unusable/wrong.
"ms" = fetch+extract. "trunc" = what `truncateHead(2000 lines / 50KB)` would show.

| # | url | status / type | raw B | md B / lines | ~tok | ms | mode | trunc | grade | note |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | en.wikipedia.org/wiki/Transformer_(deep_learning_architecture) | 200 text/html | 1,086,371 | 137,066 / 637 | 34k | 1387 | article | bytes 278L | B- | body complete; 10 of 11 `<h2>` lost; `[edit]` junk |
| 2 | developer.mozilla.org/…/fetch | 200 text/html | 181,627 | 8,396 / 156 | 2.1k | 2011 | article | – | B+ | complete; fences no lang; stray `js` lines |
| 3 | docs.python.org/3/library/asyncio.html | 200 text/html | 25,375 | 3,313 / 58 | 0.8k | 432 | article | – | C | code unfenced+escaped; toctree dropped |
| 4 | nodejs.org/api/fs.html | 200 text/html | 1,102,999 | 399,863 / 6330 | 100k | 1076 | article | bytes 720L | B | complete; fences no lang; `#` on headings |
| 5 | github.com/mozilla/readability | 200 text/html | 348,239 | 7,131 / 96 | 1.8k | 2080 | article | – | B | README complete; code unfenced+escaped |
| 6 | github.com/…/blob/main/Readability.js | 200 text/html | 1,131,730 | 396 / 15 | 0.1k | 1876 | article | – | F | only file metadata, zero source |
| 7 | raw.githubusercontent.com/…/README.md | 200 text/plain | 7,376 | 7,375 / 129 | 1.8k | 503 | text | – | A | passthrough, fences with lang |
| 8 | api.github.com/repos/mozilla/readability | 200 application/json | 6,898 | 6,889 / 134 | 1.7k | 638 | json | – | A | pretty-printed |
| 9 | npmjs.com/package/turndown | 403 | – | – | – | 1290 | – | – | F(ext) | Cloudflare; error dumps CSS |
| 10 | pypi.org/project/requests/ | 200 text/html | 246,270 | 8,086 / 190 | 2.0k | 632 | article | – | B- | README ok; `\>>>` escaped code; empty file table |
| 11 | arxiv.org/abs/1706.03762 | 200 text/html | 43,644 | 1,951 / 14 | 0.5k | 642 | article | – | C+ | abstract ok; **authors dropped** |
| 12 | arxiv.org/pdf/1706.03762 | 200 application/pdf | 2,215,244 | – | – | 1061 | – | – | A(err) | clean "Cannot extract text from application/pdf (2215244 bytes)" |
| 13 | stackoverflow.com/questions/11227809/… | 403 | – | – | – | 1010 | – | – | F(ext) | Cloudflare; error dumps CSS |
| 14 | news.ycombinator.com/ | 200 text/html | 34,708 | 13,673 / 181 | 3.4k | 867 | article | – | A- | all 30 stories, links absolute |
| 15 | news.ycombinator.com/item?id=1 | 200 text/html | 6,527 | 1,929 / 21 | 0.5k | 676 | full-page | – | B | comments present; nav+footer junk |
| 16 | www.reddit.com/r/programming/ | ECONNREFUSED | – | – | – | 37 | – | – | env | hosts-blocked; msg hides cause |
| 17 | www.reddit.com/r/programming.json | ECONNREFUSED | – | – | – | 35 | – | – | env | same |
| 18 | old.reddit.com/r/programming/ | 200 (→ /login) | 320,210 | **20** / 1 | 0 | 2122 | full-page | – | F | "Skip to main content"; no warning |
| 19 | react.dev/learn | 200 text/html | 265,160 | 15,310 / 343 | 3.8k | 452 | article | – | C+ | prose ok; **code blocks collapsed to 1 line** |
| 20 | vitejs.dev/guide/ | 200 text/html | 90,314 | 10,520 / 306 | 2.6k | 2068 | article | – | B+ | tables good; `npmYarnpnpmBunDeno` tab junk |
| 21 | go.dev/doc/tutorial/getting-started | 200 text/html | 35,393 | 6,165 / 129 | 1.5k | 455 | article | – | C+ | code unfenced (`<pre>` w/o `<code>`) |
| 22 | doc.rust-lang.org/book/ch01-01-installation.html | 200 text/html | 30,474 | 6,130 / 123 | 1.5k | 239 | article | – | B | "Keyboard shortcuts" junk; lang lost |
| 23 | anthropic.com/news | 200 text/html | 462,540 | 8,799 / 236 | 2.2k | 832 | full-page | – | B- | article cards ok; skip-links junk |
| 24 | medium.com/tag/programming | ECONNREFUSED | – | – | – | 177 | – | – | env | hosts-blocked |
| 25 | x.com/elonmusk | 200 text/html | 260,307 | 267 / 7 | 0.1k | 1535 | article | – | F(exp) | login wall; no warning |
| 26 | httpbin.org/redirect/3 | 200 json (→ /get) | 552 | 542 / 14 | 0.1k | 6938 | json | – | A | final URL reported |
| 27 | httpbin.org/status/500 | 500 | – | – | – | 2922 | – | – | A(err) | "HTTP 500 INTERNAL SERVER ERROR for …" |
| 28 | httpbin.org/gzip | 200 json | 540 | 530 / 14 | 0.1k | 3303 | json | – | A | decoded |
| 29 | httpbin.org/brotli | 200 json | 539 | 529 / 14 | 0.1k | 3113 | json | – | A | decoded |
| 30 | httpbin.org/encoding/utf8 | 200 text/html | 14,239 | **12** / 1 | 0 | 1282 | full-page | – | F | fragment HTML → only `<h1>` survives |
| 31 | httpbin.org/delay/5 | 200 json | 602 | 589 / 17 | 0.1k | 9138 | json | – | A | |
| 32 | https://example.com | 200 text/html | 559 | 167 / 5 | 0 | 271 | full-page | – | A | |
| 33 | http://example.com | 200 text/html | 559 | 167 / 5 | 0 | 130 | full-page | – | A | http kept (no forced upgrade) |
| 34 | gnu.org/software/bash/manual/bash.html | 200 text/html | 1,040,954 | 528,557 / 8107 | 132k | 2975 | article | bytes 744L | B | complete; 166 `<pre>` → only 16 fences |
| 35 | www.yahoo.co.jp/ | 200 text/html;utf-8 | 209,956 | 512 / 19 | 0.1k | 1027 | article | – | D | Readability picked a 3-item sidebar |
| 36 | www.people.com.cn/ | 200 text/html (utf-8 meta) | 124,588 | 734 / 4 | 0.2k | 185 | article | – | D | no mojibake (site is UTF-8 now); content lost |
| 36b | www.kakaku.com/ (meta charset=shift_jis, no header charset) | 200 text/html | 106,275 | 10,225 / 498 | 2.5k | 1108 | article | – | **F** | **mojibake**: title `���i.com`, body `�p�\�R��` |
| 36c | www.jalan.net/ (header charset=Windows-31J) | 200 text/html | 197,761 | 9,957 / 148 | 2.5k | 890 | full-page | – | B | decoded correctly |
| 37 | en.wikipedia.org/wiki/List_of_programming_languages | 200 text/html | 257,157 | 63,038 / 715 | 16k | 594 | article | bytes 581L | A- | list intact, clean cut at "S" |
| 38 | tc39.es/ecma262/#sec-array.prototype.map | 200 text/html | 7,594,217 | 2,211,811 / 37062 | 553k | 6418 | article | bytes 573L | C | fragment ignored; target at line 26907 of temp file |
| 39 | docs.anthropic.com/llms.txt | 200 text/plain | 72,234 | 72,233 / 758 | 18k | 6456 | text | bytes 538L | A | |
| 40 | docs.anthropic.com/…/prompt-caching (→ platform.claude.com) | 200 text/html | 2,384,849 | 6,855 / 45 | 1.7k | 7494 | article | – | **F** | **output is the sidebar nav only; article dropped** |
| 41 | …/prompt-caching.md | 200 text/markdown | 154,086 | 154,085 / 3337 | 39k | 1168 | text | bytes 795L | A | `.md` variant exists and is excellent |
| 42 | news.ycombinator.com/ (raw) | 200 | 34,708 | 14,500 / 187 | 3.6k | 899 | full-page | – | A- | = #14 + header/footer nav |
| 43 | npmjs.com/package/turndown (raw) | 403 | – | – | – | 171 | – | – | F(ext) | |
| 44 | github.com/…/blob/main/Readability.js (raw) | 200 | 1,131,730 | 40,902 / 4031 | 10k | 742 | full-page | **lines 2000L / 12KB** | F | code starts at line 2257; model sees nav + line numbers only |
| 45 | anthropic.com/news (raw) | 200 | 462,540 | 8,799 / 236 | 2.2k | 867 | full-page | – | B- | identical to #23 |

## 3. Edge inputs (`qa-edge.mts`, via `fetchPage` → `normalizeUrl`)

| input | result |
|---|---|
| `example.com` | OK → https://example.com/ |
| `"  https://example.com  "` | OK (trimmed) |
| `@https://example.com` | OK (`@` stripped) |
| `javascript:alert(1)` | ERR `Not a valid URL: javascript:alert(1)` — misleading; it is an unsupported scheme (becomes `https://javascript:alert(1)` → bad port) |
| `ftp://x` / `file:///etc/passwd` | ERR `Unsupported protocol "ftp:"/"file:"` — good |
| `http://localhost:1`, `http://127.0.0.1:1`, `https://[::1]` | ERR `Could not reach …: fetch failed` — cause (ECONNREFUSED) hidden |
| `http://169.254.169.254/latest/meta-data/` | ERR after **10.5s** `fetch failed` (no SSRF block, by design; note the slow hang) |
| `…/?utm_source=x&utm_medium=y&id=5` | OK; tracking params **kept** in the fetched URL (only stripped inside page links) |
| `…Transformer_(deep_learning_architecture)#Training` | OK; fragment dropped, page fetched from top |
| `data:text/html,<h1>hi</h1>` | ERR `Not a valid URL` (misleading; should say unsupported protocol) |
| `data://text/html,…` | ERR `Unsupported protocol "data:"` |
| 9,020-char URL | HTTP 404 from example.com — error message echoes the whole URL (~9KB into context) |
| `https://münchen.de`, `münchen.de` | OK → https://www.muenchen.de/ (IDN fine) but article mode returns 213B of junk (Readability mis-pick, see P3) |
| `https://example.com:443/`, `HTTPS://EXAMPLE.COM/`, `//example.com` | OK, normalized |
| `example.com/path with spaces` | OK → percent-encoded → 404 (error text includes example.com's inline CSS) |
| `https://user:pass@httpbin.org/basic-auth/user/pass` | ERR `Could not reach …: Request cannot be constructed from a URL that includes credentials` (Node limitation; message acceptable) |
| httpbin `/status/204` | 200-family, 0 bytes → index.ts throws `No readable content … may require JavaScript` (misleading for a 204) |
| httpbin `/status/301`, `/absolute-redirect/2` | followed; final URL reported (note absolute-redirect ends on **http://** — downgrade silently accepted) |
| `/response-headers?Content-Type=` | empty type → sniffed → text; fine |
| `/xml` | application/xml → passthrough text; fine |
| `/bytes/100` | `Cannot extract text from "application/octet-stream" (100 bytes)`; good |
| `/stream/3` (NDJSON) | JSON parse fails → raw passthrough; good |
| `/redirect-to?url=ftp://…` | HTTP 502 from httpbin; fine |
| `/html`, `/robots.txt`, `/deny` | fine |

## 4. Local-server tests (`qa-charset.mts`, `qa-size.mts`)

| case | result |
|---|---|
| Shift_JIS in `Content-Type` header | correct `日本語のテスト` |
| `Windows-31J` header | correct |
| `iso-8859-1` header | correct (`café`) |
| bogus `charset=x-bogus-999` | falls back to UTF-8; fine |
| UTF-8 BOM text | BOM stripped; fine |
| **Shift_JIS only in `<meta charset>`** | **mojibake** `���{��̃e�X�g` |
| **gb2312 only in `<meta http-equiv>`** | **mojibake** `������` |
| Shift_JIS only in `<?xml encoding?>` | mojibake |
| **HTML fragment, no `<html>/<body>`** (`<h1>Title</h1><p>…300 chars…</p><pre>code</pre>`) | output = `Title` (5 bytes) — everything after the first top-level element dropped |
| `<p>One</p><p>Two…</p>` | output = `One` |
| JSON served as text/html | converted as HTML, brackets escaped `\[1,2,3\]` |
| 14 MB HTML | body cut at 10,533,159 B (one chunk past the 10 MB cap); fetch 35 ms; **extract 12.9 s, +672 MB RSS**; no indication to the model that the body was cut |
| 14 MB text | cut at 10.5 MB, instant; no indication of the cut |
| 60,000-char single line (text/plain) | passes through; `truncateHead` then returns **empty content** (`firstLineExceedsLimit`) — model gets a header and nothing else (not tested via index.ts, inferred from pi's truncate.js) |
| server drips 1 byte/s for 40 s | after 30 s: **raw `DOMException: The operation was aborted due to timeout`** — not a `WebFetchError`, no URL in message |
| server sends headers after 35 s | `WebFetchError: Timed out after 30s: http://…` — correct |

## 5. index.ts execute() verification (`qa-index.mts`, real pi `truncateHead`/`formatSize`)

- Header for nodejs fs: `# File system | Node.js v26.8.1 Documentation` / `source: https://nodejs.org/api/fs.html (200 · text/html)` /
  `6330 lines · 390.5KB → showing 720 lines (49.6KB)` / `full: /var/folders/…/T/pi-web-fetch/qa-session-ABC-123-weird/001-nodejs.org-fs.html.md`.
- Temp file exists, mode 0644, 399,863 B, 6330 lines; shown content is an exact prefix of the file (verified). Truncation cut lands at a
  line boundary inside the `fs.promises.createWriteStream`-style option list (mid-section, but no partial line).
- Session id with `/` and spaces is sanitized to `qa-session-ABC-123-weird`. File names: `001-nodejs.org-fs.html.md`, `002-tc39.es-ecma262.md`,
  `003-en.wikipedia.org-Transformer_-deep_learning_architecture.md` (the `.html.md` double suffix is slightly odd but harmless).
- `session_shutdown reason=reload` keeps the dir; `reason=quit` removes it. Works as documented.
- Header does NOT say the word "truncated", does not state the truncation reason (bytes vs lines), and does not suggest the next `read` offset
  (line 721). It also never mentions when the *HTTP body* was cut at 10 MB.
- 204 empty response → `Error: No readable content … The page may require JavaScript` (misleading).

## 6. Per-URL quality notes (evidence paths under qa-out/)

- **01 Wikipedia Transformer** — prose and math (`![{\displaystyle xW}]` alt text) complete, refs list included (~40% of bytes). Only 1 of 11 `<h2>`
  survives (`grep '^## ' 01-en.wikipedia.org.md` → just "Full transformer architecture"; raw has History/Training/Architecture/…). Probable
  cause: each h2 sits in `<div class="mw-heading mw-heading2">` next to a `<span class="mw-editsection">` link, so Readability's link-density
  cleaning drops the wrapper. The `[edit]` links themselves leak 19× as `\[[edit](https://en.wikipedia.org/w/index.php?title=…&action=edit&section=3 "Edit section: …")\]`.
- **02 MDN fetch** — all sections present (Syntax/Parameters/Return/Exceptions/Examples/Specifications/See also). Code blocks are fenced but
  language-less, preceded by a stray `js` line (MDN's language label). "Baseline Widely available" banner at top. BCD table empty (JS-rendered).
- **03 Python asyncio** — h1 lost (only in header), `<pre>` blocks come out as plain escaped text: `\>>> import asyncio` / `\>>> await asyncio.sleep(10, result\='hello')`.
  The toctree (list of asyncio sub-pages, the main content of this index page) is dropped entirely. Starts with a bare `---`.
- **04 Node fs** — 6330 lines, 313 headings, 210 fenced blocks (0 with language although source has `class="language-mjs"`). Headings carry a
  trailing `#` (`## File system#`) from the anchor link. Type links `[<string>](https://developer.mozilla.org/…)` are verbose but correct.
- **05 GitHub repo** — README fully present, but every code block is unfenced and escaped: `var article \= new Readability(document).parse();`,
  `npm install @mozilla/readability`. GitHub renders highlighted blocks as `<div class="highlight highlight-source-js"><pre>` (no `<code>`).
- **06/44 GitHub blob** — article mode: `2812 lines (2520 loc) · 88.8 KB … [View remainder of file in raw view](…)`. Raw mode: 4031 lines;
  lines 1–~2250 are nav menus and then bare line numbers as paragraphs (`894\n\n895\n\n896`); source starts at line 2257 double-spaced with
  indentation lost; truncation hits the 2000-line limit at 12 KB, so the model never sees code. `raw.githubusercontent.com` (#07) is perfect.
- **10 PyPI** — README fine; `\>>> r.status\_code` escaped code; "Download files" table has header labels but no rows (JS); badges appear as `[![Version]](url)`.
- **11 arXiv abs** — abstract + submission history; title only in header; **author list missing** although `<meta name="citation_author">` is present in raw.
- **14/42 HN** — article mode already strips header/footer; 30 items, `hide`/`comments`/`from?site=` absolute. Numbering appears as `1.\n\n[title]` paragraphs.
- **15 HN item** — comments and threading metadata (`parent | next`) present; nav + footer included.
- **18 old.reddit** — redirected to `old.reddit.com/login/?reason=lor2&dest=…`; final URL is in the header but body is 20 B. No hint that this is a login wall.
- **19 react.dev** — prose complete; each sandbox code block appears twice: once fenced but with all newlines removed
  (`function MyButton() {return (<button>I'm a button</button>);}`) because lines are `<div class="cm-line">…<br/></div>` inside `<code>`, and once
  as escaped plain text (`<button\>`).
- **20 Vite** — good tables; tab strip leaks as `npmYarnpnpmBunDeno`; `bash` label lines before fences; headings end with a zero-width space.
- **21 Go** — tutorial complete but code (`<pre>` without `<code>`) is emitted as indented plain text inside the ordered list.
- **22 Rust book** — starts with mdBook's "Keyboard shortcuts" help block; fences present but language lost (`class="language-console"` in source; raw mode keeps it → confirms Readability strips classes).
- **23/45 anthropic.com/news** — full-page fallback; list of cards is fine; leading `Skip to main contentSkip to footer` and stray `-` list bullets.
- **34 bash manual** — 528 KB, 8107 lines, complete, `¶` on headings, `---` between every section; 166 `<pre class="example-preformatted">` → only 16 fences.
- **35 yahoo.co.jp / 36 people.com.cn / münchen.de** — Readability returns a small (>200 char) side block, so no full-page fallback: 512 B / 734 B / 213 B from 200–290 KB pages.
- **36b kakaku.com** — `<meta charset="shift_jis">`, no header charset → title `���i.com`, every string garbage.
- **37 List of programming languages** — clean bullet list, absolute links; truncation stops cleanly at "SIMSCRIPT".
- **38 tc39** — 7.6 MB downloaded (under the 10 MB cap, 6.4 s), 2.2 MB markdown written to temp; `#sec-array.prototype.map` ignored; section is at line 26907 of the temp file (`## 23.1.3.21 Array.prototype.map ( callback [ , thisArg ] )`) so `grep` works.
- **40 platform.claude.com prompt-caching** — 2.38 MB HTML; Readability returns the left sidebar (link list, 6.8 KB) and the actual article (h1 "Prompt caching", ~40 h2/h3) is gone. The `.md` variant (#41) and `llms.txt` (#39) are excellent.

## 7. Problems, prioritized

**P1 (high) — `<pre>` without `<code>` is not a code block; contents get markdown-escaped.**
Turndown's fenced rule requires `pre > code`. Affects GitHub READMEs (`05-github.com.md`: `var article \= new Readability(document).parse();`),
Sphinx/Python docs (`03-docs.python.org.md`: `\>>> import asyncio`), Go docs (`21-go.dev.md`), PyPI (`10-pypi.org.md`), GNU manuals
(`34-www.gnu.org.md`: 166 `<pre>` → 16 fences). For a coding agent this is the single most damaging defect. Fix: a turndown rule for `pre`
(any child) emitting a fence from `textContent`; take language from `pre`/wrapper `class` (`highlight-source-js`, `language-x`, `brush: x`).

**P2 (high) — Fence language always lost in article mode; label spans leak.**
0 of ~470 fences across all HTML outputs have a language (`grep -c '^```[a-z]'`). Readability strips `class` attributes (`keepClasses:false`), so
`<code class="language-console">` (Rust book) loses it; raw mode keeps it (`52-rust-raw.md` has ```` ```console ````). Node uses `class="language-mjs"`
on `<pre>`, MDN `class="brush: js"`, which turndown never reads anyway. MDN/Vite language labels leak as stray `js`/`bash` lines. Fix: before
Readability, copy the detected language onto a `data-lang` attribute (or pass `keepClasses:true`), and read it in the pre rule.

**P3 (high) — Readability picks the wrong block and the 200-char fallback never fires.**
`40-docs.anthropic.com.md` (platform.claude.com): output is 100% sidebar nav, article gone. `35-www.yahoo.co.jp.md` (512 B of 210 KB),
`36-www.people.com.cn.md` (734 B of 125 KB), muenchen.de (213 B of 288 KB). The model gets a confident-looking "article" with no `note:` line.
Fix ideas: (a) if article markdown < ~2–5% of raw bytes or < N chars, retry full-page and/or flag `note: extraction looks thin`; (b) treat
Readability output whose link density is very high (nav) as failure; (c) for docs sites, probe `<link rel="alternate" type="text/markdown">`,
`URL + ".md"`, or `/llms.txt` and mention it in the header.

**P4 (high) — Charset declared only in `<meta>` → mojibake.**
Real: kakaku.com (`51-kakaku.md`: `���i.com`, `�p�\�R��`). Synthetic: Shift_JIS meta, gb2312 http-equiv, `<?xml encoding>` (`charset.log`).
README says "Charset from the Content-Type header is honoured" — true, but a large share of JP/CN/KR/legacy sites only declare it in `<meta>`.
Fix: when header charset is absent, sniff the first ~2 KB of bytes for `<meta charset>` / `http-equiv content-type` / BOM and re-decode.

**P5 (medium-high) — HTML without `<html>/<body>` wrapper → only the first element survives.**
`30-httpbin.org.md` = `Unicode Demo` (12 B of a 14 KB page); synthetic `<h1>..</h1><p>..</p><pre>..</pre>` → `Title`. Cause: `extractHtml` uses
`document.querySelector("body") ?? document.documentElement`, and linkedom's `documentElement` for a fragment is the first element. Fix:
wrap the body in `<html><body>…</body></html>` when it lacks `<html>`/`<body>`, or convert `document.childNodes` in order.

**P6 (medium-high) — GitHub blob pages are unusable; nav-heavy pages hit the 2000-line limit before content.**
Article mode: 396 B of metadata. Raw: 4031 lines, code from line 2257, truncated at line 2000 (only 12 KB of the 50 KB budget used), so the model
sees menus and bare line numbers (`44-github.com-raw.shown.md`). Fix: rewrite `github.com/<o>/<r>/blob/<ref>/<path>` → `raw.githubusercontent.com/<o>/<r>/<ref>/<path>`
(and `?plain=1` for README-like pages); more generally, drop `nav/header/footer/[role=navigation]` before full-page conversion so line-limit
truncation isn't consumed by menus.

**P7 (medium) — Timeout/cancel during body streaming escapes as a raw DOMException.**
`slow.log`: `/drip` → `[DOMException] The operation was aborted due to timeout` (no URL, not `WebFetchError`). Only errors thrown by
`fetch()` itself are translated (`fetch.ts:120-125`); `readBoundedBody` (`fetch.ts:138`) is unguarded, so a slow body or an Esc during
download produces a generic message instead of "Timed out after 30s: <url>" / "Cancelled".

**P8 (medium) — Multi-line code with per-line `<div>`/`<br>` collapses.**
react.dev (`19-react.dev.md`): `function MyButton() {return (<button>I'm a button</button>);}` — turndown uses `firstChild.textContent`, which
ignores `<br>` and `<div class="cm-line">` boundaries. Same structure in GitHub blobs. Fix: in the pre rule, replace `<br>` with `\n` and join
block-level children with `\n` before reading text.

**P9 (medium) — No signal when the result is a login/JS wall or when the body was cut at 10 MB.**
`18-old.reddit.com.md` = 20 B, final URL `…/login/?reason=lor2…`, title "Welcome to Reddit"; `25-x.com.md` = 267 B login prompt; both come
back as ordinary results. A 14 MB body is silently cut at 10.5 MB (`size.log`) and the header still says nothing. Fix: add a `note:` when
markdown/raw ratio is tiny, when the final URL path contains `login|signin|consent`, and when `bytes >= MAX_BODY_BYTES`.

**P10 (medium) — Wikipedia section structure lost; `[edit]` junk.**
10 of 11 `<h2>` dropped (`01-en.wikipedia.org.md`), 19 `[edit]` links kept. Fix: remove `.mw-editsection` (and `sup.reference`? optional)
before Readability; consider `classesToPreserve`/pre-unwrapping `.mw-heading` divs.

**P11 (medium) — arXiv authors dropped.** `11-arxiv.org.md` has no "Vaswani". `<meta name="citation_author">` ×8 exist in raw; use
`citation_author`/`citation_title`/`citation_date` in the header for `author:` when Readability's byline is empty.

**P12 (low-medium) — Error message quality.**
- Cloudflare 403 detail dumps `<style>` text: `Just a moment... *{box-sizing:border-box;margin:0;padding:0}html{…}` (`harness.log` #9, #13). Strip
  `<script>/<style>` bodies before text-izing; also cap at 300 chars *after* cleanup.
- `fetch failed` hides `error.cause.code` (ECONNREFUSED / ENOTFOUND / CERT_*) — append it.
- `javascript:` and `data:` inputs report `Not a valid URL` instead of unsupported scheme (`fetch.ts:50` only treats `scheme://` as a scheme).
- 204 / empty body → "may require JavaScript" (`index.ts:155`).
- 9 KB URL is echoed verbatim in the 404 error; truncate URLs in messages.
- `169.254.169.254` hangs 10.5 s before failing (kernel timeout, not the tool's) — acceptable, but a shorter connect timeout would help.

**P13 (low) — Residual junk.** Trailing `#` (nodejs), `¶` (Sphinx/Texinfo), zero-width space (VitePress) on headings; `Skip to main content`
(anthropic.com, old.reddit, GitHub), mdBook `## Keyboard shortcuts … Press Esc to hide this help` (`22-doc.rust-lang.org.md` lines 1–11),
VitePress tab strips (`npmYarnpnpmBunDeno`), MDN "Baseline" banner, bare `---` at document start (Python docs), `\[1\]` citation escapes.

**P14 (low) — URL fragment ignored on giant pages.** tc39 (7.6 MB, 6.4 s, 2.2 MB temp) — the requested section is at line 26907. Cheap
improvement: when a fragment is present and the element with that id exists, report `fragment "#…" at line N of full file` in the header (or
start the shown window there).

**P15 (low) — Performance/memory on the 10 MB worst case.** 10 MB HTML → linkedom+Readability+turndown 12.9 s and +672 MB RSS (`size.log`);
tc39 6.4 s. Fine for normal pages (<3 s everywhere else), but a lower HTML cap (e.g. 5 MB) or a time budget would bound the worst case.

**P16 (info) — Things that work well.** Existing tests green; JSON/text/markdown passthrough; gzip/brotli; redirects with final URL; PDF/binary
refusal message; HN layout-table unwrapping; Wikipedia list pages; tables (Vite, MDN); temp-file lifecycle (reload keeps, quit deletes;
session id sanitized; shown output is an exact prefix of the file); header charset handling incl. Windows-31J; IDN hosts; `raw: true` matches
docs (adds nav; never loses content vs article mode).
