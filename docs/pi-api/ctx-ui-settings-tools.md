# ctx, UI, messages, settings, sessions and tools

Pinned to pi 1.4.0; see [README](README.md) for citations and staleness. What can't be done with
these is in [limits.md](limits.md).

## `ExtensionContext`

Declared at `dist/core/extensions/types.d.ts:213-253`. The members whose behaviour isn't obvious:

| Member | Behaviour |
|---|---|
| `ctx.signal` | `AbortSignal \| undefined`: the agent's signal, set only while a run is streaming (`turn_end`, a tool's `execute`). Commands and idle events usually get `undefined` |
| `ctx.sessionManager` | read-only (`dist/core/session-manager.d.ts:178`): `getCwd`, `getSessionDir`, `getSessionId`, `getSessionFile`, `getLeafId`, `getLeafEntry`, `getEntry`, `getLabel`, `getBranch`, `buildContextEntries`, `buildSessionProjection`, `getHeader`, `getEntries`, `getTree`, `getSessionName` |
| `ctx.model` | the selected model, possibly a virtual one; `undefined` when none is selected |
| `ctx.thinkingLevel` | the session's current level (`"off"` … `"max"`), or `undefined`; also `pi.getThinkingLevel()` |
| `ctx.mode` / `ctx.hasUI` | `"tui" \| "rpc" \| "json" \| "print"`; `hasUI` is true in TUI and RPC |
| `ctx.isProjectTrusted()` | whether project-local resources and `.pi/settings.json` are in effect |
| `ctx.getContextUsage()` | see [events.md](events.md#context-pressure) |
| `ctx.compact()` | aborts the current run first: [limits.md](limits.md) |

A tool's `execute(toolCallId, params, signal, onUpdate, ctx)` (`types.d.ts:514`) gets the run's
signal for that call, and an `ExtensionToolContext` (`:269`): `ctx` plus `tools` and `executeTool`.

## UI

```ts
ctx.ui.setStatus(key: string, text: string | undefined): void
ctx.ui.setWorkingMessage(message?: string): void     // no argument restores pi's default
ctx.ui.notify(message: string, type?: "info" | "warning" | "error"): void
ctx.ui.theme.fg(color: ThemeColor, text: string): string
```

- **Footer status** (`dist/modes/interactive/components/footer.js:253-262`): one line under pi's
  footer holding every extension's status, sorted by key and joined by spaces, each passed through
  `sanitizeStatusText` (whitespace collapsed, ANSI kept). pi applies no colour: colour it with
  `theme.fg(...)`.
- **Working row:** only shown while pi's working indicator is up; see [limits.md](limits.md).
- **Toasts:** `notify` has three levels, info, warning and error.
- **RPC mode** (`dist/modes/rpc/rpc-mode.js:101-113`): `setStatus` writes
  `{"type":"extension_ui_request","method":"setStatus","statusKey","statusText"}` to stdout (an
  omitted `statusText` clears it), `notify` writes `method: "notify"`, and `setWorkingMessage` does
  nothing. `ctx.ui.theme` is the real theme in RPC too, so coloured text reaches the client with
  ANSI escapes in it: format plain text when `ctx.mode !== "tui"`, or strip `/\x1b\[[0-9;]*m/g` on
  the receiving side.
- pi draws its own compaction card for both a boundary compaction (on `entry_appended`) and a pi
  compaction (on `compaction_end`), with a cost line when the entry has `usage`.

## `pi.sendMessage`

```ts
// types.d.ts:1258; implementation agent-session.js:1844-1882
pi.sendMessage<T>(
  message: { customType: string; content: string | (TextContent | ImageContent)[]; display: boolean; details?: T },
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
): void
```

- Fire and forget; errors surface as extension errors.
- `deliverAs: "nextTurn"`: held and sent with the next user prompt.
- While a run is streaming and `triggerTurn !== false`: `followUp` queues it after the run;
  anything else is a steer, injected before the next model request. A steer sent from `turn_end` is
  polled after that boundary's drafts are committed, so it lands after them in the session.
- Idle with `triggerTurn: true`: starts a run.
- Streaming with `triggerTurn: false`: held until the turn ends, so it never lands between a tool call
  and its result.
- Idle otherwise: appended at once, no turn.
- The model receives it as a `user` message (`dist/core/messages.js:89-96`); `display: false` hides
  it in the TUI only.
- An extension's steer never reaches `queue_update`, and clearing the queue on abort
  (`agent-session.js:1944-1952`) drops it without notice: only the human's queued messages are
  returned to the editor.

## Settings

```ts
pi.getSettings(): Settings     // types.d.ts:1286
```

- The global `settings.json` deep-merged with the project `.pi/settings.json`, the latter only when
  the project is trusted. A copy taken from memory: [limits.md](limits.md).
- The schema allows unknown top-level keys, so an extension can keep its own settings key in
  `settings.json`. The TS `Settings` type has no index signature: read it as
  `(pi.getSettings() as Record<string, unknown>).myKey`.
- `getCompactionSettings(model)` isn't on `ExtensionAPI`. To resolve `compaction.reserveTokens` /
  `keepRecentTokens` for a model, mirror `getCompactionTokenSetting`
  (`dist/core/settings-manager.js:643-659`): `compaction.modelOverrides["<provider>/<id>"][field]`,
  then `compaction[field]`, then the default (`DEFAULT_COMPACTION_SETTINGS`, exported: reserve 16384,
  keepRecent 20000); `enabled` defaults to true. pi throws on a value that isn't a non-negative safe
  integer; an extension's resolver should fall back instead. Inside `session_before_compact`,
  `event.preparation.settings` is already resolved.
- `thinkingBudgets`, `transport` and `retry` are on `Settings` too; a side model call that should
  match the agent's request copies them ([model-calls.md](model-calls.md)).

## Session files

- The session file is `<sessionDir>/<timestamp>_<sessionId>.jsonl`
  (`dist/core/session-manager.js:713`), created lazily once a user or assistant message exists.
- Under `--no-session` (every subagents Run is one), the manager is `SessionManager.inMemory`
  (`session-manager.js:1364-1366`): `getSessionDir()` is `""` and `getSessionFile()` is `undefined`.
  Branch on `getSessionFile() === undefined` before building a path; `join("", …)` silently resolves
  against the cwd.
- Whether an RPC child inherits the parent's project-trust decision is unverified, so project
  settings may not reach a Run.

## `pi.registerTool`

`ToolDefinition` is at `types.d.ts:453-519`; pi's `docs/extensions.md` ("Tools", "Tool exposure")
covers exposure, `executionMode`, `terminate`, `outputSchema` and nested `ctx.executeTool`. Beyond it:

- A custom tool without `promptSnippet` is left out of the system prompt's tool list.
- `exposure` defaults to `direct`: declared to the model and active from registration. Changing the
  active tool set mid-session changes the request prefix and costs a cache rebuild.
- Throwing from `execute` produces an error result.
- A tool that makes its own model calls reports their `usage` once: in the tool result, or in a
  compaction draft's `usage`, not both.
- Tool calls of one assistant message can run in parallel: when `execute` runs, a sibling's result may
  already be persisted, and this call's isn't.

## Built-in tool shapes

| Tool | Input | Result |
|---|---|---|
| `read` | `{ path, offset?, limit? }` (`offset` is a 1-indexed line) | `details: { truncation? }` |
| `write` | `{ path, content }` (the whole file) | text `Successfully wrote to <path>` |
| `edit` | `{ path, edits: [...] }` | |
| `bash` | `{ command, timeout? }` | output text; on failure see [limits.md](limits.md); `details: { truncation?, fullOutputPath? }` (pi saved a full copy when it truncated) |

Built-ins also include `grep`, `find`, `ls` (`powershell` on Windows). Paths may be relative to
`ctx.cwd`: normalise before comparing. A tool call's arguments live on the assistant message
(`content[i] = { type: "toolCall", id, name, arguments }`); its result is a separate `toolResult`
entry with `toolCallId`, `toolName` and `isError`.

## Imports at runtime

Inside pi, an extension can import (`dist/core/extensions/virtual-modules.js:14-30`): `typebox` (and
`/compile`, `/value`), `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`,
`@earendil-works/pi-ai` (resolved to `pi-ai/compat`, a superset), `pi-ai/models`, `pi-ai/oauth`,
`pi-ai/providers/all`, and `@earendil-works/pi-coding-agent`, plus Node built-ins. `pi-ai` isn't in
this repo's `peerDependencies`; it type-checks because npm hoists it, so prefer `import type` from it.
Some useful functions exist in `dist/` but aren't exported from the package root: check
`dist/index.d.ts` before importing (see [limits.md](limits.md) for the compaction ones).
