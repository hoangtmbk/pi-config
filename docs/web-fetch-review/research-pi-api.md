# pi 0.84.3 extension API research for a `web_fetch` tool

Local package root (referred to as `$P` below):
`/Users/hoangta/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent`

Upstream: https://github.com/badlogic/pi-mono (packages/coding-agent). Note the docs now link to
`earendil-works/pi-mono` for source files (e.g. `.../blob/main/packages/coding-agent/src/core/tools/read.ts`);
raw fetches from `raw.githubusercontent.com/badlogic/pi-mono/main/...` still work.

Key local files:
- `$P/docs/extensions.md` (3002 lines; sections: Custom Tools @1893, Output Truncation @2150, Custom Rendering @2220, ctx @942, events @273)
- `$P/docs/packages.md`, `$P/docs/json.md`, `$P/docs/settings.md`, `$P/docs/skills.md`, `$P/docs/compaction.md`, `$P/docs/tui.md`, `$P/docs/themes.md`
- `$P/dist/core/extensions/types.d.ts` (all extension types), `$P/dist/core/extensions/loader.js` (jiti aliases, discovery)
- `$P/dist/core/tools/{read,bash,grep,truncate,output-accumulator}.js` (built-in tool patterns)
- `$P/dist/core/system-prompt.js` (how tools/guidelines appear in the system prompt)
- `$P/examples/extensions/README.md` and `$P/examples/extensions/*.ts`
- Note: the local install's `examples/extensions/` is missing `truncated-tool.ts`, `with-deps/`, `widget-placement.ts`, `working-indicator.ts` even though README references them; fetch from upstream.

Also observed: `~/.pi/agent/extensions/web-fetch/` already exists (index.ts, fetch.ts, extract.ts, test.ts, package.json, node_modules, README.md) — the user's in-progress extension. Not read/edited.

---

## 1. Extension API surface relevant to a fetch tool

### 1.1 Extension module shape and tool registration

An extension is a `.ts`/`.js` module (loaded via jiti, no compile step) with a default export factory:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi: ExtensionAPI) { ... }   // may be async; awaited before session_start
```

Tools are registered with `pi.registerTool(definition)`. There is also `defineTool()` (exported from the package root) which is only a typing helper preserving parameter inference for standalone definitions:

```ts
// $P/dist/core/extensions/types.d.ts:386
export declare function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
  tool: ToolDefinition<TParams, TDetails, TState>): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
