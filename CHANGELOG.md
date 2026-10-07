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
  images" setting turns them off: they show as placeholders, and the page adds
  a Content Security Policy so the browser itself refuses any remote image or
  media file, however a note spells it. Turning them back on applies after a
  reload.
- `obsidian://open` and `obsidian://search` links in notes that point at the
  open vault (by name or by path) open in Basalt. Links to other vaults, and
  ones that would write (`new`, `append`), still go to the system.
- Bases list layout, as in Obsidian 1.10: bullets, numbers or no markers,
  properties on one line or indented under the first, and a custom separator.
- Inline SVG drawings in notes render in Live Preview and Reading view,
  sanitized (no scripts, event handlers, embedded HTML or SVG animation), and
  colours such as `fill="#e8710a"` inside HTML are no longer read as tags.
  A link inside a note's HTML, a drawing or an image map never replaces the
  app: in Reading view and canvas cards it opens like other links, and in a
  hover preview it does nothing.
  Clicking a rendered drawing puts the caret after it, so typing can't break
  it, and Reading view renders an HTML block written right under a paragraph.
- The arrow keys move one line at a time past tables, math blocks, drawings
  and the Properties block, instead of jumping lines above them. A click just
  below a table, an embed or the Properties block lands on the next line. A
  click, double-click, drag or Cmd-click on the edge of the Properties block
  or beside it can no longer put the caret in the hidden frontmatter, and a
  click along a math block's edge opens it with the caret inside the `$$`.
- Files and folders whose names start with a dot (sync backups such as
  `.unisonbak.*`, `.DS_Store`) are hidden from the file tree, search, the quick
  switcher and the index, as in Obsidian. "Show hidden files" in Settings shows
  them again.
- Code blocks are coloured, the same in Live Preview and Reading view. The
  colours use Obsidian's `--code-*` variables, so themes and snippets apply.
- Empty folders show in the file tree, and New folder makes a folder instead
  of a starter note.
- Back and forward (Cmd-Opt-Left and Cmd-Opt-Right, or the command palette)
  move through the notes a pane has shown, as in Obsidian.
- Pasting from a web page or a document gives Markdown: headings, lists,
  links, bold and italics, code, quotes and tables come across. A paste into
  code, or of text with no formatting, stays as it was.
- Dataview JS pages have `file.inlinks`, `file.outlinks` and `file.aliases`.
- Dataview JS blocks can use Obsidian's `app` (with `app.vault.getFiles()` and
  `getAllLoadedFiles()` listing every file and folder, each in its folder), and
  `moment` has `endOf`, `startOf` and `isBetween`. Its units, ISO offsets and
  rounding follow moment.js, checked against it. A block can still declare its
  own `app`.
