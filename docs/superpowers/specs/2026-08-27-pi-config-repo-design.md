# pi-config repo design

Date: 2026-08-27

## Goal

Keep every custom pi resource (extensions, skills, prompts, themes) in one GitHub repo that can be
installed and updated on any machine with pi's own package commands, without ever putting pi's
credentials, caches or session transcripts under version control.

## Decision

A **pi package repo** (`hoangtmbk/pi-config`, public — it holds no credentials or machine state), consumed via `pi install`, rather than
git-tracking `~/.pi/agent` directly. Rationale: `~/.pi/agent` also holds `auth.json` (OAuth
tokens), `sessions/`, `models-store.json`, `trust.json` and pi-managed `git/`/`npm/` clones; a
dotfiles-style repo there is one `git add -A` away from leaking a token, and the existing
`extensions/web-fetch` git repo would have to become a submodule. pi's package mechanism already
does clone + `npm install` + update, so it is the sync vehicle.

## Layout

```
pi-config/
├── package.json     pi manifest, all runtime deps, scripts (single package.json by design)
├── tsconfig.json    portable: no absolute paths; pi types come from the devDependency
├── extensions/web-fetch/   moved in with full git history (this repo's history *is* web-fetch's)
├── skills/ prompts/ themes/   convention dirs, auto-discovered
└── docs/web-fetch-review/     design/QA/SDD docs, kept out of extensions/
```

## Dependency handling

- Runtime deps of every extension are hoisted to root `dependencies` — `pi install` runs
  `npm install --omit=dev` at the package root only.
- `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox` are `peerDependencies: "*"`
  (per pi docs) and `pi-coding-agent` is additionally a devDependency so `tsc` resolves the types on
  any machine. npm hoists `pi-tui`/`typebox`, so no `paths` mapping is needed.

## Per-machine workflow

- Dev machine: working copy at `~/workspace/pi-config`, registered with `pi install <path>`
  (local path, no copy; edits are live).
- Other machines: `pi install git:github.com/hoangtmbk/pi-config`; sync with `pi update --all`.
- Never both on one machine (double-load).

## Explicitly excluded

`auth.json`, `settings.json`, `models-store.json`, `sessions/`, `trust.json`, `bin/fd` (arm64
binary; install `fd` per machine), `.claude/` (Claude Code, not pi).

## Verification

`npm run typecheck` and `npm test` (237 tests) pass from the repo root; `pi -e <repo> -p ...`
confirms the package loads from a fresh install path.
