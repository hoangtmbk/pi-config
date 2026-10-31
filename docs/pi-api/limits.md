# What an extension can't do in pi 1.4.0

Pinned to pi 1.4.0; see [README](README.md) for citations and staleness. Each entry: what a spec
would naturally assume, what pi does, the evidence, and what to design for instead. Check a spec's
acceptance criteria against every entry before it becomes tickets: an AC that rests on one of these
can't be met as written.

## Settings edits don't reach a running session

*Parked #34.* `pi.getSettings()` returns `structuredClone(this.settings)`
(`dist/core/settings-manager.js:329-331`), and `this.settings` is rebuilt only in the constructor, on
a trust change (`:341-361`), in `reload()` (`:362-387`) and by pi's own setters. Nothing watches the
file. `reload()` runs from `/reload` (`AgentSession.reload`, `dist/core/agent-session.js:2998-3010`),
which first sends `session_shutdown` with `reason: "reload"` and invalidates the extension runner,
so the extension is loaded again from scratch and its in-memory state starts over.

Design for: "applies after `/reload` or a restart". Reading `settings.json` from disk yourself means
re-implementing pi's global/project merge and trust rule, and pi's own keys (`compaction.*`) would
still come from pi's stale copy, so the two can disagree.

## Outside a boundary, an extension can't append context edits or compactions

