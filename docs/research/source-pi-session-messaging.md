# Peer session messaging in pi (primary sources)

Question: can several interactive pi sessions, each with a name, send messages to one another
("alice" → "bob"; bob's agent receives it and can reply)? What does pi 0.84.3 already provide,
and what has to be built?

Sources are the installed package `node_modules/@earendil-works/pi-coding-agent` at version
`0.84.3` [package.json:3] [CHANGELOG.md:5]. Paths below are relative to that directory unless
they start with `extensions/` or `docs/adr/` (this repo) or `nested:` (the package's own
`node_modules/@earendil-works/`, where `pi-client` and `pi-protocol` live). Line numbers refer to
the shipped `docs/*.md`, `dist/**/*.d.ts` and `dist/**/*.js` files.

## Recommendation

Build it as **one user-global extension plus a per-machine mailbox under `~/.pi/agent/`**, and
nothing else. Pi already has every *in-process* half of the feature:

- a session name (`--name`, `/name`, `pi.setSessionName`), a session id, a session file path,
  and a cwd, all readable from an extension [docs/sessions.md:13-28] [dist/core/extensions/types.d.ts:216-219, 969-972];
- `pi.sendMessage(msg, { triggerTurn, deliverAs })`, which appends a custom message to the
  conversation and either starts a turn (idle) or queues it as steer/follow-up (streaming)
  [dist/core/agent-session.js:1071-1101];
- a documented, supported pattern of starting a background listener in `session_start` and
  closing it in `session_shutdown` [docs/extensions.md:220-224] [examples/extensions/file-trigger.ts:15-40];
- slash commands, model-callable tools, and `notify`/`setStatus`/`setWidget` for the human
  [dist/core/extensions/types.d.ts:68-100, 926-929].

What pi does **not** have is any cross-process channel between two interactive sessions.
`pi.events` is an in-process bus [dist/core/extensions/loader.js:504], RPC mode is a
stdin/stdout protocol for a child the caller spawns [docs/rpc.md:3, 22-24], and the new
socket protocol (`pi-client`/`pi-protocol`) ships **client-side only** in 0.84.3: the CLI
parser for `pi --listen unix:…` / `pi server` / `pi client --connect` exists in `dist/cli/experimental/`
but nothing in the shipped entrypoints or bundle calls it [dist/cli/experimental/commands/pi.d.ts:5-10]
[verified: no `runServer`/`experimentalCli`/`--listen`/`createUnixTransportFactory`/`PROTOCOL_VERSION`
hit in `dist/main.js`, `dist/cli.js`, `dist/bun/cli.js`, `dist/bundle/*.js`, `dist/bundle/chunks/*.js`].

So the transport has to be built: a Unix socket (or file mailbox) per session under
`getAgentDir()`, plus a registry file mapping name → `{ pid, socket, sessionId, sessionFile, cwd }`.
Everything on either side of that socket is existing pi API.

## 1. Session identity

**Name.** Set at startup with `--name <name>` / `-n` or later with `/name <name>`
[docs/usage.md:205] [docs/sessions.md:52-65]. At startup `main.js` normalizes the flag and calls
`sessionManager.appendSessionInfo(name)` [dist/main.js:548-554]. The name lives in the session
file as a `session_info` entry:

```ts
export interface SessionInfoEntry extends SessionEntryBase {
    type: "session_info";
    name?: string;
}
```
[dist/core/session-manager.d.ts:80-84] [docs/session-format.md:296-304]

An extension reads and writes it with `pi.getSessionName()` / `pi.setSessionName(name)`
[dist/core/extensions/types.d.ts:969-972] [docs/extensions.md:1471-1488]. Setting it emits
`session_info_changed { name }` to extensions [dist/core/agent-session.js:2376-2381]
[dist/core/extensions/types.d.ts:423-428]; the TUI reacts by updating the footer and terminal
title [dist/modes/interactive/interactive-mode.js:2597-2601, 786-788]. Names are normalized and
the TUI warns if the stored name differs from what was typed
[dist/modes/interactive/interactive-mode.js:5147-5152]. Nothing enforces uniqueness: a name is
free text on a `SessionInfo` record [dist/core/session-manager.d.ts:125-131].

**Id, file, cwd, dir.** `ctx.sessionManager` is a `ReadonlySessionManager` exposing
`getCwd | getSessionDir | getSessionId | getSessionFile | getLeafId | … | getSessionName`
[dist/core/extensions/types.d.ts:218-219] [dist/core/session-manager.d.ts:140]. The id is the
UUID in the session header (`{type:"session", id, timestamp, cwd, parentSession?}`)
[dist/core/session-manager.d.ts:5-12]; the file is
`~/.pi/agent/sessions/--<cwd-with-dashes>--/<timestamp>_<uuid>.jsonl` [docs/session-format.md:8-11],
`undefined` under `--no-session` [dist/core/session-manager.d.ts:208]. `ctx.cwd` is on every
context [dist/core/extensions/types.d.ts:216-217]. `/session` prints name, file and id
[dist/modes/interactive/interactive-mode.js:5155-5169]. There is no pid in the API; use Node's
`process.pid` (extensions have Node built-ins) [docs/extensions.md:152].

**Other sessions on disk.** `SessionManager.list(cwd)` / `listAll()` return `SessionInfo`
records with `path, id, cwd, name?, created, modified, …` for every session file
[dist/core/session-manager.d.ts:125-139, 343-354]. That is an inventory of *files*, not of
*running processes*: nothing records liveness.

**Session id for child processes.** The `bash` tool injects `PI_SESSION_ID` and
`PI_SESSION_FILE` into commands the model runs [docs/environment-variables.md:22-30]; they are not
injected into the user's `!` commands [docs/environment-variables.md:49].

## 2. Injecting messages into a running interactive session

Signature on `ExtensionAPI`:

```ts
sendMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">, options?: {
    triggerTurn?: boolean;
    deliverAs?: "steer" | "followUp" | "nextTurn";
}): void;
sendUserMessage(content: string | (TextContent | ImageContent)[], options?: {
    deliverAs?: "steer" | "followUp";
    expandPromptTemplates?: boolean;
}): void;
```
[dist/core/extensions/types.d.ts:953-966]

`CustomMessage` is `{ role:"custom", customType, content: string | (Text|Image)[], display, details?, timestamp }`
[docs/session-format.md:137-144]. It is persisted as a `custom_message` entry that **does**
participate in LLM context, converted to a user message; `details` is not sent to the LLM;
`display:false` hides it from the TUI [dist/core/session-manager.d.ts:85-103].

The implementation decides by state [dist/core/agent-session.js:1071-1101]:

```js
if (options?.deliverAs === "nextTurn") {
    this._pendingNextTurnMessages.push(appMessage);
}
else if (this.isStreaming && options?.triggerTurn !== false) {
    if (options?.deliverAs === "followUp") { this.agent.followUp(appMessage); }
    else { this.agent.steer(appMessage); }
}
else if (options?.triggerTurn) {
    await this._runAgentPrompt(appMessage);
}
else {
    this.agent.state.messages.push(appMessage);
    this.sessionManager.appendCustomMessageEntry(...);
    this._emit({ type: "message_start", message: appMessage });
    this._emit({ type: "message_end", message: appMessage });
}
```

So:

- **Idle + `triggerTurn: true`** — the message is appended and an LLM turn starts immediately
  [dist/core/agent-session.js:1092-1093].
- **Idle, no trigger** — appended to state and file, rendered, no turn; the model sees it on
  the next user prompt [dist/core/agent-session.js:1095-1100].
- **Streaming** — `"steer"` (default) is delivered after the current assistant turn finishes
  its tool calls, before the next LLM call; `"followUp"` only when the agent has no more tool
  calls [docs/extensions.md:1415-1420]. Note the guard is `triggerTurn !== false`: an explicit
  `triggerTurn: false` while streaming skips the queue and pushes straight into
  `agent.state.messages` [dist/core/agent-session.js:1084, 1095-1096].
- **`"nextTurn"`** — held in `_pendingNextTurnMessages` and injected alongside the next user
  prompt [dist/core/agent-session.js:1081-1082, 882-886]; `triggerTurn` is ignored [docs/extensions.md:1420].

The queues are real: `queue_update { steering, followUp }` events fire on change
[dist/core/agent-session.d.ts:49-51], `steeringMode`/`followUpMode` (`"all"` | `"one-at-a-time"`,
default one-at-a-time) control drain rate [docs/settings.md:171-172] [docs/rpc.md:346-348, 363-365],
and `ctx.isIdle()` / `ctx.hasPendingMessages()` are readable from any handler
[dist/core/extensions/types.d.ts:231-232, 239-240]. Errors thrown inside `sendCustomMessage` surface
as an extension error with event `"send_message"` rather than to the caller
[dist/core/agent-session.js:1935-1943].

`sendUserMessage` always triggers a turn and **throws** if streaming without `deliverAs`
[docs/extensions.md:1444-1450]; it goes through `prompt()` with `source: "extension"`
[dist/core/agent-session.js:1136-1137], so other extensions' `input` handlers see it with
`event.source === "extension"` [dist/core/extensions/types.d.ts:639-652] [docs/extensions.md:908, 924].

**Rendering.** `pi.registerMessageRenderer(customType, (message, {expanded, outputPad}, theme) => Component)`
[dist/core/extensions/types.d.ts:947-948] [docs/extensions.md:2834-2845]; the TUI uses it only when
`message.display` is true [dist/modes/interactive/interactive-mode.js:2925-2932]. For TUI-only
notes that must not reach the model use `pi.appendEntry` + `pi.registerEntryRenderer`
[docs/extensions.md:1453-1469, 1600-1618].

This repo's `subagents` extension already uses exactly this: `triggerTurn: true, deliverAs: "steer"`
for results, `triggerTurn: false` at shutdown [extensions/subagents/index.ts:368-372, 410, 538]
[docs/adr/0002-async-spawn-with-explicit-join.md:12-16].

## 3. Extension lifecycle and long-lived listeners

Event names are the `pi.on` overloads: `project_trust, resources_discover, session_start,
session_info_changed, session_before_switch, session_before_fork, session_before_compact,
session_compact, session_compact_failed, session_shutdown, session_before_tree, session_tree,
context, before_provider_request, before_provider_headers, after_provider_response,
before_agent_start, agent_start, agent_end, agent_settled, turn_start, turn_end, message_start,
message_update, message_end, tool_execution_start/update/end, model_select,
thinking_level_select, tool_call, tool_result, user_bash, input`
[dist/core/extensions/types.d.ts:892-925]; the ordering diagram is at [docs/extensions.md:277-349].
`agent_settled` (not `agent_end`) is the "nothing more will run automatically" signal
[docs/extensions.md:567-569].

Background listeners are explicitly supported, with two rules:

> Extension factories may run in invocations that never start a session. Do not start
> background resources such as processes, sockets, file watchers, or timers from the factory.
> Defer background resource startup until `session_start` … Register an idempotent
> `session_shutdown` handler to close any session-scoped resources you start.
[docs/extensions.md:220-224]

The bundled `file-trigger.ts` does precisely this — `fs.watch` inside `session_start`, then
`pi.sendMessage(..., { triggerTurn: true })` from the watcher callback
[examples/extensions/file-trigger.ts:15-40]. The extension is torn down (`session_shutdown`)
on quit, Ctrl+C/D, SIGHUP/SIGTERM, `/reload`, `/new`, `/resume`, `/fork`, `/clone`
[docs/extensions.md:316-326, 347-348, 1299-1306]; `reason` is
`"quit" | "reload" | "new" | "resume" | "fork"` [dist/core/extensions/types.d.ts:477-483]. After
replacement the old runtime is invalidated: captured `pi`/`ctx` objects throw, and every
`pi.events` subscription is unsubscribed [dist/core/extensions/loader.js:167-176, 366-373]
[docs/extensions.md:1247-1252]. A socket server therefore has to be (re)created in every
`session_start`, closed in every `session_shutdown`, and the `ctx` used to call `ui.*` must be
the one captured from the latest `session_start` (the `event-bus.ts` example does this)
[examples/extensions/event-bus.ts:14-18]. `ctx.signal` is `undefined` outside a turn, so a
socket callback cannot rely on it [docs/extensions.md:1001-1011]. Extension errors are logged and
the agent continues [docs/extensions.md:2903].

Extensions also load in `-p`, `--mode json` and `--mode rpc`; `ctx.hasUI` is false in print/json
[docs/extensions.md:2908-2916], so a peer listener should be gated on mode or a flag.

## 4. Cross-process primitives in pi itself

**RPC mode.** `pi --mode rpc` speaks strict LF JSONL on stdin/stdout [docs/rpc.md:10, 22-37].
Commands include `prompt` (with `streamingBehavior`), `steer`, `follow_up`, `abort`,
`get_state` (returns `sessionFile, sessionId, sessionName, isStreaming, pendingMessageCount`),
`set_session_name`, `get_entries { since }`, `get_commands`
[docs/rpc.md:43-122, 162-193, 694-722, 772-789] [dist/modes/rpc/rpc-types.d.ts:14-133, 145-158].
Extension `notify/setStatus/setWidget` become `extension_ui_request` lines to the client
[docs/rpc.md:1161-1182]. The exported `RpcClient` **spawns** that child (`cliPath, cwd, env, args`;
`start()`/`stop()`) and offers `prompt/steer/followUp/setSessionName/waitForIdle`
[dist/modes/rpc/rpc-client.d.ts:14-27, 44-52, 66-74, 219, 232] [dist/index.d.ts:27]. There is no
way to point it at an already-running interactive pi: it owns the process's stdio. That is why
this repo uses it only for parent→child ([docs/adr/0001-rpc-child-processes-for-subagents.md:3-8]).

**`pi.events`.** `{ emit(channel, data); on(channel, handler) => unsubscribe }`
[dist/core/event-bus.d.ts:1-8], documented as "communication between extensions"
[docs/extensions.md:1710-1717]. One bus is created per extension load inside the process
[dist/core/extensions/loader.js:504]; the SDK lets an *embedding app* pass a shared bus
[docs/sdk.md:658-670]. It does not cross processes.

**Experimental remote protocol (client only).** 0.84.x added "the transport-neutral `PiClient`,
CBOR protocol, Unix-socket transport, and `@earendil-works/pi-coding-agent/client` `RemoteSession`
controller" [CHANGELOG.md:261]; `./client` is in the export map [package.json:24-27]. The pieces:

```ts
export declare function createUnixTransportFactory(options: { path: string; maxPendingBytes?: number }): ByteTransportFactory;
```
[nested:pi-client/dist/unix.d.ts:1-7]

```ts
export declare class PiClient {
    static connect(options: PiClientOptions): Promise<PiClient>;
    listSessions(): Promise<readonly SessionMetadata[]>;
    createSession(options?: CreateSessionOptions): Promise<PiSessionHandle>;   // { cwd?, name?, model?, thinkingLevel? }
    attachSession(sessionId: string): Promise<PiSessionHandle>;
    acquireSession(sessionId: string, options: { mode: "shared" | "exclusive" }): Promise<PiSessionHandle>;
}
export interface SessionLease {
    prompt(text: string): Promise<SessionSnapshot>;
    steer(text: string): Promise<SessionSnapshot>;
    abort(): Promise<SessionSnapshot>; setModel(...); setThinking(...);
}
```
[nested:pi-client/dist/client.d.ts:4-24] [nested:pi-client/dist/types.d.ts:16-21]
[nested:pi-client/dist/session-handle.d.ts:10-24]

`SessionMetadata` carries `sessionName` and `cwd` when the store supports them
[nested:pi-protocol/README.md:12]; the wire format is `[uint32-be length][CBOR]` with a `hello`
handshake and "no compatibility guarantees" [nested:pi-protocol/README.md:5-10, 69].

The **server** half is absent from this release. `dist/cli/experimental/` defines a parser for
`pi [--listen unix:<path>]`, `pi server --listen …`, `pi client --connect …` with a
`runPi/runServer/runClient` context [dist/cli/experimental/cli.d.ts:1-5]
[dist/cli/experimental/commands/pi.d.ts:5-14] [dist/cli/experimental/commands/server.d.ts:4-12]
[dist/cli/experimental/commands/client.d.ts:4-12] [dist/cli/experimental/transport-address.d.ts:1-9],
but no shipped file invokes it (see the grep in the Recommendation). `dist/server/create-harness.js`
only assembles a pi-agent-core `AgentHarness` with the four coding tools
[dist/server/create-harness.d.ts:22-25] [dist/server/create-harness.js:1, 37] and has no importer.
`PI_EXPERIMENTAL=1` [dist/core/experimental.js:3] is consulted by the footer and startup UI, not
by any server [callers: dist/modes/interactive/components/footer.js, dist/cli/startup-ui.js,
dist/core/index.js]. The docs never mention `--listen`, `pi server` or `pi client`
[grep of docs/*.md: only docs/settings.md:60 mentions `PI_EXPERIMENTAL`, for first-time setup].
The only `createServer(` occurrences in the bundle are in provider chunks
(`dist/bundle/chunks/anthropic.js`, `openai-codex.js`, `chunk-GPPBJGBU.js`), not a session server.

**Nothing like Claude Code's agent teams.** Pi "intentionally does not include built-in MCP,
sub-agents, permission popups, plan mode, to-dos, or background bash" [docs/usage.md:308]; the
bundled `subagent/` example spawns via `exec` [docs/extensions.md:2984]. There is no
`SendMessage`/`ListAgents` equivalent.

## 5. Commands and tools

**Slash command.**

```ts
registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
export interface RegisteredCommand {
    name: string; sourceInfo: SourceInfo; description?: string;
    getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<...>;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}
```
[dist/core/extensions/types.d.ts:876-882, 928-929]

`/msg bob hello` arrives as `args === "bob hello"`; the handler returns nothing, so output reaches
the TUI only via `ctx.ui.notify` or `pi.sendMessage` [docs/extensions.md:1513-1521]. Extension
commands are checked before the `input` event and run immediately even while streaming
[docs/extensions.md:287, 897-899] [dist/core/agent-session.d.ts:354-356]; the same holds when an RPC
client sends `/msg …` as a `prompt` [docs/rpc.md:67]. Command handlers get
`ExtensionCommandContext` (`waitForIdle`, `newSession`, `switchSession`, `reload`)
[dist/core/extensions/types.d.ts:254-291]. Argument completion can list peer names
[docs/extensions.md:1523-1540].

**Model-callable tool.**

```ts
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
    name: string; label: string; description: string;
    promptSnippet?: string; promptGuidelines?: string[];
    parameters: TParams;                       // TypeBox
    execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined,
            onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionContext): Promise<AgentToolResult<TDetails>>;
    renderCall?: (...) => Component; renderResult?: (...) => Component;
}
```
[dist/core/extensions/types.d.ts:344-377]

`content` goes to the LLM, `details` is for rendering/state [docs/extensions.md:1978-1982];
throw to signal an error [docs/extensions.md:1996-1997]; use `StringEnum` from `pi-ai` for enums
[docs/extensions.md:2011]; `promptSnippet` puts the tool in the system prompt's tool list
[docs/extensions.md:1898]. `registerTool` also works after startup [docs/extensions.md:1351-1352].
Tools receive `ExtensionContext`, not the command context [docs/extensions.md:1309-1310].
`--tools <list>` is a strict allowlist that filters extension tools too [docs/usage.md:211], so
`send_message`/`list_sessions` must be named there when that flag is used.

## 6. UI for the human

`ExtensionUIContext` on `ctx.ui`:

```ts
notify(message: string, type?: "info" | "warning" | "error"): void;
setStatus(key: string, text: string | undefined): void;
setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
setWidget(key: string, content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined, ...): void;
setTitle(title: string): void;
custom<T>(factory: (tui, theme, keybindings, done) => Component, options?: { overlay?: boolean; ... }): Promise<T>;
```
[dist/core/extensions/types.d.ts:76, 80, 97-100, 115, 117-127]

In the TUI, `notify` maps info → status line, warning → warning row, error → error row
[dist/modes/interactive/interactive-mode.js:1914, 2151-2160]; `setStatus` and `setWidget` go to
the footer and to the widget slot above/below the editor
[dist/modes/interactive/interactive-mode.js:1916, 1926] [docs/extensions.md:2568-2598]. Guard with
`ctx.hasUI` (true in TUI and RPC, false in print/json) [docs/extensions.md:954-956]; in RPC mode
only the string-array widget form is forwarded [docs/rpc.md:1301]. This repo's `subagents` widget
follows the same `hasUI`-guarded pattern [extensions/subagents/index.ts:551-556].

## 7. Where to keep a registry

There is no per-extension data-dir API. The pieces available:

- `getAgentDir()` → `~/.pi/agent` (overridable with `PI_CODING_AGENT_DIR`) is exported from the
  root [dist/index.d.ts:2] [dist/config.d.ts:76-77] [docs/environment-variables.md:81-82]. The
  other helpers in `config.d.ts` (`getSessionsDir`, `getSettingsPath`, …) [dist/config.d.ts:84-93]
  are **not** re-exported, and the `exports` map (`.`, `./rpc-entry`, `./client`) blocks deep
  imports [package.json:17-27].
- `CONFIG_DIR_NAME` for project-local `.pi/…` paths [docs/extensions.md:958-973].
- `pi.appendEntry(customType, data)` for state that belongs *in the session file*
  [docs/extensions.md:1453-1469].
- `pi.registerFlag("peer-name", { type: "string" })` / `pi.getFlag` for a startup name
  [dist/core/extensions/types.d.ts:935-946].
- Settings files: `~/.pi/agent/settings.json` and `.pi/settings.json` [docs/settings.md:5-8].

So a registry such as `~/.pi/agent/peers/<name>.json` and sockets under `~/.pi/agent/peers/`
(or `$TMPDIR`) is the extension's own convention. Project-local extensions load only after the
project is trusted [docs/extensions.md:113], so the peer extension should be user-global
(`~/.pi/agent/extensions/`) or listed in `~/.pi/agent/settings.json` [docs/extensions.md:115-135].

## 8. SDK: attaching to another session's transcript

`SessionManager.open(path)` reads any session file, and `parseSessionEntries`, `getEntries`,
`getBranch`, `buildContextEntries` are public [dist/core/session-manager.d.ts:144-145, 261-281, 319-325]
[dist/index.d.ts:19]; the file is append-only JSONL [docs/session-format.md:3]. That gives a
*read-only* view of a peer's transcript (poll or `fs.watch` the file). Two things it does not
give:

- **Injection.** Appending to another process's file does not reach that process: its
  `SessionManager` keeps a private in-memory index (`fileEntries`, `byId`, `leafId`)
  [dist/core/session-manager.d.ts:190-195] and nothing in the docs describes multi-writer or
  reload-on-change behaviour. Only the owning process's `sendCustomMessage` updates both state and
  file [dist/core/agent-session.js:1095-1098].
- **Attachment.** `createAgentSession({ sessionManager: SessionManager.open(...) })` creates a
  *second agent* over that transcript in the caller's process [docs/sdk.md:786-789]; it is not a
  handle to the running TUI. `ctx.switchSession(path)` replaces the *current* session
  [docs/extensions.md:1200-1216]. RPC `get_entries { since }` is a cursor into an RPC child
  [docs/rpc.md:694-722].

## What the feature needs, mapped

| Need | Pi provides | Build |
|---|---|---|
| Name a session | `--name`, `/name`, `pi.setSessionName`, `session_info_changed` [docs/sessions.md:52-65] | uniqueness check against the registry |
| Find live peers | `SessionManager.listAll()` (files only) [dist/core/session-manager.d.ts:353-354] | registry file + pid liveness (`process.kill(pid, 0)`) |
| Send | — | client: connect to peer socket / write mailbox |
| Receive | `session_start` listener pattern [docs/extensions.md:220-224] | server: `net.createServer` on a unix socket (or `fs.watch` on a mailbox) |
| Deliver to the agent | `pi.sendMessage({customType:"peer-msg", …}, {triggerTurn:true, deliverAs:"steer"})` [dist/core/agent-session.js:1071-1101] | choose `nextTurn` vs `triggerTurn` policy |
| Show the human | `ctx.ui.notify`, `setStatus`, `setWidget`, `registerMessageRenderer` [dist/core/extensions/types.d.ts:76-100, 947] | — |
| Let the model reply | `registerTool("send_message")`, `registerTool("list_sessions")` [dist/core/extensions/types.d.ts:927] | — |
| Human shortcut | `registerCommand("msg")` with completions [dist/core/extensions/types.d.ts:928-929] | — |
| Cleanup | `session_shutdown` (all reasons) [dist/core/extensions/types.d.ts:477-483] | unlink socket, drop registry entry; tolerate SIGKILL leftovers |

## Gaps and open questions

1. **No cross-process bus.** `pi.events` is per-process [dist/core/extensions/loader.js:504]; the
   socket protocol has no shipped server in 0.84.3 (Section 4). Building a `pi-protocol` server
   inside an extension would mean implementing the `ServerMessage`/`Command` schemas
   [nested:pi-protocol/dist/schemas.d.ts:1819-1820, 13734-13738] behind an "experimental, no
   compatibility guarantees" protocol [nested:pi-protocol/README.md:69] — far more than a
   private JSONL-over-unix-socket between two copies of the same extension. Whether a future pi
   release wires `pi --listen` is unknown from these sources.
2. **No liveness or uniqueness.** Session names are free text [dist/core/session-manager.d.ts:130-131];
   nothing records pids. Stale registry entries after a crash must be detected by the extension.
3. **Delivery policy is a design choice.** `triggerTurn: true` while idle starts a turn even if
   the human is mid-thought [dist/core/agent-session.js:1092-1093]; `nextTurn` waits for the human's
   next prompt [dist/core/agent-session.js:1081-1082, 882-886]; `steer` vs `followUp` while
   streaming differ in when they land [docs/extensions.md:1415-1418]. The subagents extension chose
   `triggerTurn + steer` [docs/adr/0002-async-spawn-with-explicit-join.md:12-16]; a peer message
   from a human-driven session may warrant `nextTurn` plus a `notify`.
4. **Explicit `triggerTurn: false` while streaming bypasses the queue** and mutates
   `agent.state.messages` mid-run [dist/core/agent-session.js:1084, 1095-1096]. Avoid that combination;
   omit `triggerTurn` (default steer) or use `nextTurn`.
5. **Runtime replacement.** Every `/new`, `/resume`, `/fork`, `/reload` invalidates captured
   `pi`/`ctx` and unsubscribes `pi.events` [dist/core/extensions/loader.js:167-176]; the listener
   must be rebuilt per `session_start` and the registry entry rewritten with the new session id
   and file. `session_shutdown` also fires for `reload` [dist/core/extensions/types.d.ts:480].
6. **Modes.** The extension loads in `-p`/json/rpc as well [docs/extensions.md:2908-2916]; a
   headless run should probably not register as a peer, or should register without UI calls
   (`hasUI` guard).
7. **What the receiving model sees.** A custom message is converted to a *user* message in
   context [dist/core/session-manager.d.ts:89-91]; the sender's identity therefore has to be in
   `content` (e.g. `[from alice] …`), since `details` is not sent [dist/core/session-manager.d.ts:91].
8. **No API for the extension's own data directory** or for `getSessionsDir()` from the root
   export [dist/index.d.ts:2] [package.json:17-27]; derive paths from `getAgentDir()`.
9. **Replies while the sender is busy.** If alice is streaming when bob's reply arrives, alice's
   extension can only queue it (`steer`/`followUp`); there is no "interrupt now" short of
   `ctx.abort()` [dist/core/extensions/types.d.ts:237-238]. Whether a reply should abort is a policy
   question these sources do not answer.
10. **`pi-tui`** is only needed for custom renderers (`Text`, `Box`) [docs/extensions.md:2832-2845];
    nothing in it concerns IPC.
