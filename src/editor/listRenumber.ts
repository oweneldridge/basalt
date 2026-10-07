// Numbered lists keep their count after any edit, as Obsidian keeps them: a
// numbered item on (or just after) a changed line takes the number after the
// item before it in its list, or, when it starts its list, the number that
// list started at before the edit; the items after it count on from there.
// Only the user's own edits renumber, never a reload from disk.
// Unlike Obsidian, lists are read as the parser reads them, so a numbered line
// in code, math, a comment, frontmatter or a paragraph is left as typed, and
// a list's items are the ones it renders, however they're indented.
import { EditorState, Transaction, type ChangeSpec } from "@codemirror/state";
import { ensureSyntaxTree, foldedRanges } from "@codemirror/language";
import type { SyntaxNode, Tree } from "@lezer/common";
import { hiddenSpans } from "../lib/linkify";

const NUMBERED = /^[>\s]*\d+[.)] /;
// A list marker with any task box after it.
const MARKER = /^(\d+)[.)]( \[.\])?/;
// The most digits a list number can have.
const MAX_NUMBER = 999999999;
// How far past the edit the parse is waited for, and for how long.
const LOOKAHEAD = 100000;
const PARSE_MS = 50;

/** A numbered list item: its list marker and where it sits. */
interface Item {
  node: SyntaxNode; // the ListItem
  from: number; // where its number starts
  num: string;
  marker: string; // number, delimiter and any task box
  level: number; // how many lists it's nested in
}

/** The numbered list items of one version of a note, as the parser reads it. */
class Items {
  private hidden: { frontmatter: number; spans: [number, number][] } | null = null;
  constructor(
    private state: EditorState,
    private tree: Tree,
  ) {}

  /** The numbered item whose marker starts line `n`, if there is one. */
  at(n: number): Item | null {
    const line = this.state.doc.line(n);
    if (!NUMBERED.test(line.text)) return null;
    const pos = line.from + /^[>\s]*/.exec(line.text)![0].length;
    const mark = this.tree.resolveInner(pos, 1);
    if (mark.name !== "ListMark" || mark.from !== pos || mark.parent?.parent?.name !== "OrderedList") return null;
    if (this.isHidden(n, pos)) return null;
    return this.item(mark.parent);
  }

  /** The item before or after `node` in its list, if it's one to count. */
  sibling(node: SyntaxNode, dir: "prevSibling" | "nextSibling"): Item | null {
    const next = node[dir];
    if (next?.name !== "ListItem") return null;
    const item = this.item(next);
    return item && !this.isHidden(this.state.doc.lineAt(item.from).number, item.from) ? item : null;
  }

  /** The item the ListItem `node` holds. */
  private item(node: SyntaxNode): Item | null {
    const mark = node.firstChild;
    if (mark?.name !== "ListMark") return null;
    const m = MARKER.exec(this.state.sliceDoc(mark.from, mark.to + 4))!;
    let level = -1;
    for (let p: SyntaxNode | null = node; p; p = p.parent) if (p.name === "ListItem") level++;
    return { node, from: mark.from, num: m[1], marker: m[0], level };
  }

  /** Whether `pos` on line `n` is in frontmatter, `$$` math or a comment,
   * which the parser reads as ordinary text. */
  private isHidden(n: number, pos: number): boolean {
    if (!this.hidden) {
      const doc = this.state.doc;
      let frontmatter = 0;
      if (doc.lines > 1 && doc.line(1).text.trim() === "---")
        for (let k = 2; k <= doc.lines && !frontmatter; k++) if (/^(---|\.\.\.)$/.test(doc.line(k).text.trim())) frontmatter = k;
      // Most notes have none of these, and finding them reads the whole note.
      const text = doc.toString();
      this.hidden = { frontmatter, spans: /\$\$|%%|<!--/.test(text) ? hiddenSpans(text, false) : [] };
    }
    return n <= this.hidden.frontmatter || this.hidden.spans.some(([from, to]) => pos >= from && pos < to);
  }

  static of(state: EditorState, upto: number): Items | null {
    const tree = ensureSyntaxTree(state, Math.min(state.doc.length, upto + LOOKAHEAD), PARSE_MS);
    return tree ? new Items(state, tree) : null;
  }
}

