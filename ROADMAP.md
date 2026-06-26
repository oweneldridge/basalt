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
| 4b | Bases views over YAML (parse Obsidian .base read-only); canvas editing later | next |
| 4.5 | Multi-vault switcher polish; multi-window (watchers keyed per vault root) | planned |
| 5 | Basalt plugin API + first-party must-have workflows (Dataview-style queries, templater, tasks) | planned |

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
