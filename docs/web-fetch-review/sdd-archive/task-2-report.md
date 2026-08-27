# Task 2 report — Code-block fidelity (Phase 1.1–1.4)

Commit: `485a36d fix(extract): preserve code verbatim — DOM-level cleanup, keepClasses, universal pre rule`
(branch `fidelity`, parent `2e62505`).

## What I implemented, per brief item

**1. `cleanMarkdown()` deleted.** Both call sites now just `.trim()` the Turndown output. No regex ever
touches the markdown again. The blank-line collapse was dropped entirely (not reimplemented): measured
across all 13 fixtures, Turndown never emits a run of 3+ newlines, so the rule was buying nothing.
Trailing-whitespace stripping is gone as instructed (it destroyed `<br>` hard breaks); the residue is
~40 lines of list-indent whitespace on `go-tutorial` and single digits elsewhere.

The empty-link cleanup moved to `cleanLinks(document)`, run after `absolutizeLinks` so href-less anchors
are already marked: an `<a>` whose `textContent.trim() === ""` and that renders no image is removed; an
`<a>` with no `href` is unwrapped in place. **Deviation:** the brief says "contains no `<img>`"; I used
"contains no `<img>` with non-empty `alt`", because `imageAltOnly` renders an alt-less image as the empty
string, so the brief's literal rule leaves 20 bare `[](https://…File:….png)` links on the Wikipedia
fixture. This also turned out to fix `github-readability`'s missing headings: GitHub's empty
`a.anchor` next to each heading pushed `div.markdown-heading`'s link density over Readability's
`_cleanConditionally` threshold, and the whole wrapper (heading included) was being deleted.

**2. `keepClasses: true`** passed to `new Readability(...)`.

**3. Turndown rule `preBlock`, `filter: "pre"`,** added in `configureBase` so both the main and the
table-cell instance carry it, and added via `addRule` so it precedes both built-in code rules
(`codeBlockStyle: "fenced"` is now dead and was removed). It emits `\n\n<fence><lang>\n<code>\n<fence>\n\n`.

- Language (`fenceLanguage`): `class` on the `<pre>`, its first `<code>`, its parent, its grandparent, in
  that order; per class attribute, `languageFromClass` scans tokens for `language-x`, `lang-x`,
  `highlight-source-x`, `highlight-x`, `brush: x` / `brush:x`, `sourceCode x`, and `hljs x` (the last only
  when `x` is in a small known-language set, since that token is not reliably a language). `default`,
  `text` and `none` resolve to no language. Candidates must look like an info string (`/^[\w+#.]+$/`), which
  is what keeps GitHub's `highlight highlight-source-js notranslate position-relative overflow-auto` from
  emitting junk. **Addition beyond the brief:** `<pre lang=python>` (the `lang` attribute) is consulted
  last — it is what GitHub-flavoured markdown renders to, and it is the only language signal PyPI ships;
  ignoring it would be information loss on a target fixture.
- Body (`preText`): walks the `<pre>`'s child nodes, emitting `\n` for `<br>` and after `div`/`p`/`li`/`tr`
  and any element whose class is a per-line wrapper (`line`, `cm-line`, …), suppressed when a newline is
  already present or immediately follows. Text nodes are emitted raw, so Turndown's escaper never sees them.
  Leading newlines and trailing whitespace are trimmed; indentation is untouched.
- Fence length is one backtick longer than the longest backtick run in the body, minimum three.

**3b. `flattenPreBlocks(document)` — not in the brief, and required.** Readability rewrites markup it reads
as layout: react.dev's per-line `<div class="cm-line">` become `<p>`, and `_hasSingleTagInsideElement`
then drops the whitespace-only text nodes that hold the indentation. No Turndown rule can recover that,
because the information is gone before Turndown runs. So every `<pre>` is reduced to a single text node
(via the same `preText`) *before* Readability, with the detected language re-stamped as `class="language-x"`
on the `<pre>` so the rule no longer depends on wrapper elements surviving. `preBlock` is still needed and
still does the work in raw/full-page mode; after flattening its walk is trivial.

