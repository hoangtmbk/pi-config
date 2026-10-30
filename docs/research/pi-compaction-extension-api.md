# What pi's extension API offers for watching and compacting context (primary sources)

Question (issue #17, a child of map #16): what can an extension in pi 1.4.0 actually do to
watch Context pressure, start a compaction, show a Pressure level and run inside a Run? Terms
(Context pressure, Pressure level, Self-compaction, Pruning, Handoff) are the ones in
`CONTEXT.md`'s Compaction section.

Sources are the installed packages `node_modules/@earendil-works/pi-coding-agent` and
`node_modules/@earendil-works/pi-agent-core`, both at version `1.4.0`
[pi-coding-agent/package.json] [pi-agent-core/package.json:3]. Paths below are relative to
`pi-coding-agent/` unless they start with `agent-core:` (`pi-agent-core/dist/`) or
`extensions/` (this repo). Line numbers refer to the shipped `docs/*.md`, `dist/**/*.d.ts` and
`dist/**/*.js` files. The dist JS was clear enough that pi's GitHub source was not needed; where
something is inferred rather than read, it says so.

## Recommendation

Pi gives an extension **two** ways to compact, and they behave very differently. The design
should depend on that difference.

1. **`ctx.compact()`** is the "manual" path, the same one `/compact` and RPC `compact` use.
   It **aborts the current run first**, reports `reason: "manual"` to
   `session_before_compact`, and **never continues the interrupted turn**
   [dist/core/agent-session.js:2225-2233, 2259] [dist/core/agent-session.js:1971-1982]. Called
   from a tool or from `turn_end` mid-task, it stops the agent. In a Run, that ends the Run's work.
2. **A `compaction` entry draft returned from `turn_end` or `agent_before_settle`** is appended
   at the boundary. The run carries on, and the next model request is built from the compacted
   projection [dist/core/extensions/types.d.ts:770-795] [dist/core/agent-session.js:487-533, 578-640]
   [agent-core:agent-loop.js:95-128, 184-195]. This path **does not fire
   `session_before_compact`, `session_compact`, `compaction_start` or `compaction_end`**. It
   emits only `entry_appended`. The extension writes the summary itself and pi never offers its
   default.

So Self-compaction and a forced level that land mid-task without stopping the agent have to go
through path 2. Pi's own threshold and overflow compaction (the backstop) and `/compact` go
through `session_before_compact`. Since pi runs no hook on path 2, the Handoff writer has to
be one function the extension calls from both places.

Pressure comes from `ctx.getContextUsage()`. It is a hybrid: the last provider-reported usage
plus a chars/4 estimate of everything after it. It is `null` after a compaction until the next
response [dist/core/agent-session.js:3500-3534] [dist/core/compaction/compaction.js:110-169].

For the UI, `setStatus` puts text on a footer line and `setWidget` puts lines above or below
the editor. Both also cross RPC as `extension_ui_request` lines, which the parent's `RpcClient`
hands to `onEvent` [dist/modes/rpc/rpc-mode.js:101-136] [dist/modes/rpc/rpc-client.js:412-427].
`setFooter` does nothing over RPC [dist/modes/rpc/rpc-mode.js:137-139].

Compaction works in a `--no-session` child. A child loads only the extensions passed with `-e`,
and its `--tools` allowlist includes extension tools [extensions/subagents/child.ts:154-165].

## 1. Context pressure: what `ctx` reports

**The call.** `ctx.getContextUsage(): ContextUsage | undefined`, available on every
`ExtensionContext`, including a tool's `ExtensionToolContext`
[dist/core/extensions/types.d.ts:247-248, 269]:

```ts
export interface ContextUsage {
    /** Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response). */
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
}
```
[dist/core/extensions/types.d.ts:197-203]

**Measured or estimated: both.** `AgentSession.getContextUsage()` builds the session
projection (the context the model will see, after compaction and `context_edit`) and calls
`estimateProjectedContextTokens` [dist/core/agent-session.js:3500-3534]. That function:

- takes the **last valid assistant message's provider usage** (`totalTokens`, or
  input+output+cacheRead+cacheWrite). It skips aborted, error and all-zero usage
  [dist/core/compaction/compaction.js:65-83, 110-135];
- **adds a chars/4 estimate** for every message after that one. This covers tool results,
  steering and custom messages. Images count as 4,800 chars
  [dist/core/compaction/compaction.js:124-134, 181-252];
