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
  keymap,
} from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import {
  autocompletion,
} from "@codemirror/autocomplete";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { internalLinkTarget, mdLinkRegexGlobal, normalizeName, parseMarkdownLink, wikilinkRegex } from "../lib/markdown";
import { linkTargetForFormat, type LinkFormat } from "../lib/rename";
import { isInExcludedRegion, treeChanged } from "./regions";
import { notePathFacet } from "./query";
import { linkResolves } from "../lib/transclude";

/** What completion needs to know about a note. */
export interface NoteRef {
  name: string;
  /** Vault-relative path including `.md`. */
  rel: string;
  /** When set, this entry is a frontmatter ALIAS of the note named here; `name`
   * is the alias text and picking it inserts `[[alias]]` (which resolves). */
  alias?: string;
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
  /** Headings of the note named/aliased `name` — for `[[Note#…` completion. */
  getHeadings: (name: string) => string[];
  /** Block ids (id + line snippet) of a note — for `[[Note#^…` completion. */
  getBlockIds: (name: string) => { id: string; snippet: string }[];
}

class WikilinkWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly display: string,
    readonly unresolved = false,
  ) {
    super();
  }
  eq(other: WikilinkWidget): boolean {
    return other.target === this.target && other.display === this.display && other.unresolved === this.unresolved;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.unresolved ? "cm-wikilink is-unresolved" : "cm-wikilink";
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
  const self = view.state.facet(notePathFacet);

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
        const widget = new WikilinkWidget(target, display, !linkResolves(target, self));
        builder.add(start, end, Decoration.replace({ widget }));
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

    // `[[Note#…` → suggest Note's headings; `[[Note#^…` → its block ids.
    const hash = before.text.indexOf("#");
    if (hash >= 0) {
      const noteName = before.text.slice(2, hash).trim();
      const partial = before.text.slice(hash + 1);
      // Shared apply: replace the completed span with `text]]` (absorbing any
      // closer already present, same as the note-name path).
      const applyText = (text: string) =>
        (view: EditorView, _c: unknown, from: number, to: number) => {
          const after = view.state.sliceDoc(to, to + 2);
          const closeLen = after === "]]" ? 2 : after.startsWith("]") ? 1 : 0;
          view.dispatch({
            changes: { from, to: to + closeLen, insert: `${text}]]` },
            selection: { anchor: from + text.length + 2 },
            userEvent: "input.complete",
          });
        };
      if (partial.startsWith("^")) {
        const blocks = opts.getBlockIds(noteName);
        if (blocks.length === 0) return null;
        return {
          from: before.from + hash + 2, // after `#^`
          options: blocks.map((b) => ({
            label: b.id,
            detail: b.snippet,
            type: "text",
            apply: applyText(b.id),
          })),
          filter: true,
        };
      }
      const headings = opts.getHeadings(noteName);
      if (headings.length === 0) return null;
      return {
        from: before.from + hash + 1,
        options: headings.map((h) => ({
          label: h,
          type: "text",
          apply: applyText(h),
        })),
        filter: true,
      };
    }

    const notes = opts.getNotes();
    // Insert `target]]`, absorbing any closer already present at APPLY time
    // (so `Name]]` can't become `[[Name]]]]`). NOTE: never return a `to` past
    // the cursor — CodeMirror silently rejects such results (popup never shows).
    const insert = (target: string) => (view: EditorView, _c: unknown, from: number, to: number) => {
      const after = view.state.sliceDoc(to, to + 2);
      const closeLen = after === "]]" ? 2 : after.startsWith("]") ? 1 : 0;
      view.dispatch({
        changes: { from, to: to + closeLen, insert: `${target}]]` },
        selection: { anchor: from + target.length + 2 },
        userEvent: "input.complete",
      });
    };
    const options: Completion[] = notes.map((note) => ({
      label: note.name,
      detail: note.alias ? `alias of ${note.alias}` : note.rel,
      type: note.alias ? "keyword" : "text",
      apply: (view: EditorView, _completion: unknown, from: number, to: number) => {
        // An alias resolves by its own text — insert it verbatim. Otherwise
        // compute the link per the vault's newLinkFormat (read at apply time).
        const relNoExt = note.rel.replace(/\.md$/i, "");
        const taken = notes.filter((n) => normalizeName(n.name) === normalizeName(note.name)).length > 1;
        const target = note.alias
          ? note.name
          : linkTargetForFormat(opts.getLinkFormat(), relNoExt, taken, opts.getActiveRel());
        insert(target)(view, _completion, from, to);
      },
    }));
    // Offer "Create <typed name>" when nothing matches exactly (Obsidian). The
    // note is created lazily when the inserted `[[name]]` link is clicked.
    const typed = before.text.slice(2).trim();
    if (typed && !notes.some((n) => normalizeName(n.name) === normalizeName(typed))) {
      // Matched on a label that can't be a prefix match, so any note whose name
      // starts with what was typed ranks above it; shown as the typed name.
      options.push({ label: `\u200b${typed}`, displayLabel: typed, detail: "Create new note", type: "text", boost: -99, apply: insert(typed) });
    }
    return { from: before.from + 2, options, filter: true };
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

/** Alt-Enter follows the link under the caret (Obsidian's default for "Follow
 * link under cursor"): a wikilink, a markdown link, or a bare URL. */
export function followLinkAtCursor(onOpen: (target: string) => void, onOpenUrl: (url: string) => void): Extension {
  return keymap.of([
    {
      key: "Alt-Enter",
      run: (view) => {
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        const at = pos - line.from;
        const hit = (re: RegExp, f: (m: RegExpExecArray) => void) => {
          let m: RegExpExecArray | null;
          while ((m = re.exec(line.text))) {
            if (at >= m.index && at <= m.index + m[0].length) {
              f(m);
              return true;
            }
          }
          return false;
        };
        return (
          hit(wikilinkRegex(), (m) => onOpen(m[1].trim())) ||
          hit(mdLinkRegexGlobal(), (m) => {
            const parsed = parseMarkdownLink(m[0].replace(/^!/, ""));
            if (!parsed) return;
            const internal = internalLinkTarget(parsed.href);
            if (internal !== null) onOpen(internal);
            else onOpenUrl(parsed.href);
          }) ||
          hit(/\bhttps?:\/\/[^\s<>()[\]]+/g, (m) => onOpenUrl(m[0]))
        );
      },
    },
  ]);
}

