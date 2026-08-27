# Final whole-branch review — `fidelity` (29c0230..fdf15f1)

Reviewer: senior code review, read-only. Verified locally: `npm test` → **214/214 pass**, `npx tsc --noEmit` → clean,
working tree clean at `fdf15f1`. All behavioural claims below were reproduced by running the branch's real
`extract()` / `fetch()` (probe scripts run out of a scratch dir; nothing in the repo was modified).

Files read whole: `index.ts`, `fetch.ts`, `format.ts`, `extract.ts`, `rewrite.ts`, `renderers.ts`, `pdf.ts`,
`README.md`, `test.ts`, `tests/*.ts` (structure + helpers), plus pi 0.84.3 `dist/core/tools/truncate.{d.ts,js}`
and `dist/core/extensions/types.d.ts` for API verification.

---

## Strengths

- **The central defect class is genuinely gone.** There is no markdown post-processing left at all (`cleanMarkdown`
  and every regex in it are deleted); the only string operation on the finished markdown is `.trim()`. Every cleanup
  is a DOM pass in `cleanDocument` (`extract.ts:699-708`). C1 is fixed at the cause, not patched.
- **The `pre` rule is the right design.** `flattenPreBlocks` (`extract.ts:196-205`) runs *before* Readability so the
  code is a single text node it cannot restructure, and re-stamps the detected language so the rule no longer depends
  on wrapper elements surviving. `preBlock` (`extract.ts:213-227`) returns the text raw, bypassing Turndown's escaper,
  and sizes the fence to outrun any backtick run inside. That is a complete answer to H1/H2/P1/P2/P8.
- **The Wikipedia heading investigation went to the actual cause** — `_cleanConditionally` deleting `div.mw-heading`
  because of the `[edit]` link's link density — and the fix removes the control first (`extract.ts:509-526`). The
  comment explaining it is the best in the codebase.
- **Comment quality throughout is exceptional and load-bearing**: nearly every non-obvious constant explains the real
  page that motivated it (`CODE_CHROME_CLASS_PATTERN`'s "a bare `copy` was tried and is wrong", `DETACHED_GLYPH_PATTERN`'s
  `C#`/`F#`, `hoistCodeAsides`' Sphinx sidebar, `scratchDir`'s `moduleCache: false`). A future maintainer will not
  re-break these.
- **Tests are real, not mocks.** `tests/fetch.test.ts` drives a live `node:http` server (retry, fallback, answers
  merge, cancellation, byte ceiling, binary gate); the fidelity suite runs `extract()` over captured real pages and
  asserts content invariants (verbatim code lines, fence counts, table row counts, heading sets, no escaping inside
  fences). `format.ts` was carved out precisely so the exact header bytes are assertable (`tests/format.test.ts`).
- **`format.ts` is a clean extraction.** Pure, no I/O, `truncateHead`/`formatSize` injected — the right seam, and it
  made 30 header assertions cheap.
- **Error paths are careful**: one deadline composed across up to four requests (`fetch.ts:415-416`), body-read aborts
  mapped to `Cancelled:` / `Timed out after 30s:` (`fetch.ts:419-427,499-501`), error bodies capped at 64 KB and
  de-tagged (`fetch.ts:44,325-332`), a failed temp-file save degrades to a result without a `full:` line instead of
  failing the fetch (`index.ts:141-149`).
- **pi API usage verified correct**: `firstLineExceedsLimit` really does return `content: ""` (truncate.js:66-79) and
  `index.ts:130-135` handles it; `session_shutdown` reasons are exactly `quit|reload|new|resume|fork`
  (types.d.ts:480) and the README table matches; `DEFAULT_MAX_LINES = 2000`, `DEFAULT_MAX_BYTES = 50 * 1024`; the
  saved file holds the markdown only, so `offset=outputLines+1` lines up exactly with what was shown.

---

## Plan alignment

### Phase 1 — information loss

