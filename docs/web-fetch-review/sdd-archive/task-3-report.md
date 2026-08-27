# Task 3 report — Extraction fidelity (Phase 1.5–1.9)

Branch `fidelity`, commit `c8396f9` on top of `a9fee99`.
Files changed: `extract.ts`, `fetch.ts`, `README.md`, `tests/fidelity.test.ts`,
`tests/extract-unit.test.ts`, `tests/charset.test.ts`.

## Tests

`npm test` (node:test via tsx) and `npm run typecheck`.

| | before | after |
|---|---|---|
| tests | 73 (64 pass / 9 fail) | **95 (95 pass / 0 fail)** |
| typecheck | clean | clean |

The count grew from 73 to 95 because `tests/charset.test.ts` previously failed at
import (one failing "test") and now runs its 4 cases, plus 1 new fidelity
assertion (python-asyncio) and 17 new unit tests in `tests/extract-unit.test.ts`.

All nine original failures are fixed: `table-td-only` (3), `wikipedia-transformer`
(2), `claude-docs-prompt-caching` (2), `fragment` (1), `charset.test.ts` (4 cases).
`hn-front` was already passing and still passes — its two assertions are the
regression guard on the rewritten table rules.

Fixture modes after the change (mode, keptRatio, markdown chars):

```
python-asyncio        article 0.529  3544     hn-front              article 0.963 13633
github-readability    article 0.659  7404     mdn-fetch             article 0.384  6660
react-learn           article 0.859 15640     claude-docs-caching   article 0.723 33523
wikipedia-transformer article 0.737 134118    table-td-only       full-page 1.000   309
go-tutorial           article 0.730  6520     fragment            full-page 1.000    31
pypi-requests         article 0.419  8270
```

## What was implemented

### 1. Tables (`isLayoutTable`, `unwrapLayoutTables`, the `dataTable` rule)

Layout is now decided by *shape*, not by `<th>`: a table is layout iff it is
nested inside another table, has at most one row, or every row holds at most one
cell. Unwrapping is innermost-first and loops until stable (`for (;;)`), so each
pass judges an outer table on the rows it has left; every pass removes at least
one table, so the old `pass < 100` guard is gone with the rewrite. Unwrapping now
also carries the `<caption>` and any `<th>` cells out, which the old version
dropped.

Data tables become GFM: `<caption>` on a bold line above the table, `colspan`
padded with the empty cells it covers (clamped at `MAX_COLSPAN = 32`), cell
contents converted through the second Turndown instance so links survive, pipes
escaped, newlines collapsed to a space.

**Deviation from the brief, please read.** Brief item 1 says the header row comes
from the first row "when it has `<th>`, otherwise emit an empty-header row
(`| | | |`)". That contradicts the acceptance fixture: `table-td-only.html` has
four td-only rows and `fidelity.test.ts` asserts exactly 5 `|`-lines with the
comment "header + separator + 3 data rows". An always-empty header would produce
6. The fixture's own prose ("a data table whose header row uses td cells instead
of th cells") says the first row *is* the header. I implemented the rule that
satisfies both the fixture and the brief's `| | | |` case:

> the first row is the header row **unless `<th>` appears below the first row** —
> which means the table labels its rows, so no row is a header row and GFM needs
> an empty one to render the data at all.

So: td-only table → first row is the header (fixture passes); `<th>` header row →
header (unchanged); `<th>` in the first *column* of every row (Wikipedia
infoboxes, MDN spec tables) → `| | |` empty header and every row kept as data.
Consequently the unit test the task asked for as "2×2 td-only → GFM with empty
header row" is written as *"renders a td-only data table, its first row as the
header"*, and the empty-header case is covered by *"emits an empty header row
when the th cells label the rows"*. If the intent really was an always-empty
header for td-only tables, the fixture assertion has to change too.

### 2. Main-content selection + kept ratio

`mainContentRegion()` picks the **largest** `main, article, [role=main]` match
(not the first) whose text is ≥ 40% of the body's text. Largest matters: on
`claude-docs-prompt-caching` the first match in document order is
`main#docs-scroll-container` with 853 of 42 255 chars (2%), while the real
content is `article#content-container` with 39 055 (92%) — the first-match
reading of the brief would have left that fixture failing. When a region is
found, Readability parses a small document built from the page's `<head>` plus
that region only (`readabilityInput()`), so a large navigation tree can no longer
outscore the article.

`Extracted.keptRatio: number` (0–1) was added and is set on every return path
(1 for json/text/full-page-of-whole-body). For an article it is
`article.textContent / page text`, both whitespace-normalised, measured after
`stripNonContent`. An article result is rejected — falling through to whole-page
conversion — when it is under `MIN_ARTICLE_CHARS` **or** when `keptRatio < 0.4`
and the page never marked a content region. `index.ts` is untouched; Task 6
renders the field.