// types.d.ts:927
registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(tool: ToolDefinition<TParams, TDetails, TState>): void;
```

`registerTool` works during load and later (inside `session_start`, commands); tools are refreshed immediately, no `/reload` needed (extensions.md §pi.registerTool).

### 1.2 `ToolDefinition` (exact, `$P/dist/core/extensions/types.d.ts:344-377`)

```ts
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
    name: string;                 // used in LLM tool calls
    label: string;                // UI label
    description: string;          // sent to LLM
    promptSnippet?: string;       // one-line entry in "Available tools" section of default system prompt; omitted if absent
    promptGuidelines?: string[];  // bullets appended flat to "Guidelines" section while tool is active
    parameters: TParams;          // TypeBox schema
    constrainedSampling?: false | ConstrainedSamplingConfig;
    renderShell?: "default" | "self";
    prepareArguments?: (args: unknown) => Static<TParams>;   // runs before schema validation (compat shim)
    executionMode?: ToolExecutionMode;   // "sequential" | "parallel" (default: parallel)
    execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined,
            onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionContext): Promise<AgentToolResult<TDetails>>;
    renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;
    renderResult?: (result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, theme: Theme,
                    context: ToolRenderContext<TState, Static<TParams>>) => Component;
}
```

### 1.3 Parameter schema (TypeBox)

- `import { Type } from "typebox"` (pi aliases `typebox`, `typebox/compile`, `typebox/value`, and `@sinclair/typebox*` to its bundled copy — see §1.10).
- Use `Type.Object({ url: Type.String({ description: "..." }), timeout: Type.Optional(Type.Number({...})) })`.
- **String enums must use `StringEnum` from `@earendil-works/pi-ai`** (`StringEnum(["markdown","text","html"] as const)`); `Type.Union(Type.Literal...)` breaks Google's API (extensions.md §Tool Definition, examples README "Key Patterns").
- Built-in `read` schema for reference (`$P/dist/core/tools/read.js`):
  ```ts
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  ```
- Built-ins strip a leading `@` from path args ("some models are idiots"); normalize similarly if you accept paths.

### 1.4 Result shape — `AgentToolResult` (`$P/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:316`)

```ts
export interface AgentToolResult<T> {
    content: (TextContent | ImageContent)[];   // sent to the model  e.g. { type: "text", text } | { type: "image", data, mimeType }
    details: T;                                // arbitrary structured data for UI rendering / session state; NOT sent to LLM
    usage?: Usage;                             // nested-LLM usage (if your tool calls a model, e.g. summarization)
    addedToolNames?: string[];
    terminate?: boolean;                       // hint to stop after this tool batch
}
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;
```

- **Errors:** throw from `execute()`; pi sets `isError: true` on the `ToolResultMessage` and reports the message to the LLM. Returning a value never sets the error flag (extensions.md "Signaling errors").
- **Streaming progress:** `onUpdate?.({ content: [{type:"text", text:"Fetching..."}], details: {...} })`; `renderResult` gets `isPartial: true` for these.
- `details` is persisted in the session file (`ToolResultMessage.details`) and is visible to `tool_result` handlers and JSON/RPC event consumers, but never goes into the provider request. It's the right place for metadata (final URL, status, content-type, truncation info, temp file path).
- Images: `content` can include `{ type: "image", data: base64, mimeType }`; `read` checks `ctx.model.input.includes("image")` and adds a note for non-vision models. Settings `images.autoResize` (default true) applies to "images returned by tools".

### 1.5 `renderCall` / `renderResult` (custom TUI rendering)

```ts
// types.d.ts:308-341
export interface ToolRenderResultOptions { expanded: boolean; isPartial: boolean; }
export interface ToolRenderContext<TState = any, TArgs = any> {
    args: TArgs; toolCallId: string; invalidate: () => void; lastComponent: Component | undefined;
    state: TState; cwd: string; executionStarted: boolean; argsComplete: boolean; isPartial: boolean;
    expanded: boolean; showImages: boolean; isError: boolean;
}
```

Pattern used by built-ins and docs:

```ts
import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";
renderCall(args, theme, context) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", args.url));
  return text;
},
renderResult(result, { expanded, isPartial }, theme, context) {
  if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);
  let t = theme.fg("success", `200 text/html ${formatSize(bytes)}`);
  if (!expanded) t += ` (${keyHint("app.tools.expand", "to expand")})`;
  return new Text(t, 0, 0);
}
```

- Return a `Component`; default `Box` shell handles padding/background (`renderShell: "self"` opts out). Use `Text` with padding `(0,0)`.
- Fallback when a slot is missing/throws: `renderCall` shows tool name; `renderResult` shows raw `content` text.
- Theme color keys (docs/themes.md): `accent, muted, dim, success, error, warning, toolTitle, toolOutput, toolSuccessBg, toolErrorBg, ...`. `theme.fg(key, str)`, `theme.bold(str)`.
- Collapsed vs expanded: built-in `read` renders nothing when collapsed and not error; `bash` shows a few preview lines; `grep` shows 15 lines collapsed. Keep default view compact.
- Overriding a built-in (same `name`) inherits renderers per slot; `promptSnippet/promptGuidelines` are not inherited.

### 1.6 Truncation helpers (`$P/dist/core/tools/truncate.js`, all exported from package root)

```ts
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;   // 50KB
export const GREP_MAX_LINE_LENGTH = 500;
export function truncateHead(content: string, options?: { maxLines?, maxBytes? }): TruncationResult;  // keep first N; never partial lines; firstLineExceedsLimit => content ""
export function truncateTail(content: string, options?): TruncationResult;  // keep last N; may return partial first line (lastLinePartial)
export function truncateLine(line: string, maxChars = 500): { text; wasTruncated };
export function formatSize(bytes: number): string;  // "512B" | "1.5KB" | "2.0MB"
interface TruncationResult { content; truncated; truncatedBy: "lines"|"bytes"|null; totalLines; totalBytes; outputLines; outputBytes; lastLinePartial; firstLineExceedsLimit; maxLines; maxBytes; }
```

Also exported but internal-ish: `OutputAccumulator` is NOT exported from the root index (only `withFileMutationQueue`, `truncate*`, `formatSize`, `DEFAULT_MAX_*`, `createXTool*`, `keyHint/keyText/rawKeyHint`, `defineTool`, `isBashToolResult`, etc. — see `$P/dist/index.d.ts` lines 8, 24, 28).

**How built-ins present truncation and point the model at more data:**

- `read` (`read.js`): description = `Read the contents of a file. Supports text files and images (...). For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`
  Appends to content:
  - `[Showing lines ${start}-${end} of ${total}. Use offset=${next} to continue.]` (line limit)
  - `[Showing lines ${start}-${end} of ${total} (50.0KB limit). Use offset=${next} to continue.]` (byte limit)
  - user limit hit early: `[${remaining} more lines in file. Use offset=${next} to continue.]`
  - first line too big: `[Line N is 120.0KB, exceeds 50.0KB limit. Use bash: sed -n 'Np' path | head -c 51200]`
  `details = { truncation }` (type `ReadToolDetails`).
- `bash` (`bash.js`): description `... Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. ...`. Uses `OutputAccumulator({ tempFilePrefix: "pi-bash" })` streaming to a temp file; appends `[Showing lines ${start}-${end} of ${total}. Full output: ${fullOutputPath}]`; `details = { truncation, fullOutputPath }`. TUI shows `Full output: <path>` warning line.
- `grep` (`grep.js`): description `... Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.`; `details = { matchLimitReached, truncation, linesTruncated }`.
- Docs example (`truncated-tool.ts`, upstream) writes full output to `mkdtemp(join(tmpdir(), "pi-rg-"))/output.txt` and appends `[Output truncated: showing X of Y lines (a of b). N lines omitted. Full output saved to: <tempFile>]`, and puts `truncation` + `fullOutputPath` in `details`.
- Docs rule: "Tools MUST truncate their output ... Always inform the LLM when output is truncated and where to find the full version. Document the truncation limits in your tool's description."

### 1.7 Session events relevant to a fetch tool

```ts
// types.d.ts:416
export interface SessionStartEvent { type: "session_start"; reason: "startup" | "reload" | "new" | "resume" | "fork"; previousSessionFile?: string; }
// types.d.ts:478
export interface SessionShutdownEvent { type: "session_shutdown"; reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string; }
pi.on("session_start", async (event, ctx) => {...});
pi.on("session_shutdown", async (event, ctx) => {...});
```

- Docs: "Extension factories may run in invocations that never start a session. Do not start background resources ... from the factory. Defer ... until `session_start` ... Register an idempotent `session_shutdown` handler." (extensions.md "Long-lived resources and shutdown")
- On `/new`, `/resume`, `/fork`, `/reload`: pi emits `session_shutdown` for the old extension instance, re-loads/rebinds extensions, then `session_start` with the matching reason.
- `session_start` handler is also where `todo.ts`/`tools.ts` reconstruct state from `ctx.sessionManager.getBranch()` entries (`entry.type === "message" && entry.message.toolName === "my_tool"` → `entry.message.details`).
- Verified live (print mode): `session_start reason=startup`, then `session_shutdown reason=quit` on exit.

### 1.8 `ExtensionContext` (`types.d.ts:209-252`)

```ts
export interface ExtensionContext {
    ui: ExtensionUIContext; mode: "tui" | "rpc" | "json" | "print"; hasUI: boolean; cwd: string;
    sessionManager: ReadonlySessionManager; modelRegistry: ModelRegistry; model: Model<any> | undefined;
    scopedModels: readonly ScopedModel[]; thinkingLevel?: ThinkingLevel;
    isIdle(): boolean; isProjectTrusted(): boolean;
    signal: AbortSignal | undefined;     // current agent abort signal (Esc); undefined when idle
    abort(): void; hasPendingMessages(): boolean; shutdown(): void;
    getContextUsage(): ContextUsage | undefined; compact(options?): void; getSystemPrompt(): string;
}
// ReadonlySessionManager = Pick<SessionManager, "getCwd"|"getSessionDir"|"getSessionId"|"getSessionFile"|"getLeafId"|"getLeafEntry"|"getEntry"|"getLabel"|"getBranch"|"buildContextEntries"|"getHeader"|"getEntries"|"getTree"|"getSessionName">
ctx.sessionManager.getSessionId(): string          // UUID v7; verified live
ctx.sessionManager.getSessionFile(): string | undefined   // undefined when --no-session
```

- In `execute()`, the **`signal` argument** is the per-tool-call abort signal; pass it to `fetch(url, { signal })`. `ctx.signal` is the agent-turn signal (defined during tool_call/tool_result/turn events; undefined in session events/commands).
- `ctx.ui` (`types.d.ts:68`): `notify(message, type?: "info"|"warning"|"error")`, `setStatus(key, text|undefined)`, `setWidget(key, string[]|factory|undefined, opts?)`, `setWorkingMessage(msg?)`, `confirm(title, message, opts?)`, `select(...)`, `input(...)`, `custom(...)`, `setTitle(...)`. Guard dialogs with `ctx.hasUI` (true in tui+rpc; false in print/json where they are no-ops); guard `custom()` with `ctx.mode === "tui"`.
- Bash tool exposes `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` env vars to shell commands (extensions.md "Remote Execution"), useful if a cache dir is keyed by session.

### 1.9 npm dependencies, package.json manifest, discovery rules

From `$P/dist/core/extensions/loader.js` (`resolveExtensionEntries` / `discoverExtensionsInDir`):

1. `~/.pi/agent/extensions/*.ts|*.js` → loaded directly (global)
2. `~/.pi/agent/extensions/<dir>/package.json` with `"pi": { "extensions": ["./src/index.ts"] }` → loads declared entries (checked first)
3. else `<dir>/index.ts` or `index.js`
4. Same for project-local `<cwd>/.pi/extensions/` (only after project trust) and for `settings.json` `"extensions": [...]` paths (a directory path is resolved by the same rules; a file path loads as a single extension). No recursion beyond one level.

npm deps: "Add a `package.json` next to your extension (or in a parent directory), run `npm install`, and imports from `node_modules/` are resolved automatically" (jiti module resolution). For `pi install`ed packages, runtime deps must be in `dependencies` (installs use `npm install --omit=dev`). Bundled core packages (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) should go in `peerDependencies` with `"*"` and must not be bundled (docs/packages.md "Dependencies").

Upstream `examples/extensions/with-deps/package.json`:
```json
{ "name": "pi-extension-with-deps", "private": true, "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "dependencies": { "ms": "2.1.3" }, "devDependencies": { "@types/ms": "2.1.0" } }
```
For publishing as a pi package add `"keywords": ["pi-package"]` (pi.dev/packages gallery indexes this), optional `pi.skills/prompts/themes`, `pi.image`/`pi.video`.

### 1.10 Module aliasing (`loader.js:13-114, 417-428`)

jiti is created with `moduleCache: false` and `alias: getAliases()` mapping to pi's own bundled copies:
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, legacy `@mariozechner/pi-*` names, `typebox`, `typebox/compile`, `typebox/value`, `@sinclair/typebox`, `@sinclair/typebox/compile`, `@sinclair/typebox/value`. So extensions import these without installing them; installing a different `typebox` locally is ignored for these specifiers (and would be a type mismatch risk only at the TS level).

### 1.11 `/reload` semantics (extensions.md §ctx.reload, §session_shutdown)

`/reload` (or `await ctx.reload()` from a command) → emits `session_shutdown` with `reason: "reload"` for the current extension runtime → reloads extensions/skills/prompts/themes/context files (jiti `moduleCache: false`, so the module is re-imported fresh) → emits `session_start` with `reason: "reload"` and `resources_discover` with reason `"reload"`. Code after `await ctx.reload()` runs in the old frame; treat reload as terminal. Tools cannot call `ctx.reload()` (only `ExtensionCommandContext` has it); the docs' pattern is a `reload_runtime` tool that `pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" })`.

Practical implication for web_fetch: any in-memory cache/browser pool must be created lazily (session_start or first call) and closed in `session_shutdown` for every reason value, because reload/new/resume/fork all tear the instance down.

---

## 2. Existing fetch/search tools in pi and the ecosystem

- **pi ships no built-in web fetch or search tool.** Built-ins are exactly `read, bash, powershell, edit, write, grep, find, ls` (`$P/dist/core/tools/index.d.ts` `ToolName`). No `web_fetch`/`websearch` strings anywhere in `$P/dist/core`. pi's README stance: "No MCP. Build CLI tools with READMEs (see Skills), or build an extension".
- **pi-mono `examples/extensions/` has no fetch/browser/search example** (verified listing of upstream dir: 9 dirs + ~70 files; none match fetch/web/http/browser/search/url/curl). Closest relevant examples: `truncated-tool.ts` (truncation + temp file + renderCall/renderResult), `with-deps/` (npm deps), `subagent/` (nested LLM calls), `dynamic-tools.ts`/`kimi-deferred-tools.ts` (search_tools loader pattern), `tool-override.ts`.
- **pi-mono packages:** `agent, ai, client, coding-agent, evals, protocol, server, session-backends/sqlite-node, telemetry, tui`. No web package.
- **Community packages (npm, keyword `pi-package`; gallery at https://pi.dev/packages, also https://www.npmjs.com/search?q=keywords%3Api-package):**
  - `pi-web-fetch` — https://github.com/georgebashi/pi-web-fetch — `web_fetch` via headless Chrome (puppeteer) + trafilatura (Python via uvx), optional LLM distillation via pi sub-agent, batch up to 10 URLs, browser pool, 15-min cache, auto-summary when >~50KB and no prompt, cross-host redirect detection, site hooks (GitHub→`gh`).
  - `@code-yeongyu/pi-webfetch` — https://github.com/code-yeongyu/pi-webfetch — `webfetch(url, format: markdown|text|html, timeout)` mirroring opencode's contract; 30s default/120s cap timeout, 5MB cap, Accept negotiation, browser UA + Cloudflare retry; compact/expanded TUI rendering. Src: `src/index.ts`, `src/webfetch/`.
  - `pi-smart-fetch` — https://github.com/Thinkscape/agent-smart-fetch — `web_fetch`, `batch_web_fetch`; browser TLS fingerprint impersonation, defuddle extraction, metadata, streams large/binary to temp files, meta-refresh redirects, formats markdown|html|text|json|raw.
  - `pi-web-kit` — https://github.com/jvm/pi-mono/tree/main/packages/pi-web-kit — `web_search`, `web_fetch` (chunked reads via `limit`/`offset`), docs/code search; providers Exa/TinyFish/Brave/Firecrawl/markdown.new/Context7; "context-efficient".
  - `@siddr/pi-fetch-url` (https://github.com/sids/pi-extensions), `pi-web-access` (nicobailon: search, fetch, GitHub clone, PDF, YouTube), `@ollama/pi-web-search`, `@bitcraft-apps/pi-web-tools` (shell-only, no keys), `@thurstonsand/pi-web-tools`, `@peron_js/web-pi`, `@juicesharp/rpiv-web-tools`, `@pi-stef/web`, `pi-webaio`, `pi-exa`, `@j6e/pi-md-web-surfer` (Jina), `@demigodmode/pi-web-agent`, `@mrclrchtr/supi-web`, `@amaster.ai/pi-web-access`, `pi-web-search` (provider-native search), `pi-deepseek-search`.
  - Browser-automation: `pi-agent-browser`, `pi-agent-browser-native`, `pi-browser-harness`, `pi-playwright`, `pi-browser-debug`, `@amaster.ai/pi-browser-use`.
- Extension gallery / discovery: README says "Find packages on npmjs.com (keywords:pi-package) or Discord"; docs/packages.md documents `pi install npm:<pkg>` / `git:github.com/user/repo` / local path; `-l` for project-local.

Takeaway: the tool name `web_fetch` is the de-facto convention (pi-web-fetch, pi-smart-fetch, pi-web-kit); parameter conventions in the wild: `url`, `format`, `timeout`, `prompt` (LLM distillation), `limit`/`offset` (chunking).

---

## 3. Large tool output conventions

- **`details` is the out-of-context channel.** `AgentToolResult.details` / `ToolResultMessage.details` is persisted in the session (`.jsonl`) and available to renderers, `tool_result` hooks, JSON/RPC consumers and `session_start` reconstruction, but only `content` is converted for the provider. No separate artifact/attachment mechanism exists; images go into `content` as `{type:"image"}`.
- **Temp-file pattern is the official one.** `bash` streams to a temp file (`pi-bash` prefix in `os.tmpdir()`) when truncated and reports `Full output: <path>`; `truncated-tool.ts` uses `mkdtemp(join(tmpdir(), "pi-rg-"))`. Docs: "Write full output to temp file ... Inform the LLM where to find complete output".
- **`read` reads arbitrary absolute paths**: `resolveReadPathAsync(path, cwd)` resolves relative to cwd or accepts absolute; no sandboxing beyond `access(R_OK)`. Supports `offset` (1-indexed line) and `limit` (line count); default cap 2000 lines / 50KB whichever first; continuation hints `Use offset=N to continue.`; images by MIME sniffing. So `web_fetch` can save the full markdown to a file and tell the model `Use read with offset=... on <path>` — the model already knows `read`'s contract from its own description. (Bash `sed -n`/`head -c` is the fallback for single huge lines.)
- **Compaction hooks:** `session_before_compact` (`{ preparation, branchEntries, customInstructions, reason: "manual"|"threshold"|"overflow", willRetry, signal }`, return `{cancel:true}` or `{compaction:{summary, firstKeptEntryId, tokensBefore, details?}}`), `session_compact`, `session_compact_failed`. Built-in summarizer truncates each tool result to `TOOL_RESULT_MAX_CHARS = 2000` chars when building the summarization request (`$P/dist/core/compaction/utils.js:75`). Settings: `compaction.enabled` (true), `reserveTokens` (16384), `keepRecentTokens` (20000). There is no built-in "prune old tool outputs" step; an extension can do that via the `context` event (`event.messages` deep copy; return `{ messages }`), e.g. replace stale `web_fetch` results with a stub pointing at the temp file. `ctx.getContextUsage()` gives `{ tokens, ... }` for adaptive behaviour.
- **Teaching the model when to use web_fetch vs curl:**
  - `promptSnippet` → one-line under `Available tools:` in the default system prompt (only tools with a snippet appear; otherwise the prompt says "you may have access to other custom tools").
  - `promptGuidelines: string[]` → bullets under `Guidelines:` while the tool is active; must name the tool explicitly ("Use web_fetch instead of `curl` in bash when ..."). Built-in `read` uses `"Use read to examine files instead of cat or sed."` as precedent; `bash` guideline: "You can inspect PI_* environment variables ...".
  - Note both snippet/guidelines rebuild the system prompt (cache prefix invalidation) when activated dynamically; static registration at load is fine.
  - `before_agent_start` handler can return `{ systemPrompt: event.systemPrompt + "..." }` per turn, and `event.systemPromptOptions` exposes `.toolSnippets`, `.promptGuidelines`, `.selectedTools` (see `prompt-customizer.ts`, `pirate.ts`).
  - Skills (`docs/skills.md`): `SKILL.md` with frontmatter `name`/`description` in `~/.pi/agent/skills/`, `.pi/skills/`, `.agents/skills/`, package `skills/` dir or `pi.skills` manifest; descriptions go into the system prompt (only when `read` tool is available) and the agent `read`s the full file on demand; `/skill:name` forces it. A pi package can ship both the extension and a skill teaching research workflows.
- Tool description itself is the primary channel (see §4). Dynamic tool loading (`pi.setActiveTools`) is available if you want fetch tools hidden until a `search_tools` loader activates them.

---

## 4. Tool descriptions and headless testing

### 4.1 Description guidance found in pi

- `description` is sent verbatim as the tool's schema description. Built-ins put (a) what it does, (b) the truncation limits, (c) how to get more (`Use offset/limit ... continue with offset until complete`), (d) special behaviour (temp file, image attachments). Extensions doc: "Document the truncation limits in your tool's description".
- `promptGuidelines` rule: "Each guideline must name the tool it refers to — avoid 'Use this tool when...'".
- Lazily-loaded tools "should usually rely on their tool description and omit active-only prompt metadata".
- Param descriptions: `Type.String({ description })` on every field (all built-ins do this).
- Default system prompt (`$P/dist/core/system-prompt.js`) says "In addition to the tools above, you may have access to other custom tools depending on the project." — so a custom tool without `promptSnippet` is still callable, just not advertised in the prompt body.

### 4.2 Headless test commands (verified on 0.84.3, macOS, user default model `openai-codex/gpt-5.6-sol`)

Print mode (returns final assistant text on stdout; extension `console.error` goes to stderr):

```bash
pi -p --no-session --no-extensions --no-skills --no-context-files --no-prompt-templates \
   --tools qa_echo -e /abs/path/to/ext/index.ts \
   "Call the qa_echo tool with text 'hello-qa' and then reply with only the tool's output."
# stdout: ECHO:hello-qa (limits 2000/50.0KB, cwd=..., aborted=false)
# stderr: [qa-ext] session_start reason=startup mode=print hasUI=false sessionId=01a04239-...
#         [qa-ext] session_shutdown reason=quit
```

JSON event stream (machine-checkable tool I/O):

```bash
pi --mode json --no-session --no-extensions --no-skills --no-context-files --no-prompt-templates \
   --tools web_fetch -e /abs/path/to/ext/index.ts "Fetch https://example.com and summarize" 2>/dev/null \
 | jq -c 'select(.type=="tool_execution_start" or .type=="tool_execution_end")'
# tool_execution_end carries {toolCallId, toolName, args?, result:{content,details}, isError}
# message_end with message.role=="toolResult" carries content, details, isError
```

Notes:
- `--tools <list>` is a strict allowlist across built-in + extension tools; `--no-builtin-tools` keeps only extension tools; `--exclude-tools bash` is useful to force the model to use `web_fetch` instead of curl.
- `--no-extensions` disables discovery but explicit `-e` still loads (the doc says "Combine `--no-*` with explicit flags to load exactly what you need"). `-e` also accepts `npm:`/`git:` sources and a directory (resolved via package.json `pi.extensions` or `index.ts`).
- `--no-session` avoids writing `~/.pi/agent/sessions/...`; `--session-id <id>`/`--session <path>` for reproducible sessions; `--model provider/id`, `--thinking off` to cut cost.
- `--offline` / `PI_OFFLINE=1` disables startup network ops (version check), not your tool's fetches.
- macOS has no `timeout` binary; wrap with the harness timeout or `gtimeout`.
- `examples/extensions/README.md` first line: `pi --extension examples/extensions/permission-gate.ts`.
- For unit tests without an LLM, call the definition's `execute(toolCallId, params, signal, onUpdate, ctx)` directly (the tool object is plain data; `truncated-tool.ts`, code-yeongyu's package run `npm test` with vitest). RPC mode (`--mode rpc`, docs/rpc.md) is the other programmatic driver.
- A ready QA extension exists at `/private/tmp/claude-501/-Users-hoangta--pi-agent/3c4b50e6-f0a2-4e6a-8a84-e798e027111c/scratchpad/qa-ext/index.ts`; sample outputs in `qa-json.jsonl` alongside.

---

## 5. Output-limit settings and per-project vs global enablement

- There is **no settings.json knob for tool output limits**; `DEFAULT_MAX_LINES=2000` / `DEFAULT_MAX_BYTES=51200` are constants in `truncate.js`. Only `TruncationOptions { maxLines?, maxBytes? }` at call sites. Related settings: `images.autoResize` (true; applies to images returned by tools), `compaction.*` (see §3), `defaultTools` (built-in enable list; "Extension and SDK custom tools remain enabled"), `outputPad`, `hideThinkingBlock`.
- **Scopes** (docs/extensions.md "Extension Locations", docs/settings.md "Resources", docs/packages.md):
  - Global: `~/.pi/agent/extensions/*.ts` or `~/.pi/agent/extensions/<dir>/index.ts|package.json(pi.extensions)`; `~/.pi/agent/settings.json` `"extensions": [...]` / `"packages": [...]`.
  - Project: `<cwd>/.pi/extensions/...` and `.pi/settings.json` (same keys) — loaded only after the project is trusted (`~/.pi/agent/trust.json`, `-a/--approve`, `defaultProjectTrust`). Paths in `.pi/settings.json` resolve relative to `.pi`; in global settings relative to `~/.pi/agent`.
  - `pi install <source> [-l]` writes to global or (`-l`) project settings; `pi config [-l]` toggles individual resources; package object form filters `extensions: ["extensions/*.ts", "!extensions/legacy.ts"]`; project entry for the same package wins over global (dedup by npm name / git URL / absolute path).
  - CLI: `-e <path|npm:|git:>` for a single run; `--no-extensions` to ignore discovery.
  - `CONFIG_DIR_NAME` export should be used instead of hardcoding `.pi` for project-local config paths.
- Per-tool activation at runtime: `pi.getActiveTools()/pi.setActiveTools(names)`; the `examples/extensions/tools.ts` `/tools` UI persists selection via `pi.appendEntry("tools-config", {...})`.
