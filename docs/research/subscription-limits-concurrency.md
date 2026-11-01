# How concurrent Claude Code sessions share one subscription's limits

Date: 2026-11-01 · Ticket: #77 · Map: #74

Question: when several Claude Code sessions run at once on **one** consumer subscription, how do
they share usage and rate limits, and what happens when a limit is hit mid-task? Specifically:
per account or per session; the 5-hour and weekly windows; model-specific caps; how a session
behaves when limited; whether that state is visible from outside the session.

Facts only. Each claim is tagged:

- **[doc]** stated in an official Anthropic source (Help Center, claude.com/pricing,
  code.claude.com docs). All were read on 2026-11-01. The Help Center pages carry no calendar
  date, only "Updated yesterday".
- **[anecdotal]** reported by users in `anthropics/claude-code` GitHub issues. Not confirmed by
  Anthropic. Most of these issues were auto-closed as duplicates or as inactive.

## Sources

| Key | Source |
|---|---|
| HC-limits | Help Center, "How do usage and length limits work?" — https://support.claude.com/en/articles/11647753-understanding-usage-and-length-limits |
| HC-cc | Help Center, "Use Claude Code with your Pro, Max, or Ultra plan" — https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan |
| HC-max | Help Center, "What is the Max plan?" — https://support.claude.com/en/articles/11049741-what-is-the-max-plan |
| HC-fable | Help Center, "Claude Fable models on your plan" — https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan |
| HC-promo | Help Center, "Claude Code May–August 2026 weekly limits promotion" — https://support.claude.com/en/articles/15910845 |
| Pricing | https://claude.com/pricing |
| CC-errors | Claude Code docs, Error reference — https://code.claude.com/docs/en/errors |
| CC-interactive | Claude Code docs, Interactive mode, "Wait for a usage limit to reset" — https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset |
| CC-costs | Claude Code docs, Manage costs — https://code.claude.com/docs/en/costs |
| CC-statusline | Claude Code docs, Status line — https://code.claude.com/docs/en/statusline#rate-limit-usage |
| CC-hooks | Claude Code docs, Hooks — https://code.claude.com/docs/en/hooks#stopfailure |
| CC-headless | Claude Code docs, Headless / `-p` — https://code.claude.com/docs/en/headless |
| CC-sdk | Claude Code docs, Agent SDK TypeScript reference — https://code.claude.com/docs/en/agent-sdk/typescript |
| CC-model | Claude Code docs, Model configuration — https://code.claude.com/docs/en/model-config |

## 1. Plans that exist today

The ticket names Pro / Max 5x / Max 20x. The current pricing page lists a different line-up
**[doc: Pricing]**:

| Plan | Price | Allowance (pricing-page wording) | 5-hour limit | Fable |
|---|---|---|---|---|
| Pro | $20/mo ($17/mo annual) | "More usage than Free" every 5 hours and every week | yes | usage credits only |
| Max | $100/mo | "5x Pro usage" every 5 hours and every week | yes | included, up to half the weekly limit |
| Ultra | $200/mo | "10x Pro usage" every week | **none for verified accounts** | included, up to 50% of weekly limits |

- No "Max 20x" tier appears on the pricing page or on HC-max. HC-max states Max gives "five
  times the Pro plan's usage every five hours and every week". **[doc: Pricing, HC-max]** Older
  issues and third-party guides still refer to Max 20x. Whether legacy 20x subscriptions continue
  is not documented in the sources read.
- Anthropic publishes **no absolute numbers** (tokens, messages or hours) for any window. Only
  the multiples above. **[doc: Pricing, HC-limits]** How fast a window fills "depends on the model,
  chat length, and file size", the features used, and the effort level. **[doc: Pricing, HC-limits]**
- Since 2026-09-14, weekly limits *in Claude Code* are 25% higher than before the May–Sept
  promotion. 5-hour limits were not changed. **[doc: HC-promo]**

## 2. Per account, not per session

- Limits belong to the **account/plan**. All surfaces draw from one pool: "your usage of all
  different Claude product surfaces (claude.ai, Claude Code, Claude Desktop) counts towards the
  same usage limit." **[doc: HC-limits]** "These limits are shared across Claude and Claude Code,
  meaning all activity in both tools counts against the same limits." IDE usage is included too.
  **[doc: HC-cc]**