| # | Item | Where | Status |
|---|---|---|---|
| 1.1 | Delete `cleanMarkdown` regexes; DOM-level link cleanup | regexes gone; `cleanLinks` `extract.ts:421-434` | Done |
| 1.2 | Universal `<pre>` → fence with language | `extract.ts:213-227`, `fenceLanguage` `:102-129` | Done (adds `<pre lang=>`, `brush:`, `sourceCode`, `hljs` whitelist) |
| 1.3 | `keepClasses: true` | `extract.ts:747` | Done |
| 1.4 | Per-line `<div>`/`<br>`/`<span>` code | `preText` `extract.ts:144-184`, flattened pre-Readability `:196-205` | Done |
| 1.5 | Tables: only nested/1-row/1-column unwrapped | `isLayoutTable` `extract.ts:344-348`, `dataTable` `:283-328` | Done; caption + colspan handled |
| 1.6 | Main-content region, kept ratio, always report | `mainContentRegion` `:645-658`, ratio `:757`, header `format.ts:96-101` | Done (see Minor 6 on the 0.9 floor) |
| 1.7 | Wikipedia `[edit]`, `#`/`¶`/ZWSP, demoted h2 | `cleanHeadings` `extract.ts:521-548` | Done (see Important 3 on scope) |
| 1.8 | Body-less HTML | `adoptStrayNodes` `extract.ts:682-691` | Done |
| 1.9 | `<meta charset>` sniff | `decodeBody` `fetch.ts:268-276` | Done |

### Phase 2 — robustness & coverage

| # | Item | Where | Status |
|---|---|---|---|
| 2.1 | Markdown-first `Accept`, pass `text/markdown` through | `fetch.ts:31`; `extract.ts:922` (`^text/`) | Done |
| 2.2 | One plain-UA retry on 401/403/429/503; no `sec-ch-ua` | `fetch.ts:36,449-456,435-441` | Done |
| 2.3 | URL rewrites (6 rules) + reported | `rewrite.ts` whole; `fetch.ts:458-471`; `format.ts:65-69` | Done, all six + fallback |
| 2.4 | PDF via `unpdf`, bounded | `pdf.ts`; `extract.ts:876-908` | Done, 200-page cap, cut-at-10 MB warning |
| 2.5 | Error quality | `fetch.ts:139-156,318-332,419-427,503-505`; `format.ts:103-112` | Done |
| 2.6 | Content-type gate before download + sniff | `fetch.ts:296-316,489-494,507-510` | **Partial — see Important 1** |
| 2.7 | `Accept-Language`; no https upgrade for `host:port`; keep `ref`/`source`/`si` | `fetch.ts:33,171-179`; `extract.ts:43` | Done |
| 2.8 | toolCallId naming, unconditional mkdir, `firstLineExceedsLimit` | `format.ts:150-163`; `index.ts:77`; `index.ts:130-135` | Done |
| 2.9 | Header polish + untrusted-data label | `format.ts:56-118` | Done |
| 2.10 | `promptGuidelines` | `index.ts:104-108` | Done |

### Phase 3 — tests

Fixture suite (`tests/fidelity.test.ts`, 12 fixtures), unit suites for extract/fetch/format/rewrite/renderers/pdf/charset,
live runner kept opt-in (`test.ts`, 9 content + 5 error cases — matches README:191-194 and still runs: it uses the
current `fetchPage(url, undefined, {allowPdf:true})` / `extract(page, raw)` signatures). Headless e2e was run by the
implementer; not re-run here.

### "Deliberately NOT adding" — respected

No `prompt`/summarizer, no browser, no `start_index`, no automatic third-party fallback (and no `via` param either),
no robots.txt, no private-IP blocking, no multi-URL/search/auth/cookies, no link-index/outline mode, no caching, no
Defuddle/jsdom/mdream. Dependencies added: **`unpdf` only** (plus dev-only `tsx`, `typescript`, `@types/*`) —
exactly what the plan allowed (`package.json:16-27`).

### Original findings → where fixed

