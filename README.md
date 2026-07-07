# Basalt

**An open-source, local-first Markdown knowledge base — vault-compatible with Obsidian, built so it can never be taken away from you.**

[![CI](https://github.com/oweneldridge/basalt/actions/workflows/ci.yml/badge.svg)](https://github.com/oweneldridge/basalt/actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](./LICENSE)
![Platforms: macOS · Windows · Linux](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-lightgrey.svg)

Basalt reads and writes the *same plain-Markdown vault* you already use in Obsidian: a folder of `.md` files with `[[wikilinks]]`, YAML frontmatter, and an untouched `.obsidian/` config. You can run Basalt and Obsidian over the same vault and switch between them freely — your notes are just files.

> **Status:** broad core-app parity, alpha. Live Preview editing, backlinks + unlinked mentions, graph view, search, tabs/splits, Canvas + Bases, transclusion, math, Dataview-style queries, templates, and a plugin API — all over the same vault as Obsidian, live. See the [changelog](./CHANGELOG.md) and [roadmap](#roadmap).

## Why this exists

Obsidian is excellent, free, and stores your data in open plain text. But it is **closed-source**, and any closed product can change its terms, get acquired, add telemetry, or decay — "[enshittification](https://en.wikipedia.org/wiki/Enshittification)." Basalt is an insurance policy against that day:

- **AGPL-3.0 licensed.** Every fork and every hosted version must stay open source, forever. No one — not a future maintainer, not an acquirer — can take it proprietary. That legal guarantee *is* the point.
- **Your vault is the source of truth.** Plain Markdown + YAML + open [JSON Canvas](https://jsoncanvas.org). Zero lock-in: if Basalt itself ever goes bad, you walk away with the same files.
- **Designed to be continued by someone else.** Small, documented, conventional stack (see [ARCHITECTURE.md](./ARCHITECTURE.md)). The real protection against abandonment is a codebase a stranger can pick up.

## What it is (and isn't)

- ✅ Reads/writes your existing Obsidian vault losslessly (plain files, no import step).
- ✅ Aims for **core parity**: Live Preview editing, wikilinks + backlinks, graph view, search, YAML properties, Canvas.
- ✅ Ships its **own** clean, documented plugin API (TypeScript), and will reimplement the handful of must-have community workflows (Dataview-style queries, templating, tasks).
- ❌ Does **not** run Obsidian's ~4,500 community plugins. They are TypeScript bound to Obsidian's *private, closed Electron runtime*; bug-for-bug compatibility is an unwinnable maintenance war and the antithesis of a small, sustainable codebase. See [ARCHITECTURE.md → The plugin question](./ARCHITECTURE.md#the-plugin-question).

## Stack

- **Shell:** [Tauri 2](https://tauri.app) (Rust core + system WebView) — ~50 MB RAM vs Electron's 300 MB+, cross-platform (macOS / Windows / Linux).
- **Editor:** [CodeMirror 6](https://codemirror.dev) — the same editor engine Obsidian uses, so Live Preview can match exactly.
- **Frontend:** React 19 + TypeScript + Vite (chosen for the largest contributor pool, to maximize the odds someone can continue the project).

## Install

Download the installer for your platform from the [latest release](https://github.com/oweneldridge/basalt/releases/latest):

- **macOS** — `.dmg` (Apple Silicon or Intel).
- **Windows** — `.msi` or `.exe` (NSIS) installer.
- **Linux** — `.AppImage` or `.deb`.

Builds are currently **unsigned**, so the OS may warn on first launch:

- macOS: right-click the app → **Open** (once), or `xattr -dr com.apple.quarantine /Applications/Basalt.app`.
- Windows: **More info → Run anyway** on the SmartScreen prompt.

## Develop

Prerequisites: [Rust](https://rustup.rs), Node 20+, and your platform's [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev      # launch the desktop app (first Rust build takes a few minutes)
npm run typecheck      # tsc --noEmit
npm test               # vitest unit tests
npm run build          # typecheck + build the frontend
npm run tauri build    # produce a distributable bundle in src-tauri/target/release/bundle/
```

## Releasing

Releases are built and published by GitHub Actions ([`.github/workflows/release.yml`](./.github/workflows/release.yml)) on a version-tag push, across macOS (Apple Silicon + Intel), Windows, and Linux:

```sh
npm version patch          # bumps the version + creates a git tag
git push --follow-tags     # triggers the release workflow → a draft GitHub Release
```

Review the draft release's installers and notes, then publish it. Signing is optional and off by default; the workflow consumes Apple/Windows signing secrets if you add them.

## Roadmap

Basalt is built in phases so each phase is independently useful — see [ROADMAP.md](./ROADMAP.md) for the full phase table and the [CHANGELOG](./CHANGELOG.md) for what's shipped. The Obsidian core-app parity backlog is complete; out of scope by design are Obsidian Sync/Publish, the mobile app, and running Obsidian's own community plugins.

## License

[AGPL-3.0-or-later](./LICENSE). Copyright © 2026 Owen Eldridge and contributors.

"Obsidian" is a trademark of Dynalist Inc.; Basalt is an independent project and is not affiliated with or endorsed by Obsidian. "Vault-compatible with Obsidian" describes file-format compatibility only.
