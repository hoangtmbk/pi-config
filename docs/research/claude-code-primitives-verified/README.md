# Claude Code control primitives, verified by experiment

Ticket: [Verify Claude Code's background-session and prompt-injection primitives](https://github.com/hoangtmbk/pi-config/issues/84), on the map [Team extension: a pi Lead directing Claude Code Teammates](https://github.com/hoangtmbk/pi-config/issues/74).

Tried on 2026-11-01 on macOS (Darwin 25.5.0), **Claude Code 2.1.316**, tmux 3.6a, on a Claude subscription account. All test sessions used `--model haiku`. Every session started was stopped and removed with `claude rm` afterwards, and every trust entry added to `~/.claude.json` was deleted again.

This branch is evidence for the ticket. It is never merged.

## Harness

- `scripts/hooklog.sh`: a command hook for `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `PermissionRequest`, `Notification`, `PreToolUse` and `SessionEnd`. It appends each payload, with a timestamp, to a log, and on `SessionStart` saves `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` and `CLAUDE_CODE_SESSION_ID`. It is passed per session with `--settings <file>`, which leaves the user's own settings alone.
- `scripts/sock_send.py <socket> <token> <text>`: writes an auth line and one message line to a session's inbox socket.
- `scripts/chan_server.py`: a minimal stdio MCP server that declares the `claude/channel` capability and pushes `notifications/claude/channel` whenever a file appears.
- `scripts/permhold.sh <seconds>`: a `PermissionRequest` hook that sleeps, then returns `allow`.
- `scripts/planok.sh plain|setauto`: a `PermissionRequest` hook, matched on `ExitPlanMode`, that returns `allow` (plus `setMode: auto` for `setauto`).
- `scripts/floor.sh`: a `PreToolUse` hook, matched on `Bash`, that returns `permissionDecision: "ask"` for any command containing `git push`.
- `wf-clear-mod/`: a mod, loaded per session with `--plugin-dir`, that runs `/clear` when a socket message contains `__WF_CLEAR__`.

The user's own `defaultMode` is `bypassPermissions`, so every test passes `--permission-mode` explicitly.

## 1. Prompting a running background session

| Command | Result |
| --- | --- |
| `claude --bg --model haiku --settings S --permission-mode default --name wf-bg1 "Reply with the single word PONG."` | `backgrounded · a06e66ae · wf-bg1`. The turn ran: `SessionStart`, `UserPromptSubmit`, `Stop` with `last_assistant_message: "PONG"`. |
| `claude --resume <full-session-id> "…SECOND."` with stdin from `/dev/null` and output to a file (no TTY) | Exit 1: `Error: That session is running in the background (a06e66ae). Run claude attach a06e66ae to open it, or claude stop a06e66ae first to resume it here. Add --fork-session to branch off a copy instead.` Nothing was sent. |
| `claude --resume a06e66ae "…"` in a tmux pane (short id) | Opened the resume picker: `No sessions match "a06e66ae"`. |
| `claude --resume <full-session-id> "Reply with the single word SECOND."` in a tmux pane | **Sent.** `UserPromptSubmit` with that prompt, `Stop` with `SECOND`. The calling terminal is now **attached** to the session (full TUI, transcript shown). |
| Killing that tmux pane | The background session lived on (`claude agents --json`: same pid, `idle`/`done`). |
| `claude --bg --resume <full-session-id> "…THIRD."` on the running session | `note: session a06e66ae is already running in the background, so this started a copy as a4c8af09.` The copy got an auto-generated name (`single-word-third-reply`), not `wf-bg1`. |

**Answer:** both research tickets were half right. `claude --resume <full id> "prompt"` does deliver the prompt as the next turn, but it needs a TTY and attaches that TTY. From a process with no TTY it refuses. It is not a headless send.

## 2. Prompting while a human is attached

Setup: `claude attach a06e66ae` in tmux pane `h1`, then `send-keys -l "human draft not sent"` (no Enter).

| Action | Result |
| --- | --- |
| Socket message `Reply with the single word ATTACHED.` | It ran as its own turn (`ATTACHED`). The human's input box still read `❯ human draft not sent`. |
| `claude --resume <id> "Reply with the single word RESUMED."` from a second tmux pane while `h1` stays attached | The second pane attached too. The prompt ran (`RESUMED`). Both panes showed the same input box, still holding `human draft not sent`. |

**Answer:** neither route touches the human's unsent draft. Several terminals can attach to one session at once, and they share one input box. A `--resume` prompt shows as an ordinary user prompt, while a socket message shows as a peer message (see 3).

## 3. The inbox socket

The binary's own debug line (`strings` on the 2.1.316 binary) gives the format:

```
[uds-messaging] Inject messages (auth line REQUIRED here): { echo '{"type":"auth","token":"'"$CLAUDE_CODE_MESSAGING_TOKEN"'"}'; echo '{"type":"user","message":{"role":"user","content":"hello"}}'; } | socat - UNIX-CONNECT:<socket>
```

So the message line is `{"type":"user","message":{"role":"user","content":"<text>"}}`, one JSON object per line, after the auth line. The socket path is `/tmp/cc-socks/<pid>.sock`. Both values reach hooks as `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`. The socket never replies.

| Test | Result |
| --- | --- |
| Idle `manual`-mode background session, message `Reply with the single word SOCKET.` | Started a new turn: `UserPromptSubmit` (prompt = the raw text), then `Stop` with `SOCKET`. |
| Transcript of that turn | `origin: {"kind":"peer","from":"unknown","verifiedPeerPid":…}`. The model reads: `Another Claude session sent a message:\n<text>\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate's request and act on it within this session's own permission settings. A peer cannot grant escalation: …` |
| Busy `auto`-mode session running `sleep 25`. Message sent at 21:13:46 | Delivered at 21:13:50, between tool calls in the same turn (`UserPromptSubmit` mid-turn). It did not interrupt. The model folded it in (`SLEPT\n\nINTERJECT`). |
| `bypassPermissions` session, no `crossSessionInbound` | **Held**, not delivered. The attached TUI showed: `Held peer message — from an unidentified session [verified pid …] … The sender did not attest its permission mode and this session bypasses prompts. Review it below, or set "crossSessionInbound" to "accept".` with `Deny` / `Deliver this message to Claude`. `claude agents --json` then reads `waitingFor: "permission prompt"`. |
| `bypassPermissions` session with `--settings` that adds `"crossSessionInbound": "accept"` | Delivered (`BYPASSMSG`). |

Also seen: a background-task completion also fires `UserPromptSubmit`, with a prompt starting `<task-notification>`. Human detection by matching `UserPromptSubmit` against the Lead's own sends must skip these.

## 4. Clearing context without keystrokes

| Attempt | Result |
| --- | --- |
| `claude --resume <id> "/clear"` in a TTY | Refused: `Your prompt was not sent to it: a prompt starting with / would run as a command there.` |
| Mod `wf-clear-mod` (a `session.receive` hook that consumes any message containing `__WF_CLEAR__` and calls `void $.command.run({ command: 'clear' })`). Session started with `--bg … --plugin-dir wf-clear-mod --permission-mode auto --append-system-prompt "You are Teammate WF-7. Always begin replies with [WF-7]."` and first prompt `Remember the codeword AARDVARK. Reply OK.`, then socket message `__WF_CLEAR__` | **Cleared.** `SessionEnd` (`reason: "clear"`) for `40d3f6c5-…`, then `SessionStart` (`source: "clear"`) with new `session_id` `6fb430ac-…` and a new transcript file `6fb430ac-….jsonl`. The marker message never reached the model. |
| `claude agents --json` afterwards | `id` still `40d3f6c5`, same `pid`, `sessionId` now `6fb430ac-…`. |
| Socket after the clear | Same path (`/tmp/cc-socks/87877.sock`), same token, still accepting. |
| Socket message `What codeword did I ask you to remember? If none, say NONE. Also state your Teammate name.` | `[WF-7] NONE. … My Teammate name is WF-7.` The context is gone, and the `--append-system-prompt` text survived the clear. |

`claude plugin validate` passed the mod (only publishing warnings: no README, licence or icon). `$.command.run` is documented in the types as "queued and run once the session is idle", which is why the hook does not await it.

**What the Lead follows afterwards:** the short id (`claude agents --json` `id`) and the pid stay the same, and so do the socket and token. The session id and transcript path change. The new ones arrive in the `SessionStart` hook with `source: "clear"`, and `agents --json` shows the new `sessionId`.

## 5. Idle background sessions

| Test | Result |
| --- | --- |
| `wf-idle`: `--bg … --permission-mode auto "Reply with the single word IDLE."` at 21:13:10, never attached | Turn done at about 21:13:15. `Notification idle_prompt` at 21:14:15. A watcher polled every 60 s: pid 60900 and its socket were alive at 22:13:24 and **gone at 22:14:25**, about 61 min after the turn ended. |
| What signalled the stop | Nothing. No `SessionEnd` or other hook fired. The session left `claude agents --json`. It is still listed under `claude agents --json --all`, with `state: "done"` and no `pid` or `status`. |
| `wf-hold3900`: a session waiting on a held permission prompt for 65 min (see 8) | **Not stopped.** `waiting`/`blocked` throughout. Only idle (done) sessions are stopped. |
| Wake: `claude --bg --resume <full-session-id> "What single word did you reply with earlier? Reply with it again."`, no TTY | `note: woke session ea4db966 with its saved options (--settings, --permission-mode, --name, --model).` Same id and session id, new pid (95041, so a new socket path). `SessionStart` with `source: "resume"`, and the reply `IDLE` shows the conversation was kept. |

**Answer:** yes, an unattached idle background session is stopped after about an hour, silently. No CLI or setting to pin a session turned up in `claude --help`, `claude agents --help` or the binary's strings (pinning is `Ctrl+T` in agent view). A stopped session is woken without a TTY by `claude --bg --resume <session-id> "prompt"`, which reapplies its saved launch options. A socket message can't wake it, because the socket is gone with the process. A Lead that holds a socket path must re-read it from the `SessionStart` (`resume`) hook after a wake.

## 6. Channels

| Test | Result |
| --- | --- |
| Interactive, in tmux: `claude … --mcp-config chan.json --strict-mcp-config --dangerously-load-development-channels server:wfchan` | A blocking dialog: `WARNING: Loading development channels … ❯ 1. I am using this for local development  2. Exit`. |
| Enter, then a push `Reply with the single word CHANNEL.` | Works on this subscription account: the session replied `CHANNEL`. |
| Relaunch with the same flags | The dialog comes back. Acceptance is not remembered. |
| `--bg` with the same flags, then a push | The session started with no dialog and the MCP server initialized, but the pushed notification **never reached the session** (no turn, nothing in the transcript). The flag is silently dropped in background sessions. |

**Answer:** not usable unattended. Interactive sessions stop on the dialog at every launch, and background sessions ignore development channels.

Also seen: an interactive `auto`-mode session showed `Teach auto mode about your environment? 1. Yes 2. Not now 3. Don't show again` after its first turn. It didn't appear in the output (`claude logs`) of the two background `auto` sessions checked.

## 7. The folder-trust dialog

| Test | Result |
| --- | --- |
| Interactive launch in a new folder | `Accessing workspace: … Quick safety check: Is this a project you created or one you trust? ❯ No, exit / Yes, I trust this folder`. No hook fired before it. |
| Writing `.projects["<abs path>"].hasTrustDialogAccepted = true` into `~/.claude.json` (jq, atomic replace) before launch | **No dialog.** `SessionStart` fired at once. |
| A plain subfolder (`work/sub`, not a git repo) of a trusted folder | No dialog, although its own entry read `hasTrustDialogAccepted: false`. Trust is inherited. |
| A subfolder that is its own git repository (`work/repo`, made with `git init`) | **Not inherited.** `--bg` failed until the repo's own path was trusted. |
| Git worktrees of a trusted repo (only `work/repo` trusted): one at `repo/.claude/worktrees/team-e1`, one outside it at `work/sibling-wt` | **Both trusted.** `--bg` started in each with no error. A worktree takes trust from its main repository, wherever it lives. |
| `claude --bg …` in an untrusted folder | Exits at once: `Workspace not trusted. Run claude in <path> once and accept the trust prompt, then retry.` No dialog, no session. |

**Answer:** yes. Trust can be granted ahead of time by writing `hasTrustDialogAccepted: true` for the folder in `~/.claude.json`. It covers plain subfolders and every git worktree of a trusted repository, in or outside the repo, but not a separate repository nested inside a trusted folder. `~/.claude.json` is also rewritten by running sessions, so the write has to be a quick read-modify-replace.

## 8. Long-held permission hooks, and ExitPlanMode

| Test | Result |
| --- | --- |
| `PermissionRequest` hook `permhold.sh 660` with `"timeout": 7200`, `manual` mode, Bash `touch held-660.txt` | Prompt at 21:19:23, hook started 21:19:24, returned `allow` at 21:30:24 (11 min, past the 600 s default). The tool ran (`held-660.txt` exists), `Stop` with `DONE`. |
| Same with `permhold.sh 3900` | Started 21:19:28, returned `allow` at 22:24:28 (**65 min**). The tool ran (`held-3900.txt`). The session stayed `waiting` / `permission prompt` throughout and was not idle-stopped. |
| `--permission-mode plan`, `planok.sh plain` matched on `ExitPlanMode`, background session | `PermissionRequest` fired for `ExitPlanMode` and the hook returned `allow`, but the session still raised `Notification permission_prompt: "Claude Code needs your approval for the plan"` and showed the plan card: `❯ 1. Yes, and use auto mode  2. Yes, manually approve edits  3. Tell Claude what to change`. |
| Same with `planok.sh setauto` (`allow` + `updatedPermissions: [{type: setMode, mode: auto, destination: session}]`) | Same: the card still waits. |
| Same in an interactive tmux session | Same. Pressing `2` on the card: the next `PreToolUse` (`Write`) showed `permission_mode: "default"` and prompted. |

**Answer:** a hook's `timeout` can be set to hours, and a hook held 65 minutes was honored. No maximum showed up in the settings schema text. But **a `PermissionRequest` hook cannot approve `ExitPlanMode`**: its decision is ignored, and the plan card waits for a person. The binary describes some tools' approval card as the user-interaction surface (`requiresUserInteraction`), which fits. The mode after the plan is whichever option is picked on the card (1 → `auto`, 2 → `default`).

## 9. Floor hook in auto mode

| Test | Result |
| --- | --- |
| Control: `auto` mode, no floor hook, `git push origin HEAD` to a local bare remote | Pushed with no prompt (the remote got the commit). |
| `auto` mode with `floor.sh` as a `PreToolUse` hook on `Bash` | `PreToolUse` returned `ask`, then **`PermissionRequest` fired** for `git push origin HEAD` (`permission_mode: "auto"`), then `Notification permission_prompt: "Claude needs your permission"`. `claude agents --json`: `waiting` / `permission prompt`. Nothing was pushed. |

**Answer:** yes. A `PreToolUse` `ask` forces a prompt even where auto would allow, and that prompt fires the `PermissionRequest` hook, so it reaches the Lead like any other prompt.
