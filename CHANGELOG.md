# Changelog

All notable changes to Basalt are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Basalt aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Embedded bases: `![[Tasks.base]]`, `![[Tasks.base#View]]` and fenced `base`
  blocks render in Live Preview and Reading view (read-only for now).
- Bases `this`, the file a base is shown for: the embedding note, or the base
  itself when opened directly.
- Bases `file.backlinks`, `file.embeds`, and `median()`/`stddev()` on lists, plus
  a Stddev summary.
- Images from the web (`https:`) load in the desktop app. A "Load remote
  images" setting turns them off: they show as placeholders, so opening a note
  never contacts another server. This covers raw HTML images too.
- `obsidian://open` and `obsidian://search` links in notes that point at the
  open vault (by name or by path) open in Basalt. Links to other vaults, and
  ones that would write (`new`, `append`), still go to the system.
- Bases list layout, as in Obsidian 1.10: bullets, numbers or no markers,
  properties on one line or indented under the first, and a custom separator.

### Fixed

- Hiding a sidebar, toggling Reading view, editing a property, splitting a
  pane, moving a folder or renaming a note no longer reverts what you typed.
- A vault rescan, Reload, or a slow read in another pane no longer reverts text
  or raises a "Changed on disk" against your own save. Stacked columns follow
  external edits.
- Saves are compare-and-swap: if the file changed since Basalt last read it
  (another tab or device, Obsidian, iCloud), you get "Changed on disk" instead
  of a silent overwrite. Saves to one note, canvas or base run one at a time.
- Saving keeps a note's creation time and permissions, so Dataview's
  `file.ctime` stays put. On macOS it also keeps Finder tags, "Open with" and
  other extended attributes.
- "Keep mine" on a note that was deleted elsewhere writes your text back
  instead of discarding it.
- Typing while a note is being renamed no longer recreates the old file or
  drops what you typed, and the caret stays where you were typing. Edits
  follow a renamed note only from the pane that showed it, so a new note that
  later takes the old name can never write into the renamed one. Text typed in
  a note while its folder is being moved is saved too.
- After "Keep mine" writes back a note deleted elsewhere, later edits save
  normally, and focus returns to the editor after Keep mine or Reload. A save to a
  note that was renamed or deleted elsewhere raises "Changed on disk" instead
  of bringing the old file back.
- Renaming a note rewrites links inside properties, and table-escaped
  `[[Note\|alias]]` links. Text inside a `|` or `>` block scalar is left alone, as
  Obsidian doesn't treat it as a link.
- Links resolve in Obsidian's order (the linking note's folder first, then the
  shortest path), so a rename updates the same links Obsidian would. Folder
  moves leave links to notes that didn't move alone.
- Inserting a template that has properties merges them into the note's own
  instead of dropping a second `---` block into the middle of the note. New
  keys are added and lists gain the missing items; nothing the note already
  has is lost or retyped. With the caret at the very top, the body goes after
  the note's properties.
- Adding a row or column to a table inside a list item, blockquote or callout
  keeps its indent and `>` markers, and a quoted table no longer shows `>` as
  its first column.
- Editing one Bases view no longer rewrites the others: their comments and
  layout stay as written, and flow lists keep the `[a, b]` style.
- Bookmarking a file writes `bookmarks.json` the way Obsidian does: other
  entries keep their key order, the new one gets a `ctime` and no fixed title
  (so its name follows renames), and there's no trailing newline.
- The Calendar plugin opens and creates daily notes with the vault's Daily
  notes settings (folder, date format, template), marks days whose notes use a
  custom format, and its days are buttons you can reach from the keyboard.
- Renaming a folder updates markdown-style attachment links such as
  `![](Media/pic.png)`, not only `![[...]]` embeds.
- Moving a note to another folder keeps its own links pointing where they did:
  `./` attachment paths, and bare names Obsidian looks up in the note's folder
  first.
- "Link" on an unlinked mention writes Obsidian's link text (a path when the
  name is ambiguous) and skips mentions inside URLs and tags.
- Rename no longer rewrites a note that has unsaved edits or a conflict; it
  reports it instead.
- The Properties sidebar keeps YAML types and quoting, doesn't write fields
  you only clicked into, and leaves lists of maps alone.
- Ticking a task in Reading view ticks that task, including inside callouts
  and after `%%` comments. Tasks in embedded notes are read-only. TASK queries
  ignore checkboxes inside code fences and frontmatter.
- Changing a Bases view's group-by drops a stale `groupOrder`; an empty canvas
  card keeps its `text` key; trashing a file whose name is taken keeps its
  extension; folders with a dot in their name trigger a rescan.
- A failed read or an oversized note can no longer seed an editor with empty
  or placeholder text.
- An external edit to an open canvas or base no longer blocks the next save
  with a false conflict.
- The web app's event stream recovers after a proxy answers a reconnect with
  an error.
- Audio, video and PDF embeds load under the release build's content policy.
- Obsidian's CSS snippets follow the enabled list in its `appearance.json`.

### Security

- A path outside the vault gets the same error whether or not it exists, so
  error text can't be used to probe the host's files.
