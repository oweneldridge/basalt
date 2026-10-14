// Backspace right after a list or quote marker removes the marker (CodeMirror's
// deleteMarkupBackward). Upstream, it can take a letter with it on a quote line
// written without a space (`>body` under `> [!note]`), or cut a marker in part
// (`. ` out of `3. `), so its edit is only used when it removes or blanks
// whole markers at the start of the line; otherwise Backspace deletes one
// character as usual.
import type { StateCommand, Transaction } from "@codemirror/state";
import { deleteMarkupBackward } from "@codemirror/lang-markdown";

// One marker at the start of a line: indentation, a quote's `>`, a list
// marker, or a task's box.
const MARKER = /[ \t]+|>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+|\[[^\]\n]\][ \t]+/y;

/** Where the markers at the start of `text` begin and end. */
function markerEdges(text: string): Set<number> {
  const edges = new Set([0]);
  for (let pos = 0; ; ) {
    MARKER.lastIndex = pos;
    const m = MARKER.exec(text);
    if (!m) return edges;
    pos += m[0].length;
    edges.add(pos);
  }
}

export const deleteMarkupOnly: StateCommand = ({ state, dispatch }) => {
  let tr: Transaction | null = null;
  if (!deleteMarkupBackward({ state, dispatch: (t) => (tr = t) }) || !tr) return false;
  let whole = true;
  (tr as Transaction).changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const line = state.doc.lineAt(fromA);
    const edges = markerEdges(line.text);
    if (!edges.has(fromA - line.from) || !edges.has(toA - line.from) || /\S/.test(inserted.toString())) whole = false;
  });
  if (!whole) return false;
  dispatch(tr);
  return true;
};
