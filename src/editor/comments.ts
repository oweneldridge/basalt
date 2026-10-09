// `%%comment%%` in Live Preview: shown dimmed, `%%` and all, as Obsidian's
// Live Preview shows them (only Reading view and export leave them out). They
// may run over several lines, so the whole note is scanned, again only when
// an edit adds or removes a `%`, a backtick or a `~`, or edits a line with one.
// A note with a `%%` on an indented line, which may be code, is scanned again
// on every edit, since a blank line or a list marker elsewhere can change it.
import { StateField } from "@codemirror/state";
import type { Text } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { commentRanges, mayHaveIndentedComment } from "../lib/render";

const DIM = Decoration.mark({ class: "cm-comment" });

interface Comments {
  deco: DecorationSet;
  indented: boolean;
}

function scan(doc: Text): Comments {
  const text = doc.toString();
  return {
    deco: Decoration.set(commentRanges(text).map(([from, to]) => DIM.range(from, to))),
    indented: mayHaveIndentedComment(text),
  };
}

export const comments = StateField.define<Comments>({
  create: (state) => scan(state.doc),
  update(value, tr) {
    if (!tr.docChanged) return value;
    let rescan = value.indented;
    const start = tr.startState.doc;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (rescan) return;
      rescan =
        /[%`~]/.test(start.sliceString(fromA, toA) + inserted.toString()) ||
        /[%`~]/.test(start.lineAt(fromA).text) ||
        /[%`~]/.test(start.lineAt(toA).text);
    });
    return rescan ? scan(tr.state.doc) : { deco: value.deco.map(tr.changes), indented: false };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});