`restoreLeadHeading()` now takes the content root (`region ?? document`), so its
"first heading" search is scoped to the chosen region — the ledgered minor from
Task 1 is closed.

### 3. Doc-site junk — and the root cause of the Wikipedia heading loss

`cleanHeadings()` removes `.mw-editsection`, `a.headerlink`, `a.anchor`,
`.mw-jump-link`, `[class*="skip-to"]`, plus `a[aria-hidden="true"]` inside
headings, then strips zero-width characters (U+200B/U+FEFF) anywhere in a heading
and a trailing `#`/`¶`/zero-width run from its last text node. A heading whose
entire text is such a glyph keeps it.

**Root cause of "10 of 11 h2s dropped":** not the `div.mw-heading` wrapper, and
not `unlikelyCandidates`. Wikipedia emits
`<div class="mw-heading mw-heading2"><h2 id="History">History</h2><span class="mw-editsection">…[edit]…</span></div>`.
In `_prepArticle` → `_cleanConditionally(articleContent, "div")` that div is 13
characters of text with link density 0.31 and class weight 0, which trips two of
Readability's removal rules at once — *"Suspiciously short"* (`contentLength < 25
&& headingDensity < 0.9 && linkDensity > 0`) and *"Low weight and a little linky"*
(`weight < 25 && linkDensity > 0.2`) — and the `<h2>` inside goes with the div.
Verified against the fixture: baseline keeps 1 of 10 sections; removing
`.mw-editsection` alone keeps 10 of 10 (link density drops to 0, both rules stop
firing); unwrapping `div.mw-heading` also keeps 10 of 10 but is redundant, so it
was not implemented. The `[edit]` removal was required by item 3 anyway — it is
the same one-line fix.

`nav, header, footer, aside` are removed only on the full-page path
(`stripChromeRegions`), never in article mode, per the brief.

**Extra requirement (python-asyncio's first code example).** Main-content
selection alone did *not* fix it. Cause, traced with Readability's debug log: the
example lives in `<aside class="sidebar">`, and Readability kills it twice over —
`_grabArticle` drops it as an unlikely candidate on the class `sidebar`, and
`_prepArticle` ends with an unconditional `_clean(articleContent, "aside")` that
deletes every `<aside>` regardless of class or content. Fixed at the DOM level
with `hoistCodeAsides()`: an `<aside>` containing a `<pre>` is a worked example
rather than navigation, so it is unwrapped into the flow before Readability runs.
The fixture now yields the block as a ```python3 fence, asserted by the new test
*"keeps the first code example, the one in the Sphinx sidebar"*.

### 4. Body-less HTML

`adoptStrayNodes()` runs first thing after `parseHTML`: linkedom does no tree
fixup, so `<h1>…</h1><p>…</p>` parses into a document whose *first element* is
the document element and whose body is empty. Any top-level element children
(other than `<html>`) are moved into a real `<body>`, created if needed. The
`fragment` fixture now converts all four elements.

### 5. Charset

`fetch.ts` exports `decodeBody(buffer, headerCharset)`. Header charset wins;
otherwise the first 2048 bytes are read as latin1 (via `Buffer`, so no ICU
dependency and no byte can fail to decode) and searched for
`<meta … charset=…>` — one pattern covers both the `charset` attribute and
`http-equiv="Content-Type"`. Decodes with `TextDecoder(label, {fatal:false})`,
falling back to utf-8 for labels Node does not know. `decodeCharset` is gone;
both former call sites use `decodeBody`. The `@ts-expect-error` in
`tests/charset.test.ts` was removed as its comment instructed.

README: the charset bullet under **Robustness** now describes the `<meta>`
fallback.

## Self-review

