# subagents extension

Date: 2026-08-27

Design settled by grilling; terminology in [`CONTEXT.md`](../../../CONTEXT.md).
Load-bearing decisions recorded as [ADR-0001](../../adr/0001-rpc-child-processes-for-subagents.md)
and [ADR-0002](../../adr/0002-async-spawn-with-explicit-join.md).

## Goal

Let the main pi session fan work out to focused child sessions, keep working while they run, see
their progress in the TUI, and answer their questions when they get stuck. Minimal, stable, robust
— in that order of priority when they conflict.

## Terminology

**Agent** = a markdown definition. **Run** = one child process executing one task.
**Supervisor** = the parent-side owner of every run. **Question** = a run escalating ambiguity to
the parent. **Waiting** = a run suspended on an unanswered question. **Delivery** = a result
re-entering the parent conversation. Full definitions in `CONTEXT.md`; use these words in code.

## Prior art, and what was taken

| Source | Taken | Rejected |
|---|---|---|
| pi's own `examples/extensions/subagent/` | agent discovery (`agents.ts`), `--append-system-prompt` via temp file, agent-scope security model | `--mode json -p` (one-shot, output-only — cannot carry a question), blocking delegation |
| `amosblomqvist/pi-interactive-subagents` | async spawn, `ask_question`, unique-name addressing, strict tool allowlist, widget-above-editor | tmux panes, cross-restart registry, loadout snapshots, resume, real-pi-in-tmux integration tests |
| `nicobailon/pi-subagents` | nothing structural — read for API patterns only | FleetView/inspector overlay, missions, schedules, watchdog, councils, external CLI runners, capability ceilings |

Both reference repos target older pi. Repo A is on the pre-rename `@mariozechner/pi-*` scope at
v0.65; repo B on `@earendil-works` ≥0.80. This targets **0.84.3**, the version in this repo.

## Execution model

A run is a child process:

```
pi --mode rpc \
   --no-session \
   --no-extensions \
   -e <extensions/subagents/index.ts> \
   --tools <agent's allowlist> \
   --model <agent's model, if set> \
   --append-system-prompt <tmpfile: run preamble + agent body>
```

driven by pi's exported `RpcClient` (public API, `dist/index.d.ts`). RPC over `--mode json -p`
because a question implies a reply implies a second turn, which one-shot mode cannot do. RPC also
supplies abort for free.

**Framing warning:** RPC is strict JSONL, LF-only. Node's `readline` is *not* protocol-compliant
here — it also splits on U+2028/U+2029, which are legal inside JSON strings. `RpcClient` handles
this; do not hand-roll the reader.

## Run lifecycle

```
        spawn                  agent_settled, no ask_question
  ─────────────▶  running  ──────────────────────────────────▶  done
                   │  ▲                                          │
   agent_settled,  │  │  subagent_answer                         │  delivery
   turn contained  │  │  (RPC prompt)                            ▼
   ask_question    ▼  │                                      (parent)
                 waiting                                         ▲
                                                                 │
                  child exit != 0, or spawn failure ──▶ failed ───┘
```

`agent_settled` is the done-signal, **not** `agent_end` — `agent_end` can be followed by an
automatic retry or compaction. Because a question parks the run between turns, `agent_settled`
is ambiguous: the supervisor disambiguates by whether that settling turn produced an
`ask_question` `tool_execution_end`. This rule is the single most bug-prone thing in the design
and gets dedicated tests.

A `waiting` run's process stays alive and idle. A `done` run's result is the child's **last
assistant message**; the result's shape is dictated by the agent markdown's own instructions, not
by a `report` tool.

## Tool surface

Three tools in the parent, one in the child. No multiplexed `action` parameter — three tight
schemas beat one fat one for tool-call accuracy.

**`subagent(agent, task, name?, model?)`** — spawns a run, returns its name immediately. No batch
form: because spawn returns immediately, "fan out five scouts" is five fast tool calls. The tool
*description* is built at registration time and embeds the discovered agent roster, so there is no
`subagents_list` round-trip.

**`subagent_wait(names?)`** — blocks until the named runs (or all active runs) reach `done` or
`failed`; returns their results and drains them from the mailbox.

**`subagent_answer(name, answer)`** — answers a `waiting` run. Sends the answer as an RPC `prompt`,
starting a fresh turn in the child.

**`ask_question(question)`** *(child only)* — returns immediately; the child's turn then ends and
the run parks as `waiting`. The parent agent is the responder, not the human: nothing blocks on
human attention, so the extension stays headless-safe.

