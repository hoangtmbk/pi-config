# Async spawn with explicit join

`subagent` returns a run's name immediately rather than blocking the parent turn until the child
finishes. Blocking delegation — what pi's bundled example does — is markedly simpler: no run
registry, no delivery routing, no orphan reconciliation. It also makes genuine fan-out impossible
and makes a progress widget pointless, since a blocked parent could just stream the child inline.
Both were explicit goals, so async wins; `subagent_wait` restores the blocking case as a
deliberate join rather than the only mode.

## Consequences

A finished run needs a delivery policy, because the parent may be idle or mid-turn when it
completes: results are both queued in a mailbox that `subagent_wait` drains, and auto-delivered via
`pi.sendMessage` — `triggerTurn` when the parent is idle, `deliverAs: "steer"` when it is
streaming, so nothing lands mid-tool-call. Auto-delivery alone cannot express a deliberate join;
a mailbox alone silently rots results the agent forgets to collect. Concurrency is capped at 4 with
a queue, since the binding constraint on parallel runs is provider rate limits.
