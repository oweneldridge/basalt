// Markdown formatting hotkeys: Mod-B (bold), Mod-I (italic), Mod-K (link).
// All commands use changeByRange so they're correct with multiple cursors, and
// each returns the post-change selection in that range's own coordinates.
//
// Toggle detection is SYNTAX-TREE based, not textual: a purely textual
// before/after check can't tell an italic `*` from half of a bold `**`
// delimiter and silently corrupts markup (e.g. **bold** -> *bold* on Mod-I).
import { EditorSelection } from "@codemirror/state";
import type { EditorState, StateCommand } from "@codemirror/state";
import type { KeyBinding } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

/** Innermost enclosing node of `typeName` that covers [from, to], if any. */
function enclosing(
  state: EditorState,
  from: number,
  to: number,
  typeName: string,
): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, side);
    while (node) {
      if (node.name === typeName && node.from <= from && node.to >= to) return node;
      node = node.parent;
    }
  }
  return null;
}

/** Toggle an inline emphasis marker around each selection range. `typeName` is
 * the lezer node this marker produces (Emphasis / StrongEmphasis). */
function toggleWrap(marker: string, typeName: string): StateCommand {
  const len = marker.length;
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const tr = state.changeByRange((range) => {
      const { from, to } = range;
      const inverted = range.head < range.anchor;
      const mkRange = (a: number, b: number) =>
        inverted ? EditorSelection.range(b, a) : EditorSelection.range(a, b);

      const node = enclosing(state, from, to, typeName);
      if (node) {
        // Unwrap: delete the node's actual opening/closing mark children (their
        // real lengths matter — `***` nests Emphasis and StrongEmphasis marks).
        const marks = node.getChildren("EmphasisMark");
        if (marks.length >= 2) {
          const open = marks[0];
          const close = marks[marks.length - 1];
          const shift = open.to - open.from;
          // Clamp the selection into the content, then shift left past the
          // deleted opening mark.
          const cf = Math.min(Math.max(from, open.to), close.from);
          const ct = Math.min(Math.max(to, open.to), close.from);
          return {
            changes: [
              { from: open.from, to: open.to },
              { from: close.from, to: close.to },
            ],
            range: mkRange(cf - shift, ct - shift),
          };
        }
      }
      // Wrap (an empty selection gets the markers with the caret inside).
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: mkRange(from + len, to + len),
      };
    });
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
    return true;
  };
}

/** Wrap each selection as a Markdown link, caret in the URL slot. */
const insertLink: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const tr = state.changeByRange((range) => {
    if (range.empty) {
      return {
        changes: { from: range.from, insert: "[]()" },
        range: EditorSelection.cursor(range.from + 1), // inside the []
      };
    }
    return {
      changes: [
        { from: range.from, insert: "[" },
        { from: range.to, insert: "]()" },
      ],
      range: EditorSelection.cursor(range.to + 3), // between the ()
    };
  });
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

export const markdownKeys: readonly KeyBinding[] = [
  { key: "Mod-b", run: toggleWrap("**", "StrongEmphasis") },
  { key: "Mod-i", run: toggleWrap("*", "Emphasis") },
  { key: "Mod-k", run: insertLink },
];
