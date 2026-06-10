# Architecture

This document exists so that **someone who is not the original author can understand, build on, or revive Basalt.** That is the project's core resilience strategy: a codebase a stranger can pick up is the real defense against abandonment.

## Principles

1. **The vault is the source of truth.** Basalt holds no canonical state that isn't derivable from the files on disk. Everything else (the link index, search, the graph) is a *cache* that can be rebuilt from the vault at any time. This is what makes the data impossible to lock in.
2. **Markdown stays canonical.** Like Obsidian (and unlike Notion), the document model is the raw Markdown text, not a rich-text tree. Live Preview is a *rendering* over that text, never a replacement for it. This guarantees lossless round-tripping with any other Markdown tool.
3. **The filesystem boundary is narrow.** All file IO is in Rust (`src-tauri`). The webview never gets raw filesystem capabilities — it can only call the explicit vault commands (`open_vault` / `read_vault` / `read_note` / `write_note` / `create_note` / `read_image` / `start_watching`), every path is validated against the canonical vault root held in Rust managed state, and all writes are atomic (temp + fsync + rename). Smaller attack surface, easier to audit.
4. **Small and conventional over clever.** Boring, well-known tools (React, CodeMirror, Tauri) maximize the contributor pool. Resist dependencies and abstractions that only the author understands.

## Layout

```
basalt/
├── src-tauri/                 # Rust backend (the only thing that touches the filesystem)
│   ├── src/lib.rs             # vault commands (managed root): open_vault, read_vault, read_note, write_note, create_note, read_image, start_watching
│   ├── Cargo.toml
│   ├── tauri.conf.json        # window, bundle, identifier
│   └── capabilities/          # Tauri permission grants (dialog, opener, core)
├── src/                       # React + TypeScript frontend
│   ├── lib/
│   │   ├── vault.ts           # typed wrappers over the Rust commands + Note types
│   │   └── store.ts           # (planned) vault state: notes, active note, dirty tracking
│   ├── editor/
│   │   ├── setup.ts           # assembles the CodeMirror 6 extension stack
│   │   ├── livePreview.ts     # conceal-while-editing decorations (the signature feature)
│   │   ├── wikilink.ts        # [[link]] decoration, click-to-open, autocomplete
│   │   └── theme.ts           # editor theme + syntax highlighting
│   ├── components/
│   │   ├── Sidebar.tsx        # note list / file tree
│   │   └── EditorPane.tsx     # mounts CodeMirror, wires autosave + navigation
│   ├── App.tsx                # top-level: vault open, note routing
│   └── styles.css             # app chrome (dark theme)
└── ARCHITECTURE.md / README.md / LICENSE
```

## Subsystems

### Vault layer (`src-tauri/src/lib.rs`, `src/lib/vault.ts`)
A vault is a folder. `open_vault` canonicalizes and stores the root in managed state; `read_vault` walks it recursively (skipping dotfolders like `.obsidian`, `.git`, `.trash`), returning every note with content for the index. A `notify` watcher emits `vault-changed` (per-note) and `vault-rescan` (directory-level) events so external edits — including Obsidian's — reflect live, with content-based suppression of Basalt's own write echoes.

### Editor (`src/editor/`)
CodeMirror 6, chosen because it is *literally* Obsidian's editor engine — the only way to match Live Preview behavior exactly.

- **`livePreview.ts`** — a `ViewPlugin` that walks the Lezer Markdown syntax tree over the visible viewport and emits `Decoration.replace` ranges that hide formatting marks (`#`, `*`, `_`, `` ` ``) *except* on the line the cursor/selection currently touches. This "conceal unless editing" behavior is the heart of Live Preview. It is deliberately conservative today (headings, emphasis, strong, inline code) and grows element-by-element.
- **`wikilink.ts`** — decorates `[[Target]]` / `[[Target|Alias]]`: styles them as links, conceals the brackets unless the cursor is inside, opens the target on click (and ⌘/Ctrl-click), and provides `[[`-triggered autocompletion from the note list. Wikilinks are matched with a scanner rather than the Markdown grammar because CommonMark has no native wikilink node.
- **`setup.ts`** — composes the stack: markdown language + code-language data, history, default keymap, search, the theme, Live Preview, and wikilinks. New editor features are added here.

### Link/metadata index (planned — Phase 2)
The backbone of everything Obsidian-feeling. A single in-memory index, rebuilt from the vault and updated on change, mapping: note → outgoing links, headings, tags, embeds, frontmatter; and the inverse for backlinks and unlinked mentions. The graph view and search read from this index. It is intentionally a derived cache (Principle 1).

## The plugin question

The single biggest strategic decision. Obsidian's moat is **~4,500 community plugins** — but those are TypeScript programs that run inside Obsidian's *private, undocumented Electron renderer*, importing closed implementations behind MIT-licensed type *stubs* (there is no reference runtime). Reaching bug-for-bug compatibility would mean reverse-engineering a moving, versioned, black-box API maintained by thousands of authors who owe a clone nothing — and it would force Basalt back onto Electron, discarding the lightweight native shell that is half the point.

**Decision:** Basalt ships its **own** small, documented, stable TypeScript plugin API (Phase 5), and the project reimplements the handful of workflows users actually depend on (Dataview-style queries, Templater-style templating, Tasks, Kanban) as first-party or first-party-blessed extensions. We compete on a *sustainable* extension story, not on emulating a competitor's private internals. This keeps the codebase small enough to stay alive — which, for an anti-enshittification project, matters more than feature-completeness.

## Roadmap

Moved to [ROADMAP.md](./ROADMAP.md) (phases 0–2.5 shipped; 2.6+ planned). Sync,
Publish, and native mobile remain explicitly out of scope: each is a separate
product. Users who need sync today can pair the vault with Syncthing, git, or
iCloud/Dropbox — the open-format advantage means that just works.

## Known limitations (tracked)

- **A replaced image shows stale until restart.** The image cache keys on path and the watcher only signals `.md` and directory changes; an asset overwritten mid-session keeps its cached bytes. Broaden the watcher or key on mtime (with Phase 2.8 attachments).
- **Oversized notes (>5 MB) are listed without content**, so their outgoing links aren't indexed; the editor still opens them via `read_note`.
- **Frontmatter wikilinks aren't indexed as links** (the prose mask skips YAML). Obsidian indexes Properties links; revisit with Properties editing (Phase 3).
