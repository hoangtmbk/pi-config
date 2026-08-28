# subagents

Hand a task to an Agent and keep working. `subagent` starts a **Run** — a child pi process
carrying out one delegated task — and returns its name straight away; the Run works in its own
context, asks a question if the task turns out to be ambiguous, and its result arrives back in the
conversation when it is done.

The vocabulary below is the repo's, defined in [`CONTEXT.md`](../../CONTEXT.md): an **Agent** is a
markdown definition, a **Run** is one execution of an Agent, the **Supervisor** is the parent-side
owner of every Run, a **Question** is a Run escalating to the parent, **Waiting** is a Run on an
unanswered Question, a **Slot** is one of the four places a Run may work in, and **Delivery** is the
moment a result re-enters the parent conversation.

## Why

A Run is a `pi --mode rpc` child driven by pi's exported `RpcClient`, not an in-process session and
not a tmux pane ([ADR-0001](../../docs/adr/0001-rpc-child-processes-for-subagents.md)). A separate
process gives crash isolation and a hard tool boundary; RPC's bidirectional JSONL gives the second
turn that a Question implies, which pi's one-shot `--mode json -p` cannot.

`subagent` returns a name rather than blocking the parent turn
([ADR-0002](../../docs/adr/0002-async-spawn-with-explicit-join.md)). Blocking delegation is simpler
and makes fan-out impossible; `subagent_wait` restores the blocking case as a deliberate join rather
than the only mode.

## The four tools

Three live in the parent session, one only inside a Run. There is no multiplexed `action` parameter:
three tight schemas beat one fat one for tool-call accuracy.

| Tool | Where | What it does |
|---|---|---|
| `subagent(agent, task, name?, model?)` | parent | Starts a Run and returns its name immediately. The whole roster is baked into the tool's description, so choosing an Agent costs no round trip. |
| `subagent_wait(names?)` | parent | Blocks until the named Runs — or every Run still in flight — are done, failed or Waiting, and returns what each has to say. |
| `subagent_answer(name, answer)` | parent | Answers a Waiting Run. The answer arrives as that Run's next prompt and it carries on from there. |
| `ask_question(question)` | child | Escalates to the parent session and returns immediately; the Run then ends its turn and goes Waiting. |

Three things follow from the shapes:

- **`task` is the whole task.** A Run starts from an empty context and cannot see the parent
  conversation, so the task has to carry the goal, the paths and what a finished answer looks like.
  The same goes for `answer`: it is a prompt, not a reply into a shared thread.
- **There is no batch form.** Because spawn returns immediately, "fan out five scouts" is five fast
  tool calls.
- **Waiting ends a join.** Only the parent can answer a Question, and a parent inside
  `subagent_wait` cannot — so a Waiting Run comes back from the join carrying its question, to be
  answered and joined again, rather than the two features deadlocking. For the same reason, a
  *queued* Run comes back saying it is still queued once nothing is running to free its Slot: with
  every Slot held by a Waiting Run, waiting on it would not be patience but a deadlock.

`name` is optional: a Run is named after its Agent and auto-suffixed on collision (`scout`,
`scout-2`). Names are session-scoped — there is no cross-restart registry.

## Writing an Agent

An Agent is a markdown file with YAML frontmatter. The body is the system prompt appended to the
child's, after a preamble telling the Run what it is.

```markdown
---
name: scout
description: Read-only codebase recon — returns compressed, cited findings
tools: read, grep, find, ls
model: claude-haiku-4-5              # optional; omit to inherit the parent's model
---

You are a scout. Investigate a codebase and return findings another agent can
use without opening the files you opened.

Whoever reads your output has **not** seen these files. Cite everything: path
plus line range.

Answer in this shape:

## Files read
...
```

| Key | Required | Notes |
|---|---|---|
| `name` | yes | What `subagent(agent: …)` addresses, and what its Runs are named after. |
| `description` | yes | One line. It goes into the `subagent` tool's description, so it is the whole basis on which the model picks this Agent. |
| `tools` | yes | The exact `--tools` allowlist. `tools: read, grep` and `tools: [read, grep]` are both accepted. |
| `model` | no | Overrides the parent's model. `subagent(model: …)` overrides this in turn. |

Two rules are worth stating out loud:

