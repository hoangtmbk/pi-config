# Clarifications

Append-only. These are the human's answers to questions the Lead escalated because the Brief
couldn't answer them. Teammates read this file as part of the Brief. Appending needs no
approval, since a clarification answers an ambiguity. Changing what the Brief asks for is a
Brief change.

## 2026-11-01 14:20 · asked by dev-1, Task "cache store", escalated by the Lead

**Question:** A first fetch was truncated, with the full markdown saved to a temp file. On a
cache hit, should the result point at that same file or write a new one?

**Brief says:** nothing. AC1 says "the same markdown" but not the `full:` path.

**Answer:** Same file. The `full:` path is part of "the same markdown".

## 2026-11-01 15:05 · asked by qa-1, Task "verify", escalated by the Lead

**Question:** AC4 says a non-2xx response is never cached. Does a 304 count as a failure?

**Brief says:** nothing. Honouring cache headers is out of scope, so a 304 shouldn't happen,
but a server can send one anyway.

**Answer:** Treat a 304 like any non-2xx: don't cache it. No need to handle it specially.