| Finding | Fixed at | Note |
|---|---|---|
| C1 code-corrupting regexes | deleted; DOM cleanup `extract.ts:699-708` | Verified by `code-regex` fixture |
| H1 bare `<pre>` unfenced/escaped | `extract.ts:213-227` | |
| H2 fence language lost | `extract.ts:747` + `fenceLanguage` | |
| H3 td-only tables flattened | `extract.ts:344-348,283-328` | Ruling: first row = header |
| H4 text types refused | `fetch.ts:67-68` broadened | **Not complete: `extract.ts:40-41` still refuses — Important 1** |
| M1 abort during body read | `fetch.ts:419-427,496-501` | |
| M2 `fetch failed` hides cause | `describeFailure` `fetch.ts:139-156` | |
| M3 binary downloaded then refused | `fetch.ts:489-494` | |
| M4 `<meta charset>` ignored | `fetch.ts:242-276` | |
| M5 10 MB cut silent | `truncatedAtBytes` `fetch.ts:520` → `format.ts:103` | |
| M6 `firstLineExceedsLimit` | `index.ts:128-135`, `format.ts:75-82` | |
| M7 counter resets on `/reload` | `tempFileName` `format.ts:150-163` | |
| M8 mkdir race | `index.ts:76-77` | |
| M9 `ref`/`source`/`si` stripped | `extract.ts:43` | |
| M10 partial extraction silent | `keptRatio` + `extracted:` line | |
| M11 `host:port` upgraded to https | `fetch.ts:171-179` | |
| L2/L3/L4/L9/L10/L12 | `fetch.ts:31`, `:224-232`, `:44`, `index.ts:178-181`, details slimmed, README rewritten | Done although out of plan |
| L7 h1→h2 demotion, L14 `![alt]` invalid markdown | not addressed | Out of plan; `extract.ts:235` still emits `![alt]` |
| QA P1–P10, P12, P13(headings) | as above | |
| QA P11 (arXiv `citation_author`) | not addressed | Out of plan |
| QA P13 (mdBook/VitePress junk), P14 (fragment→line), P15 (10 MB perf) | not addressed | Out of plan — plan chose not to |

---

## Issues

### Critical

None. No path was found that corrupts code, mis-reports truncation, loses the saved file, or exposes a security
boundary. (SSRF is intentionally allowed; redirects to non-http(s) schemes are rejected by undici before they reach
this code; URLs are `URL`-normalised before they reach `fetch`, so no header injection.)

### Important

**1. `extract.ts` refuses text bodies that `fetch.ts` deliberately accepted — the two `TEXT_TYPE_PATTERN`s diverge.**
`fetch.ts:67-68` accepts a wide text set and, for unknown types, sniffs the first 1 KB and *keeps* anything that reads
as text (`fetch.ts:296-316,507-510`). `extract.ts:40-41` then applies a narrower list and `extract.ts:948-951` throws
`Cannot extract text from "<type>"`. Verified end to end with a plain-text body:

```
THROW application/octet-stream  -> Cannot extract text from "application/octet-stream" (25 bytes)
THROW application/ecmascript    -> Cannot extract text from "application/ecmascript"
THROW application/x-ndjson      -> Cannot extract text from "application/x-ndjson"
```

`application/octet-stream` with a plain-text body is one of the exact cases H4 named ("raw files on many hosts"), and
the branch downloads it, decodes it, and then throws it away. This is the ledger's deferred "duplicated divergent
TEXT_TYPE_PATTERN" item, and it is a functional gap, not cosmetics. One-line fix: at `extract.ts:934`, treat *any*
type that reached this point the way the empty-type branch is treated (sniff for HTML, else pass through as text) —
the fetch layer has already refused everything binary, so nothing else can arrive here.

**2. `stripNonContent` deletes `<form>` subtrees, so content inside a form is silently lost.**
`extract.ts:456-461` removes `form` (and `button`) document-wide. Verified:

```
input : <h1>T</h1><form><p>Body text inside a form that matters a lot…</p></form>
output: "# T"      mode=full-page   keptRatio=1.00
```

Note the reported ratio: **1.00**, because `pageChars` (`extract.ts:738`) is measured *after* `cleanDocument` — so
DOM-cleanup losses are invisible to the `extracted:` line and the model gets no signal at all. Classic ASP.NET
WebForms wraps the entire page body in one `<form runat="server">`; those pages now return nothing (the caller sees
"No readable content … may require JavaScript", `index.ts:117-120`, which is the wrong diagnosis). Pre-existing
(`29c0230:extract.ts:47` had the same filter), but the branch's stated goal 1 is exactly this. Fix: unwrap `<form>`
(keep its children) and drop only its controls (`input, select, textarea, button`).

