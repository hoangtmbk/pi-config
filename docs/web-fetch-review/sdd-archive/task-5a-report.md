# Task 5a report — rewrite / renderers / pdf (unwired)

Commit: `e8bbde8 feat: rewrite/pdf/renderers modules (unwired)` on branch `task5a-modules`
(worktree `/private/tmp/claude-501/-Users-hoangta--pi-agent/3c4b50e6-f0a2-4e6a-8a84-e798e027111c/scratchpad/wt-task5a`).

## Files

New:
- `/private/tmp/.../wt-task5a/rewrite.ts` (142 lines)
- `/private/tmp/.../wt-task5a/renderers.ts` (~178 lines)
- `/private/tmp/.../wt-task5a/pdf.ts` (56 lines)
- `/private/tmp/.../wt-task5a/tests/rewrite.test.ts` (40 cases)
- `/private/tmp/.../wt-task5a/tests/renderers.test.ts` (10 cases)
- `/private/tmp/.../wt-task5a/tests/pdf.test.ts` (4 cases)

Modified: `package.json`, `package-lock.json` (adds `unpdf ^1.8.1`). No existing source or test file touched.

## Exported signatures (for the Task 5b wiring)

```ts
// rewrite.ts
export interface Rewrite { url: URL; note: string; fallback?: URL }
export function rewriteUrl(url: URL): Rewrite | undefined;

// renderers.ts
export type HtmlToMarkdown = (html: string) => string;
export function renderKnownJson(finalUrl: URL, json: unknown, htmlToMarkdown: HtmlToMarkdown): string | undefined;

// pdf.ts
export interface PdfText { text: string; pages: number; truncatedPages: boolean; title?: string }
export function pdfToText(bytes: Uint8Array, opts?: { maxPages?: number }): Promise<PdfText>;
```

Notes for the wiring:
- `htmlToMarkdown` is a **required** third argument (no import of `extract.ts`, per the brief). Pass the real HTML→markdown converter; only the StackExchange renderer calls it.
- `renderKnownJson` dispatches on the **final** URL host: `api.stackexchange.com`, `registry.npmjs.org`, `pypi.org` + path prefix `/pypi/`. Pass the post-redirect URL.
- StackExchange answers: attach the second request's `items` array to the question JSON as `answers` (`{...questionJson, answers: answerItems}`) before calling.
- `Rewrite.fallback` is set for stackexchange / npm / wikipedia / arxiv / pypi (always the original URL) and **not** for the github blob→raw rule (a pure address change; a 404 there means the file genuinely is not at that ref, and the blob page would not have it either).
- `pdf.pages` is the document's **total** page count, not the number of pages rendered; `truncatedPages = totalPages > maxPages`. Default `maxPages` is 200.
- `pdfToText` throws `Error("PDF has no extractable text (scanned image?)")` when the kept pages hold < 20 chars — the fetch/extract layer should surface that message as-is.

## Rule coverage (rewrite.ts)

| rule | in | out | fallback |
| --- | --- | --- | --- |
| github blob | `github.com/{o}/{r}/blob/{ref}/{path}` (`#L10-L20` preserved, query dropped) | `raw.githubusercontent.com/{o}/{r}/{ref}/{path}` | — |
| stackexchange | `{so,superuser,serverfault,askubuntu}.com` and `{site}.stackexchange.com` `/questions/{id}[/slug]`, `/q/{id}` | `api.stackexchange.com/2.3/questions/{id}?site={site}&filter=withbody` | original |
| npm | `npmjs.com/package/{name}` (scope as `@s/n` or `@s%2Fn`), `/v/{version}` | `registry.npmjs.org/{name}[/{version}]` (scope always `%2F`) | original |
| wikipedia | `{lang}.wikipedia.org/wiki/{Title}` | `…/api/rest_v1/page/html/{Title}` (encoding preserved) | original |
| arxiv | `arxiv.org/abs/{id}` (`1706.03762`, `…v5`, `hep-th/9901001`) | `arxiv.org/html/{id}` | original abs |
| pypi | `pypi.org/project/{name}[/{version}]` | `pypi.org/pypi/{name}[/{version}]/json` | original |

Negatives covered by tests: `/tree/`, `/issues/`, `/pull/`, repo root, `blob` without a file path, `/a/{id}`, non-numeric question id, `/tags/`, `api.stackexchange.com` itself, npm `/search`, wikipedia `Special:` and encoded `File%3A`, `/w/index.php`, `arxiv.org/pdf/`, `/list/`, unparseable arXiv id, pypi `/search/`, unrelated host, lookalike host `github.com.evil.test`.

## Tests

