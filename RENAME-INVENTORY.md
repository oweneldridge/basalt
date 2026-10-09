# Where the name lives

Basalt will be renamed (the name clashes with erikjuhani/basalt, an Obsidian
TUI that also installs a `basalt` command through Homebrew). The new name isn't
chosen yet. This lists every place the name appears, so the rename is one
planned pass. Counted 2026-10-03: 745 mentions in 104 tracked files, most of
them prose and comments.

## Breaks existing installs or vaults

Each of these needs a migration, an alias, or to stay as it is.

| What | Where | Why it matters | Plan |
|---|---|---|---|
| Bundle identifier `dev.basalt.desktop` | `src-tauri/tauri.conf.json` | The webview's storage is kept per app, so a new identifier starts empty: settings, hotkeys, recent vaults, workspaces, enabled plugins and their approved code hashes, snippet toggles, and version history (IndexedDB `basalt-snapshots`) | Keep the identifier, or copy the old app data on first launch. Check where Tauri keeps it on a built app first (not checked) |
| `.basalt/` in every vault | `basalt-core` (plugins, snippets) | Installed plugins and snippets would vanish | Read both folders, or move `.basalt/` on open |
| `.basalt-tmp-*` temp files | `atomic_write`, `sweep_temps` | A temp file left by a crash under the old prefix would never be cleaned up | Sweep both prefixes |
| ` ```basalt-query ` blocks | `src/editor/query.ts`, `ReadingView.tsx`, `plugins.ts` | Query blocks in people's notes would stop rendering | Keep `basalt-query` as an alias |
| `require("basalt")` | plugin host, all six plugins | Plugin copies in vaults would fail to load | Answer both module names |
| `basalt://` deep links | `tauri.conf.json` `schemes`, `src/lib/deeplink.ts`, CLI | The CLI and anyone's saved links use it | Register both schemes for a release or two |
| `basalt` CLI command | `package.json` `bin`, `cli/basalt.mjs` | People's scripts; also collides with the other project's Homebrew `basalt` | Rename, and say so in the changelog |
| `BASALT_*` env vars | `basalt-server` (`BASALT_AUTH`, `BASALT_VAULT`, `BASALT_HOST`, `BASALT_PORT`, `BASALT_WEB_DIR`, `BASALT_ALLOWED_HOSTS`) | Existing `.env` files and compose files, including Spectre's | Read the new and old names; warn on the old |
| Spectre deployment | `/opt/arrstack/basalt/basalt-server`, image `basalt-server-basalt-web`, container `basalt-web`, homelab-fleet docs | Renaming the compose project changes the image name compose looks for | Rename in one deploy, with the usual snapshot and rollback tag |
| `WRITE_CONFLICT` text ("Changed on disk since Basalt last read it") | `basalt-core`, `src/lib/vault.ts` | The app matches this exact string from the server | Change both sides together (`vault.test.ts` checks they match) |

## Safe to rename (internal)

- Browser storage keys (`basalt.*`, `basalt-*`): can keep their names if the
  identifier stays; renaming them would need a copy step for no visible gain.
- Crates `basalt`, `basalt_lib`, `basalt-core`, `basalt-server`; the npm
  package name; paths in the Dockerfile and CI.
- DOM hooks: `data-basalt-img`, `data-basalt-html`, `basalt-mermaid-*` ids,
  `basalt:` custom events.
- Dev-only env vars: `BASALT_TEST_VAULT`, `BASALT_E2E_BIG_VAULT`.

## User-facing text

- `productName`, the window title and `document.title` ("Note · Basalt").
- Settings and dialog text, error messages, the plugin settings tab.
- README, CHANGELOG, PARITY, DEPLOY, DESIGN notes, the GitHub repo name and
  `homepage` in `tauri.conf.json` (GitHub redirects the old repo URL).

## Before the rename

- Put the product name for user-facing text in one constant (TypeScript and
  Rust) and use it everywhere, so the visible rename is one line.
- Not built yet, so name it from that constant: the `basalt-plugin://` scheme
  in DESIGN-plugin-loading.md.
