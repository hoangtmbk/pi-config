# Final fix wave — `fidelity` (fdf15f1 → HEAD)

One wave of fixes closing the four **Important** findings of `final-review.md`, the Minors the review
called trivial, and the controller's ruling on the `extracted:` floor. No new dependencies, no regex
over produced markdown, all pre-existing tests still green.

Verification (run at the end of the wave, from the repo root):

```
$ npx tsc --noEmit
(no output)

$ npm test
# tests 234
# suites 50
# pass 234
# fail 0
# duration_ms ~900
```

Baseline was 214 tests; 20 were added, none removed. Two format assertions were re-pointed by the
`extracted:` ruling (documented under Ruling below) — no other assertion was touched.

---

## Important 1 — `extract.ts` refused text bodies `fetch.ts` accepted

**Change.** The "which extractor does this body belong to" decision now exists once, in `fetch.ts`,
and is carried on the page:

- `fetch.ts:70-108` — `PageKind = "html" | "json" | "pdf" | "text"` and `classifyPage(contentType, body)`,
  exported. HTML/JSON by declared type; the HTML sniff (moved here from `extract.ts`) now runs for
  *every* type that declared nothing usable (absent, `application/octet-stream`, vendor types), not
  only for the empty one; everything else that survived the binary gate is `text`.
- `fetch.ts:129-130` — `FetchedPage.kind`.
- `fetch.ts:551-561` — set once in `fetchPage`; the gate's `pdf` verdict wins over the header, so an
  `application/octet-stream` `.pdf` is `kind: "pdf"`.
- `extract.ts:36` — the second, narrower `TEXT_TYPE_PATTERN` deleted.
- `extract.ts:997-1020` — `extract()` routes on `page.kind` only. The `Cannot extract text from "<type>"`
  throw is gone: nothing binary can reach this function.

**Covering tests.**
- `tests/extract-unit.test.ts:564-594` — `application/octet-stream`, `application/ecmascript`,
  `application/x-ndjson` and a missing type with a text body all extract as `mode: "text"`; an
  octet-stream body that *is* HTML still parses as HTML; a `text/plain` body containing tags is not
  sniffed into HTML (a declared text type is believed).
- `tests/fetch.test.ts:326-340` — `page.kind` recorded end to end against the live `node:http` server
  for six type/body combinations.

**Repro, before → after** (probe against the real `extract()`):

```
before: THROW application/octet-stream -> Cannot extract text from "application/octet-stream"
after:  OK    application/octet-stream -> mode=text "plain text body, 25 bytes"
        OK    application/ecmascript   -> mode=text "plain text body, 25 bytes"
        OK    application/x-ndjson     -> mode=text "plain text body, 25 bytes"
```

## Important 2 — `<form>` subtrees deleted, and the loss was invisible in `keptRatio`

**Change.**
- `extract.ts:481-497` — `form` is no longer removed. The interactive controls
  (`input, select, textarea, button`) are removed document-wide, then each `<form>` is unwrapped and
  its children kept in place.
- `extract.ts:462-470,477` — cleanup split: `stripInvisible` (`script, style, noscript, template`)
  from the rest of `stripNonContent`.
- `extract.ts:802-812` — the `keptRatio` denominator is now measured *between* the two: after
  scripts/styles (whose bodies would swamp it) and before every pass that can delete text a reader
  wanted. DOM-cleanup losses are therefore visible in the `extracted:` line; previously the WebForms
  case reported 100% while returning nothing.
- `extract.ts:756-770` — `adoptStrayNodes` made idempotent (it now runs twice on the HTML path; the
  body it creates is itself a document child, and adopting it into itself throws in linkedom).

**Covering tests.**
- `tests/extract-unit.test.ts:595-617` — a WebForms-shaped page (whole body inside one `<form>`)
  yields its heading and its prose, and drops the `input`/`select`/`textarea`/`button` values.
- `tests/extract-unit.test.ts:619-637` — cleanup losses move the ratio (`< 0.9`) while script text
  stays out of the denominator (`> 0.5`); the arithmetic is spelled out in the test.

**Repro, before → after:**

```
input : <h1>T</h1><form><p>Body text inside a form that matters a lot…</p></form>
before: "# T"                                          mode=full-page keptRatio=1.00
after : "# T\n\nBody text inside a form that matters…" mode=full-page keptRatio=1.00
```