**3. Heading-control removal is document-wide and deletes anchors that carry visible text.**
`extract.ts:475` `HEADING_CONTROL_SELECTOR = ".mw-editsection, a.headerlink, a.anchor"` is applied at
`extract.ts:522-526` to the whole document, not to headings. An `<a class="anchor">` or `<a class="headerlink">` in
prose is removed **with its text**. Verified:

```
input : <p>See <a class="anchor" href="/x">the linked docs</a> for more, plus
         <a class="headerlink" href="/y">important text</a>.</p>
output: "See for more, plus ."
```

Fix: scope the query to inside `HEADING_SELECTOR` elements (the loop at `:528` already walks headings), or require
`textContent.trim()` to be empty/glyph-only. `cleanLinks` already removes empty anchors, so nothing is lost by
tightening this.

**4. `CODE_CHROME_CLASS_PATTERN` deletes prose sections whose class merely *starts* with a control token.**
`extract.ts:446-447` allows `[\s_-]` on both sides of the token, so `clipboard-api-example`, `copy-link-guide` and
`language-label-explainer` all match and the element is removed unless it contains a `<pre>` (`extract.ts:463-468`).
Verified — each of these lost its whole paragraph:

```
<div class="clipboard-api-example"><p>Reading from the clipboard requires permission…</p></div> → gone
<div class="copy-link-guide">…</div>                                                            → gone
<div class="language-label-explainer">…</div>                                                   → gone
```

These are plausible class names on precisely the docs pages a coding agent fetches. The Task-2 review already
narrowed this once (bare `copy` → prose loss); it is still one step too loose. Fix: match whole class *tokens*
(`(class ?? "").split(/\s+/)` against an anchored pattern/Set) instead of allowing `-`/`_` continuation.

### Minor

1. **`[class*="skip-to"]` is a substring match** (`extract.ts:478`) — `class="skip-top"`, `skip-toggle`, `skip-total`
   are removed with their subtree (verified: `<p class="skip-top">Real prose…</p>` disappears). Use a token match.
2. **`stripChromeRegions` drops `<aside>` prose in the full-page fallback** (`extract.ts:570,579-581`). `hoistCodeAsides`
   rescues asides holding code, but a docs "note"/"warning" callout in an `<aside>` is deleted. Ratio does drop
   (measured 0.15 on a synthetic case), so it is at least signalled. Consider hoisting asides with no links at all.
3. **`<pre>` inside a data-table cell is flattened to one line** — `dataTable`'s cell render collapses newlines to a
   space (`extract.ts:292-297`). Ledger item; API reference tables with code samples lose line structure. `<br>` in
   the cell would preserve it.
4. **Sibling `<article>`s: only the largest survives** (`mainContentRegion` `extract.ts:645-658`). On a page with
   several full articles the rest are dropped in both the article and the full-page-fallback paths; only the
   `extracted:` percentage hints at it.
5. **npm packument renderer drops the latest version's dependencies** (`renderers.ts:106-114` returns dependencies
   only for the single-version document). "What does this package depend on" is unanswerable from the packument path.
6. **The `extracted:` line fires on almost every real page.** Measured `keptRatio` over the 14 fixtures: 11 of 14
   article results are below the 0.9 floor (`format.ts:13`) — mdn 0.38, pypi 0.42, python 0.53, github 0.66, go 0.73,
   wikipedia 0.74, claude-docs 0.72. Advising "use raw=true if something is missing" on nearly every fetch invites
   redundant double fetches. Ledger flagged it as tunable; 0.65–0.7 would fire on the cases that mean it.
