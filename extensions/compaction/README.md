# compaction

Earlier, calmer compaction for pi. It watches how full the context is against three **Pressure
levels** — notice, warning and forced — shows the user one quiet footer status once pressure
builds, and tells the agent, once per level, that it is a good time to compact.

The vocabulary is the repo's, defined in [`CONTEXT.md`](../../CONTEXT.md): **Context pressure** is
how full the context is in raw tokens, a **Pressure level** is one of the three bands it crosses,
**Self-compaction** is a compaction the agent starts at a natural break, **Pruning** shrinks context
without summarizing it, and the **Handoff** is what stands in for the span a compaction removed.

> **Work in progress.** What is here today is the Pressure levels, the footer status, the
> steers and the notice Pruning batch. Forced compaction, Self-compaction, kept-tail Pruning and
> the Handoff are still to come, so nothing compacts yet and forced does nothing. The extension is not in the package's
> `pi.extensions` until the Handoff has passed its replay check; until then load it by hand:
>
> ```bash
> pi -e ./extensions/compaction/index.ts
> ```

## Why

Long sessions get worse as they grow, well before the window is full, and pi's own compaction
fires only near the window (window − `reserveTokens`), which on a 1M-window model is almost never.
The levels are fixed token counts rather than a share of the window because rot and cost grow with
the raw count, whatever the window holds.

This builds on pi's compaction rather than replacing it
([ADR-0005](../../docs/adr/0005-build-on-pis-compaction.md)): pi's trigger, overflow recovery and
`/compact` all stay on as the backstop for whatever the levels miss.

## Pressure levels

| Level | Default | What happens as pressure crosses it |
|---|---|---|
| notice | 120,000 | One Pruning batch, if it frees enough; then, unless that brought pressure back under notice, a muted footer status and one steer to the agent. |
| warning | 150,000 | The status turns the warning colour, one steer to the agent, and one toast to the user. |
| forced | 170,000 | Compaction, without ending the run. *(Not yet: today nothing happens.)* |

Pressure is read at every `turn_end`, from `ctx.getContextUsage()`. Three rules decide what a
boundary does:

- **A level is crossed while pressure is at or above it**, and re-arms only once pressure falls
  below it again. So each level acts once per crossing, not once per turn spent above it.
- **Only the highest level crossed at a boundary acts.** A turn that jumps from under notice past
  warning gets the warning steer and not notice's; notice is marked crossed all the same. A jump
  past forced gets no steer at all.
- **A turn that didn't happen does nothing.** A turn the user aborted or the provider failed
  changes nothing and marks no level crossed — including the turn pi still ends as "completed"
  when Escape lands while tools are running, which is caught by the run's abort signal rather
  than the turn's outcome. A boundary with no reading (no model, or a compaction not yet answered)
  does nothing either.

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

There is no toast at notice, and none at forced.

## What the agent hears

One steer per crossing, as a hidden custom message:

| Level | Steer |
|---|---|
| notice | This is a good point to Self-compact at your next natural break, such as after finishing the current step. Finish what you are doing first. Don't shorten or skip work. |
| warning | Self-compact at your next natural break, before you start a new subtask. If you don't, compaction will happen for you, possibly in the middle of a step. |

They are deliberately calm: no token counts, nothing about running out or a limit, and nothing at
forced, because pressure that reads as a deadline makes a model cut corners.

A steer goes out with `deliverAs: "steer"`, so the agent takes it at its next turn boundary. The
one exception is the boundary that ends the run: a steer queued there would make pi run one more
turn just to answer it, so it is held with `deliverAs: "nextTurn"` and arrives with the user's next
prompt. A steer that Escape clears from pi's queue unread is not sent again; the level still counts
as crossed.

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
fires `turn_end` the way pi's runner chains it, and reads back what crossed pi's boundary: steers
and how they landed, footer statuses, toasts, working-row text, the boundary's drafts and the
pruned copies written. The session behind it is a real
in-memory `SessionManager`. `options` is how a test injects what would otherwise be real: the
model call the writers make, the folder for pruned copies, and the clock.

## Layout

```
index.ts        extension entry: registerCompaction, event wiring, steers, footer, toasts
pressure.ts     the Pressure levels, and which one a boundary acts on   (pure — no pi, no I/O)
pruning.ts      Pruning: picks results, writes markers, checks edits, saves full copies
status.ts       the status codec, shared with the subagents extension  (pure)
tests/          offline suite and the recording fake pi
```
