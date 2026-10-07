// Tab / Shift-Tab on a list item, as in Obsidian: the item moves with the items
// nested under it. Numbered lists then renumber the way every edit renumbers
// them (listRenumber.ts).
import { type ChangeSpec } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import type { EditorState, Line } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

const ITEM = /^(\s*)([-*+]|(\d{1,9})([.)]))(\s+)/;

function item(line: Line): { indent: string } | null {
  const m = ITEM.exec(line.text);
  return m ? { indent: m[1] } : null;
}

/** The last line of the item at `n`: lines below it indented deeper. */
function blockEnd(state: EditorState, n: number, indent: string): number {
  let last = n;
  for (let k = n + 1; k <= state.doc.lines; k++) {
    const text = state.doc.line(k).text;
    if (text.trim() === "" || !text.startsWith(indent) || !/^\s/.test(text.slice(indent.length))) break;
    last = k;
  }
  return last;
}

function shift(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (state.selection.ranges.length > 1) return false;
  const startLine = state.doc.lineAt(sel.from);
  if (!sel.empty && state.doc.lineAt(sel.to).number !== startLine.number) return false;
  const it = item(startLine);
  if (!it) return false;
  if (dir < 0 && it.indent === "") return true; // already at the top level
  const unit = state.facet(indentUnit);
  const n = startLine.number;
  const end = blockEnd(state, n, it.indent);
  const changes: ChangeSpec[] = [];
  for (let k = n; k <= end; k++) {
    const line = state.doc.line(k);
    if (dir > 0) changes.push({ from: line.from, insert: unit });
    else {
      const lead = /^(\t| {1,4})/.exec(line.text)?.[0] ?? "";
      if (lead) changes.push({ from: line.from, to: line.from + lead.length });
    }
  }
  view.dispatch(state.update({ changes, userEvent: dir > 0 ? "input.indent" : "delete.dedent" }));
  return true;
}

export const indentListItem = (view: EditorView): boolean => shift(view, 1);
export const outdentListItem = (view: EditorView): boolean => shift(view, -1);
