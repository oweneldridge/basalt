// Heading folding (Obsidian parity). CM's markdown support can fold any
// multi-line block (paragraphs included), which is noisier than Obsidian — so
// instead of the stock `foldGutter` we drive a custom gutter that only marks
// HEADING lines and folds the section beneath them. The fold STATE +
// inline "…" placeholder still come from `codeFolding()`, and the keymap from
// `foldKeymap` (those can fold any block at the cursor for power users).
//
// A heading section runs from the end of the heading line down to the line
// before the next heading of the same or higher level (or end of document).
// `ATXHeadingN` nodes are siblings under the Document, so we walk siblings.
import {
  codeFolding,
  foldEffect,
  unfoldEffect,
  foldedRanges,
  syntaxTree,
  foldKeymap,
} from "@codemirror/language";
import { gutter, GutterMarker } from "@codemirror/view";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

const ATX = /^ATXHeading([1-6])$/;

/** If `lineStart` begins a heading with a non-empty section, the fold range for
 * that section; otherwise null. */
export function headingSectionAt(
  state: EditorState,
  lineStart: number,
): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart);
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from, 1);
  while (node && !ATX.test(node.name)) node = node.parent;
  if (!node) return null;
  const level = Number(node.name.slice(-1));

  let end = state.doc.length;
  for (let sib = node.nextSibling; sib; sib = sib.nextSibling) {
    const m = ATX.exec(sib.name);
    if (m && Number(m[1]) <= level) {
      end = state.doc.lineAt(sib.from).from - 1; // end of the previous line
      break;
    }
  }
  const from = line.to; // fold begins just after the heading text
  return end > from ? { from, to: end } : null;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s/;

/** If `lineStart` begins a list item that HAS children (deeper-indented lines
 * beneath it), the fold range covering those children; otherwise null. A blank
 * line or a same/less-indented line ends the item (Obsidian's "fold indent"). */
export function listItemSectionAt(state: EditorState, lineStart: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart);
  const m = LIST_ITEM.exec(line.text);
  if (!m) return null;
  const indent = m[1].length;
  let end = line.to;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const l = state.doc.line(n);
    if (l.text.trim() === "") break; // blank line ends the item
    const childIndent = (/^\s*/.exec(l.text)?.[0].length ?? 0);
    if (childIndent <= indent) break; // sibling or dedent
    end = l.to;
  }
  return end > line.to ? { from: line.to, to: end } : null;
}

/** The foldable range a line begins — a heading section or a list item's
 * children — or null. */
function foldableAt(state: EditorState, lineStart: number): { from: number; to: number } | null {
  return headingSectionAt(state, lineStart) ?? listItemSectionAt(state, lineStart);
}

function isFolded(state: EditorState, range: { from: number; to: number }): boolean {
  let folded = false;
  foldedRanges(state).between(range.from, range.to, (from, to) => {
    if (from === range.from && to === range.to) folded = true;
  });
  return folded;
}

class FoldMarker extends GutterMarker {
  constructor(readonly folded: boolean) {
    super();
  }
  eq(other: FoldMarker): boolean {
    return other.folded === this.folded;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.folded ? "cm-fold-marker closed" : "cm-fold-marker";
    span.textContent = this.folded ? "▸" : "▾";
    return span;
  }
}
const OPEN = new FoldMarker(false);
const CLOSED = new FoldMarker(true);

const headingFoldGutter = gutter({
  class: "cm-fold-gutter",
  // Only heading lines with a section get a marker; open markers are muted
  // until gutter hover (theme.ts), a folded heading's marker stays visible.
  lineMarker(view, line) {
    const range = foldableAt(view.state, line.from);
    if (!range) return null;
    return isFolded(view.state, range) ? CLOSED : OPEN;
  },
  // Markers reflect fold state, which changes via effect-only transactions
  // (no doc change), so recompute every update.
  lineMarkerChange: () => true,
  initialSpacer: () => OPEN,
  domEventHandlers: {
    // The editor keeps its focus, so typing goes on where it was.
    mousedown(_view, _line, event) {
      event.preventDefault();
      return false;
    },
    click(view, line) {
      const range = foldableAt(view.state, line.from);
      if (!range) return false;
      const effect = (isFolded(view.state, range) ? unfoldEffect : foldEffect).of(range);
      view.dispatch({ effects: effect });
      return true;
    },
  },
});

/** An edit of the user's that would change a folded section's hidden text
 * (or join a line onto it) opens the section instead and changes nothing, so
 * nothing changes unseen. A selection reaching visible text past the section,
 * or the whole note, is the user's to change, hidden text and all. Tab and
 * Shift-Tab only change indentation, and undo and redo put back what was. */
const guardFolds = EditorState.transactionFilter.of((tr) => {
  const event = tr.annotation(Transaction.userEvent);
  if (!tr.docChanged || !event || /^(undo|redo|input\.indent|delete\.dedent)/.test(event)) return tr;
  const all = tr.startState.doc.length;
  const open: { from: number; to: number }[] = [];
  foldedRanges(tr.startState).between(0, all, (from, to) => {
    // Into the text of the line after it: a selection that ends at the line's
    // end (Shift+End, a triple-click) shows only the placeholder selected.
    const covered = tr.startState.selection.ranges.some((r) => r.from <= from && (r.to > to + 1 || (r.from === 0 && r.to === all)));
    if (covered) return;
    tr.changes.iterChanges((fromA, toA) => {
      if ((fromA < to && toA > from) || (fromA === to && toA > to)) open.push({ from, to });
    });
  });
  if (!open.length) return tr;
  // A selection over the opened text shrinks to its start, so the next key
  // doesn't replace what just came into view.
  const sel = tr.startState.selection.main;
  return { effects: open.map((r) => unfoldEffect.of(r)), selection: sel.empty ? undefined : EditorSelection.cursor(sel.from) };
});

/** Text typed, pasted, dropped or inserted at a folded section's hidden end
 * (where the caret sits after its placeholder) would join its last hidden
 * line, so the section opens to show where it went. Enter starts a line after
 * the section as usual. */
const openWhenTypedAtEnd = EditorState.transactionFilter.of((tr) => {
  const event = tr.annotation(Transaction.userEvent);
  if (!tr.docChanged || !event || /^(undo|redo|input\.indent|delete\.dedent)/.test(event)) return tr;
  const open: { from: number; to: number }[] = [];
  foldedRanges(tr.startState).between(0, tr.startState.doc.length, (from, to) => {
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (fromA === to && toA === to && !inserted.sliceString(0, 1).startsWith("\n")) open.push({ from, to });
    });
  });
  return open.length ? [tr, { effects: open.map((r) => unfoldEffect.of(r)) }] : tr;
});

export const headingFold: Extension = [codeFolding(), headingFoldGutter, guardFolds, openWhenTypedAtEnd];

export { foldKeymap };
