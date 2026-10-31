# Model calls from an extension

Pinned to pi 1.4.0; see [README](README.md) for citations and staleness. pi's `docs/extensions.md`
says to use `ctx.modelRegistry.streamSimple()` for nested model calls; this is what that call does
and doesn't do. [ADR 0004](../adr/0004-handoff-written-by-a-forked-call.md) records why matching the
agent's request shape matters for the provider cache.

## `ctx.modelRegistry.streamSimple`

```ts
// dist/core/model-registry.d.ts:39
streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
// pi-ai/dist/types.d.ts:543
interface Context { systemPrompt?: string; messages: Message[]; tools?: Tool[] }
// pi-ai/dist/types.d.ts:233, :107 (abridged)
interface SimpleStreamOptions extends StreamOptions {
  toolChoice?: "auto" | "none";     // not `tool_choice`
  reasoning?: ThinkingLevel;        // the thinking level; not `thinkingLevel`
  thinkingBudgets?: ThinkingBudgets;
}
interface StreamOptions {
  signal?: AbortSignal; maxTokens?: number; temperature?: number;
  cacheRetention?: CacheRetention;  // "none" drops cache markers and the prompt cache key
  sessionId?: string; transport?: Transport; metadata?: Record<string, unknown>;
  onPayload?(payload, model): unknown; /* … */
}
```

- **Auth** is resolved at request time (`dist/core/model-runtime.js:497-521`); no API key needed.
  The stream is lazy (`pi-ai/dist/api/lazy.js:45-66`): missing auth or an unknown provider arrives as
  an `error` event with `stopReason: "error"`, not as a throw. (Unverified: that pi-ai's own
  `streamSimple`, called directly, throws synchronously. It does for an `api` with no registered
  provider, `pi-ai/dist/compat.js:163-169`; for missing auth it depends on whether the provider is
  wrapped by `lazyStream`.)
- **A virtual model** is routed first, and `maxTokens` capped to the routed model's.
- **No extension hooks run**: see [limits.md](limits.md).
- **Other members:** `find(provider, modelId)` (`model-registry.d.ts:29`), `complete(...)`
  (`stream(...)` awaited to an `AssistantMessage`, `model-runtime.js:494-496`: it takes the
  provider-specific `ModelsApiStreamOptions`, not `streamSimple`'s options, and `ModelRegistry` has
  no `completeSimple`; await `streamSimple(...).result()` instead), `getApiKeyAndHeaders(model)` →
  `{ ok: true, apiKey?, headers?, baseUrl?, env? } | { ok: false, error }` (`:33`).

### What the agent's own request carries

`pi-agent-core/dist/agent.js:306-320` and `dist/core/sdk.js:268-287`: `reasoning` (`undefined` when
the level is `"off"`), `sessionId` (the session's id), `transport` and `thinkingBudgets` (from
settings), `onPayload`, `onResponse`, `maxRetryDelayMs`. Not `maxTokens`, `cacheRetention`,
`toolChoice` or `temperature`. A side call meant to share the agent's cached prefix passes the same
`reasoning`, `sessionId = ctx.sessionManager.getSessionId()`, and `thinkingBudgets` / `transport` from
`pi.getSettings()` when set, and leaves the other four unset. On Anthropic, a changed thinking budget
or `toolChoice` drops the cached conversation.

### Building the context

- **At a boundary:** `messages: [...event.context.llmMessages, yourUserMessage]`. `llmMessages`
  already starts with the system message carrying the prompt and tool declarations, so passing
  `systemPrompt` or `tools` as well adds a second system message and breaks the prefix.
- **Elsewhere:** `convertToLlm(ctx.sessionManager.buildSessionProjection().messages)` (`convertToLlm`
  is exported from the package root).
- **Inside a tool's `execute`:** the last assistant message has tool calls without results. Append one
  `ToolResultMessage` per call whose result isn't on the branch yet
  (`{ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp }`)
  before your user message.
- **Which model:** the last `role: "assistant"` message records `provider` and `model`;
  `ctx.modelRegistry.find(provider, model)` gives the physical model behind it, which under a virtual
  model differs from `ctx.model`.

### The stream

