# Pi package ecosystem and a minimal package setup

_Researched 2026-08-28 from primary web sources._

## Findings

### The core is already a viable minimal setup

Pi describes itself as a minimal harness and starts with four built-in model tools—`read`, `write`, `edit`, and `bash`; customization is optional. Its official quick start is one global npm package plus provider authentication, and normal installation does not require lifecycle scripts, so the documented command uses `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` ([official README](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#quick-start)). The current npm metadata also declares Node `>=22.19.0` for the Pi CLI ([npm registry metadata](https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent/latest)).

A **Pi package is a distribution envelope**, not a required runtime layer: it can bundle extensions, skills, prompt templates, and themes and be installed from npm, git, or a local path. The public catalog is an npm-backed discovery surface for those resource types ([Pi package catalog](https://pi.dev/packages), [package docs](https://pi.dev/docs/latest/packages)).

### Choose the least-powerful resource that solves the need

- **Skills** are Markdown instructions, loaded on demand or selected automatically. Use them for repeatable procedures or domain guidance that does not need a new runtime capability ([skills docs](https://pi.dev/docs/latest/skills)).
- **Extensions** are TypeScript/JavaScript modules that can register tools, commands, event handlers, providers, and UI. Use them only when code execution or a capability absent from core is necessary ([extensions docs](https://pi.dev/docs/latest/extensions)).
- **Themes** only alter presentation; Pi already includes `dark` and `light`, so a custom theme is not part of a functional minimum ([themes docs](https://pi.dev/docs/latest/themes)).
- **Packages** are worthwhile when one or more such resources must be installed, versioned, or shared together. A package may declare exact resource paths in `package.json.pi`; otherwise Pi discovers conventional `extensions/`, `skills/`, `prompts/`, and `themes/` directories ([package structure docs](https://pi.dev/docs/latest/packages#package-structure)).

Thus, the smallest shared package can contain only one useful skill (or one extension) and a `package.json`; empty resource categories and custom themes need not be included.

### Security boundary

Pi's official warning is unusually broad: packages run with **full system access**; extensions execute arbitrary code, while skills can direct the model to take any action, including running executables. The docs explicitly require source review before third-party installation ([package security warning](https://pi.dev/docs/latest/packages#install-and-manage)). Project-local packages are installed only after the project is trusted, but trust also permits project extensions to execute, so trust is a security decision rather than package vetting ([project trust docs](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#project-trust)).

For evaluation, `pi -e npm:<package>` or `pi -e git:<repo>` installs into a temporary directory for one run, and package resource filters can load only selected resource types/files ([temporary install](https://pi.dev/docs/latest/packages#install-and-manage), [package filtering](https://pi.dev/docs/latest/packages#package-filtering)). Temporary installation limits persistence, **not authority while running**. Before installing, inspect the exact source/ref, `package.json` (especially scripts and dependencies), extension code, and skill text; the catalog's npm/repository/report links are useful inputs, but catalog presence should not replace review ([catalog](https://pi.dev/packages)).

### Pinning and updates

Use exact versions or refs in reproducible/minimal configurations:

```sh
pi install npm:@scope/pkg@1.2.3
pi install git:github.com/owner/repo@<commit-sha>
```

Versioned npm specs are pinned and skipped by package updates. Git tags or commits are treated as pinned refs; update commands reconcile the checkout to that configured ref but do not advance it. Changing a pin requires another `pi install ...@<new-version-or-ref>` ([npm and git source rules](https://pi.dev/docs/latest/packages#package-sources)). Prefer a commit SHA over a tag when immutable source identity matters.

`pi update` updates Pi itself; `pi update --extensions` updates packages; `pi update --all` updates both. Unversioned packages can therefore move during package updates, while pinned ones do not ([install/manage docs](https://pi.dev/docs/latest/packages#install-and-manage)). A sensible policy is to pin, review release/source diffs, update deliberately, and test before changing the shared pin.

### Dependency requirements

- Third-party runtime libraries belong in `dependencies`; Pi runs `npm install` for npm/git package installs, so they are installed automatically ([dependency docs](https://pi.dev/docs/latest/packages#dependencies)).
- Imports from Pi's bundled core packages—`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`—belong in `peerDependencies` with `"*"` and must not be bundled ([dependency docs](https://pi.dev/docs/latest/packages#dependencies)).
- Depending on another Pi package requires both `dependencies` and `bundledDependencies`, with its resources referenced under `node_modules/`, because separately installed Pi packages have isolated module roots ([dependency docs](https://pi.dev/docs/latest/packages#dependencies)).
- A skills/themes/prompts-only package generally needs no runtime dependency. An extension package needs only the libraries it actually imports; keep that graph small because each dependency expands review and update surface.

## Recommendation

Start with **core Pi and no third-party package**. Add a single reviewed skill when repeated instructions justify it; add an extension only for a capability core cannot provide; keep built-in themes. If sharing the setup, make one small package with an explicit `pi` manifest, omit empty categories, minimize runtime dependencies, pin npm packages to exact versions and git packages to commit SHAs, and update pins only after reviewing diffs. Treat every package—including skills-only packages—as trusted code/instructions with full-agent impact.
