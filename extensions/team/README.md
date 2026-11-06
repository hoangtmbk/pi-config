# team

A Lead in pi running a **Team** of Claude Code **Teammates** on one **Effort**. The vocabulary is
the repo's, defined in the Teams section of [`CONTEXT.md`](../../CONTEXT.md): a **Team** is a
folder of markdown, a **Role** is one position on it, a **Playbook** is the Team's standing rules,
and a **Workspace** is where its Teammates work.

`/team start` opens an Effort on a Team, runs its intake up to the human approving a Brief, then the
Lead plans, hands Tasks to Teammates (background `claude --bg` sessions), reviews them and writes
Reports. The Team block above pi's editor shows where it stands.

## Setup and limits

- Pinned to pi 1.4.0 (the dev dependency this was built against) and Claude Code 2.1.316
  (`MIN_CLAUDE_VERSION`). `/team start` warns on an older `claude`; the warning never stops it.
- Teammates run `claude --bg`, so `claude` must be on the PATH and signed in. The extension adds the
  Effort's folder to `~/.claude.json` as trusted so a Teammate does not stop at the trust dialog.
- **Best effort, not a security boundary.** The floor hook (it makes a push, a force or a destructive
  command ask) and a Role's deny rules reduce what a Teammate does unprompted. They match commands by
  text and can be bypassed; do not rely on them to contain a hostile or confused session.
- **Use another provider for the Lead.** A Lead on the same Anthropic subscription as its Teammates
  shares their usage limits, so the Effort stalls at a limit, Lead included. Run pi's Lead on a
  different provider where you can.
- **`maxTeammates`** is a pi setting (default 3) read from pi's settings; a change takes effect after
  `/reload`.
- Observations the code does not act on, so not guaranteed: `/model` typed inside a Teammate's
  terminal may save as your default model; background sessions may auto-compact their context; and
  `claude` may show a "Teach auto mode" dialog. The extension handles none of the three. `npm run
  live:team` prints them as things to check by hand.

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
/team cancel         end the held Effort without sign-off, once you confirm: every Teammate stops,
                     clean worktrees are removed, branches are kept
/team attach [id]    attach to a Teammate's session (pick one, or name it); also just `/team`
/team handback <teammate> [note]
                     hand a Teammate you took over back to the Lead, with an optional note
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
Before writing the Brief the Lead checks each Playbook rule against what its tools can do: only
the bold-id rules, since an override can name only those; the guidance around them isn't checked,
so a Playbook's guidance should describe only what the Lead or the extension does. A Role's
model is set by its Role file, or for this Effort by the Brief's `roles:`, which an approved Brief
change can change again from the Role's next launch on; so a rule asking for a model per Role is
carried out there. There is no per-Task choice: a cheaper model for simpler Tasks means a separate
Role (a `dev-lite` on Haiku), which you add, since a Playbook change can't create a Role file. A
rule the Lead can't carry out it tells you about, skips with an override naming the rule, and
proposes changing in the final Report. The approval dialog lists each Playbook entry the Brief
skips, with its reason, and so does the plan Report; a Brief change's dialog lists those it newly
skips.

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

A Task handed off (running, in review or sent back) keeps the goal, criteria and dependencies it
was handed off for, and an accepted one those it was done for. A re-plan must restate them: the
same goal (spacing at its ends aside) and the same criteria and dependencies in any order, which
`plan.md` and `effort.jsonl` keep as recorded. One that changes them is refused, naming each change
and the recorded values. An accepted Task stays in the plan in its Role; one not yet accepted is
dropped by leaving it out or giving it another Role, which stops its Teammate, and new work goes in
a new Task.

`team_handoff` writes the Task's folder, `tasks/<nnn>-<role>-<slug>/task.md`, and staffs the
Task with no judgment from the Lead, down a ladder:

1. **Reuse** an idle Teammate of the Task's Role whose Task is accepted. Its context is cleared
   first (below), so it starts the new Task fresh, under the same short id.
2. **Start** a new Teammate of the Role (`builder-1`, `builder-2`, …) while fewer than
   `maxTeammates` are live.
3. **Swap**: at the cap, stop (`claude stop`) an idle Teammate whose Task is accepted and whose
   Role has no queued Task, and start one in its place.
