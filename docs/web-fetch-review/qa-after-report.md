# web-fetch extension — QA-after report (fidelity branch, HEAD fdf15f1)

Extension: `/Users/hoangta/.pi/agent/extensions/web-fetch` (not modified). Harness:
`<scratch>/qa-after.mts`, run via `npx tsx <scratch>/qa-after.mts` from inside the extension dir
so `node_modules` resolve. Outputs: `web-fetch-review/qa-after/NN-host[-raw].md` +
`web-fetch-review/qa-after/results.json`. `<scratch>` =
`/private/tmp/claude-501/-Users-hoangta--pi-agent/3c4b50e6-f0a2-4e6a-8a84-e798e027111c/scratchpad`.

Harness calls `fetchPage(url, undefined, { allowPdf: true })` then `await extract(page, raw)` —
the real pipeline minus the `index.ts`/`format.ts` header-formatting layer (per instructions, a
few rows note what the header layer *would* add, verified by reading `format.ts` directly).

## 1. Existing test runner

`npx tsx test.ts` — **14/14 passed** (9 content cases, 5 error cases): `All cases passed.`

## 2. Before/after table

Grades are my read of the saved markdown against the same rubric as the original report
(A = faithful & clean, B = usable with minor loss, C = notable loss, D = mostly lost, F = unusable).

| # | url | old | new | mode | kept | md KB | fences lang/tot | note |
|---|---|---|---|---|---|---|---|---|
| 1 | docs.python.org/3/library/asyncio.html | C | **A-** | article | 0.53 | 3.5 | 2/2 | both examples fenced+langed, verbatim |
| 2 | github.com/mozilla/readability | B | **A-** | article | 0.66 | 7.4 | 5/6 | all code blocks now fenced |
| 3 | github.com/…/blob/Readability.js | F | **A** | text | 1.0 | 88.8 | – | rewritten to raw.githubusercontent.com, full source |
| 4 | react.dev/learn | C+ | **A-** | text | 1.0 | 15.8 | 27/27 | MDX source via content negotiation, all code fenced+langed |
| 5 | go.dev/doc/tutorial/getting-started | C+ | **B+** | article | 0.73 | 6.5 | 0/10 | now fenced (source has no lang class to recover) |
| 6 | pypi.org/project/requests/ | B- | **A-** | json | 1.0 | 3.2 | 4/4 | PyPI JSON renderer, clean `>>>` code |
| 7 | en.wikipedia.org/…/Transformer | B- | **A-** | article | 0.76 | 194 | 0/1 | Parsoid rewrite: 10/10 h2s kept, 0 `[edit]` junk |
| 8 | platform.claude.com/…/prompt-caching | F | **A** | text | 1.0 | 154 | 76/76 | `.md` variant served via Accept header |
| 9 | www.yahoo.co.jp/ | D | **C-** (raw: A-) | article | 0.09 | 1.7 | – | still thin in article mode; header now warns + `raw=true` fixes it |
| 10 | kakaku.com/ | F | **A-** | full-page | 0.98 | 26 | – | meta-charset sniff works, no mojibake |
| 11 | httpbin.org/encoding/utf8 | F | **A** | full-page | 1.0 | 14 | 0/1 | full fragment preserved |
| 12 | npmjs.com/package/turndown | F(403) | **A** | json | 1.0 | 9.6 | 11/12 | registry rewrite + renderer |
| 13 | stackoverflow.com/questions/… | F(403) | **A-** | json | 1.0 | 39.7 | 8/37 | StackExchange API + merged answers, code fenced |
| 14 | arxiv.org/abs/1706.03762 | C+ | **B+** | article | 0.92 | 40.6 | – | all 8 authors+affils+emails present (footnote markup leaks) |
| 15 | arxiv.org/pdf/1706.03762 | F(throw) | **A-** | pdf | 1.0 | 39.2 | – | full text incl. authors, tables; some line-wrap artifacts |
| 16 | news.ycombinator.com/ | A- | **A-** | article | 0.96 | 13.4 | – | unchanged, still all 30 stories |
| 17 | developer.mozilla.org/…/fetch | B+ | **A-** | article | 0.38 | 6.5 | 5/5 | fences now have `js`, banner/stray-label junk gone |
| 18 | nodejs.org/api/fs.html | B | **A-** | article | 0.93 | 396.6 | 104/105 | fences carry `mjs`/`console`/`js`, no trailing `#` |
| 19 | doc.rust-lang.org/book/ch01-01… | B | **A-** | article | 0.97 | 5.9 | 9/11 | `console`/`powershell` kept, keyboard-shortcut junk gone |
| 20 | old.reddit.com/r/programming/ | F | **F** (mitigated) | full-page | 1.0 | 0.02 | – | still 20B "Skip to main content"; `format.ts` would add `warning: final URL looks like a login/consent page` (final URL is `/login/?...`) but `extract`/`fetchPage` alone give no signal |
| 21 | tc39.es/ecma262/ | C | **A-** | article | 0.95 | 2163 | 58/60 | 7.6MB fetched (under 10MB cap), not truncated, 5.3s, clean fences |
| 22 | example.com | A | **A** | full-page | 1.0 | 0.16 | – | unchanged |
| 23 | münchen.de | D | **D** (mitigated) | article | 0.02 | 0.25 | – | still a 251B mis-pick; `format.ts` would add `warning: …produced almost no text — likely a login wall…` (message is misleading here, but the flag fires) |
| 24 | anthropic.com/news | B- | **A-** | full-page | 0.60 | 3.3 | – | "Skip to main content" junk gone, cards intact |