- **falls back to a pure chars/4 estimate of the whole projection** when the last usage comes
  from before the newest `context_edit` or `compaction` entry
  [dist/core/compaction/compaction.js:137-169].

After a compaction, `tokens` and `percent` are `null` until an assistant response arrives after
it [dist/core/agent-session.js:3507-3526] [docs/rpc-commands.md:567]. So the value really is
measured only right after a model response. Once a `context_edit` is in the path, every number
is an estimate until the next response.

`contextWindow` comes from the routed model when there is one, otherwise from the selected model
(`_limitsModel()`) [dist/core/agent-session.js:310-312, 3501]. `percent` is relative to that
window. The domain's Pressure levels are token counts, so they should use `tokens`.

**When it changes.** The projection is rebuilt from persisted entries. A message is persisted in
the `message_end` handling, **after** the extension `message_end` handlers have run
[dist/core/agent-session.js:751-768]. So:

- **per assistant response:** yes. Read it in `turn_end`. A `message_end` handler for the
  assistant message still sees the previous value, because that message is not persisted yet.
- **after tool results:** yes. Each `toolResult` message is persisted at its own `message_end`,
  and its size is added by the chars/4 estimate. `turn_end` sees the whole batch
  [agent-core:agent-loop.js:164-185]. Unverified: the exact interleaving of tool-result
  `message_end`s within a parallel batch.
- **mid-stream:** no. The response being streamed is not in the projection. The only mid-stream
  signal is `message_update`, whose message carries cumulative provider usage that "can remain
  zero until completion when a provider does not report usage while streaming"
  [docs/json.md:96-100]. Whether that usage arrives mid-stream depends on the provider.

**Pi's own trigger uses the same numbers.** `shouldCompact` is
`contextTokens > contextWindow - reserveTokens` [dist/core/compaction/compaction.js:173-177].
Pi checks it at three points:

- between turns of a run, after the tool results are appended, inside `prepareNextTurn`
  [dist/core/agent-session.js:417-432, 534-541];
- before a new prompt [dist/core/agent-session.js:1480-1486];
- after the run, together with overflow recovery [dist/core/agent-session.js:1559, 2391-2510].

The built-in footer shows `percent` of the window. It turns warning-coloured above 70% and
error-coloured above 90% [dist/modes/interactive/components/footer.js:118-136, 170-185].

## 2. Starting a compaction

### 2a. `ctx.compact(options?)`

```ts
export interface CompactOptions {
    customInstructions?: string;
    onComplete?: (result: CompactionResult) => void;
    onError?: (error: Error) => void;
}
/** Trigger compaction without awaiting completion. */
compact(options?: CompactOptions): void;
```
[dist/core/extensions/types.d.ts:204-208, 249-250]

- **Does it wait?** No. It returns `void` at once and fires `void (async () => { await this.compact(...) })()`.
  The result arrives only through `onComplete`/`onError` [dist/core/agent-session.js:2831-2842].
