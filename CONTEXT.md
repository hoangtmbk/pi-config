# pi-config

My personal [pi](https://pi.dev) package: the extensions, skills, prompt templates and themes
installed on every machine. This glossary covers the terms that mean something specific here,
beyond what pi itself already names.

## Language

### Subagents

**Agent**:
A definition — a markdown file with YAML frontmatter naming a model, a tool allowlist and a
system prompt. A description of a capability, not a running thing.
_Avoid_: subagent (when you mean the definition), agent type, role

**Roster**:
The set of Agents a session can run: the definitions bundled with the extension plus the user's
own, with a user definition replacing a bundled one of the same name. What the `subagent` tool's
description is built from. Agents the checkout defines are held apart from it — see Project scope.
_Avoid_: registry, catalog, agent list

**Project scope**:
The Agents a checkout defines, in the nearest `.pi/agents/` at or above the working directory.
Never in the Roster: one is runnable only behind a trust confirmation, and one claiming a Roster
name is dropped rather than replacing it, because a repo-controlled file must not be what a
familiar name resolves to.
_Avoid_: local agents, repo agents, workspace scope

**Run**:
One execution of an agent: a single child pi process carrying out one delegated task, with its
own identity, lifecycle and transcript. Many runs can share one agent.
_Avoid_: subagent (when you mean the execution), job, task, invocation

**Supervisor**:
The part of the extension living in the parent session that owns every run: spawning, tracking
lifecycle, surfacing progress and routing messages between parent and children.
_Avoid_: manager, orchestrator, pool

**Question**:
An escalation from a run back to the parent session when the delegated task is ambiguous
enough that guessing would waste the work. Suspends the run until answered.
_Avoid_: clarification, prompt, ask

**Waiting**:
The state of a run that has asked a question and not yet been answered. Deliberately distinct
from done: the run has produced no result and is still alive.
_Avoid_: parked, blocked, idle, stalled

**Slot**:
One of the four places a run may work in. A run holds a slot from the moment it starts until it
stops, waiting on a question included; a run asked for while all four are held is queued, and
starts when one frees. Four because the binding constraint is provider rate limits (ADR-0002).
_Avoid_: worker, lane, permit, concurrency limit

**Delivery**:
The moment a finished or failed run's result re-enters the parent session's conversation.
Separate from the run finishing — a run can be done for some time before its result is delivered.
_Avoid_: return, callback, report
