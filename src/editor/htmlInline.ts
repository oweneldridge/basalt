// Inline raw HTML in Live Preview: the inline tags Reading view renders
// (<b>, <i>, <span>, <font>, <sup>, <mark>, <kbd>, …) show by concealing the
// tags and styling the content with a class that mimics the element
// (superscript via vertical-align, highlight, strike, …), revealing the raw
// markup when the caret is on the span. Attributes are dropped, as Reading view
// drops them, but for a plain colour on <font>. Nothing else is ever rendered,
// so it's safe; block HTML stays in Reading mode / export via DOMPurify.
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { isInExcludedRegion, treeChanged } from "./regions";

const TAGS = "abbr|bdi|big|b|cite|code|del|dfn|em|font|ins|i|kbd|mark|q|samp|small|span|strike|strong|sub|sup|s|time|u|var";
const PAIR_RE = new RegExp(`<(${TAGS})(\\s[^<>]*)?>([^<]*?)</\\1>`, "gi");
const FONT_COLOR = /\bcolor\s*=\s*["']?(#[0-9a-f]{3,8}|[a-z]+)["'\s>]?/i;
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
      const innerFrom = start + m[0].indexOf(">") + 1;
      const innerTo = end - (tag.length + 3); // `</tag>`
      if (innerTo <= innerFrom) continue;
      const color = tag === "font" ? FONT_COLOR.exec(m[2] ?? "")?.[1] : undefined;
      builder.add(start, innerFrom, CONCEAL);
      builder.add(
        innerFrom,
        innerTo,
        Decoration.mark({ class: `cm-html-${tag}`, attributes: color ? { style: `color: ${color}` } : undefined }),
      );
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