Unknown names are rejected with an error listing valid ones. Names derive from the agent name,
auto-suffixed on collision (`scout`, `scout-2`), and are session-scoped — there is no
cross-restart registry.

## Delivery

When a run reaches `done` or `failed`, its result is delivered to the parent via `pi.sendMessage`:

- parent idle → `triggerTurn: true` (wake it)
- parent streaming → `deliverAs: "steer"` (pi lands it at a turn boundary, never mid-tool-call)

and it also sits in a mailbox that `subagent_wait` can drain early. Auto-delivery alone cannot
express a deliberate join; mailbox alone silently rots results the agent forgets to collect.

## Agents

Markdown + YAML frontmatter, matching pi's example verbatim: `name`, `description`, `tools`,
`model`; body is the system prompt. Discovery walks up from cwd for `.pi/agents/` and reads
`~/.pi/agent/agents/`. **Default scope is user-only** — a project-local agent file is
repo-controlled prompt injection — with a confirmation prompt for project agents in untrusted
projects. This repo bundles a small set: `scout` (read-only recon) and `worker`.

Tool access is a **strict allowlist, no default**: `--no-extensions --tools <exactly the
frontmatter list>`. An agent naming no tools is a config error, surfaced loudly. This extension
re-adds itself via `-e` as the one deliberate exception, so `ask_question` exists in the child.

## TUI

One `setWidget` block above the editor, `ctx.hasUI`-guarded, hidden entirely when no runs are
active. One line per run: elapsed, name, state, and current activity derived from the child's
`tool_execution_start` events.

```
╭─ Runs ─────────────────────────── 3 active ─╮
│ 01:12  scout      running · read auth.ts    │
│ 00:47  scout-2    waiting                   │
│ 00:09  worker     running · bash            │
╰─────────────────────────────────────────────╯
```

Question *text* is not shown — it is already being delivered into the conversation, and duplicating
it in a fixed-height widget invites truncation. The widget is a status surface, not a message one.

## Failure policy

- **Parent abort or `session_shutdown`** → SIGTERM every child, SIGKILL after a grace period. An
  orphaned pi child burns tokens invisibly; that is the worst available failure mode.
- **Child crash / non-zero exit** → a `failed` result delivered exactly like a successful one,
  carrying exit code and last stderr. The parent decides whether to retry or route around it.
- **No wall-clock timeout.** Every value is wrong for some legitimate long task; the parent can
  abort explicitly instead.
- **Concurrency capped at 4**, with a queue. The binding constraint is provider rate limits, not CPU.

## Layout

```
extensions/subagents/
├── index.ts        extension entry: tool registration, event wiring, delivery routing
├── supervisor.ts   run registry + lifecycle state machine  (pure — no I/O)
├── child.ts        spawn seam + RpcClient wrapper           (all the I/O)
├── agents.ts       agent discovery (adapted from pi's example)
├── widget.ts       TUI rendering                            (pure: state -> lines)
├── agents/         bundled agent definitions
└── tests/
```

`supervisor.ts` being pure is load-bearing, not stylistic: it is what makes the test strategy a
matter of feeding event sequences rather than an exercise in mocking. `child.ts` is the only file
that knows a subprocess exists, and it is the seam tests replace.

Register `./extensions/subagents/index.ts` in `package.json`'s `pi.extensions`; runtime deps (if
any) go in root `dependencies`, per this repo's single-`package.json` rule.

## Verification

- `npm test` drives the supervisor against a **scripted fake RPC child** — a small script speaking
  the JSONL protocol. It must stay offline, key-free and deterministic, like `web-fetch`'s suite.
  Sequences that matter: settle-with-question vs settle-without, two children settling in the same
  tick, crash mid-turn, name collision, queue admission at the concurrency cap, delivery while the
  parent is streaming vs idle.
- `npm run live:subagents` — a manual runner against real pi, deliberately **not** in `npm test`.
  Repo A's real-pi-in-tmux integration tests are the anti-pattern here: slow, key-dependent, flaky.
- `npm run typecheck` clean.

## Out of scope, deliberately

Parent→child steering of a running run; resuming a finished run; cross-restart name registries;
nested spawning (children spawning grandchildren — excluded consciously, as it turns the identity
model from flat to a tree); worktree isolation; scheduled or recurring runs; watchdog/adversarial
review; external CLI runners (claude, codex, cursor); council/voting; mission records; per-agent
memory; an inspector overlay.

Steering and the inspector are both cheap *additive* follow-ups on this substrate — RPC already
carries `steer`, and `RpcClient` already holds each child's transcript. Nested spawning is not.
