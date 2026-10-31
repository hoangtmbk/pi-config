# pi's extension API, as installed

**Pinned to pi 1.4.0** (`@earendil-works/pi-coding-agent`, `pi-ai` and `pi-agent-core`, all 1.4.0).
Every claim cites the installed `dist/`, not pi's docs; a sample was re-read against it, and none was
run against a model. A claim marked "unverified" is a lead, not a fact. If `package.json` now pins a different pi, treat each claim as a lead: re-read the cited file
before a spec, ticket or line of code depends on it, then fix the claim and move this pin.

What this adds over pi's own docs: the behaviour the `.d.ts` files and
`node_modules/@earendil-works/pi-coding-agent/docs/` don't state, such as ordering, what a return
value really does, and what an extension can't do at all. For lifecycle, handler composition, tool
exposure and state storage, read pi's `docs/extensions.md` first; for exact signatures, the exported
declarations (`dist/core/extensions/types.d.ts`).

## Files

| File | Read it when the work touches |
|---|---|
| [`limits.md`](limits.md) | anything a spec or ticket promises pi will do. **Read this before writing acceptance criteria**: each entry is something an extension can't do in 1.4.0, and three tickets (#34, #35, #43) were parked on them |
| [`events.md`](events.md) | `turn_end` and other boundaries, drafts (`custom`, `custom_message`, `context_edit`, `compaction`), `session_before_compact`, the compaction entry, cut points, context pressure |
| [`ctx-ui-settings-tools.md`](ctx-ui-settings-tools.md) | `ctx` members, the footer/working row/toasts in TUI and RPC, `pi.sendMessage`, `pi.getSettings`, session files, `registerTool`, built-in tool shapes, runtime imports |
| [`model-calls.md`](model-calls.md) | a model call of the extension's own: `ctx.modelRegistry.streamSimple`, `generateSummary`, usage and cache-miss accounting |

## Citations

Paths are relative to `node_modules/@earendil-works/pi-coding-agent/` unless they start with
`pi-ai/` or `pi-agent-core/`, which are its siblings under `node_modules/@earendil-works/`. Line
numbers are 1.4.0's; after an upgrade, search for the named function rather than trusting them.

## Elsewhere in this repo

- [`docs/research/source-pi-session-messaging.md`](../research/source-pi-session-messaging.md):
  session identity, `pi.sendMessage` delivery, long-lived listeners (`session_start` /
  `session_shutdown`), as of pi 0.84.3.
- [`docs/web-fetch-review/research-pi-api.md`](../web-fetch-review/research-pi-api.md): tool
  registration, output truncation and custom rendering, as of pi 0.84.3.
- [ADR 0001](../adr/0001-rpc-child-processes-for-subagents.md): driving a `pi --mode rpc` child with
  `RpcClient`, and why its JSONL stream rules out `readline`.
- [ADR 0004](../adr/0004-handoff-written-by-a-forked-call.md): the request shape a side call must
  copy to hit the provider cache.
