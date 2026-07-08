# Parity gaps — UX/UI, layout, plugins (2026-07-08 review)

Evidence-based review of Basalt vs Obsidian in the three areas most behind
(aside from the by-design exclusions: Sync/Publish, mobile, marketplaces).
Ordered by leverage (impact ÷ effort). Checked items are done.

## Plugin API (Basalt's own API — the weakest area)

- [x] **Event system** — `app.vault.on(create|delete|rename|modify)`,
      `app.workspace.on(file-open|active-leaf-change)`, `plugin.registerEvent`,
      `registerDomEvent`, `registerInterval`. *(done)*
- [x] **Settings-tab API** — `addSettingTab(tab)` / `PluginSettingTab.display(el)`. *(done)*
- [x] **`addStatusBarItem`** *(done — with the status bar below)*; **`addRibbonIcon`** still open.
- [ ] **Custom view registration** (`registerView`) — add side-panel view types
      (compounds the layout gap).
- [ ] **Metadata cache API** — parsed tags/links/frontmatter/headings for a note.
- [ ] **Thicker vault API** — delete/rename/folder ops/attachment access.

## UX/UI depth

- [x] **Bottom status bar** — cursor line/col + word/char count + plugin items. *(done)*
- [ ] **Editor right-click menu** (cut/copy/format/bookmark) instead of native.
- [ ] **Tab right-click menu** (Close others / to the right / Split / Move to
      new window); currently right-click just toggles pin.
- [ ] **File context menu depth** — Open in new tab/pane/window, Make a copy,
      Move to…, Copy path.
- [ ] **File tree** — multi-select, folder drag-to-reparent, reveal-active-file,
      collapse-all/expand-all, folders-first sort.
- [ ] **Inline title** — click the editor's title to rename.
- [ ] **Drag a tree note into the editor** to insert a link.
- [ ] **Properties panel** — dedicated add/edit-property UI (inline render exists).
- [ ] Appearance: font / font-size / accent settings; rebind built-in shortcuts;
      persist UI zoom.

## Layout composability (biggest lift)

- [ ] **Movable views/leaves** — drag any view into any zone (fixed 3-zone shell
      today); reorder/relocate right-panel tabs.
- [ ] **Drag a tab to a pane edge to split**; drag a tab out to a new window.
