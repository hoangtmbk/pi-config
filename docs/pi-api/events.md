# Events, turn boundaries and compaction

Pinned to pi 1.4.0; see [README](README.md) for citations and staleness. The full event list is
`ExtensionAPI.on` in `dist/core/extensions/types.d.ts:1187-1227`; how each kind of handler composes
is the table in pi's `docs/extensions.md` ("Understand handler composition"). What can't be done
from these events is in [limits.md](limits.md).

## `turn_end`

```ts
// types.d.ts:828, BoundaryState :786
interface TurnEndEvent extends BoundaryState {
  type: "turn_end"; turnIndex: number;
  message: AgentMessage;           // this turn's assistant message
  toolResults: ToolResultMessage[];
  messageEntryId: string;          // persisted entry ids of the above
  toolResultEntryIds: string[];
}
interface BoundaryState {
  entries: SessionBoundaryDraft[]; // drafts proposed by EARLIER handlers
  continue: boolean;
  context: BoundaryContextPreview; // the projection with `entries` applied
  outcome: "completed" | "aborted" | "error";
}
type TurnEndEventResult = { entries?: SessionBoundaryDraft[]; continue?: boolean };  // :1085
```

- **When it fires:** from pi-agent-core's `finishTurn` hook (`dist/core/agent-session.js:487-532`),
  after the assistant message and every tool result of the turn are persisted, before the steering
  queue is polled (`pi-agent-core/dist/agent-loop.js:184-191`). So every tool's `execute` has
  returned, and queued steers are not yet in the context. On an `aborted` or `error` stop the
  boundary still fires, then the run ends (`agent-loop.js:146-158`).
- **Return an object, and spread what came in:** `return { entries: [...event.entries, ...mine] }`.
  The returned `entries` *replaces* the running list (`dist/core/extensions/runner.js:775`), so
  leaving out `event.entries` deletes earlier handlers' drafts.
- **`outcome`** is derived from the assistant message's `stopReason` only
  (`agent-session.js:488-489`); see [limits.md](limits.md) for Escape during tools.
- **`event.context.llmMessages`** is `convertToLlm` of the preview projection and starts with the
  system message(s) carrying the prompt and tool declarations. Custom messages (`pi.sendMessage`)
  appear there as `role: "user"` (`dist/core/messages.js:89-96`), indistinguishable from typed user
  messages: to find what the user typed, read session entries with `type: "message"` and
  `message.role: "user"`.
- Handlers are awaited and never cancelled by pi; honouring `ctx.signal` is the handler's job.
- `continue: true` asks for one more model request, and is dropped with an error line if the context
  can't continue (`agent-session.js:515-518`). Guard it: an unconditional `continue` loops.

`agent_before_settle` (`types.d.ts:797-799`) is the other actionable boundary: same `BoundaryState`,
fired once before the run settles.

### How pi chains the handlers and drops drafts

`emitBoundary` (`runner.js:759-806`):

```
entries = []; context = buildContext(entries)
for each handler, in extension load order:
    result = await handler({...base, entries, continue, context}, ctx)   // a throw is logged, loop goes on
    if result?.entries !== undefined: entries = result.entries
    if result?.continue !== undefined: continue = result.continue
    try   { context = buildContext(entries); valid = true }
    catch { valid = false; emitError("Invalid boundary entries: …") }
return valid ? { entries, continue, context } : { entries: [], continue: false }
```

- **All or nothing.** `valid` is recomputed after every handler and only the last state counts: one
  bad draft from any extension, before or after yours, drops every draft at that boundary. The only
  signal is an extension error line. To know whether yours landed, look for it on the branch later,
  by something unique to that draft (an id in `details`), not just by "the newest entry isn't mine".
- `buildContext` (`agent-session.js:615-634`) replays the drafts on an in-memory copy of the branch
  (`SessionManager.inMemory`, `:603-610`) and projects it. It throws exactly when an
  `appendContextEdit` would throw (below).