- The web server takes a request's concurrency slot before reading its body,
  so a burst of large requests can't exhaust memory, and still accepts only
  JSON (a cross-site form can't post commands).
- Folder operations never follow symlinks, so a symlink inside the vault can't
  lead a folder delete or rename outside it.
- `basalt-server` with auth off answers only `localhost`, `127.0.0.1` and `::1`
  (add names with `BASALT_ALLOWED_HOSTS`), which blocks DNS rebinding.
- The templater-lite preview block runs a template only when you ask.
- HTML export picks its file in a native dialog run by the app, not the page.
- `basalt://open` asks before opening a vault you haven't opened before, and
  refuses network paths.
- Attachments open in the system viewer through a command that checks the
  file is in the vault; the unscoped open-path permission is gone.
- The web app opens only http, https, mailto and tel links.
- Mermaid 11.17.2 and DOMPurify 3.4.16.

### Accessibility

- Graph view and Slides are dialogs: focus stays inside, Escape returns it to
  where it was, and the rest of the app is inert. Slides announce "Slide 2 of
  5" as you move. The graph's filter, mode buttons and canvas have names.
- With reduced motion on, the graph is drawn once it settles instead of
  animating; dragging a node still follows the pointer.
- The two side panels are named landmarks ("Files", "Note details").
- Tab close buttons and toolbar buttons are at least 24 by 24 pixels, and a
  tab's close button shows when it has keyboard focus.
- Text fields and dropdowns have edges you can see: their borders meet 3:1
  against the panel behind them, in light and dark.
- Canvas cards work from the keyboard. Tab reaches each card and names it,
  focus selects it, Enter edits a text card or opens a note or link, arrow keys
  move the selection (Shift for bigger steps), Delete removes it, and Escape
  after editing returns to the card.
- Modals are real dialogs: focus moves in and back, Escape closes, and typing
  can't reach the note behind.
- Tabs work from the keyboard (arrows, Enter, Delete); the editor and icon
  buttons have names; panes follow keyboard focus.
- Save errors and conflicts are announced; notices sit in a live region.
- Text colors meet 4.5:1 contrast in both themes.
- Basalt keeps your own font size and lets the browser zoom in the web app.
- Visible focus rings for keyboard focus; reduced-motion and forced-colors
  settings are respected.

## [0.1.0] — first public alpha

The first tagged release: a local-first Markdown editor that reads and writes
the **same plain-Markdown vault** as Obsidian (a folder of `.md` + YAML +
`.canvas`/`.base`, with `.obsidian/` left untouched). Every disk write is atomic
and vault-contained; every data-mutating feature shipped with an adversarial
data-safety review.

### Editing

- **Live Preview** editor (CodeMirror 6): headings, emphasis, code, lists,
  tables (click-to-edit), task checkboxes, blockquotes, callouts (foldable),
  `==highlight==`, `#tags`, autolinks, `%%comments%%`.
- **Wikilinks** with click-to-open / create, `[[` autocomplete (including
  `#heading` and `#^block` completion), and markdown-style `[text](note.md)`
  links.
- **Aliases** (`aliases:` frontmatter) resolved everywhere, rename-safe.
- **Math** (KaTeX) inline/block in Live Preview, reading, and export; **raw
  HTML** in Markdown (DOMPurify-sanitized); **footnotes**.
- **Transclusion**: `![[Note]]`, `![[Note#heading]]`, `![[Note#^block]]`.
- **Inline media players**: `![[file.mp3]]` audio, video, and PDF embeds.
- Keystroke parity: Mod-B/I/K, Tab indent, multi-cursor, list/task
  continuation, auto-pair, spellcheck toggle.

### Navigation & knowledge graph

- Quick switcher (⌘O), full-text **search** with operators (`path:`/`file:`/
  `tag:`, `-exclude`, `"phrase"`, `/regex/`), command palette (⌘P).
- **Backlinks**, unlinked mentions, outgoing links, outline, tag, and bookmark
  panes; **hover page-preview**.
- **Graph view** (global + local), left **ribbon**, status bar (word count).

### Files & workspace

- File tree with new-note/new-folder, drag-to-move, **rename/delete** to
  `.trash` with **vault-wide link rewrite**; **single-pass folder rename**.
- **Attachments** (image paste/drop honoring `attachmentFolderPath`).
- **Tabs**, split panes, workspaces, tab pinning, drag-tabs-between-panes;
  multi-vault switcher + multi-window.
- **File-recovery snapshots** (local version history + restore).

### Rendering & interop

- **Reading mode**; **PDF / self-contained HTML export** (math as MathML).
- **JSON Canvas** editing (nodes, edges, groups); **Bases** views over YAML
  (read + edit).
- **Dataview-style queries** (`TABLE`/`LIST`/`TASK` + `FROM/WHERE/SORT/GROUP
  BY`), **Templater-style templates** (no JS eval), both DoS-hardened.
- Read-only `.obsidian` interop (link format, daily notes, templates,
  bookmarks); typed **Properties** editor; heading folding; **CSS snippets**;
  custom **hotkeys**; a Basalt **plugin API** (off by default).

### Theming & platform

- Light / dark / system themes; readable line length toggle.
- macOS, Windows, Linux (Tauri 2 — Rust core + system WebView).

### Not included (by design)

Obsidian Sync/Publish, the mobile app, and Obsidian's community plugins
(Basalt has its own plugin API). See [ARCHITECTURE.md](./ARCHITECTURE.md).

[0.1.0]: https://github.com/oweneldridge/basalt/releases/tag/v0.1.0
