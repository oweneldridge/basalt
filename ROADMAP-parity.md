# Parity gaps — UX/UI, layout, plugins (2026-07-08 review)

Evidence-based review of Basalt vs Obsidian in the three areas most behind
(aside from the by-design exclusions: Sync/Publish, mobile, marketplaces).
Ordered by leverage (impact ÷ effort). Checked items are done.

## Plugin API (Basalt's own API — the weakest area)

- [x] **Event system** — `app.vault.on(create|delete|rename|modify)`,
      `app.workspace.on(file-open|active-leaf-change)`, `plugin.registerEvent`,
      `registerDomEvent`, `registerInterval`. *(done)*
- [x] **Settings-tab API** — `addSettingTab(tab)` / `PluginSettingTab.display(el)`. *(done)*
- [x] **`addStatusBarItem`** + **`addRibbonIcon`** *(done)*.
- [x] **Custom view registration** (`registerView`) — plugin right-panel views. *(done)*
- [x] **Metadata cache API** — getFileCache(tags/links/headings/frontmatter). *(done)*
- [x] **Thicker vault API** — delete/rename/createFolder. *(done; attachment access still open)*

## UX/UI depth

- [x] **Bottom status bar** — cursor line/col + word/char count + plugin items. *(done)*
- [x] **Editor right-click menu** — Cut/Copy/Paste/Bold/Italic. *(done)*
- [x] **Tab right-click menu** (Close / Close others / to the right / Pin / Split). *(done)*
- [x] **File context menu depth** — Open to the right, Make a copy, Copy path. *(done; Move to… still open)*
- [x] **File tree** — reveal-active-file + collapse-all *(done)*; folders-first already default. Multi-select + folder drag-to-reparent still open.
- [x] **Inline title** — editable filename above the editor. *(done)*
- [x] **Drag a tree note into the editor** → inserts `[[wikilink]]`. *(done)*
- [x] **Properties panel** — add/edit/remove in the right sidebar (+ inline render). *(done)*
- [x] Appearance: font-size + accent settings *(done)*; rebind built-in shortcuts still open;
      persist UI zoom.

## Layout composability (biggest lift)

- [ ] **Movable views/leaves** — drag any view into any zone (fixed 3-zone shell
      today); reorder/relocate right-panel tabs.
- [x] **Drag a tab to a pane edge to split** *(done)*; drag a tab out to a new window still open.