*Parked #43.* Only the actionable boundaries, `turn_end` and `agent_before_settle`, accept drafts
(`custom`, `custom_message`, `context_edit`, `compaction`; see [events.md](events.md#drafts)).
Everywhere else:

- `session_before_compact` takes no drafts: its result is only `{ cancel?, compaction? }`
  (`dist/core/extensions/types.d.ts:1137-1140`), and pi appends exactly one compaction entry from it
  (`agent-session.js:2297` for `/compact`, `:2586` for threshold and overflow).
- `ctx.sessionManager` is a `ReadonlySessionManager`, getters only
  (`dist/core/session-manager.d.ts:178`).
- A tool's `execute` can't append entries either. It can hand work to the same turn's `turn_end`,
  which fires after every tool of the turn has finished.

Outside a boundary the writes left are `pi.appendEntry()` (a custom entry the model doesn't see) and
`pi.sendMessage()` (a custom message the model does see).

Design for: edits that ride on a pi-started compaction either don't happen, or are stored and drafted
from the next `turn_end`, re-checked against the branch then.

## An extension's working-row text never shows during a pi compaction

*Parked #35.* `ctx.ui.setWorkingMessage` changes the live indicator only while it is the `"working"`
kind (`dist/modes/interactive/interactive-mode.js:2059-2064`). On `compaction_start`, which fires
before `session_before_compact` on `/compact`, threshold and overflow alike, pi swaps in its own
`CompactionStatusIndicator` (`interactive-mode.js:2930-2945`) with fixed text: `Compacting
context...`, `Auto-compacting...`, `Context overflow detected, Auto-compacting...`
(`dist/modes/interactive/components/status-indicator.js:44-51`). A message set anyway is stored and
shows on the *next* working row unless reset with `setWorkingMessage()` (no argument). In RPC mode
`setWorkingMessage` is a no-op (`dist/modes/rpc/rpc-mode.js:111-113`).

Design for: working-row text only inside a run (`turn_end`, a tool's `execute`), where the working
indicator is up. In a pi compaction, pi's indicator is what the user sees. In RPC, use
`ctx.ui.setStatus`.

## `ctx.compact()` ends the run, and `ctx.signal` is the wrong signal in a pi compaction

`ctx.compact()` calls `AgentSession.compact()` (`agent-session.js:2831-2834`), which awaits
`this.abort()` before compacting (`:2230-2231`): calling it from a handler or tool ends the run it is
part of. For the same reason, in `session_before_compact` on `/compact` `ctx.signal` is `undefined`
or already aborted. Escape during any pi compaction calls `session.abortCompaction()`
(`interactive-mode.js:2936-2939`), which aborts `event.signal`, not the agent's signal.

Design for: inside a run, compact by drafting a `compaction` at `turn_end`. In
`session_before_compact`, pass `event.signal` to any model call.

## The exported cut-point helpers don't reproduce pi's own cut

pi's `/compact` and backstop cut with `prepareCompaction` → `findProjectedCutPoint`
(`dist/core/compaction/compaction.js:555-687`), over the *projected* (context-edited) branch, starting
after the previous compaction, with an extra rule for recovery omissions. Neither function is exported
from the package root. The exported `findCutPoint(entries, startIndex, endIndex, keepRecentTokens)`
(`compaction.d.ts:94`) sizes entries from their *raw* messages and leaves `startIndex` to the caller,
so after a `context_edit` has shrunk entries, it keeps a smaller tail than pi would. Also not exported:
`estimateProjectedContextTokens` (reach it through `ctx.getContextUsage()`) and
`getCompactionSettings` (see [ctx-ui-settings-tools.md](ctx-ui-settings-tools.md#settings)).

Design for: feeding `findCutPoint` the projection mapped back to entries; see
[events.md](events.md#cut-points).

## A side model call skips every extension's request hooks

`ctx.modelRegistry.streamSimple` goes straight to the provider (`dist/core/model-runtime.js:497-521`).
`context`, `context_with_system` and `before_provider_request` run only for the agent's own requests,
wired in `dist/core/sdk.js:228, 273, 281`. So a side call sends what you built, and another
extension's rewrite of the agent's request makes the two differ without warning.

Design for: building the side call's context from what the agent's next request would carry
([model-calls.md](model-calls.md#building-the-context)), and detecting cache misses afterwards from
`usage` rather than assuming a hit.

## Escape during tool execution reports `outcome: "completed"` first

`turn_end`'s `outcome` comes only from the assistant message's `stopReason`
(`agent-session.js:487-490`). When Escape lands while tools run, that message already ended with
`toolUse`, so the turn's boundary reports `completed` with `isError: true` "aborted" tool results; the
loop then goes round once more, and that turn's boundary is the `aborted` one
(`pi-agent-core/dist/agent-loop.js:146-158`).

Design for: treating `ctx.signal?.aborted === true` at `turn_end` as aborted too.

## A failed `bash` call is always an error result, and its exit code isn't stored

A non-zero exit returns `isError: true` with `Command exited with code N` appended to the text
(`dist/core/tools/bash.js:295-303`). The result's `structuredContent` (which carries `exit_code`) is not
persisted: the stored `ToolResultMessage` keeps `content`, `details`, `usage` and `isError` only
(`pi-agent-core/dist/agent-loop.js:662-675`).

Design for: reading the exit status from `isError` and the trailing text line.

## pi has no record of a file being created or deleted

pi's file tracking (`FileOperations {read, written, edited}`, `dist/core/compaction/utils.js`) records
`read`, `write` and `edit` tool calls by `arguments.path`. There is no delete tool, `bash rm` is
invisible, and `write`'s result (`Successfully wrote to <path>`) doesn't say whether the file existed.

Design for: deriving "created" and "deleted" yourself (e.g. a `write` to a path not seen before;
parsing `rm` / `git rm` / `mv` in successful `bash` calls), or not promising them.

## A steer sent at a run's last turn starts one more model turn

After the boundary, pi-agent-core polls the steering queue and keeps looping while anything is in it
(`pi-agent-core/dist/agent-loop.js:184-193`). A `deliverAs: "steer"` message sent from the `turn_end`
that would have ended the run makes the agent answer it in a new turn.

Design for: `deliverAs: "nextTurn"` when the turn's message has no tool calls (queued for the next
user prompt, `agent-session.js:1853-1855`), or accept the extra turn.

## Context pressure can be unknown

`ctx.getContextUsage()` returns `undefined` with no model or a `contextWindow <= 0`, and
`{ tokens: null, percent: null }` after a compaction until an assistant reply with usage arrives
(`agent-session.js:3500-3534`). See [events.md](events.md#context-pressure).

Design for: both meaning "no reading", never 0.