- **No regex over produced markdown.** All new cleanup is DOM-level. The one
  regex touching markdown is the pre-existing, cell-scoped pipe-escape /
  newline-collapse inside the table rule, which GFM strictly requires (a raw `|`
  or newline in a cell changes the table's shape). Code fences are never touched.
- **Dead code.** `pass < 100` loop gone, `decodeCharset` gone, no unused symbol
  remains in either file (checked).
- **Naming/YAGNI.** `MIN_MAIN_RATIO` and `MIN_KEPT_RATIO` are both 0.4 but mean
  different things and are kept separate deliberately. The suspected
  `div.mw-heading` unwrap was dropped once the real cause was found.

## Concerns

1. **The table header rule deviates from the brief** — see item 1 above. This is
   the one place where brief and acceptance test could not both be satisfied
   literally, and it deserves a controller decision.
2. **README line 95 is now wrong** and I left it alone because the task said the
   charset sentence is the only README edit: *"A table with no `<th>` is treated
   as layout; genuine data tables become GFM tables…"*. That is exactly the rule
   this task replaced. One sentence, worth fixing in a follow-up.
3. **`hoistCodeAsides` loses the aside's own label.** On python-asyncio the code
   survives but `<p class="sidebar-title">Hello World!</p>` does not: once
   hoisted, that `<p>`'s own class matches Readability's `sidebar` unlikely-
   candidate regex. Keeping it would mean stripping classes off hoisted children,
   which would also strip the `highlight-python3` wrapper class the fence
   language comes from. Substance kept, label lost.
4. **Dropping `aside` in full-page mode is a small information-loss risk** (goal
   1) that the brief mandates. `hoistCodeAsides` runs before it, so
   code-carrying asides are safe; an aside of pure prose on a page where
   Readability already failed would not be.
5. **`readabilityInput` re-parses `<head>` + the region.** That is one extra
   parse of the head on every marked page — measurable only on huge pages, and it
   keeps the title/metadata Readability reads. Noted in case a later profile
   cares.

---

## Fix round 1 (review response)

Commit `efa018f` on top of `6eea3c1` (branch had moved: Task 5a's
`rewrite.ts`/`renderers.ts`/`pdf.ts` were merged in; none of them touched).
Files changed: `extract.ts`, `fetch.ts`, `tests/extract-unit.test.ts`,
`tests/fidelity.test.ts`.

### Finding 1 — `C#` headings were losing their `#`

`HEADING_SUFFIX_PATTERN = /[\s#¶​﻿]+$/` stripped any trailing glyph
run, so `<h2>C#</h2>` came out as `## C`. Replaced with the controller's rule,
in `cleanHeadings()`:

- `DETACHED_GLYPH_PATTERN = /\s+[#¶]+\s*$/` — a glyph run goes only when the
  text sets it off with whitespace (`Title #`, `Title ¶`).
- `GLYPH_ONLY_PATTERN = /^[#¶]+$/` — a text node that is *nothing but* glyphs is
  a permalink label and goes, unless it is the only thing the heading says
  (`<h2>#</h2>` stays a `#`).
- Zero-width characters (U+200B/U+FEFF) anywhere in the heading and trailing
  whitespace are still always stripped.
- A `#` welded to a word is content and stays.

Measured on the unit-test page, headings now render as: `C#`, `F#`, `C# #` →
`C#`, `Issue#`, `Spaced hash #` → `Spaced hash`, `Spaced pilcrow ¶` → `Spaced
pilcrow`, zero-width → stripped, `Anchored heading<a class="anchor">#</a>` →
`Anchored heading`, `Spanned heading<span>#</span>` → `Spanned heading`,
`[edit]` → gone, Sphinx `¶` → gone. An extra case asserts no heading is left
with empty text.

### Finding 2 — `raw: true` was no longer the whole page

The full-page tail ran `stripChromeRegions` and narrowed to `region ?? body`
even when the caller asked for `raw`, so an index page lost the nav links that
are its content. Now:

```ts
const source = raw ? body : (region ?? body);
if (!raw && source) stripChromeRegions(source);
```

`raw` therefore gets the entire `<body>` with only the universal cleanup
(scripts/chrome-class removal, `<pre>` flattening, link absolutising and
cleaning, heading junk, layout tables), and its `keptRatio` is 1 by
construction. Region narrowing and chrome removal now belong to the automatic
fallback alone. Fixture check: `claude-docs-prompt-caching` raw is 55 683 chars
(the "~55k full-page" figure the fidelity test comments cite) against 33 523 for
the article path; `hn-front` raw 14 464, `wikipedia-transformer` raw 239 167,
all at `keptRatio` 1.000.

### Minors (both trivial, both done)

- `fetch.ts`: the `META_CHARSET_PATTERN` comment said "the last `charset=`";
  the pattern is lazy and takes the first. Comment corrected.
- `tests/fidelity.test.ts`: `assertFenceHasLines` now finds a fence where
  `lines.every(...)` holds, instead of taking the first fence containing
  `lines[0]`, and its failure message lists every fence.

### Tests

Covering tests: `tests/extract-unit.test.ts` (34 tests, +10: 7 heading cases,
3 raw-mode cases) and `tests/fidelity.test.ts` (43 tests).

```
$ npx tsx --test tests/extract-unit.test.ts   → # tests 34  # pass 34  # fail 0
$ npx tsx --test tests/fidelity.test.ts       → # tests 43  # pass 43  # fail 0
$ npm test                                    → # tests 163 # pass 163 # fail 0
$ npm run typecheck                           → clean
```

Suite went 153 → 163 (the 10 new tests); nothing regressed.

### Left as ledgered, per the review

Multi-`<article>` sibling selection, the `MAX_COLSPAN` cap, README:95 (Task 6),
and `extract.ts`'s size. The table-header deviation described above stands as
implemented.
