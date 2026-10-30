# compaction

Earlier, calmer compaction for pi. It watches how full the context is against three **Pressure
levels** — notice, warning and forced — shows the user one quiet footer status once pressure
builds, and tells the agent, once per level, that it is a good time to compact.

The vocabulary is the repo's, defined in [`CONTEXT.md`](../../CONTEXT.md): **Context pressure** is
how full the context is in raw tokens, a **Pressure level** is one of the three bands it crosses,
**Self-compaction** is a compaction the agent starts at a natural break, **Pruning** shrinks context
without summarizing it, and the **Handoff** is what stands in for the span a compaction removed.

> **Work in progress.** What is here today is the Pressure levels, the footer status, the
> steers, and our Handoff on `/compact` and pi's own backstop, written by pi's summarizer. Forced
> compaction, Self-compaction, Pruning and the Handoff's own writers are still to come, so forced
> does nothing yet. The extension is not in the package's
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
| notice | 120,000 | A muted footer status, and one steer to the agent. |
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

## The Handoff

Every compaction that reaches pi's `session_before_compact` — `/compact`, and pi's own threshold
and overflow backstop — gets our Handoff in place of pi's summary. The cut is pi's, so the kept
tail is exactly the one pi would keep. Code writes the parts it can extract exactly; a writer
writes the judgment part:

| Part | Written by |
|---|---|
| User messages | code: every message the user typed in the removed span, verbatim and in order (an `ask_question` answer included; tool results and custom messages, our steers included, left out). Over ~20K tokens, the first message and the newest that fit are kept, with a marker counting the ones dropped between; one message over ~2K tokens is cut to its head and tail. |
| File state | code: `read`, `write` and `edit` tool calls applied in order — read only is `read`, a write to a file not seen before is `created`, anything else that changed it is `edited` — and `deleted` for the paths a successful `bash` `rm`, `git rm` or `mv` named (conservatively: quoting, globs, expansions and anything after a `cd` are skipped). |
| Constraint ledger | carried forward from the previous Handoff. *(Not yet added to.)* |
| The judgment part | the writer chain. *Today only its last writer: pi's own summarizer, `generateSummaryWithUsage`, whose text stands in for the six judgment sections.* |

`details` is the record: the summary is rendered from it, and the next compaction merges from the
previous `details` (user messages, file state, ledger) and never parses old summary text. It is
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

If the writer fails, nothing is compacted and an error toast says why; Escape stops it with no
compaction and no toast. Only if our own code throws does pi fall back to its whole default.

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
with pi's own preparation of the branch — and reads back what crossed pi's boundary: steers and how
they landed, compaction entries and their `details`, footer statuses, toasts and working-row text.
The model call is scripted ([`tests/scripted-model.ts`](tests/scripted-model.ts)). The session
behind it is a real in-memory `SessionManager`. `options` is how a test injects what would otherwise be real: the
model call the writers make, the folder for pruned copies, and the clock.

## Layout

```
index.ts        extension entry: registerCompaction, event wiring, steers, footer, toasts
pressure.ts     the Pressure levels, and which one a boundary acts on   (pure — no pi, no I/O)
status.ts       the status codec, shared with the subagents extension  (pure)
handoff.ts      the Handoff: its details record, the parts code writes, merging, rendering
writers.ts      the writer chain, and pi's summarizer as its last writer
tests/          offline suite, the recording fake pi and the scripted model call
```
