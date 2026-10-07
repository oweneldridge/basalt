// Numbered lists keep their count after any edit, as Obsidian keeps them: a
// numbered item on (or just after) a changed line takes the number after the
// item before it in its list, or, when it starts its list, the number that
// list started at before the edit; the items after it count on from there.
// Only the user's own edits renumber, never a reload from disk.
// Unlike Obsidian, lists are read as the parser reads them, so a numbered line
// in code, math, a comment, frontmatter or a paragraph is left as typed, and
// a list's items are the ones it renders, however they're indented.
import { EditorState, MapMode, Transaction, type ChangeSpec, type Text } from "@codemirror/state";
import { ensureSyntaxTree, foldedRanges, language } from "@codemirror/language";
import type { Input, SyntaxNode, Tree } from "@lezer/common";

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

// Nodes whose text is literal: a list marker inside one isn't a list item,
// even when a fence's language (```markdown) parses it as one.
const LITERAL = new Set(["FencedCode", "CodeBlock", "CodeText", "InlineCode", "HTMLBlock", "CommentBlock", "Comment"]);

/** The numbered list items of one version of a note, as the parser reads it. */
class Items {
  private hidden: { frontmatter: number; spans: [number, number][] } | null = null;
  constructor(
    private state: EditorState,
    private tree: Tree, // the lines around the edit, parsed afresh
    private offset: number, // where `tree` starts in the note
    private full: Tree, // the editor's tree, as far as `limit`
    private limit: number,
  ) {}

  /** The numbered item whose marker starts line `n`, if there is one. */
  at(n: number): Item | null {
    const line = this.state.doc.line(n);
    if (!NUMBERED.test(line.text)) return null;
    const pos = line.from + /^[>\s]*/.exec(line.text)![0].length;
    const mark = this.tree.resolveInner(pos - this.offset, 1);
    if (mark.name !== "ListMark" || mark.from + this.offset !== pos || mark.parent?.parent?.name !== "OrderedList") return null;
    if (this.literal(mark) || this.isHidden(n, pos)) return null;
    return this.item(mark.parent);
  }

  /** The item before or after `node` in its list, if it's one to count. A
   * quoted list has the `>` of each line between its items. */
  sibling(node: SyntaxNode, dir: "prevSibling" | "nextSibling"): Item | null {
    let next = node[dir];
    while (next?.name === "QuoteMark") next = next[dir];
    if (next?.name !== "ListItem") return null;
    const item = this.item(next);
    return item && !this.isHidden(this.state.doc.lineAt(item.from).number, item.from) ? item : null;
  }

  /** The item the ListItem `node` holds. */
  private item(node: SyntaxNode): Item | null {
    const mark = node.firstChild;
    if (mark?.name !== "ListMark") return null;
    const from = mark.from + this.offset;
    const m = MARKER.exec(this.state.sliceDoc(from, mark.to + this.offset + 4));
    if (!m) return null;
    let level = -1;
    for (let p: SyntaxNode | null = node; p; p = p.parent) if (p.name === "ListItem") level++;
    return { node, from, num: m[1], marker: m[0], level };
  }

  private literal(node: SyntaxNode): boolean {
    for (let p: SyntaxNode | null = node; p; p = p.parent) if (LITERAL.has(p.name)) return true;
    return false;
  }

  /** Whether `pos` on line `n` is in frontmatter, `$$` math or a `%%`
   * comment, which the parser reads as ordinary text. Past where the parse is
   * known, everything counts as hidden. */
  private isHidden(n: number, pos: number): boolean {
    if (pos >= this.limit) return true;
    this.hidden ??= { frontmatter: this.frontmatter(), spans: this.spans() };
    return n <= this.hidden.frontmatter || this.hidden.spans.some(([from, to]) => pos >= from && pos < to);
  }

  private frontmatter(): number {
    const doc = this.state.doc;
    if (doc.lines < 2 || doc.line(1).text.trim() !== "---") return 0;
    for (let k = 2; k <= doc.lines && doc.line(k).from < this.limit; k++) if (/^(---|\.\.\.)$/.test(doc.line(k).text.trim())) return k;
    return 0;
  }