**4. `stripNonContent(document)`** replaces the old inline strip loop and the `dropNonContent` Turndown
rule. It removes `script, style, noscript, svg, canvas, iframe, template, form, button` at DOM level, then
removes elements whose class matches
`/(?:^|[\s_-])(?:copy|clipboard)(?:btn|button|[\s_-]|$)|lang(?:uage)?[-_](?:label|name)|code-?block-?title/i`
**that do not contain a `<pre>`**. The containment guard is load-bearing: GitHub's README content container
is `<div class="js-snippet-clipboard-copy-unpositioned …">`, and an unguarded regex deletes the entire
README. The `copy|clipboard` half is anchored on token boundaries so `copyright` does not match. `language-name`
was added to the brief's `lang(uage)?-label` because that is MDN's actual class, and it was the QA #2 stray
`js` line (verified: zero stray language/copy lines across all seven code-bearing fixtures now).

**5. Dead code removed:** `dropNonContent` (its tags are all stripped at DOM level now), `codeBlockStyle`,
`cleanMarkdown`. There are no `FetchedPage.charset` reads in `extract.ts`. **Not done:** the
`for (let pass = 0; pass < 100; …)` loop in `unwrapLayoutTables` is left as it is — it is live, not unused
(`hn-front` depends on it for nested tables), Task 3 item 1 rewrites layout-table detection wholesale, and
replacing the bound with `while (true)` trades a bounded loop for a possible hang with no test to catch it.

**6. Extra: title metadata withheld from Readability** (`TITLE_METADATA_SELECTOR`). Readability deletes the
article's first `h1`/`h2` when `_textSimilarity(articleTitle, heading) > 0.75` (Readability.js:1105). On the
GitHub fixture that scores 0.86 for `<h1>Readability.js</h1>` against the page title "GitHub -
mozilla/readability: A standalone version of the readability lib", and the README loses its own heading —
which is not recoverable afterwards. The Readability clone now has `title, meta[property$="title"],
meta[name$="title"]` removed, so `_articleTitle` is empty and the check never fires; we take the title from
the source document ourselves, with `og:title` added as a fallback so nothing that Readability used to
supply is lost. Cost: `article.title` is always empty now, so titles are the raw `<title>` rather than
Readability's separator-stripped version. That trades goal (2) for goal (1), which is the stated priority.

## Tests

```
npx tsx --test tests/fidelity.test.ts     # focused
npm test                                  # tsx --test tests/*.test.ts
npm run typecheck                         # tsc --noEmit → clean
```

| | before (2e62505) | after |
|---|---|---|
| `tests/fidelity.test.ts` | 17 pass / 25 fail | **34 pass / 8 fail** |
| `npm test` (incl. charset.test.ts import failure) | 17 / 26 | 34 / 9 |

All eight target fixtures pass in full. Newly passing (17):

- code-regex: `auto f = [](int a) { return a; };`, `arr[i]();`, `let v = vec![1, 2];` verbatim; first fence
  labelled `cpp`; exactly 2 fences (the bare `<pre>` included).
- python-asyncio: ≥1 fence; REPL session verbatim; a fence carries a language (`pycon`).
- github-readability: README heading `Readability.js`; ≥6 fences; code lines verbatim.
- react-learn: MyButton example on separate lines, indentation intact, in one fence.
- div-code: all three blocks fenced with lines intact; exactly 3 fences.
- go-tutorial: all ten `<pre>` fenced.
- pypi-requests: doctest session fenced with unescaped `>>>` prompts.
- mdn-fetch: unchanged (already green), plus the stray `js` label lines are gone.

The 8 remaining failures are exactly Task 3's list: wikipedia-transformer (2), claude-docs-prompt-caching (2),
table-td-only (3), fragment (1), plus `charset.test.ts` failing at import by design.

## Files changed

- `extract.ts` — all production changes.
- `tests/helpers.ts` — **one harness fix**, see below.

## Test change (harness defect, not an assertion change)

`fences()` only recognised a fence at column 0. `go-tutorial`'s ten `<pre>` blocks live inside `<ol><li>`,
so Turndown correctly indents them to the list item's content column — valid CommonMark, and invisible to
the old helper, which reported 0 fences for a document containing ten. `fences()` now accepts leading
indentation on the opening and closing delimiter and strips the opening indentation from the body lines.
No assertion was touched. Fence counts for the top-level fixtures (`code-regex` 2, `div-code` 3, `mdn-fetch` 5)
are unchanged.

