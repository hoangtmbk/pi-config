# Minimal pi coding-agent setup (official web sources)

## Recommendation

Start with **pi itself, one provider credential, and the defaults**. Do not add a settings file, package, extension, skill, prompt, theme, or custom model until a repeated workflow requires one. Keep a small project `AGENTS.md` only when the repository needs commands or constraints communicated to the agent.

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
cd /path/to/project
export ANTHROPIC_API_KEY=sk-ant-...  # or start pi and run /login
pi
```

The official quickstart says `--ignore-scripts` is safe because normal installs need no dependency lifecycle scripts; an official curl installer is also available. ([Quickstart](https://pi.dev/docs/latest/quickstart), [official GitHub README](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#quick-start))

## What the minimum includes

- **Authentication:** either use `/login` for a subscription provider (built-ins include Claude Pro/Max, ChatGPT Plus/Pro/Codex, and GitHub Copilot), or expose an API key as an environment variable. `/login` can also store an API key in `~/.pi/agent/auth.json`; using an environment variable means that file can be omitted. ([Quickstart — Authenticate](https://pi.dev/docs/latest/quickstart#authenticate), [Providers](https://pi.dev/docs/latest/providers))
- **Tools:** the normal default is only `read`, `write`, `edit`, and `bash`. `grep`, `find`, and `ls` are additional built-in read-only tools available through tool configuration. Thus no extension is required for ordinary repository reading, editing, and command execution. ([Quickstart — First session](https://pi.dev/docs/latest/quickstart#first-session), [Using Pi — Tool options](https://pi.dev/docs/latest/usage#tool-options))
- **Settings:** no settings file is required. If preferences become useful, global settings live at `~/.pi/agent/settings.json`; project overrides live at `.pi/settings.json`. `/settings` handles common options, while `/model` and `/thinking` plus Ctrl+S save startup defaults. ([Settings](https://pi.dev/docs/latest/settings))
- **Project instructions:** `AGENTS.md`/`CLAUDE.md` files are optional context, loaded from the current and parent directories; `~/.pi/agent/AGENTS.md` supplies global instructions. Use this lightweight mechanism before building an extension. ([Quickstart — project instructions](https://pi.dev/docs/latest/quickstart#give-pi-project-instructions))

## Resources and packages

Extensions, skills, prompt templates, and themes are optional resource types. They can be loaded from global or project settings, local conventional directories, or a pi package. Settings default the corresponding resource arrays and `packages` to empty, so none are needed for a working install. ([Settings — Resources](https://pi.dev/docs/latest/settings#resources))

Install a package only when it provides a proven need:

```bash
pi install npm:@foo/pi-tools       # user/global
pi install -l git:github.com/u/r   # project-local
pi list
pi config                          # enable/disable package resources
```

Packages may come from npm, git, or local paths. Global installation updates `~/.pi/agent/settings.json`; `-l` updates `.pi/settings.json`, and trusted projects can install missing project packages at startup. Packages run with full system access—extensions execute arbitrary code and skills may direct executable actions—so review third-party source first. ([Pi Packages — install and manage](https://pi.dev/docs/latest/packages#install-and-manage), [Security](https://pi.dev/docs/latest/security))

## What can be omitted

- **`settings.json`** until a default model, thinking level, theme, or other preference is worth persisting.
- **`auth.json`** when credentials come from environment variables.
- **All custom resources and packages**: extensions, skills, prompt templates, custom themes, custom providers/models, MCP, sub-agents, plan mode, to-dos, permission UI, and background bash are not required by the core workflow. Pi intentionally leaves many of these workflow choices outside the core. ([Using Pi — Design Principles](https://pi.dev/docs/latest/usage#design-principles))
- **Custom theme:** pi already includes `dark` and `light`. ([Themes](https://pi.dev/docs/latest/themes))
- **Saved sessions**, for disposable runs, with `--no-session`; normal sessions otherwise save automatically. ([Using Pi — Sessions](https://pi.dev/docs/latest/usage#sessions))
- **Discovered resources/context**, for a deliberately sterile run:

  ```bash
  pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files
  ```

  These switches can be combined with an explicit resource to load exactly one item. ([Using Pi — Resource options](https://pi.dev/docs/latest/usage#resource-options))

## Bottom line

The best minimal setup is the stock CLI plus one authentication method. Preserve the four default tools and normal session handling; add a concise `AGENTS.md` when project guidance is needed. Add settings only to remove recurring friction, and install reviewed packages only after their value outweighs their code-execution and configuration surface.
