// Live Preview for ```mermaid fenced blocks: render the diagram when the cursor
// is outside the block, reveal the raw source for editing when it's inside.
// Like tables/frontmatter this is a block replacement, so it must come from a
// StateField. Rendering is async (mermaid is lazy-loaded) and cached, so the
// widget shows a placeholder then fills in.
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { renderMermaid } from "../lib/mermaid";

class MermaidWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: MermaidWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-mermaid";
    wrap.textContent = "Rendering diagram…";
    void renderMermaid(this.source).then((r) => {
      if ("svg" in r) {
        wrap.textContent = "";
        wrap.innerHTML = r.svg; // sanitized by mermaid (securityLevel: strict)
      } else {
        wrap.className = "cm-mermaid cm-mermaid-error";
        wrap.textContent = `Mermaid error: ${r.error}`;
      }
    });
    return wrap;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function compute(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = state.selection;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      const lang = info ? state.doc.sliceString(info.from, info.to).trim().toLowerCase() : "";
      if (lang !== "mermaid") return false;
      // Editing inside the block → leave it raw.
      if (sel.ranges.some((r) => r.from <= node.to && r.to >= node.from)) return false;
      const codeText = node.node.getChild("CodeText");
      const source = codeText ? state.doc.sliceString(codeText.from, codeText.to) : "";
      builder.add(node.from, node.to, Decoration.replace({ widget: new MermaidWidget(source), block: true }));
      return false;
    },
  });
  return builder.finish();
}

const mermaidField = StateField.define<DecorationSet>({
  create: (state) => compute(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? compute(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

// Click the rendered diagram to place the caret inside the block (revealing the
// raw source for editing).
const mermaidClick = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    const el = (event.target as HTMLElement | null)?.closest(".cm-mermaid") as HTMLElement | null;
    if (!el) return false;
    const pos = view.posAtDOM(el);
    const line = view.state.doc.lineAt(Math.min(pos + 1, view.state.doc.length));
    view.dispatch({ selection: { anchor: line.from } });
    event.preventDefault();
    return true;
  },
});

export const mermaid: Extension = [mermaidField, mermaidClick];
