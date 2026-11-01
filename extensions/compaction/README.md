# compaction

Earlier, calmer compaction for pi. It watches how full the context is against three **Pressure
levels** — notice, warning and forced — shows the user one quiet footer status once pressure
builds, and tells the agent, once per level, that it is a good time to compact.

The vocabulary is the repo's, defined in [`CONTEXT.md`](../../CONTEXT.md): **Context pressure** is
how full the context is in raw tokens, a **Pressure level** is one of the three bands it crosses,
**Self-compaction** is a compaction the agent starts at a natural break, **Pruning** shrinks context
without summarizing it, and the **Handoff** is what stands in for the span a compaction removed.

It is on by default, in main sessions and in Runs: see [Loading](#loading).

## Why

Long sessions get worse as they grow, well before the window is full, and pi's own compaction
fires only near the window (window − `reserveTokens`), which on a 1M-window model is almost never.
The levels are fixed token counts rather than a share of the window because rot and cost grow with
the raw count, whatever the window holds.

This builds on pi's compaction rather than replacing it
([ADR-0005](../../docs/adr/0005-build-on-pis-compaction.md)): pi's trigger, overflow recovery and
`/compact` all stay on as the backstop for whatever the levels miss.

## Loading

- **Main sessions.** The extension is in the package's `pi.extensions`, beside `subagents`,
  `web-fetch` and `web-search`, so pi loads it with the package. It has no on/off switch of its
  own; pi's package filter unloads it, as it would any other of the package's extensions:

  ```json
  { "packages": [{ "source": "git:github.com/hoangtmbk/pi-config", "extensions": ["!extensions/compaction/index.ts"] }] }
  ```

- **Runs.** Every Run loads it, whatever the filter says. A Run is spawned with
  `--no-extensions`, and the subagents extension adds this one with a second `-e` and puts
  `self_compact` in the Run's tool allowlist, whatever its Agent's own `tools` say, as it does for
  `ask_question`. A Run reads the same settings files as its parent (it runs in the parent's cwd
  without `--no-settings`), so it resolves the levels for its own model. Nothing is set per Agent or
  per Run.

## Pressure levels

| Level | Default | What happens as pressure crosses it |
|---|---|---|
| notice | 120,000 | One Pruning batch, if it frees enough; then, unless that brought pressure back under notice, a muted footer status and one steer to the agent. |
| warning | 150,000 | The status turns the warning colour, one steer to the agent, and one toast to the user. |
| forced | 170,000 | Compaction at that turn boundary, without ending the prompt; see [Forced compaction](#forced-compaction). |

The defaults can be changed, per model too, and shrink on a small window; see
[Configuration](#configuration). Pressure is read at every `turn_end`, from `ctx.getContextUsage()`. Three rules decide what a
boundary does:

- **A level is crossed while pressure is at or above it**, and re-arms only once pressure falls
  below it again. So each level acts once per crossing, not once per turn spent above it.
- **Only the highest level crossed at a boundary acts.** A turn that jumps from under notice past
  warning gets the warning steer and not notice's; notice is marked crossed all the same. A jump
  past forced compacts, and gets no steer and no toast at all.
- **A turn that didn't happen does nothing.** A turn the user aborted or the provider failed
  changes nothing and marks no level crossed — including the turn pi still ends as "completed"
  when Escape lands while tools are running, which is caught by the prompt's abort signal rather
  than the turn's outcome. A boundary with no reading (no model, or a compaction not yet answered)
  does nothing either.

## Configuration

The levels are set in one top-level `pressureLevels` key of pi's `settings.json` — global
(`~/.pi/agent/settings.json`) or project (`.pi/settings.json`, when the project is trusted) — and
read merged, with `pi.getSettings()`, at every `turn_end`:

```json
{
  "pressureLevels": {
    "notice": 120000,
    "warning": 150000,
    "forced": 170000,
    "modelOverrides": { "openai/gpt-6.1-sol": { "forced": 600000 } }
  }
}
```

- **Each level resolves on its own**: the model's override, then the plain setting, then the
  built-in default. Override keys are exact, case-sensitive `provider/modelId`, as in pi's own
  `compaction.modelOverrides`. So you can set just one level, for one model.
- **Scaling on a small window.** If no level came from the model's override, the model reports a
  window, and `forced` is not below pi's own trigger (window − `compaction.reserveTokens`, resolved
  per model the way pi does), all three levels are multiplied by one factor so that `forced` sits at
  85% of the trigger, with the same spacing. On a 128K window with pi's default 16,384 reserve that
  gives about 67K / 84K / 95K.
- **A model override is used exactly as written.** One that sets any level is never scaled and
  never warned about, even past pi's trigger — that is how you leave a model to pi's backstop on
  purpose.
- **Bad values fall back.** A level that isn't a positive whole number, a `pressureLevels`,
  `modelOverrides` or override entry that isn't an object, or a set that isn't strictly
  notice < warning < forced puts that model on the built-in defaults (still scaled), with one
  warning naming the bad key, once per distinct problem per session. Bad configuration never
  throws, and a bad `compaction.reserveTokens` is left to pi to report.
- **A model switch** re-resolves the levels for the new model at the next turn. A level already
  past counts as crossed, and only the highest crossed level acts: from a 1M-window model at 100K
  to a 128K one, that is forced.
- **`compaction.enabled: false`** turns off forced, and only forced: notice, warning, the steers,
  Pruning and our Handoff on `/compact` all go on, and the warning toast no longer says when
  compaction will be forced. The extension has no on/off switch of its own.
- **The kept tail** is pi's `compaction.keepRecentTokens`, resolved per model the way pi does, so
  `/compact`, pi's backstop and forced keep the same tail.
- **When an edit takes effect.** An edit to `settings.json` mid-session applies after `/reload` or a
  restart, not before. pi reads the file into memory only at startup and on `/reload`, and the
  extension never reads the file itself: it takes pi's copy, through `pi.getSettings()`, at every
  turn. So a change pi has taken in (at startup, on `/reload`, or through pi's own setters) is what
  the next turn goes by, and the levels always come from the same copy as pi's own
  `compaction.*`.

The extension never writes pi's settings and adds nothing under `compaction.*`. Nothing is set per
Agent or per Run.

The Pruning and Handoff numbers are code constants, not settings; the replay check is what tunes
them:

- the notice Pruning batch's minimum: 20K tokens;
- the protected window: the newest 40K tokens of tool output;
- the prunable floor: about 1K tokens;
- the kept `bash` lines: the last ~10, at most ~2,000 characters of them;
- the user-message budget: ~20K tokens in all, ~2K for any one message;
- serialized mode's tool-result cut: head 1,200 + tail 800 characters, halving to a 200 floor;
- the quote minimum: 12 characters;
- the stall timeout: 60s with nothing streamed.

## What the user sees

Below notice, nothing: pi's own footer, its percentage and its 70%/90% colouring are untouched.
From notice up, one extension status line under it, with the count live each turn:

```
ctx notice · 124k        (muted)
ctx warning · 152k       (warning colour; forced reads the same)
```

It clears as soon as pressure is back under notice. The one toast is at warning, the first time
pressure crosses it:

```
Context at 152k (warning). The agent has been told it's a good time to compact; forced at 170k.
```

There is no toast at notice, and none at forced. The other toasts are about compactions; see
[Forced compaction](#forced-compaction) and [The Handoff](#the-handoff).

## What the agent hears

One steer per crossing, as a hidden custom message:

| Level | Steer |
|---|---|
| notice | This is a good point to Self-compact at your next natural break, such as after finishing the current step. Finish what you are doing first. Don't shorten or skip work. |
| warning | Self-compact at your next natural break, before you start a new subtask. If you don't, compaction will happen for you, possibly in the middle of a step. |

They are deliberately calm: no token counts, nothing about running out or a limit, and nothing at
forced, because pressure that reads as a deadline makes a model cut corners.

A steer goes out with `deliverAs: "steer"`, so the agent takes it at its next turn boundary. The
one exception is the boundary that ends the prompt: a steer queued there would make pi run one
more turn just to answer it, so it is held with `deliverAs: "nextTurn"` and arrives with the user's
next prompt. A steer that Escape clears from pi's queue unread is not sent again; the level still
counts as crossed.

## Pruning at notice

At the first `turn_end` at or above notice, before the steer, one **Pruning batch** replaces old
bulky tool output and superseded reads with a one-line marker pointing at a saved full copy:

```
[Pruned: output of `npm test` (120,000 chars, exit 0). Full output: <session-dir>/<session-id>.pruned/<entry-id>.txt]
```

- **What it picks.** Old bulk: any tool result above about 1K tokens outside the newest 40K tokens
  of tool output (a result straddling that edge is inside it). Superseded reads, at any age: a
  `read` followed by a later successful `read` of the same file and range, or a whole-file
  `write`. An `edit` does not supersede a read — most of it stays true, and the agent builds its
  next edit from it.
- **What it never touches.** `ask_question`, `subagent`, `subagent_wait`, `subagent_answer` and
  `self_compact` results; any result with `isError: true`; a result with an image in it; one
  already edited, by us or another extension; and anything that isn't a tool result.
- **How.** Only by replacing a result's content with `context_edit` drafts, never omitting it, so
  every call keeps its result. A `bash` result keeps its last ~10 lines (at most 2,000 characters)
  after the marker. Its exit is always `exit 0`: pi marks every non-zero exit as an error, and
  errors are never pruned. Other tools get the marker alone, naming the tool and its first
  argument (`read src/a.ts`).
- **Only if it pays.** The batch costs one cache miss over everything after its earliest edit, so
  it goes out only if it frees at least 20K tokens. Below that, nothing is pruned and the steer
  goes out as usual. It runs once per notice crossing, never at warning, never on any other turn,
  and not at a boundary where a compaction already lands.
- **Then the steer.** Whether to steer is judged on the last measured usage minus what the batch
  frees — pi's own chars/4 count of the edited context runs high until the next response. Below
  notice there is no steer, the footer clears, and notice re-arms; so the agent is steered to
  Self-compact only once Pruning can no longer free enough.
- **Saved copies** go to `<session-dir>/<session-id>.pruned/<entry-id>.txt`, beside the session
  file, or, for a session with none (a `--no-session` Run), to `<os-tmpdir>/<session-id>.pruned/`.
  The agent reopens one with plain `read`. Nothing of ours cleans them up. A copy that can't be
  written drops its edit, so a marker never points at nothing.
- **Checked before it is returned.** If any draft at a boundary fails pi's replay, pi drops every
  extension's drafts there. So each edit is checked the way `appendContextEdit` checks it — the
  target is found, on the active branch, and editable — and one that fails is dropped with its
  pair, unsent and unsaved. The drafts follow earlier extensions' drafts, never replacing them.

## Forced compaction

At the first `turn_end` at or above forced — the turn that ends a prompt included, with no grace
period — the extension compacts at that boundary from `turn_end` (the **boundary path**). pi has
already run and persisted every tool of the turn, so nothing is in flight, and the prompt goes on
straight after, its next request built from the Handoff and the kept tail.

- **The cut** is pi's exported `findCutPoint` with pi's `keepRecentTokens`, fed the session's
  projection rather than its raw branch, starting after the newest compaction: a pruned result
  counts at its pruned size, as it does in pi's own preparation for `/compact`. So the tail is the
  one `/compact` would keep.
- **The drafts** go after any drafts earlier extensions proposed at that boundary, which stand:
  our compaction first, so pi measures its `tokensBefore` on the context as it was, then the kept
  tail's Pruning. Not at a boundary where an earlier extension already drafts a compaction.
- **Kept-tail Pruning.** The cache is cold after a compaction anyway, so the tail it keeps is
  pruned too, with no minimum gain: superseded reads only, with the same rules, marker, saved copy
  and edit checks as the notice batch. The rest of the tail stays verbatim — old bulk included —
  and nothing in the removed span is edited. Copies are saved only once the Handoff is written.
  The notice batch never runs at a boundary where a compaction lands. This is boundary-path only
  (forced and Self-compaction): `/compact` and pi's backstop do no kept-tail Pruning and store
  nothing for later ([#43](https://github.com/hoangtmbk/pi-config/issues/43)). pi takes no drafts
  from `session_before_compact`, and deferring the edits to the next `turn_end` would cost a cache
  miss of its own, since the first request after the compaction has already rebuilt the cache.
  That tail is pruned at the next notice batch that clears its minimum, or the next boundary
  compaction.
- **A sunk compaction is re-drafted once.** pi drops every draft at a boundary when any one of them
  won't replay, so another extension's bad draft sinks ours with it. The next boundary sees that no
  compaction landed (ours carries its `compactionNo`, so our previous one doesn't pass for it) and
  drafts the same Handoff over the same cut again, whatever pressure reads, with no writer called.
  Its kept-tail edits go with it, checked again against the branch. Sunk twice, or with its cut
  entry no longer on the branch, it is handled as every writer failing. An aborted or failed turn
  lets a forced one go silently (a Self-compaction waits; see below).
- **Forced is not spent by crossing it.** It acts at every boundary at or above it until a
  compaction lands. Three things hold it back: `compaction.enabled: false`; the **warning-pause
  guard** — once a compaction, on either path, leaves pressure at or above warning, a toast says
  so ("Compaction left context at 158k, still above warning. Forced compaction is paused until it
  drops.") and forcing waits until pressure is below warning; and every writer failing, which
  disarms it for the rest of the prompt (an error toast says why) and re-arms it at the next prompt.
  Escape during the writer chain stops it with no compaction and no toast, and leaves forced
  armed.
- **What the user sees:** pi's working row reads `Compacting at 172k (forced) · pruning old tool
  output…`, then `Compacting at 172k (forced) · writing Handoff…` while it writes, and is handed
  back to pi after. The footer status is cleared meanwhile (a Run's
  reads `ctx compacting`), and comes back after a compaction only at a reading still at notice or
  above; after a compaction that didn't happen, it shows where pressure stands. Then pi's own
  compaction card, drawn from the entry.

## Self-compaction

The `self_compact` tool (exported as `SELF_COMPACT_TOOL`) lets the agent compact at a natural
break, from notice up, and carry on in the same prompt, with nothing from the user. It is always
declared, so the tool list never changes and the prompt cache holds. Its one required parameter is
`note`: what the agent is doing and will do next, in its own words. There is no focus parameter,
and the description says nothing about running out or a limit.

- **Below notice it refuses**, saying the context isn't large enough yet for a compaction to help.
- **When pi's cut has nothing to remove**, from notice up, it compacts nothing and says so: "Not
  compacted: the older part of the conversation is too small to replace yet. Carry on with the
  task." No writer runs, so there is no toast and forced stays armed. This can happen when notice
  sits near `keepRecentTokens`, as with a model override or very low `pressureLevels`.
- **From notice up, `execute` compacts.** A tool can't append to the session, so it runs the same
  boundary path as forced — pi's cut, kept-tail Pruning, our Handoff from the writer chain — and
  keeps the compaction for that turn's `turn_end`, which applies it after the drafts earlier
  extensions proposed. The branch then ends at the assistant message making the call, so after
  it the agent sees the system prompt, the Handoff, then the kept tail ending in its own
  `self_compact` call and result. The notice batch and the steers are skipped at that boundary,
  as when forced lands. If an earlier extension's bad draft sinks it, it is re-drafted once like a
  forced one. One a sibling call's Escape cut short still lands, since the agent was told it did.
  For the same reason, one its own boundary can't draft — an earlier extension compacts there, or
  the turn didn't complete — is held, through any boundaries that can't draft it either, and drafted
  at the first that can; if pi drops it there, it is handled as every writer failing. One that
  someone else's compaction overtakes in the meantime is let go: the context was compacted.
- **It returns one plain line**, with no token counts: "Context compacted. The Handoff above
  carries the task; continue from its Next step." on success, and "Compaction failed; carry on
  with the task." when every writer fails (with the same error toast, and forced disarmed for the
  rest of the prompt, as on any path) or when Escape stops it mid-write (no toast, forced still
  armed). It promises no retry: after every writer failing, forced won't try again until the next
  prompt.
- **The note** opens the Handoff's Next step verbatim, labelled `Agent's note (verbatim)`, and the
  writer's instruction restates it and asks for the rest of Next step to agree with it, or say why
  it can't be followed. It lasts for that compaction only: it is not merged forward, and the next
  compaction's writer is shown the previous Handoff without it.
- **What the user sees:** pi's working row reads `Self-compacting · pruning old tool output…`, then
  `Self-compacting · writing Handoff…`, and the footer status as for forced.

## The Handoff

Every compaction gets our Handoff in place of pi's summary: forced and Self-compaction, on the boundary path, and
whatever reaches pi's `session_before_compact` — `/compact`, and pi's own threshold and overflow
backstop — on the hook path. Either way the cut is pi's, so the kept tail is exactly the one pi
would keep. Code writes the parts it can extract exactly; a writer
writes the judgment part:

| Part | Written by |
|---|---|
| User messages | code: every message the user typed in the removed span, verbatim and in order (an `ask_question` answer included; tool results and custom messages, our steers included, left out). Over ~20K tokens, the first message and the newest that fit are kept, with a marker counting the ones dropped between; one message over ~2K tokens is cut to its head and tail. |
| File state | code: `read`, `write` and `edit` tool calls applied in order — read only is `read`, a write to a file not seen before is `created`, anything else that changed it is `edited` — and `deleted` for the paths a successful `bash` `rm`, `git rm` or `mv` named (conservatively: quoting, globs, expansions and anything after a `cd` are skipped). |
| Constraint ledger | the writer proposes quotes in `<ledger>`; code checks them and merges them into the previous Handoff's ledger (see below). The `/compact` focus is code's own entry. |
| The judgment part | the writer chain: the forked call, then serialized mode, then pi's own summarizer, `generateSummaryWithUsage`, whose text stands in for the six judgment sections. |

`details` is the record: the summary is rendered from it, and the next compaction merges from the
previous `details` (user messages, file state, ledger) and never parses old summary text. That is
the newest compaction of ours, even when one that isn't ours (pi's default after our code threw,
another extension's) has landed on top: such a summary can't be read back, so the user messages and
file operations it removed are read from the branch itself, and the ledger carries on growing. It is
marked as ours by `kind: "handoff"`, and records `compactionNo`, the `writer`, the failed
`attempts` before it and a `log`. The rendered order is Goal, Constraint ledger, Progress,
Decisions and why, Open problems, Critical context, File state, User messages (verbatim), Next
step; when pi's summarizer wrote the judgment part, its text stands where the judgment sections
begin and the code-written parts follow it.

What the user sees: a warning toast, "Compaction used pi's default summary; the Handoff may be
thinner.", whenever pi's summarizer wrote it, and then pi's own compaction card. The footer status is
cleared while compacting (a Run's reads `ctx compacting`) and comes back at the next reading only if
pressure is still at notice or above. pi's working row is not relabelled: during a hook compaction
pi replaces it with its own compaction indicator, which `setWorkingMessage` does not reach.

### The Constraint ledger

The user's rules, preferences and exclusions, as exact quotes (`ledger.ts`). The writer proposes
`<add>` quotes and `<supersede><old>…</old><by>…</by></supersede>` pairs; code checks every one and
drops (into `details.log`) what fails:

- A quote must be found in a real user message: one the writer saw, kept tail included, or one in
  the previous `details`' user messages. Only whitespace differences are forgiven (each run counts as
  one space, and the entry is stored that way); case and punctuation are not. Under 12 characters
  it is dropped. Assistant text, tool results and custom messages never pass.
- An add contained in an active entry is a duplicate.
- A supersede's `old` must match exactly one active entry, exactly (whitespace aside, as above; a
  part of an entry matches none), and its `by` must pass the same check as an add. Otherwise the
  entry stays in force.
- A superseded entry stays in `details` with `supersededBy` (the user's words that replaced it), and
  is left out of the rendered Handoff. Nothing else ever leaves the ledger, and it has no size cap.
- A reply with no `<ledger>` adds nothing, and is logged; pi's summarizer proposes none.

`/compact <instructions>` is the compaction focus: the writer is told to give it the most care, and
it is stored as a `focus` entry, rendered `Compaction focus: "…"`. It lasts until the next `/compact`
with instructions, which supersedes it. The writer can't supersede it, and no add counts as its duplicate.

### The writer chain

The chain is the same on both paths. Writers are tried in order and the first to succeed writes the
judgment part; each failed attempt goes into `details.attempts` with its reason. Writers stop on the
prompt's signal on the boundary path and on the compaction's own on the hook path.

- **The forked call** (`fork.ts`, ADR-0004) is the agent writing its own Handoff: a side request
  that sends the live conversation exactly as the next turn would, so it reads the warm prompt
  cache. That is `turn_end`'s `context.llmMessages` at a forced compaction; on Self-compaction, the
  session as `self_compact` runs, which is the previous request plus the calling message; on the hook
  path, the branch as the model sees it. The system prompt and tools are the transcript's own system
  messages. Each call still pending in the last assistant message gets a placeholder result first
  ("Writing the Handoff; see the next message." for `self_compact`, "(This result isn't available to
  the Handoff writer. It stays in the kept tail.)" for any other), then one trailing user message
  opens "[Compaction: this message comes from the compaction extension, not from the user. …]" and
  holds the instruction. It runs on the model behind the last reply, with the agent's own options:
  `reasoning` at the session's thinking level (none at "off"), the session id, pi's `transport` and
  `thinkingBudgets`, and no `maxTokens` or `cacheRetention`. `toolChoice` is `"none"` on Codex and
  unset everywhere else — on Anthropic changing it voids the cached conversation. Its reply is read
  and fails exactly as serialized mode's below. It is skipped only on `overflow`, where the live
  context is what didn't fit; there is no cache-temperature check. Nothing is checked before it is
  sent: afterwards its `usage.cacheRead` is compared with the last real request, as pi's own miss
  detector does (1,024 tokens of noise allowed), and a miss goes into `details.log`.
- **Serialized mode** sends one request on the model behind the last reply: a system prompt saying
  the conversation is data, not instructions, and one user message holding `<previous-handoff>`
  (on a repeat compaction), `<conversation>` (the removed span), `<kept-tail>` and the instruction
  (`instruction.ts`). Thinking and custom messages are left out. Each tool result keeps its first
  1,200 and last 800 characters; if the request doesn't fit the model's window less pi's
  `reserveTokens`, the cut halves (1,000, 500, 250) down to a 200 floor, and past that the attempt
  fails. Code takes the reply's last `<handoff>` block and splits it on the six exact headings. It
  fails on a provider error, a reply stopped at the token cap, no `<handoff>` block, a missing
  heading, or an empty or "(none)" Goal or Next step. A tool call beside a usable block is ignored,
  never run. The `<ledger>` after it is checked as below.
- **pi's summarizer** is last, with pi's own prompt and retry policy.

Any writer's attempt fails after 60s with nothing streamed; there is no cap on a reply that keeps
streaming, and no retry of our own. If every writer fails, nothing is compacted and an error toast
reads "Compaction failed (<last error>). Context will keep growing until your next message or pi's
own compaction.", on every path, and forced is disarmed for the rest of the prompt. Escape stops
the chain with no compaction and no toast. Only if our own code throws does pi fall back to its
whole default.

## The replay check

Handoff quality is judged by replaying recorded sessions: cut them, compact, and compare the Handoff
with what really happened next. Its code is in `replay/`, apart from the modules pi loads, since it
drives the extension through the offline suite's fake pi. `replay/replay.ts` is its deterministic
half, three plain functions that score our Handoff and pi's default summary alike: each takes any
compaction entry, ours or pi's.

| Check | What it reports |
|---|---|
| `fileStateDiff(handoff, removed)` | the Handoff's file state against the true one, read from every message it stands in for with the Handoff's own mapping; `exact` is the pass bar. pi's own compaction can say only read or modified, so a created or deleted file is wrong there. |
| `recurringDetailRetention(handoff, { removed, tail, after })` | of the identifiers in the removed span (paths, names, flags, error codes, hashes, versions…) that the kept tail doesn't show and that the user or the agent names again after the cut before any tool result shows them, the share found word for word in the Handoff, beside its size. Capitals that are plain English (`NEVER` beside `never`) and bare numbers don't count. Reported, not gated; below 70% is the trigger to add an identifier dump. |
| `collapseGuard(chain)` | each Handoff in a chain counted — judgment size, ledger entries, files, user messages (dropped ones included), open items — and a flag for every count that fell from one Handoff to the next. |

They are tested offline on small fixture sessions written for the purpose, never real transcripts.

The live half is `npm run live:compaction` (about $45; `--quick`, the first session only, about
$5), run by hand and never by `npm test` or CI. It replays the sessions named in
`replay-manifest.json` beside this README, gitignored like the `replay-reports/` folder it writes
to, so that transcripts never reach the repo:

```json
{ "sessions": ["~/.pi/agent/sessions/<project>/<session>.jsonl", { "path": "…", "name": "the refactor" }] }
```

`--rejudge <report.json>` runs only the judge again, on a saved report's Handoffs and continuations
(about $1.30 for a full report): each saved cut is found in its recording by the recorded actions
its continuation was compared with, and everything is checked before anything is spent.
`--only "<session>#<depth>"` picks cuts; the rest keep their saved verdicts. It is how a change to
the judge is calibrated against the hand labels.

- **Cuts** (`replay-corpus.ts`): two or three per session, chained, at turn boundaries the recording
  really had: mid-run, as Self-compaction after the extension's real steer (the agent's own
  `self_compact` note goes to the Handoff; an agent that doesn't compact when steered is compacted as
  forced, and the report says so) or as forced; and just before a user message, as `/compact`. The
  kinds rotate across sessions, every cut has at least one recorded user turn after it (the judge sees up to three), and each
  removes at least `keepRecentTokens`. A session pi already compacted is skipped: with the
  extension loaded from the start pi never compacts first, and the rules before pi's compaction
  live on only in its summary. (A saved report's cuts in such a session can still be re-judged.)
- **Two lanes** (`replay-session.ts`): the extension, through the same fake pi the offline suite
  drives, and pi's own `compact`, with no extension, chained on its own summaries. Both run on the
  session's recorded model; a session whose model can't be reached is skipped.
- **The continuation** (`replay-continuation.ts`): from each lane's Handoff and kept tail, the model
  proposes actions; while each matches the recorded one, the recorded result is fed back, for at
  most three actions. The first that differs is judged. Nothing is executed.
- **The judge** (`replay-judge.ts`), GPT 6.1 Sol (`openai-codex/gpt-6.1-sol`) by default: the one
  checked against hand labels (#48) and passed with (#50), so that a re-run judges the same way.
  It sees both Handoffs blind, as A and B in alternating order, and scores ledger recall,
  violations, re-asks and redone work. A rule counts as carried only as the instruction itself, not
  as a record that it was once followed; re-reads, and what a rule the continuation's own Handoff
  carries calls for, are not redone work. Every verdict must cite its evidence and every rule must be the user's own words.
- **The report** (`replay-report.ts`): each pass bar for ours and pi's default — ledger recall ≥95%
  at every depth with no decline, 0 violations, ≤1/30 re-asks, ≤3/30 redone, exact file state, no
  worse than pi's default — then retention and the collapse guard (reported, not gated), the actual
  spend by what it went on, and every cut's findings with their evidence. A cut that errored or went
  unjudged makes the run inconclusive. A JSON of the raw results sits beside it, to hand-label from.

All of it but the runner itself (`test.ts`) is tested offline, against a scripted model on fixture
sessions.

## The status codec

`status.ts` exports `formatStatus` and `parseStatus`, which write and read the three statuses —
`ctx notice · 124k`, `ctx warning · 152k` and `ctx compacting`, always with a lowercase `k`. A Run
has no footer of its own: its `setStatus` travels to the parent as an RPC `extension_ui_request`,
and the parent's subagents extension reads it with the same codec, so what a child writes is
exactly what its parent parses. Outside the TUI the status is sent as plain text, and `parseStatus`
strips terminal colour anyway.

## Testing

Run from the repo root (`pi-config/`):

```bash
npm test                 # offline suite: no pi binary, no key, no network
npm run typecheck        # tsc --noEmit against pi's real .d.ts
```

The suite drives the extension only through a **recording fake pi**
([`tests/fake-pi.ts`](tests/fake-pi.ts)) around `registerCompaction(pi, options)`. A test sets
pi's side of the world — the pressure pi would report, the turn's messages, the mode, an Escape —
fires `turn_end` the way pi's runner chains it — or compacts through `session_before_compact`,
with pi's own preparation of the branch — and reads back what crossed pi's boundary: steers and
how they landed, footer statuses, toasts, working-row text, the boundary's drafts, the pruned
copies written, and compaction entries with their `details`. The model call is scripted
([`tests/scripted-model.ts`](tests/scripted-model.ts)). The session behind it is a real
in-memory `SessionManager`. `options` is how a test injects what would otherwise be real: the
model call the writers make, the folder for pruned copies, and the clock.

## Layout

```
index.ts        extension entry: registerCompaction, event wiring, steers, self_compact, footer, toasts
tools.ts        SELF_COMPACT_TOOL and the never-pruned tool names  (a leaf: imports nothing)
pressure.ts     the Pressure levels from settings, and which one a boundary acts on   (pure)
landing.ts      our boundary compactions from written to committed: Self-compaction's wait, re-drafts
cut.ts          pi's cut for the boundary path, and what a cut keeps, over what the model sees  (pure)
pruning.ts      Pruning: picks results, writes markers, checks edits, saves full copies
status.ts       the status codec, shared with the subagents extension  (pure)
handoff.ts      the Handoff: its details record, the parts code writes, merging, rendering
writers.ts      the writer chain, the stall timeout, and pi's summarizer as its last writer
chain.ts        the writer chain for one compaction, assembled from pi's settings and the session
instruction.ts  the writer's instruction, in both modes' wording, and the reply parser  (pure)
fork.ts         the forked call: the live context, placeholder results, the cache-miss check
serialized.ts   serialized mode: the transcript, the tool-result cut and its halving
replay/         the replay check, apart from what pi loads:
  replay.ts               its deterministic checks  (pure)
  replay-corpus.ts        the manifest, reading a recording, its turn boundaries and the chain of cuts  (pure)
  replay-session.ts       one session replayed in both lanes: ours and pi's default
  replay-continuation.ts  the open-loop continuation: match, feed back, stop at the first difference
  replay-judge.ts         the judge's request and the checked reading of its verdict
  replay-report.ts        the spend, the pass bars and the report
test.ts         the live replay check: `npm run live:compaction`, by hand only
tests/          offline suite, the recording fake pi, the scripted model call, pi internals reached by path
```
