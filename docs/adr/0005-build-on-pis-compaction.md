# Build on pi's compaction, not replace it

The compaction extension adds Pressure levels, Self-compaction, Pruning and its own Handoff on top
of pi's compaction, and leaves pi's own on: the threshold trigger (window − `reserveTokens`), the
overflow recovery, `/compact` and the compaction entry itself all stay pi's. Our levels sit earlier
than pi's trigger and act first; pi's trigger and overflow recovery are the last-resort backstop
for whatever ours miss, such as a single turn whose tool results overshoot the window. Every
compaction, whoever starts it, is still a pi compaction entry: ours are drafted from `turn_end`,
pi's arrive through `session_before_compact`, and both carry our Handoff. Replacing pi's compaction
(turning it off with `compaction.enabled: false` and owning every trigger) was rejected: it would
mean rebuilding overflow recovery, which only pi can do mid-request, and `/compact`, and it would
leave a session with nothing at all when our code fails. Building on it costs us only the
discipline to stay out of pi's way.

## Consequences

The extension never writes pi's settings and reads its own from a separate `pressureLevels` key, so
`compaction.enabled: false` keeps its meaning ("never compact unless someone chooses to") and turns
off only our forced level. The kept tail is pi's `keepRecentTokens` and the cut is pi's exported
`findCutPoint`, so every path keeps the same tail. Pi's trigger can still fire on top of ours when
our levels sit above it (a model override that leaves a model to pi's backstop, or a compaction
that left pressure high); it then compacts through our `session_before_compact` hook, so it still
gets our Handoff. When every writer of ours fails, nothing is compacted and pi's trigger remains as
the backstop rather than us forcing a poor Handoff. Pi's own summarizer (`generateSummary`) is the
last writer in our chain on both paths, inside our Handoff, so pi's default is a fallback, not a
competitor. The spec is [#32](https://github.com/hoangtmbk/pi-config/issues/32).