- **What it does.** It calls `AgentSession.compact(customInstructions)`. The method's
  documentation says: "This is the manual entry point used by `/compact`, RPC, and extensions …
  Aborts the current agent operation first. Manual compaction never retries or continues the
  interrupted agent turn" [dist/core/agent-session.js:2215-2231]. The first line is
  `await this.abort()`. `abort()` aborts the agent, any retry, any compaction already running
  (including pi's own auto-compaction) and any branch summary. Then it waits for idle
  [dist/core/agent-session.js:1971-1982, 2360-2363].
- **Reason reported.** `session_before_compact` gets `reason: "manual"`, `willRetry: false`, and
  the `customInstructions` passed in [dist/core/agent-session.js:2253-2262]. Nothing marks it as
  started by an extension rather than `/compact`. An extension that needs to tell the two apart
  has to set a flag of its own, or a marker in `customInstructions`, before calling it.
- **Where it may be called from:**
  - *Between runs* (idle, a command, `agent_settled`): fine. Nothing is running, so the abort is
    a no-op. This is the `/trigger-compact` command in the example
    [examples/extensions/trigger-compact.ts:43-49].
  - *A tool's `execute`* or *`turn_end`*: it works, but **the run is aborted and does not
    resume**. The bundled example calls it from `turn_end` once a fixed token count is crossed
    [examples/extensions/trigger-compact.ts:27-41], so the example interrupts the agent.
  - *`agent_before_settle`*: unverified. `abort()` sets `_abortDuringBeforeSettle`, which makes
    the boundary return "do not continue" [dist/core/agent-session.js:1576-1577, 1978-1979]. The
    compaction would then run once the session is idle. Returning a compaction draft (2b) is
    the cleaner path from here.
- RPC `compact` is the same method [dist/modes/rpc/rpc-mode.js:417-419]. So is
  `RpcClient.compact()` [dist/modes/rpc/rpc-client.js:238-240].

### 2b. A compaction draft at an actionable boundary

`turn_end` and `agent_before_settle` handlers receive `BoundaryState` and may return
`{ entries?, continue? }`. The entries can include a compaction draft:

```ts
export interface CompactionEntryDraft {
    type: "compaction";
    summary: string;
    /** Null creates a self-retaining compaction that keeps no preceding entries. */
    firstKeptEntryId: string | null;
    details?: unknown;
    usage?: Usage;
}
export type SessionBoundaryDraft = CustomEntryDraft | CustomMessageEntryDraft | ContextEditEntryDraft | CompactionEntryDraft;
export interface BoundaryState { entries: SessionBoundaryDraft[]; continue: boolean; context: BoundaryContextPreview; outcome: AgentActivityOutcome; }
export interface BoundaryResult { entries?: SessionBoundaryDraft[]; continue?: boolean; }
```
[dist/core/extensions/types.d.ts:753-799, 828-835, 1085-1086] [docs/extensions.md:211, 230]

How it runs:

- **Ordering.** The agent loop runs `finishTurn`, which dispatches the `turn_end` boundary,
  **after** the tool batch's results are pushed. Only then does it go back to `prepareNextTurn`
  and `prepareRequest` [agent-core:agent-loop.js:164-185, 95-132]. Pi commits the drafts with
  `_commitBoundaryDrafts` and refreshes `agent.state.messages` from the projection
  [dist/core/agent-session.js:505-514, 570-577, 635-640]. The next turn's context is rebuilt
  from the projection, which now holds the compaction
  [dist/core/agent-session.js:423-431, 439-445]. The run is not aborted, and a turn with
  pending tool calls goes on as normal.
- **Handlers are awaited** in order, and each sees the drafts proposed so far
  [dist/core/extensions/runner.js:759-806]. A summarizer call made inside `turn_end` therefore
  holds up the run until it finishes. The event has no signal of its own; use `ctx.signal`.
- **Validation.** After each handler, pi builds a preview session with the drafts applied. If
  that throws, **every** draft is dropped and `continue` is forced to false
  [dist/core/extensions/runner.js:788-805]. `tokensBefore` is computed by pi
  [dist/core/agent-session.js:592-595]. Pi does **not** check `firstKeptEntryId`. An id that is
  not on the path keeps nothing before the compaction, the same as `null` (see 3).
- **What it skips.** `_applyBoundaryDrafts` calls `appendCompaction(..., fromHook=true, ...)`
  directly [dist/core/agent-session.js:592-595]. No `session_before_compact`, no
  `session_compact`, no `compaction_start`/`compaction_end`. The only event is `entry_appended`
  [dist/core/agent-session.js:638-639], which RPC forwards [dist/modes/rpc/rpc-mode.js:265-266].
  `docs/json.md:122` describes `entry_appended` only for `pi.appendEntry()`, but the code emits
  it for boundary entries too. There is no default summary to fall back on, because the
  extension must supply `summary`.
- `continue: true` asks for one more model request when the run would otherwise stop. It is
  checked against `canContinue` [dist/core/agent-session.js:515-519, 615-634, 1566-1589].

### 2c. Can a tool's result say "compact before the next request" without ending the run?

Not by itself. A tool result has `content`, `details`, `isError` and `terminate`, and none of
them asks for a compaction [docs/extensions.md:247-253]. But the extension can build it in two
steps:

1. The Self-compaction tool's `execute` returns normally. Its arguments can carry the agent's
   own Handoff text, and it records "compact now" (for example in `details`).
2. The same extension's `turn_end` handler sees `event.toolResults` and
   `event.toolResultEntryIds`, plus `event.messageEntryId` for the assistant message that made
   the call [dist/core/extensions/types.d.ts:828-835]. It returns a compaction draft. The next
   request in the **same run** sees the compacted context.

Keeping the Self-compaction call and its result is a valid cut: an assistant message is a cut
point, and its tool results follow it [dist/core/compaction/compaction.js:253-266, 287-305].
To keep them, use `firstKeptEntryId = event.messageEntryId`.

**Calling `ctx.compact()` from the tool instead ends the run** (2a). A tool can also return
`terminate: true` and leave the compaction to `agent_before_settle`. That run then ends at
settle, so it does not keep working either.

Pi's own threshold path is the only built-in compaction that runs between turns without
aborting [dist/core/agent-session.js:423-431]. It is private (`_runAutoCompaction`), and an
extension cannot change `reserveTokens` at runtime. `ExtensionContext` exposes no
`settingsManager` [dist/core/extensions/types.d.ts:213-253].

## 3. Hooks around compaction

### `session_before_compact`

```ts
export interface SessionBeforeCompactEvent {
    type: "session_before_compact";
    preparation: CompactionPreparation;
    branchEntries: SessionEntry[];
    customInstructions?: string;
    reason: "manual" | "threshold" | "overflow";
    willRetry: boolean;
    signal: AbortSignal;
}
export interface SessionBeforeCompactResult { cancel?: boolean; compaction?: CompactionResult; }
```
[dist/core/extensions/types.d.ts:600-611, 1137-1140]

```ts
export interface CompactionPreparation {
    firstKeptEntryId: string;
    messagesToSummarize: AgentMessage[];
    turnPrefixMessages: AgentMessage[];
    isSplitTurn: boolean;
    tokensBefore: number;
    previousSummary?: string;
    fileOps: FileOperations;
    settings: CompactionSettings;   // { enabled, reserveTokens, keepRecentTokens }, model overrides applied
}
export interface CompactionResult<T = unknown> {
    summary: string; firstKeptEntryId: string; tokensBefore: number;
    estimatedTokensAfter?: number; usage?: Usage; details?: T;
}
```
[dist/core/compaction/compaction.d.ts:18-32, 118-134] [docs/compaction.md:297-331]

- **Fires for** `/compact`, `ctx.compact()` and RPC `compact` (`"manual"`), pi's threshold check
  (`"threshold"`), and overflow or length recovery (`"overflow"`, where `willRetry` is true
  when the failed turn is retried) [dist/core/agent-session.js:2253-2262, 2543-2552].
  It does **not** fire for boundary drafts (2b).
- **It runs only after pi has prepared.** If `prepareCompaction` returns `undefined` (the last
  entry is already a compaction, or there is nothing to summarize), the hook never fires
  [dist/core/agent-session.js:2243-2251, 2533-2536] [dist/core/compaction/compaction.js:609-612, 642-643].
- **Cancel:** return `{ cancel: true }`. The first handler that cancels wins and the remaining
  handlers are skipped [dist/core/extensions/runner.js:813-825]. A cancelled compaction emits
  `compaction_end` with `aborted: true` and `session_compact_failed`
  [dist/core/agent-session.js:2263-2266, 2331-2351]. A threshold cancel has no retry, so the
  next check fires the hook again. The overflow backstop in particular should not be cancelled
  casually (recovery is "one compact-and-retry attempt", [dist/core/agent-session.js:2445-2465]).
- **Custom content:** return `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage?, details? } }`.
  Pi saves exactly these fields with `fromHook: true` and emits
  `session_compact { compactionEntry, fromExtension: true, reason, willRetry }`
  [dist/core/agent-session.js:2267-2284, 2297-2311, 2557-2600]. When several handlers return a
  result, the **last** one wins [dist/core/extensions/runner.js:819-822].
- **Fallback to pi's default:** return `undefined`, or throw. A throw is reported as an
  extension error and treated as no result [dist/core/extensions/runner.js:827-836]. Pi then
  runs `_runDefaultCompaction` [dist/core/agent-session.js:2285-2293, 2576-2584]. This is the
  mechanism behind the map's "pi's default summary is the fallback if ours fails". The bundled
  example falls back the same way [examples/extensions/custom-compaction.ts:28-32, 95-115].
  A summary that is returned and then fails downstream does **not** fall back. It surfaces as
  `session_compact_failed { fromExtension: true }` [dist/core/extensions/types.d.ts:622-635].
- **`signal`:** the compaction's abort controller. Esc/`abort()` aborts it
  [dist/core/agent-session.js:2360-2363]. Pass it to the summarizer call.
- **Custom `firstKeptEntryId`:** pi accepts any string. It does not check that the id is on
  the path or is a valid cut point [dist/core/agent-session.js:2280, 2297]
  [dist/core/session-manager.js:880-899]. When context is rebuilt, entries before the
  compaction are kept only from the entry whose id matches. **An id that matches nothing keeps
  nothing** [dist/core/session-manager.js:201-228]. Moving it later than `preparation`'s means
  the extension must summarize the extra span itself from `branchEntries`. Moving it so that a
  tool result is kept without its call breaks pi's own rule ("Never cut at tool results")
  [docs/compaction.md:128-136]. Unverified: what the provider does with such an orphaned
  result.
- **`tokensBefore`:** in this path pi saves whatever the extension returns
  [dist/core/agent-session.js:2281, 2297]. Pass `preparation.tokensBefore` through. That value
  is pi's own projected estimate [dist/core/compaction/compaction.js:627].
- **`details`:** any JSON. Pi carries file lists forward only from its *own* summaries, not from
  `fromHook` ones, so an extension that wants cumulative read and modified files must keep them
  in its own `details` [docs/compaction.md:200-204].

### How `keepRecentTokens` and the cut rules limit it

- Pi walks back through the projection, summing chars/4 estimates until it reaches
  `keepRecentTokens` (default 20,000). It cuts at the nearest valid cut point at or after that
  entry: a user, assistant, bashExecution, custom, branchSummary or compactionSummary message,
  never a tool result [dist/core/compaction/compaction.js:253-266, 555-608]
  [docs/compaction.md:43-49, 128-138].
- When one user-message span is larger than the budget, pi splits it (`isSplitTurn`), and
  `turnPrefixMessages` holds the start of the span [docs/compaction.md:100-126]
  [dist/core/compaction/compaction.js:633-641].
- The span to summarize starts at the previous compaction's kept boundary, and
  `previousSummary` is the previous summary [dist/core/compaction/compaction.js:618-625].
- `reserveTokens` and `keepRecentTokens` come from `compaction.*` settings, with
  `compaction.modelOverrides["provider/id"]` applied, and are read when the compaction starts
  [docs/compaction.md:417-461] [dist/core/agent-session.js:2241, 2523].
- These limits bind only `preparation`. A hook result, or a boundary draft, sets its own
  `firstKeptEntryId`. `prepareCompaction` and `estimateProjectedContextTokens` are **not**
  exported from the package, whose `exports` map has only `.` and `./rpc-entry`
  [dist/index.d.ts:6] [package.json `exports`]. So a boundary-draft path that wants pi's cut
  has to reimplement it. The exported `findCutPoint`/`estimateTokens` work on raw entries,
  and `buildSessionProjection` is exported [dist/index.d.ts:6, 21].
- The serialization pi uses to summarize cuts each tool result to 2,000 chars and drops
  thinking blocks [docs/compaction.md:276-291]. `serializeConversation` and `convertToLlm` are
  exported for an extension's own summarizer [dist/index.d.ts:6, 12].

### Other hooks that matter here

- `session_compact` (after success) and `session_compact_failed` (after failure or abort,
  carrying `reason`, `errorMessage`, `aborted`, `willRetry` and `fromExtension`)
  [dist/core/extensions/types.d.ts:612-635].
- **Pruning primitives:**
  - a `context_edit` draft from `turn_end`/`agent_before_settle` (`replacement: null` omits a
    user, assistant, toolResult or custom_message entry; `{ content }` replaces its content).
    It is persisted, follows the branch, and is checked when applied: the target must exist, be
    on the active branch and be editable [dist/core/extensions/types.d.ts:765-769]
    [dist/core/session-manager.js:961-998] [docs/session-format.md:139-144, 235];
  - `tool_result`, which rewrites a result before it is persisted
    [dist/core/extensions/types.d.ts:1110-1120];
  - `context`, which filters the messages for a single request and persists nothing
    [dist/core/extensions/types.d.ts:672-682].

## 4. UI: surfaces for a persistent Pressure level

From `ExtensionUIContext` [dist/core/extensions/types.d.ts:72-196]:

| Surface | Call | TUI | RPC |
|---|---|---|---|
| Footer status line | `setStatus(key, text \| undefined)` | One line under the built-in footer. Every extension's statuses are joined, sorted by key, newlines collapsed, cut to terminal width [dist/modes/interactive/components/footer.js:10-16, 250-260] | `extension_ui_request {method:"setStatus", statusKey, statusText}` [dist/modes/rpc/rpc-mode.js:101-109] |
| Widget above or below the editor | `setWidget(key, string[] \| factory \| undefined, { placement: "aboveEditor" \| "belowEditor" })` | Lines or a component [dist/core/extensions/types.d.ts:49-52, 100-104] | String arrays only. Factories are ignored [dist/modes/rpc/rpc-mode.js:123-136] [docs/rpc-extension-ui.md:129-145] |
| Whole footer | `setFooter(factory \| undefined)` (`footerData` gives git branch and the extension statuses) | Replaces the built-in footer [dist/core/extensions/types.d.ts:105-113] | **No-op** [dist/modes/rpc/rpc-mode.js:137-139] |
| Working indicator/message | `setWorkingMessage`, `setWorkingIndicator`, `setWorkingVisible` | While streaming | No-op [dist/modes/rpc/rpc-mode.js:110-121] |
| Toast | `notify(message, "info" \| "warning" \| "error")` | Transient | `notifyType` [docs/rpc-extension-ui.md:97-111] |

There are **three notification levels: `info`, `warning`, `error`** (default `info`)
[dist/core/extensions/types.d.ts:80]. The persistent options are `setStatus`, `setWidget` and
`setFooter`, and only the first two cross RPC. `docs/tui.md:12-14` recommends `notify`/`setStatus`
for non-blocking feedback and `setWidget` for persistent content. Guard terminal-only calls with
`ctx.mode === "tui"`. `ctx.hasUI` is true in TUI and RPC [dist/core/extensions/types.d.ts:212-219]
[docs/extensions.md:363-366]. The built-in footer's own context figure (percent, coloured at
70% and 90%) stays visible, and an extension can replace it only with `setFooter`.

