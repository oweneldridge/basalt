// Wikilinks: [[Target]] and [[Target|Alias]].
//
// CommonMark has no wikilink node, so we scan the visible text rather than rely
// on the grammar. When the cursor is outside a link we replace it with a
// styled, clickable widget showing the alias/target; when the cursor is inside
// we leave the raw text visible (just tinted) so it can be edited.
//
// Decorations and autocompletion are SEPARATE extensions: source mode turns the
// decorations off but keeps `[[` completion (matching Obsidian).
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import {
  autocompletion,
} from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { normalizeName, wikilinkRegex } from "../lib/markdown";
import { linkTargetForFormat, type LinkFormat } from "../lib/rename";
import { isInExcludedRegion, treeChanged } from "./regions";

/** What completion needs to know about a note. */
export interface NoteRef {
  name: string;
  /** Vault-relative path including `.md`. */
  rel: string;
}

export interface WikilinkDecorationOptions {
  /** Called when a wikilink is clicked. */
  onOpen: (target: string) => void;
}

export interface WikilinkCompletionOptions {
  getNotes: () => NoteRef[];
  /** Obsidian's newLinkFormat setting (default "shortest"). */
  getLinkFormat: () => LinkFormat;
  /** Rel (with .md) of the note being edited — for "relative" format. */
  getActiveRel: () => string | null;
}

class WikilinkWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly display: string,
  ) {
    super();
  }
  eq(other: WikilinkWidget): boolean {
    return other.target === this.target && other.display === this.display;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-wikilink";
    span.textContent = this.display;
    span.dataset.target = this.target;
    span.setAttribute("role", "link");
    span.title = this.target;
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = view.state.selection;
  const touches = (from: number, to: number): boolean =>
    sel.ranges.some((r) => r.from <= to && r.to >= from);

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const re = wikilinkRegex();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      // Don't render wikilinks inside code blocks or inside a table's block
      // widget (tables.ts already renders their cells) — would corrupt source
      // or double-render.
      if (isInExcludedRegion(view.state, start)) continue;
      // A `[[…]]` preceded by `!` is an embed — handled by embeds.ts.
      if (view.state.doc.sliceString(start - 1, start) === "!") continue;
      const target = m[1].trim();
      const display = (m[2] ?? m[1]).trim();
      if (touches(start, end)) {
        builder.add(start, end, Decoration.mark({ class: "cm-wikilink-source" }));
      } else {
        builder.add(start, end, Decoration.replace({ widget: new WikilinkWidget(target, display) }));
      }
    }
  }
  return builder.finish();
}

function wikilinkCompletions(opts: WikilinkCompletionOptions) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[[^[\]]*/);
    if (!before) return null;
    // Don't pop up on a bare `[[` unless the user is actively there.
    if (before.from + 2 > context.pos) return null;
    const notes = opts.getNotes();
    // NOTE: do NOT return a `to` past the cursor — CodeMirror silently rejects
    // such results and the popup never shows. Any closer already present (from
    // closeBrackets auto-closing `[[` to `[[]]`, or editing an existing link)
    // is absorbed at APPLY time instead, so `Name]]` can't become `[[Name]]]]`.
    return {
      from: before.from + 2,
      options: notes.map((note) => ({
        label: note.name,
        detail: note.rel,
        type: "text",
        apply: (view: EditorView, _completion: unknown, from: number, to: number) => {
          // Link text per the vault's newLinkFormat (read at apply time).
          const relNoExt = note.rel.replace(/\.md$/i, "");
          const taken =
            notes.filter((n) => normalizeName(n.name) === normalizeName(note.name)).length > 1;
          const target = linkTargetForFormat(
            opts.getLinkFormat(),
            relNoExt,
            taken,
            opts.getActiveRel(),
          );
          const after = view.state.sliceDoc(to, to + 2);
          const closeLen = after === "]]" ? 2 : after.startsWith("]") ? 1 : 0;
          view.dispatch({
            changes: { from, to: to + closeLen, insert: `${target}]]` },
            selection: { anchor: from + target.length + 2 },
            userEvent: "input.complete",
          });
        },
      })),
      filter: true,
    };
  };
}

/** The rendered-link layer (gated off in source mode). */
export function wikilinkDecorations(options: WikilinkDecorationOptions): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged || treeChanged(update)) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const click = EditorView.domEventHandlers({
    mousedown: (event) => {
      const el = event.target as HTMLElement | null;
      if (el && el.classList.contains("cm-wikilink") && el.dataset.target) {
        options.onOpen(el.dataset.target);
        event.preventDefault();
        return true;
      }
      return false;
    },
  });

  return [plugin, click];
}

/** The `[[` completion layer (always on, like Obsidian's source mode). */
export function wikilinkAutocomplete(options: WikilinkCompletionOptions): Extension {
  return autocompletion({ override: [wikilinkCompletions(options)] });
}

/** Cmd/Ctrl-click on raw `[[link]]` TEXT follows it — works in source mode
 * where the decoration widgets (and their click handler) are disabled. */
export function wikilinkModClickFollow(onOpen: (target: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (!(event.metaKey || event.ctrlKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const line = view.state.doc.lineAt(pos);
      const re = wikilinkRegex();
      let m: RegExpExecArray | null;
      while ((m = re.exec(line.text))) {
        const start = line.from + m.index;
        const end = start + m[0].length;
        if (pos >= start && pos <= end) {
          onOpen(m[1].trim());
          event.preventDefault();
          return true;
        }
      }
      return false;
    },
  });
}
