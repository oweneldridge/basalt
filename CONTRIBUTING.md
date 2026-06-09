# Contributing to Basalt

Basalt's resilience strategy is a codebase a stranger can pick up. Contributions that keep it **small, conventional, and well-documented** are worth more than clever ones. Please read [ARCHITECTURE.md](./ARCHITECTURE.md) first.

## Ground rules

- **Keep the vault sacred.** Never introduce a canonical state that can't be rebuilt from the files on disk. Indexes, caches, and the graph are all derived data.
- **Markdown stays canonical.** Live Preview renders the text; it never replaces it. No rich-text document model.
- **Narrow the filesystem boundary.** All file IO lives in Rust (`src-tauri`). Don't expand the webview's raw filesystem capabilities.
- **Prefer boring.** New dependencies and abstractions must earn their place. The contributor pool is the safety net; don't shrink it.

## Setup

Prerequisites: [Rust](https://rustup.rs), Node 18+, and your platform's [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev     # run the app
npm run build         # typecheck (tsc) + build the frontend
cargo fmt --manifest-path src-tauri/Cargo.toml   # format Rust
```

TypeScript runs in `strict` mode with `noUnusedLocals`/`noUnusedParameters`; `npm run build` must pass with zero errors.

## Where things live

- A new **editor feature** (Live Preview element, syntax) → `src/editor/`, wired in `src/editor/setup.ts`.
- A new **vault operation** → a Rust command in `src-tauri/src/lib.rs` + a typed wrapper in `src/lib/vault.ts`.
- **UI** → `src/components/`.

## The plugin stance

Basalt will **not** chase compatibility with Obsidian's private plugin runtime — that's an unwinnable maintenance war (see [ARCHITECTURE.md → The plugin question](./ARCHITECTURE.md#the-plugin-question)). We build our own small, stable, documented TypeScript plugin API instead. PRs toward Obsidian-plugin emulation will be declined; PRs toward the first-party API are very welcome.

## Licensing of contributions

Basalt is **AGPL-3.0-or-later**. By contributing you agree your contribution is licensed under the same terms (inbound = outbound). This is deliberate: it's what guarantees Basalt — and every future fork — stays open source.
