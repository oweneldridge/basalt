# Embedded bases

- Render a base inside a note, as Obsidian 1.9+ does: `![[Tasks.base]]`,
  `![[Tasks.base#Open]]` (a named view) and a fenced `base` code block holding
  the YAML inline.
- Support `this`, which points at the embedding note, so a daily note or project
  page can show "tasks linking to this note" without a per-note base.
- First version is read-only: no writes to the `.base` file or the note, so it
  adds no new write path. View tabs switch locally.
- The existing `BaseView` renders every surface (Live Preview, Reading view,
  opened `.base` files); without `onChange` it is already read-only. Embeds
  mount it with `createRoot`.
- Size: medium. Pure engine change (`this`) plus two renderers and their tests.

## What Obsidian does

From the Bases help pages (syntax, views) and the 1.9 to 1.10 changelogs:

- `![[File.base]]` embeds the base with its first view; `![[File.base#View]]`
  picks a view by name.
- A `base` code block contains the same YAML as a `.base` file.
- `this` is the file a base is shown for: the embedding note (or canvas) when
  embedded, the base file itself when opened directly, the active file when in
  the sidebar. Since 1.9.14 it is null when none applies.
- Embedded bases are interactive in Obsidian, and view changes save back to the
  `.base` file. That part is out of scope here.

## Engine (`src/lib/bases.ts`)

- `runView` and `evalExpr` take an optional `thisRow: BaseRow | null`.
- `this` is a new root name, like `file` and `note`: `this.file.name`,
  `this.file.path`, `this.status`, `this["dashed-key"]`, and
  `file.hasLink(this.file)` / `file.linksTo(this)` all work by reusing the
  existing `FileVal` member code against `thisRow`.
- With no `thisRow`, `this` evaluates to null, matching Obsidian 1.9.14.
- The expression editor's autocomplete learns `this`.

## Rendering

- `BaseView` gains `initialView` (the `#View` name) and `thisRel` (defaults to
  the base file itself).
- `src/lib/baseEmbedHost.ts`: a small host singleton App installs, like the
  transclusion and query hosts. It hands the renderer the notes, attachments,
  structure version, index accessors (tags, links, backlinks, embeds), file
  reads, file opening and image resolution, and carries the "vault changed"
  signal. It doesn't import the renderer, so the YAML engine stays lazy.
- `src/lib/baseEmbed.tsx` (loaded on first use): `mountBaseEmbed(el, source,
  thisRel)` creates a React root and returns an unmount function. `source` is
  `{ target: "File.base#View" }` or `{ yaml }`. Roots whose element has left the
  page are swept on the next vault change.
- Live Preview: `transcludeBlocks.ts` routes a `.base` target to a base widget;
  a new `baseBlocks.ts` StateField renders `base` fences (caret inside shows the
  YAML, like `query.ts`). `base` joins the reserved code-block languages so a
  plugin can't take it over.
- Reading view: `![[x.base]]` already becomes a transclusion marker and is
  routed to the base renderer; `code.language-base` is post-processed like
  `dataview` blocks.
- An opened `.base` file passes its own row as `thisRow`.

## Safety and limits

- Read-only, so no conflict or compare-and-swap handling is needed.
- The evaluator's existing step, allocation and wall-clock budgets apply per
  embed. Embeds share the per-note row cache.
- A malformed base shows the parse error in place of the table, inside the
  existing `ErrorBoundary`.
- Not in this version: saving view edits, embedding in canvases, the list
  layout, and Obsidian's `this` for the sidebar.

## Tests

- Unit: `this` in filters and formulas, null when absent; `#View` selection;
  inline YAML parsing.
- Mock e2e: a note with a `base` block and one with `![[Tasks.base#View]]`
  render rows; editing the note re-renders; the block reveals its YAML when the
  caret enters.
- Real-disk e2e: the same against basalt-server, plus a check that nothing is
  written.
