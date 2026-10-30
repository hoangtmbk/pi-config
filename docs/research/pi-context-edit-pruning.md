# What `context_edit` can prune in pi, and what Pruning costs (primary sources)

Question ([#18](https://github.com/hoangtmbk/pi-config/issues/18), child of the map
[#16](https://github.com/hoangtmbk/pi-config/issues/16)): can `context_edit` entries do
**Pruning** (see `CONTEXT.md`, Compaction) in pi 1.4.0, which entries can they omit or replace,
who may append them and when, what the model sees afterwards, how they interact with
compaction, and what the prompt-cache miss they cause costs for the providers this package uses.

Sources are the installed packages `node_modules/@earendil-works/pi-coding-agent` and
`node_modules/@earendil-works/pi-ai`, both at `1.4.0` [pi-coding-agent package.json]
[pi-ai package.json]. Paths below are relative to `pi-coding-agent/` unless they start with
`pi-ai/`. Line numbers refer to the shipped `docs/*.md`, `CHANGELOG.md`, and `dist/**/*.{d.ts,js}`.
The user's own providers, prices and traffic come from `~/.pi/agent/` (read only; no keys read).
Provider-side rules (Anthropic, OpenAI) are cited by URL.

## Answer

Yes. `context_edit` is a real, supported Pruning mechanism in pi 1.4.0, and the right one:
it persists, survives resume, applies on the very next request of the same run, and later
compaction, `tokensBefore` and `getContextUsage()` all see the pruned context. The limits are:

- **An extension can only append it from two hooks**: as a draft returned from `turn_end` or
  `agent_before_settle`. `ctx.sessionManager` is read-only everywhere else, including in tools
  and commands.
- **It edits whole entries, not parts.** A replacement swaps the target's entire `content`
  array. Shortening part of a tool result means writing the shortened content yourself.
- **Pi does not check pairing for you.** Replacing a tool result keeps its `toolCallId`, so the
  pair stays valid. Omitting a tool result makes pi-ai invent an error result for the call.
  Omitting or rewriting an assistant message that holds tool calls, while keeping its results,
  breaks every later request (pi #11227). Pruning must work on whole call-and-result pairs, or
  replace tool results only.
- **The cache cost is real and usually larger than the saving.** An edit at position *p*
  re-bills everything after *p* at the uncached rate once. On the catalog prices for this user's
  models, removing *X* tokens pays back only after about `11.5 × S/X` requests on Claude and
  `19 × S/X` on GPT-6.1 (*S* = tokens kept after the edit point). Typical sessions run about 15
  more requests once they pass 100K. So Pruning pays in tokens only when the cache is already
  cold (idle longer than the TTL), when it rides along with a compaction, or when it removes most
  of what follows the edit point. Otherwise its value is Context pressure relief and less rot, not
  saved spend.
- **On Claude 5.1 and later, a client-side edit also costs reasoning.** Anthropic binds each
  thinking block to the exact prefix before it. Clearing or shortening an earlier `tool_result`
  makes every later thinking block invalid. Depending on settings that is a 400 error or the
  API dropping those blocks. Pi sends `drop_block` for models flagged `supportsMidConvoEffort`,
  which includes the user's `claude-fable-5-1`, so requests succeed but the model loses the
  reasoning that came after the edit. `claude-fable-5` (5.0), Sonnet 4.5 and the Codex models
  don't run this check. Anthropic's own advice is to shorten a result before it is first sent,
  or to clear old results server-side with `clear_tool_uses_20250919`, which doesn't trip the
  check (§7).

The rest of this note backs each point.

## 1. What a `context_edit` is

The entry type:

```ts
export interface ContextEditEntry extends SessionEntryBase {
    type: "context_edit";
    targetId: string;
    /** Null omits the target from model context. A value replaces only its content. */
    replacement: { content: ContextEditableContent } | null;
}
```
[dist/core/session-manager.d.ts:117-127]

- "Append-only edit of one earlier context-producing entry. It changes only future model
  context; the target entry and its metadata remain unchanged in raw history, UI, exports, and
  session accounting." [docs/session-format.md:139-147]
- Added in 0.87.0 (2026-09-21): "Added append-only model-context edits. For example,
  `sessionManager.appendContextEdit(entryId, null)` omits one message from future provider
  context without changing raw history, usage, or UI history." [CHANGELOG.md:535, 549]
- **Latest edit wins, per branch.** "If several edits target the same entry, the latest edit on
  the active branch wins. Edits are branch-relative: navigating to a point before the edit
  reveals the target's original contribution again." [docs/session-format.md:147]. In code, the
  projection keeps a `Map` from `targetId` to the last edit seen while walking the path
  [dist/core/session-manager.js:256-264]. So a later replacement can supersede an earlier
  omission, but there is no "undo" entry; you append a new edit with the original content.
- **Projection, not mutation.** `buildSessionProjection()` applies the edits to the compaction-aware
  entry list; "Omitted targets produce no message; replacements retain the source entry's role and
  metadata while changing only content. The raw selected entries are not modified."
  [docs/session-format.md:235] [dist/core/session-manager.js:235-284]

## 2. Which entries it can omit or replace

`appendContextEdit` validates exactly three things [dist/core/session-manager.js:962-997]:

1. the target exists,
2. the target is on the active branch,
3. the target is a `custom_message` entry or a `message` entry whose role is `user`,
   `assistant` or `toolResult`. Anything else throws "does not contribute editable model content".

So, against the ticket's list:

| Target | Possible? | How |
|---|---|---|
| A whole tool result | Yes | `replacement: null` omits it; `{ content: "…" }` replaces it |
| Part of a tool result | Only by replacement | Replacement swaps the whole `content` array [dist/core/session-manager.js:235-252]; the extension computes the shortened content itself (keep head/tail, a placeholder, a pointer to a file) |
| A tool call together with its result | Yes, as two edits | One edit per entry: the assistant message and each of its `toolResult` entries. This is what pi's own recovery does (§4) |
| An assistant message | Yes | Omit, or replace its whole content. Replacing drops every block, including `toolCall` and `thinking` blocks |
| A user message | Yes | Same rules |
| A `custom_message` (extension-injected context) | Yes | Same rules |
| Compaction summary, branch summary, system prompt / tool declarations, `custom`, labels, model changes | No | Not editable targets |
| A single `toolCall` block inside an assistant message | Not directly | Only by replacing the assistant's whole content with a copy minus that block, which orphans its result (§4) |

String replacements for assistant and tool-result targets are normalized to one text block
"because those roles require content arrays" [docs/session-format.md:147]
[dist/core/session-manager.js:983-987]. A replacement keeps every other field of the message:
`role`, `toolCallId`, `toolName`, `isError`, `usage`, timestamps [dist/core/session-manager.js:252].

Entries hidden by a compaction are moot: edits are collected only from the compaction-aware entry
list [dist/core/session-manager.js:258-262], and a target before `firstKeptEntryId` is not in the
projection anyway.

## 3. Who may append one, and when

**Extensions: only through `turn_end` and `agent_before_settle`.** `ExtensionContext.sessionManager`
is typed `ReadonlySessionManager` [dist/core/extensions/types.d.ts:222-223], a `Pick` that has no
`append*` method [dist/core/session-manager.d.ts:178]. `appendContextEdit` exists only on the full
`SessionManager` [dist/core/session-manager.d.ts:287-288]. Commands get the same read-only manager
(the command context adds navigation and session replacement, not appends)
[dist/core/extensions/types.d.ts:286-320]. Tools receive an `ExtensionContext` too, so **a
Self-compaction or prune tool cannot write the edit itself**; it must leave a request that a
`turn_end` handler of the same turn turns into drafts.

The two actionable boundaries:

- "`turn_end` and `agent_before_settle` are actionable boundaries. Their handlers can chain proposed
  `custom`, `custom_message`, `context_edit`, or `compaction` entries and return `continue: true`
  for one next model request." [docs/extensions.md:230] [CHANGELOG.md:550]
- Draft shape: `{ type: "context_edit", targetId, replacement }`
  [dist/core/extensions/types.d.ts:765-778]; result `{ entries?, continue? }`
  [dist/core/extensions/types.d.ts:792-795].
- `TurnEndEvent` carries `messageEntryId` and `toolResultEntryIds` for the turn just finished
  [dist/core/extensions/types.d.ts:828-835], and every boundary event carries a `context` preview:
  `contextEntries` (projected entries with their `sourceEntry`, i.e. the IDs to target),
  `contextMessages`, `llmMessages`, `pendingMessages`, `canContinue`
  [dist/core/extensions/types.d.ts:779-791]. The preview is rebuilt after each handler with the
  drafts so far applied, on an in-memory copy of the branch [dist/core/agent-session.js:604-634]
  [dist/core/extensions/runner.js:759-799].
- Handlers chain: each sees `entries` proposed by earlier handlers and returns the new full list
  [dist/core/extensions/runner.js:765-776]. **If the final draft list fails validation (for
  example a stale `targetId`), every draft from every extension at that boundary is dropped**
  and an "Invalid boundary entries" error is reported [dist/core/extensions/runner.js:778-799].
- Drafts are committed with the real `appendContextEdit`, then
  `_refreshFinalizedContext()` replaces `agent.state.messages` with the new projection
  [dist/core/agent-session.js:578-603, 571-577, 635-640]. **The edit therefore applies to the next
  request in the same run**, not only to the next prompt. `turn_end` fires from `finishTurn`,
  i.e. after the turn's tool results are persisted and before the next request
  [dist/core/agent-session.js:487-533].
- `continue: true` is only needed when the turn would otherwise end the run (no tool calls) and the
  extension wants one more request; pi rejects it when the context could not continue
  [dist/core/agent-session.js:515-519, 615-634]. Pruning does not need it.

**The `context` hook is not a `context_edit`.** `context` "filters conversation messages for one
provider request" [docs/extensions.md:155, 228]. It runs on every request on a `structuredClone`
of the projected messages, without system messages, and its output is not persisted
[dist/core/extensions/runner.js:1006-1022] [pi-agent-core/dist/agent-loop.js:268-273]. Its
messages carry no entry IDs. Pruning done there is invisible to compaction, `tokensBefore`,
`getContextUsage()`'s estimate and resume, so it would fight the Pressure levels. The bundled
`plan-mode` example uses it only to hide its own stale injected messages
[examples/extensions/plan-mode/index.ts:176-198].

**SDK hosts and pi itself** can call `session.sessionManager.appendContextEdit` directly, then
`session.refreshContext()` [CHANGELOG.md:543]. Pi does so for overflow/length recovery (§4).

## 4. What the model sees afterwards, and pairing

The request path is: session projection (edits applied) → `context` hooks → `convertToLlm` →
pi-ai `transformMessages` → provider conversion [pi-agent-core/dist/agent-loop.js:268-276]
[dist/core/sdk.js:277-282].

**Replacing a tool result keeps the pair.** The `toolResult` keeps `toolCallId`, so the provider
still gets `tool_result.tool_use_id` (Anthropic) [pi-ai/dist/api/anthropic-messages.js:1033-1040]
or `function_call_output.call_id` (Responses/Codex) [pi-ai/dist/api/openai-responses-shared.js:309-325]
matching the call. This is the safe Pruning primitive.

**Omitting a tool result does not break the request, but the model sees an error.** pi-ai's
second pass inserts a synthetic result for any tool call left without one:
`{ role: "toolResult", content: "No result provided", isError: true }`
[pi-ai/dist/api/transform-messages.js:138-166, 208-211]. Use a placeholder replacement instead
so the model reads "pruned", not "failed".

**Omitting or rewriting the assistant message while keeping its results breaks the session.**
Nothing drops orphaned results: `transformMessages` only adds missing results, never removes
extra ones [pi-ai/dist/api/transform-messages.js:167-211], and the Anthropic converter emits every
consecutive `toolResult` as a `tool_result` block [pi-ai/dist/api/anthropic-messages.js:1189-1213].
Pi learned this the hard way in 1.4.0: "Fixed sessions breaking after recovery from a response cut
off at the output limit: the truncated tool call was omitted but its tool results were kept, so
providers rejected every later request (#11227)" [CHANGELOG.md:45]. The fix,
`_omitRecoveryAttempt`, omits the assistant message *and* every result whose `toolCallId` it
issued, finding them in the projected context "so the pair stays together … An unpaired result
fails the next request (#11227)" [dist/core/agent-session.js:838-871]. That is the template for
pair-safe omission. Replacing an assistant message's content with text has the same effect as
omitting its tool calls, because the replacement drops the `toolCall` blocks.

**Thinking and reasoning.** Replacing an assistant message drops its `thinking` blocks with
their signatures (Anthropic) or encrypted reasoning items (Codex: `thinkingSignature` is the
serialized reasoning item, re-sent as-is [pi-ai/dist/api/openai-responses-shared.js:234-239];
the request sets `store: false` and `include: ["reasoning.encrypted_content"]`
[pi-ai/dist/api/openai-codex-responses.js:396-406]). Provider rules on this are in §7. On Claude 5.1+ even replacing an earlier *tool result*, with
the assistant message untouched, invalidates later thinking blocks.
Assistant messages that end up with no blocks are skipped on the wire
[pi-ai/dist/api/anthropic-messages.js:1177-1178] [pi-ai/dist/api/openai-responses-shared.js:300-301].

**Pi's own provider guards that matter here:** Anthropic system messages between a `tool_use`
and its `tool_result` are moved after the results because Anthropic rejects them in between
[pi-ai/dist/api/anthropic-messages.js:1045-1053]; error tool results with images are split
(#10794) [pi-ai/dist/api/transform-messages.js:4-21].

## 5. Edits and compaction

- **Compaction sees the edited context, not the raw one.** Preparation runs on
  `buildSessionProjection(pathEntries)` [dist/core/compaction/compaction.js:609-640]; "Omitted raw
  entries remain stored but do not affect cut selection, summaries, checkpoints, or token
  estimates." [docs/compaction.md:83]. So whatever Pruning removed is also gone from the
  material pi's default summarizer reads.
- **The raw entries are still available to our Handoff writer.** `session_before_compact` gets
  `branchEntries`, "all entries on current branch" [docs/compaction.md:313], which are raw
  entries including the pruned targets and the `context_edit` entries themselves. A Handoff
  writer can choose to consult pruned content.
- **`tokensBefore` reflects the edits.** "Pi also recalculates `tokensBefore` from the rebuilt,
  context-edited session projection" [docs/compaction.md:83]
  [dist/core/compaction/compaction.js:627]. Boundary-drafted compactions compute it the same way
  [dist/core/agent-session.js:591-594].
- **But right after an edit the count is a heuristic.** `estimateProjectedContextTokens` trusts
  the last assistant `usage` only if that assistant came after the latest `context_edit` or
  `compaction`; otherwise it falls back to a chars/4 estimate of the whole projection
  [dist/core/compaction/compaction.js:137-170], "conservative (overestimates tokens)"
  [dist/core/compaction/compaction.js:196-199]. `getContextUsage()` uses the same estimator
  [dist/core/agent-session.js:3500-3533], as does pi's own threshold check when any edit exists
  [dist/core/agent-session.js:2480-2484]. So Context pressure read between a Pruning and the next
  response is an over-estimate; the next response's usage corrects it. The 0.87.0 fix "edited-context
  accounting both discarding valid assistant usage captured after the latest context edit and
  reusing that usage after a later compaction made it stale" is this logic [CHANGELOG.md:559].
- **Cut points.** Compaction never cuts at a tool result [docs/compaction.md:136]; the cut walks
  projected entries, so omitted ones count zero. The one documented interaction is recovery:
  the kept boundary may advance past a suffix made only of omitted assistant attempts, and "a
  replacement edit affecting the candidate input or summarized prefix also blocks advancement"
  [docs/compaction.md:138]. Ordinary Pruning of old tool results does not touch that rule.
- **Pi's own recovery already writes `context_edit` omissions before compacting**
  [docs/compaction.md:86-99], so our extension will share the entry type with pi.

## 6. Prompt cache: what an edit costs

### How the cache is laid out for this user's providers

The user signs in to both providers with OAuth (`auth.json` holds `anthropic` and `openai-codex`,
both `type: "oauth"`), defaults to `openai-codex/gpt-6.1-sol` (`settings.json`), and has used, over
62 local sessions: `gpt-6.1-sol` 1034 responses, `claude-fable-5` 302, `gpt-5.6-sol` 138,
`gpt-6-sol` 120 (tally of `~/.pi/agent/sessions/**/*.jsonl` assistant messages).

- **Anthropic (`anthropic-messages`).** Pi puts `cache_control` on the system blocks, the last
  tool definition, and the last block of the last user message
  [pi-ai/dist/api/anthropic-messages.js:927-950, 1215-1242, 1325]
  [docs/models-configuration.md:135]. Retention defaults to `short` (5 min); `long` (1 h) only
  with `PI_CACHE_RETENTION=long` or a `cacheRetention` option
  [pi-ai/dist/api/anthropic-messages.js:18-41] [docs/environment-variables.md:88]. The user's
  sessions show `cacheWrite1h = 0`, i.e. always 5 min.
- **OpenAI Codex (`openai-codex-responses`).** Automatic prefix caching keyed by
  `prompt_cache_key = sessionId`, no retention parameter sent
  [pi-ai/dist/api/openai-codex-responses.js:172, 396-406]. Over WebSocket pi also sends only the
  input delta with `previous_response_id` when the new input extends the last one exactly; an
  edit breaks that prefix check and pi sends the full input instead
  [pi-ai/dist/api/openai-codex-responses.js:1138-1168]. (That costs bandwidth, not tokens.)

Either way an edit at position *p* leaves the prefix before *p* cacheable and everything after *p*
uncached for one request; the request after that reads the new prefix from cache again.

### Prices (pi's catalog, $/M tokens, from `~/.pi/agent/models-store.json`)

| Model | input | cache write | cache read | miss/read ratio `(w−r)/r` |
|---|---|---|---|---|
| `anthropic/claude-fable-5` | 10 | 12.5 | 1 | 11.5 |
| `anthropic/claude-fable-5-1` | 10 | 12.5 | 0.25 | 49 |
| `anthropic/claude-sonnet-4-5` | 3 | 3.75 | 0.3 | 11.5 |
| `openai-codex/gpt-6.1-sol` | 2 | (2.5) | 0.1 | 19 (miss billed as input) |
| `openai-codex/gpt-5.6-sol` | 4 | (5) | 0.4 | 9 (miss billed as input) |

Codex responses in the user's sessions report `cacheWrite = 0` throughout, so a miss there is
billed at the input rate. All of these have `promptCache: null`, so pi's cache warming does not
apply to them [docs/models.md:104-112] [docs/settings.md:21-23].

### Break-even

Let *X* be the tokens Pruning removes, *S* the tokens that remain after the edit point, *w* the
price of an uncached (written or input) token and *r* the cached-read price.

- One-time extra cost on the next request: `S × (w − r)`.
- Saving on every later request: `X × r`.
- Break-even after `n* = (w − r)/r × S/X` requests.

Pi computes the same miss cost internally (missed tokens × (paid rate − read rate)) for its
`showCacheMissNotices` setting [dist/core/cache-stats.js:14-41] [docs/settings.md:20]; the module
is not exported from the package index, so an extension would reimplement it.

Worked example, 150K-token context, Pruning 30K tokens of old `read` results sitting at 20K–50K,
so *S* = 100K:

| Model | extra cost now | saving per later request | break-even |
|---|---|---|---|
| claude-fable-5 | 100K × 11.5 = $1.15 | 30K × $1 = $0.03 | ≈ 38 requests |
| gpt-6.1-sol | 100K × 1.9 = $0.19 | 30K × $0.1 = $0.003 | ≈ 63 requests |

How many requests are there to amortize over? In the user's sessions, a stretch that crosses 100K
runs a median of 15.5 more requests (max 44) before it ends or compacts (16 stretches; tally of
local sessions). So **at mid-session, Pruning a slice from the middle of the context costs more
than it saves in tokens** unless *X* is close to *S*.

It is free or cheap when:

1. **The cache is already cold.** The next request after an idle gap longer than the TTL pays for
   the whole prefix anyway. 10.8% of the user's inter-request gaps exceed 300 s (p50 11 s, p90
   326 s). Pruning at `agent_before_settle` and letting it take effect on the next prompt, if
   that prompt comes after the TTL, costs nothing extra.
2. **It rides on a compaction.** A compaction replaces everything after the system prompt, so
   edits written in the same boundary (or just before) add no miss of their own. On Claude 5.1+
   the compaction already drops the kept span's thinking blocks too (§7), so the edit adds no
   reasoning loss either.
3. **The edit sits near the tail** (small *S*), e.g. shrinking the turn-old huge result.
4. **Edits are batched.** Each separate edit point re-bills its own suffix; several targets pruned
   in one boundary cost one miss, at the earliest target.

Where Pruning still earns its keep regardless of price: it lowers Context pressure (the levels are
fixed token counts), so it can postpone a forced compaction and its Handoff loss; and the bulk of
context is prunable. Over the user's sessions, tool results are 83% of all message characters
(`read` 46%, `bash` 19%, `web_fetch` 11.5%, `subagent_wait` 5.5%); assistant text and thinking
16%, user text 0.5%.

**The user pays by subscription, not by token**, so the dollars above are notional. The ratio is
what carries over. Codex on a ChatGPT plan charges GPT-6.1 Sol 50 credits per 1M input and 2.5
per 1M cached input, with "no separate cache-write charge"
([ChatGPT Codex pricing](https://learn.chatgpt.com/docs/pricing)). That is the same 19:1 ratio,
so the same ≈ 63-request break-even. How Claude Pro/Max limits weigh cached tokens is not
published (see Unverified).

The provider-side rules (multipliers, TTLs, pairing errors, thinking binding) are in §7.

## 7. Provider rules

### Anthropic prompt caching

From [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):

- Cache writes cost 1.25× base input with the 5-minute TTL and 2× with the 1-hour TTL. Reads
  cost 0.1× base, except Fable 5.1 and Mythos 5.1 at 0.025× and Opus 5.5 and Sonnet 5.5 at 0.05×.
  Fable 5 is $10 base, $12.50 write (5m), $1 read; Fable 5.1 reads at $0.25. That matches pi's
  catalog (§6).
- "By default, the cache has a 5-minute lifetime. The cache is refreshed for no additional cost
  each time the cached content is used."
- The prefix is `tools`, `system`, `messages` in that order; "Changes at each level invalidate
  that level and all subsequent levels", and a hit needs "100 percent identical prompt segments".
  This is why an edit at *p* misses everything after *p*.
- At most 4 breakpoints; each breakpoint looks back at most 20 positions for an earlier write.
  Pi uses one on the last user message (§6), which moves forward every turn.
- Minimum cacheable length is 512 tokens on Fable 5/5.1 and 1,024 on Sonnet 4.5. That doesn't
  matter at these context sizes.

### Anthropic tool_use / tool_result pairing

From [Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls):

- "Tool result blocks must immediately follow their corresponding tool use blocks", and
  "`tool_result` blocks must come FIRST in the content array".
- A `tool_use` without its result fails with "tool_use ids were found without tool_result blocks
  immediately after". The reverse case is pi #11227 (§4).
- `tool_result.content` is optional and may be a string or a list of text and image blocks. A
  placeholder like "[pruned: 12,400 chars of `read src/x.ts`]" is valid.

### Anthropic thinking-block binding (Claude 5.1+)

From [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
and [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/thinking):

- "The prefix check runs on Claude 5.1 and later models. Other models don't run it." A returned
  thinking block is valid only if "Nothing before the thinking block has changed."
- The edit table says "Clear or shorten an earlier `tool_result`, re-encode an earlier image, or
  change an earlier `tool_use` input" makes every later thinking block invalid. Removing thinking
  blocks from the start, the end, or all of them is valid; removing one from the middle is not.
  "Once you remove a block, leave it out." That fits append-only edits that are never undone.
- With `thinking.block_binding.prefix_mismatch_behavior` (beta
  `thinking-binding-controls-2026-08-01`), `"error"` returns a 400. `"drop_block"` "drops each
  failing block and every thinking block after it, and the request succeeds … The model answers
  that turn without using reasoning from dropped blocks, and the prompt cache restarts at the
  edit." If the field is unset, Fable 5.1 accounts created on or after 2026-08-31 get a 400, and
  older accounts pass the blocks through.
- The page's guidance: "Shorten a tool result or downscale an image before the first time you
  send it, not after. To clear old results later, trim context on the server with
  `clear_tool_uses_20250919`". A server-side edit stays valid because "the check compares what
  you sent, not the server's edited copy".
- **What pi does.** pi-ai sends the beta and `block_binding: { prefix_mismatch_behavior:
  "drop_block" }` only for models with `compat.supportsMidConvoEffort`
  [pi-ai/dist/api/anthropic-messages.js:883-885, 916, 979-988]. The user's catalog sets it on
  `claude-fable-5-1` and not on `claude-fable-5` or `claude-sonnet-4-5` (§6 source). Pi issue
  [#11316](https://github.com/earendil-works/pi/issues/11316) (closed 2026-10-23) reports
  `/context` `context_edit` entries on a model without the flag making "every turn after the
  first edit" fail with "The `signature` in the `thinking` block is invalid". Pi's own
  compaction hits the same check: on fable-5-1 it drops stale thinking after a compaction
  ([#9391](https://github.com/earendil-works/pi/issues/9391)).
- **Server-side context editing as an alternative**
  ([Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)).
  Beta `context-management-2025-06-27`, strategy `clear_tool_uses_20250919`. It "clears the
  oldest tool results … replaces each cleared result with placeholder text" and keeps the calls.
  The options are `trigger` (default 100,000 input tokens), `keep` (default 3 tool uses),
  `exclude_tools`, `clear_tool_inputs` and `clear_at_least`. `clear_at_least` exists to decide
  "if context clearing is worth breaking your prompt cache", because clearing "Invalidates cached
  prompt prefixes". The response reports `applied_edits`. An extension could add it through
  `before_provider_headers` and `before_provider_request` [docs/extensions.md:96-101], but pi's
  projection and Pressure estimate would not know what the server cleared. Whether this works
  with OAuth subscription tokens is untested.

### OpenAI prompt caching, function calls and reasoning

- From [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): the minimum
  is 1,024 tokens on GPT-5.6+, and the full rendered prefix must match: "Summarization,
  compaction, or truncation of earlier turns can also reset reuse." In-memory retention is
  "around 5 to 10 minutes of inactivity, up to one hour", with longer opt-in tiers. Pi's Codex
  path sends none of them (§6). Cached reads cost 0.05× on GPT-6.1 Sol and 0.1× on GPT-5.6+
  ([pricing](https://developers.openai.com/api/docs/pricing): gpt-6.1-sol $2 / $0.10 cached,
  gpt-5.6-sol $4 / $0.40).
- **Pairing.** A `function_call_output` must name an existing `call_id`. Pi has seen
  "400 No tool call found for function call output" on gpt-6.1-sol
  ([pi #10734](https://github.com/earendil-works/pi/pull/10734),
  [pi #11233](https://github.com/earendil-works/pi/pull/11233)). Replacing the output's content
  keeps the `call_id` (§4).
- **Reasoning items.** "ensure all items between the last user message and your function call
  output are passed into the next response untouched"
  ([Reasoning](https://developers.openai.com/api/docs/guides/reasoning)). GPT-5.6+ defaults to
  `reasoning.context: all_turns`. OpenAI documents no prefix binding like Anthropic's (see
  Unverified).

## 8. Existing pi examples and community extensions

- **Bundled examples.** None of `examples/extensions/` appends a `context_edit` (grep for
  `context_edit`, `appendContextEdit` across `examples/` finds nothing). The nearest are
  `plan-mode`, which filters its own stale messages in the `context` hook
  [examples/extensions/plan-mode/index.ts:176-198], `trigger-compact.ts`, which calls
  `ctx.compact()` from `turn_end` past 100K tokens [examples/extensions/trigger-compact.ts:3, 27-41],
  and `custom-compaction.ts` [docs/compaction.md:368].
- **Pi itself** is the only first-party user of `context_edit`: overflow/length recovery
  [dist/core/agent-session.js:838-871] [docs/compaction.md:86-99].

- **Pi proposals.** "Prune instead of Compaction"
  ([#10604](https://github.com/earendil-works/pi/issues/10604)), a tool-result pruner and spill
  example ([#8173](https://github.com/earendil-works/pi/issues/8173)), and keyed drafts to
  replace the tombstone-and-re-emit pattern done with `context_edit`
  ([#10772](https://github.com/earendil-works/pi/issues/10772)) were all closed as not planned.
  `ContextEditEntry` itself landed in direct commit
  [466db0f](https://github.com/earendil-works/pi/commit/466db0fecdc20996a553116984d18c0d362b035a)
  ("feat: add canonical session context boundaries", 2026-09-21), with no PR discussion of cache
  cost or pairing.

**Community pi extensions.** Every one checked prunes request-locally in the `context` hook. None
was found that appends `context_edit` entries.

| Package | Mechanism (from its README) |
|---|---|
| [pi-context-prune](https://github.com/championswimmer/pi-context-prune) | Summarizes tool batches and filters the raw results in `context`. Has cache-aware trigger modes; the default is `agentic-auto`, and the README calls `agent-message` batching the safest |
| [pi-dcp (Davidcreador)](https://github.com/Davidcreador/pi-dcp) | `context` filtering; "original entries are not rewritten"; `[pruned by pi-dcp…]` marker |
| [pi-dcp (PSU3D0)](https://github.com/PSU3D0/pi-dcp) | Age-based placeholder `[DCP: Large output … pruned due to age…]` |
| [pi-dcp (pi-vault)](https://github.com/pi-vault/pi-dcp), [pi-dcp (zenobi-us)](https://github.com/zenobi-us/pi-dcp) | `context` filtering; the latter drops whole messages |
| [@rochecompaan/pi-context-paging](https://github.com/rochecompaan/pi-context-paging) | Rolling window with a stable cut point "to keep the provider prompt cache useful between cuts" |
| [pi-context-pruning](https://cdn.jsdelivr.net/npm/pi-context-pruning@1.1.0/README.md) | Port of OpenCode's prune in `context`; "[output pruned — ~N tokens \| …]" marker |

Request-local filtering has the same cache cost as a `context_edit` the first time it changes
the output. It is cache-stable afterwards only if it is deterministic. It also has the
accounting blind spot described in §3.

**Prior art outside pi.**
- **OpenCode** prunes without an LLM call. It protects the newest 40K tokens of tool output,
  acts only when at least 20K can be freed, and uses the placeholder "[Old tool result content
  cleared]" ([compaction.ts](https://github.com/anomalyco/opencode/blob/22a4c5a/packages/opencode/src/session/compaction.ts#L58)).
  The minimum gain plays the same role as Anthropic's `clear_at_least`.
- **Claude Code microcompact** clears old tool results with a placeholder. This is reported only
  in secondary sources ([claudelog](https://claudelog.com/faqs/what-is-micro-compact/)).

## Unverified

- **How Claude Pro/Max subscription limits count cached tokens.** Anthropic publishes nothing.
  API rate limits count cache reads as zero toward ITPM
  ([Rate limits](https://platform.claude.com/docs/en/api/rate-limits)), but that is API rate
  limiting, not subscription quota. A community fit in
  [claude-code#45756](https://github.com/anthropics/claude-code/issues/45756) estimates about
  0.1×.
- **Whether editing earlier Responses items invalidates OpenAI encrypted reasoning.** OpenAI
  documents no prefix binding, and nothing was found either way. The Codex models in this user's
  sessions have not shown such errors in pi's tracker.
- **Whether Anthropic server-side `clear_tool_uses_20250919` is accepted on OAuth (subscription)
  requests through pi.** Untested.
- **The user's Anthropic account creation date**, which sets the default for unset
  `prefix_mismatch_behavior`. Moot for `fable-5-1`, because pi sets `drop_block` explicitly, and
  for `fable-5`, which has no check.
- **Session tallies are approximate.** Character shares count each tool result once across
  sessions, not per request. The 100K-stretch count covers 16 stretches in 62 sessions.
