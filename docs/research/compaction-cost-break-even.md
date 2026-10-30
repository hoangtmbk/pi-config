# What a compaction costs compared with carrying the context

Date: 2026-10-30

Question (issue #20, child of map #16): when is compacting cheaper than carrying the context,
for the models this package's user actually runs? Covers input, cache-read and cache-write
prices and cache lifetimes; what one compaction costs; the break-even at 120K, 150K and 170K;
and how often compacting costs more than carrying on.

Terms follow `CONTEXT.md` (Compaction): *Context pressure*, *Pressure level*, *Self-compaction*,
*Pruning*, *Handoff*. A **call** below is one model request, meaning one assistant message in
the session file. Agent turns with tools make several calls per user message.

Sources:

- **pi** is `@earendil-works/pi-coding-agent` `1.4.0`, installed at the repo root's `node_modules/`.
  `[compaction.md:N]`, `[models.md:N]` and `[settings.md:N]` mean that package's `docs/`.
  `[dist/...]` means its shipped JS.
- **Local** is `~/.pi/agent/settings.json`, `models.json`, `models-store.json` (pi's cached
  catalog), the provider *types* in `auth.json` (no secrets read), and all 62 session files under
  `~/.pi/agent/sessions/` (56 have model calls, 1,569 calls in all, 2026-08-27 to 2026-10-30).
  Analysis scripts lived in a scratch directory. The numbers are reproducible from the
  session files.
- **OpenAI API pricing**: <https://developers.openai.com/api/docs/pricing>, fetched 2026-10-30.
  The page has no last-updated date. Its only dates: Fast mode renamed 2026-07-30, and GPT-5.6
  Sol promo pricing "at least through November 21, 2026".
- **OpenAI prompt caching**: <https://developers.openai.com/api/docs/guides/prompt-caching>,
  fetched 2026-10-30 (undated).
- **Codex (ChatGPT sign-in) rate card**: <https://learn.chatgpt.com/docs/pricing> (redirect target
  of `developers.openai.com/codex/pricing`), fetched 2026-10-30.
- **Anthropic pricing**: <https://platform.claude.com/docs/en/about-claude/pricing>, fetched
  2026-10-30.
- **Anthropic prompt caching**: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>,
  fetched 2026-10-30.

## Answer

1. **Cost is cents either way. It cannot be what sets the levels.** On the user's default
   model (GPT-6.1 Sol through Codex sign-in), one compaction at 120–170K costs about **$0.18–0.21**
   at list-equivalent rates. Carrying 120K of cached context costs about **$0.009 per call** on
   top of what the call costs anyway. On Claude Fable 5 the figures are about $0.96–1.11 per
   compaction and $0.09–0.14 per call.