- Nothing in the docs gives a session, process or terminal its own allowance. N concurrent
  Claude Code sessions, plus any claude.ai chat the human does, all drain the same 5-hour and
  weekly meters. **[doc: inferred directly from the two statements above. No doc talks about
  "concurrent sessions" by name.]**
- Every subagent, workflow agent and agent-team teammate sends its own requests that "draw on
  your usage". Agent-team token use is "roughly proportional to team size", and about 7x a
  standard session when teammates run in plan mode. **[doc: CC-costs]**
- Idle sessions can still spend: prompt suggestions, session recap, idle compaction, scheduled
  `/loop` tasks, goal check-ins, and inbound cross-session messages each start requests that
  carry the session's full context. **[doc: CC-costs, "Background token usage" and "Why usage
  climbs in a long session"]**

## 3. The windows

| Window | Semantics | Source |
|---|---|---|
| 5-hour "session" limit | "The period starts when you send your first message, and your limit resets in full five hours later." Pro and Max have it. Verified Ultra does not. | [doc: HC-limits, HC-cc] |
| Weekly limit | Applies across all models. "Resets at a fixed time each week that is assigned to your account". This does not depend on when you start using Claude. | [doc: HC-limits, HC-max] |
| Weekly Fable limit | Max/Ultra: Fable may use up to 50% of the weekly limit. It is a ceiling inside the weekly pool, not extra capacity. Pro: Fable bills to usage credits from the start. | [doc: HC-fable, HC-cc] |
| Opus / Sonnet limits | Claude Code has distinct messages, `You've hit your Opus limit · resets …` and `You've hit your Sonnet limit · resets …`. They "apply only to requests to that model family". | [doc: CC-errors] |

- Usage counts against the 5-hour and weekly allowances **at the same time**. "A single burst
  of heavy activity, such as a large workflow fanout, can exhaust the weekly allowance before the
  session window resets." **[doc: CC-errors]**
- HC-max adds: "Additional usage limits may apply to manage capacity and ensure fair access."
  **[doc: HC-max]**
- None of the Help Center pages read describes a separate Opus or Sonnet allowance, or its size.
  Only the Claude Code error reference names those limits. **[doc: gap]**
- The Help Center once described an automatic Opus→Sonnet switch at a usage threshold
  (Max 5x at 20%, Max 20x at 50%). That text is not on the current pages. **[anecdotal / historic:
  search snippet of an old support.anthropic.com version; current HC-cc has no such text]**

## 4. What a session does when a limit is hit

### Messages

```
You've hit your session limit · resets 3:45pm
You've hit your weekly limit · resets Mon 12:00am
You've hit your Opus limit · resets 3:45pm
You've hit your Sonnet limit · resets 3:45pm
```

- "Claude Code blocks further requests until the reset time shown." Session and weekly limits
  are shared across all models, "so switching models doesn't restore access". After an Opus or
  Sonnet limit, `/model` to a model outside that family keeps you working. A model switch loses the
  prompt cache, so the next request re-reads the whole conversation. **[doc: CC-errors]**
- Early warning: `You've used 85% of your session limit · resets 3:45pm`. **[doc: CC-errors]**
- **Wrap-up allowance**: if the 5-hour limit is hit mid-response, Claude Code may finish the
  current step and shows `Usage limit reached · wrapping up`. It applies only to a response
  already in progress. On Max it can apply at each 5-hour limit. On Pro, only once per week.
  **[doc: HC-cc]**

### Auto-wait and continue (v2.1.234+)

