# Can a forked call hit the provider cache?

Date: 2026-10-30

Question (issue #27, child of map #16): can an extension's **forked call** hit the provider's
prompt cache on `openai-codex` (GPT-6.1 Sol, Codex sign-in) and on Anthropic (Claude Fable 5),
from `session_before_compact` and from `turn_end`? A forked call sends the live conversation
exactly as the agent's next turn would (same system prompt, tools, messages, model, thinking
level and session id), plus one closing Handoff instruction, and its output is never persisted.
Covers: (1) whether an extension can rebuild the request closely enough, and which pieces are
public, private or need copying; (2) what the fork can append or change, and how to stop it
calling tools; (3) how to confirm a hit and what a miss costs.

Terms follow `CONTEXT.md` (Compaction): *Handoff*, *Self-compaction*, *Pressure level*.
**V** marks what I verified by reading code or docs or by running a test. **I** marks what I inferred.

Sources:

- **pi** is `@earendil-works/pi-coding-agent`, `pi-agent-core` and `pi-ai`, all `1.4.0`, installed
  in the repo root's `node_modules/`. `[ca:…]` = `pi-coding-agent/dist/core/…`,
  `[core:…]` = `pi-agent-core/dist/…`, `[ai:…]` = `pi-ai/dist/api/…`. `extensions.md` is
  `pi-coding-agent/docs/extensions.md`.
- **Local**: `~/.pi/agent/settings.json` (default `openai-codex/gpt-6.1-sol`), `models-store.json`
  (model entries), provider *types* in `auth.json` (both `oauth`; no secrets read), and a grep of
  this repo's `extensions/` for request-shaping hooks.
- **OpenAI prompt caching**: <https://developers.openai.com/api/docs/guides/prompt-caching>, and
  **OpenAI reasoning**: <https://developers.openai.com/api/docs/guides/reasoning>, both fetched 2026-10-30.
- **Anthropic prompt caching**: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>,
  **thinking**: <https://platform.claude.com/docs/en/build-with-claude/thinking>, and **extended
  thinking**: <https://platform.claude.com/docs/en/build-with-claude/extended-thinking>, all fetched 2026-10-30.
- **Test**: a small Node script (in a scratch directory, not committed) that drives pi's own
  `ModelRuntime.streamSimple` with the user's Codex sign-in. It ran 7 sessions of 6 calls each,
  every prompt under 7K tokens, on the subscription with no API charges. A second script built
  the Anthropic request bodies offline, using a fake key and a `fetch` that throws, so it sent
  nothing over the network. A live Anthropic run was **not possible**: the stored Claude OAuth
  refresh token has expired (`invalid_grant`).

## Answer

1. **`openai-codex` (GPT-6.1 Sol): yes, with public APIs only (V, by code and by test).** Each
   test session sent two real tool-calling turns (A, B), then the fork (B's transcript, plus B's
   reasoning, tool call and tool result, plus a trailing user message). In every session where
   B's prefix was cached at all, the fork read **all of it**: 6 of 7 sessions (4352 of 4500 once,
   and 4480 of 4590–4617 in five). That held with reasoning items in the input (`effort: high`). In the one
   session where it read nothing, the provider was routing at random: the agent's own turn B
   missed in 4 of 7 fresh sessions, so these misses are not caused by the fork. The same fork
   with **`tool_choice: "none"`** read the same prefix (full in 5/7, one 0 and one partial, both
   matching the random-routing pattern). OpenAI's docs recommend exactly this: "Set
   `tool_choice` to `"none"` instead of removing the tool definitions".
2. **Anthropic (Claude Fable 5): yes in principle (V by code and docs, *not* by a live call).**
   The fork's body is byte-identical to the agent's next-turn body except for the appended
   message and the moved last breakpoint. The 20-position lookback finds the previous
   breakpoint, and Fable 5 keeps earlier turns' thinking blocks, so a trailing user message
   does not strip them. **But `tool_choice` must not be set**: Anthropic documents that a change
   to `tool_choice` invalidates the **messages** cache, keeping only the tools and the system
   prompt. That is nearly everything at 120K+. On Anthropic, "don't call tools" can only be an
   instruction.
