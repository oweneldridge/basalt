// `%%comment%%` in Live Preview: hide inline comments (like Obsidian's LP),
// revealing them dimmed only when the caret is on the span. Not a lezer node,
// so regex-scan the viewport (the highlight.ts pattern); render.ts already
// strips comments from Reading mode / export.
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { isInExcludedRegion, treeChanged } from "./regions";

const DIM = Decoration.mark({ class: "cm-comment" });
const CONCEAL = Decoration.replace({});
const COMMENT_RE = /%%[^\n]*?%%/g;

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = view.state.selection;
  const touches = (from: number, to: number): boolean =>
    sel.ranges.some((r) => r.from <= to && r.to >= from);

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    COMMENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COMMENT_RE.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (isInExcludedRegion(view.state, start)) continue;
      if (touches(start, end)) builder.add(start, end, DIM); // editing → show dimmed
      else builder.add(start, end, CONCEAL); // hidden in Live Preview
    }
  }
  return builder.finish();
}

export const comments: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || treeChanged(update)) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
