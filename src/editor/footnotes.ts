// Footnotes in Live Preview. A reference `[^id]` (NOT a definition `[^id]:` at
// line start) renders as a small superscript marker, and an inline footnote
// `^[text]` as its text, small and raised, as Obsidian shows both; the caret
// landing on one reveals the raw token so it stays editable. Definitions are
// left as plain text (they're the content you edit). Regex-scan the viewport
// like highlight.ts, since footnotes aren't a lezer node.
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { isInExcludedRegion, treeChanged } from "./regions";

// A footnote reference [^id] (id non-space; a definition is skipped by checking
// the chars around it), or an inline footnote ^[text].
const REF_RE = /\[\^([^\]\s]+)\]|\^\[([^\]\n]+)\]/g;
const CONCEAL = Decoration.replace({});
const INLINE = Decoration.mark({ class: "cm-footnote-inline" });

class FootnoteWidget extends WidgetType {
  constructor(readonly id: string) {
    super();
  }
  eq(o: FootnoteWidget): boolean {
    return o.id === this.id;
  }
  toDOM(): HTMLElement {
    const sup = document.createElement("sup");
    sup.className = "cm-footnote-ref";
    sup.textContent = this.id;
    sup.title = `Footnote ${this.id}`;
    return sup;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc, selection: sel } = view.state;
  const touches = (from: number, to: number): boolean =>
    sel.ranges.some((r) => r.from <= to && r.to >= from);

  for (const { from, to } of view.visibleRanges) {
    const text = doc.sliceString(from, to);
    REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REF_RE.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (isInExcludedRegion(view.state, start)) continue;
      if (m[2] !== undefined) {
        if (touches(start, end)) continue;
        builder.add(start, start + 2, CONCEAL);
        builder.add(start + 2, end - 1, INLINE);
        builder.add(end - 1, end, CONCEAL);
        continue;
      }
      // Skip a DEFINITION `[^id]:` — the token is followed by a colon and the
      // line begins with it (ignoring leading whitespace).
      const line = doc.lineAt(start);
      const afterChar = doc.sliceString(end, end + 1);
      const beforeText = doc.sliceString(line.from, start);
      if (afterChar === ":" && beforeText.trim() === "") continue;
      if (touches(start, end)) continue; // editing → show raw
      builder.add(start, end, Decoration.replace({ widget: new FootnoteWidget(m[1]) }));
    }
  }
  return builder.finish();
}

export const footnotes: Extension = ViewPlugin.fromClass(
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
