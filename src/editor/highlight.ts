// Obsidian `==highlight==`. Not a lezer node, so we regex-scan the viewport
// (the wikilink.ts pattern): tint the inner text always, and conceal the `==`
// delimiters when the caret isn't on the span.
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { highlightRegex } from "../lib/markdown";
import { isInExcludedRegion } from "./regions";

const MARK = Decoration.mark({ class: "cm-highlight" });
const CONCEAL = Decoration.replace({});

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = view.state.selection;
  const touches = (from: number, to: number): boolean =>
    sel.ranges.some((r) => r.from <= to && r.to >= from);

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const re = highlightRegex();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (isInExcludedRegion(view.state, start)) continue;
      const innerFrom = start + 2;
      const innerTo = end - 2;
      if (touches(start, end)) {
        builder.add(innerFrom, innerTo, MARK);
      } else {
        builder.add(start, innerFrom, CONCEAL);
        builder.add(innerFrom, innerTo, MARK);
        builder.add(innerTo, end, CONCEAL);
      }
    }
  }
  return builder.finish();
}

export const highlight: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
