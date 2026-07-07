# Basalt Roadmap

Continues the phase table in [ARCHITECTURE.md](./ARCHITECTURE.md). Phases 0–2
shipped more than originally scoped (watcher, backlinks, and the graph landed
early); Source/Reading modes and the command palette moved into the 2.x/3.x
hardening-and-parity track below. Phases 4–5 keep their numbers. The goal is
**core-app parity with Obsidian** — its plugin ecosystem is deliberately out of
scope (Basalt gets its own plugin API in Phase 5).

| Phase | Deliverable | State |
|-------|-------------|-------|
| 0 | Tauri 2 + CM6 shell; open vault; Live Preview; wikilink decoration + click | shipped |
| 1 | File tree, quick switcher, full-text search, autosave, frontmatter | shipped |
| 2 | Link/metadata index → backlinks, unlinked mentions, graph (global+local), fs watcher | shipped |
| 2.5 | **Hardening (2026-06 audit):** atomic writes, symlink/CSP/vault-root security, folder-rename rescan, Obsidian link-resolution parity (root-most + relative/absolute forms), fence-aware link extraction, parse-completion decoration fixes, undo/self-write data-safety, search & index perf, first tests | **shipped** |
| 2.6 | Keystroke parity: Mod-B/I/K, Tab indent, multi-cursor, task continuation, auto-pair, spellcheck, command palette (Cmd-P), MRU switcher | shipped |
| 2.7 | File lifecycle: delete to .trash, rename/move with vault-wide link rewrite, external-rename robustness | shipped |
| 2.8 | Attachments: non-md files in the tree, image paste/drop (attachmentFolderPath), PDF/audio embeds via asset protocol | shipped |
| 2.9 | Source mode toggle; read-only .obsidian interop (link format, daily notes + templates); markdown-style `[t](N.md)` link indexing + rename rewrite | shipped |
| 3 | Settings UI + light theme, outline/tag/bookmark panes, heading folding, Properties editing (raw-YAML round-trip) | shipped |
| 3.5 | Tabs, split panes, workspaces | shipped |
| 3.7 | Reading mode; PDF/HTML export | shipped |
| 4a | JSON Canvas viewer (read-only): pan/zoom world, text/file/link/group node cards, SVG edges; data-safety-reviewed (read-only contract, write_note/export_file backstops, tolerant parser) | **shipped** |
| 4b | Bases views over YAML (read-only): full .base engine (expression language, filters, formulas, views/table+cards, summaries, groupBy), DoS-hardened (ReDoS + value-growth budgets); canvas editing later | **shipped** |
| 4.5 | Multi-vault switcher (recent vaults) + multi-window: per-window vault state (Rust security boundary keyed by window label), per-window watchers, ?vault URL restore | **shipped** |
| 5a | Dataview-style query engine (```dataview TABLE/LIST/TASK + FROM/WHERE/SORT/GROUP BY/LIMIT/FLATTEN) + tasks; DoS-hardened; live in editor + reading | **shipped** |
| 5b | Templater-style templates (variables, dates, cursor, prompts) — no JS eval, curated tp.* | **shipped** |
| 5c | Basalt plugin API — in-webview plugins (basalt API: commands/code-block processors/editor extensions, .basalt/plugins loader, enable/disable, settings); off by default | **shipped** |

## Parity backlog (2026-07 Obsidian core-app audit)

A 5-dimension audit assessed 83 core features; the roadmap above covers the
majority. Remaining gaps, by size (quick-wins already shipped: sidebar toggles,
zoom, `%%comments%%`, paste-URL→link, outgoing-links pane):

- **Small (next)**: callout folding (`[!x]+/-`); follow-link-in-new-pane
  (⌘-click); new-note-in-folder (folder context menu — backend already
  supports folder-qualified names); quick-switcher "Create <query>"; reveal-in-
  Finder; readable-line-length toggle; spellcheck toggle; local-graph depth.
- **Medium — shipped (2026-07):** inline/block **math (KaTeX)** (reading +
  Live Preview + export); **footnotes** (`[^id]` + `^[inline]`); **alias**
  resolution (frontmatter `aliases:` — resolve/backlinks/autocomplete, rename-
  safe, real-file precedence); **heading link autocomplete** (`[[Note#…`) +
  **subpath navigation** (`[[Note#Heading]]`/`#^block` scroll-to); **search
  operators** (`path:`/`file:`/`tag:`, `-exclude`, `"phrase"`, `/regex/`).
- **Medium — also shipped (2026-07):** **hover page-preview** (wikilink →
  target popup); foldable **callouts** (`[!x]±`); **readable line length**
  toggle; **reveal in file manager** (context menu + command).
- **Medium — remaining**: **block-id autocomplete** (`[[Note#^…`); raw **HTML in
  Markdown** (needs sanitizer); inline **audio/video/PDF embed players**; **new
  folder** + folder/attachment context menus + **drag-drop** file tree; typed
  **Properties** widgets; per-command **hotkey assignment**; **CSS snippets**;
  status bar / ribbon; tab pinning + drag-between-panes; spellcheck toggle. Math
  export-font inlining + Live-Preview footnotes/callout-folding are follow-ups.
- **Large — all shipped (2026-07):** **note/heading/block transclusion**
  (`![[Note#h]]`, editor + reading, DoS-hardened); **Canvas editing** (drag/
  resize/create/edit/delete/colour nodes, draw edges — atomic write_canvas,
  conflict-safe, non-destructive to unmodeled fields); **Bases editing**
  (rename/type/limit/columns/filter + add/delete views — atomic write_base via a
  shared viewer write-path, comment-preserving YAML Document edit);
  **file-recovery snapshots** (local IndexedDB version history + restore,
  delete/rename-aware). Each shipped with a full adversarial data-safety review.

Out of scope by design: Obsidian Sync/Publish (paid services), the mobile app,
and running Obsidian's own community plugins (Basalt has its own plugin API).

## Ground rules (carried forward from the audit)

- The vault is shared live with Obsidian: never diverge silently on link
  resolution, file format, or `.base`/`.canvas` semantics — read Obsidian's
  conventions, write plain Markdown.
- All disk writes are atomic (temp + fsync + rename); all paths validate
  against the managed vault root; the watcher's ignore rules and the scanner's
  are one predicate.
- CM6 rules: block decorations from StateFields only; RangeSets sorted and
  non-overlapping; decoration extensions must rebuild on parse-completion
  (`regions.ts` `treeChanged`); doc-mutating widgets resolve live positions.
- Pure logic (resolution, parsing, masking) gets a vitest regression test when
  it changes — those are the bugs that silently corrupt a shared vault.
