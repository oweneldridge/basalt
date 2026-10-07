// `%%comment%%` in Live Preview: shown dimmed, `%%` and all, as Obsidian's
// Live Preview shows them (only Reading view and export leave them out). They
// may run over several lines, so the whole note is scanned, again only when
// an edit adds or removes a `%`, a backtick or a `~`, or edits a line with one.
import { StateField } from "@codemirror/state";
import type { Text } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { commentRanges } from "../lib/render";

const DIM = Decoration.mark({ class: "cm-comment" });

function scan(doc: Text): DecorationSet {
  return Decoration.set(commentRanges(doc.toString()).map(([from, to]) => DIM.range(from, to)));
}

export const comments = StateField.define<DecorationSet>({
  create: (state) => scan(state.doc),
  update(deco, tr) {
    if (!tr.docChanged) return deco;
    let rescan = false;
    const start = tr.startState.doc;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (rescan) return;
      rescan =
        /[%`~]/.test(start.sliceString(fromA, toA) + inserted.toString()) ||
        /[%`~]/.test(start.lineAt(fromA).text) ||
        /[%`~]/.test(start.lineAt(toA).text);
    });
    return rescan ? scan(tr.state.doc) : deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
