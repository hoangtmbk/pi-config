# team

A Lead in pi running a **Team** of Claude Code **Teammates** on one **Effort**. The vocabulary is
the repo's, defined in the Teams section of [`CONTEXT.md`](../../CONTEXT.md): a **Team** is a
folder of markdown, a **Role** is one position on it, a **Playbook** is the Team's standing rules,
and a **Workspace** is where its Teammates work.

So far the extension knows its Teams, runs Team setup to adopt a Playbook, and `/team start` opens
an Effort and runs its intake up to the human approving its Brief. Planning and Teammates come later.

## Usage

```
/team start <team>   pick a Team and open an Effort on it; refused, naming each file and reason, if
                     any file of it is wrong. A Team with no adopted Playbook goes through Team
                     setup first. Refused outside a git repo, and while this session holds an Effort
/team start          the Lead proposes a Team from each Team's description
/team setup <team>   Team setup: agree the Team's Playbook with the Lead, then adopt it
/team pending        answer what waits on you: approve, send back with a note, or later
/team pause [reason] pause the held Effort: no new Task starts, running Teammates finish theirs
/team resume         lift your pause on the held Effort; in a session holding none, adopt an
                     Effort no pi session leads (pick one, or name it)
/team report         ask the Lead for a Report on everything since the last one
/team reports        pick a Report, newest first, and read it in an overlay
/team attach [id]    attach to a Teammate's session (pick one, or name it); also just `/team`
```

`/team start` warns when `claude --version` is older than 2.1.316, the version this extension was
tried on. The warning never stops it. Every `/team` command runs while the Lead is streaming.

## Team setup

`/team setup <team>` seeds a draft at `~/.pi/agent/team/playbooks/<team>.draft.md` and wakes the
Lead to walk you through it. The draft starts from, in order: a draft an earlier setup left
unadopted, the adopted Playbook, the Team's `default-playbook.md`, or nothing, in which case the
Lead grills you and writes one. The Lead edits the draft with pi's own file tools.

When you're happy, the Lead calls `team_request_approval` with checkpoint `adopt-playbook` and the
draft's path. That validates the draft (refusing it with its config errors), snapshots its bytes
with their sha256 and adds a pending item. Nothing you say in chat adopts it: in `/team pending`
you see the path and sha and approve, send it back with a note (which wakes the Lead), or leave it
for later. Approving writes the snapshot, not whatever the draft holds by then, as
`<team>.md` with `<team>.adopted.json` and removes the draft.

The request and the dialog warn of what won't protect you: a `roles.<role>.allow` rule that auto
mode drops on entry (any-command Bash, interpreter wildcards, package-manager run commands,
`Agent`, `Monitor`) for a Role that runs in `auto`, and an `escalate` entry with no `ask:` list.

The Lead's tools (`team_request_approval`) are registered at load but switched off; Team setup
switches them on, and adoption switches them off again. Setup and its pending items live in the pi
session's memory.

## Intake

`/team start` on a Team with an adopted Playbook opens an **Effort**: a folder
`~/.pi/agent/team/efforts/<team>-<yyyy-mm-dd>/` (numbered `-2`, `-3`, … when taken) whose
`effort.jsonl` is the extension's whole memory of it, starting with the Team, the repo (the git
root of pi's folder) and the sha256 of the Playbook in force. The session records it in a
`team-effort` entry. One session holds one Effort.

The Lead grills you one question at a time and writes the **Brief** to `brief.draft.md` in the
Effort: frontmatter with `team`, `playbook` (that sha), `repo` and `overrides`, then Goal,
Acceptance criteria (`- **AC1** …`, unique ids), Scope, Decide for me / Ask me, Delivery, and any
sections the Playbook adds under `## Brief sections`. It then calls `team_request_approval` with
checkpoint `brief`, which refuses the draft naming each problem: a missing section, a repeated or
missing criterion id, an override naming a rule the Playbook doesn't have, a wrong repo or sha.

In `/team pending` you see the draft's path and sha, the repo, and every Role with the mode it
would run in. Approving writes the snapshot asked about as `brief.md`, copies the Playbook to
`playbook.md` and the Team to `team/`, and appends a line with their sha256s to `approvals.jsonl`.
From then on the Effort reads only those copies, so editing your Team or Playbook changes nothing
in it; a copy whose sha no longer matches its approval is reported and never used. A Brief can't
be approved once its Playbook has been adopted again: start a new Effort.

`team_plan`, `team_handoff`, `team_review`, `team_report` and `team_answer` are switched on with the Effort, and
refuse until the Brief is approved. `team_status`, `team_pause` and `team_resume` come on with them.

### Planning and handing off

`team_plan` takes the whole Task list: each Task's slug, Role, goal, the Tasks it depends on and
the criterion ids it covers. It refuses a list that leaves one of the Brief's criteria uncovered or
names a Role the Team doesn't have. Planning again replaces the list, and `plan.md` in the Effort
is rewritten as a view of it; editing `plan.md` changes nothing.

