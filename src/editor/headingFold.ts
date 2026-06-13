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
import type { EditorState, Extension } from "@codemirror/state";
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
    const range = headingSectionAt(view.state, line.from);
    if (!range) return null;
    return isFolded(view.state, range) ? CLOSED : OPEN;
  },
  // Markers reflect fold state, which changes via effect-only transactions
  // (no doc change), so recompute every update.
  lineMarkerChange: () => true,
  initialSpacer: () => OPEN,
  domEventHandlers: {
    click(view, line) {
      const range = headingSectionAt(view.state, line.from);
      if (!range) return false;
      const effect = (isFolded(view.state, range) ? unfoldEffect : foldEffect).of(range);
      view.dispatch({ effects: effect });
      return true;
    },
  },
});

export const headingFold: Extension = [codeFolding(), headingFoldGutter];

export { foldKeymap };