- **The tool list is a strict allowlist with no default.** A Run is spawned `--no-extensions --tools
  <exactly this list>`. `ask_question` is the one deliberate exception: this extension re-adds itself
  to the child with `-e` *and* puts the tool in the allowlist, because the allowlist filters
  extension tools too. An Agent naming no `tools` is a config error, not an Agent with an empty set.
- **The body carries the output contract.** A Run's result is its **last assistant message** — there
  is no `report` tool — so an Agent that does not say what its final message should look like gets
  whatever the model felt like ending on. Both bundled Agents end with an "answer in this shape"
  section, and that is why.

Files are read from three places:

| Scope | Where | Precedence |
|---|---|---|
| bundled | [`agents/`](agents/) beside this README — `scout` and `worker` | lowest |
| user | `~/.pi/agent/agents/*.md` | replaces a bundled Agent of the same name |
| project | the nearest `.pi/agents/*.md` at or above the working directory | never in the roster — see below |

Within one directory, two files claiming one name is always a mistake: the first by filename wins
and the other is rejected. A file that looks like an Agent but cannot be run — invalid YAML, no
`tools`, a name already taken — is rejected with a reason rather than silently skipped;
`npm run live:subagents` prints those reasons for the machine it runs on.

## Scope and trust

**The default scope is user-only.** An Agent file a checkout carries is repo-controlled prompt
injection with a tool allowlist attached, so the project scope is held apart from the roster:

- A project Agent is **listed separately** in the `subagent` tool's description, said to be gated.
- Running one **asks first** — a confirmation naming the Agent, its file and the tools it would get.
  A project pi already trusts is not asked again (that decision was taken once, deliberately), and a
  session with nowhere to show a dialog refuses rather than running unasked, which is what keeps a
  `-p` or JSON-mode session safe.
- A project Agent claiming a name the bundled or user scopes already use is **dropped**, not merged.
  Precedence runs one way only: a familiar name must never quietly resolve to a file the repo wrote.

Declining is not a failed Run. The confirmation happens before the Run is registered, so a refusal
comes back as an error on the tool call that asked, and nothing was started.

## Slots, and the queue

At most **four** Runs work at once. A Run holds a Slot from the moment it starts until it stops,
Waiting on a question included; a fifth Run asked for while all four are held comes back named and
`queued`, and starts when a Slot frees, in the order the Runs were asked for.

Four because the binding constraint on parallel Runs is provider rate limits, not CPU
(ADR-0002). Fanning out past the cap is a wait rather than a refusal, and nothing about addressing a
Run — waiting for it, answering it — depends on whether its child has come up yet.

## The lifecycle

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

The done-signal is `agent_settled`, not `agent_end` — `agent_end` can be followed by an automatic
retry or a compaction. Because a Question suspends a Run *between* turns, `agent_settled` alone is
ambiguous: the Supervisor tells the two apart by whether the settling turn produced an
`ask_question` result. That rule is the single most bug-prone thing in the design, and it has
dedicated tests.

**Delivery** happens twice over, on purpose. A finished Run's result is handed to pi with
`triggerTurn` so an idle parent wakes, and `deliverAs: "steer"` so a streaming parent takes it at a
turn boundary rather than mid-tool-call; it also sits in a mailbox that `subagent_wait` drains. A
result a join collected is *not* also delivered — nothing is said twice — and a Run whose result
already arrived on its own comes back from a later join saying so rather than repeating it.

The one departure is shutdown. The Runs a session leaves behind are reported into the conversation
without `triggerTurn`: the parent asked for all of this to stop, and starting a turn to say that it
stopped would be the opposite of what it asked for. It is on the record for whenever the parent next
takes a turn.

## The widget

One block above the editor while anything is active, and nothing at all when nothing is:

```
╭─ Runs ─────────────────────── 3 active ─╮
│ 01:12  scout     running · read auth.ts │
│ 00:47  scout-2   waiting                │
│ 00:09  worker    running · bash         │
╰─────────────────────────────────────────╯
```

Elapsed, name, state, and what the child is currently inside, derived from its tool events. A
Question's *text* is never here: it is already being delivered into the conversation, and a
fixed-height block would only truncate it. The whole thing is `hasUI`-guarded, so a `-p` or
JSON-mode session gets no widget rather than widget lines in its output.

## When things go wrong