- On by default in **interactive sessions signed in with a claude.ai subscription**. Claude Code
  waits in the open session and, at the reset, injects a continuation ("Usage limit reset ·
  Continuing automatically"). It does not resend the last message. Footer lines:
  `Usage limit reached · limit resets 3:45pm` / `Continuing automatically at 3:45pm · Esc to cancel`.
  **[doc: CC-interactive]**
- It re-arms at most twice in a row. After that it shows
  `Automatic continue stopped after repeated usage-limit hits · /rate-limit-options to try again`.
  The continued turn still stops on permission prompts. **[doc: CC-interactive]**
- **Not started automatically** for: agent-team teammate sessions and Remote Control sessions (a
  person must run `/rate-limit-options`); resets more than 24 h away, which includes most weekly
  limits; an Opus/Sonnet limit while running a model outside that family. **[doc: CC-interactive]**
- **Not offered at all** for background sessions, `-p` runs, API keys, and cloud providers.
  **[doc: CC-interactive]**
- The wait is cancelled if a prompt is sent, the session exits (it does not restart on resume),
  `/clear`, `/resume`, `/login`, rewind, a `UserPromptSubmit` hook blocks the continuation, and
  similar actions. **[doc: CC-interactive]**
- Controlled by `autoContinueAtUsageLimit` (settings) or the `/config` toggle "Continue
  automatically at usage limit". **[doc: CC-interactive]**
- Unattended alternative: `CLAUDE_CODE_RETRY_WATCHDOG=1` retries 429/529 indefinitely.
  `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS` (60000–10800000) re-checks whether a
  usage limit has lifted while a request waits. **[doc: CC-errors, "Tune retry behavior"]**

### Model fallback

- `--fallback-model` / `fallbackModel` chains switch only on overload, unavailability, or other
  non-retryable server errors. "Authentication, billing, **rate-limit**, request-size, and
  transport errors … never trigger a switch." **[doc: CC-model, "Fallback model chains"]** A usage
  limit therefore does **not** fall back automatically. Switching is manual (`/model`), and helps
  only for Opus/Sonnet family limits.
- Separate mechanism: content-classifier fallback (Fable/Opus 5.5/Sonnet 5.5/Opus 5 → an older
  model on cyber/bio flags). It is unrelated to limits. **[doc: CC-model]**
- Fable on Max: when the Fable half-weekly cap is reached, Claude Code shows a usage-credits
  consent prompt. In agent-team teammate, background and Remote Control sessions, the prompt waits
  `dialogExpiry` (default 5 min). If nobody answers, the turn ends with "the prompt to confirm went
  unanswered — nothing was sent". In `-p` and SDK apps without the prompt, Fable bills to usage
  credits **without asking**. **[doc: CC-model "Fable and usage credits", CC-errors]**

### Throttles that are not the plan quota

- `API Error: Server is temporarily limiting requests (not your usage limit)`: a short-lived
  server-side throttle. Claude Code tells it apart from the plan limit by the absence of the
  unified quota headers. Since v2.1.199 it is retried with backoff before it is shown. **[doc: CC-errors]**
- `API Error: Repeated 529 Overloaded errors`: capacity across all users. It "doesn't count
  against your quota", and capacity is tracked per model. **[doc: CC-errors]**
- Retries: up to 10 attempts (`CLAUDE_CODE_MAX_RETRIES`, capped at 15) with exponential backoff
  before an error is shown. **[doc: CC-errors]**
- For 429s, the docs advise "Reduce concurrency: avoid running many parallel subagents".
  **[doc: CC-errors, "Request rejected (429)"]**

## 5. Real-world multi-session behaviour [anecdotal]

- **Burst-start throttling.** Spawning ~10 `claude` sessions back-to-back right after a 5-hour
  reset: the first 3–4 work, and the rest fail with "Server is temporarily limiting requests (not
  your usage limit)". Staggering launches by ~2–5 s reportedly gets all of them through.
  Commenters believe there is an account-scoped concurrent-request cap that does not scale with
  the plan multiplier. Anthropic did not confirm this. Closed as not planned.
  https://github.com/anthropics/claude-code/issues/53922
- **2–3 parallel sessions below the cap get 429s**: one session works while the others return
  `rate_limit_error: This request would exceed your account's rate limit`, with weekly usage
  around 65% and session usage around 5%.
  https://github.com/anthropics/claude-code/issues/46037 (dup of #40273),
  https://github.com/anthropics/claude-code/issues/61277 (dup of #53922),
  https://github.com/anthropics/claude-code/issues/40273 (Max 20x users, "API Error: Rate limit
  reached" when spawning more than one agent. Closed not planned.)
