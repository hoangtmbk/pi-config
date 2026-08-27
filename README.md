# pi-config

My [pi](https://pi.dev) package: the extensions, skills, prompt templates and themes I want on
every machine, in one repo that pi can install and update itself.

## What's inside

| Path | What |
|---|---|
| `extensions/web-fetch/` | `web_fetch` tool — fetches a URL and returns clean, context-lean markdown. See its [README](extensions/web-fetch/README.md). |
| `skills/` | Skills (`<name>/SKILL.md`). Auto-discovered; empty for now. |
| `prompts/` | Prompt templates (`*.md`). Auto-discovered; empty for now. |
| `themes/` | Themes (`*.json`). Auto-discovered; empty for now. |
| `docs/web-fetch-review/` | Design notes, QA reports and SDD archive from building web-fetch. |
| `docs/superpowers/specs/` | Design specs for this repo. |

`package.json` carries the `pi` manifest (which resources to load), the runtime `dependencies`
of every extension, and the test/typecheck scripts. There is deliberately **one** `package.json`:
`pi install` runs `npm install --omit=dev` at the package root and nowhere else.

## Setup on a new machine

```bash
pi install git:github.com/hoangtmbk/pi-config
```

That clones to `~/.pi/agent/git/github.com/hoangtmbk/pi-config`, installs dependencies, and
registers the package in `~/.pi/agent/settings.json`. Start `pi` and `web_fetch` is available.

Pull updates later with:

```bash
pi update --all          # or: pi update --extensions
```

## Developing (this checkout)

On the machine where you edit this repo, point pi at the working copy instead of a clone, so
changes are live without a push/pull cycle:

```bash
git clone git@github.com:hoangtmbk/pi-config.git ~/workspace/pi-config
cd ~/workspace/pi-config && npm install
pi install ~/workspace/pi-config
```

Don't also install the `git:` form on the same machine, or every tool loads twice. `pi list`
shows what is registered.

```bash
npm test                 # offline suites for every extension
npm run typecheck        # tsc against pi's real .d.ts (pi-coding-agent is a devDependency for this)
npm run live:web-fetch   # web-fetch's manual runner against real URLs
```

### Adding things

- **Extension:** `extensions/<name>/index.ts`, add its runtime deps to root `dependencies`, and add
  `./extensions/<name>/index.ts` to `pi.extensions` in `package.json`. Tests go in
  `extensions/<name>/tests/*.test.ts` and are picked up by `npm test`.
- **Skill / prompt / theme:** drop it in the matching directory — no manifest change needed.

Then commit, push, and run `pi update --all` on the other machines.

## What is *not* here, on purpose

`~/.pi/agent` also holds `auth.json` (OAuth tokens), `settings.json` (has per-machine state),
`models-store.json` (cache), `sessions/` (transcripts), `trust.json` (absolute local paths) and
`bin/` (platform binaries). None of that belongs in a synced repo; `.gitignore` blocks the
dangerous ones as a safety net.