## 5. Runs: compaction in a `--mode rpc --no-session` child

**How a Run is spawned.** `extensions/subagents/child.ts` starts each Run with `RpcClient`
using `--no-session --no-extensions -e <subagents index.ts> --tools <allowlist + ask_question>`
[extensions/subagents/child.ts:159-165, 224-234]. Two consequences:

- **The child loads only the extensions given with `-e`.** `--no-extensions` turns off discovery
  "(explicit -e paths still work)" [dist/cli/args.js:320]. A compaction extension in its own
  directory reaches a Run only if `childArgs` adds a second `-e`, or if the subagents extension
  imports it.
- **`--tools` is a strict allowlist and includes extension tools** [docs/cli.md:119-128]. A
  Self-compaction tool must be appended in `childArgs`, the way `ask_question` is
  [extensions/subagents/child.ts:154-160]. Unverified: whether `pi.setActiveTools()` from the
  child's `session_start` could add it outside the allowlist.

**Does compaction work with `--no-session`?** By reading the code, yes. `--no-session` only
swaps in `SessionManager.inMemory(...)` [dist/main.js:286-287]. Compaction, `context_edit` and
boundary drafts all go through that session manager's `append*` and `buildSessionProjection`,
whether or not a file backs it [dist/core/session-manager.js:880-899, 961-998]. Settings,
including `compaction.*`, still come from the settings manager. Not tested in a running child.
`ctx.hasUI` is true in RPC, so the child's extension can call `setStatus`/`setWidget`/`notify`.