`AssistantMessageEventStream` (`pi-ai/dist/utils/event-stream.d.ts`) is an
`AsyncIterable<AssistantMessageEvent>` with `result(): Promise<AssistantMessage>`. Events
(`pi-ai/dist/types.d.ts:575`):

```
start → (text_* | thinking_* | toolcall_*)* →
  done { reason: "stop" | "length" | "toolUse" | …, message } | error { reason: "aborted" | "error", error }
```

- The final `AssistantMessage` (`types.d.ts:368`) has `content` (text, thinking, tool calls),
  `stopReason`, `errorMessage?` and `usage`. A provider error is `stopReason: "error"`, the token cap
  is `"length"`.
- For a stall timeout, reset a timer on every event and abort your own `AbortController`, combined
  with the run's signal, as `signal`.
- **In tests:** `createAssistantMessageEventStream()` from `@earendil-works/pi-ai` builds a real
  stream to `push()` events into and `end()`.

### Usage and cache misses

```ts
// pi-ai/dist/types.d.ts:285
interface Usage { input; output; cacheRead; cacheWrite; cacheWrite1h?; reasoning?; totalTokens;
                  cost: { input; output; cacheRead; cacheWrite; total } }
```

pi's own miss check (`dist/core/cache-stats.js`, `detectMiss`): prompt tokens are
`input + cacheRead + cacheWrite`; missed = `min(previous prompt tokens, this one's) − cacheRead`;
1,024 tokens or fewer is noise; a turn with no cache activity counts only if the provider reported
caching before. Mirror it to log a side call's misses the way pi counts the agent's.

## `generateSummary` / `generateSummaryWithUsage`

pi's own summarizer, exported from the package root. Arguments are **positional**:

```ts
// dist/core/compaction/compaction.d.ts:112, :114
generateSummary(currentMessages, model, _reserveTokens, apiKey, headers?, signal?, customInstructions?,
  previousSummary?, thinkingLevel?, streamFn?, env?, retry?, callbacks?, sessionId?): Promise<string>
generateSummaryWithUsage(/* same */): Promise<{ text: string; usage: Usage }>
```

- Prefer `generateSummaryWithUsage`, so a compaction can carry `usage`.
- It serializes the messages into one user message (`serializeConversation`, tool results cut to
  2,000 characters), adds `<previous-summary>` when given, and appends `customInstructions` as an
  additional focus.
- It always sends `cacheRetention: "none"` and `sessionId ?? uuidv7()`
  (`compaction.js:477-492`), and sends `reasoning` only when the model reasons and the level isn't
  `"off"` (`:463-469`). It never reads the agent's cache.
- It throws on `stopReason` `error` or `length`, and on any tool call.
- **Auth:** without `streamFn` it calls pi-ai directly with the `apiKey` / `headers` / `env` you pass:
  resolve them with `await ctx.modelRegistry.getApiKeyAndHeaders(model)`, or pass
  `streamFn = (m, c, o) => ctx.modelRegistry.streamSimple(m, c, o)`. The `streamFn` route also gives
  tests one seam for every model call.
- **Retry:** omitted means none. pi passes its retry settings; an extension can pass
  `pi.getSettings().retry` (`RetryPolicy`, `pi-ai/dist/utils/retry.d.ts`).
- On its own hook path pi also summarizes a split turn's prefix separately; one call over
  `messagesToSummarize` plus `turnPrefixMessages` is the simpler equivalent.
- `serializeConversation` is exported but hard-codes the 2,000-character cut; a different cut needs
  your own serializer.

## Other exports worth knowing

From the package root: `calculateContextTokens(usage)`, `estimateTokens(message)`,
`getLastAssistantUsage(entries)`, `shouldCompact(tokens, window, settings)` (`tokens > window −
reserveTokens`), `DEFAULT_COMPACTION_SETTINGS`, `findCutPoint`, `findTurnStartIndex`, `convertToLlm`,
`serializeConversation`, `buildSessionProjection`, `getLatestCompactionEntry`,
`sessionEntryToContextMessages`, and `SessionManager` (with `static inMemory`, useful in tests).
Not exported: see [limits.md](limits.md).
