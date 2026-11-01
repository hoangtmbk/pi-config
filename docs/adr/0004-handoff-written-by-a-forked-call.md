# The Handoff is written by a forked call

The judgment part of every Handoff (the plan, where the work stands, loose ends, the next step) is
written by a forked call: a side request on the session's own model and thinking level that sends
the live conversation exactly as the agent's next turn would, plus one Handoff instruction, and is
never persisted. Pi's default summarizer serializes the transcript into one user message, cuts
each tool result to 2,000 characters and deliberately skips the cache. A fork sees everything the
agent sees, reasoning included, knows the plan as well as the agent does, and runs on every path,
including those with no agent turn to spend (`/compact`, the forced level, pi's backstop). On a
warm cache it also costs less than pi's default. Having the working agent write the Handoff in its
own turn was rejected, because that only works for Self-compaction. Writing it with a cheaper
summarizer model was rejected too, because only the session model can read the cache.

## Consequences

The fork is always used while the context fits, even on a cold cache, where it costs about twice
pi's default (a dollar or so on Fable 5): rot, not cost, decides here, and a cold cache mostly
means a `/compact` typed after a pause. Serialized mode, the same instruction over a serialized
transcript, exists only for overflow, where the live context can't be sent, and as the fallback
when the fork fails. Pi's default summary comes last, on both paths. Building the fork
means following pi's request shape: the system prompt and tools come from the transcript's system
messages and not from `getSystemPrompt`, `cacheRetention` stays unset, and on Anthropic
`tool_choice` must not be set, since changing it drops the cached conversation. So on Anthropic
"don't call tools" is only an instruction, and any tool call in the fork's reply is ignored. An
extension that rewrites requests (a `context` handler, `before_provider_request`, hidden tool
declarations) makes the fork miss without warning, so misses are detected afterwards from
`usage.cacheRead` and logged, not prevented. A miss costs money; it doesn't make the Handoff
wrong. The Codex cache hit was confirmed live
([#49](https://github.com/hoangtmbk/pi-config/issues/49)), though one fork in three missed
([#60](https://github.com/hoangtmbk/pi-config/issues/60)). The Anthropic hit is unconfirmed: it
rests on pi's code and Anthropic's docs alone
([Can a forked call hit the provider cache?](https://github.com/hoangtmbk/pi-config/issues/27)),
and no live check has been run on an Anthropic model.