/** `num` written as `was` is: zero-padded to its width when it was. */
const written = (num: number, was: string) => (was.length > 1 && was[0] === "0" ? String(num).padStart(was.length, "0") : String(num));

function renumber(tr: Transaction, now: Items, was: Items): ChangeSpec[] {
  const doc = tr.newDoc;
  const before = tr.startState.doc;
  const changed: { from: number; to: number }[] = [];
  const touched = new Set<number>();
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    changed.push({ from: fromB, to: toB });
    for (let n = doc.lineAt(fromB).number; n <= Math.min(doc.lines, doc.lineAt(toB).number + 1); n++) touched.add(n);
  });
  const isTouched = (pos: number) => {
    const line = doc.lineAt(pos);
    return changed.some((c) => c.from <= line.to && c.to >= line.from);
  };
  // The item a line held before the edit.
  const wasItem = (pos: number) => was.at(before.lineAt(tr.changes.invertedDesc.mapPos(doc.lineAt(pos).to)).number);
  const numbers = new Map<number, number>();
  const out: ChangeSpec[] = [];
  const set = (item: Item, num: number) => {
    numbers.set(item.from, num);
    if (num !== parseInt(item.num, 10)) out.push({ from: item.from, to: item.from + item.num.length, insert: written(num, item.num) });
  };
  for (const n of [...touched].sort((a, b) => a - b)) {
    const item = now.at(n);
    if (!item || numbers.has(item.from)) continue;
    const old = wasItem(item.from);
    // A line that wasn't a list item before only becomes one by the user's
    // own typing on it, never by an edit elsewhere (a fence losing a backtick).
    if (!old && !isTouched(item.from)) continue;
    const prev = now.sibling(item.node, "prevSibling");
    let num: number;
    if (prev) num = (numbers.get(prev.from) ?? parseInt(prev.num, 10)) + 1;
    else if (isTouched(item.from) && old?.marker !== item.marker) num = parseInt(item.num, 10); // a number the user typed
    else if (!old) continue;
    else if (old.level !== item.level) num = 1;
    else {
      // The number the list started at before the edit.
      let first = old;
      for (let p = was.sibling(old.node, "prevSibling"); p; p = was.sibling(p.node, "prevSibling")) first = p;
      num = parseInt(first.num, 10);
    }
    if (num > MAX_NUMBER) continue;
    set(item, num);
    // The items after it count on, up to one that's already right.
    for (let next = now.sibling(item.node, "nextSibling"); next && num < MAX_NUMBER; next = now.sibling(next.node, "nextSibling")) {
      if (numbers.has(next.from) || (!wasItem(next.from) && !isTouched(next.from))) break;
      num++;
      if (num === parseInt(next.num, 10)) {
        numbers.set(next.from, num);
        break;
      }
      set(next, num);
    }
  }
  return out;
}

export const renumberLists = EditorState.transactionFilter.of((tr) => {
  const event = tr.annotation(Transaction.userEvent);
  if (!tr.docChanged || !event || /^(undo|redo|input\.renumber|input\.type\.compose)/.test(event)) return tr;
  // Only an edit on or just above a numbered line can renumber anything.
  const doc = tr.newDoc;
  let near = -1;
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    for (let n = doc.lineAt(fromB).number; n <= Math.min(doc.lines, doc.lineAt(toB).number + 1); n++)
      if (NUMBERED.test(doc.line(n).text)) near = Math.max(near, doc.line(n).to);
  });
  if (near < 0) return tr;
  const now = Items.of(tr.state, near);
  const was = Items.of(tr.startState, tr.changes.invertedDesc.mapPos(near));
  if (!now || !was) return tr;
  const changes = renumber(tr, now, was);
  if (!changes.length) return tr;
  // A number hidden in a closed fold is left as it is, so nothing changes unseen.
  let hidden = false;
  const folds = foldedRanges(tr.state);
  for (const c of changes as { from: number; to: number }[])
    folds.between(c.from, c.to, (from, to) => {
      if (c.from < to && c.to > from) hidden = true;
    });
  return hidden ? tr : [tr, { changes, sequential: true, userEvent: "input.renumber" }];
});
