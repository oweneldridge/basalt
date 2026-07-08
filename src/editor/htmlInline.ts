// Inline raw HTML in Live Preview: render the SAFE, attribute-free inline tags
// (<sup>, <sub>, <mark>, <kbd>, <u>, <s>, <ins>, <del>, <small>, <abbr>, <cite>)
// by concealing the tags and styling the content with a class that mimics the
// element (superscript via vertical-align, highlight, strike, …), revealing the
// raw markup when the caret is on the span. Only this fixed allowlist — no
// attributes, no <script>/<style> — so it's safe (the same set render.ts allows
// inline; block HTML stays in Reading mode / export via DOMPurify).
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { isInExcludedRegion, treeChanged } from "./regions";

const TAGS = "sup|sub|mark|kbd|u|s|ins|del|small|abbr|cite";
const PAIR_RE = new RegExp(`<(${TAGS})>([^<]*?)</\\1>`, "gi");
const CONCEAL = Decoration.replace({});

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = view.state.selection;
  const touches = (from: number, to: number): boolean =>
    sel.ranges.some((r) => r.from <= to && r.to >= from);

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    PAIR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PAIR_RE.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (isInExcludedRegion(view.state, start)) continue;
      if (touches(start, end)) continue; // editing → show raw markup
      const tag = m[1].toLowerCase();
      const openLen = tag.length + 2; // `<tag>`
      const innerFrom = start + openLen;
      const innerTo = end - (tag.length + 3); // `</tag>`
      if (innerTo <= innerFrom) continue;
      builder.add(start, innerFrom, CONCEAL);
      builder.add(innerFrom, innerTo, Decoration.mark({ class: `cm-html-${tag}` }));
      builder.add(innerTo, end, CONCEAL);
    }
  }
  return builder.finish();
}

export const htmlInline: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || treeChanged(update)) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
