// Clicks on a line whose markup Live Preview hides. The click reveals the
// markup, which shifts the text, so CodeMirror can resolve one click to a range
// over `# ` or `**`, or put the caret on the wrong side of it; the next key then
// deletes or breaks the markup. Here:
// - a single click is a caret, never a range;
// - a click left of hidden line markup (`> `, `- `, `- [ ] `, `# `, a callout's
//   `[!type]`) lands after it, where the visible text starts;
// - a click past a line's end lands after any hidden closing markup;
// - a double-click that picked only markup selects the word beside it.
import { EditorSelection, EditorState, Prec } from "@codemirror/state";
import type { Extension, Line, SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { frontmatterRange } from "./regions";

let click: { detail: number; extend: boolean } | null = null;

const observer = EditorView.domEventObservers({
  mousedown(e) {
    // CodeMirror selects synchronously inside this same mousedown; later
    // selections (a drag) come from other events and are left alone.
    click = { detail: e.detail, extend: e.shiftKey };
    setTimeout(() => (click = null));
  },
});

const LINE_MARKUP = /^[ \t]*(?:>[ \t]?)*(?:[-*+][ \t]+(?:\[[^\]\n]\][ \t]+)?)?(?:#{1,6}[ \t]+)?(?:\[![\w-]+\][+-]?[ \t]?)?/;
const INLINE_MARKS = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark", "HeaderMark"]);
const MARKUP_ONLY = /^[\s*_=~`#>]+$/;

function touched(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function inCode(state: EditorState, pos: number): boolean {
  for (let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent)
    if (n.name === "FencedCode" || n.name === "CodeBlock") return true;
  return false;
}

/** Where the visible text of a line starts, past markup Live Preview hides. */
function textStart(state: EditorState, line: Line): number {
  if (touched(state, line.from, line.to) || inCode(state, line.from)) return line.from;
  const fm = frontmatterRange(state);
  if (fm && line.from <= fm.to) return line.from;
  return line.from + (LINE_MARKUP.exec(line.text)?.[0].length ?? 0);
}

/** Where hidden closing markup at a line's end starts (the line's end if none). */
function closingMarkup(state: EditorState, line: Line): number {
  const marks: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (n) => {
      if (!INLINE_MARKS.has(n.name)) return;
      const parent = n.node.parent;
      if (!parent || touched(state, parent.from, parent.to)) return;
      if (n.name === "CodeMark" && parent.name !== "InlineCode") return;
      marks.push({ from: n.from, to: n.to });
    },
  });
  for (const m of line.text.matchAll(/==[^=\n]+?==/g)) {
    const from = line.from + m.index!;
    if (touched(state, from, from + m[0].length)) continue;
    marks.push({ from: from + m[0].length - 2, to: from + m[0].length });
  }
  let end = line.to;
  for (;;) {
    const m = marks.find((k) => k.to === end && k.from < end);
    if (!m) return end;
    end = m.from;
  }
}

function placeCaret(state: EditorState, head: number): number {
  const line = state.doc.lineAt(head);
  const start = textStart(state, line);
  if (head < start) return start;
  const closing = closingMarkup(state, line);
  if (closing < line.to && head >= closing) return line.to;
  return head;
}

/** The word next to a markup-only double-click selection. */
function wordBeside(state: EditorState, range: SelectionRange): SelectionRange | null {
  const text = state.sliceDoc(range.from, range.to);
  if (!MARKUP_ONLY.test(text)) return null;
  const line = state.doc.lineAt(range.from);
  const around = state.sliceDoc(Math.max(line.from, range.from - 1), Math.min(line.to, range.to + 1));
  if (!/[*_=~`#>]/.test(around)) return null; // a space between plain words
  for (let p = range.to; p < line.to; p++) {
    const w = state.wordAt(p);
    if (w && !MARKUP_ONLY.test(state.sliceDoc(w.from, w.to))) return EditorSelection.range(w.from, w.to);
  }
  for (let p = range.from; p > line.from; p--) {
    const w = state.wordAt(p - 1);
    if (w && !MARKUP_ONLY.test(state.sliceDoc(w.from, w.to))) return EditorSelection.range(w.from, w.to);
  }
  return null;
}

const guard = EditorState.transactionFilter.of((tr) => {
  const c = click;
  if (!c || c.extend || !tr.selection || tr.docChanged || !tr.isUserEvent("select.pointer")) return tr;
  const sel = tr.newSelection;
  const main = sel.main;
  let next: SelectionRange | null = null;
  if (c.detail === 1) {
    const caret = placeCaret(tr.startState, main.head);
    if (!main.empty || caret !== main.head) next = EditorSelection.cursor(caret);
  } else if (c.detail === 2) {
    // The first click put the caret where the user aimed, on the layout they
    // saw; the second lands on text the first one shifted by revealing markup.
    const first = tr.startState.selection.main;
    const w = first.empty ? tr.startState.wordAt(first.head) : null;
    next = w ? EditorSelection.range(w.from, w.to) : wordBeside(tr.startState, main);
    if (next && next.from === main.from && next.to === main.to) next = null;
  }
  if (!next) return tr;
  const ranges = sel.ranges.map((r, i) => (i === sel.mainIndex ? next! : r));
  return [tr, { selection: EditorSelection.create(ranges, sel.mainIndex), sequential: true }];
});

// Lowest precedence runs first, so the Properties and math filters see the
// caret this one settles on.
export const clickGuard: Extension = [observer, Prec.lowest(guard)];
