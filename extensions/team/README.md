# team

A Lead in pi running a **Team** of Claude Code **Teammates** on one **Effort**. The vocabulary is
the repo's, defined in the Teams section of [`CONTEXT.md`](../../CONTEXT.md): a **Team** is a
folder of markdown, a **Role** is one position on it, a **Playbook** is the Team's standing rules,
and a **Workspace** is where its Teammates work.

So far the extension knows its Teams, runs Team setup to adopt a Playbook, and `/team start` gets
as far as picking a Team.

## Usage

```
/team start <team>   pick a Team; refused, naming each file and reason, if any file of it is wrong.
                     A Team with no adopted Playbook goes through Team setup first, then is picked
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
switches them on, and adoption switches them off again. Setup and pending items live in the pi
session's memory for now.

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
setup.ts         Team setup: seeding the draft, validating and adopting it, its warnings
claude.ts        the only module that runs claude (version check)
teams/software/  the bundled software Team: architect, dev and qa, and its default Playbook
tests/           offline suite, fake claude, temp-root harness
```
