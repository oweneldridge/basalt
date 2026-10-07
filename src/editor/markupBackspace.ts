// Backspace right after a list or quote marker removes the marker (CodeMirror's
// deleteMarkupBackward). Upstream, it takes a letter with it on a quote line
// written without a space (`>body` under `> [!note]`), so its edit is only used
// when it stays within the line's markers; otherwise Backspace deletes one
// character as usual.
import type { StateCommand, Transaction } from "@codemirror/state";
import { deleteMarkupBackward } from "@codemirror/lang-markdown";

const LINE_MARKUP = /^[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[^\]\n]\][ \t]+)?)*/;

export const deleteMarkupOnly: StateCommand = ({ state, dispatch }) => {
  let tr: Transaction | null = null;
  if (!deleteMarkupBackward({ state, dispatch: (t) => (tr = t) }) || !tr) return false;
  let within = true;
  (tr as Transaction).changes.iterChangedRanges((fromA, toA) => {
    const line = state.doc.lineAt(fromA);
    if (toA > line.from + (LINE_MARKUP.exec(line.text)?.[0].length ?? 0)) within = false;
  });
  if (!within) return false;
  dispatch(tr);
  return true;
};
