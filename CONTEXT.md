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
own identity, lifecycle and transcript. Many runs can share one agent. Not pi's own run of one
prompt's turns, up to the agent settling: call that a *prompt* ("disarmed until the next prompt").
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

**Steer**:
A human's message into a running run, typed in the Inspector and taken by the child at its next
turn boundary. The parent is told, without a turn being started (ADR-0003). A message to a Waiting
run is not a steer but an answer to its question, from the user instead of the parent.
_Avoid_: nudge, interrupt, redirect, inject

**Inspector**:
The overlay showing one run's live transcript, rendered like the main chat, with an editor for
steering it and a key to kill it. Opened from the `/subagents` picker; finished runs stay
inspectable for the rest of the session.
_Avoid_: viewer, monitor, debugger, attach

### Compaction

**Context pressure**:
How full a session's context is, measured in tokens rather than as a share of the model's
window — rot and cost grow with the raw count, whatever the window holds.
_Avoid_: context usage, fill, load

**Pressure level**:
One of three bands context pressure crosses: *notice*, then *warning*, then *forced*, at which
compaction happens whether or not the agent chose it. Each level is a fixed token count, not a
percentage.
_Avoid_: threshold (when you mean the band), alert, tier

**Self-compaction**:
A compaction the agent itself starts, at a natural break in its work, before the forced level
makes the choice for it.
_Avoid_: manual compaction (that is the user's `/compact`), auto-compaction, checkpoint

**Pruning**:
Shrinking context without summarizing it: dropping or shortening entries that no longer matter,
such as a file read since edited or an old command's output. Nothing is rewritten in the agent's
words.
_Avoid_: trimming, cleanup, compaction (when nothing is summarized)

**Handoff**:
What stands in for the span a compaction removed — everything the agent needs to carry on the
same task as though nothing had been taken away.
_Avoid_: summary (when you mean what this extension produces), digest, recap

**Constraint ledger**:
The part of a Handoff that lists the user's rules, preferences and exclusions as exact quotes
of what they said. It only grows across compactions; an entry leaves it only when a later quote
from the user supersedes it.
_Avoid_: rules list, constraints summary, memory

### Teams

**Lead**:
The pi session that works with the human first, until it understands what they want, then
directs a Team's Teammates toward it. The human's single point of contact for the Effort.
_Avoid_: orchestrator, manager, supervisor (that is the subagents extension's)

**Team**:
A named definition: the set of Roles that together cover one kind of work, such as a software
team or a marketing team. A description, not a running thing.
_Avoid_: crew, squad, workforce

**Role**:
One position on a Team, such as architect, dev or QA: what that position is for and how a
Teammate filling it is set up. A definition, as an Agent is.
_Avoid_: persona, specialist, agent (that is the subagents extension's)

**Teammate**:
One running Claude Code session filling a Role, in a terminal the human can attach to and type
into. Many Teammates may fill the same Role.
_Avoid_: worker, terminal, run (that is a pi child process), subagent

**Playbook**:
A Team's standing guidance on how the Lead runs it: who does what, in what order, what counts as
done, and when to come back to the human. Agreed with the human in Team setup and revised only
with them. Reused across Efforts.
_Avoid_: pipeline, workflow, process, SOP

**Brief**:
What the human wants from one Effort, agreed with the Lead at intake. No Teammate starts until
the human has approved it.
_Avoid_: spec, requirements, ticket, task (that is a Task)

**Effort**:
One run of a Team against one approved Brief, from intake to the human's sign-off. A Lead holds
at most one Effort at a time.
_Avoid_: project, job, session, run

**Task**:
One unit of work the Lead hands to one Teammate, as its plan for meeting the Brief. The Brief is
what the human wants; Tasks are how the Lead gets there.
_Avoid_: ticket, job, assignment
