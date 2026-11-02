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

`team_plan` and `team_handoff` are switched on with the Effort, and refuse until the Brief is
approved.

### Planning and handing off

`team_plan` takes the whole Task list: each Task's slug, Role, goal, the Tasks it depends on and
the criterion ids it covers. It refuses a list that leaves one of the Brief's criteria uncovered or
names a Role the Team doesn't have. Planning again replaces the list, and `plan.md` in the Effort
is rewritten as a view of it; editing `plan.md` changes nothing.

`team_handoff` writes the Task's folder, `tasks/<nnn>-<role>-<slug>/task.md`, and starts a new
Teammate of the Task's Role (`builder-1`, `builder-2`, …) as `claude --bg` in the Workspace,
named `team-<effort-id>-<teammate-id>`. The launch passes the Role's flags, the mode in force
(the Playbook's for the Role, then the Role's own, then `auto`) and, from `teammates/<id>/`:

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
first turn is a pointer to `task.md`. A launch that fails leaves the Task planned. A Task that
needs a worktree of its own (`isolated`) is refused.

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
claude.ts        the only module that runs claude (version check)
teams/software/  the bundled software Team: architect, dev and qa, and its default Playbook
tests/           offline suite, fake claude, temp-root harness
```