**raw:true comparison**
- **#9 yahoo.co.jp**: article mode keeps 1.7KB/0.09 kept-ratio (thin, wrong pick); `raw:true` gives 15.2KB full-page with real portal content (nav, trending topics, search suggestions) — raw is a strict improvement here, exactly the escape hatch the header's `extracted: 9%… use raw=true` line points to.
- **#16 HN**: article 13.4KB/181 lines vs raw 14.5KB/189 lines — same 30 stories in both; raw only adds the top nav bar (`new | past | comments | ask | show | jobs | submit`, `login`). Matches documented behavior: raw never loses content vs article mode.

## 3. Remaining problems (priority order)

1. **Readability still mis-picks thin regions on some pages, silently in isolation** (old P3, `#9` yahoo.co.jp keptRatio 0.09, `#23` münchen.de keptRatio 0.02) — `extract()` alone still returns junk here. This is now *mitigated*, not fixed: `format.ts` (not exercised by `fetchPage`/`extract` directly, verified by reading source) adds `extracted: N% of page text (article) — use raw=true if something is missing` whenever `keptRatio < 0.9`, and for münchen.de additionally fires `warning: …produced almost no text — likely a login wall or a page that needs JavaScript` (message is misleading for this case — it's a Readability mis-pick, not a login wall — but the signal is correct). A model that heeds the warning and retries with `raw=true` gets good content (verified for yahoo.co.jp). Real fix would still need a per-site heuristic or lower `MIN_KEPT_RATIO` trust when `mainContentRegion` picks a landmark that itself contains mostly nav (both sites likely have a `<main>`/role=main wrapper covering the visible chrome, which short-circuits the `region !== undefined` trust bypass in `extractHtml`).
2. **old.reddit.com login wall still returns 20 bytes with zero content** (`#20`, unchanged from before) — again mitigated only at the `format.ts` header layer (`warning: final URL looks like a login/consent page`, confirmed by final URL `https://old.reddit.com/login/?reason=lor2&dest=…`), not fixed at the extraction layer. No `note`/`via:` line from `fetchPage` itself.
3. **go.dev code fences have no language** (`#5`, 0/10) — code is now fenced (fixed the P1 defect), but go.dev's `<pre>` blocks carry no class/lang hint in the source HTML, so there is nothing left to recover; this is a source limitation, not a regression.
4. **arXiv abstract author block is a run-on paragraph** (`#14`) — all 8 authors, affiliations and emails are present (up from zero), but LaTeX footnote markup (`††thanks:`, `11footnotemark: 1`) leaks inline and everything is one dense paragraph instead of a clean author line. Cosmetic, not a content-loss defect anymore.
5. **PDF text has word-wrap/line-break artifacts** (`#15`) — e.g. "in / my / opinion / ." each on its own line near figure captions. Expected for naive PDF text extraction; still far better than the prior hard throw.

## 4. Regressions (things worse than before)

None found. Every URL that changed grade moved up or stayed flat; no case lost content, gained junk, or leaked raw HTML/markup that wasn't there before. Specifically checked and ruled out:
- `raw:true` output for `#9`/`#16` adds only legitimate nav content, no new junk.
- No `extracted:`/`via:`/error-dump noise appears *inside* the markdown bodies themselves (that formatting lives in `format.ts`'s header, outside what `extract()` returns, so it can't contaminate the saved `.md` files this harness wrote).
- Wikipedia (`#7`) links now point at `/w/rest.php/v1/page/…` REST-API-shaped URLs instead of plain `/wiki/…` paths (byproduct of the Parsoid rewrite) — uglier, still resolvable, not counted as a regression since the alternative (10/11 headings and dozens of `[edit]` links) was strictly worse.

## 5. Evidence paths

All saved outputs under `/Users/hoangta/.pi/agent/extensions/web-fetch-review/qa-after/`:
`01-docs.python.org.md` … `24-www.anthropic.com.md`, plus raw variants `25-www.yahoo.co.jp-raw.md`,
`26-news.ycombinator.com-raw.md`, and `results.json` (full per-case metadata: status, contentType,
charset, rawBytes, truncatedAtBytes, mdBytes/Lines, mode, keptRatio, fence counts, note, ms, error).
Harness source: `<scratch>/qa-after.mts`. Raw console log: `<scratch>/qa-after.log`.
