// A click just outside a rendered block (a pixel row along its edge, or the
// gutter beside it) resolves to the start or end of the block's hidden source.
// The caret goes on the line beside the block instead, so a key never lands in
// front of its opening markup or after its closing markup. Clicks on the block
// itself are its widget's business.
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Extension, StateField } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";

export function blockEdges(field: StateField<DecorationSet>): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.isUserEvent("select.pointer") || tr.docChanged || !tr.selection) return tr;
    const deco = tr.startState.field(field);
    const doc = tr.startState.doc;
    let moved = false;
    const ranges = tr.newSelection.ranges.map((r) => {
      if (!r.empty) return r;
      let pos = r.head;
      deco.between(r.head, r.head, (from, to, d) => {
        if (!d.spec.block) return;
        if (r.head === to && to < doc.length) pos = doc.lineAt(to + 1).from;
        else if (r.head === from && from > 0) pos = doc.lineAt(from - 1).to;
      });
      if (pos === r.head) return r;
      moved = true;
      return EditorSelection.cursor(pos);
    });
    if (!moved) return tr;
    return [tr, { selection: EditorSelection.create(ranges, tr.newSelection.mainIndex), sequential: true }];
  });
}