`team_handoff` writes the Task's folder, `tasks/<nnn>-<role>-<slug>/task.md`, and staffs the
Task with no judgment from the Lead, down a ladder:

1. **Reuse** an idle Teammate of the Task's Role whose Task is accepted. Its context is cleared
   first (below), so it starts the new Task fresh, under the same short id.
2. **Start** a new Teammate of the Role (`builder-1`, `builder-2`, …) while fewer than
   `maxTeammates` are live.
3. **Swap**: at the cap, stop (`claude stop`) an idle Teammate whose Task is accepted and whose
   Role has no queued Task, and start one in its place.
4. **Queue** the Task, saying why (`cap 3 reached; waits for 001, 002 and 003`). `team_review`
   starts queued Tasks, in handoff order, when an acceptance frees a Teammate.

Every live Teammate counts toward the cap, working or idle. `maxTeammates` is a pi setting
(default 3), read after `/reload`. Starts are at least 5 s apart. The reply says which Teammate
was started or reused, or that the Task is queued and why. A Teammate fills one Role for life.

A new Teammate starts as `claude --bg` in the Workspace, named
`team-<effort-id>-<teammate-id>`. The launch passes the Role's flags, the mode in force
(the Playbook's for the Role, then the Role's own, then `auto`), the Team's mod with
`--plugin-dir` (below) and, from `teammates/<id>/`:

