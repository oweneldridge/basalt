// Live Preview for math: `$…$` (inline) and `$$…$$` (display, inline or a
// multi-line block). Rendered with KaTeX (lazy-loaded). Caret outside → render;
// inside → reveal the raw source, like mermaid/transclusion.
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { isInExcludedRegion } from "./regions";

interface MathSpan {
  from: number;
  to: number;
  tex: string;
  display: boolean;
  block: boolean;
}

const MATH_RE = /\$\$([\s\S]+?)\$\$|\$(?!\s)((?:\\.|[^$\n\\])+?)(?<!\s)\$/g;

function findMath(text: string): MathSpan[] {
  const spans: MathSpan[] = [];
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
  ) {
    super();
  }
  eq(o: MathWidget): boolean {
    return o.tex === this.tex && o.display === this.display && o.block === this.block;
  }
  toDOM(): HTMLElement {
    const el = document.createElement(this.block ? "div" : "span");
    el.className = "cm-math" + (this.block ? " cm-math-block" : "");
    void import("../lib/math").then((m) => {
      el.innerHTML = m.renderMath(this.tex, this.display);
    });
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function compute(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = state.selection;
  for (const s of findMath(state.doc.toString())) {
    if (s.from >= s.to) continue;
    if (isInExcludedRegion(state, s.from)) continue; // math inside code stays raw
    if (sel.ranges.some((r) => r.from <= s.to && r.to >= s.from)) continue; // editing → raw
    builder.add(
      s.from,
      s.to,
      Decoration.replace({ widget: new MathWidget(s.tex, s.display, s.block), block: s.block }),
    );
  }
  return builder.finish();
}

const mathField = StateField.define<DecorationSet>({
  create: (state) => compute(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? compute(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

export const math: Extension = mathField;
