// Live Preview for ```dataview (and ```basalt-query) fenced blocks: render the
// query result when the cursor is outside the block, reveal the raw source for
// editing when it's inside. A block replacement, so it comes from a StateField
// (like mermaid/tables). The result is produced by the QueryHost that App
// installs; the note's own path comes from a per-editor Facet.
import { Facet, RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { renderQuerySource } from "../lib/queryHost";

/** The vault-relative path (with .md) of the note this editor is showing —
 * the `this`/self note for any query block in it. */
export const notePathFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? "",
});

const QUERY_LANGS = new Set(["dataview", "basalt-query", "query"]);

class QueryWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly selfPath: string,
  ) {
    super();
  }
  eq(other: QueryWidget): boolean {
    return other.source === this.source && other.selfPath === this.selfPath;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-query";
    wrap.append(renderQuerySource(this.source, this.selfPath));
    return wrap;
  }
  ignoreEvent(event: Event): boolean {
    // Let clicks (link navigation, checkbox toggle) through to the widget DOM;
    // swallow other events so typing near it doesn't reach the doc oddly.
    return event.type !== "mousedown" && event.type !== "click" && event.type !== "change";
  }
}

function compute(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = state.selection;
  const selfPath = state.facet(notePathFacet);
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      const lang = info ? state.doc.sliceString(info.from, info.to).trim().toLowerCase() : "";
      if (!QUERY_LANGS.has(lang)) return false;
      if (sel.ranges.some((r) => r.from <= node.to && r.to >= node.from)) return false; // editing → raw
      const codeText = node.node.getChild("CodeText");
      const source = codeText ? state.doc.sliceString(codeText.from, codeText.to) : "";
      builder.add(node.from, node.to, Decoration.replace({ widget: new QueryWidget(source, selfPath), block: true }));
      return false;
    },
  });
  return builder.finish();
}

const queryField = StateField.define<DecorationSet>({
  create: (state) => compute(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? compute(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

// Click the rendered block (but NOT an interactive child) to place the caret
// inside for editing.
const queryClick = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    const t = event.target as HTMLElement | null;
    if (!t) return false;
    if (t.closest("a, input, button")) return false; // link / checkbox → let it act
    const el = t.closest(".cm-query") as HTMLElement | null;
    if (!el) return false;
    const pos = view.posAtDOM(el);
    const line = view.state.doc.lineAt(Math.min(pos + 1, view.state.doc.length));
    view.dispatch({ selection: { anchor: line.from } });
    event.preventDefault();
    return true;
  },
});

export const query: Extension = [queryField, queryClick];