- `settings.json`, which adds to your own settings: the Teammate's hooks, `crossSessionInbound:
  "accept"`, the Playbook's allow and deny rules for the Role and for `*`, every `escalate` rule
  as `ask`, and a deny on editing `brief.md`, `clarifications.md`, `approvals.jsonl`,
  `playbook.md`, `team/**` and `effort.jsonl`;
- `prompt.md`, appended to the system prompt: a preamble naming the Teammate, its Role, the Lead
  as its only contact, `AskUserQuestion` for questions, the Task-folder convention, the paths of
  `brief.md` and `clarifications.md`, and that installing dependencies in the fresh Workspace is
  its job, then the Role's prompt;
- `mcp.json`, when the Role has `mcpServers`.

The Effort directory is added with `--add-dir`, `EnterPlanMode` is always disallowed, and the
first turn is a pointer to `task.md`. A launch that fails leaves the Task planned (or queued).

### Isolated Tasks

A Task handed off with `isolated: true` gets a worktree and branch of its own, cut from the
Effort branch's tip when its Teammate starts: `…/team-<effort-id>-task-<nnn>/` beside the
Workspace (never inside it) on branch `team/<effort-id>-task-<nnn>`, with what your repo's
`.worktreeinclude` lists copied in. Its Teammate always starts fresh there, never reused, and a
Teammate restaffed after a crash launches in the same worktree. Only what it commits merges.

Accepting it with `team_review` writes a `merge-intended` line to `effort.jsonl`, then merges the
branch into the Effort branch with `--no-ff`. Once merged, the Task is accepted, its Teammate
stopped, and its worktree and branch removed. The merge is refused, with a `merge-failed` line,
while the Workspace or the Task's worktree has uncommitted changes, or when it would conflict
(the merge is aborted): nothing is merged, and the Task stays in review with its branch intact.

### Clearing between Tasks

A Teammate is cleared exactly when it is handed a different Task from the one in its context:
never on a send-back of its own Task, and never mid-Task. The clear is one write-ahead step in
`effort.jsonl`: the reuse is recorded, the clear marker goes over the Teammate's inbox, the
Teammate's `SessionStart` with source `clear` records its new session id, and then the Task's
pointer is sent. The short id stays, so a human attached to it stays attached.

The Team's mod (`mod/` here) runs inside every Teammate: it consumes the clear marker and runs
`/clear`. Claude Code writes a `tsconfig.json` into a mod's folder when loading it, so the
extension loads it from a copy in `~/.pi/agent/team/mod/`, refreshed whenever the bundled
content changes.

### What a Teammate tells the Lead

Each hook a Teammate fires runs `hook.mjs`, which appends the event as one line to the Teammate's
journal, `teammates/<id>/events.jsonl`, then rings the Lead's doorbell: a localhost port and token
the Lead writes to `lead.json` before its first launch. The doorbell only says "read this journal";
the Lead applies each line once, from the Teammate's cursor, and every `effort.jsonl` line it adds
for one carries that cursor. A doorbell without the token is ignored, and whatever a journal holds
is also read when the Lead's run settles, so a lost doorbell loses nothing.

- `SessionStart` records the Teammate's session id, short id and inbox socket;
- `UserPromptSubmit` is logged as a message having landed, and `PermissionDenied` is logged;
- an idle `Notification` is dropped;
- a `Stop` after the round's `result-<n>.md` is written means the round is done, and wakes the
  Lead with the Task and the result's path. A `Stop` without a new result is "stopped short", and
  wakes the Lead with the Teammate's last message.

Wakes that come while the Lead is busy are sent together as one follow-up once its run settles.

### Usage

Every Teammate's status line runs `statusline.mjs`, which runs the human's own status line
command (local, then project, then user settings, as Claude Code picks it) and prints its output
unchanged, then writes the JSON it got to `teammates/<id>/statusline.json`. While the Team block
shows, the extension reads those files once a minute: the block's usage line shows the freshest
reading, where it came from and how old it is, and each row's `ctx` comes from them. With no
status line under a minute old it asks Claude Code's undocumented `get_usage` control request
instead, at most once a minute. Each Report's Usage section has the freshest reading and its change
since the Effort began, each Role's tokens and API-price estimate summed across its sessions, and
the Lead's own cost as pi reports it.
### Held requests

A Teammate's permission prompt, an `AskUserQuestion` included, is held by its `PermissionRequest`
hook: the hook journals it with a request id `req-<8 hex>`, keeps a socket open to the Lead
bridge, and the Lead is woken with the tool and its input. The prompt stays live in the
Teammate's terminal meanwhile, and the first answer wins. Nothing is allowed by default.

- `team_answer` with `allow` or `deny` and a `reason` goes to the hook as its decision. An allow
  may add a session `rule` for the same tool, such as `Bash(npm test:*)`, and name the `grant` it
  relies on. An `AskUserQuestion` is answered with `answers`, keyed by each question's exact text.
- The human answering in the terminal kills the hook, journalled as denied in the terminal; a
  `PostToolUse` for the call after it shows it was allowed. Either way the Lead's answer is then
  refused as already answered.
- A hook that holds 3570 s without an answer gives the prompt back to the terminal. It waits in
  `/team pending` as an item that attaches to the Teammate, and in the Report's Waiting on you.

The next Report logs every answer, rule and grant under Decided for you, with the Task.

### Reviewing

Once woken about a result, the Lead decides on it with `team_review`, which refuses while the
round's `result-<n>.md` isn't written or its `Stop` hasn't come yet.

- `accept` marks the Task accepted in `plan.md`; it is never handed off or reviewed again.
- `send_back` writes the Lead's feedback to `feedback-<n>.md`, records the send-back, then sends
  the Teammate's inbox socket its auth line and a pointer to that file asking for
  `result-<n+1>.md`. The same session works the next round; nothing is cleared. A send-back past
  the Playbook's `sendBackLimit` (2 unless set) is refused and the Lead escalates to the human
  instead.

No file in a Task folder is ever overwritten: a `feedback-<n>.md` already there refuses the
send-back. A pointer that can't reach the inbox is reported to the Lead, with the send-back
already on record.

`plan.md` shows each Task as planned, running, in review, sent back or accepted, with its
Teammate, its folder and how often it was sent back.

### Reports

The Lead writes a Report with `team_report`: a headline, Brief coverage by criterion id, and any
work it found outside the Brief, which is kept as a suggestion and never started. The extension
adds the logged sections from `effort.jsonl`, leaving out any with nothing in them:

- **Since the last Report**: what was asked, approved, planned, handed off, finished, sent back,
  accepted or denied, with the time (UTC);
- **Plan**: each Task's status, when the plan or a Task moved, and why the Lead re-planned
  (`team_plan`'s `reason`);
- **Waiting on you**: what `/team pending` holds;
- **Decided for you**: what the extension answered on your behalf;
- **Teammate modes**: every Role's mode in the plan Report, then a Teammate's mode only when it
  changes;
- **Found work**: the running count, and the items new since the last Report.

The first Report, written once the plan is, is the plan Report. Each is saved as
`reports/<nnn>.md` in the Effort directory, numbered from 001 and never overwritten, and shows in
chat collapsed to its headline; the Lead gets back only where it went. The Team block counts them.

### Pausing

Three pauses hold independently: yours (`/team pause [reason]`), the Lead's (`team_pause`, with a
reason) and a usage limit's. Each is lifted only by whoever set it: you with `/team resume`, the
Lead with `team_resume`, a usage pause at its reset. The Effort runs only while none holds. While
one does, no new Task starts and `team_handoff` queues the Task with `paused`, while running
Teammates finish the Task they have. Once the last pause lifts, queued Tasks start through the
staffing ladder; lifting your pause also tells the Lead what started. The Team block shows `⏸
paused` with a line for each pause, who set it, since when and why, and the next Report says who
paused and resumed.

## Attaching to a Teammate

`/team` (or `/team attach [id]`) lists the Teammates with a session, then offers:

- **Attach here**: pi's TUI stops, `claude attach <short id>` runs in the terminal until you leave
  it (Ctrl+Z), then pi redraws and says you are back.
- **Open in a tmux window**: only inside tmux; `tmux new-window` runs the same command.
- **Copy the command**: copies `claude attach <short id>`.

Attaching only views the session: it is never a Takeover, and tmux is only a viewer (ADR-0006).
Outside the TUI, `/team attach` answers with the command. The Team block marks a short id that
changed since you last attached with `(new)`; effort.jsonl records the last one attached.

## Leading an Effort across pi sessions

An Effort has one Lead, the pi session `lead.json` names with its pid, bridge and session file. A
second session trying to lead it is refused, naming the session that does; `lead.lock`, created
only while a session takes or leaves the Lead, keeps two from winning at once, and one left by a
pid that has died is taken over. The session records the Effort it leads as a `team-effort` entry.

- `pi -c`, `/resume` back to the session and `/reload` lead the Effort again on their own, while
  `lead.json` still names the session's file.
- `/new` or `/resume` to another session asks first; "no" stays.
- `/fork` and `/clone` move the Effort: `lead.json` names the new session's file, which leads it.
- Leaving the session marks `lead.json` with `stoppedAt`: no live Lead, until `/team resume`
  adopts the Effort in a session holding none.
- `/tree` keeps the Effort, and tells the Lead where it stands on its next turn.

## Defining a Team

A Team is a folder:

```
<team>/
  team.md               name, description, workspace (git-worktree); the body says what work it covers
  roles/<role>.md       one per Role; the Team's Roles are the files present
  default-playbook.md   optional: the Playbook setup starts from
```

Teams are read from two places only: the ones bundled in [`teams/`](teams/) and the human's own
under `~/.pi/agent/teams/<team>/`. A user Team with a bundled Team's name replaces it as a whole;
nothing of the bundled one is merged in. Teams inside the checkout pi runs in are never read: a
Role sets what a Teammate may run and with which permissions, and a cloned repo doesn't get to
choose that.

A Role's frontmatter takes only the fields that map to `claude` launch flags:

| Field | Launch flag |
|---|---|
| `name`, `description` | none: the name must match the file, and the Lead reads the description when it staffs |
| `model`, `effort` | `--model`, `--effort`, passed as written |
| `allowedTools`, `disallowedTools` | the same flags (YAML lists) |
| `mcpServers` | `--mcp-config` (a map of server name to server config) |
| `plugins` | `--plugin-dir`, one per entry |
| `permissionMode` | `--permission-mode`: `auto`, `acceptEdits`, `manual`, `dontAsk` or `bypassPermissions` |

The body is the Role's prompt. `plan` is not a mode a Role may set (a Teammate in plan mode stalls
behind a plan card, so a plan is a Task whose result is the plan), and `bypassPermissions` is
refused in a bundled Team: only the human's own Team or adopted Playbook may ask for it.

A Playbook's frontmatter is `sendBackLimit` (default 2), `checkpoints`, and `permissions` with
`grants`, `escalate` and `roles` (by Role name, or `*`). Its body is prose; every list item opening
with a bold kebab-case id (`- **design-first**: …`) is a rule. Rules, checkpoints, grants and
escalate entries share one id namespace. An adopted Playbook lives at
`~/.pi/agent/team/playbooks/<team>.md` beside `<team>.adopted.json` (`{ sha256, adoptedAt }`); once
its bytes stop matching that sha256 it counts as not adopted.

Any unknown field, missing name or description, malformed Playbook field or duplicate id is a
config error naming the file. A Team with any config error is still listed, with its errors, and
`/team start` refuses it.

## Testing

```bash
npm test             # offline suite: no network, no real claude
npm run typecheck
```

Every path root (pi's agent dir, `~/.claude.json`, the `claude` executable, the bundled Teams) is
injected through `registerTeam(pi, deps)`, so tests run against temp folders and
[`tests/fake-claude.ts`](tests/fake-claude.ts), a scripted stand-in for `claude`. `/team` is driven
through a recording fake pi in `tests/index.test.ts`.

## Layout

```
index.ts         wiring: the /team command and its subcommand table
definitions.ts   Teams, Roles and Playbooks: discovery, validation, adoption state
start.ts         what /team start says, and what it asks the Lead (pure)
core.ts          the Effort core: a pure state machine over effort.jsonl
intake.ts        what the Lead is asked at intake, and the Brief's approval dialog (pure)
records.ts       the Effort folder: Brief validation, approved records and their shas
repo.ts          the git root an Effort works on
setup.ts         Team setup: seeding the draft, validating and adopting it, its warnings
claude.ts        the only module that runs claude (version check, attach)
attach.ts        the /team attach menu: attach here, tmux window, copy the command
teams/software/  the bundled software Team: architect, dev and qa, and its default Playbook
tests/           offline suite, fake claude, temp-root harness
```