3. **Both hooks work (V).** At `turn_end` and in `session_before_compact` (threshold and
   `/compact`), the last real request has completed and written its cache, and the live context
   is that request plus what came after it. The fork only has to reproduce the **previous**
   request's prefix and append to it. Overflow is out of scope: there the context doesn't fit
   (serialized mode).
4. **Everything needed is public (V), with one real caveat.** The system prompt and tool
   declarations are **in the transcript** as system messages, so the fork does not need
   `getSystemPrompt`/`getActiveTools`, and using them would be wrong. The caveat: pi applies some
   request-local transforms that a fork rebuilt from the session projection doesn't see (§1.3).
   None is active in this user's setup today. If one becomes active, the fork misses silently.
   Guard against that by comparing payloads (§3.2).
5. **What a miss costs (at 150K):** about **$0.30 instead of $0.015** of input on GPT-6.1 Sol.
   On Fable 5 it is about **$1.88 instead of $0.15**, because the miss also *writes* the whole
   context at 1.25×. A Fable 5 fork that misses costs about twice pi's default summary, and
   Anthropic's cache goes cold after 5 minutes. So the writer should check that the cache is
   warm and fall back to serialized mode when it is cold (§3.3).

## 1. Rebuilding the request

### 1.1 What the agent actually sends (V)

- pi-agent-core builds each request as `streamFn(model, normalizeContext({ messages: convertToLlm(transformContext(messages)) }), { ...config, apiKey, signal })`
  `[core:agent-loop.js:268-280]`. The config holds `reasoning` (`undefined` when the level is
  "off"), `sessionId`, `transport`, `thinkingBudgets` and `onPayload` `[core:agent.js:306-316]`.
  It sets no `maxTokens`, `cacheRetention`, `toolChoice`, `temperature` or `serviceTier`.
- The session's `streamFn` adds only timeouts, retries, identity and header hooks
  (`buildRequestOptions`), then calls `modelRuntime.streamSimple` `[ca:sdk.js:192-270]`. The
  `sessionId` is `sessionManager.getSessionId()` `[ca:sdk.js:276]`.
- **The prompt and the tools live in the transcript.** The leading system message carries the
  base prompt and `toolsAdded`, and later system messages carry changes (pi-ai `SystemMessage`
  type; `extensions.md` §"Activate tools dynamically"). The `messages` in a session projection
  start with that system message (`_buildBoundaryContext` checks `hasNonSystemContext`
  `[ca:agent-session.js:615-635]`).
- **Codex body** `[ai:openai-codex-responses.js:376-440]`: `model`, `store: false`,
  `instructions` (from the leading system message), `input`, `text.verbosity: "low"`,
  `include: ["reasoning.encrypted_content"]`, `prompt_cache_key = sessionId`,
  `tool_choice = options.toolChoice ?? "auto"`, `parallel_tool_calls: true`, and `reasoning`.
  On GPT-6.1 Sol (`supportsAdditionalTools`) the tool definitions go into `input` as an
  `additional_tools` item, not into `tools` (seen in the captured payloads). The body has **no
  output-token cap**. `cacheRetention: "none"` drops `prompt_cache_key` and the `session-id` header
  `[ai:openai-codex-responses.js:172, 1312]`.
- **Anthropic body** `[ai:anthropic-messages.js:890-1022]`: the system blocks (with OAuth, first
  "You are Claude Code…" and then the prompt, each carrying `cache_control`), the tools (the last
  one carries `cache_control`), the messages (`cache_control` on the **last block of the last user
  message** `[:1216-1240]`), `thinking: {type: "adaptive"}` plus `output_config.effort`
  (Fable 5 has `forceAdaptiveThinking`), `max_tokens`, `fallbacks` (Fable 5 lists Opus 4.8 and
  Opus 5) and `betas`. `tool_choice` is sent only when it is set `[:1016-1022]`.