## Self-review

- **No regex on markdown.** The only regexes left in the markdown path are inside `preBlock`'s own body
  handling (`^\n+`, `\s+$`, `` `+ ``), all applied to the code string before it is fenced, never to a
  finished document.
- **No regressions.** Output length per fixture, before → after: hn-front, claude-docs, table-td-only and
  fragment unchanged to the byte; the seven code-bearing fixtures +17 to +379 chars (the fences);
  wikipedia −424 (the 20 alt-less image links, partly offset by restored content). Every previously green
  test is still green.
- **No new dependencies**; `tsc --noEmit` clean; only `extract.ts` and `tests/helpers.ts` in the commit.
- **Duplication I accepted:** `preText`/`fenceLanguage` run twice per `<pre>` (once in `flattenPreBlocks`,
  once in `preBlock`). Collapsing them would mean either a Turndown rule that cannot handle raw/full-page
  mode, or carrying state between the DOM pass and the conversion. The second run is O(1) on a flattened
  `<pre>`.

## Concerns

1. **Withholding title metadata from Readability is the largest judgement call here** and reaches beyond the
   brief. It fixes real information loss (a page's own top heading), but it also means `Extracted.title` is
   now always the raw `<title>`/`og:title`, never Readability's cleaned-up version. If that is not wanted,
   the alternative is to accept that `github-readability`'s "keeps the README's own heading" test cannot pass.
2. **`CODE_CHROME_CLASS_PATTERN` is a heuristic on class names.** It is anchored and guarded by "contains no
   `<pre>`", and no fixture loses content to it, but a `<span class="copy-text">` holding real content on some
   other site would be deleted. Bounded, not eliminated.
3. **`<pre lang=…>` could in principle be a natural language** (`lang="en"`), which would emit ` ```en `. It
   is consulted only after every class-based source and only on the `<pre>` itself. I judged a bogus info
   string cheaper than losing PyPI's `python`/`console`/`shell` labels, but it is a deviation worth a look.
4. **python-asyncio still yields only one fence.** Readability drops the page's first code example entirely
   (task-1 report concern #3). That is defect 1.6 territory — content selection, not code fidelity — and the
   test only requires ≥1 fence. Task 3's main-content selection should recover it.
5. **`unwrapLayoutTables`' `pass < 100` loop was deliberately left in place** (see item 5 above). If the
   controller wants it gone regardless, it should be done as part of Task 3's table rewrite, which replaces
   that function's selection logic anyway.

---

# Fix round 1 — review findings

Commit: `da44bfd fix(extract): narrow code-chrome class match, restore deleted lead heading`.
Files: `extract.ts`, `tests/extract-unit.test.ts` (new).

## FINDING 1 — `CODE_CHROME_CLASS_PATTERN` deleted prose

Confirmed and fixed. The old alternation `(?:^|[\s_-])(?:copy|clipboard)(?:btn|button|[\s_-]|$)` matched a
bare `copy` token, so `copy`, `body-copy`, `hero-copy` all matched, document-wide, and the
`querySelector("pre")` guard is irrelevant to a prose block. The label alternative was also unanchored on
the right, so `language-namespace` matched `language-name`.

Every alternative is now a whole class token *and* unmistakably a control:

```
/(?:^|[\s_-])(?:copy[-_]?(?:button|btn|icon|code|link)|copy[-_]to[-_]clipboard|clipboard|lang(?:uage)?[-_](?:label|name)|code[-_]?block[-_]?title)(?:[\s_-]|$)/i
```

The `querySelector("pre")` guard is kept as a second line of defence. Coverage of the real fixtures is
unchanged: GitHub's controls still match via `js-clipboard-copy` on the `<clipboard-copy>` element, MDN's
label via `language-name`, Sphinx via `copybtn`. Re-verified: zero stray `js`/`bash`/`Copy` lines across all
thirteen fixtures, and per-fixture output lengths are within ±35 chars of the previous commit.

**Note:** PyPI's `copy-tooltip` no longer matches. It never reached the output anyway (it is a `<span>` whose
text is supplied by CSS), and re-checking the fixture confirms nothing leaked.

## FINDING 2 — withholding title metadata from Readability

Confirmed as the wrong approach and replaced, though the stated mechanism does not reproduce: with `<title>`
removed, `origTitle` is `""`, and Readability.js:640-648 (`curTitleWordCount <= 4` → `curTitle = origTitle`)
puts it straight back to `""`, so the single-`<h1>` substitution at :627-632 is undone before
`_headerDuplicatesTitle` runs. The finding's conclusion still stands on its own terms — the trick manipulated
Readability's input to get a side effect, changed `article.title` semantics, and did not generalise.

`TITLE_METADATA_SELECTOR` and the clone-stripping are gone. Readability now sees the document untouched, and
`restoreLeadHeading(content, document)` runs on its output: take the source document's first `<h1>` (else its
first `<h2>`) that is not inside `header, nav, footer, aside`; if no heading in `article.content` has that
text, prepend it as an `<h1>`. `Extracted.title` is back to `article?.title?.trim() || documentTitle`, with
`documentTitle` falling back to `og:title`, exactly as the finding asks.