7. **`safeSegment` permits `.` and `..`** (`format.ts:133-140`), so a pathological session id would make
   `scratchDir` resolve to the parent and `rm(dir, {recursive:true})` (`index.ts:90`) delete a sibling tree. Not
   reachable today (pi's `getSessionId()` is a uuid) but a two-character guard is cheap.
8. **`video/mp2t` is refused before download** (`fetch.ts:56`) — H4 explicitly named it as how static servers label
   `.ts` source files. Following the plan's binary-family rule, so a deviation from the review, not from the plan.
9. **A non-`WebFetchError` can escape `execute`**: `await import("./pdf.ts")` (`extract.ts:882`) if `unpdf` is missing,
   and `parseHTML`/`turndown` internals on a pathological document. pi still marks the result as an error, but the
   message is a stack-flavoured one.
10. **`extract`/`turndown`/`pdfToText` ignore the abort signal.** The 30 s deadline covers HTTP only; a 10 MB page
    spends ~13 s in linkedom+Readability+turndown (QA P15) with Esc doing nothing. Out of plan, worth knowing.
11. **`raw: true` is indistinguishable from an automatic full-page fallback** in `details.mode` and the TUI line
    (`index.ts:210`, `extract.ts:794`) — both say `full-page`. A `mode: "raw"` (or a boolean in details) would make
    transcripts readable.
12. **Exactly-`MAX_BODY_BYTES` bodies are flagged truncated** (`fetch.ts:209` exits the loop before `done`), so a
    10.00 MB page gets `warning: body cut at 10 MB` it did not deserve. Ledger item.
13. **`"10 MB"` is a literal in `format.ts:103` and `extract.ts:861,885`, duplicated from `MAX_BODY_BYTES`**
    (`fetch.ts:41`). Ledger item; three places to change.
14. **README numeric/example drift** (docs are otherwise accurate — every other number I checked matches the code:
    2000/50 KB, 200 pages, 10 answers, 40%/40%/200 chars, 90% floor, shutdown-reason table, `Accept` string,
    9 live URLs + 5 error cases):
    - `README.md:35` and `:38` show `…/w/rest.php/v1/page/Transformer_%28deep_learning%29/html` and a temp file named
      `…-en.wikipedia.org-html.md`, but `rewrite.ts:126` produces `…/api/rest_v1/page/html/{Title}` (which the README's
      own table at `:127` states correctly) — and `tempFileName` would then use the *title* as the slug, not `html`.
    - `README.md:13-18` "Measured reduction" table is pre-branch: it reports the Wikipedia article at 137 KB of
      markdown while the header example at `:37` says 189.8 KB for the same page.
    - `README.md:104` "`text/*`, YAML, XML, source files | Passed through unchanged" overstates what `extract.ts`
      accepts — see Important 1.
15. **`tsconfig.json:14-24` hardcodes this machine's absolute pi path**, so `npm run typecheck` works for no one else.
    The plan explicitly sanctioned it ("local-only"); worth a one-line comment in the README's Testing section.
16. **`extract.ts` is 952 lines** and now carries seven distinct concerns (language detection, pre flattening, tables,
    link/heading/chrome cleanup, region selection, JSON routing, PDF routing). Not urgent — the module is coherent
    and well-commented — but a `dom-clean.ts` / `tables.ts` split is the obvious next move if it grows again.
17. **Test seams in the production interface**: `FetchOptions.rewrite` and `timeoutMs` (`fetch.ts:102-112`) exist only
    for tests. Both are documented as such and harmless; noted for the record.
18. **`![alt]` is still not valid markdown** (`extract.ts:235`, review L14) — it renders literally. `*alt*` or
    `![alt]()` would render. Out of plan.

---

## Ledger triage

| Ledger item | Verdict | Why |
|---|---|---|
| T1: report mislabels `cache_control` count | defer | Report artefact, not code. |
| T1: tsconfig adds `skipLibCheck` | defer | Justified; pi's own d.ts is not our problem. |
| T4: divergent `TEXT_TYPE_PATTERN` (ecmascript accepted then refused) | **fix before merge** | It is broader than ecmascript: octet-stream/NDJSON text is fetched then thrown away (Important 1). |
| T4: 4xx body read before the binary gate (mojibake in error) | defer | Affects only the 300-char error blurb; capped at 64 KB. |
| T4: `WebFetchError` lacks `cause` | defer | `describeFailure` already puts the code in the message. |
| T4: no assertion of the default "30s" message text | defer | Timeout mapping is tested with an injected timeout. |
| T4: exactly-10 MB body flagged truncated | defer | One spurious warning line at an exact boundary (Minor 12). |
| T4: 50 ms sleep in the cancel test | defer | Test-suite hygiene; suite runs in ~1 s. |
| T2: `restoreLeadHeading` chrome guard is only header/nav/footer/aside | defer | Worst case is one extra `# Site name` line; tested for the common case. |
| T2: `headingText` does not decode entities | defer | Worst case is a duplicated lead heading. |
| T2: entity/whitespace dup check is a regex over the HTML string | defer | Same blast radius as above. |
| T3: README table sentence stale | done | `README.md:149-152` now matches `isLayoutTable`. |
| T3: python-asyncio `p.sidebar-title` "Hello World!" label lost | defer | One label; the code it titles is preserved (that was the point of `hoistCodeAsides`). |
| T5a: `renderers.ts` 178 lines | defer | Cohesive; 192 now. |
| T5a: `{lang}.m.wikipedia.org` not rewritten | defer | Mobile URLs still fetch and extract normally. |
| T3 ruling: `#`/`¶` stripped only when detached (C# stays) | defer (accept) | Correct trade; covered by `extract.ts:236-283` tests. |
| T3 ruling: `raw` = whole body, chrome strip only in the auto fallback | defer (accept) | Consistent across code, README:28-29 and the tool description. |
| T3: sibling `<article>` selection can drop the second article | defer | Minor 4; signalled by `extracted:`. |
| T3: `MAX_COLSPAN=32` untested | defer | Guard only; wrong behaviour is bounded padding. |
| T3: `META_CHARSET` comment wrong + decoy match | defer | A decoy needs `charset=` inside an earlier `<meta content=…>`; rare, and the fallback is utf-8. |
| T3: `<pre>` in a table cell flattened | defer | Minor 3; fixing well means `<br>` in cells. |
| T3: `extract.ts` ~820 (now 952) lines | defer | Minor 16 — split when it next grows. |
| T5b: 2xx-but-placeholder rewrite wins (fallback gated on `!ok`) | defer | README:118-120 states the rule; a content check would be guesswork. |
| T5b: `attachAnswers` mutates `FetchedPage` | defer | Local, documented (`fetch.ts:367-407`), tested. |
| T6: `renderResult` bytes-only branch untested | defer | `index.ts` is not unit-testable without a pi harness; the branch is 3 lines. |
| T6: `extracted:` fires often (0.9 tunable) | defer, but tune | Minor 6 — measured 11/14 fixtures; recommend 0.65–0.7 now. |
| T6: `"10 MB"` literal duplicated in `format.ts` | defer | Minor 13. |
| T6 round 2: README:120 `note:` → `via:` | done | Verified in `fdf15f1`. |
| T6 ruling: `full:` line right after the size line | defer (accept) | Reads as a continuation of it; tested. |
| T5 ruling: split into 5a modules + 5b wiring | defer (accept) | `rewrite.ts`/`renderers.ts`/`pdf.ts` are clean, pure and separately tested. |

---

## Recommendations

Before merge (all small, all in one commit's worth of work):

1. `extract.ts:934` — make the fallback branch cover *every* unrecognised type, not only the empty one. Add a test
   asserting `application/octet-stream` with a text body extracts as `mode: "text"`.
2. `extract.ts:458` — unwrap `<form>` instead of removing it (keep removing `input/select/textarea/button`).
3. `extract.ts:522-526` — scope `HEADING_CONTROL_SELECTOR` removal to inside headings (or to empty/glyph-only anchors).
4. `extract.ts:446-447` — match whole class tokens; same for `[class*="skip-to"]` at `:478`.
5. `README.md:35,38` — fix the Wikipedia example URL and the temp-file example to match `rewrite.ts:126`; either
   re-measure or date-stamp the reduction table at `:13-18`; soften `:104`.

Worth doing soon, not gating: tune `KEPT_RATIO_FLOOR` (Minor 6), distinguish `raw` from the automatic fallback in
`details.mode` (Minor 11), and add one Parsoid-HTML fixture — the Wikipedia rewrite means the most-cited fixture in
the suite is no longer the HTML the tool will actually see for a `wikipedia.org/wiki/…` URL.

---

## Assessment

**Ready to merge? With fixes.** The branch does what it set out to do: every Phase 1 and Phase 2 item is present,
C1/H1–H4/M1–M11 are all addressed at the cause rather than patched, the tests are real and would catch a regression,
and the code is clearer than what it replaces. The four Important findings are all the same shape — DOM cleanup
selectors that reach past their target and silently delete content, plus one content-type mismatch between two
modules that the task-scoped reviews could not see — and each is a one-line fix in `extract.ts` that directly serves
goal 1, so they are worth doing before this lands rather than after.
