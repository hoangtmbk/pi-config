# Coding standards

The judgement calls a reviewer checks a change against. Each rule names where the repo already
follows it; when a change breaks one, cite the rule and the evidence. Rules a script can check
(what may import what) belong in a script, not here. `npm run check:imports` checks the import
rules.

## Tests go through the seams, with fakes at the edge

A test drives the extension the way pi does, through its registration function or a module's
exported API, with only the outside world faked: a recording fake `pi`, a scripted RPC child that
is a real subprocess, a `fetch` that replies from a fixture. Everything between runs as it does in
production. A seam is an optional parameter whose default is the real thing, injected by tests and
by nothing else. `npm test` stays offline, key-free and deterministic.

Evidence: `SubagentsOptions` and `fakeSession` / `recorder` in
`extensions/subagents/tests/index.test.ts`; `extensions/subagents/tests/fake-rpc-child.ts`; `deps.fetch` in
`extensions/web-search/brave.ts` with `fakeFetch` in its `tests/helpers.ts`; each extension
README's "Testing" section.

## Anything that spends tokens or needs a key is a live runner

Work that needs a real model, API key, network or pi binary goes in the extension's `test.ts`
beside `tests/` (never inside it), run by a `live:<extension>` script, started by a human, printing
`ok` / `FAIL` per case. It is never part of `npm test`.

Evidence: `package.json` scripts; the header of `extensions/subagents/test.ts`; the test "has a
manual runner against real pi that `npm test` cannot reach" in `extensions/subagents/tests/index.test.ts`.

## `register*` and `index.ts` are wiring

The registration function connects pi to the modules: it registers tools and handlers and passes
their inputs on. Decisions live in modules that can be tested without pi, and each outside thing
(a subprocess, a provider's API) is known to one module only. A rule written inline in a handler or
`execute`, or a second copy of a predicate a module already owns, belongs in that module.

Evidence: the header of `extensions/subagents/index.ts` ("This file is wiring and nothing else"),
with `supervisor.ts` pure and `child.ts` the only module that knows a process exists; the header of
`extensions/web-search/brave.ts`; commit f0178d2 moving the active-Run predicate out of the wiring
into the Supervisor.

## CONTEXT.md's words, everywhere

Code identifiers, comments, READMEs, error messages and test names use the terms defined in
`CONTEXT.md` (Run, Delivery, Steer, Pressure level, Handoff, Pruning, …), never the words it lists
under _Avoid_. A test name is a sentence about behaviour in those terms, with the reason when it
isn't obvious.

Evidence: `docs/agents/domain.md`; test names such as "queues as a steer while the parent is
streaming, so it never lands mid-tool-call".

## Comments and READMEs say what is true now

A comment or README states what the code does and why, as of this commit: no plans, no claims about
work in another ticket, no guesses presented as facts. A change in behaviour changes its comment
in the same commit. A comment earns its place by giving the reason, especially the alternative that
was rejected; one that restates the code is noise.

Evidence: commit ffd5adb ("describeError claimed to unwrap something thrown across a process
boundary; a failed spawn rejects in-process"); commit 61febdf replacing the web-search README's
guesses with measurements; the `executionMode` comment in `extensions/web-search/index.ts`.

## Failures are loud and say what to do next

An error the model or the user reads says what happened and what would work instead, naming the
valid options. Bad input is rejected, never quietly turned into something else.

Evidence: `unknownAgent` and `approveProjectAgent` in `extensions/subagents/index.ts`; the test
"rejects an unknown agent with the names that would have worked"; commit f0178d2 rejecting a blank
Run name instead of treating it as "every Run".
