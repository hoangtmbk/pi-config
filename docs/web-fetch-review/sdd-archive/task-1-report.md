# Task 1 report — Test infrastructure + fidelity fixtures (RED)

Commit: `2e62505 test: fixture-based fidelity suite (red) + tsconfig` (branch `fidelity`, parent `29c0230`).

## What I implemented

**`package.json`** — added `scripts.test` (`tsx --test tests/*.test.ts`), `scripts.typecheck` (`tsc --noEmit`),
devDependencies `tsx`, `typescript`, `@types/turndown`, `@types/node`. No new runtime dependency; no
`@earendil-works/*` or `typebox` dependency declared.

**`tsconfig.json`** — NodeNext module/resolution, `allowImportingTsExtensions`, `noEmit`, `strict`, ES2022 target,
`lib: ["ES2022","DOM"]`, `types: ["node"]`, and absolute `paths` for the three globally-installed pi packages
(`@earendil-works/pi-coding-agent` → `dist/index.d.ts`, `@earendil-works/pi-tui` → pi's bundled
`dist/index.d.ts`, `typebox` → pi's bundled `build/index.d.mts`). `skipLibCheck: true` is **required**, not
cosmetic: without it pi's bundled `@anthropic-ai/sdk` and `pi-ai` `.d.ts` files emit ~40 errors
(`undici-types` path escapes, JSON imports without an import attribute) that this repo cannot fix.

**`extract.ts:47`** — the only production change. Turndown's typed tag-list filter has no `"svg"` member, so
the `dropNonContent` rule now uses a predicate over `node.nodeName` against the same eight element names.
Behaviour is unchanged (svg is also removed at DOM level in `extractHtml`). `npm run typecheck` passes.

**`tests/helpers.ts`** — `loadFixture(name): FetchedPage` (built against the real `FetchedPage` shape:
`{url, status, contentType, charset, body, bytes}` — there is **no `finalUrl` field**, contrary to the brief;
each fixture is given the origin it was captured from so `absolutizeLinks` behaves as it did live),
`fixtureBytes(name)`, `fences(md) -> {lang, code}[]`, `headings(md) -> {level, text}[]` (fence-aware, so a `#`
inside code is not counted), `hasEscapedMarkdownInFences(md)` and `escapedFences(md)` (the latter only so
failure messages can name the offending fence; both share one `/\\[[\]>*_]/` pattern — exactly the five
escapes the brief names, deliberately narrow to avoid false positives on real code).

**`tests/fixtures/`** — nine real page bodies copied verbatim from `../web-fetch-review/qa-out/` under the
names the brief specifies, plus four hand-built fixtures (`code-regex.html`, `table-td-only.html`,
`fragment.html`, `div-code.html`) and one generated fixture (`meta-sjis.html`).

**`tests/fidelity.test.ts`** — 13 `describe` blocks / 42 tests.
**`tests/charset.test.ts`** — 4 tests behind an import of `decodeBody`, which does not exist yet.

## Ambiguities resolved

- **`51-kakaku.md.raw.txt` is not raw bytes.** It is already-mojibake UTF-8 text (`hasReplacementChar: true`,
  no `0x93 0xFA` sequence anywhere). Per the brief's fallback I generated `tests/fixtures/meta-sjis.html`
  with a throwaway Node script: ASCII skeleton with `<meta charset="shift_jis">` plus the hand-built byte
  array `93 FA 96 7B 8C EA 83 65 83 58 83 67` ("日本語テスト") in `<title>`, `<h1>` and `<p>`. The generated
  file is committed byte-exact (verified with `git cat-file -p HEAD:tests/fixtures/meta-sjis.html | xxd`);
  the script is not.
- **`40-docs.anthropic.com` confirmed as the sidebar-only page.** Its `.md` is 6,855 chars of pure left-nav
  links and never contains `cache_control`, while the same fixture in `raw` mode yields 55,678 chars with 36
  occurrences of `cache_control`. That measurement is what makes the `>= 20,000` threshold defensible.
- **`decodeBody` vs. "typecheck must pass".** These two constraints conflict: the import of a not-yet-existing
  export is a compile error. I put `// @ts-expect-error` on that one import line, which keeps `tsc --noEmit`
  green while the *runtime* failure stays exactly what the brief wants (`SyntaxError: ... does not provide an
  export named 'decodeBody'`). The directive is self-cleaning: once `decodeBody` exists, TS flags the unused
  `@ts-expect-error` and forces its removal.
- **python-asyncio fence language.** The fixture has no `highlight-python` wrapper — measured classes are
  `highlight-python3` (first block) and `highlight-pycon` (second). Asserting the literal lang `python`
  would be wrong, so the test asserts "at least one fence carries a non-empty language" with the measured
  class names in a comment.

## Test command and results

```
npm test          # tsx --test tests/*.test.ts
npm run typecheck # tsc --noEmit  → clean
```

`tests 43 · pass 17 · fail 26 · duration ~0.9 s`
(42 fidelity tests + 1 whole-file failure for `charset.test.ts`, which fails at import by design.)

Every failure below was traced to a documented Phase 1 defect; none is a harness bug.

| # | Test | Result | Reason |
|---|---|---|---|
| 1 | charset.test.ts (whole file) | FAIL | 1.9 — `decodeBody` is not exported from `fetch.ts`; charset is read only from the header, never from `<meta>` |
| 2 | code-regex · `auto f = [](int a) { return a; };` verbatim | FAIL | 1.1 — `cleanMarkdown`'s empty-link regex eats `[](int a)` inside the fence |
| 3 | code-regex · `arr[i]();` verbatim | FAIL | 1.1 — the href-less-anchor regex rewrites `arr[i]()` to `arri` |
| 4 | code-regex · `// -----` verbatim | pass | guard (the separator regex needs a whole-line match, so `// -----` survives today) |
| 5 | code-regex · `let v = vec![1, 2];` verbatim | FAIL | 1.2 — bare `<pre>` is not fenced, so Turndown escapes it to `vec!\[1, 2\]` |
| 6 | code-regex · `>>> print("hi")` verbatim | pass | guard |
| 7 | code-regex · blank line inside first fence | pass | guard (`\n{3,}` only collapses 3+ newlines) |
| 8 | code-regex · first fence lang `cpp` | FAIL | 1.3 — Readability strips `class="language-cpp"`, so Turndown emits a bare fence |
| 9 | code-regex · exactly 2 fences | FAIL | 1.2 — the bare `<pre>` becomes loose paragraphs, so only 1 fence |
| 10 | code-regex · no escaping inside fences | pass | guard (today's escaping lands *outside* the fence; becomes load-bearing once 1.2 fences the block) |
| 11 | python-asyncio · ≥ 1 fence | FAIL | 1.2 — the surviving `<pre>` has no `<code>` child, so nothing is fenced |
| 12 | python-asyncio · REPL session verbatim | FAIL | 1.2 — rendered as `\>>> import asyncio`, `result\='hello'` |
| 13 | python-asyncio · ≥ 1 fence with a language | FAIL | 1.3 — Readability drops the `highlight-pycon` wrapper class |
| 14 | python-asyncio · no escaping inside fences | pass | guard |
| 15 | github-readability · README heading `Readability.js` | FAIL | 1.7 — Readability returns 11.8 KB of content with **zero** `<h1>…<h6>` elements; every README heading is dropped |
| 16 | github-readability · ≥ 6 fences | FAIL | 1.2 — all six README `<pre>` blocks are `<pre>` without `<code>`; 1 fence emitted |
| 17 | github-readability · README code lines verbatim | FAIL | 1.2 — `var article \= new Readability(document).parse();` |
| 18 | github-readability · no escaping inside fences | pass | guard |
| 19 | react-learn · MyButton example on separate lines | FAIL | 1.4 — per-line `<div class="cm-line">` collapses to `function MyButton() {return (<button>I'm a button</button>);}` |
| 20 | div-code · `<div>`-per-line block fenced with lines intact | FAIL | 1.2 + 1.4 — becomes three separate paragraphs, no fence |
| 21 | div-code · `<br>`-separated block fenced with lines intact | FAIL | 1.2 — lines survive but no fence is emitted |
| 22 | div-code · `<span class="line">` block fenced with lines intact | pass | guard (has a `<code>` child, so Turndown's built-in rule already fences it) |
| 23 | div-code · one fence per `<pre>` (3) | FAIL | 1.2 — only 1 of 3 |
| 24 | go-tutorial · ≥ 10 fences | FAIL | 1.2 — all ten `<pre>` blocks reach the markdown but none is fenced |
| 25 | go-tutorial · `$ go mod init example/hello` verbatim | pass | guard (this line happens to contain no escapable character) |
| 26 | go-tutorial · no escaping inside fences | pass | guard |
| 27 | pypi-requests · doctest fence with unescaped prompts | FAIL | 1.2 — `\>>> import requests`, `r.status\_code`, `r.headers\['content-type'\]`, and unfenced |
| 28 | pypi-requests · no escaping inside fences | pass | guard |
| 29 | wikipedia · ≥ 8 of 10 `<h2>` sections at level 2 | FAIL | 1.7 — only `Full transformer architecture` survives; `History`, `Training`, `Architecture`, `Subsequent work`, `Applications`, `See also`, `Notes`, `References`, `Further reading` are all gone |
| 30 | wikipedia · no `[edit]` | FAIL | 1.7 — `[edit]` appears 19 times |
| 31 | wikipedia · no `#`/`¶`/ZWSP heading debris | pass | guard |
| 32 | claude-docs · markdown ≥ 20,000 chars | FAIL | 1.6 — Readability returns 6,855 chars: the left navigation sidebar only |
| 33 | claude-docs · contains `cache_control` | FAIL | 1.6 — 37 occurrences in the HTML, 0 in the output |
| 34 | table-td-only · GFM table with 3 data rows | FAIL | 1.5 — a `<th>`-less table is treated as layout and unwrapped; 0 table lines |
| 35 | table-td-only · row cells on one line | FAIL | 1.5 — each cell becomes its own paragraph, so row association is lost |
| 36 | table-td-only · caption `Versions` kept | FAIL | 1.5 — `<caption>` is dropped entirely |
| 37 | table-td-only · nested layout table unwrapped, no `\|` | pass | guard |
| 38 | fragment · `# Title`, `one`, `two`, fence with `code` | FAIL | 1.8 — output is the 5-char string `Title`; everything after the first element is lost |
| 39 | hn-front · no GFM table | pass | guard |
| 40 | hn-front · ≥ 150 absolute links | pass | guard (measured 181) |
| 41 | mdn-fetch · ≥ 5 fences | pass | guard |
| 42 | mdn-fetch · `fetch(resource, options)` / `.fetch(myRequest)` verbatim | pass | guard |
| 43 | mdn-fetch · no escaping inside fences | pass | guard |

Coverage of the Phase 1 table: 1.1 ✓, 1.2 ✓, 1.3 ✓, 1.4 ✓, 1.5 ✓, 1.6 ✓, 1.7 ✓, 1.8 ✓, 1.9 ✓ — all nine.

## Files changed

- `package.json` (scripts + devDependencies), `package-lock.json`
- `tsconfig.json` (new)
- `extract.ts` (one rule, lines 45–51)
- `tests/helpers.ts`, `tests/fidelity.test.ts`, `tests/charset.test.ts` (new)
- `tests/fixtures/` — 14 files (new): 9 captured pages, 4 hand-built, 1 generated
- `test.ts` untouched; `index.ts` untouched; `node_modules/` and `.superpowers/` remain gitignored.

## Self-review

- **Assertions are measured, not guessed.** Fence counts come from counting `<pre>` blocks in each fixture and
  confirming every one of them already reaches the markdown (github 6/6, go 10/10 — note go's closing tags are
  written `</pre\n>`, which a naive `</pre>` count misses). Wikipedia's ten section names come from its `<h2>`
  elements minus the `Contents` TOC heading. HN's `>= 150` is against a measured 181. The react-learn expected
  lines are the literal `cm-line` div contents.
- **Caught one false pass and fixed it.** `table-td-only` originally had `<h1>Versions table</h1>`, so the
  "caption kept" assertion passed on the heading text rather than the caption. The fixture heading is now
  `Release history`, and the test fails correctly.
- **Harness verified, not assumed.** For the one failure whose cause was not obvious (github headings), I ran
  Readability directly on the fixture and confirmed `article.content` contains no heading elements at all —
  so the test is red for a real extraction defect, not for a `headings()` parsing bug.
- **No overbuilding.** No live-network test, no snapshot files, no assertions beyond the brief's list. The one
  helper the brief did not name (`escapedFences`) exists only to make an assertion message readable and shares
  its pattern with `hasEscapedMarkdownInFences`.
- **Output is clean.** Aside from the 26 expected failures the run is silent — no warnings, no stray logs,
  ~0.9 s wall clock.

## Concerns

1. **The fixtures add ~4.6 MB to the repo** (`claude-docs-prompt-caching.html` 2.3 MB, `wikipedia-transformer.html`
   1.0 MB). Intentional per the brief, but worth a conscious decision before this branch merges.
2. **`tsconfig.json` hard-codes an absolute path** to `~/.nvm/versions/node/v22.22.2/lib/node_modules`. It is
   local-only by design, but it breaks for anyone else and after a Node version bump.
3. **python-asyncio loses a whole code block to Readability**, separately from the fenced-code defects: the
   first example (`import asyncio` / `async def main(): ...`) is in the fixture HTML but never reaches
   `article.content`. That is real information loss adjacent to defect 1.6 and is **not** covered by any test
   here, because the brief did not call for it. Worth deciding whether Phase 1 should cover it.
4. **`code-regex`'s "no escaping inside fences" assertion is currently vacuous** — today's escaping (`vec!\[1, 2\]`)
   sits outside any fence, so it passes for the wrong reason. It becomes load-bearing the moment defect 1.2
   fences the bare `<pre>`. Same for `go-tutorial` and `pypi-requests`. Not a defect in the test, but a reviewer
   should not read those greens as "escaping is fine today".
5. **The `@ts-expect-error` in `charset.test.ts` must be deleted** when `decodeBody` lands, or `tsc` will fail on
   the now-unnecessary directive. That is the intended forcing function, but it will look like an unrelated
   breakage to whoever implements 1.9 if they do not read the comment.
