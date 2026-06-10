# Basalt

**An open-source, local-first Markdown knowledge base — vault-compatible with Obsidian, built so it can never be taken away from you.**

Basalt reads and writes the *same plain-Markdown vault* you already use in Obsidian: a folder of `.md` files with `[[wikilinks]]`, YAML frontmatter, and an untouched `.obsidian/` config. You can run Basalt and Obsidian over the same vault and switch between them freely — your notes are just files.

> **Status:** usable alpha — Live Preview editing, backlinks + unlinked mentions, graph view, quick switcher, full-text search, folder tree, images/embeds, and live-reload alongside Obsidian on the same vault. See the [roadmap](#roadmap).

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

## Develop

Prerequisites: [Rust](https://rustup.rs), Node 18+, and your platform's [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev      # launch the desktop app (first Rust build takes a few minutes)
npm run build          # typecheck + build the frontend
npm run tauri build    # produce a distributable bundle
```

## Roadmap

Basalt is built in phases so each phase is independently useful — see [ROADMAP.md](./ROADMAP.md) for the full table (shipped: vault editor with Live Preview, backlinks + unlinked mentions, live-reload watcher, path-based link resolution, quick switcher + full-text search, graph view, folder tree, images/embeds, and the 2026-06 hardening pass with the first test suite).

## License

[AGPL-3.0-or-later](./LICENSE). Copyright © 2026 Owen Eldridge and contributors.

"Obsidian" is a trademark of Dynalist Inc.; Basalt is an independent project and is not affiliated with or endorsed by Obsidian. "Vault-compatible with Obsidian" describes file-format compatibility only.