- On commit (`agent-session.js:635-640`) pi appends the drafts to the real session, refreshes the
  agent's context (so the next request *in the same run* is built from it), and emits
  `entry_appended` per entry. That event is what an RPC client sees for a boundary compaction: there
  is no `compaction_start`/`compaction_end`.

### Drafts

```ts
// types.d.ts:753-777
{ type: "custom"; customType: string; data?: unknown }
{ type: "custom_message"; customType: string; content: string | (TextContent | ImageContent)[]; display: boolean; details?: unknown }
{ type: "context_edit"; targetId: string; replacement: { content: ContextEditableContent } | null }
{ type: "compaction"; summary: string; firstKeptEntryId: string | null; details?: unknown; usage?: Usage }
```

- A `compaction` draft has no `tokensBefore`: pi computes it when the draft is applied, from the state
  at that point in the list (`agent-session.js:592-594`). Put the compaction before any edits in the
  list to record the true pre-compaction size.
- pi appends it with `fromHook: true` (`agent-session.js:594`), as it does for every compaction an
  extension supplies, so `fromHook` can't tell two extensions apart: mark yours in `details`.
- `firstKeptEntryId: null` keeps no earlier entries.
- Pass `usage` for the model calls that produced the summary: the TUI's compaction card shows a cost
  line from it, and session totals include it.
- A boundary compaction bypasses `session_before_compact` and pi's summarizer entirely
  (`_applyBoundaryDrafts`, `agent-session.js:578-601`, calls `appendCompaction` directly).

### `context_edit` replay rules

`appendContextEdit` (`dist/core/session-manager.js:962-998`) throws, which drops the whole boundary,
when:

1. `replacement` is neither `null` nor `{ content: string | array }`;
2. `targetId` isn't in the session;
3. the target isn't on the active branch;
4. the target isn't editable: only `custom_message` entries and `message` entries with role `user`,
   `assistant` or `toolResult` are.

Checking these four against `ctx.sessionManager` (`getEntry`, `getBranch`) before returning a draft
keeps one stale target from sinking everything. Also:

- The replacement swaps the entry's whole `content`; role, `toolCallId`, `isError` and the rest stay.
  A string on an `assistant` or `toolResult` target is normalised to one text block.
- `null` omits the entry from context. Don't omit a `toolResult`: its tool call is then left without a
  result.
- The latest edit per target wins.
- An edit whose target sits in a span a compaction removed validates but does nothing.

## `session_before_compact`

Fires for pi's own compactions: `/compact`, the threshold trigger (window − `reserveTokens`), and
overflow recovery.

```ts
// types.d.ts:601-611
interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  preparation: CompactionPreparation;   // compaction.d.ts:118
  branchEntries: SessionEntry[];        // raw branch: content before any context_edit
  customInstructions?: string;          // the text after `/compact`
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;                   // overflow recovery that retries the turn
  signal: AbortSignal;                  // the compaction's own signal
}
interface CompactionPreparation {
  firstKeptEntryId: string; messagesToSummarize: AgentMessage[]; turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean; tokensBefore: number; previousSummary?: string;
  fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
  settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };  // resolved for the model
}
// types.d.ts:1137-1140
interface SessionBeforeCompactResult { cancel?: boolean; compaction?: CompactionResult }
interface CompactionResult { summary: string; firstKeptEntryId: string; tokensBefore: number;
                             estimatedTokensAfter?: number; usage?: Usage; details?: unknown }
```

- Composition (`runner.js:813-839`): for `session_before_*` events the last truthy result wins and a
  `cancel` returns at once. `undefined`, or a throw (logged), leaves pi's default summary.
- Return `preparation.firstKeptEntryId` and `preparation.tokensBefore` unless you mean otherwise: pi
  doesn't validate a custom `firstKeptEntryId`.
- The removed span is `messagesToSummarize` plus, when `isSplitTurn`, `turnPrefixMessages`. These are
  projected (edited) messages; `branchEntries` has the raw ones.