### 1.2 Pieces the fork needs

| Piece | Where an extension gets it | Status |
|---|---|---|
| Transcript (prompt + tools + messages) | `turn_end`: `event.context.llmMessages` (= `convertToLlm(projection.messages)`, `BoundaryContextPreview`). `session_before_compact`: `convertToLlm(ctx.sessionManager.buildSessionProjection().messages)` (`convertToLlm` is exported from the package root) | Public (V) |
| Model | `ctx.model`; under a virtual model, use the physical model of the last assistant message (`modelRegistry.find(msg.provider, msg.model)`), because routing is private (`prepareRequest`) | Public (V); virtual routing private |
| Thinking level | `ctx.thinkingLevel` / `pi.getThinkingLevel()`; pass `reasoning: undefined` for "off", as the agent does | Public (V) |
| Session / routing id | `ctx.sessionManager.getSessionId()` (it is the agent's `sessionId`) | Public (V) |
| Auth + transport | `ctx.modelRegistry.streamSimple(model, context, options)`: request-time auth through pi's own `ModelRuntime`, so it shares pi's `pi-ai` instance and its Codex WebSocket pool | Public (V) |
| Transport setting | `settings.transport` (default `auto`); it does not change the body | Copy if set (V) |
| `getSystemPrompt()`, `getActiveTools()`, `getAllTools()` | **Not needed.** Passing them as `Context.systemPrompt`/`tools` would add a second system message and break the prefix | (V by type; effect I) |

Don't pass `cacheRetention: "none"` the way pi's summarizer does `[ca:compaction/compaction.js:482]`.
It removes both providers' cache markers and the routing key, which guarantees a miss. Leave it
unset, as the agent does. Leave `maxTokens` unset too, so Anthropic's `max_tokens` stays identical.

### 1.3 What a projection-built fork does not reproduce (V: these exist; I: their effect)

Pi wraps the agent's `transformContext` and conversion with layers an extension can't call:

- extension `context` / `context_with_system` handlers (`runner.emitContext`);
- hidden tool declarations from `prepareLoadout` hooks (codemode, tool_search, MCP exposure)
  `[ca:agent-session.js:1345]`;
- a forced system prompt from `before_agent_start` `[ca:agent-session.js:1366]`;
- the image-blocking `convertToLlm` wrapper, when `blockImages` is on `[ca:sdk.js:~170-190]`;
- `before_provider_request` payload rewrites (the agent passes `onPayload`; the fork doesn't
  unless it passes its own).

If any of these changed the *previous* request, the fork's prefix differs and it misses. In this
setup none is active: this repo's extensions register no `context`, `context_with_system`,
`before_provider_request` or `before_provider_headers` handlers, and codemode and tool_search
load inactive by default. A pending prompt or tool update message, which pi appends before the
*next* request `[ca:agent-session.js:539-560]`, does not matter: the fork only has to match the
request that already wrote the cache.

## 2. What the fork can append or change

### 2.1 Appending a trailing user message: yes, on both

- **Codex (V, test).** The fork's `input` is the agent's next-turn `input` plus one `user`
  item. All other body fields hash the same (captured payloads). OpenAI's implicit mode puts a
  breakpoint at the latest eligible message and looks back over up to 20 earlier eligible
  endings (user messages, the last tool output of a group). So the fork finds the entry the last
  real request wrote. **Reasoning items are not dropped**: the fork read B's prefix *including*
  B's reasoning item. The docs don't state GPT-6.1 Sol's default `reasoning.context`; the test
  answers it for this case.
- **Anthropic (V, code and docs).** The offline bodies show the fork = next-turn body + one user
  text message after the tool-result message. System, tools and the other parameters are
  identical. Only the 4th breakpoint moves from the last `tool_result` to the new text block
  (OAuth already uses all 4: `system[0]`, `system[1]`, `tools[last]`, last user block). The
  lookback checks 20 positions back from that breakpoint, and a run of `tool_use` or
  `tool_result` blocks counts as one position. So the previous request's breakpoint, one
  assistant turn back, is found. Fable 5 is a "keep all prior turns" model, so a non-tool-result
  user message does not strip earlier thinking blocks (thinking docs, "Thinking block
  preservation by model").
- **Edge (I).** An assistant turn with more than ~19 positions (for example, many parallel tool
  calls each preceded by a Fable progress-update thinking block) pushes the previous breakpoint
  out of the lookback, and the messages miss. The agent's own next turn has the same limit.

### 2.2 Stopping tool calls while sending the same tool definitions

- **Codex: send `tool_choice: "none"` (V).** It is not in OpenAI's list of settings that affect
  the prefix, the docs recommend it for exactly this, and in the test it read the same prefix as
  `auto`. Over the WebSocket it only disables pi's `previous_response_id` delta for that request:
  `requestBodiesMatchExceptInput` sees a different `tool_choice` and the full body is sent
  `[ai:openai-codex-responses.js:1135-1166]`. That changes bandwidth, not the cache (I).
- **Anthropic: don't set `tool_choice` (V, docs).** "Changes to the `tool_choice` parameter only
  affect message blocks", which marks the messages cache ✘. Leave it unset. Write "do not call
  tools" into the Handoff instruction, and treat a response that is only a tool call as a
  failure that falls back to serialized mode. Since the output is never persisted, a stray tool
  call is harmless otherwise. Adding a dedicated "handoff" tool is worse: any change to the tool
  definitions invalidates the whole cache.
- **Neither provider lets you lower the effort for the fork (V, docs).** `reasoning.effort`
  (OpenAI) and the thinking configuration and effort (Anthropic) are rendered into the prompt.
  So the fork runs at the session's level and pays for its reasoning tokens. Codex has no output
  cap to set either.

### 2.3 Concurrency and pi's own state (V code, I effect)

- Both hooks run after the previous response has finished, which satisfies Anthropic's rule
  that "a cache entry only becomes available after the first response starts". The `turn_end`
  handler is awaited before the next request `[ca:agent-session.js:497-520]`.
- On Codex the fork can reuse pi's pooled WebSocket for the same `sessionId` and overwrites its
  continuation `[ai:openai-codex-responses.js:1226]`. The agent's next request then sends the
  full body once. That request is usually compacted anyway.
- The fork does not go through the agent's `streamFn`, so it does not restart pi's cache warmer
  `[ca:sdk.js:269]`, and its usage is not recorded unless the extension passes it on (for
  example in the compaction draft's `usage`).

## 3. Confirming a hit, and what a miss costs

### 3.1 Usage fields (V)

pi normalizes both providers into `AssistantMessage.usage = { input, cacheRead, cacheWrite, output }`:

- Codex: `cacheRead = input_tokens_details.cached_tokens`,
  `cacheWrite = input_tokens_details.cache_write_tokens`, and `input` is the remainder
  `[ai:openai-responses-shared.js:505-517]`. Over Codex sign-in `cacheWrite` was 0 on every call.
  Reads come in 128-token steps.
- Anthropic: `cacheRead = cache_read_input_tokens` and `cacheWrite = cache_creation_input_tokens`
  (plus `cacheWrite1h`) `[ai:anthropic-messages.js:494-498, 660-670]`.

Check it the way pi's own miss detector does `[ca:cache-stats.js:14]`. Take
`prev = last real assistant message's (input + cacheRead + cacheWrite)` and
`missed = min(prev, forkPrompt) − fork.cacheRead`. Treat `missed ≤ 1024` as a hit.

### 3.2 A guard against silent mismatches (I, uses public hooks)

1. Record the last real request body in `before_provider_request`, which sees the final payload
   after every private transform.
2. Pass an `onPayload` to the fork's `streamSimple` that checks the recorded body is a prefix of
   the fork's: `instructions`, the non-input fields and the leading `input` items on Codex;
   `system`, `tools` and the leading `messages` with `cache_control` stripped on Anthropic.
3. On a mismatch, log it (or fall back to serialized mode) before spending the call.

### 3.3 What a miss costs (prices from `models-store.json`, as in #20)

Input side of one fork at context C. Output (the Handoff, about 5K, plus reasoning) is the same
either way: about $0.05 on Sol and $0.25 on Fable 5.

| C | GPT-6.1 Sol hit (C × $0.10/M) | Sol miss (C × $2/M) | Fable 5 hit (C × $1/M + Δ write) | Fable 5 miss (C × $12.50/M) |
|---|---|---|---|---|
| 120K | $0.012 | $0.24 | $0.12 | $1.50 |
| 150K | $0.015 | $0.30 | $0.15 | $1.88 |
| 170K | $0.017 | $0.34 | $0.17 | $2.13 |

- Δ is the tail since the last real request (the last assistant turn plus tool results and the
  instruction), usually a few K: a few cents of 1.25× writes on Fable 5.
- For comparison, from #20: pi's default summary costs $0.18–0.21 (Sol) and $0.96–1.11
  (Fable 5) in total. A **warm** fork is cheaper than that on both. A **cold** fork costs about
  1.6× the default on Sol and about 2× on Fable 5.
- On Fable 5 a known-cold fork could pass `cacheRetention: "none"` to skip the write ($1.50
  instead of $1.88 at 150K). Serialized mode is still cheaper.
- How often the cache is cold (#20): 2.9% of calls missed on Codex, 15.7% on Anthropic, and 78%
  of Anthropic calls after a 5–30 min pause. A `/compact` typed after a pause on Fable 5 will
  usually be cold.
- So the writer should **send the fork only while the cache is warm**: no more than about 5 min
  since the last response on Anthropic, and no more than about 30 min on Codex. Otherwise use
  serialized mode. Threshold and Self-compaction fire mid-run, so their cache is warm.

## 4. Test detail (Codex, GPT-6.1 Sol)

Each session used a fresh `sessionId`: a system prompt of about 2.4K tokens with one tool, then
A (the user asks for two tool calls) → tool result of about 2.1K → B → tool result of about 2.1K.
The calls that followed:

- **F_auto**: the fork (transcript plus a trailing "HANDOFF… do not call tools" user message).
- **N**: the agent's real next turn.
- **F_none**: the fork with `tool_choice: "none"`.
- **F_auto2**: F_auto repeated.

| Run (transport, effort) | B read / B prompt | F_auto read | N read | F_none read | F_auto2 read |
|---|---|---|---|---|---|
| sse, low | 2304 / 4500 | **4352** | 6400 | 6400 | 6400 |
| sse, high | 2432 / 4617 | **4480** | 4480 | 0 | 6656 |
| sse, high | 0 / 4575 | 0 | 4480 | 6528 | 6528 |
| sse, high | 2432 / 4602 | **4480** | 4480 | 6656 | 6656 |
| sse, high | 0 / 4608 | **4480** | 0 | 6528 | 6656 |
| ws (auto), high | 0 / 4590 | **4480** | 4480 | 2432 | 6656 |
| ws (auto), high | 0 / 4595 | **4480** | 2432 | 6528 | 6528 |

- The fork prompts were 6.6–6.8K. No fork made a tool call, with either `tool_choice`.
- The "high" runs added a short private-reasoning request, so reasoning items were in `input`.
- The zeros and partial reads appear on real turns too (B missed 4 of 7), so they come from
  provider routing. On GPT-5.6+ the `prompt_cache_key` "is not needed to optimize caching", and
  keys "do not pin requests to a machine".
- In the "high" runs, N did not reuse the part the fork had written beyond B's prefix. This
  doesn't matter here (I): after a fork comes a compaction, so the next request is a new context.