- **Usage endpoint saturation.** With 10–15 concurrent sessions, each one polls
  `GET /api/oauth/usage`. That endpoint's per-account limit trips (429, `retry-after` ~500–700 s)
  and stays tripped for hours. Model requests are unaffected, but `/usage` and status-line usage go
  stale. https://github.com/anthropics/claude-code/issues/77477 (closed, inactive),
  https://github.com/anthropics/claude-code/issues/31319. The docs confirm the symptom: `/usage`
  falls back to last-known bars (≤ 60 min old) "most often because the usage endpoint is rate
  limited". **[doc: CC-costs]**
- **Status-line percentages differ between terminals.** `rate_limits.five_hour.used_percentage`
  reflects each session's last API response, so concurrent terminals show different values for the
  same account-wide meter. https://github.com/anthropics/claude-code/issues/75408 (open)
- **Inconsistent auto-resume UI** across two concurrent Desktop sessions hitting the limit at the
  same moment. https://github.com/anthropics/claude-code/issues/86347
- Many reports say windows drain much faster than expected on Max (e.g. #38335, #90675). They
  are not specific to concurrency and are listed for context only.

## 6. Detecting limit state from outside a session

| Channel | What it gives | Source |
|---|---|---|
| **Status line** `rate_limits` JSON (piped to the statusLine command) | `five_hour.used_percentage`, `seven_day.used_percentage` (0–100), `*.resets_at` (epoch s). Pro/Max/Ultra only, and only after the session's first API response. Each window may be absent, and a window is dropped once `resets_at` passes. It is a per-session snapshot (see #75408). No per-model (Opus/Sonnet/Fable) field is listed. | [doc: CC-statusline] |
| **`StopFailure` hook** | Fires instead of `Stop` when a turn ends on an API error. Input `error` is one of `rate_limit`, `overloaded`, `billing_error`, `server_error`, … and is matchable. `last_assistant_message` holds the error string. Output is ignored, so it can be used for side effects only. | [doc: CC-hooks] |
| **`Notification` hook** types | `quota_auto_resume_fired`, `quota_auto_resume_stale`, `quota_auto_resume_disabled`. `idle_prompt` is **not** sent while waiting for a usage-limit reset. | [doc: CC-hooks] |
| **`-p` / stream-json** | Exit code 0 on success and non-zero when the run fails. The failure is printed as the result on stdout. `system/api_retry` events carry `error: "rate_limit"`, `error_status`, `retry_delay_ms`. | [doc: CC-headless] |
| **Agent SDK** | `SDKRateLimitEvent` (`type: "rate_limit_event"`, `status: allowed / allowed_warning / rejected`, `resetsAt`, `utilization`, `errorCode: "credits_required"`). `SDKAssistantMessageError = 'rate_limit'` (429 against quota) vs `'overloaded'` (529). Sending `/usage` as a prompt returns a structured `SDKUsageReport` with server-supplied `rate_limits.limits[]` rows (`kind`, `percent`, `resets_at`, `scope.model`, `is_active`) — experimental. | [doc: CC-sdk] |
| **`/usage`** (interactive) | Plan usage bars and reset times from the server. The attribution breakdown is computed from local history on this machine only, so it excludes other devices and claude.ai. | [doc: CC-costs] |
| **`/status`** | HC-cc says to "monitor your remaining allocation" with it. CC-errors uses it to confirm the active credential (e.g. a stray `ANTHROPIC_API_KEY`). Its exact output is not documented in the sources read. | [doc: HC-cc, CC-errors] |
| **Terminal text** | The literal messages in §4 appear in the TUI. A process scraping the pane (e.g. tmux `capture-pane`) would see them. This is inferred from the docs and has not been tested. | [doc-derived] |
| **Transcript JSONL** | Not documented in the sources read. Unknown whether limit events are written in a stable form. | gap |

## 7. Open gaps

- No published numbers for any window, and no published limit on **concurrent requests or
  sessions per account**. The only evidence for a concurrency throttle is anecdotal (§5).
- Size and existence of separate Opus/Sonnet weekly limits on current plans. The error strings
  exist, but no Help Center page describes the limits.
- Whether legacy Max 20x subscriptions still exist alongside Max ($100, 5x) and Ultra.
- Whether usage-limit events are written to the session transcript in a parseable form.
