---
team: software
playbook: 3f9c1e0b7a2d4c56e8f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6
overrides:
  - rule: design-review
    change: skip
    reason: >-
      The output header change is spelled out under Constraints below, so I've already seen the
      only interface change. The architect still designs; I just don't need to approve it.
  - rule: read-public-docs
    change: also allow fetching https://httpbin.org/*, including non-GET requests
    reason: QA needs to check the cache against real status codes and redirects.
---

# web_fetch: reuse a recent fetch within the session

## Goal

When the model fetches the same page twice in one pi session, which it often does after a
compaction or when it switches subtasks, `web_fetch` refetches and re-extracts it. That is
slow, and some sites rate-limit it. A repeat fetch within a few minutes should return the saved
result instead.

## Acceptance criteria

- **AC1**: A second `web_fetch` of the same URL with the same `raw` value, within 10 minutes in
  the same pi session, makes no network request and returns the same markdown.
- **AC2**: The provenance header of a cached result has a line `cached: <age>` (e.g.
  `cached: 3m ago`). A fresh fetch has no such line.
- **AC3**: A different `raw` value, a different session, or an entry older than 10 minutes
  fetches fresh.
- **AC4**: A failed fetch (network error or a non-2xx status) is never cached.
- **AC5**: The cache lives in the session's existing scratch directory and goes when it does.
  Nothing is kept across sessions.
- **AC6**: `extensions/web-fetch/README.md` documents the cache in a short section.

## Scope

In: `extensions/web-fetch/` and its tests.

Out: a cache shared across sessions; a cache-control setting; honouring HTTP cache headers
(`Cache-Control`, `ETag`); any change to the other extensions.

## Constraints

- The only change to the tool's output is the `cached:` header line from AC2. No new parameter.
- No new dependency.
- The redirect target counts as the same URL only if the request URL matches. Key on what the
  model asked for, not on where it ended up.

## Context

- The scratch directory and the temp-file naming are in `extensions/web-fetch/index.ts` and
  `format.ts`.
- `CODING_STANDARDS.md` applies. Tests run with the repo's existing test command.

## Decide for me / ask me

- **Decide for me**: the key format, the file layout inside the scratch directory, how age is
  rounded in the header.
- **Ask me**: anything that would change what the model sees beyond the `cached:` line.

## Delivery

Commits on the Effort's branch. Push the branch and open a PR against `main` when QA passes.
This covers the floor for that push and that PR, and nothing else.
