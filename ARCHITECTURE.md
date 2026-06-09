# Architecture

This document exists so that **someone who is not the original author can understand, build on, or revive Basalt.** That is the project's core resilience strategy: a codebase a stranger can pick up is the real defense against abandonment.

## Principles

1. **The vault is the source of truth.** Basalt holds no canonical state that isn't derivable from the files on disk. Everything else (the link index, search, the graph) is a *cache* that can be rebuilt from the vault at any time. This is what makes the data impossible to lock in.
2. **Markdown stays canonical.** Like Obsidian (and unlike Notion), the document model is the raw Markdown text, not a rich-text tree. Live Preview is a *rendering* over that text, never a replacement for it. This guarantees lossless round-tripping with any other Markdown tool.
3. **The filesystem boundary is narrow.** All file IO is in Rust (`src-tauri`). The webview never gets raw filesystem capabilities — it can only call the explicit `list_notes` / `read_note` / `write_note` / `create_note` commands. Smaller attack surface, easier to audit.
4. **Small and conventional over clever.** Boring, well-known tools (React, CodeMirror, Tauri) maximize the contributor pool. Resist dependencies and abstractions that only the author understands.

## Layout

```
basalt/
├── src-tauri/                 # Rust backend (the only thing that touches the filesystem)
│   ├── src/lib.rs             # vault commands: list_notes, read_note, write_note, create_note
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
A vault is a folder. `list_notes` walks it recursively, skips dotfolders (`.obsidian`, `.git`, `.trash`), and returns `{ path, rel, name }` per `.md` file. Notes are read/written on demand. **Planned:** a filesystem watcher so external edits (including Obsidian's) reflect live, and incremental index updates.

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

| Phase | Deliverable | State |
|------|-------------|-------|
| 0 | Tauri 2 + CM6; open vault; Live Preview (common elements); wikilink decoration + click | **in progress** |
| 1 | File tree, quick switcher, full-text search, autosave, Source/Reading modes, frontmatter | planned |
| 2 | Link/metadata index → backlinks, unlinked mentions, tags, block refs, transclusion | planned |
| 3 | Graph (global + local), Properties UI, daily notes, templates, command palette, themes | planned |
| 4 | JSON Canvas whiteboard; Bases-style table/card views over YAML | planned |
| 5 | Basalt plugin API + reimplemented must-have workflows | planned |

Sync, Publish, and native mobile are explicitly out of scope for the foreseeable future: each is a separate product. Users who need sync today can pair the vault with Syncthing, git, or iCloud/Dropbox — the open-format advantage means that just works.

## Known limitations (tracked)

Surfaced by the Phase 2 review; deliberately deferred, not forgotten:

- **Folder-name collisions.** Links and backlinks resolve by bare note name, so two notes with the same basename in different folders (e.g. `work/Index` and `personal/Index`) are conflated. Phase 2.5 will resolve each link to a concrete note *path* (Obsidian-style shortest-unique-path) and key the index by path.
- **No live reload of external edits.** Editing a note in Obsidian (or another app) while Basalt is open won't refresh until you reopen the vault. Needs a filesystem watcher (planned with Phase 2.5); re-opening the *currently* open note is a deliberate no-op until then.
- **Move/rename leaves stale index entries.** The index is path-keyed; a future move/rename feature must call `removeNote(oldPath)` before `setNote(newNote)`. No move feature exists yet, so this is a latent contract, not an active bug.
