// Live Preview for ```base fenced blocks: the inline base renders as a table
// when the caret is outside the block and shows its YAML when inside, like
// query.ts. The renderer is loaded on first use.
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { notePathFacet } from "./query";
import { blockEdges } from "./blockEdges";

// Keyed by the element: CodeMirror may destroy an `eq` twin of the widget that
// built the DOM.
const unmounts = new WeakMap<HTMLElement, () => void>();

class BaseBlockWidget extends WidgetType {
  constructor(
    readonly yaml: string,
    readonly selfPath: string,
  ) {
    super();
  }
  eq(other: BaseBlockWidget): boolean {
    return other.yaml === this.yaml && other.selfPath === this.selfPath;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-base-block";
    void import("../lib/baseEmbed").then((m) => {
      if (wrap.isConnected) unmounts.set(wrap, m.mountBaseEmbed(wrap, { yaml: this.yaml }, this.selfPath));
    });
    return wrap;
  }
  destroy(dom: HTMLElement): void {
    unmounts.get(dom)?.();
    unmounts.delete(dom);
  }
  ignoreEvent(event: Event): boolean {
    return event.type !== "mousedown" && event.type !== "click";
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
      if (lang !== "base") return false;
      if (sel.ranges.some((r) => r.from <= node.to && r.to >= node.from)) return false; // editing → raw
      const codeText = node.node.getChild("CodeText");
      const yaml = codeText ? state.doc.sliceString(codeText.from, codeText.to) : "";
      builder.add(node.from, node.to, Decoration.replace({ widget: new BaseBlockWidget(yaml, selfPath), block: true }));
      return false;
    },
  });
  return builder.finish();
}

const baseBlockField = StateField.define<DecorationSet>({
  create: (state) => compute(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? compute(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

// Clicking the rendered table (outside its links and buttons) puts the caret
// in the block so the YAML can be edited.
const baseBlockClick = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    const t = event.target as HTMLElement | null;
    if (!t || t.closest("a, input, button, select")) return false;
    const el = t.closest(".cm-base-block") as HTMLElement | null;
    if (!el) return false;
    const pos = view.posAtDOM(el);
    view.dispatch({ selection: { anchor: view.state.doc.lineAt(Math.min(pos + 1, view.state.doc.length)).from } });
    event.preventDefault();
    return true;
  },
});

export const baseBlocks: Extension = [baseBlockField, baseBlockClick, blockEdges(baseBlockField)];
