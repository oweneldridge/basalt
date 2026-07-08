# Design: movable views / leaves

Status: proposal — not started. This is the last open item on `ROADMAP-parity.md`
and the only genuinely large one. The point of this doc is to decide **whether**
to do the full version before writing any of it.

## What "movable leaves" means

In Obsidian every panel is a *leaf* in one workspace tree. The file explorer,
search, backlinks, outline, an open note — all the same kind of thing. You can
drag any of them anywhere: split the editor, stack a view as a tab next to a
note, move the outline from the right sidebar to the left, pop a note out to its
own window. There is no privileged "sidebar" — the sidebars are just the left
and right regions of the one tree.

Basalt is not built that way, and mostly for good reasons (see below). The
question is how much of that flexibility is worth the rework.

## Where Basalt is today

The shell is fixed (`src/App.tsx`, the `return` around the `.workspace` div):

```
.app (column)
  .workspace (row)
    <Ribbon/>                     fixed strip of icons
    <Sidebar/>      + resizer     file tree + search filter
    <PaneTree/>                   the editor region — the only movable part
    resizer + <RightPanel/>       tabbed: Properties / Backlinks / Links /
                                  Outline / Tags / Bookmarks / plugin views
  <StatusBar/>
```

The editor region **is** a proper layout tree already:

- `src/lib/workspace.ts` — `LayoutNode = leaf{id} | split{dir,sizes,children}`,
  plus `splitLeaf(before)`, `removeLeaf`, `setSizes`, `neighborLeaf`.
- `src/components/PaneTree.tsx` — renders that tree as nested flex splits with
  drag resizers. Fully generic; doesn't care what a leaf contains.
- A `leaf.id` maps to a `Pane` (`{ tabs, active, doc, pinned, linked, stacked }`).
  A pane's tabs are **all notes** — the tab model is homogeneous.

Recently shipped and relevant: **drag-a-tab-to-split** (drop a tab on a pane
edge → `splitLeaf` + move the tab), tab drag-between-panes, the tab context menu,
`registerView` (plugin views live as extra tabs *inside* `RightPanel`).

Multi-window: `openNewWindow(vault)` → the `open_new_window` Tauri command opens
a **brand-new App instance** with `?vault=`. Windows share nothing but the vault
on disk. There is no cross-window workspace state.

## The gap, precisely

1. **The two sidebars are outside the layout tree.** They're their own
   components with their own fixed slots. A view can't leave its region.
2. **The tab model is note-only.** `Pane.tabs: string[]` (note paths). A leaf
   can't hold a "backlinks" tab next to a note tab.
3. **No drag-to-new-window.** `openNewWindow` exists but nothing moves a tab out.

## Three ways to close it

### Option A — full unification (the Obsidian model)

One workspace tree with three root regions (left / center / right), each a
`LayoutNode` subtree. Every panel becomes a typed leaf:

```ts
type ViewSpec =
  | { type: "editor" }               // holds note tabs, as today
  | { type: "filetree" }
  | { type: "search" }
  | { type: "backlinks" | "outline" | "properties" | "tags" | "bookmarks" }
  | { type: "plugin"; viewId: string };
type Leaf = { kind: "leaf"; id: string; views: ViewSpec[]; active: number };
```

`renderPane(id)` becomes `renderLeaf(leaf)` dispatching on the active view's
type. Tab bars generalize to hold heterogeneous tabs. `Sidebar` / `RightPanel`
stop being components and become *content renderers* mounted inside leaves.
Drag/drop (already ~70% built for note tabs) extends to view tabs.

What this buys: true "drag anything anywhere," outline-in-left-sidebar, a
backlinks pane split under a note, plugin views that aren't stuck in the right
panel.

What it costs:
- **Workspace schema change + migration.** The persisted per-vault workspace
  (localStorage) changes shape. The restore path (`src/App.tsx` ~line 1118) must
  version-bump and *fall back to the default 3-zone layout* on any old or
  malformed data — never throw, never strand a user with no sidebar.
- **Rewrites** `Pane`, the tab bar, `Sidebar`, `RightPanel`, the layout
  render, and the drag/drop model.