## Important 3 — heading-control removal deleted anchors carrying visible text

**Change.** `extract.ts:508-537,578-600`. `HEADING_CONTROL_SELECTOR` is split:

- `.mw-editsection` and `.mw-jump-link` stay document-wide (the `[edit]` control sits *beside* the
  `<h2>`, inside `div.mw-heading` — the whole point of the Wikipedia fix).
- `a.headerlink, a.anchor` are removed only when the label is empty or glyph-only
  (`ANCHOR_LABEL_PATTERN`: `#`, `¶`, `§`, `🔗`, ZWSP, BOM, whitespace), or when the anchor is inside a
  heading that says something else too (mkdocs wraps the heading's own words in the anchor, so an
  anchor that *is* the whole heading is kept).
- Anything else is left alone; `cleanLinks` already removes empty anchors and unwraps href-less ones,
  so a prose anchor keeps both its label and its link.

**Covering tests.** `tests/extract-unit.test.ts:639-664` (prose labels survive) plus the existing
heading-debris table at `tests/extract-unit.test.ts:246-283` and `tests/fidelity.test.ts:236` — both
still green, so Sphinx `¶`, GitHub `#` and Wikipedia `[edit]` debris is still stripped.

**Repro, before → after:**

```
input : <p>See <a class="anchor" href="/x">the linked docs</a> for more, plus
         <a class="headerlink" href="/y">important text</a>.</p>
before: "See for more, plus ."
after : "See [the linked docs](https://example.test/x) for more, plus [important text](https://example.test/y)."
```

## Important 4 — `CODE_CHROME_CLASS_PATTERN` deleted prose whose class merely *started* with a token

**Change.** `extract.ts:432-460,498-502`. The pattern is anchored (`^…$`) and tested against one
whitespace-separated class *token* at a time via `classTokens`/`hasClassToken`. The alternatives grew
an explicit `clipboard-copy`/`clipboard-button` form and an optional `js-` behaviour prefix, so the
fixture chrome (`js-clipboard-copy` on GitHub, `copybtn` on Sphinx, `language-name` on MDN) still
matches while prose does not.

**Covering tests.** `tests/extract-unit.test.ts:666-700` — `clipboard-api-example`, `copy-link-guide`
and `language-label-explainer` keep their paragraphs; `js-clipboard-copy`, `copybtn` and the
`language-name` label are still removed and the code beside them still fences. The pre-existing
`code-block chrome removal must not touch prose` suite (`:63-98`) is unchanged and green.

**Repro, before → after:**

```
<div class="clipboard-api-example"><p>Real prose…</p></div>    before: gone   after: kept
<div class="copy-link-guide">…</div>                           before: gone   after: kept
<div class="language-label-explainer">…</div>                  before: gone   after: kept
```

---

## Ruling — `extracted:` fires under 0.6, not 0.9 (review Minor 6, ledger "defer, but tune")

`format.ts:12-22` — `KEPT_RATIO_FLOOR = 0.6`, with the measurement written into the comment.
Re-measured over the fixtures after this wave: 3 of 13 now fire (mdn 0.38, pypi 0.41, python 0.53)
where 11 of 14 fired before; github 0.65, claude-docs 0.70, wikipedia 0.73, go 0.73, react 0.85 no
longer advise a redundant `raw=true` refetch.

Tests: `tests/format.test.ts:97-120` — the two ratio assertions moved to 0.42/0.38 (they were 0.62 and
0.71, both now above the floor) and a new case asserts silence at 0.62/0.71/0.89. README `:54` and `:142-144` updated.

## Minors fixed