- `npx tsx --test tests/rewrite.test.ts tests/pdf.test.ts tests/renderers.test.ts` → **54 pass, 0 fail**, no warnings on stderr.
- `npm run typecheck` → clean.
- `npm test` (full) → 127 tests, 118 pass, **9 fail** — exactly the pre-existing set (4 charset + 5 fidelity: wikipedia headings/edit-links, claude-docs sidebar, table-td-only ×3, fragment). Unchanged from the baseline; my files are only new files plus package.json/lock.

PDF test builds its own PDFs: catalog + page tree + Helvetica font + one `BT /F1 24 Tf 100 700 Td (…) Tj ET` content stream per page, with a real xref table whose offsets come from the serialised (ASCII) output. No network, no fixture blobs.

## Self-review findings

- The brief's PDF example text (`Hello PDF`, 9 chars) would trip its own "< 20 chars → throw" rule, so the fixture page reads `Hello PDF, this is page one.` and the test still asserts `Hello PDF` is present. The 2-char case is used deliberately as the no-text-layer test.
- StackExchange meta line includes `asked YYYY-MM-DD` from `creation_date` (the brief listed the field; staleness matters on SO answers). Guarded against absurd timestamps so a junk value cannot throw `RangeError` out of a renderer.
- `renderers.ts` is ~178 lines, a little over the "~150 per module" guidance; the excess is the shared `str/num/arr/isRecord` guards that keep every field access safe against arbitrary JSON.
- Wikipedia titles containing a literal `/` (sub-pages) are left untouched rather than guessed at — the REST endpoint needs `%2F`, and such titles are almost always namespaced anyway.
- npm scoped names are normalised to `@scope%2Fname` for the registry; an already-encoded `%2f` is passed through as-is (the registry accepts either case).
- Renderers never dump raw JSON; unknown shapes return `undefined` (tested for each renderer) so the caller keeps the pretty-JSON fallback.

## Concerns

1. **`npm install unpdf` replaced the worktree's `node_modules` symlink with a real directory.** The main checkout's `node_modules` and `package.json` were NOT modified (verified: no `unpdf` there), so the concurrent implementer is unaffected — but after merging this branch the main checkout needs `npm install` before anything imports `pdf.ts`.
2. `unpdf` bundles PDF.js and is ~2 MB installed; it is imported at module scope in `pdf.ts`. If extension start-up cost matters, Task 5b should `await import("./pdf.ts")` lazily on the PDF branch rather than importing it at the top of `extract.ts`.
3. Nothing imports these three modules yet — they are dead code until Task 5b wires them.

## Fix round 1 (review: "Needs fixes") — commit `582141a fix: github blob fallback, npm deprecated + pypi yanked notices`

**Important — github blob rewrite now sets `fallback: url`.** A ref containing `/` (`release/1.0`,
`feature/x`, `dependabot/npm_and_yarn/...`) is common and the URL gives no way to tell where the ref
ends and the path begins, so `rest.join("/")` is a guess that can produce a 404ing raw URL. With the
fallback set, the blob page is fetched instead of losing the content. The `Rewrite.fallback` doc
comment no longer claims any rule "cannot 404 on its own" — every rule now sets a fallback, and the
comment says why (a rewrite is a guess about where the content lives).
Covering test: `"github blob on a slash-containing branch keeps a fallback"`
(`https://github.com/o/r/blob/release/1.0/src/file.ts` → raw URL + `fallback` = the original blob URL).
The three existing github cases were updated to assert the fallback too.

**Minor — npm deprecations.** `npm()` now reads `deprecated` off the version manifest: `versions[latest]`
for a packument, the document itself for a single-version response, and emits `**Deprecated:** {message}`
as the line directly under the title (before the description). Test `"puts a deprecation notice under the
title"` covers both shapes.

**Minor — PyPI yanked releases.** `pypi()` emits `**Yanked:** {yanked_reason || "yes"}` under the title
when `info.yanked === true`. Test `"flags a yanked release under the title"` covers reason present,
reason absent, and `yanked: false` (no line).

**Minor (optional, done) — PDF title.** `makePdf` in `tests/pdf.test.ts` takes an optional title, appends
an `<< /Title (…) >>` object and references it from the trailer as `/Info N 0 R`. Test `"reports the
document title when the metadata carries one"` asserts `title === "My Title"` and `undefined` for a
document with no `/Info`.

Left untouched per the review: renderers.ts length, mobile Wikipedia hosts.

### Verification

```
$ npm run typecheck            # clean
$ npx tsx --test tests/rewrite.test.ts tests/renderers.test.ts tests/pdf.test.ts
# tests 58  # pass 58  # fail 0        (41 rewrite + 12 renderers + 5 pdf, no stderr noise)
$ npm test                      # full suite
# tests 131  # pass 122  # fail 9      (unchanged pre-existing set: 4 charset + 5 fidelity)
```