2. **Break-even (pi's own summarizer, Handoff 5K, 20K kept, warm cache)**: a compaction pays back
   after **20 / 16 / 15 further calls** at 120K / 150K / 170K on GPT-6.1 Sol. On Claude Fable 5
   it takes **11 / 9 / 8**. With the cache misses actually measured in this user's sessions it
   takes **13 / 10 / 10** on GPT-6.1 Sol and **4 / 3 / 3** on Fable 5, whose 5-minute cache
   goes cold during human pauses.
3. **What follows 120K in real sessions**: only 5 of 56 sessions reached 120K, and 1 reached
   150K and 170K. After 120K they ran **0, 12, 21, 21 and 31 more calls** (median 21, with at most
   3 user messages). Above 80K, context grows a median **0.65K and a mean 1.5K per call** (p90 3.4K).
   So getting from 120K to 150K takes about 20 calls, which is about the break-even.
   Compacting at 120K would have cost more than carrying on in 1 of the 4 GPT paths: the session
   that ended right there. At 100K it would have cost more in 6 of 10 GPT paths and 2 of 2
   Claude paths.
4. **When compaction is free: the cache is already cold.** After a gap longer than the cache's
   lifetime (5 min on Anthropic by default, about 30–60 min on Codex), the next call has to pay
   full price for the whole context anyway. Compacting at that moment saves money on its
   first call at every level, on both providers (§4.3).
5. **Pruning on a warm cache is the expensive move.** Dropping 20K from early in a 120K context
   forces the remaining 80K to be re-prefilled. That takes **about 75 calls** to pay back on
   GPT-6.1 Sol (about 50 with measured misses) and 46 on Fable 5 (about 16 with misses).
   Pruning should be batched: run it on a cold cache or inside a compaction, never call by call (§5).
6. **What it means for the levels**: nothing here argues against notice 120K / warning 150K /
   forced 170K. A forced compaction at 170K pays back in 10–15 calls on the default model. The
   notice level sits where a compaction pays back only if the work goes on past roughly the
   warning level, which suits a notice, not a forced level. Two things to carry into the spec:
   a cold-cache moment past the notice level is the cheapest time to Self-compact, and Pruning
   should not run often (§6).

## 1. What the user runs

- `settings.json`: `defaultProvider: "openai-codex"`, `defaultModel: "gpt-6.1-sol"`. No
  `compaction` or `cacheWarming` keys, so pi's defaults apply: `reserveTokens` 16384,
  `keepRecentTokens` 20000 [compaction.md:434-435], `cacheWarming: "streaming"` [settings.md:21].
  `PI_CACHE_RETENTION` is not set in the environment, so the short retention tier applies
  [environment-variables.md:88].
- `auth.json` holds two providers, `openai-codex` and `anthropic`, both of type `oauth`. **Both are
  subscriptions (ChatGPT sign-in for Codex, Claude sign-in), not metered API keys.** The dollar
  figures here are pi's list-equivalent costs, the same figures pi stores in each message's
  `usage.cost`. They stand in for how fast plan allowance is used up. See §2.3 for why the ratios
  still hold.
- `models.json` only overrides context windows, for older Codex models (1.05M) and Sonnet 4.5 (200K).
- Calls by model across all sessions:

  | Provider / model | Calls |
  |---|---|
  | openai-codex / gpt-6.1-sol | 1,009 |
  | anthropic / claude-fable-5 | 290 |
  | openai-codex / gpt-5.6-sol | 131 |
  | openai-codex / gpt-6-sol | 119 |
  | openai-codex / gpt-5.5 | 19 |
  | anthropic / claude-haiku-4-5 | 1 |

  The worked examples therefore use **GPT-6.1 Sol (Codex)** and **Claude Fable 5**, with
  GPT-6 Sol and Fable 5.1 as sensitivity cases.

## 2. Prices and cache lifetimes

### 2.1 List prices (USD per 1M tokens)

| Model | Input | Cache read | Cache write | Output | Source |
|---|---|---|---|---|---|
| GPT-6.1 Sol | 2.00 | 0.10 (0.05×) | 2.50 (30m, 1.25×) / 5.00 (12h, 2.5×) | 10.00 | OpenAI pricing |
| GPT-6 Sol | 2.00 | 0.20 (0.1×) | 2.50 / 5.00 | 10.00 | OpenAI pricing |
| GPT-5.6 Sol | 4.00 | 0.40 | 5.00 / 10.00 | 20.00 | OpenAI pricing (promo through ≥ 2026-11-21) |
| GPT-5.5 | 5.00 | 0.50 | none listed | 30.00 | OpenAI pricing |
| Claude Fable 5 | 10 | 1.00 (0.1×) | 12.50 (5m, 1.25×) / 20 (1h, 2×) | 50 | Anthropic pricing |
| Claude Fable 5.1 | 10 | 0.25 (0.025×) | 12.50 / 20 | 50 | Anthropic pricing |
| Claude Sonnet 5 | 2 | 0.20 | 2.50 / 4 | 10 | Anthropic pricing |
| Claude Haiku 4.5 | 1 | 0.10 | 1.25 / 2 | 5 | Anthropic pricing |

OpenAI prices above 272K input tokens are doubled for input, cache read and cache write, and
1.5× for output (GPT-6.1 Sol: $4 / $0.20 / $5 / $15) [OpenAI pricing]. Pi's catalog for
`openai-codex/gpt-6.1-sol` has a 500K window and the same tier at `inputTokensAbove: 272000`
[local models-store.json]. Below 272K, which covers all the levels discussed here, the base rates
apply. Anthropic charges Claude 4.6+ the same rate across the full 1M window [Anthropic pricing,
"Long context pricing"].

Pi's catalog prices match these pages for every model above [local models-store.json].

### 2.2 Cache lifetimes

| Provider | Lifetime | Refresh | Source |
|---|---|---|---|
| OpenAI, GPT-5.6 and later | at least 30m by default (`prompt_cache_options.ttl: "30m"`), or 12h. "OpenAI may retain entries longer than the requested minimum." | "A 30-minute read refreshes coverage to at least 30 minutes after that read." | OpenAI caching guide |
| OpenAI, earlier models | in-memory "around 5 to 10 minutes of inactivity, up to one hour"; `24h` extended | | OpenAI caching guide |
| Anthropic | 5 minutes by default; 1 hour at 2× write | "refreshed for no additional cost each time the cached content is used"; measured from the start of the request | Anthropic caching guide |

Pi sends `prompt_cache_options.ttl: "30m"` on GPT-5.6+ when long retention is supported
[models-configuration.md:150]. Pi's bundled catalog declares `promptCache: {short: 300, long: 3600}`
for every Anthropic model. **No `openai-codex` model declares a lifetime**, so pi never warms the
cache for the user's default model [dist/bundle/chunks/chunk-MM3LKT73.js; models.md:106-112].
Cache warming also needs at least $0.05 of avoided miss cost [settings.md:23]
[dist/core/cache-warmer.js:8], and by default it runs only while a run is streaming, not between
runs [settings.md:21].

**Measured cache behaviour (local sessions).** The table shows the share of the previous call's
context read from cache, by the gap since the previous call. It covers calls whose previous call
had more than 20K of context, followed along each session branch:

| Gap | Codex: mean hit | Codex: full misses | Anthropic: mean hit | Anthropic: full misses |
|---|---|---|---|---|
| < 60s | 0.99 (n 852) | 0.6% | 1.00 (n 145) | 0% |
| 60–300s | 0.98 (n 121) | 1.7% | 1.00 (n 46) | 0% |
| 5–30m | 0.96 (n 70) | 2.9% | 0.22 (n 36) | 78% |
| 30–60m | 0.80 (n 16) | 19% | 0.00 (n 1) | 100% |
| > 1h | 0.29 (n 27) | 70% | 0.03 (n 8) | 75% |

Over all calls, the **miss rate** (under half the context read from cache) was **2.9% on Codex**
(32/1,086) and **15.7% on Anthropic** (37/236). On Anthropic, 19% of calls came more than 5
minutes after the previous one. The provider-reported lifetimes match the data: on Anthropic the
cache is gone after 5 minutes, and on Codex it lasts beyond 30 minutes.

### 2.3 Subscription billing keeps the ratios

The Codex credit rate card lists GPT-6.1 Sol at 50 credits per 1M input, 2.5 per 1M cached input
and 250 per 1M output. That is exactly 25× the API's $2 / $0.10 / $10, so every ratio is the same.
The card adds: "Codex credit billing has no separate cache-write charge." It also warns that
"credit prices alone don't determine included subscription usage" [Codex rate card]. So on
Codex, a cold prefill costs the plain input rate (write factor **1.0**, not 1.25), and the
break-even counts below hold in plan-allowance terms. Session usage agrees: every `openai-codex`
call records `cacheWrite: 0` [local sessions].

Anthropic publishes no per-token accounting for Claude subscription usage. This note assumes API
ratios (cache read 0.1×, 5-minute write 1.25×). That is unverified. The API docs say "cache hits
are not deducted against your rate limit" [Anthropic caching guide], which if anything makes
carrying cheaper in allowance terms.

## 3. What one compaction costs

### 3.1 How pi compacts (the costs that follow from it)

- The summarizer is the **session's own model**. `compact()` receives `request.model`
  [dist/core/agent-session.js:2209].
- The summarizer request uses `cacheRetention: "none"` ("Avoid cache writes for one-off
  summaries") [dist/core/compaction/compaction.js:478-482] [compaction.md:23]. Its input is
  serialized text, so it shares no prefix with the cached conversation. **The summarizer's input is
  paid at the full uncached rate.**
- Pi serializes the span being summarized with thinking omitted and **each tool result cut to
  2,000 characters** [compaction.md:289-291]. It keeps the most recent `keepRecentTokens` (20K)
  [compaction.md:45], cutting only at valid points [compaction.md:130-136].
- The next request is `system + Handoff + kept messages`. It is a new prefix, so it is **fully
  uncached** (OpenAI 1.0× on Codex, Anthropic 1.25× write).

### 3.2 Measured compactions (all four in the local sessions)

All four were the user's own `/compact`. Each `tokensBefore` sits far below pi's trigger at
window − 16K.

| Model | `tokensBefore` | Summarizer input | Summarizer output | Handoff chars (~tokens) | First call after | Its billing |
|---|---|---|---|---|---|---|
| claude-fable-5 | 110,601 | 30,264 | 4,208 | 10,008 (~2.5K) | 52,294 | 52,292 cache write |
| gpt-6.1-sol | 114,360 | 32,739 | 3,270 | 13,646 (~3.4K) | 35,991 | all uncached input |
| gpt-6.1-sol | 107,930 | 37,938 | 4,804 | 20,004 (~5.0K) | 41,288 | all uncached input |
| gpt-6.1-sol | 190,655 | 47,009 | 6,444 | 26,121 (~6.5K) | 64,772 | all uncached input |

So:

- **Summarizer input was 0.25–0.35 × the context**, because of the 2,000-character truncation. The
  model below uses 0.3 × C.
- **Summarizer output was 3.3–6.4K tokens**, in line with the Handoff's size. The model uses 5K.
- **The context after compaction was 36–65K, not 30K.** The first call in a session is a median
  4.4K tokens (system + tools + first prompt; p90 8.8K). That puts the kept tail at roughly
  28–54K, 1.4–2.7× `keepRecentTokens`, because the cut snaps to user and assistant boundaries
  and to chars/4 estimates. The main model uses the ticket's P = 5K system + 5K Handoff + 20K
  kept = **30K**, with P = 45K (the measured median) as a sensitivity case.
- In list-equivalent dollars these compactions cost $0.10–0.16 for the summarizer on GPT-6.1 Sol
  and $0.51 on Fable 5, as recorded in `usage.cost`. On top came the cold first call: $0.07–0.13
  on GPT-6.1 Sol and $0.80 on Fable 5.

### 3.3 Cost model

Costs are in units of one uncached input token, where `r` = cache-read factor, `w` = cold-prefill
factor and `o` = output factor:

```
one-off cost   Δ = I_s + O_s·o + P·(w − r)        I_s = summarizer input, O_s = Handoff output
saved per call s = (C − P) · [ r·(1 − m) + w·m ]  m = miss rate (0 for an always-warm cache)
break-even     N* = Δ / s
```

The new tokens each call adds (tool results, user messages) cost the same on both paths, and so
does output, so both cancel. The saving per call is constant: the C − P tokens no longer carried.
The model ignores the second compaction the compacted path might need later.

Factors: GPT-6.1 Sol on Codex r 0.05, w 1.0, o 5. Claude Fable 5 with a 5-minute cache
r 0.1, w 1.25, o 5.

## 4. Break-even

### 4.1 Worked example: GPT-6.1 Sol (Codex), C = 120K, P = 30K

- Summarizer: 36K uncached input + 5K output × 5 = 36K + 25K = 61K
- Cold first call: 30K × (1.0 − 0.05) = 28.5K
- **Δ = 89.5K input-equivalents = $0.179**
- Saved per call: 90K × 0.05 = 4.5K = $0.009. **N\* = 19.9 calls.**
- With the measured 2.9% miss rate: s = 90K × (0.05·0.971 + 1.0·0.029) = 7.0K, so **N\* = 12.8**.

Claude Fable 5 (5-minute cache), same C and P: Δ = 36K + 25K + 30K × 1.15 = 95.5K = **$0.955**.
Saved per call: 9K = $0.09, so **N\* = 10.6**. With the measured 15.7% misses, s = 25.2K and
**N\* = 3.8**.

### 4.2 Table (P = 30K, I_s = 0.3·C, O_s = 5K)

"Self" means the Handoff is written inside the live conversation, appended to the cached
prefix, so the summarizer's input is C × r instead of 0.3·C × 1. This is one possible design for
Self-compaction, not what pi does.

| Model | C | Summarizer | Δ (USD) | Saved/call, warm | N\*, warm | N\*, measured misses |
|---|---|---|---|---|---|---|
| GPT-6.1 Sol, Codex | 120K | pi | 0.179 | 0.0090 | **19.9** | 12.8 |
| | 150K | pi | 0.197 | 0.0120 | **16.4** | 10.5 |
| | 170K | pi | 0.209 | 0.0140 | **14.9** | 9.6 |
| | 120K | self | 0.119 | 0.0090 | 13.2 | 8.5 |
| | 150K | self | 0.122 | 0.0120 | 10.2 | 6.5 |
| | 170K | self | 0.124 | 0.0140 | 8.9 | 5.7 |
| GPT-6 Sol, Codex | 120K / 150K / 170K | pi | 0.18 / 0.19 / 0.21 | | 9.8 / 8.1 / 7.4 | 7.7 / 6.4 / 5.8 |
| Claude Fable 5, 5m | 120K | pi | 0.955 | 0.090 | **10.6** | 3.8 |
| | 150K | pi | 1.045 | 0.120 | **8.7** | 3.1 |
| | 170K | pi | 1.105 | 0.140 | **7.9** | 2.8 |
| | 120K / 150K / 170K | self | 0.72 / 0.75 / 0.77 | | 7.9 / 6.2 / 5.5 | 2.8 / 2.2 / 1.9 |
| Claude Fable 5, 1h | 120K / 150K / 170K | pi | 1.18 / 1.27 / 1.33 | | 13.1 / 10.6 / 9.5 | 8.4 / 6.7 / 6.1 (3% misses assumed) |
| Claude Fable 5.1, 5m | 120K / 150K / 170K | pi | 0.98 / 1.07 / 1.13 | | 43 / 36 / 32 | 5.0 / 4.1 / 3.7 |

**Sensitivity to P = 45K** (measured post-compaction size): GPT-6.1 Sol rises to **27.7 / 21.5 /
19.0** calls when warm (17.7 / 13.8 / 12.2 with misses). Fable 5 rises to 15.0 / 11.6 / 10.2 (5.4 / 4.1 / 3.6).

What moves N\*:

- **The cache-read factor.** GPT-6.1 Sol's 0.05× and Fable 5.1's 0.025× make carrying so cheap
  that a warm-cache compaction needs 20–40+ calls to pay back. GPT-6 Sol and Fable 5, at 0.1×,
  need half as many.
- **Handoff output.** 5K output × 5 = 25K input-equivalents, about 28% of Δ on GPT-6.1 Sol. A
  Handoff of 2.5K instead of 5K takes about 3 calls off N\*.
- **Post-compaction size P.** Every extra 10K kept adds 10K × (w − r) to Δ and takes 10K × r off
  each call's saving.
- **Misses.** On a 5-minute cache with human pauses, misses dominate the cost of carrying.

### 4.3 When the cache is already cold

If the last call is older than the cache lifetime, the next call pays C × w whether or not it
compacts. Compacting replaces that with P × w:

```
Δ_cold = I_s + O_s·o + P·w − C·w
```

- GPT-6.1 Sol (Codex), C = 120K: 36K + 25K + 30K − 120K = **−29K** (saves $0.06 on the first call).
  150K: −50K. 170K: −64K.
- Fable 5 (5m), C = 120K: 36K + 25K + 37.5K − 150K = **−51.5K** (saves $0.52). 150K: −80K.
  170K: −99K.

**Above about 80K, a compaction on a cold cache is cheaper than carrying from its very first call.**
(With P = 30K, the cold break-even is C ≈ 79K on GPT-6.1 Sol and C ≈ 66K on Fable 5. With
P = 45K it is C ≈ 100K and C ≈ 86K.) Use pi's summarizer here, not an
in-conversation Handoff: on a cold cache the in-conversation version would pay full price for all
of C.

### 4.4 Real sessions: what followed each crossing

For each path from root to leaf through the session tree, the analysis took the first call at or
above the level and counted the calls that followed, up to a compaction or the end of the path:

| Level | Paths crossing | Calls after (sorted) | User messages after |
|---|---|---|---|
| 100K | 12 (10 Codex, 2 Anthropic) | 0, 2, 3, 3, 4, 5, 13, 16, 24, 24, 34, 38 | |
| 120K | 5 (4 Codex, 1 Anthropic) | 0, 12, 21, 21, 31 | 0, 0, 1, 1, 3 |
| 150K | 1 (Codex) | 16 | 0 |
| 170K | 1 (Codex) | 6 | 0 |

The counts are censored at the user's own `/compact`, which three times came at 108–114K. These
sessions top out at 80–145K. Only one, a GPT-6.1 Sol session that ran past 230K across three
manual compactions, went beyond 150K.

**Counterfactual.** The question: compact at the crossing (pi summarizer, P = 30K, the path's own
provider prices) or carry on? Each later call was replayed with its real hit or miss:

| Level | Compaction would have cost more | Net per crossing (USD) |
|---|---|---|
| 100K | Codex 6 of 10; Anthropic 2 of 2 | Codex −0.17 to +0.23; Anthropic −0.76, −0.54 |
| 120K | Codex 1 of 4 (the path that ended at once); Anthropic 0 of 1 | Codex −0.19, +0.01, +0.11, +0.18; Anthropic +2.24 (four cold misses at 120–133K) |
| 150K | Codex 1 of 1 (−$0.004, break-even) | |
| 170K | Codex 1 of 1 (6 calls followed) | −0.13 |

The sample is small (5 crossings at 120K). Taken together with the per-call growth figures below,
it still puts break-even about where the levels sit.

**Context growth per call**, along each session branch:

| | Codex | Anthropic | All |
|---|---|---|---|
| All calls: median / mean / p90 | 0.61K / 2.3K / 5.4K | 1.7K / 3.0K / 7.0K | 0.74K / 2.4K / 5.9K |
| When context ≥ 80K: median / mean / p90 | 0.59K / 1.4K / 3.4K | 1.8K / 2.5K / 3.1K | 0.65K / 1.5K / 3.4K |

At a mean of 1.4K per call (Codex), going from 120K to 150K takes about 21 calls and from 150K to
170K about 14. On Anthropic, at 2.5K per call, it takes about 12 and 8. **The gap between levels
is about one break-even interval.**

## 5. Pruning has a cache cost too

Pruning removes tokens at some position q. Every token after q then becomes a new prefix and
must be prefilled cold once:

```
one-off cost = (C − q − X)·(w − r)      X = tokens pruned
saved per call = X·[ r·(1 − m) + w·m ]
```

Pruning X = 20K starting at q = 20K in a 120K context:

- GPT-6.1 Sol (Codex): 80K × 0.95 = 76K one-off, against 1K saved per call: **76 calls**
  (49 with measured misses).
- Fable 5 (5m): 80K × 1.15 = 92K, against 2K per call: **46 calls** (16 with misses).
- The same 20K pruned near the tail (q = 95K) pays back in about 5 calls.
- On a cold cache, or inside a compaction (which rebuilds the prefix anyway), the one-off cost is
  **zero**.

So on a warm cache, Pruning early entries one at a time costs more than it saves for any session
shorter than about 50–75 more calls. The 0.65K median growth per call means there is rarely much
new to prune between calls anyway.

## 6. What this means for the map

- **Levels.** At 120K / 150K / 170K the money is small: $0.18–0.21 per compaction against
  $0.009–0.014 per call carried, on the default model. Rot, not cost, should decide where the
  levels sit. The data does not argue against the defaults:
  - 120K: a compaction pays back only if work goes on 13–20 more calls, the median for sessions
    that cross 120K. That is about right for *notice* (a nudge, not a force).
  - 150K and 170K: break-even falls to 10–16 calls, and forcing at 170K is cost-neutral to cheap.
  - The user's own `/compact` habit (108–114K) sits just under *notice*.
  - Per-model overrides matter: a Fable 5.1 or GPT-6.1 Sol session on a warm cache needs 2–4×
    more calls to pay back than GPT-6 Sol or Fable 5.
- **Self-compaction timing.** The cheapest moment is right after the cache has gone cold: the
  agent's next call after a pause longer than 5 minutes on Anthropic, or about 30–60 minutes on
  Codex. Past about 80–100K that compaction saves money from its first call (§4.3). A natural break
  in the work, while the cache is still warm, costs N\* calls to recoup.
- **Who writes the Handoff (open on the map).** An in-conversation Handoff on a warm cache cuts Δ
  by about a third on the default model: summarizer input C × 0.05 instead of 0.3·C at full price.
  On a cold cache pi's separate, truncated summarizer is cheaper. Handoff length is the
  biggest lever under the extension's control: 1K output ≈ 5K input.
- **Pruning cadence.** Prune in batches: on a cold cache, or as part of a compaction. Never per
  call on a warm cache, unless the pruned entries sit near the tail.
- **Cache warming.** Pi does not warm `openai-codex` (no declared lifetime). On Anthropic it warms
  only while a run is streaming. Neither changes the human-pause misses that dominate Anthropic's
  cost of carrying.

## Assumptions and limits

- Handoff 5K tokens of output. Kept recent tokens 20K. System + tools 5K, so P = 30K; the measured
  P of 36–65K is covered by the P = 45K case. The summarizer is the session model, with input
  0.3 × C uncached (measured 0.25–0.35).
- Output and new per-call tokens are the same with and without compaction, so they cancel. The
  model ignores a later second compaction and any change in the agent's behaviour (re-reads after
  a lossy Handoff would add calls on the compacted side).
- Dollars are list-equivalent. Both providers are subscriptions here. Codex credit ratios match the
  API's exactly, with no cache-write charge. Claude subscription accounting is unpublished and
  assumed to follow API ratios.
- The 1-hour Anthropic rows assume a 3% miss rate. There is no local data with 1-hour retention.
- The session sample is one user over about two months. Only 5 paths crossed 120K and 1 crossed
  150K.