| Minor | Change | Test |
|---|---|---|
| 1 — `[class*="skip-to"]` substring match | `extract.ts:529-537,585-587`: whole-token `SKIP_LINK_CLASS_PATTERN`, requiring a separator after `to` (`skip-to-content`, `js-skip-to-content` match; `skip-top`, `skip-toggle`, `skip-total` do not) | `tests/extract-unit.test.ts:653-663` |
| 7 — `safeSegment` permits `.`/`..` | `format.ts:141-156`: a dots-only segment falls back, so no session id can point `scratchDir` at a parent | `tests/format.test.ts:301-305` |
| 14 — README Wikipedia example URL | `README.md:33-40`: the header example now shows `…/api/rest_v1/page/html/Transformer_(deep_learning_architecture)` (matching `rewrite.ts:126` and the README's own table) and the temp-file name `tempFileName` actually produces for it; both were computed by running `rewriteUrl` + `tempFileName`, not written by hand | `tests/rewrite.test.ts` (unchanged, already asserts the URL) |
| 14 — README reduction table drift | `README.md:11-12` (table at `:14-19`): dated as single fetches taken while building, and the Wikipedia row flagged as predating the Parsoid rewrite | — |
| 14 — README `:104` overstated the text types | `README.md:104-113`: the content-type table now says what `fetch`/`extract` actually do after Important 1, including octet-stream text and NDJSON, and states that the decision is made once in `fetch.ts` | — |
| 15 — `tsconfig.json` hardcodes a local pi path | `README.md:197,207-208`: one line in Testing saying the path must be adjusted elsewhere | — |

README also gained a line each for the new anchor, class-token and form rules (`:161-163`, `:170-171`, `:173-175`).

## Deliberately not fixed

Everything the review's Ledger triage marked **defer** stays deferred, in particular: `<pre>` in a
table cell flattened (Minor 3), sibling `<article>` selection (Minor 4), the packument dependencies
(Minor 5), `video/mp2t` (Minor 8), non-`WebFetchError` escapes (Minor 9), abort during extraction
(Minor 10), `raw` vs the automatic fallback in `details.mode` (Minor 11), exactly-10 MB truncation
flag (Minor 12), the duplicated `"10 MB"` literal (Minor 13), the `extract.ts` split (Minor 16), the
test seams in `FetchOptions` (Minor 17), and `![alt]` (Minor 18). Minor 2 (`<aside>` prose in the
full-page fallback) is left as the review recommended — it is signalled by the ratio, and hoisting
link-free asides is a behaviour change worth its own decision.

---

## Re-review patch (second wave)

Two regressions the first wave introduced, both reported by the re-review and fixed with no other
changes. `npx tsc --noEmit` clean, `npm test` → **237/237 pass** (3 tests added).

### R1 (Important) — the HTML sniff reached types that had declared themselves

The first wave gated the sniff on `!TEXT_TYPE_PATTERN.test(contentType)`, and `fetch.ts`'s pattern is
narrower than the `extract.ts` one it replaced (no `x-sh`, `typescript`, `x-javascript`, `x-toml`,
`x-ndjson`). A `.ts` file containing `a < p`, a JSX sample, an HTML heredoc in a shell script or a
JSONL dump quoting `<div>` was therefore handed to Readability+Turndown instead of being passed
through verbatim — contradicting the comment right above it.

- `fetch.ts:66-75` — `TEXT_TYPE_PATTERN` re-absorbs the alternatives the deleted `extract.ts` pattern
  had: `(x-)?javascript`, `(x-)?typescript`, `x-sh`, `(x-)?toml`, `(x-)?yaml`, plus `x-ndjson`.
- `fetch.ts:95-111` — the sniff is now gated on `contentType === "" || contentType === "application/octet-stream"`,
  exactly the two ways a server declares nothing, which is what the comment always claimed.

Tests, `tests/extract-unit.test.ts:604-627`:
- `application/typescript` with `const a = 1 < p; // <div>` extracts as `mode: "text"`, byte for byte;
  same for `application/x-javascript` (JSX), `application/x-sh` (heredoc), `application/x-toml` and
  `application/x-ndjson` with an embedded `"<div>"` string.
- `""` and `application/octet-stream` carrying `<html>…` still sniff to HTML (`# Sniffed`).

### R2 (Minor) — `raw` inherited the new pre-cleanup ratio denominator

`extract.ts:880-884` — `keptRatio: raw || !pageChars ? 1 : …`. `raw` converts the whole body by
definition; dividing by the pre-cleanup denominator made a chrome-heavy page report ~0.5 on a `raw`
call, and the header then advised "use raw=true" to a caller already using it.

Test: `tests/extract-unit.test.ts:341-359` — a page firing every cleanup rule (jump link, skip-to nav,
`.mw-editsection`, `copy-button`, a `<form>` with controls) returns `keptRatio === 1` under `raw`,
with the form's prose intact.