| Case | What happens |
|---|---|
| Child crashes or exits non-zero | A `failed` result, delivered exactly like a successful one, carrying the exit code and the tail of stderr. The parent decides whether to retry or route around it. |
| Spawn fails | Reported on the `subagent` call that asked, if it is still there — otherwise delivered, for a Run admitted from the queue long after its call returned. |
| Parent turn aborted, or `session_shutdown` | Every child is SIGTERMed whatever state its Run is in, SIGKILLed if it ignores that, and every outstanding Run is failed and accounted for. |
| A long task | No wall-clock timeout. Every value is wrong for some legitimate task; abort the turn instead. |

The reap is the one thing here that is not best-effort. An orphaned pi child burns tokens invisibly
with no session left to report to, which is the worst failure mode available, so it is bounded on
both ends: a grace period around the SIGKILL, and a deadline around the one case a signal cannot
reach yet — a child still coming up, which stops itself on arrival.

## Testing

Run from the repo root (`pi-config/`):

```bash
npm test                 # offline suite: no pi binary, no key, no network
npm run typecheck        # tsc --noEmit against pi's real .d.ts
npm run live:subagents   # manual runner against real pi — spends tokens
```

`npm test` drives the whole extension against a **scripted fake RPC child**
([`tests/fake-rpc-child.ts`](tests/fake-rpc-child.ts)), a small script speaking the JSONL protocol.
Spawn, framing, settling, Delivery and the reap are all exercised as real subprocesses — including
asking the kernel whether a killed child's pid has really gone — without a pi binary, an API key or
a network. It stays offline, key-free and deterministic.

[`test.ts`](test.ts) is the manual runner and lives *beside* `tests/` rather than in it: pi loads
only `index.ts`, and `npm test` globs `tests/*.test.ts`, so nothing reaches it by accident. It plays
the parent session and spawns five real Runs — a result that arrives on its own, a Question answered
and resumed, two Runs collected by a deliberate join, the widget, and a shutdown with a Run still
alive, whose pid it then watches leave. It prints `ok`/`FAIL` per case, with each widget block
verbatim and the opening lines of everything delivered, so success and failure are a paragraph apart
by eye.

```bash
npm run live:subagents                                  # the pi pinned in devDependencies
npm run live:subagents -- --model <id>                  # …on a particular model
PI_SUBAGENT_LIVE_MODEL=<id> npm run live:subagents      # …the same, from the environment
PI_CLI=/path/to/cli.js npm run live:subagents           # …against another pi
```

Three seams stay offline-only, because the suite settles them without spending anything: discovery
building the `subagent` tool's description, the queue at the cap, and the trust confirmation, which
needs a session that can show a dialog. The runner prints the discovered roster on the way past, so
a machine whose discovery is broken still says so before a token is spent.

That split is deliberate, and it is one of the things this extension took from its prior art by
rejecting it: one of the reference repos ran its integration tests as real pi inside tmux panes —
slow, key-dependent and flaky. Everything that genuinely needs a model, a key and a binary lives in
the manual runner instead, where a human starts it and reads the output.

## Not included, on purpose

Parent→child steering of a running Run; resuming a finished one; cross-restart name registries;
nested spawning (a Run cannot delegate further — that would turn the identity model from flat to a
tree); worktree isolation; scheduled or recurring Runs; watchdog review; external CLI runners;
councils; per-agent memory; an inspector overlay.

Steering and an inspector are both cheap *additive* follow-ups on this substrate — RPC already
carries `steer`, and `RpcClient` already holds each child's transcript. Nested spawning is not.

## Layout

```
index.ts        extension entry: tool registration, event wiring, delivery routing
supervisor.ts   run registry + lifecycle state machine   (pure — no I/O)
child.ts        spawn seam + RpcClient wrapper           (all the I/O)
agents.ts       agent discovery, and the three scopes
widget.ts       TUI rendering                            (pure: state → lines)
agents/         the bundled Agents: scout and worker
tests/          offline suite, fixtures and the fake RPC child
test.ts         manual live runner against real pi (not loaded by pi, not in npm test)
```

`supervisor.ts` being pure is load-bearing rather than stylistic: it is what makes the test strategy
a matter of feeding event sequences instead of an exercise in mocking. `child.ts` is the only file
that knows a Run is a subprocess, and it is the seam the tests replace.

No new runtime dependencies. The root `package.json` carries `./extensions/subagents/index.ts` in
`pi.extensions` and the `live:subagents` script.
