// Live Preview for math: `$…$` (inline) and `$$…$$` (display, inline or a
// multi-line block). Rendered with KaTeX (lazy-loaded). Caret outside → render;
// inside → reveal the raw source, like mermaid/transclusion.
import { EditorSelection, EditorState as State, Prec, RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { isInExcludedRegion } from "./regions";
import { fillMath, hasMathLoaded, mathGeneration } from "./mathRender";

interface MathSpan {
  from: number;
  to: number;
  tex: string;
  display: boolean;
  block: boolean;
}

// A `$` followed by a digit closes nothing, so `$5 and $10` stays text (Obsidian).
const MATH_RE = /\$\$([\s\S]+?)\$\$|\$(?!\s)((?:\\.|[^$\n\\])+?)(?<!\s)\$(?!\d)/g;

function findMath(text: string): MathSpan[] {
  const spans: MathSpan[] = [];
  // A `$` inside inline code is code: blank code spans (same length) first.
  text = text.replace(/`[^`\n]+`/g, (m) => " ".repeat(m.length));
  MATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATH_RE.exec(text))) {
    const from = m.index;
    const to = from + m[0].length;
    if (m[1] !== undefined) {
      // $$…$$ display. Block when it spans lines or sits alone on its line.
      const lineStart = text.lastIndexOf("\n", from - 1) + 1;
      const nl = text.indexOf("\n", to);
      const lineEnd = nl < 0 ? text.length : nl;
      const alone = text.slice(lineStart, from).trim() === "" && text.slice(to, lineEnd).trim() === "";
      const block = m[0].includes("\n") || alone;
      spans.push({
        from: block ? lineStart : from,
        to: block ? lineEnd : to,
        tex: m[1].trim(),
        display: true,
        block,
      });
    } else {
      spans.push({ from, to, tex: (m[2] ?? "").trim(), display: false, block: false });
    }
  }
  return spans;
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    readonly block: boolean,
    readonly generation: number,
  ) {
    super();
  }
  eq(o: MathWidget): boolean {
    return o.tex === this.tex && o.display === this.display && o.block === this.block && o.generation === this.generation;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.block ? "div" : "span");
    el.className = "cm-math" + (this.block ? " cm-math-block" : "");
    fillMath(el, this.tex, this.display, view);
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function compute(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = state.selection;
  // A `$$` block takes its whole line, so it can start before an inline
  // formula earlier on that line: keep them in order and never overlapping
  // (out of order, the builder throws and the keystroke is lost).
  let end = -1;
  for (const s of findMath(state.doc.toString()).sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (s.from >= s.to || s.from < end) continue;
    end = s.to;
    if (isInExcludedRegion(state, s.from)) continue; // math inside code stays raw
    if (sel.ranges.some((r) => r.from <= s.to && r.to >= s.from)) continue; // editing → raw
    builder.add(
      s.from,
      s.to,
      Decoration.replace({ widget: new MathWidget(s.tex, s.display, s.block, mathGeneration()), block: s.block }),
    );
  }
  return builder.finish();
}

const mathField = StateField.define<DecorationSet>({
  create: (state) => compute(state),
  update: (deco, tr) => (tr.docChanged || tr.selection || hasMathLoaded(tr.effects) ? compute(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

// A click on a rendered block's padding, or a pixel row along it, resolves to
// the very start or end of its source. Put the caret just inside the `$$`
// instead, so the source opens for editing and a key never breaks a delimiter.
const edgeClick = State.transactionFilter.of((tr) => {
  if (!tr.isUserEvent("select.pointer") || tr.docChanged || !tr.selection) return tr;
  const deco = tr.startState.field(mathField);
  const doc = tr.startState.doc;
  let moved = false;
  const ranges = tr.newSelection.ranges.map((r) => {
    if (!r.empty) return r;
    let pos = r.head;
    deco.between(r.head, r.head, (from, to, d) => {
      if (!(d.spec.widget instanceof MathWidget) || !d.spec.widget.block) return;
      const src = doc.sliceString(from, to);
      if (r.head === from) pos = from + src.indexOf("$$") + 2;
      // A click below the note's last block continues the note after it.
      else if (r.head === to && to < doc.length) pos = from + src.lastIndexOf("$$");
    });
    if (pos === r.head) return r;
    moved = true;
    return EditorSelection.cursor(pos);
  });
  if (!moved) return tr;
  return [tr, { selection: EditorSelection.create(ranges, tr.newSelection.mainIndex), sequential: true }];
});

// Runs after the Properties filter, which can move a click to a block's start.
export const math: Extension = [mathField, Prec.high(edgeClick)];
