# compaction

Earlier, calmer compaction for pi. It watches how full the context is against three **Pressure
levels** — notice, warning and forced — shows the user one quiet footer status once pressure
builds, and tells the agent, once per level, that it is a good time to compact.

The vocabulary is the repo's, defined in [`CONTEXT.md`](../../CONTEXT.md): **Context pressure** is
how full the context is in raw tokens, a **Pressure level** is one of the three bands it crosses,
**Self-compaction** is a compaction the agent starts at a natural break, **Pruning** shrinks context
without summarizing it, and the **Handoff** is what stands in for the span a compaction removed.

> **Work in progress.** What is here today is the Pressure levels, the footer status and the
> steers. Forced compaction, Self-compaction, Pruning and the Handoff are still to come, so
> nothing compacts yet and forced does nothing. The extension is not in the package's
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
and how they landed, footer statuses, toasts and working-row text. The session behind it is a real
in-memory `SessionManager`. `options` is how a test injects what would otherwise be real: the
model call the writers make, the folder for pruned copies, and the clock.

## Layout

```
index.ts        extension entry: registerCompaction, event wiring, steers, footer, toasts
pressure.ts     the Pressure levels, and which one a boundary acts on   (pure — no pi, no I/O)
status.ts       the status codec, shared with the subagents extension  (pure)
tests/          offline suite and the recording fake pi
```
