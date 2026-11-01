# Prior art: a lead directing several Claude Code sessions

Date: 2026-11-01 · Ticket: #76 · Map: #74

Question: what existing tools already have a lead directing several Claude Code sessions, what
should the Team extension's spec borrow or avoid, and does anything make a pi-native Lead a thin
wrapper (which would redraw the map's destination)?

Method: official Claude Code docs (code.claude.com, fetched today) and the
[CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) (current version
2.1.316); for everything else, the repo's README, source at a pinned commit, and GitHub issues.
Earlier notes already cover pi-messenger and the `pi-subagents` forks
([web-pi-multi-session.md](web-pi-multi-session.md),
[peer-sessions-messaging.md](peer-sessions-messaging.md)); they are not repeated here.
"Unverified" means read in docs or code but not run.

## Verdict: no thin wrapper exists

Nothing surveyed lets a pi Lead be a thin layer over someone else's runtime:

- **Claude Code agent teams can't have a pi lead.** "The main session is the lead for its
  lifetime", the team config is runtime-owned ("don't edit it by hand or pre-author it"), teammates
  can't be spawned under `-p` or the Agent SDK, and there is no external API. A request for a
  documented contract for outside writers to the inbox files (#88332) was closed as not planned.
- **The multi-session managers are apps, not libraries.** claude-squad and ccmanager are closed
  TUIs. agent-deck and ntm have scriptable CLIs and JSON output, so a Lead could shell out to them,
  but each is a large, fast-moving Go control plane that wants to own tmux, worktrees and Claude's
  `settings.json`.
- **The orchestration frameworks don't run real sessions, or did and gave up.** claude-flow (now
  ruflo) "swarms" are MCP records plus prompting around a single Claude process. claude-swarm v1
  ran headless workers as blocking MCP calls, and its author dropped Claude Code entirely in v2.
- **Only hcom comes close.** It is a Rust binary that launches Claude and pi in visible terminals,
  records hook events to SQLite and lets any process `hcom send @name`. A Lead on top of it would be
  thin, at the price of an external daemon and database, global hooks and a PTY wrapper.
- **No pi package fits.** The pi packages that drive Claude are headless (Agent SDK, `-p`, ACP),
  tmux-bound with model-printed done markers, or drive pi executors rather than Claude.

**What does change the picture is that Claude Code itself now ships the primitives that ADR-0001
lacked.** These are background sessions a human attaches to from any terminal, a machine-readable
state listing, a documented per-session inbox socket, a way to send a prompt into a running
background session, and turn-end hooks. A pi-native Lead built on them needs no tmux. See
[§2](#2-claude-code-primitives-an-outside-lead-can-use).

## 1. Claude Code agent teams (experimental)

Source: [agent-teams](https://code.claude.com/docs/en/agent-teams) unless noted.

- **Enable:** set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; added in v2.1.32 as a research
  preview. With the flag on, any subagent Claude *names* launches as a teammate, without asking.
  Since v2.1.178 every session has one implicit team (`TeamCreate`/`TeamDelete` are gone).
- **Start:** the lead calls the Agent tool with a `name`. Teammates load CLAUDE.md, MCP and skills
  like any session and get the spawn prompt, but not the lead's history. Spawning "requires an
  interactive session".
- **Talk:** each agent has one mailbox file, `~/.claude/teams/{team}/inboxes/{agent}.json`.
  `SendMessage` sends to one recipient by name. Any teammate can message any other, and "the lead
  doesn't need to poll". Issue reports say teammates poll their inbox about every 500 ms
  (#89515). The entry schema isn't documented.
- **Task list:** `~/.claude/tasks/{team}/`, with tasks pending, in progress or completed, plus
  dependencies. Claims use file locking. The team config (`config.json`, a `members` array) is
  deleted at session end; the task list stays.
- **Done/idle:** a teammate that stops "automatically notifies the lead and includes its final
  answer"; an API-error stop notifies "failed". Hooks: `TeammateIdle` (exit 2 keeps the teammate
  working), `TaskCreated` and `TaskCompleted` (exit 2 blocks) ([hooks](https://code.claude.com/docs/en/hooks)).
- **Human steps in:**
  - In-process (the default): arrow keys plus Enter in the lead's agent panel, then type.
  - Split panes: tmux or iTerm2 with `it2`; click the pane. Not supported in VS Code's terminal,
    Windows Terminal or Ghostty.
  - From the teammate view, `/clear`, `/compact` and `/rewind` act on the *lead*. A teammate's
    model is fixed at spawn. The lead has no documented way to clear a teammate's context.
- **Permissions:** teammates inherit the lead's mode (not `dontAsk`), and
  `--dangerously-skip-permissions` propagates. Split-pane teammates don't get `--allowedTools`
  (use `--settings` `permissions.allow`). "Teammate permission prompts appear in the lead session."
  Messages from agents are labelled as non-human and can't approve anything.
- **Documented limits:**
  - `/resume` and `/rewind` don't restore in-process teammates.
  - "Task status can lag."
  - Shutdown can be slow.
  - One team per session, and no nested teams.
  - "Lead is fixed."
  - Permission modes are set at spawn.
  - The lead sometimes starts doing tasks itself ("Wait for your teammates…").
- **What broke** (CHANGELOG versions; issue numbers in anthropics/claude-code):
  - **Messaging failures:**
    - tmux teammates couldn't message (2.1.33).
    - A malformed mailbox entry caused a crash loop (2.1.207).
    - `SendMessage` reported "sent" after a failed write (2.1.224).
    - Duplicate idle notifications (2.1.212).
    - A teammate's final answer didn't reach the lead (2.1.251).
  - **Leftover panes:** orphaned panes after the lead exits or after shutdown (2.1.77, 2.1.257).
  - **tmux startup:** pane launch failed with slow shell rc files, and keystrokes leaked into new
    panes (2.1.183).
  - **Settings not inherited:** model, mode, effort, deny rules (2.1.72, 2.1.98, 2.1.186, 2.1.309).
  - **Empty task list after `--resume`/`/clear`:** 2.1.311.
  - **Still open:**
    - Messages to a busy interactive teammate wait until its turn ends (#99111, #98998).
    - 5–62 minute delivery delays and lost final reports (#76500).
    - The lead burns 13–22% of input tokens acknowledging idle notifications (#47930).
    - Ping-pong wake-ups between lead and teammates (#85047).
    - Idle teammates are never evicted (#89515).
    - A tmux teammate stuck on a permission or trust prompt "waits forever" and the lead isn't told
      (#104356).
    - One in-process teammate's pending prompt blocks every teammate's messages (#104675).
    - Races between `send-keys` and Claude Code's own tmux commands (#26572).

## 2. Claude Code primitives an outside Lead can use

These are the pieces the other tools keep rebuilding, and they bear directly on ADR-0001's
objections.

**Background sessions** ([agent-view](https://code.claude.com/docs/en/agent-view), research preview since v2.1.139)

- **Starting and attaching:**
  - `claude --bg --name <n> "prompt"` starts a session under a supervisor daemon. It can't be
    combined with `-p` (2.1.198).
  - `claude attach <id|name>` attaches from **any terminal**; ← or `/exit` detaches without
    stopping it. The other commands are `logs`, `stop`, `respawn` and `rm`.
- **State:** `claude agents --json [--all]` is the supported state read, with these fields:
  - `state`: `working|blocked|done|failed|stopped`
  - `status`: `busy|waiting|idle`
  - `waitingFor`: `permission prompt`, `input needed`, `sandbox request`, `worker request` or
    `dialog open`
  - `sessionId` and `name`

  "A session that finished its turn and is waiting for your next instruction reads `done`, not
  `blocked`." Files under `~/.claude/jobs/<id>/` "are not a stable interface".
- **Sending a prompt:** since 2.1.285, `claude --resume <id> "prompt"` on a running background
  session "is sent to it as its next turn" (CHANGELOG). Peek-panel replies to a working session
  "join the session's message queue instead of interrupting".
- **Lifecycle and cost:**
  - An unattached session that is done or waiting has its process stopped after about an hour,
    then resumes on attach or reply. `Ctrl+T` pins it.
  - Sessions survive terminal close and sleep, but not shutdown.
  - "Background sessions consume your subscription usage the same as interactive sessions."

**Per-session inbox socket** ([cross-session-messaging](https://code.claude.com/docs/en/cross-session-messaging), v2.1.224+)

- **Where it is:** every interactive or `-p` session except `--bare` binds a Unix socket, exported
  to hooks and Bash as `CLAUDE_CODE_MESSAGING_SOCKET`, with `CLAUDE_CODE_MESSAGING_TOKEN`. It is
  documented for when "you want a script or hook to post into a session". Background sessions bind
  one too and appear in the listing.
- **Delivery:** a message is read "between tool calls during an active turn", and an idle session
  "starts a new turn with the message".
- **What a message can't do:** it is labelled as from another session. It "can't approve
  anything", and "a command in the message's text, such as `/compact`… Claude Code never
  executes it".
- **Inbound controls:** `crossSessionInbound` is `accept`, `hold` or `refuse`. With no value set, a
  session that *bypasses* permission prompts holds messages from non-bypassing senders for
  approval. Pass `accept` per session via `--settings`.
- **Limits:** about 1M characters per message, 50 queued messages, loop throttling, a complete line
  within 30 s, and plain text only.
- **Undocumented wire format:** only the auth line `{"type":"auth","token":…}` is documented, not
  the message line. agent-deck reverse-engineered
  `{"msgV":1,"msg_id":…,"type":"user","session_id":…,"message":{"role":"user","content":…},"priority":"next"}`
  from the 2.1.259 binary and gates it on a protocol version
  ([claudesocket.go L321-385](https://github.com/asheshgoplani/agent-deck/blob/10aa3a4a78484852b3f1ead9cbe5239c0a7ac7f2/internal/send/claudesocket.go#L321)).
- `notify_when_idle` exists but only Claude's own `SendMessage` can subscribe.

**Hooks** ([hooks](https://code.claude.com/docs/en/hooks)): every hook gets `session_id` and `transcript_path`, which "may lag".

- **`Stop`** carries `last_assistant_message`. It fires at **every** turn end, not on user
  interrupt; API errors fire `StopFailure` instead.
- **`Notification`** matchers include `permission_prompt`, `idle_prompt` (about 60 s after the
  turn, too slow as a turn signal), `elicitation_dialog`, `agent_needs_input` and
  `agent_completed`.
- **`SessionStart`** sources are `startup|resume|clear|compact|fork`, so it does fire on `/clear`,
  which changes the session ID.
- **`UserPromptSubmit`** carries `prompt`.
- **Other:** hooks can be `http`. `asyncRewake` and `FileChanged` exist.
- **Per-spawn:** hooks can be supplied with `--settings` per spawned session, leaving the user's
  settings.json alone.

**Channels** ([channels-reference](https://code.claude.com/docs/en/channels-reference), research preview since v2.1.80)

- An MCP server pushes `notifications/claude/channel` into a running session and gets replies
  through a tool. It has an optional permission relay.
- Custom channels need `--dangerously-load-development-channels`, which shows a startup
  confirmation dialog and is ignored under `-p`.

**Headless only:** `--input-format stream-json`, `--output-format`, `--permission-prompt-tool` and `--max-turns` work only with `-p`. The interactive TUI has no stream-json input.

## 3. Multi-session managers (tmux / PTY)

### claude-squad ([smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad), 8.7k★, v1.0.20 2026-08-20)

A Go TUI. Source at `ce1ffb43`.

- **Talk:** one detached tmux session per instance, in a git worktree. It writes raw bytes to a PTY
  on `tmux attach-session`: the text, 100 ms sleep, then `\r`
  ([instance.go L632-650](https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/instance.go#L632)).
- **Done/idle:** SHA-256 of `capture-pane` every 500 ms; a changed hash means running, an
  unchanged one means ready. A permission prompt is the literal string `"No, and tell Claude what
  to do differently"`. The trust dialog is auto-answered with Enter. "Auto-yes" presses Enter on
  that string, from a daemon that keeps running after the TUI exits.
- **Human steps in:** attach with Enter, detach with Ctrl-Q. It never detects human input. tmux
  outlives the TUI, and state is in `~/.claude-squad/state.json`.
- **What broke:**
  - Auto-yes stopped working after a Claude Code UI change; users fell back to skip-permissions
    (#151, #180).
  - A prompt sent before the CLI is ready is lost (#266, open).
  - "Error capturing pane content" after the tmux server died (#51).
  - A stdin race between its own reader and the attach reader (#325).

### ccmanager ([kbwo/ccmanager](https://github.com/kbwo/ccmanager), 1.3k★, v4.4.11 2026-10-27)

TypeScript and Ink. Source at `b0948dd2`.

- **Talk:** no tmux. Its own PTY (Bun Terminal) feeds an `@xterm/headless` screen buffer.
- **Done/idle:** regexes on the emulated screen every 100 ms
  ([stateDetector/claude.ts](https://github.com/kbwo/ccmanager/blob/b0948dd25b41511d67c2b0db386082d21a9fdfbd/src/services/stateDetector/claude.ts)):
  - **waiting:** `do you want|would you like … yes|❯`, `esc to cancel`, or `N. deny (esc)`.
  - **busy:** `esc to interrupt`, a spinner line, or a token-count line above the `─❯─` box.
  - **idle:** none of these, with the screen unchanged for 1.5 s.

  It runs its own status hooks on transitions. Auto-approve asks `claude --model haiku -p` whether
  a human is needed, and any keypress cancels it.
- **Human steps in:** in its own UI. **Sessions die when ccmanager exits**; "restore" relaunches
  the command but not the conversation. It forces `--teammate-mode in-process` so Claude's own
  teams don't fight its PTY.
- **What broke:**
  - Reported idle while Claude was busy because a custom statusline hid `esc to interrupt` (#227).
  - Detection broke when 2.0.28 changed the plan-mode menu (#113, #117).
  - A terminal resize fired the idle hook (#73).

### agent-deck ([asheshgoplani/agent-deck](https://github.com/asheshgoplani/agent-deck), 1.2k★, v1.16.35 2026-10-31)

The most relevant one. Go and tmux. Source at `10aa3a4a`.

- **Lead shape:** a **"conductor"**, a persistent Claude or Codex session that oversees child
  sessions, answers routine questions, escalates the rest and is woken by status transitions. It
  also ships a pi extension (`agent-deck pi-hooks install`) that runs pi as a child.
- **Done/idle: hooks first.** `agent-deck hooks install` adds `SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `Stop`, `PermissionRequest`, `Notification` (`permission_prompt|elicitation_dialog`),
  `SessionEnd` and `PreCompact`. These write `~/.agent-deck/hooks/{instance}.json`, keyed by an
  env var
  ([claude_hooks.go L255-291](https://github.com/asheshgoplani/agent-deck/blob/10aa3a4a78484852b3f1ead9cbe5239c0a7ac7f2/internal/session/claude_hooks.go#L255)).
  Screen patterns remain as a fallback, tested against a labelled corpus of captures. Output
  arrives over a `tmux -C` control-mode pipe.
- **Talk:** two transports:
  - **tmux:** `send-keys -l`, or `load-buffer` plus `paste-buffer -p`, then a separate `Enter`.
  - **Inbox socket:** the reverse-engineered frame from §2.
- **Human steps in:** `ClaudeComposerReady` refuses to type with code `composer_draft` (the human
  has unsent text), `agent_busy`, `dialog_open` or `no_prompt`. It uses the ANSI dim attribute to
  ignore grey suggestion text
  ([composer_ready.go](https://github.com/asheshgoplani/agent-deck/blob/10aa3a4a78484852b3f1ead9cbe5239c0a7ac7f2/internal/send/composer_ready.go#L10)).
  This is the closest prior art for "notice the human typed".
- **Scriptable:** `session send [--wait]`, `session show --json`, `launch --parent` and
  `session children`.
- **What broke** (the most useful list in this survey):
  - **No trustworthy "finished" signal:** `Stop` fires every turn, so "waiting" mixes up done, a
    pause and blocked. The proposal was a sentinel line the worker prints (#1186, #1214).
  - **Sends merged with the human's text:** automated sends were appended to the operator's
    half-typed text, or clobbered an open picker (#1409, #1981). Grey suggestion text was misread
    as a draft (#1777).
  - **Lost Enter / double delivery:** text was typed but not submitted (#1413, #2077, #616).
    Ctrl-C-and-resend delivered twice (#1979).
  - **Wrong status:**
    - `Stop` arrives before the screen settles (#2502).
    - Quiet sessions stuck at "running" (#2896).
    - A usage-limit hit looked like idle (#1802).
    - A non-UTF-8 locale broke parsing (#1867, #1495).
  - **Watchdog kills:** the startup watchdog killed live sessions (#2361, #2369).

### ntm ([Dicklesworthstone/ntm](https://github.com/Dicklesworthstone/ntm), 465★, v1.38.0 2026-10-31)

Go and tmux, built to be driven by an agent: `--robot-send`, `--robot-is-working`,
`--robot-tail`, plus `ntm serve` (REST, SSE and WebSocket).

- **Talk:** `send-keys -l`, or paste-buffer, then `Enter`.
- **Done/idle:** screen patterns only
  ([patterns.go](https://github.com/Dicklesworthstone/ntm/blob/e819b97bb99e6cd0bf6b713726a7db4455a536d1/internal/agent/patterns.go)):
  - **working:** a spinner line, or `(ctrl+c|esc) to interrupt`.
  - **turn-ended:** a line like `✻ Cogitated for 2m 3s`.
  - The newest marker in the last 16 lines wins.

  It has worktrees per agent, plus "Agent Mail" file reservations.
- **What broke:**
  - "bypass permissions on" always matched as idle (#79).
  - `send-keys -l` stripped newlines, so prompts were never submitted (#86).
  - `--prompt` raced the welcome screen (#158).
  - `@` tokens opened autocomplete (#198).
  - "Sent" was reported for unsubmitted prompts (#241).
  - A fixed 120 s idle threshold injected prompts mid-task (#235, #238).

### oh-my-claudecode `omc team` ([Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode), 40k★, v5.7.26 2026-11-01)

Two runtimes: `/team` wraps native agent teams, and `omc team N:claude` runs persistent
interactive `claude` TUIs in tmux panes.

- **Talk:** the full brief goes to `workers/{w}/inbox.md`, then a short trigger is typed with
  `send-keys -l` plus `Enter`. The leader's own inbox is a file, "not tmux send-keys".
- **Done/idle:** a protocol plus scraping:
  - Workers call `omc team api claim-task` / `transition-task-status` with claim tokens, and write
    `.ready`, a status JSON and `heartbeat.json`.
  - `paneLooksReady` / `paneHasActiveTask` regex `capture-pane` output for prompt glyphs, spinners
    and "esc to interrupt".
  - An idle-nudge loop resends keys.
- **Human:** plain tmux panes. Workers run `--dangerously-skip-permissions`.
- **What broke:**
  - A new spinner glyph made working panes get torn down as idle (#4124).
  - A new trust dialog killed workers (#4123).
  - A bypass dialog auto-selected "exit" in small panes (#2184).
  - The first task was lost to a boot-banner race (#3485).
  - `send-keys` fired before the shell was ready (#1144).
  - The start command was truncated at 1024 bytes (#4191).
  - The leader was told "available" while a report was still owed (#3662).
  - Orphaned workers (#1632).

### Tmux-Orchestrator and Claude Code Agent Farm (Dicklesworthstone)

Older precedents, now abandoned or deprecated by their own authors.

- **[Tmux-Orchestrator](https://github.com/Jedward23/Tmux-Orchestrator)** (1.8k★, last push
  2025-07-14):
  - An orchestrator *Claude* drives others with `send-keys "$MSG"; sleep 0.5; send-keys Enter`.
    Putting Enter in the same call failed.
  - It reads with `capture-pane | tail -50`, and the LLM judges the state. There is no programmatic
    idle detection.
  - Self-wakeups are `nohup sleep N && send-keys`.
  - What broke: a referenced script was missing (#4, #6). Users asked to replace prompt rules with
    hooks (#12). A PM-plus-team setup wasted tokens and overwrote files (#21).
- **[Agent Farm](https://github.com/Dicklesworthstone/claude_code_agent_farm)** (923★):
  - A Python script, not an LLM, runs 20+ skip-permissions panes. It scrapes readiness strings
    (some match Claude's old bordered prompt; unverified), uses heartbeat files with a 120 s
    restart, and sends `/clear` when context runs low.
  - Launches must be staggered and locked because concurrent starts corrupted `~/.claude`.
  - The author calls it "an old legacy project that I don't recommend", replaced by mcp_agent_mail
    (mailboxes plus file reservations with TTLs) (#4).

## 4. Orchestration frameworks

### claude-flow → ruflo ([ruvnet/ruflo](https://github.com/ruvnet/ruflo), 80k★, v3.68.0 2026-11-01)

- **Talk:** in nearly every path, Claude Code *is* the lead and the swarm is MCP tools plus
  prompts:
  - `agent_spawn` writes a record to `.claude-flow/agents/store.json` with `status: 'idle'`.
    `swarm start` prints "This CLI coordinates agent state. Execution happens via: Claude Code
    Agent tool / claude -p / hive-mind spawn --claude"
    ([agent-tools.ts](https://github.com/ruvnet/ruflo/blob/main/v3/%40claude-flow/cli/src/mcp-tools/agent-tools.ts#L478)).
  - `hive-mind spawn --claude` starts **one** interactive `claude` with a "Queen" prompt.
  - Real `claude -p` processes appear only in background daemon workers and a console plugin.
- **Done/idle:** a field the model sets through MCP calls. **Human:** only the one queen process.
- **What broke:**
  - "Ruflo is 99% Theater" (#1514). The maintainer's own audit issue (#1896, open) says "the
    multi-agent swarm runtime its README describes does not yet execute end-to-end".
  - Per-worktree daemons running `claude --print` exhausted the quota (#2661, P0). Millions of
    tokens were burned in 30 minutes (#1330).

### claude-swarm v1 (parruda; gem [`claude_swarm`](https://rubygems.org/gems/claude_swarm) v1.0.11, repo now 404)

- **Talk:** the main instance is an interactive `claude` with `--mcp-config` and
  `--append-system-prompt`. Each worker is an MCP server exposing `task(prompt, new_session?)`,
  which runs a **headless** resumed session through the Ruby SDK, so delegation is a blocking tool
  call.
- **Done/idle:** the SDK result message. **Human:** only the main instance.
- **What broke:** the author dropped Claude Code in v2 (SwarmSDK). The migration guide gives the
  reasons: "Heavy resource usage (multiple Claude Code processes)", "Complex state management
  across processes", "Limited control", and "Tied to Claude Code's release cycle".

## 5. pi packages, and hcom

### pi-interactive-subagents ([HazAT](https://github.com/HazAT/pi-interactive-subagents), 727★, v3.7.2 2026-05-12, git-installed)

This is the approach ADR-0001 weighed. It supports cmux, tmux, zellij and WezTerm, and **it
already has a Claude backend** (`cli: claude`).

- **Talk:**
  - It types `bash <script>` into the pane after a fixed 500 ms shell-ready delay.
  - The script runs `claude --dangerously-skip-permissions --plugin-dir … [--append-system-prompt]
    [--resume] "<task>"; echo __SUBAGENT_DONE_$?__`.
- **Done/idle:**
  - Every second it polls for a `.exit` file (pi children) or a sentinel file written by a plugin
    `Stop` hook (Claude).
  - The hook writes `last_assistant_message` **only if the transcript has exactly one user
    message**, that is, no human typed.
  - The fallback scrapes the echo marker.
  - Results are the sentinel text or the last 200 screen lines. They reach the parent as a steer;
    then the pane is closed.
- **Human:** types in the pane. For Claude that suppresses the sentinel, so the parent waits for
  `claude` to exit. Interrupt is refused for Claude.
- **What broke:**
  - Children forget `subagent_done` (#3).
  - `/reload` leaks poll timers, about 70% CPU after 10 reloads (#5).
  - zellij API changes (#7, #17, #19).
  - Shell init swallows the typed command, so the child "stalled forever" (PR #59).
  - A child the user quit still shows as running (PR #53).
  - Children aren't closed on shutdown (PR #46).

### Other pi packages that drive Claude Code

| Package | Transport | Done/idle | Human attach | Notes |
|---|---|---|---|---|
| [pi-claude-supervisor](https://github.com/btnalit/pi-claude-supervisor) (npm 0.10.0, 0★) | real TUI in a private tmux socket; `load-buffer` + `paste-buffer -p` + Enter; also a `-p` stream-json mode | hook relay: `Stop` (`last_assistant_message`), `StopFailure`; `Notification idle_prompt` as a backstop | yes; **detects the human** when a `UserPromptSubmit` prompt doesn't match a pending paste, then pauses automation (`human_takeover`) until resumed or 30 min idle | needs Claude Code ≥2.1.270; hands finished sessions back rather than killing them; auto-accepts the trust dialog |
| [claude-code-tmux / ccmux](https://github.com/Mahir-Isikli/claude-code-tmux) (6★) | tmux; paste with verify-and-retry; pi tools `ccmux_start/send/steer/status/capture`; hooks via `--settings` | the model must print `CCMUX_DONE:<id>` or write a done file; the README calls it "best-effort … heuristic" | yes | runs skip-permissions; matches the trust prompt on screen |
| [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) (744★) and fork `@ramtinj95/pi-claude-delegation` | Agent SDK | SDK result | no | billing worries: "Third-party apps now draw from your extra usage" (#177, #213) |
| [pi-shell-acp → entwurf](https://github.com/junghan0611/pi-shell-acp) | ACP; native Claude sessions get a mailbox via `SessionStart` watch paths, a `*.msg` file, and a `FileChanged` + `asyncRewake` wake | hook wake | native sessions yes, ACP no | wake proven on Linux only; driving a live tmux pane is ruled out of scope |
| [pi-lead](https://github.com/spacegrowth/pi-lead) | iTerm2 tabs or tmux windows; **executors are pi**, not Claude | executor writes a report to the Lead's inbox file, which wakes the Lead; `health.json` | yes | "pi-lead never types into a running pi session"; approval gates, staged-not-committed work, a `verify` step; documents duplicate-wake and crash recovery |

Unverified, read from npm descriptions only: pi-tmux-orchestrator, pi-agents-tmux and pi-tmux-pane.
Not relevant to human attach (headless `claude -p`, done when the process exits):
pi-harness-delegate, claude-code-pi and pi-claude-cli.

### hcom ([aannoo/hcom](https://github.com/aannoo/hcom), 621★, Rust)

- **Talk:** launches Claude, pi, Codex and others in visible terminals (tmux, kitty, wezterm,
  zellij, cmux), logs hook activity to SQLite, and lets any process `hcom send @name`.
- **Done/idle:** `hcom events --idle X --wait`.
- **How Claude is woken:** either the `Stop` hook blocks and polls, returning `decision:block`, or
  a PTY wrapper types a wake marker that `UserPromptSubmit` replaces with the queued messages.

This is the one external layer a Lead could sit on thinly.

### For contrast: structured protocols with no human attach

- **vibe-kanban** (28.5k★) runs `claude -p --input-format=stream-json --permission-prompt-tool=stdio`.
- **Crystal/Nimbalyst** runs `-p` stream-json under node-pty.
- **ACP** ([claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp), 2.7k★)
  runs the SDK over stdio for a single client.

All three give exact status and permission events, but a human can't type into the live session.

## 6. Failure modes that recur across tools

| Failure | Seen in | Lesson |
|---|---|---|
| Status from screen regex breaks on Claude UI changes (spinner glyph, trust dialog, plan menu, statusline, locale) | omc #4124/#4123, ccmanager #113/#117/#227, claude-squad #151/#180, ntm #79, agent-deck #1867 | get status from hooks; scraping only as a tie-breaker |
| Typing before the TUI or shell is ready loses the first prompt | claude-squad #266, ntm #158, omc #3485/#1144, HazAT PR #59, Claude Code 2.1.183 | wait for a readiness signal (`SessionStart` hook), not a sleep |
| Enter lost or newline stripped, so the text sits unsubmitted | agent-deck #1413/#2077, ntm #86/#241 | confirm the submit via `UserPromptSubmit`; never resend blindly (agent-deck #1979) |
| Automated text merged with the human's half-typed input | agent-deck #1409/#1981/#1777 | check the input box before typing, or don't type at all |
| `Stop` ≠ task done | agent-deck #1186/#1214, omc #3662 | a separate "task finished" signal |
| Fixed idle timeouts misfire | ntm #235/#238, omc #3798 | state, not timers |
| Prompt stalls invisible to the lead | Claude Code #104356, #104675 | watch `Notification permission_prompt` / `waitingFor` |
| Lead burns tokens on notifications | Claude Code #47930/#85047 | don't acknowledge every idle; batch |
| Background `claude -p` work without a budget | ruflo #2661/#1330 | global budget or lease |
| Sessions owned by the lead's process die with it | ccmanager | host sessions outside pi (tmux or `--bg`) |
| `/reload` leaks timers | HazAT #5 | clean up on `session_shutdown` (see [limits.md](../pi-api/limits.md)) |
| Skip-permissions by default | most tmux tools | also makes the inbox socket *hold* messages by default |

## 7. Borrow / avoid

These are notes for the spec. The design decisions belong to the map.

**Borrow**

- **Hosting outside pi:** both `claude --bg` + `claude attach` and tmux sessions survive a Lead
  restart. Background sessions also answer ADR-0001's objections (no tmux, no pane layout, works in
  a plain terminal).
- **Status from hooks supplied per spawn:** pass them with `--settings`, keyed by a Teammate env
  var (agent-deck, ccmux, supervisor).
  - `Stop` with `last_assistant_message` means the turn ended.
  - `StopFailure` means the turn errored.
  - `Notification permission_prompt` / `elicitation_dialog` means blocked on a human.
  - `SessionStart` (including `source: "clear"`, where the session ID changes) means ready.
  - `SessionEnd` means exited.
  - `claude agents --json` is a cross-check.
- **A task-done signal separate from turn-end:** the native teams' idle notification "includes its
  final answer". omc uses claim-token task transitions. A tool or file the Teammate writes beats a
  printed marker the model must remember.
- **Noticing the human:** pi-claude-supervisor matches each `UserPromptSubmit` against pending Lead
  sends; anything unmatched came from the human, and the Lead pauses. agent-deck's empty-input
  check is the fallback for typed transports.
- **The brief in a file, a short nudge in the session** (omc). This fits the map's "work passes
  through files".
- **Advisory file reservations with TTLs** (mcp_agent_mail, ntm Agent Mail), for when Teammates
  share files.
- **Labelling Lead messages as non-human,** as Claude Code does for peer messages, so they can't
  approve prompts.
- **A shutdown request/response handshake** (native teams).
- **Handing a finished session back** rather than killing it (supervisor).
- **Stripping inherited `CLAUDE_CODE_*` env vars** (session ID, messaging socket and token) when
  spawning `claude` from inside another Claude-launched process.

**Avoid**

- Screen-scraped status as the primary signal.
- Fixed sleeps before typing.
- Fixed idle timeouts.
- Blind resends.
- Done markers the model must remember to print (HazAT #3, ccmux).
- Auto-yes on a matched string.
- `--dangerously-skip-permissions` as the default.
- PTYs owned by the Lead process.
- Acknowledging every idle notification (ping-pong).
- Registry-only "agents" and orchestration that lives only in a prompt (ruflo).
- `-p`, SDK or ACP transports for Teammates, which rule out human attach. SDK billing is also in
  flux.

## 8. Unverified: prototype before the spec relies on these

1. **The inbox socket's message line.** It is undocumented; agent-deck's frame was
   reverse-engineered from 2.1.259. Also unverified: whether a non-child sender (pi) is delivered
   or held under each permission mode with `crossSessionInbound: accept`.
2. **`claude --resume <id> "prompt"` into a running `--bg` session.** CHANGELOG 2.1.285 says it
   becomes the next turn. Unverified: behaviour while a human is attached and mid-typing, and
   whether it queues or is refused while the session is busy.
3. **Clearing a Teammate's context.** The socket won't run `/clear` ("never executes" commands),
   and there is no `clear` CLI verb. The options are typing `/clear` into an attached terminal, or
   starting a fresh session (new `--session-id`) with the Brief and Playbook re-sent. Unverified:
   whether `--append-system-prompt` is reapplied after `/clear`.
4. **The background-session idle stop.** An unattached idle session's process is stopped after
   about an hour, so it is unclear whether its inbox socket still accepts messages, or whether only
   `--resume <id> "prompt"` / a peek reply wakes it. Pinning (`Ctrl+T`) avoids this, but the CLI
   equivalent is unverified.
5. **Stability.** Agent view, channels and agent teams are all research previews or experimental.
   `claude agents --json` is documented as the stable read, `~/.claude/jobs/` is not, and neither
   is `~/.claude/sessions/<pid>.json` (which lists `messagingSocketPath` locally on 2.1.316).
6. **macOS.** entwurf's `FileChanged` + `asyncRewake` wake was only proven on Linux.
