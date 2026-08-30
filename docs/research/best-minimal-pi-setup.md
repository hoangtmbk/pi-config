# Best minimal setup for pi

Date: 2026-08-28

## Executive recommendation

Use pi's core with one authenticated provider and no authored customization at first. The official quick start is only:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

or install pi, start it, and run `/login` to use a subscription/provider login. Pi is already useful because the default model tools include `read`, `write`, `edit`, and `bash`; add skills, prompt templates, extensions, and packages only after a repeated workflow proves they are worth their surface area. [official README:63-91]

For this `pi-config` repo, the best minimal personal package is:

1. Keep `subagents` if fan-out/background work is part of the daily workflow.
2. Keep `web_fetch` if you regularly ask pi to read docs/URLs.
3. Treat `web_search` as optional because it adds a Brave API-key dependency.
4. Keep machine state (`auth.json`, `settings.json`, `models-store.json`, sessions, trust decisions, binaries) out of the repo. This repo already documents that split. [repo README:71-76]

## Minimal layers

### Layer 0: zero package, default pi

This is the lowest-friction baseline:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
/login
```

Facts behind the recommendation:

- Pi can be installed with npm, and the docs note `--ignore-scripts` is safe for normal npm installs. [official README:63-69]
- Authentication can be either an API-key environment variable plus `pi`, or interactive `/login`. [official README:77-89]
- Built-in model catalogs ship with pi; after authenticating, choose a model with `/model` or Ctrl+L. [official README:97-99]
- Pi's default coding tools are enough for normal repository work: `read`, `write`, `edit`, and `bash`. [official README:91]
- Custom themes are unnecessary at first because built-in `dark` and `light` exist and first run auto-detects terminal background. [themes docs:19-40]

### Layer 1: small personal defaults

Only add a global setting when it removes repeated friction. Good candidates:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "defaultProjectTrust": "ask"
}
```

Notes:

- `~/.pi/agent/settings.json` is the global settings location; `.pi/settings.json` is project-local. [settings docs:1-10]
- `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` are first-class settings. [settings docs:26-35]
- Keep `defaultProjectTrust` at `ask` unless you intentionally want non-interactive runs to trust project resources. Pi asks before trusting project-local settings/resources/extensions, and non-interactive modes use the global `defaultProjectTrust` fallback. [settings docs:12-22]

### Layer 2: package only proven resources

If syncing a setup across machines, use a pi package, but make it intentionally small.

Pi packages can bundle extensions, skills, prompts, and themes; package installs are managed with `pi install`, `pi list`, and `pi update --extensions/--all`. [packages docs:3-43] A package declares resources under `package.json.pi`, or pi auto-discovers conventional directories if there is no manifest. [official README:439-454; packages docs:156-165]

This repo currently declares three extension entrypoints plus empty resource directories: [package.json:9-18]

```json
"pi": {
  "extensions": [
    "./extensions/subagents/index.ts",
    "./extensions/web-fetch/index.ts",
    "./extensions/web-search/index.ts"
  ],
  "skills": ["./skills"],
  "prompts": ["./prompts"],
  "themes": ["./themes"]
}
```

That is reasonable for a power-user setup, but not the absolute minimal package. The repo README confirms `web_search` needs a Brave API key, while `web_fetch` is available after install. [repo README:23-32]

## What to omit until needed

- **Custom providers/models**: not needed for built-in providers. Use `models.json` only for custom/local providers; built-in provider catalogs ship with pi. [providers docs:1-3]
- **Checked-in settings/auth/state**: keep per-machine state out of a synced repo. This repo intentionally excludes `auth.json`, `settings.json`, model cache, sessions, trust decisions, and binaries. [repo README:71-76]
- **Custom tools/extensions**: extensions execute code and packages run with full system access, so each one should justify itself. [official README:409-411; packages docs:18-20]
- **Empty skills/prompts/themes directories**: harmless, but not needed for a truly minimal manifest until resources exist. This repo notes these directories are currently empty. [repo README:13-15]
- **Theme configuration**: use auto `dark`/`light` first. [themes docs:19-40]
- **Search extension**: omit unless you need integrated search and have a Brave key. [repo README:10-12,23-32]

## Hermetic minimal run

If “minimal” means “ignore anything already installed or auto-discovered,” run pi with resource discovery disabled:

```bash
pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files
```

The CLI documents disabling extension, skill, prompt-template, theme, and context discovery; it also says `--no-*` flags can be combined with explicit resources to load exactly what you need. [official README:589-603]

## Suggested setup command sets

### Fresh machine, no personal package

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
/login
# select provider, then /model if needed
```

### Fresh machine, current `pi-config` package

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install git:github.com/hoangtmbk/pi-config
pi
/login
```

The repo's documented package install clones into `~/.pi/agent/git/...`, installs dependencies, and registers the package in `~/.pi/agent/settings.json`. [repo README:23-32]

### Development checkout

```bash
git clone git@github.com:hoangtmbk/pi-config.git ~/workspace/pi-config
cd ~/workspace/pi-config && npm install
pi install ~/workspace/pi-config
```

Do not also install the `git:` form on the same machine, or tools load twice. [repo README:40-52]

## Open questions

- The official docs do not state which model a brand-new authenticated setup selects before `/model`; the SDK example says the model comes from settings or the first available model. [SDK example:1-10; SDK README:104-115]
- “Best” depends on whether the goal is absolute minimalism, daily productivity, or reproducible cross-machine setup. My recommendation is: start at Layer 0, add Layer 1 defaults, then install only a small Layer 2 package when the same resource proves valuable across machines.

## Source index

- Official pi README: `/Users/hoangta/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/README.md`
- Official providers docs: `/Users/hoangta/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md`
- Official settings docs: `/Users/hoangta/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/settings.md`
- Official packages docs: `/Users/hoangta/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`
- Official themes docs: `/Users/hoangta/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/themes.md`
- Official SDK minimal example: `/Users/hoangta/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/examples/sdk/01-minimal.ts`
- This repo README: `README.md`
- This repo manifest: `package.json`
