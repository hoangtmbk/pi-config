# web-fetch

A `web_fetch` tool for pi: fetches a URL and returns its main content as clean markdown.

## Why

`curl` in bash returns raw HTML — a Wikipedia article is ~1 MB, roughly 270k tokens, and most of it is
markup, navigation, and tracking parameters. `web_fetch` returns the same article as ~34k tokens of
markdown, and caps what actually enters the context at pi's standard tool limit.

Measured reduction, raw HTML → markdown:

| Page | Raw | Markdown | Reduction |
|---|---|---|---|
| Wikipedia (Transformer) | 1.09 MB | 137 KB | 87% |
| nodejs.org release notes | 519 KB | 73 KB | 86% |
| GitHub repo page | 321 KB | 4.5 KB | 98.6% |
| Hacker News front page | 35 KB | 14 KB | 59% |

## Usage

```
web_fetch(url: string, raw?: boolean)
```

- `url` — http or https. A bare host like `example.com` is upgraded to `https://`.
- `raw` — skip main-content extraction and convert the whole page. Use for index, listing, or
  search-result pages where the article extractor drops what you want.

Output starts with a provenance header, then the markdown:

```
# Transformer (deep learning)
source: https://en.wikipedia.org/wiki/Transformer_... (200 · text/html)
author: Contributors to Wikimedia projects
637 lines · 133.9KB → showing 220 lines (48.8KB)
full: /var/folders/.../pi-web-fetch-GDGPza/page.md
---
<markdown>
```

## Truncation

Output is capped at pi's standard tool limits (`DEFAULT_MAX_LINES` = 2000 lines, `DEFAULT_MAX_BYTES`
= 50 KB) — the same limits the built-in `grep` and `read` tools use, so `web_fetch` behaves
consistently with the rest of pi.

Nothing is lost when that cap is hit: the complete markdown is written to a temp file and its path is
reported. The model reads it with `read` (offsets work) or searches it with `grep`, pulling in only
the part it needs rather than re-fetching.

### Temp file lifecycle

Saved pages live in `$TMPDIR/pi-web-fetch/<session-id>/`, named `001-en.wikipedia.org-Transformer.md`
so a directory listing stays readable. Keying on the session id rather than a random suffix means
concurrent pi sessions never share a directory, and `/reload` — which rebuilds the extension without
ending the session — lands on the same directory instead of orphaning the previous one.

A `session_shutdown` handler removes the directory when the session ends. It deliberately skips two
shutdown reasons:

| Reason | Cleaned | Why |
|---|---|---|
| `quit`, `new`, `resume` | yes | The session is over; nothing will reference these paths again. |
| `reload` | no | Same conversation continues — earlier tool results still cite these paths. |
| `fork` | no | The fork inherits the transcript, and with it the paths. |

One consequence worth knowing: resuming a session from a *previous* pi run will find those paths gone,
since the files were cleaned when that run ended. The model should re-fetch the URL in that case.

## Content types

| Type | Handling |
|---|---|
| `text/html`, `application/xhtml+xml` | Readability extraction → markdown, with a whole-page fallback |
| `application/json`, `*+json` | Rendered as markdown when the payload is one we know (npm, PyPI, StackExchange); otherwise pretty-printed, and passed through raw if malformed |
| `application/pdf` | Text layer extracted, one marker per page; a scan with no text layer throws |
| `text/*`, YAML, XML, source files | Passed through unchanged |
| Anything else | Throws, naming the type and size — never dumps binary into context |

When a server sends no `Content-Type`, the body is sniffed for HTML.

## URL rewrites

Some pages have a machine-readable twin, and fetching that instead costs a fraction of the tokens:
a GitHub blob becomes the raw file, an npm or PyPI project page becomes its registry document, a
Wikipedia article becomes Parsoid HTML, an arXiv abstract becomes the HTML rendering, and a
StackExchange question becomes the API document — plus one extra request for its top answers, merged
into the same payload. Every rewrite is a guess, so a non-2xx answer falls back to the original URL,
and either way the swap is reported in the `note:` line of the header.

## What the cleanup does

Each rule was added because it was observed wasting tokens on a real page:

- **Image URLs dropped**, alt text kept — the model cannot fetch them, and CDN URLs run to hundreds of
  characters.
- **Empty links stripped** — GitHub emits `[](#anchor)` beside every heading, Wikipedia beside every
  citation.
- **Relative URLs resolved** against the final URL after redirects. Hacker News otherwise yields bare
  `vote?id=123` hrefs that are meaningless outside the page.
- **Tracking parameters stripped** (`utm_*`, `fbclid`, `gclid`, and friends).
- **Layout tables unwrapped.** Sites built from nested tables (Hacker News) otherwise render as
  pipe-padded markdown tables *larger than the source HTML* — 122% before this fix, 41% after. A
  table with no `<th>` is treated as layout; genuine data tables become GFM tables with cell markup
  converted, so links inside them survive.

## Robustness

- Browser User-Agent — a bare Node fetch gets 403'd by many sites.
- 30s timeout and pi's cancellation signal are combined, so Esc aborts the in-flight request.
- Response body is bounded at 10 MB, aborted mid-stream rather than buffered.
- Redirects followed; the **final** URL is reported and used as the link base.
- Non-2xx throws with the server's own error text included — pi marks the result `isError`.
- If Readability returns nothing usable (under 200 chars), it falls back to whole-page conversion
  automatically. This is why `raw` is rarely needed.
- Charset comes from the `Content-Type` header, and when the header declares none, from the
  document's own `<meta charset>` (or `<meta http-equiv="Content-Type">`). Legacy Shift_JIS and
  GB2312 pages therefore decode as text instead of replacement characters. Unknown labels fall
  back to UTF-8.

## Not included, on purpose

JavaScript rendering, caching, robots.txt, search, multi-URL fetching, and auth/cookies. There
is also no SSRF blocking — fetching `localhost:3000` docs is a thing you want from a local dev tool.

## Testing

```bash
npx tsx test.ts
```

Hits six real sites and five error cases (404, dead host, bad protocol, malformed URL, binary
content).

## Layout

```
index.ts     tool registration, truncation, TUI rendering
fetch.ts     HTTP: user agent, timeout, redirects, size guard, abort
extract.ts   content-type routing, Readability, markdown conversion, cleanup
test.ts      manual test runner (not loaded by pi)
```

Dependencies (`linkedom`, `@mozilla/readability`, `turndown`) install into this directory.
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` are aliased by pi's
extension loader and must not be declared as dependencies.

After editing, `/reload` in a pi session picks up changes.
