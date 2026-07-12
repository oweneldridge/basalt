// Live Preview for raw-HTML blocks (e.g. Obsidian daily-note headers like
// `<font color=…><center>…</center></font>`): render the sanitized HTML when
// the caret is outside the block, reveal the raw markup for editing when it's
// inside. A block replacement, so it comes from a StateField. Block boundaries
// come from the same scanner the Reading view uses, so both agree.
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { htmlBlockRanges } from "../lib/htmlBlocks";
import { sanitizeHtml } from "../lib/sanitize";

class HtmlBlockWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: HtmlBlockWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-html-block";
    wrap.innerHTML = sanitizeHtml(this.source); // DOMPurify — no scripts/styles/handlers
    return wrap;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function compute(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = state.selection;
  const doc = state.doc;
  for (const range of htmlBlockRanges(doc.toString())) {
    const from = doc.line(range.fromLine + 1).from;
    const to = doc.line(range.toLine + 1).to;
    // Editing inside the block → leave it raw.
    if (sel.ranges.some((r) => r.from <= to && r.to >= from)) continue;
    const source = doc.sliceString(from, to);
    builder.add(from, to, Decoration.replace({ widget: new HtmlBlockWidget(source), block: true }));
  }
  return builder.finish();
}

const htmlBlockField = StateField.define<DecorationSet>({
  create: (state) => compute(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? compute(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

// Click the rendered HTML to place the caret inside the block (reveal raw).
const htmlBlockClick = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    const el = (event.target as HTMLElement | null)?.closest(".cm-html-block") as HTMLElement | null;
    if (!el) return false;
    const pos = view.posAtDOM(el);
    const line = view.state.doc.lineAt(Math.min(pos + 1, view.state.doc.length));
    view.dispatch({ selection: { anchor: line.from } });
    event.preventDefault();
    return true;
  },
});

export const htmlBlock: Extension = [htmlBlockField, htmlBlockClick];