**What reaches the parent's `RpcClient`.** RPC writes every session event to stdout through
`toJsonEvent` [dist/modes/rpc/rpc-mode.js:265-266] [dist/modes/json-event.js:16-28].
`RpcClient.handleLine` passes **every non-response line** to the `onEvent` listeners, including
`extension_ui_request` [dist/modes/rpc/rpc-client.js:412-427]. Those UI requests are not in the
`JsonAgentSessionEvent` type that `RpcEventListener` declares [dist/modes/rpc/rpc-client.d.ts:34],
but `RpcExtensionUIRequest` is exported [dist/index.d.ts:36]. The events that carry a child's
pressure or compaction:

| Signal | Event |
|---|---|
| Pressure (raw) | `message_end` with `message.usage` (assistant), and `message_update.usage` mid-stream if the provider reports it [docs/json.md:62-100] |
| Pressure (pi's own number) | not an event. RPC `get_session_stats` returns `contextUsage` [docs/rpc-commands.md:526-567] (`RpcClient.getSessionStats()` [dist/modes/rpc/rpc-client.js:276]) |
| Pressure level, as the child's extension computes it | `extension_ui_request {method:"setStatus"}` or `{method:"setWidget"}` |
| Compaction via hook paths | `compaction_start {reason}`, `compaction_end {reason, result, aborted, willRetry, errorMessage?}` [docs/json.md:128-160] |
| Compaction via boundary draft | `entry_appended {entry}` with `entry.type === "compaction"` [dist/core/agent-session.js:638-639] |

The Supervisor already reads `message_end` from the child
[extensions/subagents/supervisor.ts:283]. Inference: pressure can be measured on the parent
side from `message_end` usage, without polling.

## 6. Cache

- **The summary request itself** is sent with `cacheRetention: "none"` and a fresh routing
  `sessionId`. The conversation goes in as one serialized text block inside a single user
  message [dist/core/compaction/compaction.js:477-489, 500-532] [docs/compaction.md:23]. It
  neither writes nor reuses the conversation's cache. The bundled custom summarizer does the
  same [examples/extensions/custom-compaction.ts:79-88].
- **After a compaction** the prefix changes, so the next request starts its cache from scratch.
  Pi's cache-miss accounting deliberately does not count that miss: "The context legitimately
  changed" [dist/core/cache-stats.js:59-64]. The compaction entry snapshots the current system
  message [dist/core/session-manager.js:882, 895].
- **`context_edit`** gets no such exemption in the miss accounting
  [dist/core/cache-stats.js:54-88]. Inference: an edit to an early entry changes the prefix from
  that point on, and the following request is billed as a miss. Pruning old entries costs a
  cache rebuild each time, so batching Prunings, or doing them alongside a compaction, is
  cheaper.
- **Idle cache warming** (`cacheWarming`) can be overridden with `cache_warming_decision`
  [docs/settings.md:20-23] [docs/extensions.md:232-234]. Nothing ties it to compaction.
- Inference, unverified: a Handoff written by the agent itself as a Self-compaction tool
  argument (2c) is just another turn on the cached prefix, so it is the cheapest Handoff. A
  separate summarizer call pays for all of its input uncached.

## What the downstream decisions need, mapped

| Decision | What pi allows |
|---|---|
| Who writes the Handoff | For hook paths (`/compact`, the backstop, `ctx.compact`), a `session_before_compact` handler, with pi's default as the fallback. For boundary drafts (Self-compaction, a forced level mid-run), only the extension. Pi never runs its summarizer there. One writer, called from both. |
| Self-compaction contract | Tool plus `turn_end` compaction draft. The run continues, the agent's own Handoff can be an argument, and `firstKeptEntryId` is chosen by the extension. Not `ctx.compact()`, which ends the run. |
| Forced level | Same boundary-draft path from `turn_end`. `ctx.compact()` only when idle. |
| Pressure level UI | `setStatus` (footer line) and/or `setWidget`. Both reach the parent over RPC. `setFooter` is TUI-only. Three notify levels. |
| A Run's pressure in the parent | The child's `setStatus`/`setWidget` `extension_ui_request`, or the parent computes it from `message_end` usage. Compaction shows up as `compaction_*` or `entry_appended`. |
| A Run gets the extension | `childArgs` must add `-e <compaction ext>` (or the subagents extension loads it) and append the Self-compaction tool to `--tools`. |

## Gaps and open questions

- Whether calling `ctx.compact()` inside `agent_before_settle` compacts cleanly after the
  settle. Read, not run (2a).
- Whether `pi.setActiveTools()` can add a tool outside a child's `--tools` allowlist (5).
- Whether a tool result orphaned by a custom `firstKeptEntryId` breaks a provider request (3).
- Compaction in a `--no-session` RPC child was confirmed by reading the code only (5).
- The exact order in which a parallel tool batch persists its results, which decides what
  `getContextUsage()` returns while that batch is running (1).
- `examples/extensions/custom-compaction.ts:4-7` says it summarizes everything and keeps
  nothing, but it returns `preparation.firstKeptEntryId` (line 105), which keeps the recent
  tail. The comment is out of date. The code is right.
