# Driving an interactive Claude Code session from outside

Date: 2026-11-01 · Ticket: #75 · Map: #74

Question: how can a pi extension (the **Lead**) drive an *interactive* Claude Code session (a
**Teammate**) from outside, while a human can still attach to that session and type into it?
The goal is facts and trade-offs for choosing the control channel. This note makes no design
recommendation.

Evidence comes from three kinds of source:

- **Docs**: the official Claude Code docs at `code.claude.com/docs/en/*.md`, fetched 2026-11-01.
  Each claim names its page, for example [agent-view](https://code.claude.com/docs/en/agent-view.md).
- **Local**: `claude --help` and `claude agents --help` from **Claude Code 2.1.316**, plus `man tmux`
  for **tmux 3.6a**, on macOS (Darwin 25.5).
- **Tried**: a throwaway experiment. An interactive `claude --model haiku` ran in a separate tmux
  server (`tmux -L cc75exp`) and was driven with `send-keys`, `paste-buffer`, `capture-pane` and
  `claude agents --json`, with a command hook logging every Stop, Notification and
  PermissionRequest event. [Experiment log](#appendix-experiment-log) has the details.

---

## Summary: the facts the decision turns on

1. **Claude Code now ships first-party pieces for this.** The ticket assumed only tmux plus
   hooks, but Claude Code 2.1.316 also documents:
   - **Background sessions** (`claude --bg`, `claude attach`, `claude agents --json`). They are
     hosted by a supervisor process, and a human can attach from any terminal.
   - **Channels**: an MCP server that pushes events into a running session. They are in research
     preview.
   - **A per-session inbox socket** used for cross-session messaging.
   - **Mods**: in-process plugin code that can call `$.prompt.submit` and `$.command.run`.
   - **`claude agents --json`**: a supported, scriptable state API that also covers plain
     interactive sessions.
2. **Input.** tmux `send-keys` works but is fragile. `send-keys -l` drops an embedded LF, so a
   multi-line prompt arrives joined into one line. `paste-buffer -p` (bracketed paste) keeps
   newlines, and a separate `Enter` then submits. Anything injected is **appended to whatever the
   human has typed but not yet sent** (tried).
3. **State.** `claude agents --json` reports `status: busy|waiting|idle` and
   `waitingFor: "permission prompt"` for an interactive session in a tmux pane (tried). Hooks give
   push signals:
   - `UserPromptSubmit`: the turn started.
   - `Stop`, with `last_assistant_message`: the turn ended. It arrived about 3 s after submit in the
     experiment.
   - `PermissionRequest`: immediate.
   - `Notification` `permission_prompt`: about 6 s later.
   - `Notification` `idle_prompt`: about 60 s after Stop.
4. **Identity.** `--session-id <uuid>` fixes the *first* conversation's ID only. `/clear` (tried)
   ends that conversation and starts a new `session_id` and transcript file. The process (pid), the
   `--name`, and the inbox socket stay the same.
5. **`/clear` from outside.** Only keystrokes (`send-keys`), the agent-view peek panel (a human
   UI), or a mod's `$.command.run` can trigger it. Docs say that inbox-socket messages arrive as
   plain text and never run commands. They also say `claude --resume <id> "/clear"` refuses a
   prompt that starts with `/`.
6. **Results.** Transcript JSONL is documented as an **internal, unstable format**. The documented
   result surfaces are the hook payloads (`last_assistant_message` on Stop), MCP tool calls the
   Teammate makes, and `claude -p --resume … --output-format json`. That last one is not usable
   against a *running* session.

---

## 1. Sending input into a running interactive session

### 1a. Terminal keystrokes via tmux (tried)

| Method | Result in Claude Code 2.1.316 |
|---|---|
| `tmux send-keys -l $'line1\nline2'` | The LF was **dropped**. The box showed `line1line2`, with no newline and no submit. |
| `tmux set-buffer` + `tmux paste-buffer -p` | Two lines in the input box, newline kept, not submitted. The `-p` flag "inserts bracket control codes … if the application has requested bracketed paste mode" (`man tmux`). Claude Code requests that mode. |
| `paste-buffer` **without** `-p` | Per `man tmux`, "any linefeed (LF) characters in the paste buffer are replaced with a separator, by default carriage return (CR)". Each CR is an Enter, so the first line would submit on its own. Not tried. |
| `send-keys Enter` after the paste | Submitted. `UserPromptSubmit` received `"prompt":"Line one…\nLine two…"`, with the newline intact. |
| `send-keys 1` on a permission dialog | Selected **Yes**, and the tool ran (`marker.txt` was created). Dialogs can be answered by keystroke. |
| `send-keys -l /clear` + `Enter` | Ran `/clear`. `SessionEnd` fired with `reason:"clear"`, then `SessionStart` with `source:"clear"` and a **new** `session_id`. |
| Human typed `human draft in progress ` and then the Lead pasted `LEAD INSTRUCTION` | The box read `human draft in progress LEAD INSTRUCTION`. Injected keys **merge into the human's unsent draft**. |

Other keystroke facts, from the docs:

- **Multi-line keys** ([interactive-mode](https://code.claude.com/docs/en/interactive-mode.md)):
  "`Ctrl+J` — Works in any terminal without configuration" inserts a newline. Shift+Enter inside
  tmux needs `set -s extended-keys on` in `~/.tmux.conf`
  ([terminal-config](https://code.claude.com/docs/en/terminal-config.md#configure-tmux)).
- **Large pastes** ([terminal-config](https://code.claude.com/docs/en/terminal-config.md#paste-large-content)):
  a paste over 800 characters or three lines collapses to `[Pasted text #N +X lines]`, but the full
  text is still sent. Claude "is told that a paste can contain instructions you didn't write, and to
  follow instructions inside it only where the message you typed asks it to"
  ([same page](https://code.claude.com/docs/en/terminal-config.md#how-claude-treats-pasted-text)).
  That framing **also applies to a whole prompt injected by bracketed paste.** The docs recommend
  writing very large inputs to a file and asking Claude to read it.
- **Typing while Claude works** ([interactive-mode › Queue messages](https://code.claude.com/docs/en/interactive-mode.md#queue-messages-while-claude-works)):
  Enter while Claude works **queues** the message instead of interrupting it. Queued messages are
  passed "as soon as those tool calls finish, within the same turn". Commands such as `/clear` are
  held "until the turn ends". `Esc` interrupts the turn.
- **Trust dialog** (tried): the first launch in an untrusted directory shows a full-screen
  "Accessing workspace … Yes, I trust this folder" dialog before anything else. No hook, including
  SessionStart, ran until it was accepted.
- **Default permission mode** (tried): `bypass permissions on` appeared without the flag, so on this
  machine the user settings set `defaultMode` to bypass. `--permission-mode default` overrode it
  ("manual mode on").

### 1b. Background sessions: `claude --bg` and `claude attach` (docs only)

Source: [agent-view](https://code.claude.com/docs/en/agent-view.md),
[sessions](https://code.claude.com/docs/en/sessions.md#resume-a-running-background-session) and
[cli-reference](https://code.claude.com/docs/en/cli-reference.md).

- **Starting one.** `claude --bg [--name N] "<prompt>"` starts a session under a **supervisor
  process**, prints a short ID, and returns. The ID works with `claude attach | logs | stop |
  respawn | rm`. `--bg` cannot be combined with `-p`.
- **Attaching.** "Background sessions don't need any terminal open to keep working." A human runs
  `claude attach <id|name>` in any terminal to get the full interactive session. It "always
  render[s] in fullscreen mode", and "tmux copy mode show[s] only the current viewport". Detaching
  (`←` on an empty prompt, `Ctrl+Z`, `/exit`) "never stops a background session".
- **Untrusted directories.** "Where no dialog can appear, such as in a script, the command exits
  with a `Workspace not trusted` error."
- **Sending a prompt from the shell.** `claude --resume <session> "prompt"` sends the prompt as the
  next turn *and then attaches this terminal*. It refuses, sends nothing and exits 1 when the command
  line has "Piped or redirected input or output", any session-configuring flag, or output flags. "A
  prompt that starts with `/` or `!` isn't sent." So there is **no documented headless "send this
  text to a running background session" CLI**. The peek panel's reply box in `claude agents` is
  interactive only.
- **Idle reaping.** A session that is finished and "unattached for about an hour" has its process
  stopped. The conversation stays on disk and resumes on the next attach or reply. `Ctrl+T` pins a
  session to keep it running.
- **Supervisor crashes.** "on macOS and Linux, your sessions stop unless a new supervisor connects
  within about a minute".
- **Configuration.** The permission mode, model, effort and configuration flags persist across
  supervisor restarts.

### 1c. Channels: MCP push into a running session (docs only, research preview)

Source: [channels](https://code.claude.com/docs/en/channels.md) and
[channels-reference](https://code.claude.com/docs/en/channels-reference.md).

- **What a channel is.** "A channel is an MCP server that pushes events into your running Claude
  Code session". Claude Code spawns it as a **stdio subprocess**. It declares
  `capabilities.experimental['claude/channel']` and emits
  `notifications/claude/channel { content, meta }`. Claude sees
  `<channel source="…" k="v">content</channel>`.
- **Timing.** "Events queue into the session and are processed in order. If several notifications
  arrive while Claude is busy, they're delivered together on the next turn". An idle session starts
  a turn.
- **Two-way.** A channel can expose a reply **tool** that Claude calls. Replies show in the
  terminal only as a tool call ("sent").
- **Permission relay.** `claude/channel/permission` sends the server
  `permission_request { request_id, tool_name, description, input_preview }`. The server answers
  `{ request_id, behavior: allow|deny }`. "The local terminal dialog stays open … Claude Code applies
  whichever answer arrives first". Project trust and MCP consent dialogs are not relayed.
- **Enabling a custom channel.** It must be opted in per launch with
  `--dangerously-load-development-channels server:<name>`. That flag shows a full-screen warning
  dialog ("I am using this for local development"), plus a one-time "New MCP server found" consent
  for a `.mcp.json` server. Only allowlisted plugins work with plain `--channels`. Neither flag is
  shown in `claude --help`.
- **Availability.** Channels need Anthropic auth (claude.ai or Console key) and are unavailable on
  Bedrock, Vertex and Foundry. "Pro, Max, and Ultra users without an organization skip these checks
  entirely". Team and Enterprise need `channelsEnabled`.
- **Stability.** "the `--channels` flag syntax and protocol contract may change based on feedback."

### 1d. Per-session inbox socket: cross-session messaging (docs, partly tried)

Source: [cross-session-messaging](https://code.claude.com/docs/en/cross-session-messaging.md) and
[env-vars](https://code.claude.com/docs/en/env-vars.md).

- **The socket.** Every session with messaging on (v2.1.224+, on by default) binds a Unix socket.
  Its path is exported to hooks and Bash as `CLAUDE_CODE_MESSAGING_SOCKET`. In the experiment it
  was `/tmp/cc-socks/<pid>.sock`, visible to the SessionStart hook. Docs describe this section as
  being for "when you want a script or hook to post into a session".
- **Wire format.** The docs give **only the auth line**, `{"type":"auth","token":"<token>"}`, which
  is optional on macOS and Linux. They do not give the message line format. Tried: a plain text line
  and a guessed `{"type":"message",…}` line were both **silently ignored**. The format is
  undocumented and is not a public contract.
- **Delivery.** "The receiving Claude reads the message between tool calls during an active turn …
  When the receiving session is idle, Claude Code starts a new turn". Messages arrive as text from a
  named sender with a reply address. "Commands don't run: a command in the message's text, such as
  `/compact`, arrives as plain text."
- **Inbound policy.** `crossSessionInbound` is `accept`, `hold` or `refuse`. With no value set, a
  receiving session in **bypass** mode *holds* messages from senders that are not bypassing, and
  shows an approval dialog. A message posted to a session's own socket by its own child process is
  delivered.
- **Throttling.** Inbound messages are rate-limited per sender, and at most 50 are queued.
- **Teammate to Teammate.** Teammates (Claude sessions) can already reach each other with the
  built-in `SendMessage` and `ListAgents` tools. Blocking that takes deny rules for `SendMessage`
  and `ListAgents` and/or `crossSessionInbound: refuse`.

### 1e. Mods: in-process code in the Teammate (docs only)

Source: [mods api](https://code.claude.com/docs/en/plugins/mods/api.md) and
[mods reference](https://code.claude.com/docs/en/plugins/mods/reference.md).

- **What a mod is.** A mod is a plugin with a JS/TS hooks module. It loads with `--plugin-dir`
  (per session) or by being installed.
- **Submitting prompts.** `$.prompt.submit({ text, asUser? })` "waits until the session is idle and
  then starts a new turn". Without `asUser`, Claude reads the text "after a sentence that names
  your mod as the sender".
- **Running commands.** `$.command.run` runs a command. The docs do not say whether built-ins such
  as `/clear` are accepted. `$.turn.abort` aborts a turn.
- **Timers and I/O.** `$.clock.every` runs work "between turns", outside any event.
  `$.process.spawn` streams a long-running command, and `$.http.fetch` is available. A mod cannot
  open a listening socket directly: "no network or file access of its own". It can poll the Lead,
  or spawn a helper process that does.
- **Observing messages.** `session.receive` and `session.send` events observe cross-session
  messages, and `{ consumed }` keeps a message away from Claude.

### 1f. Not suitable for "a human can attach", for reference

- **`claude -p --input-format stream-json`** (with `--output-format stream-json`) is the SDK's
  streaming input. It is **non-interactive** and has no TUI to attach to
  ([headless](https://code.claude.com/docs/en/headless.md), `claude --help`).
- **Remote Control** (`--remote-control`) lets you drive a local session from claude.ai/code or the
  Claude app. It needs a claude.ai subscription and Anthropic servers ("API keys are not
  supported"). There is no local programmatic API
  ([remote-control](https://code.claude.com/docs/en/remote-control.md)).

---

## 2. Knowing a Teammate's state

### 2a. `claude agents --json`: the supported pull API (tried)

[agent-view › List sessions as JSON](https://code.claude.com/docs/en/agent-view.md#list-sessions-as-json)
says it "is the supported way to read session state from outside Claude Code". It lists
**interactive sessions too**, not just background ones. Three observations of the tmux test session:

```json
{ "pid": 38177, "cwd": ".../exp/work", "kind": "interactive", "sessionId": "ac6aa020-…", "name": "tm-exp", "status": "idle" }
{ …, "status": "busy" }                                            // immediately after Enter
{ …, "status": "waiting", "waitingFor": "permission prompt" }       // Bash approval dialog open
```

- **Interactive fields.** `pid`, `status` (`busy`, `waiting` or `idle`), `waitingFor`
  (`permission prompt`, `input needed`, `sandbox request`, `worker request` or `dialog open`),
  `sessionId` and `name`.
- **Background fields.** Background sessions add `id` and `state` (`working`, `blocked`, `done`,
  `failed` or `stopped`). "`blocked` always means the session needs something from you".
- **Filtering.** `--cwd <path>` filters the list, and `--all` adds completed background sessions.
  It "does not require a TTY".
- **Internal files.** "The files under `~/.claude/jobs/<id>/` are not a stable interface."
- **Identity after `/clear`.** After `/clear`, the entry's `sessionId` changed to the new ID while
  `pid` and `name` stayed the same (tried).
- **Cost.** It is a poll. Each call spawns a `claude` process.

### 2b. Hooks: push signals (tried)

Hooks can be supplied per session with `--settings <file-or-json>`. Hook entries "merge across
settings levels rather than replacing each other"
([hooks](https://code.claude.com/docs/en/hooks.md)). Every payload carries `session_id`,
`transcript_path`, `cwd`, `permission_mode` and `hook_event_name`. Hook processes also get
`CLAUDE_CODE_SESSION_ID`, which is "updated on `/clear`"
([env-vars](https://code.claude.com/docs/en/env-vars.md)).

Event timeline from the experiment (unix seconds):

| t | Event | Payload highlights |
|---|---|---|
| +0 | `SessionStart` | `source:"startup"`, `session_title:"tm-exp"`, `model`. Fired only after the trust dialog was accepted. |
| +30 | `UserPromptSubmit` | `prompt` with the full text, `prompt_id` |
| +33 | `Stop` | `last_assistant_message:"ALPHA\nNo tools were used."`, `background_tasks:[]`, `session_crons:[]` |
| +93 | `Notification` | `notification_type:"idle_prompt"`, `message:"Claude is waiting for your input"` |
| `/clear` | `SessionEnd` then `SessionStart` | `reason:"clear"`, then `source:"clear"` with a new `session_id` |
| tmux kill | `SessionEnd` | `reason:"other"` |
| +0 | `UserPromptSubmit` | second session |
| +2 | `PermissionRequest` | `tool_name:"Bash"` |
| +8 | `Notification` | `notification_type:"permission_prompt"` |

Documented semantics that matter:

- **Stop.** It "Does not run if the stoppage occurred due to a user interrupt. API errors fire
  StopFailure instead." Docs recommend `last_assistant_message` over reading the transcript,
  because "the transcript file isn't guaranteed to include the final message at Stop time".
  `background_tasks` and `session_crons` "distinguish 'session is done' from 'session is paused
  waiting for background work'". Stop can also keep Claude working with
  `{"decision":"block","reason":…}` or with `additionalContext`, capped at 8 consecutive
  continuations.
- **PermissionRequest.** Use it "when you need a signal the moment Claude asks". It can return
  `allow` or `deny` itself through `hookSpecificOutput.decision.behavior`.
- **Notification.** `permission_prompt` fires after about 6 s, deferred by each keystroke.
  `idle_prompt` fires about 60 s after Claude finishes, and only if nobody has typed. Both are
  gated on the human "appear[ing] to be away from the terminal". Other types include
  `agent_needs_input` and `agent_completed`, which fire only while agent view is open.
- **UserPromptSubmit** fires for *any* submitted prompt, including the human's. It can block a
  prompt or add `additionalContext`, but cannot rewrite it.
- **Hook output reaching Claude.** Hook output "is delivered on the next conversation turn. If the
  session is idle, the response waits until the next user interaction", except for an
  `asyncRewake` hook that exits with code 2. `FileChanged` hooks can watch a file but "have no
  decision control" and cannot add context. **Hooks are therefore a state and outbound channel,
  not an inbound prompt channel.**
- **Hook types.** `command`, `http` (POST to a URL), `mcp_tool`, `prompt` and `agent`. An `http`
  hook can POST state straight to a server hosted by the Lead.

### 2c. Screen scraping

- **`capture-pane`.** `tmux capture-pane -p [-S start] [-E end] [-J] [-e]` returns the visible text
  (`man tmux`). The experiment read the trust dialog, the permission dialog and its options, the
  "✻ Baked for 3s · done" line, and the input box. Nothing on screen is a documented format, and
  the layout varies with width, renderer and version.
- **Attached background sessions** are fullscreen. "tmux copy mode show[s] only the current
  viewport".
- **Terminal status protocol.** The OSC 7501 Program Status Protocol reports working, waiting or
  done to the terminal. "inside tmux, Claude Code checks tmux for support instead of your terminal"
  ([terminal-config](https://code.claude.com/docs/en/terminal-config.md#see-session-status-in-your-terminal)).

---

## 3. Getting results back

| Surface | Facts |
|---|---|
| **Transcript JSONL** | `~/.claude/projects/<cwd with non-alphanumerics → '->/<session-id>.jsonl`. "The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release" ([sessions](https://code.claude.com/docs/en/sessions.md#where-transcripts-are-stored)). The path arrives in every hook payload. It is written asynchronously and "may lag". `/clear` starts a new file (tried). |
| **Hook payloads** | `Stop.last_assistant_message` is the turn's final text. `PermissionRequest` carries `tool_name` and `tool_input`. `http` hooks deliver either one to a URL. |
| **MCP server hosted by the Lead** | Pass it with `--mcp-config '<json>'` and `"type":"http"` plus a `url` (an entry with a `url` but no `type` is read as stdio and fails). `--strict-mcp-config` ignores all other MCP configuration. Tools appear as `mcp__<server>__<tool>` and go through permissions, so pre-allow them with `--allowedTools` or `permissions.allow`. Timeouts: `MCP_TOOL_TIMEOUT` defaults to about 28 h. HTTP servers also have a per-request timer, by default 60 s to the first response byte, raised by a per-server `timeout`. `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` defaults to 5 min for network servers. A tool call that blocks until the Lead answers (an "ask") has to stay inside these limits ([mcp](https://code.claude.com/docs/en/mcp.md), [env-vars](https://code.claude.com/docs/en/env-vars.md)). An MCP server's `instructions` string reaches Claude when the server connects. |
| **Channel reply tool** | When the Lead's bridge is a channel (section 1c), Claude's replies come back as tool calls on that same server. |
| **`claude -p --resume <id> --output-format json`** | Documented for asking an *existing* session a question. If the session is a running background session, the command attaches instead or exits 1 (section 1b). It is not a way to read a live interactive session. |
| **`claude logs <id>`** | Background sessions only: "Print the session's recent output". It is terminal output, not structured data. |
| **Files the Teammate writes** | Background sessions get `CLAUDE_JOB_DIR`. The docs suggest having a session "write a file of its own, for example under `$CLAUDE_JOB_DIR/tmp`" to report progress. |

---

## 4. Session identity, resume and `/clear`

- **`--session-id <uuid>`**: "Use a specific session ID for the conversation (must be a valid
  UUID)". Tried: the SessionStart payload and `claude agents --json` both showed the given UUID.
- **`/clear` breaks that identity.** It ends the conversation and starts a new one with a fresh
  UUID and transcript file. The pid, the inbox socket and the `--name` survive. "With no argument,
  the new session keeps a name you set with `--name` or `/rename`"
  ([sessions](https://code.claude.com/docs/en/sessions.md#manage-context-within-a-session)). Tried:
  `session_title:"tm-exp"` was still present after `/clear`.
- **MCP subprocesses keep the old ID.** An MCP server subprocess's `CLAUDE_CODE_SESSION_ID` "retains
  the ID it was spawned with" ([env-vars](https://code.claude.com/docs/en/env-vars.md)). After a
  `/clear`, a stdio MCP server sees a stale ID.
- **`--resume <id|name|transcript-path>`** reloads a saved conversation, searching this project
  first and then all projects. **`--continue`** reloads "the most recent conversation in the
  current directory". It skips `-p` and SDK sessions, so it is ambiguous with several Teammates in
  one directory.
- **`--fork-session`** gives the copy a new ID.
- **Resuming one session in two places**: "If you resume the same session in two terminals without
  forking, messages from both interleave into one transcript."
- **System prompt on resume.** `--append-system-prompt` text is recorded on the first request and
  reused on resume "until the conversation is compacted", unless `--system-prompt-snapshot off` is
  passed ([cli-reference](https://code.claude.com/docs/en/cli-reference.md)).
- **Hook signals for these events.** `SessionStart.source` is `startup`, `resume`, `clear`,
  `compact` or `fork`. `SessionEnd.reason` is `clear`, `resume`, `logout`, `prompt_input_exit` or
  `other`. A SessionStart hook's `additionalContext` is how context can be re-injected after
  `/clear`. `initialUserMessage` works only in `-p` mode.

Ways to send `/clear` remotely:

| Path | Works? | Source |
|---|---|---|
| Keystrokes (`send-keys -l /clear`, then `Enter`) | Yes | tried |
| Peek-panel reply in `claude agents` (a human UI) | Commands "wait for the turn to end" and then run | agent-view |
| `claude --resume <id> "/clear"` | No. "A prompt that starts with `/` or `!` isn't sent" | sessions |
| Inbox socket or `SendMessage` | No. It "arrives as plain text. Claude Code never executes it" | cross-session-messaging |
| Mod `$.command.run` | Exists. Built-in coverage is undocumented | mods api |
| Channel event | Arrives as `<channel>` content for Claude to read, not as a command | channels-reference |

---

## 5. Per-session configuration from the command line

All of the following are in `claude --help` (2.1.316) and
[cli-reference](https://code.claude.com/docs/en/cli-reference.md).

| Need | Flag | Notes |
|---|---|---|
| Model and effort | `--model <alias\|id>`, `--effort low…max`, `--fallback-model` | `/model` and `/effort` can change them mid-session |
| Pre-approved tools | `--allowedTools` / `--disallowedTools` | Permission rule syntax, such as `"Bash(git *)" Edit "mcp__lead__*"`. `--tools` limits which built-ins exist at all |
| Permission mode | `--permission-mode acceptEdits\|auto\|bypassPermissions\|manual(=default)\|dontAsk\|plan` | Overrides `defaultMode` from settings (tried) |
| System prompt | `--append-system-prompt`, `--append-system-prompt-file`, `--system-prompt[-file]` | Recorded once per conversation (see section 4) |
| MCP | `--mcp-config <file-or-json…>`, `--strict-mcp-config` | |
| Settings and hooks | `--settings <file-or-json>`, `--setting-sources user,project,local` | `--settings` overrides the same keys for this session. Hooks merge. "The file must be a regular file no larger than 2 MiB" |
| Plugins, skills and mods | `--plugin-dir <path>` (repeatable), `--agent <name>`, `--agents <json>` | |
| Name | `-n/--name` | Shown in the prompt bar and `claude agents`. Survives `/clear`. Usable with `--resume <name>` and `claude attach <name>` |
| Working directory | **No `--cwd` flag.** The session uses the process cwd. `--add-dir` adds more directories, and `-w/--worktree [name]` creates `<repo>/.claude/worktrees/<name>` | `claude agents --cwd` is only a list filter |
| Isolation | `--bare`, `--safe-mode`, `--restricted` | `--bare` skips hooks and CLAUDE.md, does not bind the inbox socket, and needs an API key (no OAuth or subscription) |
| Config root | `CLAUDE_CONFIG_DIR`, with `CLAUDE_CODE_PROJECT_DIR_NAME` | Env vars, not flags. A separate config dir also means a separate background supervisor instance |

Not combinable or not applicable: `--bg` with `-p`. `--output-format`, `--input-format`,
`--max-budget-usd` and `--json-schema` are `-p`-only. Configuring flags also make
`claude --resume <running-bg-id>` refuse.

---

## 6. Multiplexer and terminal options

| | **tmux** (3.6a, installed) | **zellij** (not installed) | **WezTerm** (not installed) | **iTerm2** | **Claude Code supervisor** (`--bg`) |
|---|---|---|---|---|---|
| Inject text | `send-keys [-l]`, `paste-buffer -p` (bracketed) | `zellij action write-chars`, `write` (bytes), `paste` ("using bracketed paste mode"), each with `--pane-id` | `wezterm cli send-text [--no-paste] --pane-id` ("as though it were pasted"; bracketed if the pane enabled it) | Python API `Session.async_send_text` ("as though the user had typed it"), macOS only | No headless send. `claude --resume <id> "prompt"` attaches the calling terminal |
| Read screen | `capture-pane -p -S/-E [-J] [-e]` | `zellij action dump-screen [--full] [--ansi] --pane-id` | `wezterm cli get-text --start-line/--end-line [--escapes]` | `async_get_screen_contents`, `get_screen_streamer` | `claude logs <id>` (recent output) |
| Human attach | `tmux attach -t …` from any terminal, multiple clients | `zellij attach` | Only inside the WezTerm GUI or mux server | Only inside iTerm2 | `claude attach <id>` from any terminal |
| Pane and process info | Formats `pane_pid`, `pane_current_command`, `pane_dead` / `pane_dead_status`, option `remain-on-exit`; `wait-for` channels; control mode `-C`/`-CC` streams notifications | `list-clients` (focused pane id, running command); `ZELLIJ_PANE_ID` env | `WEZTERM_PANE` env | Python API | `claude agents --json` (`pid`, `status`, `state`) |
| Used by Claude Code itself | Agent teams split-pane mode, `--tmux` with `--worktree` | No | No | Agent teams via `it2` CLI plus the Python API being enabled | Agent view |

Sources: `man tmux`;
[zellij CLI actions](https://zellij.dev/documentation/cli-actions.html);
[wezterm send-text](https://wezterm.org/cli/cli/send-text.html) and
[get-text](https://wezterm.org/cli/cli/get-text.html);
[iTerm2 Session API](https://iterm2.com/python-api/session.html);
[agent-teams › display mode](https://code.claude.com/docs/en/agent-teams.md#choose-a-display-mode).

Facts relevant to the comparison:

- Claude Code's own **agent teams** use tmux or iTerm2 panes, and the docs say: "`tmux` has known
  limitations on certain operating systems and traditionally works best on macOS. Using `tmux -CC`
  in iTerm2 is the suggested entrypoint". "Split-pane mode isn't supported in VS Code's integrated
  terminal, Windows Terminal, or Ghostty."
- **Truecolor in tmux.** Inside tmux, Claude Code clamps to 256 colours unless
  `CLAUDE_CODE_TMUX_TRUECOLOR` is set. Notifications and the progress bar need
  `allow-passthrough on` ([terminal-config](https://code.claude.com/docs/en/terminal-config.md#configure-tmux)).
- **Server isolation.** `tmux -L <name>` gives a separate server, which keeps Teammates out of the
  user's own tmux server. The experiment ran inside the user's tmux (`$TMUX` set) and used `-L`.
- **Inherited environment.** A tmux server started from inside a Claude Code session inherits that
  session's `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, etc. The
  experiment stripped them with `env -u …`. Whether a nested `claude` misbehaves with them set was
  not tested.
- **Background sessions and attach.** A background session plus `claude attach` gives a
  human-attachable terminal without any multiplexer. Injecting from a script then needs channels,
  the inbox socket, a mod, or running `claude attach` inside a multiplexer pane and sending keys
  to it.

---

## 7. Trade-off matrix (facts only)

| Inbound mechanism | Human can attach and type | Works mid-turn | Can run `/clear` | Documented contract | Preview, flags or dialogs | Collides with the human's draft |
|---|---|---|---|---|---|---|
| tmux keystrokes | Yes (`tmux attach`) | Queues until the tool calls finish | Yes | tmux is stable. The screen is not | None, but the trust dialog must be answered | **Yes** (tried) |
| `claude --bg` plus `--resume <id> "prompt"` | Yes (`claude attach`) | Sent "as its next turn"; refused while the session waits on a question | No | Yes | Untrusted directory gives an error | Not applicable. It needs a TTY and attaches |
| Channel (MCP push) | Yes (any terminal mode) | Delivered "together on the next turn" | No | Yes, but "may change" | Research preview; `--dangerously-load-development-channels` warning dialog | No |
| Inbox socket | Yes | "between tool calls" | No | Socket and auth line only; **message format undocumented** | Inbound hold rules in bypass mode | No |
| Mod `$.prompt.submit` | Yes | Waits for idle | `$.command.run` (built-ins unclear) | Yes (mods API) | Mod loaded via `--plugin-dir` | No |
| `-p` stream-json | **No** | Yes | No | Yes | None | Not applicable |

| State or outbound mechanism | Push or pull | Covers permission waits | Survives `/clear` |
|---|---|---|---|
| `claude agents --json` | Pull, spawns a process per poll | `waitingFor` | Same `pid` and `name`, new `sessionId` |
| Hooks (`command` or `http`) via `--settings` | Push | `PermissionRequest` (immediate), `Notification` (about 6 s) | New `session_id` in later payloads; `SessionStart source=clear` |
| `capture-pane` | Pull | Visible dialog text | Not applicable |
| MCP tools on the Lead | Push (Teammate-initiated) | No | stdio servers keep the spawn-time `CLAUDE_CODE_SESSION_ID` |
| Transcript JSONL | Pull or tail | No | New file per `/clear`; format internal |

---

## Not verified / open

- **Inbox socket message format.** Not found in the docs, and two guesses were ignored. A bytewise
  search of the 300 MB binary was abandoned as out of scope.
- **Not run locally:** `claude --bg`, channels (they need a custom MCP server plus the
  development-flag dialog), and mods. Their facts above come from the docs only.
- **`$.command.run` with built-in commands** such as `/clear` is undocumented.
- **Bracketed paste and the "pasted text" framing.** Whether a prompt injected by bracketed paste
  is marked to Claude as "pasted" (with the injection caveat) when it is the entire prompt, rather
  than collapsed, was not checked in the transcript.
- **zellij, WezTerm and iTerm2** are covered from their docs only. None was installed.

---

## Appendix: experiment log

Setup:

- `tmux -L cc75exp new-session -d -s tm -x 160 -y 45 -c <scratch>/exp/work env -u CLAUDECODE … claude --model haiku --effort low --session-id ac6aa020-… --name tm-exp --settings <scratch>/exp/settings.json`
- The settings registered a single `command` hook for SessionStart, UserPromptSubmit, Stop,
  StopFailure, Notification, PermissionRequest and SessionEnd. The hook appended
  `date +%s`, `$CLAUDE_CODE_MESSAGING_SOCKET` and the stdin JSON to a log file.

Steps:

1. `capture-pane` showed the workspace trust dialog. No hook log existed yet.
   `send-keys Down Enter` accepted it, and `SessionStart` was logged.
2. `send-keys -l $'…\n…'` produced joined text. `Escape Escape` cleared the draft.
3. `set-buffer` + `paste-buffer -p` produced two lines. `send-keys Enter` submitted them, and
   `claude agents --json` showed `busy`. `UserPromptSubmit` and then `Stop` (about 3 s later) were
   logged. `Notification idle_prompt` followed about 60 s after that.
4. Two lines posted to `/tmp/cc-socks/<pid>.sock` with `nc -U` (plain text, then guessed JSON)
   produced no visible effect.
5. `send-keys -l /clear` + `Enter` logged `SessionEnd reason=clear`, then `SessionStart
   source=clear` with a new `session_id`. `claude agents --json` showed the same pid and name with
   the new `sessionId`.
6. `tmux kill-server` logged `SessionEnd reason=other`.
7. A new session with `--permission-mode default` was asked to run `touch marker.txt` with Bash.
   - Logged: `PermissionRequest` (+2 s) and `Notification permission_prompt` (+8 s).
   - `claude agents --json` showed `waiting` / `permission prompt`.
   - `send-keys 1` approved the call, and the file was created.
8. Typed a human draft, then pasted text into the box. The box held both strings concatenated.
9. `tmux -L cc75exp kill-server`. `claude agents --json --cwd <scratch>/exp/work` returned `[]`.