## Minor findings

- **Image-only `<pre>`**: `flattenPreBlocks` now skips a `<pre>` with no text that contains an `<img>`, and
  `preBlock` returns the child rules' `content` instead of `""` when there is no code to fence — so the alt
  text survives.
- **`<pre lang="en">`**: a `NATURAL_LANGUAGE_TAGS` deny-set is consulted before the `lang` attribute is
  accepted. It deliberately omits `r`, `ts`, `sh`, `go`, `pl`, `cs` and `c`, which name both a human language
  and a programming language.
- **The "needed for raw mode" claim was wrong.** `flattenPreBlocks` runs unconditionally, so every `<pre>`
  Turndown sees is already a single text node. `preBlock` now reads `pre.textContent` and `preText` is called
  in exactly one place. The rule comment says so.

## Regression tests

New file `tests/extract-unit.test.ts` (6 tests, tiny inline pages, no fixtures):

| test | fails without the fix |
|---|---|
| keeps a `body-copy` block sitting next to a code block | yes — verified against `485a36d`'s `extract.ts` |
| keeps a class that merely starts with a label token (`language-namespace`) | yes — verified against `485a36d` |
| drops the copy control (`<button>` and `<span class="copy-button">`) and the `language-name` label | — |
| still fences the code with its language | — |
| keeps the h1 that differs from the page title | yes — verified by disabling `restoreLeadHeading` |
| leaves the site name out of the article (chrome `<h1>` is not restored) | yes — verified by removing the `CHROME_REGIONS` guard |

The h1 case uses `<title>Configuring TLS for the gateway</title>` with `<h1>Configuring TLS</h1>`: the
review's suggested `<title>Page 3 — Docs</title>` does *not* reproduce, for the `origTitle` reason above,
and would have been a vacuous test. This pairing scores `_textSimilarity` 1.0 and Readability really does
delete the heading.

## Commands and output

```
$ npx tsc --noEmit
(clean)

$ npx tsx --test tests/fidelity.test.ts
# tests 42 · pass 34 · fail 8          (unchanged; all 8 target fixtures green)

$ npx tsx --test tests/extract-unit.test.ts
# tests 6 · pass 6 · fail 0

$ npm test
# tests 49 · suites 16 · pass 40 · fail 9
```

`npm test` goes 34/9 → 40/9: the six new tests, no change to the failure set (the 8 Task-3 fidelity tests
plus `charset.test.ts`'s by-design import failure).

## Remaining concerns

1. `restoreLeadHeading` uses the document's first non-chrome heading, not a heading from a chosen content
   region — that concept arrives with Task 3 item 2. On a page whose first non-chrome heading sits in a
   sidebar rather than the article, a heading Readability dropped for good reason could be re-inserted. The
   `header/nav/footer/aside` guard covers the common shape; a `<div class="sidebar">` does not.
2. `CODE_CHROME_CLASS_PATTERN` is still a class-name heuristic, now a conservative one. It will miss controls
   named in ways the alternation does not list (the cost is a stray `Copy` line, not lost content).