- Basalt follows the vault's "Show line number", "Confirm file deletion" and
  "Readable line length" settings (the last until it's switched in Basalt).
- Images, PDFs, audio, video, canvases and bases can be renamed (right-click,
  Rename…) or dragged onto a folder. Every link, embed and canvas card that
  shows the file follows it, including a rename that only changes case.
- Search knows `task:`, `task-todo:`, `task-done:`, `section:`, `[property]`,
  `[property:value]`, `match-case:`, `ignore-case:` and `(a OR b)` groups, and
  says how many results it found.
- Plugins get Obsidian's `metadataCache.unresolvedLinks`, and `resolvedLinks`
  counts links to attachments too.

### Changed

- In Live Preview, `%%comments%%` show dimmed, as Obsidian shows them, instead
  of being hidden. Reading view and export still leave them out.
- Tags follow Obsidian's rule: letters of any script, digits, emoji, `-`, `_`
  and `/`, with the `#` at the start, after a space or after a formatting mark.
  A link to `#heading` and an escaped `\#` are no longer tags, and a number on
  its own (`#42`) never is.
- Callouts take Obsidian's colour for their type in both views, with titles
  that keep 4.5:1 contrast in the light theme. In Live Preview, quotes and
  callouts sit on the text column in plain type, as do embeds, queries and
  HTML blocks.
- The file tree lists a file that isn't a note by its name, with its extension
  as a small tag, as Obsidian does.
- Backlinks count every link and every mention, as Obsidian counts matches, and
  a line with several is listed once. Link all links each mention, not only the
  first on a line.
- Dataview JS `file.outlinks` include attachments and links to notes that
  don't exist yet.
- Pasted text is no longer escaped (Obsidian doesn't escape it), so a pasted
  `[[link]]`, `snake_case` or `C:\path` stays as it was.

### Fixed

- Links in Reading view go where they point. `[[Note#Heading]]` and block links
  scroll to their target, `[[#Heading]]` and `[text](#Heading)` scroll within
  the note, and a footnote number jumps to its footnote. Markdown links without
  `.md`, or to a PDF, open like wikilinks, in the editor too. The same link
  clicked again scrolls again.
- Text selected in Reading view stays selected when something else in the app
  updates.
- Links to files that don't exist show faded with a dotted underline, as in
  Obsidian, though a little less faded so they keep their contrast.
- The hover preview shows the section a link points to, with its embeds and
  media, and closes when the link is clicked.
- Turning "Show hidden files" off hides them at once, even in a large vault.
- The status bar counts words as Obsidian does: the frontmatter is left out,
  a selection is counted on its own, and nothing shows for a canvas or once
  the note is closed.
- Cmd-B and Cmd-I with nothing selected format the word at the caret, and step
  out of the markers when the caret sits right before them. Spaces at the ends
  of a selection stay outside the markers.
- A link's text reads as Obsidian shows it, folder included:
  `[[Folder/Note#Heading]]` reads "Folder/Note > Heading".
- In Live Preview, escape backslashes hide until the caret reaches them, bold
  and italics show inside a link's text, inline HTML such as `<b>` and
  `<font color>` renders, and inline footnotes show small and raised.
- A table ends at the first line without a `|`, as in Obsidian, so a sentence
  right under a table is no longer swallowed into it. A row wider than the
  header keeps its extra cells.
- Tables in Live Preview follow their column alignment, break lines at `<br>`,
  and their links open.
- A property value being typed is kept when you press Cmd-E or Ctrl-Tab or
  close the tab, and a field that was only focused leaves the note as it was.
- Templater Lite never overwrites text typed into a new note while its template
  runs, and leaves copies made in the templates folder alone. Plugins get
  Obsidian's `vault.process`.
- Tab and Shift-Tab keep a loose numbered list's numbers.
- Text after an HTML comment on the same line shows in Reading view.
- Links in properties open from Reading view.
- A PDF embed with `#page=3` or `#height=400` shows, opening at that page;
  before, it showed as missing.
- A folded section opens when Backspace or Delete would change what it hides,
  and clicking a fold arrow leaves the editor focused.
- Typing in a very long note keeps up: a 4 MB note went from 59 to 21 ms a key.
- An inline formula and a `$$` block on the same line no longer make an edit
  fail.
- A callout inside a callout shows in Live Preview.
- Backspace on a quote line written without a space (`>text`) deletes one
  character, never the marker with it.
- Renumbering a list keeps to that list, and to numbers written like `02.`.
- A heading link inside an embed goes to the embedded note.
- A table written with leading pipes ends at the first row without one, as in
  Obsidian.
- `%%` inside `~~~` fences and double-backtick code stays as written.

- Ticking a task in Reading view keeps your place instead of jumping back to
  the top of the note.
- Reading view now parses with the same CommonMark and GFM parser as Live
  Preview, extended with Obsidian's syntax, instead of a line-by-line scanner.
  Among what that fixes in real notes:
  - reference-style images and links (Google Docs exports) show their images
    instead of walls of base64;
  - lists keep wrapped lines, their start number, and code blocks inside items;
  - bold and italic may wrap onto the next line; `2 * 3 * 4` stays as typed;
  - footnotes after a quote or callout keep their numbers and text;
  - backslash escapes, entities, HTML comments, setext headings, indented code
    and double-backtick code all read as in Obsidian;
  - bare URLs are links; `#42` isn't a tag and `#café` is one;
  - `[[#Heading]]` shows "Heading" and `[[Note#Heading]]` "Note > Heading";
  - images take their `|300` size, and linked images work;
  - table columns follow their alignment, and short rows fill out;
  - inline HTML such as `<b>` or `<span>` shows as markup, without attributes
    beyond a few harmless ones;
  - a note nested a thousand quotes deep no longer blanks the app.
- Tasks with any status, such as `- [/]`, `- [-]` or `- [>]`, and tasks in
  numbered lists show as checkboxes in Live Preview and Reading view, as in
  Obsidian; clicking one marks it open or done.
- In Live Preview a callout with no title shows its type as the title
  ("> [!warning]" reads "Warning"), and only callouts marked foldable (`-` or
  `+`) get a fold arrow, as in Obsidian.
- In `[[` link completion, Enter picks the note whose name starts with what
  was typed; "Create new note" no longer outranks it.
- Cmd-E (Ctrl-E elsewhere) switches between editing and Reading view, as in
  Obsidian.
- The file tree sorts names naturally, as Obsidian does: "Untitled 2" comes
  before "Untitled 10".
- Aliases count, as in Obsidian: the quick switcher finds a note by its alias
  instead of offering to create a duplicate, and an alias mentioned in another
  note shows under unlinked mentions, where Link writes `[[Note|alias]]`.
- Search: `-path:`, `-file:` and `-tag:` exclude instead of including,
  `path:"Daily Notes"` keeps its quoted value whole, and a `/regex/` may hold
  spaces. Clicking a tag in the Tags panel searches `tag:#name` rather than
  the text `#name`.
- Dataview JS (lite) reads notes from the app's own copy instead of asking
  the server for every note on every block (one daily note fired about 35,000
  requests, and the failed ones silently counted as empty). It also allows
  top-level `await` and `dv.io.load`, passes property access through page
  lists (`pages.file.tasks`), prints links as `[[…]]`, renders bold, italic
  and code in `dv.paragraph`, and formats dates like moment.js
  (`MMM DD, YYYY [at] HH:mm`). A vault's installed copy of the plugin needs
  updating to get this.
- A new daily note made from a Templater template gets its `<% %>` tags
  processed, as in Obsidian, when Templater Lite is on and the vault's Templater
  has "Trigger on new file creation" set. Templater Lite now also runs
  `tp.user` scripts from Templater's user scripts folder and provides
  `moment()`. A vault's installed copy of the plugin needs updating to get this.
- Dollar amounts stay text: a `$` followed by a digit closes no math, as in
  Obsidian, so "$25 and $25" no longer turns into italic math, and inline code
  holding a `$` is never swallowed by math.
- Closing a side panel's tab no longer fails with "path escapes vault", and
  closing every note leaves an empty editor area, as Obsidian does, instead of
  removing it, so Cmd-W never goes on to close the side panels.
- Images resolve the way Obsidian resolves a link path: `./` and `../` paths
  work, and a path like `assets/pic.png` still finds its image after the note
  moves, by the end of its path, preferring the note's own folder.
- Lines below a diagram, an image, an embedded note or a query result stay
  where clicks and the arrow keys land once that content loads, and a click
  just outside such a block lands on the line beside it.
- Opening a note whose embedded image can't be found no longer rewrites the
  embed as "🖼 name" text on disk. Live Preview swapped the image out for that
  label in a way the editor read as typing, and autosave saved it.
- Lists type as in Obsidian: Enter on an empty item leaves the list (or moves
  up a level) in one press, without first making the list loose or leaving a
  line of spaces; Tab and Shift-Tab move an item with the items under it; a
  numbered item indented under another starts its own list at 1, and both
  levels renumber.
- In Live Preview a click never selects or types into markup it hides: a click
  left of a heading, quote, callout, list item or task starts typing after its
  markup, a click past a line's end lands after closing `**`, `==` or `~~`,
  and a double-click selects the word rather than the `**` or `# ` the first
  click revealed.
- Clicking a task's checkbox in Live Preview toggles it again. The click used
  to reveal the line's raw `- [ ]` and remove the box before it could toggle.
- A click on blank space inside the Properties box, followed quickly by a key,
  can no longer type in front of the frontmatter's opening `---`.
- Tables in Live Preview render math, highlights, strikethrough and tags in
  their cells, as Obsidian does, instead of showing the raw text.
- Lines below a formula no longer drift out of step with where clicks land
  once the formula renders, so a click on a math block opens it instead of
  typing into the line below.
- The status bar no longer says "Saved" while a side panel such as Files is
  focused, and the browser tab names that panel instead of `view:filetree`.
- Reading view keeps each line break inside a paragraph or list item, as
  Obsidian does unless "Strict line breaks" is on, and follows that setting
  from the vault. A line right under a list item stays in the item instead of
  starting a new paragraph.
- Hiding a sidebar, toggling Reading view, editing a property, splitting a
  pane, moving a folder or renaming a note no longer reverts what you typed.
- A vault rescan, Reload, or a slow read in another pane no longer reverts text
  or raises a "Changed on disk" against your own save, nor does a save whose
  reply arrives after the file watcher has seen it land, and a slow read can't
  put back text older than your last save. Stacked columns follow
  external edits and edits made in other panes, even ones that put back text
  typed earlier or that land in a column you typed in before, and opening the
  same note elsewhere over a slow link no longer reverts the column; a column
  whose note failed to load, or never answered, tries again. A rename or folder move whose reply is slow
  no longer raises a false "Changed on disk" on the notes being moved.
- Saves are compare-and-swap: if the file changed since Basalt last read it
  (another tab or device, Obsidian, iCloud), you get "Changed on disk" instead
  of a silent overwrite. Saves to one note, canvas or base run one at a time.
  A file that isn't UTF-8 is never overwritten, even when it changed to that
  while open. Notes too big for the search index (over 5 MB) get the same
  check: while one is on screen Basalt keeps the text it last saw on disk and
  reads it again after a reconnect, so an edit made elsewhere shows up instead
  of being overwritten, and a save it can't check raises "Changed on disk".
- Saving keeps a note's creation time and permissions, so Dataview's
  `file.ctime` stays put. On macOS it also keeps Finder tags, "Open with" and
  other extended attributes.
- The web server keeps a note's owner when it saves, and its Docker setup runs
  as the vault's owner. Run as root, a save left a private note readable only
  by root, so unison stopped syncing it.
- "Keep mine" on a note that was deleted elsewhere writes your text back
  instead of discarding it.
- A save that fails while offline, with the server down or on an expired login
  is tried again on a backoff, and at once when the connection or the app comes
  back, so it no longer waits for your next keystroke.
- A canvas edited while a rename fixes its links keeps the edit (the link fix
  is reported as failed instead), and an open canvas or base keeps checking
  for outside edits after many other notes are saved or moved.
- Today's daily note, a duplicated note and a plugin's new note get their text
  only while still empty, so anything typed into them first stays.
- Editing a property in the Properties panel after closing the note's tab saves
  the change instead of dropping it. The status bar's word count and the
  Backlinks panel's Link buttons keep working after clicking a side panel.
- A folder can be renamed to a name that starts with its own ("Notes" to
  "Notes old"). A canvas edited while a rename writes its link fix keeps the
  edit and the fix. Bookmarks toggled at the same moment from
  two places are all kept.
- Typing while a note is being renamed no longer recreates the old file or
  drops what you typed, even a keystroke that lands while the editor is rebuilt
  for the new name, and the caret stays where you were typing. Edits
  still carrying a renamed note's old path follow it only until the editors
  have redrawn, so a new note that later takes the old name, in any pane or
  stacked column, never writes into the renamed one. Text typed while a rename
  or folder move rewrites links is saved, without a false conflict, and gets
  the same link fix.
- After a rename, focus stays where you put it: an editor rebuilt for the new
  name, in a pane or a stacked column, takes focus only if it had it, and Enter
  in the inline title goes back to the note. A second rename or folder move
  waits for the first to finish fixing links, so renaming a note back right
  away leaves every link right, and a rename queued behind it follows the note
  if it moved; a new title keeps the note in the folder it was moved to, and a
  note dragged to a folder keeps a new title still being applied.
  Renaming a note shown in a stacked column keeps the text being typed there
  and its caret, and renaming a note opened from a search hit no longer sends
  the caret back to that line. Escape in the inline title cancels the rename, and after
  renaming from the file tree, focus is on the renamed note.
- A rename or folder move fixes links in notes being typed into inside their
  open editors, so typing in progress, even straight through the end of the
  pass, merges with the fix instead of undoing it or moving a character. Such
  notes are no longer skipped with "link updates failed". An edit made elsewhere
  just before the pass reads a note is kept, with the fix, or raises "Changed
  on disk" if you were typing in it.
- Text changed on disk lands in an open editor as separate small edits, so
  the caret stays where it was, even when lines above and below it changed.
- After "Keep mine" writes back a note deleted elsewhere, later edits save
  normally, and focus returns to the editor after Keep mine or Reload.
- A note created or renamed while the vault was being re-read keeps saving:
  the app reads again instead of taking a listing that predates the change. A save to a
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
  has is lost or retyped. Aliases and tags written `a, b` stay separate items.
  With the caret at the very top, the body goes after the note's properties.
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
  `![](Media/pic.png)`, not only `![[...]]` embeds, including files with `#`
  in the name (`a%23b.png`). Renaming a note named like the part before that
  `#` no longer turns such a link into a link to the note.
- Markdown-style images whose path is percent-encoded, as Obsidian writes
  spaces (`![](Media/shot%20one.png)`), show in Live Preview and Reading view
  instead of as missing.
- Renaming a note to the name of a note it links to keeps that link on the
  other note (written with its folder) instead of turning it into a self-link.
- Daily notes created from the Calendar fill `{{time}}` with the current time,
  and the plugin's own folder setting applies when the vault has no Daily
  notes settings.
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
- An image in an HTML block shows the vault's file.
- Moving or renaming a note no longer rewrites notes whose links come out the
  same, so a move leaves those files, and their dates, alone.
- Pasting HTML keeps what it held: a nested list in the shape Chromium writes,
  code and quotes inside list items, inline code holding backticks, a code
  block holding a fence, tables inside cells, captions, merged cells,
  highlights, links with parentheses and lists starting at 0. Google Docs bold
  and italics come across, and code copied from an editor stays plain text.
- With a section folded, a selection over it deletes (Cmd-A then Backspace,
  Cut), Shift-Tab dedents it, and typing after its placeholder opens it so the
  text shows where it went.
- HTML blocks in Live Preview update when the line after one, or the first
  line of the note, changes.
- Links inside an embed in Live Preview open.
- Backspace after a quote marker inside a list item (`- > q`) removes the
  marker.
- Back and forward follow a renamed note, skip the note already showing, and
  work while a sidebar has the focus.
- Numbered lists renumber across a line that carries on the item above it, and
  the items left under an outdented item count from 1.
- `%%` inside an indented code block stays as written, in both views.
- Renaming a note with hundreds of links to it is about four times faster
  (316 linking notes: 12 s down to 3 s here): the file tree no longer rebuilds
  for each fixed note, sorts faster, and links are fixed in several notes at
  once.
- The web app loads a vault sooner: the server compresses at a faster gzip
  level for a few percent more bytes.
- A vault re-read that overlaps a rename keeps the links the rename fixed, so
  renaming the same file again no longer leaves links to a name that's gone.
- With a section folded, an edit that would change its hidden text without a
  selection reaching past it (Shift+End then Backspace or typing, Cut, moving
  a line, Cmd-B) opens the section instead and changes nothing.
- Typing in a canvas card is kept when a rename or move of the canvas, waiting
  behind another, runs.
- Searches with `[…]` or `(…)` in a regex, a quoted phrase or a `[[link]]` work
  again, and the totals count every matching line and note.
- Pasted code keeps its line breaks (as IntelliJ-family editors copy it), and
  spaces at a link's edges stay outside it.
- Link all leaves math, comments, indented code and HTML alone.
- Backspace never cuts a list or quote marker in part, and Tab leaves a list
  that follows an HTML, table or `$$` line alone.
- A rename's report of notes it couldn't fix stays on screen instead of giving
  way to the next save's "Saved".
- In Dataview JS, `moment(…).isBefore("2026-08-01")` and the other comparisons
  read a date given as text instead of always answering false.
- Renames and moves fix links in canvas text cards too, as Obsidian does. A
  card's links are read from the canvas's own folder, so moving a folder or
  renaming an image no longer repoints one that still finds its file.
- The editor menu's Cut and Paste, template inserts and plugin inserts can't
  change a folded section's hidden text either, and a triple-click on a folded
  heading no longer counts as selecting what it hides.
- Link all also leaves callout types, footnote references, link reference
  definitions, reference links (`![][label]`), email addresses and autolinks
  (`<key:value>`) alone, never writes into a linked image, a URL holding an
  `@` or a link's address, and no longer skips prose that holds a `<`
  (`null<Date`), or text after a `$$` written in code or a comment.
- Code fenced inside a quote or callout is code: Link all and renames leave
  its text alone, and its links aren't counted.
- Search keeps a quoted phrase, a `[[link]]` or a regex whole inside `line:()`,
  `task:()` and `section:()`, even against the brackets (`line:("a b" c)`),
  reads `line:"a phrase"`, excludes a phrase with `-"a phrase"`, and counting
  every result costs little.
- Numbered lists renumber after any edit (deleting an item, typing a new one,
  moving a line, Tab and Shift-Tab), as in Obsidian, in quotes and callouts
  too, but only lines that render as list items: a numbered line in code
  (```markdown fences included), math, a comment, frontmatter or a paragraph
  is left as typed. Items under a 3-space indent count as nested, `01.` keeps
  its zero, a list an edit splits in two keeps its numbers, and a number in a
  closed fold isn't changed.
- A misspelled Dataview query type (`TABLEX`) is reported instead of running as
  a table of every note.

### Security

- The web build sends a Content Security Policy: scripts only from the server
  itself, nothing may frame it, no `<base>` or form tricks, plus `nosniff` and
  `no-referrer`. `'unsafe-eval'` remains only until plugins load as modules.
  CSS snippets can no longer `@import` styles or fonts from other sites there.
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

## [0.1.0]: first public alpha

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
- macOS, Windows, Linux (Tauri 2: Rust core + system WebView).

### Not included (by design)

Obsidian Sync/Publish, the mobile app, and Obsidian's community plugins
(Basalt has its own plugin API). See [ARCHITECTURE.md](./ARCHITECTURE.md).

[0.1.0]: https://github.com/oweneldridge/basalt/releases/tag/v0.1.0
