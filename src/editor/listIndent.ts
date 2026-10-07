// Tab / Shift-Tab on a list item, as in Obsidian: the item moves with the items
// nested under it, and numbered lists renumber at both the level it left and
// the level it joined (an item indented under `1.` starts its own list at 1).
import { type ChangeSpec, type EditorState, type Line } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";

const ITEM = /^(\s*)([-*+]|(\d{1,9})([.)]))(\s+)/;

interface Item {
  line: Line;
  indent: string;
  num: number | null; // a numbered item's number
  numFrom: number; // where its number starts
  numLen: number; // how many digits it's written with (`02` is two)
  delim: string | null; // `.` or `)` after the number
}

function item(line: Line): Item | null {
  const m = ITEM.exec(line.text);
  if (!m) return null;
  return {
    line,
    indent: m[1],
    num: m[3] ? Number(m[3]) : null,
    numFrom: line.from + m[1].length,
    numLen: m[3]?.length ?? 0,
    delim: m[4] ?? null,
  };
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

/** Renumber the run of numbered items at `indent` that contains line `n`.
 * `restart` makes a run that begins at line `n` count from 1. Blank lines
 * between items (a loose list) don't end the run; a bullet, or a number with
 * the other delimiter (`1)` after `1.`), starts another list and does. */
function renumber(state: EditorState, n: number, indent: string, restart = false): ChangeSpec[] {
  const own = item(state.doc.line(n));
  if (!own || own.num === null) return [];
  const at = (k: number) => {
    const it = item(state.doc.line(k));
    return it && it.indent === indent ? it : null;
  };
  const sameList = (it: Item) => it.num !== null && it.delim === own.delim;
  const deeper = (k: number) => {
    const text = state.doc.line(k).text;
    return text.trim() === "" || (text.startsWith(indent) && /^\s/.test(text.slice(indent.length)));
  };
  let first = n;
  for (let k = n - 1; k >= 1; k--) {
    const it = at(k);
    if (it) {
      if (!sameList(it)) break;
      first = k;
    } else if (!deeper(k)) break;
  }
  const changes: ChangeSpec[] = [];
  let next: number | null = restart && first === n ? 1 : null;
  for (let k = first; k <= state.doc.lines; k++) {
    const it = at(k);
    if (!it) {
      if (deeper(k)) continue;
      break;
    }
    if (!sameList(it)) break;
    if (next === null) next = it.num ?? 1;
    else if (it.num !== next) changes.push({ from: it.numFrom, to: it.numFrom + it.numLen, insert: String(next) });
    next++;
  }
  return changes;
}

/** The first item at `indent` below the block that ends at line `end`, before
 * the list climbs above that level. */
function nextAt(state: EditorState, end: number, indent: string): number | null {
  for (let k = end + 1; k <= state.doc.lines; k++) {
    const text = state.doc.line(k).text;
    if (text.trim() === "") continue;
    const it = item(state.doc.line(k));
    if (it && it.indent === indent) return k;
    if (!text.startsWith(indent)) return null;
  }
  return null;
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
  const userEvent = dir > 0 ? "input.indent" : "delete.dedent";
  const first = state.update({ changes, userEvent });
  const moved = first.state;
  const now = item(moved.doc.line(n))!;
  const fixes: ChangeSpec[] = [];
  const movedEnd = blockEnd(moved, n, now.indent);
  // The level it joined (a new nested list starts at 1).
  if (now.num !== null) fixes.push(...renumber(moved, n, now.indent, dir > 0));
  // The level it left: the items that followed it there.
  const after = nextAt(moved, movedEnd, it.indent);
  if (after !== null && item(moved.doc.line(after))!.num !== null) fixes.push(...renumber(moved, after, it.indent, dir < 0));
  if (!fixes.length) {
    view.dispatch(first);
    return true;
  }
  const second = moved.update({ changes: fixes });
  view.dispatch(state.update({ changes: first.changes.compose(second.changes), userEvent }));
  return true;
}

export const indentListItem = (view: EditorView): boolean => shift(view, 1);
export const outdentListItem = (view: EditorView): boolean => shift(view, -1);
