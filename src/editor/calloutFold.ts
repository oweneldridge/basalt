// Foldable callouts in Live Preview. `> [!note]-` starts folded, `> [!note]+`
// (or no marker) starts open; a chevron on the title line toggles it. A folded
// callout's BODY lines are concealed with a block replace decoration — which,
// per the editor's architecture, must come from a StateField (not a ViewPlugin,
// which owns the tinting/line decorations in callouts.ts).
//
// Fold state lives in a StateField keyed by the callout's title-line START
// position (mapped across edits). The map holds only EXPLICIT user overrides;
// the effective folded state is `override ?? (marker === "-")`, so the document
// marker is the default and a click records an override.
import { EditorState, StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { isInExcludedRegion } from "./regions";

const CALLOUT_HEAD = /^(\s*>\s*)\[!(\w+)\]([+-]?)/;

/** Toggle the fold override for the callout whose title line starts at `pos`. */
const toggleFold = StateEffect.define<number>();

/** Set of title-line positions the user has EXPLICITLY toggled, plus the
 * effective-folded value at each (so mapping survives edits). */
interface FoldEntry {
  pos: number;
  folded: boolean;
}

const foldState = StateField.define<FoldEntry[]>({
  create: () => [],
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      // Map override positions across the edit. Stale entries that no longer
      // sit on a callout title are harmless (isFolded matches by exact pos).
      next = next.map((e) => ({ ...e, pos: tr.changes.mapPos(e.pos, 1) }));
    }
    for (const eff of tr.effects) {
      if (eff.is(toggleFold)) {
        const pos = eff.value;
        const existing = next.find((e) => e.pos === pos);
        if (existing) {
          existing.folded = !existing.folded;
          next = [...next];
        } else {
          // No override yet → the click flips the marker default. We look up the
          // current default from the line text at apply time.
          const line = tr.state.doc.lineAt(pos);
          const m = CALLOUT_HEAD.exec(line.text);
          const marker = m?.[3] ?? "";
          next = [...next, { pos, folded: !(marker === "-") }];
        }
      }
    }
    return next;
  },
});

class ChevronWidget extends WidgetType {
  constructor(
    readonly pos: number,
    readonly folded: boolean,
  ) {
    super();
  }
  eq(o: ChevronWidget): boolean {
    return o.pos === this.pos && o.folded === this.folded;
  }
  toDOM(view: EditorView): HTMLElement {
    const b = document.createElement("span");
    b.className = `cm-callout-fold${this.folded ? " folded" : ""}`;
    b.textContent = "▾";
    b.title = this.folded ? "Expand callout" : "Collapse callout";
    b.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({ effects: toggleFold.of(this.pos) });
    };
    return b;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** Effective folded state for a callout at `titlePos` with the given marker. */
function isFolded(state: EditorState, titlePos: number, marker: string): boolean {
  const entry = state.field(foldState).find((e) => e.pos === titlePos);
  if (entry) return entry.folded;
  return marker === "-";
}

function build(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const { doc } = state;
  const sel = state.selection;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Blockquote") return;
      const startLine = doc.lineAt(node.from);
      const m = CALLOUT_HEAD.exec(startLine.text);
      if (!m) return false;
      if (isInExcludedRegion(state, startLine.from)) return false;
      const marker = m[3];
      const titlePos = startLine.from;
      // A chevron widget at the very start of the title line.
      ranges.push(
        Decoration.widget({ widget: new ChevronWidget(titlePos, isFolded(state, titlePos, marker)), side: -1 }).range(
          titlePos,
        ),
      );
      if (isFolded(state, titlePos, marker)) {
        const endLine = doc.lineAt(Math.min(node.to, doc.length));
        // Don't fold while the caret is inside the callout (so it stays editable).
        const touched = sel.ranges.some((r) => r.from <= endLine.to && r.to >= startLine.from);
        if (!touched && endLine.number > startLine.number) {
          // Conceal the body inline (same mechanism as the [!type] conceal),
          // from the end of the title line through the last body line.
          ranges.push(Decoration.replace({}).range(startLine.to, endLine.to));
        }
      }
      return false;
    },
  });
  // Each callout contributes a chevron at the title start and (if folded) a
  // conceal starting later, so all `from` values are distinct and increasing.
  ranges.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}

const foldDeco = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(deco, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(toggleFold))) {
      return build(tr.state);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const calloutFold: Extension = [foldState, foldDeco];