- Model calls take `event.signal`: [limits.md](limits.md).
- `/compact` reports `Already compacted` when the branch's last entry is a compaction, and `Nothing to
  compact (session too small)` when there is nothing to cut; the hook doesn't fire in either case.
- Afterwards pi emits `session_compact` (`{ compactionEntry, fromExtension, reason, willRetry }`) on
  success, or `session_compact_failed` (`{ reason, errorMessage?, aborted }`) on failure or cancel
  (`types.d.ts:613-630`).
- The threshold check runs between turns inside a run (`_compactBeforeNextAssistantResponse`,
  `agent-session.js:423-432`), after the previous boundary's drafts are committed. Overflow order is
  in pi's `docs/compaction.md`.

## The compaction entry

```ts
// session-manager.d.ts:46-59
interface CompactionEntry<T = unknown> {
  type: "compaction"; id: string; parentId: string | null; timestamp: string;
  summary: string; firstKeptEntryId: string; tokensBefore: number;
  details?: T; usage?: Usage; fromHook?: boolean;
  systemMessage?: SystemMessage;   // prompt and tool state at the compaction
}
```

- Only the newest compaction on the branch counts. The context after it is: the compaction, then the
  entries from `firstKeptEntryId` up to the compaction (system messages skipped), then everything after
  it (`buildContextEntries`, `session-manager.js:202-232`).
- The entry projects to `[systemMessage?, compactionSummary]` (`session-manager.js:187-190`), and
  `convertToLlm` sends the summary as a user message wrapped in `COMPACTION_SUMMARY_PREFIX` ("The
  conversation history before this point was compacted into the following summary: <summary>") and
  its suffix (`messages.js:103-109`).
- `getLatestCompactionEntry(entries)` is exported from the package root.

## Cut points

Exported (`compaction.d.ts`): `findCutPoint(entries, startIndex, endIndex, keepRecentTokens):
{ firstKeptEntryIndex, turnStartIndex, isSplitTurn }` (`:94`), `findTurnStartIndex`, and
`estimateTokens(message)` (characters / 4, `:64`).

`findCutPoint` (`compaction.js:334-380`) walks back from `endIndex - 1`, summing `estimateTokens` of
each entry's raw messages until it reaches `keepRecentTokens`, then takes the first valid cut point at
or after that entry. Valid cut points are entries that contribute a user, assistant, bashExecution,
custom, branchSummary or compactionSummary message, never a tool result. `isSplitTurn` is true when the
cut isn't at a turn start.

To cut as pi's `/compact` would (see [limits.md](limits.md) for why the plain call doesn't):

1. `proj = ctx.sessionManager.buildSessionProjection()`.
2. Map `proj.entries` back to entries carrying projected content: for a `message` entry,
   `{ ...p.sourceEntry, message: p.messages[0] ?? p.sourceEntry.message }`; give an omitted entry no
   messages (e.g. map it to a `custom` entry).
3. `startIndex` = 1 if `proj.entries[0].sourceEntry.type === "compaction"`, else 0.
4. `findCutPoint(entries, startIndex, entries.length, keepRecentTokens)`.
5. The removed span is `[startIndex, isSplitTurn ? turnStartIndex : firstKeptEntryIndex)`.
6. If the branch's last entry is already a compaction, there is nothing to do.

Inside a tool's `execute`, the branch ends at the assistant message holding the call (this turn's
results aren't persisted yet, though parallel siblings' may be), so a cut made there keeps that
message.

## Context pressure

```ts
// types.d.ts:197, :248
interface ContextUsage { tokens: number | null; contextWindow: number; percent: number | null }
ctx.getContextUsage(): ContextUsage | undefined
```

`agent-session.js:3500-3534`:

- `undefined` when there's no model or its `contextWindow <= 0`; under a virtual model, the window is
  the routed physical model's.
- `tokens: null` after a compaction until a non-aborted, non-error assistant reply with usage arrives.
- Otherwise: the last trusted assistant usage (`calculateContextTokens`, exported) plus characters / 4
  of everything after it. Usage from before a later `context_edit` or compaction isn't trusted, so the
  reading is pure characters / 4, usually an over-estimate, until the next reply.
- Read it in `turn_end`. `message_end` handlers run before the message is persisted
  (`agent-session.js:752-771`), so the reading there misses it.