  /** `%%` comments, then `$$` math outside them, each pair of marks found
   * outside code. A mark left open runs on past what's known, so it hides
   * the rest unless the whole note was read. */
  private spans(): [number, number][] {
    const whole = this.limit >= this.state.doc.length;
    const text = this.state.sliceDoc(0, whole ? this.state.doc.length : this.limit);
    const out: [number, number][] = [];
    const inside = (pos: number) => out.some(([from, to]) => pos >= from && pos < to);
    for (const mark of ["%%", "$$"]) {
      let open = -1;
      const found: [number, number][] = [];
      for (let i = text.indexOf(mark); i >= 0; i = text.indexOf(mark, i + 2)) {
        if (inside(i) || this.literal(this.full.resolveInner(i, 1))) continue;
        if (open < 0) open = i;
        else (found.push([open, i + 2]), (open = -1));
      }
      if (open >= 0 && !whole) found.push([open, Infinity]);
      out.push(...found);
    }
    return out;
  }

  /** The items of `state` around `from` to `upto`. */
  static of(state: EditorState, from: number, upto: number): Items | null {
    const limit = Math.min(state.doc.length, upto + LOOKAHEAD);
    const full = ensureSyntaxTree(state, limit, PARSE_MS);
    const lang = state.facet(language);
    if (!full || !lang) return null;
    // The editor's tree is updated a piece at a time and can split a quoted
    // list after an edit, so the blocks around the edit are parsed afresh.
    const range = around(state.doc, full, from, upto, limit);
    if (!range) return null;
    // A tree parsed from a range counts its positions from the range's start.
    const tree = lang.parser.parse(input(state.doc), [], [range]);
    return new Items(state, tree, range.from, full, limit === state.doc.length ? Infinity : limit);
  }
}

/** A line that starts a block of its own, after a blank line and outside any
 * list, quote or code: the parse from there on doesn't depend on what's above. */
function startsBlock(doc: Text, full: Tree, n: number): boolean {
  const line = doc.line(n);
  if (n === 1) return true;
  if (doc.line(n - 1).text !== "" || !/^[^\s>]/.test(line.text) || /^([-*+]|\d{1,9}[.)])(\s|$)/.test(line.text)) return false;
  for (let p: SyntaxNode | null = full.resolveInner(line.from, 1); p; p = p.parent) if (LITERAL.has(p.name)) return false;
  return true;
}

/** The stretch of the note around `from` to `upto` that parses on its own:
 * from the block start before it to the next one after, as far as `limit`. */
function around(doc: Text, full: Tree, from: number, upto: number, limit: number): { from: number; to: number } | null {
  let n = doc.lineAt(from).number;
  while (!startsBlock(doc, full, n)) {
    if (from - doc.line(--n).from > LOOKAHEAD) return null;
  }
  const start = doc.line(n).from;
  let end = limit;
  for (let k = doc.lineAt(upto).number + 1; k <= doc.lines && doc.line(k).from < limit; k++) {
    if (startsBlock(doc, full, k)) {
      end = doc.line(k).from;
      break;
    }
  }
  return { from: start, to: Math.max(end, start) };
}

/** The note as a parser reads it, without copying it into one string. */
const input = (doc: Text): Input => ({
  length: doc.length,
  lineChunks: false,
  chunk: (from) => doc.sliceString(from, Math.min(doc.length, from + 4096)),
  read: (from, to) => doc.sliceString(from, to),
});

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
  // An item cut off from the one before it, which is still there at its
  // level: the edit split the list, and each part keeps its numbers.
  const split = (old: Item) => {
    const prev = was.sibling(old.node, "prevSibling");
    if (!prev) return false;
    const at = tr.changes.mapPos(prev.from, 1, MapMode.TrackAfter);
    if (at === null) return false;
    const still = now.at(doc.lineAt(at).number);
    return still?.from === at && still.level === prev.level;
  };
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
    else if (split(old)) continue;
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
  let first = doc.length;
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    first = Math.min(first, doc.lineAt(fromB).from);
    for (let n = doc.lineAt(fromB).number; n <= Math.min(doc.lines, doc.lineAt(toB).number + 1); n++)
      if (NUMBERED.test(doc.line(n).text)) near = Math.max(near, doc.line(n).to);
  });
  if (near < 0) return tr;
  let changes: ChangeSpec[];
  try {
    const now = Items.of(tr.state, first, near);
    const was = Items.of(tr.startState, tr.changes.invertedDesc.mapPos(first), tr.changes.invertedDesc.mapPos(near));
    if (!now || !was) return tr;
    changes = renumber(tr, now, was);
  } catch (e) {
    // The user's own edit always goes through, renumbered or not.
    console.error("[basalt] list renumber failed", e);
    return tr;
  }
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
