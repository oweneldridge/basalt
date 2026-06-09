// Wikilinks: [[Target]] and [[Target|Alias]].
//
// CommonMark has no wikilink node, so we scan the visible text rather than rely
// on the grammar. When the cursor is outside a link we replace it with a
// styled, clickable widget showing the alias/target; when the cursor is inside
// we leave the raw text visible (just tinted) so it can be edited. We also add
// a `[[`-triggered autocomplete sourced from the vault's note names.
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
import { wikilinkRegex } from "../lib/markdown";
import { isInExcludedRegion } from "./regions";

export interface WikilinkOptions {
  /** Current vault note names, for autocomplete. */
  getNotes: () => string[];
  /** Called when a wikilink is clicked. */
  onOpen: (target: string) => void;
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

function wikilinkCompletions(getNotes: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[[^[\]]*/);
    if (!before) return null;
    // Don't pop up on a bare `[[` unless the user is actively there.
    if (before.from + 2 > context.pos) return null;
    return {
      from: before.from + 2,
      options: getNotes().map((name) => ({
        label: name,
        type: "text",
        apply: `${name}]]`,
      })),
      filter: true,
    };
  };
}

export function wikilinks(options: WikilinkOptions): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
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

  return [plugin, click, autocompletion({ override: [wikilinkCompletions(options.getNotes)] })];
}