- **New invariants to hold:** you can't close the last editor region into
  nothing; a region emptied of views should collapse gracefully; focus/active-
  leaf semantics get more complex (the right panel currently just follows the
  focused editor — with movable views, "which note does this backlinks leaf
  track" needs an answer).
- Effort: **XL.** This is the single biggest change in the codebase to date —
  multi-session, and the kind of thing that quietly breaks pane persistence for
  a week if rushed.

### Option B — incremental, keep the three zones

Don't unify. Deliver the slivers that give most of the "movable" feel:

- **B1. Drag a note tab to a new window.** `openNewWindow(vault)` already works;
  moving a tab = open a new window for this vault, open the note there (it reads
  from disk), close the local tab. Note-tabs only — a view can't meaningfully
  move to another window (each window tracks its own active note). Effort: **S–M.**
- **B2. Relocate a right-panel view to the left sidebar (and back).** Let the
  user choose which region hosts Outline / Backlinks / etc. — a per-view "dock
  left/right" toggle, persisted. No tree rework; just a `region` field per view.
  Effort: **M.**
- **B3. Open a view as a center tab.** "Open Backlinks/Graph in a new tab" —
  the view renders in the editor region as a full-width leaf. Needs the tab
  model to accept *one* non-note tab type; smaller than full A. Effort: **M.**

Option B keeps the persistence schema stable-ish (additive fields), keeps the
data-safety surface tiny, and ships value in days not weeks.

### Option C — unify the sidebars only

Turn *just* the left and right regions into small `LayoutNode` trees (so views
within a sidebar can stack/split/reorder) while the root shell stays fixed at
left | center | right. Middle ground: you can put Outline above Backlinks in the
right panel, or drag Search into the left sidebar, but you can't dissolve the
three-zone frame. Reuses `PaneTree`/`workspace.ts` for the sidebars. Effort: **L.**

## Recommendation

**Do Option B now; treat Option A as a separate, explicitly-scoped project only
if free-form panels become a real need.**

Reasoning:
- The fixed three-zone shell already covers essentially all daily use. The
  concrete complaints that motivated the parity review (panes not
  resizable/splittable, no tab drag) are **already fixed**.
- Option A's cost is dominated by *persistence migration + rewiring every panel*,
  and its benefit is mostly ergonomic rearrangement most users set once. That's
  a poor churn-to-value trade for an anti-enshittification tool whose selling
  point is "boring, stable, yours."
- B1 (drag-tab-to-new-window) is the single highest-value missing bit and is
  cheap — it's the one thing you actually reach for that isn't there.

Suggested order if you take B: **B1 → B3 → B2**, each its own commit with the
usual gate (tsc + vitest + cargo + e2e + harness verify). Stop after any one; they
don't depend on each other.

## If Option A is chosen anyway — phasing to de-risk it

Never land it as one commit. Phase behind the existing e2e harness:

1. **Model only.** Add `ViewSpec`/typed leaves to `workspace.ts` with the editor
   as the sole view type. Migrate persistence with a version bump + default-layout
   fallback. Ship with zero visible change; prove old workspaces still restore.
2. **Render dispatch.** `renderLeaf` switches on view type; editor path unchanged.
3. **Move the right panel in.** Right-panel tabs become view leaves in a fixed
   right region. Delete `RightPanel`'s bespoke tab bar; reuse the generic one.
4. **Move the sidebar in.** File tree / search become view leaves in the left
   region.
5. **Cross-region drag.** Extend the existing tab/edge drag to view tabs.
6. **Drag-to-new-window** (= B1, independent).

Each phase is independently shippable and independently revertible. Gate every
phase on: old persisted workspaces restore to *something usable*, and a fresh
vault gets the default 3-zone layout.

## Data-safety notes (apply to any option)

- Layout state is per-vault localStorage; it never touches note content, so the
  blast radius is "a weird-looking workspace," not "lost notes." Keep it that way
  — no option here should make a layout bug able to delete or overwrite a file.
- The restore path must be total: unknown/old/corrupt workspace JSON →
  default layout, log nothing scary, never a blank window.
- Persisted-schema changes need a `version` field and a one-way migration that
  fails safe to the default.

## Decision points for Owen

1. Is free-form "drag any panel anywhere" something you'd actually use, or is the
   three-zone shell fine and you just want **B1 (tab → new window)**?
2. If not-A: do you want just **B1**, or also **B3** (view-as-center-tab) and
   **B2** (dock a view to the other sidebar)?
3. If A: are you OK with a multi-session effort behind feature-phased commits,
   accepting some churn in pane persistence during the transition?

---

## Outcome (implemented)

Option A shipped across five phases (commits `faa193e` → `db7f071`):

1. **Versioned, view-aware persistence** — `leafViews.ts` (view tabs as NUL
   sentinels), workspace `version` field, total fail-safe restore.
2. **Render dispatch** — a pane's tabs can be notes or views; `renderLeafView`
   dispatches; view leaves track the last active note.
3. **Right panel → dock leaf** — the fixed `RightPanel` retired; its views live
   as tabs in a right dock; plugin views auto-sync.
4. **File explorer → dock leaf** — the fixed `Sidebar` retired; the shell is now
   one layout tree (file tree | editor | right panel).
5. **Cross-region drag** — free because the drag machinery is pane-agnostic: any
   view or note tab drags into any region or splits anywhere.

The v3 migration grafts docks onto old workspaces once and respects a v3 layout
thereafter (closed docks stay closed). Layout state never touches note content,
so the data-safety bound held.

**Still open (intentionally, was B1):** drag a tab *out to a new window* — each
window is its own App instance, so this is an open-new-window + move, not part of
the single-window leaf model.