4. **Queue** the Task, saying why (`cap 3 reached; waits for 001, 002 and 003`). `team_review`
   starts queued Tasks, in handoff order, when an acceptance frees a Teammate; a Teammate's crash
   frees room under the cap the same way.

Every live Teammate counts toward the cap, working or idle. `maxTeammates` is a pi setting
(default 3), read after `/reload`. Starts are at least 5 s apart. The reply says which Teammate
was started or reused, or that the Task is queued and why. A Teammate fills one Role for life.

A new Teammate starts as `claude --bg` in the Workspace, named
`team-<effort-id>-<teammate-id>`. The launch passes the Role's flags, the mode in force
(the Playbook's for the Role, then the Role's own, then `auto`), the Team's mod with
`--plugin-dir` (below) and, from `teammates/<id>/`:

- `settings.json`, which adds to your own settings: the Teammate's hooks, `crossSessionInbound:
  "accept"`, the Playbook's allow and deny rules for the Role and for `*`, every `escalate` rule
  as `ask`, a deny on editing `brief.md`, `clarifications.md`, `approvals.jsonl`,
  `playbook.md`, `team/**` and `effort.jsonl`, and the mod's `TEAM_HOOK` and `TEAM_LAUNCH` (the
  launch prompt, which Claude Code hands the mod as if you had typed it, so it is not a Takeover);
- `prompt.md`, appended to the system prompt: a preamble naming the Teammate, its Role, the Lead
  as its only contact, `AskUserQuestion` for questions, the Task-folder convention, the paths of
  `brief.md` and `clarifications.md`, that installing dependencies in the fresh Workspace is
  its job, and that it waits on a long run by ending its turn with a `Monitor` or background task
  watching it, since that doesn't end its session, then the Role's prompt;
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

A re-plan that drops an isolated Task stops its Teammate, then removes its worktree and deletes
its branch without forcing either: a worktree with uncommitted changes, or a branch with commits
the Effort branch lacks, is left in place and the Lead is told. Cancelling the Effort ends it, so
its worktrees go as at any end (below).

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
is also read when the Lead's prompt settles, so a lost doorbell loses nothing.

- `SessionStart` records the Teammate's session id, short id and inbox socket;
- `UserPromptSubmit` is logged as a message having landed, and `PermissionDenied` is logged;
- an idle `Notification` is dropped;
- a `Stop` after the round's `result-<n>.md` is written means the round is done, and wakes the
  Lead with the Task and the result's path. A later `Stop` for that round, before the Lead reviews
  it (a late background notice woke the Teammate), logs a `teammate-idle` line that no Report
  tells, wakes nobody, and leaves the row at "round n done".
- a `Stop` without a new result while the `Stop` hook lists the Teammate's own background tasks,
  Monitors or session crons as in flight (`background_tasks`, `session_crons`) is a wait: Claude
  Code prompts it again when they end. It logs a `teammate-waiting` line that no Report tells,
  wakes nobody, and the row shows "waiting on its background work". Any later journal line of the
  Teammate (a tool call, a prompt, another Stop) ends the wait, with a `teammate-active` line when
  nothing else records it. A wait quiet for 10 minutes (`WAITING_QUIET_MS`), such as one on a
  server left running in the background, which never prompts it again, is logged as a turn ended
  without a result and wakes the Lead once. The Lead's clock ticks while a Teammate waits, and the
  wait is kept in `effort.jsonl`, so a restart picks it up.
- any other `Stop` without a new result "ended its turn without a result", as Reports say. It wakes
  the Lead with the Teammate's last message, and tells it that a Stop doesn't end a session, that a
  Teammate waiting on its own background task or Monitor is prompted again when that ends, and
  not to nudge one.

Wakes that come while the Lead is busy are sent together as one follow-up once its prompt settles.

### Usage

Every Teammate's status line runs `statusline.mjs`, which runs the human's own status line
command (local, then project, then user settings, as Claude Code picks it) and prints its output
unchanged, then writes the JSON it got to `teammates/<id>/statusline.json`. While the Team block
shows, the extension reads those files once a minute: the block's usage line shows the freshest
reading, where it came from and how old it is, and each row's `ctx` comes from them. A reading goes
into `effort.jsonl` only when something in it changed (the windows, the session, its model, its
estimate or its `ctx`): Claude Code runs the status line again about once a minute even while idle,
and the extension keeps when it last read each file in memory. With no status line read under a
minute ago it asks Claude Code's undocumented `get_usage` control request instead, at most once a
minute. Each Report's Usage section has the freshest reading and its change since the Effort began,
each Role's API-price estimate summed across its sessions (a Role with none yet is left out), and
the Lead's own cost as pi reports it. It gives no token count: the status line's token totals are
the last request's context, not what a session used.
### Held requests

A Teammate's permission prompt, an `AskUserQuestion` included, is held by its `PermissionRequest`
hook: the hook journals it with a request id `req-<8 hex>`, keeps a socket open to the Lead
bridge, and the Lead is woken with the tool and its input. The prompt stays live in the
Teammate's terminal meanwhile, and the first answer wins. Nothing is allowed by default.

- `team_answer` with `allow` or `deny` and a `reason` goes to the hook as its decision. An allow
  may add a session `rule` for the same tool, such as `Bash(npm test:*)`, and name the `grant` it
  relies on. An `AskUserQuestion` is answered with `answers`, keyed by each question's exact text.
- The human answering in the terminal kills the hook, journalled as denied in the terminal; a
  `PostToolUse` for the call after it shows it was allowed, and so does a `PostToolUseFailure`:
  a call that ran and failed was still allowed, so a No in the terminal that was really a Yes
  doesn't start a Takeover. Either way the Lead's answer is then refused as already answered.
- A hook that holds 3570 s without an answer gives the prompt back to the terminal. It waits in
  `/team pending` as an item that attaches to the Teammate, and in the Report's Waiting on you.

The next Report logs every answer, rule and grant under Decided for you, with the Task.

A delete is a floor action only outside the Teammate's own folders: its Workspace, its Claude Code
job temp folder (`$CLAUDE_JOB_DIR/tmp`, under `$CLAUDE_CONFIG_DIR` or else `~/.claude`) and its
session's scratchpad. The floor hook and `team_answer` work these out with one function in
`floor.mjs`, so they agree on every command. Once trusted, `$CLAUDE_JOB_DIR` in a command reads as
the job folder, unless the command sets it; unquoted, only where bash can't split it.

A name the command sets itself reads as the path it holds, only in its double-quoted form (`"$T"`,
`"$T"/x`, `"${T}/x"`), and only when there's no doubt: a plain `T=value` of its own, set nowhere
else in the line and never exported, read or unset, in a text with no group, subshell, function,
loop, `if`, `case`, `eval` or `source`; outside a `$(…)`, a pipeline or a backgrounded list; sure
to have run before the delete (earlier in its `&&` chain, or leading an earlier list); and a value
that is a literal absolute path or starts with `$PWD` (the directory known), the trusted
`$CLAUDE_JOB_DIR` or such a name. So `T="$CLAUDE_JOB_DIR/tmp/smoke" && rm -rf "$T"` is inside;
`T=$(pwd) && rm -rf "$T"`, `rm -rf $T` unquoted, and any name set twice are not.

A request to a local host (`localhost`, `127.x`, `::1`, `0.0.0.0`) is no send, and the floor reads
the host when it's written out, even with the port or path in a variable
(`"http://127.0.0.1:$PORT/keys/$KEY"`). A URL held in a variable (`"$URL/keys"`) has no host the
floor can read, so a write to it is a send; the preamble tells Teammates to write local URLs out.

A `delivery` citation counts only when `reason` quotes, in double quotes, the words of the
Delivery that cover the action, and the Report logs that passage. A Delivery that says nothing of a
send or a delete doesn't cover one. Nor does the floor justify moving a criterion's scratch into
the Workspace: `team_answer`'s and `team_handoff`'s text tell the Lead that changes a criterion,
which is the human's.

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
- **Playbook entries the Brief skips**: in the plan Report only, each `skip` override with its
  reason;
- **Waiting on you**: what `/team pending` holds;
- **Decided for you**: what the extension answered on your behalf;
- **Teammate modes**: every Role's mode in the plan Report, then a Teammate's mode only when it
  changes;
- **Found work**: the running count, in every Report once anything is found, and the items new
  since the last Report.

The first Report, written once the plan is, is the plan Report. Each is saved as
`reports/<nnn>.md` in the Effort directory, numbered from 001 and never overwritten, and shows in
chat collapsed to its headline; the Lead gets back only where it went. The Team block counts them.

### Ending an Effort

The Lead ends the work with a final Report: `team_report` with `final: true`. It must map every
Brief criterion id to evidence, and may propose Playbook `changes`, each an `oldText` to replace
with `newText` in the Playbook the Effort runs on; a change that doesn't apply is refused. The
final Report replaces the Plan section with every Task, its Role and the model it ran on, as its
sessions' status lines gave it (every one, when it changed, as a `/model` in a Takeover does). With
no reading it gives the model its Teammate was launched on and says so; none for a Task never
launched. It adds the checkpoints with their approvals and the found work, and puts sign-off in
`/team pending`. There each Playbook change is asked first, one by one: adopted, it becomes the
Team's Playbook for the next Effort (this Effort keeps its snapshot); declined, it is dropped.
Approving sign-off records the Report's sha256 in `approvals.jsonl`, stops every Teammate and ends
the Effort; sending it back wakes the Lead with your note and drops the proposed changes. At the
end clean worktrees are removed and every branch is kept; a dirty worktree is kept and named.
`/team cancel` ends the Effort the same way without a Report. An ended Effort can't be adopted.
What the end did goes on record after `effort-ended` as a `worktrees-ended` line, each worktree
`removed` or `kept` with its `why` and the processes found `running` in it, and to the Lead in the
message that ends the Effort, which tells it not to use a removed worktree and to leave any process
named there to the human.

A process still running in a worktree (a server a Teammate started with `&`, which `claude stop`
doesn't reach) is named by pid and command in the final Report's Worktrees section, and as the
worktree goes in the notice, the `worktrees-ended` line and the Lead's message, and is never stopped; so is one left in an isolated Task's worktree
when an accept or a drop removes it. A Teammate's own session, and what is still attached to it,
isn't named, since stopping the Teammate stops those. The session is known by the pid `claude
agents --json` gives it: if that list gives no pids, a live session may be named too.

### Pausing

Three pauses hold independently: yours (`/team pause [reason]`), the Lead's (`team_pause`, with a
reason) and a usage limit's. Each is lifted only by whoever set it: you with `/team resume`, the
Lead with `team_resume`, a usage pause at its reset. The Effort runs only while none holds. While
one does, no new Task starts and `team_handoff` queues the Task with `paused`, while running
Teammates finish the Task they have. Once the last pause lifts, queued Tasks start through the
staffing ladder; lifting your pause also tells the Lead what started. The Team block shows `⏸
paused` with a line for each pause, who set it, since when and why, and the next Report says who
paused and resumed.

## The Team block

While an Effort is held, a framed block shows, top to bottom:

- the title (Team, Effort id, live Teammate count) and a status line: `running` or `paused`, the
  phase (intake, planning or working) and Tasks accepted of planned;
- a line per pause (who set it, since when, why) and per model hold (the Roles held, on an Opus or
  Sonnet limit or a usage-credit confirm, until when);
- the account's usage: the 5-hour and weekly windows with their resets, the source and its age;
- a row per Teammate: id, short id (`?` when unconfirmed after a restart, `(new)` when it changed),
  starting, busy or idle, its Task, what it did when idle, `ctx N%`, and its mode (`mode≠launch`
  when it drifted from the launch mode); a Takeover shows `YOURS`, its age and what triggered it,
  with `/team handback <id>`;
- the queued Tasks and `+N more Teammates` past `maxTeammates`;
- a footer: `N waiting on you  /team pending`, `reports N  /team reports`, `attach  /team`.

## Taking over a Teammate

A Takeover starts when you type a prompt or run a command that is not read-only in a Teammate's
terminal, interrupt a turn, or answer No to its permission prompt. What the Lead sent and attaching
never count. During one, sends to that Teammate are held and dropped at the hand-back, its
permission prompts are yours, and review and answer are refused. End it with `/team handback`, the
`/handback` command in the Teammate, or "Hand back" in the attach menu; the Lead is woken once.

## Restarting pi

An Effort survives pi restarting. On start the extension draws the block, listens on the bridge,
recovers unfinished intents, replays the Teammates' journals, reconciles with `claude agents`,
ticks, and wakes the Lead once. Teammates not heard from since show `?` until they are. An
approval on record in `approvals.jsonl` but not yet in `effort.jsonl` (a Brief, a Brief change, a
Playbook change or a sign-off) is finished as answered; a Playbook change adopted but not yet
recorded stays pending, to answer again.

## Usage limits

`limits.ts` is the only place that reads a limit message. Hitting a usage limit pauses the Effort
(and a model-family limit holds only that family's Roles) until the reset, or the next ordinary
Stop; `continue` is sent about two minutes after the reset. A reset more than a day away asks you
in `/team pending` to stay paused or cancel; one Claude Code gave no time for waits for its
auto-resume or the next ordinary Stop, and asks the same only once the pause has held a day. A usage-credit confirm holds the Roles
on that family and tells the Lead never to confirm it: that is yours. It counts as waiting on you,
shows in the Report's Waiting on you, and `/team pending` offers to attach to the Teammate's
terminal, where only you answer it. A Role's `model` or `effort` set in the
Brief's `roles:` frontmatter, once changed, gives a fresh session at the next Task.

A Brief change that alters what the Lead answers under (its grants, Delivery text or the `escalate`
entries it skips) does the same for each Teammate holding a session rule the Lead added with
`team_answer`, so no rule outlives the terms it was added under. Skipping an `escalate` entry
needs no fresh start for the rest: a Teammate's settings `ask` every `escalate` entry of the
Playbook whatever the Brief skips, and the skip only changes what `team_answer` may allow.

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
npm run live:team    # manual, real claude --bg: spends usage, never run by npm test
```

Every path root (pi's agent dir, `~/.claude.json`, the `claude` executable, the bundled Teams) is
injected through `registerTeam(pi, deps)`, so tests run against temp folders and
[`tests/fake-claude.ts`](tests/fake-claude.ts), a scripted stand-in for `claude`. `/team` is driven
through a recording fake pi in `tests/index.test.ts`.

## Live runner

`npm run live:team` drives real `claude --bg` in a temp git repo, one case after another, and
prints `ok` or `FAIL` for each. It reaps every session it launched, even when a case fails. It
spends your usage and adds a trust entry to `~/.claude.json`. Cases: `inbox` (the socket format
and that a launch prompt is not a composer one), `clear` (the bundled mod's `__TEAM_CLEAR__` and its
journal), `ask` (an `AskUserQuestion` answered through the hook), `floor` (the floor hook's `ask`
reaching `PermissionRequest` in `auto`), `statusline` (the wrapper writing `statusline.json`
unattached), `wake` (a resume after `claude stop`) and `fragile` (version, `get_usage`, the agents
listing). `--only a,b`, `--model <id>`, `--list` and `CLAUDE_PATH` select what runs. It ends with
a checklist of what needs a person or a real pi: a composer prompt journalling in the mod, env and
`process.run` there, `/handback`, Esc, a restart across pi, and the real limit wording. It lives in
`test.ts` outside the `tests/` glob so `npm test` never reaches it.

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
claude.ts        the only module that runs claude (launch, stop, inbox, usage, version, attach)
bridge.ts        the Lead's local socket the hooks ring and hold permission requests on
block.ts         the Team block and `team_status`
limits.ts        the only parser of usage-limit messages
hook.mjs         the Teammate hook: journals events, rings the Lead, holds permissions
floor.mjs        the floor hook (best effort)
statusline.mjs   the status line wrapper that writes statusline.json
mod/             the mod bundled into Teammates: clear, /handback, Takeover journalling
test.ts          the manual live runner (`npm run live:team`)
attach.ts        the /team attach menu: attach here, tmux window, copy the command
teams/software/  the bundled software Team: architect, dev and qa, and its default Playbook
tests/           offline suite, fake claude, temp-root harness
```
