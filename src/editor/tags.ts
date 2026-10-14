// Tags `#tag` / `#nested/tag`. Styled as a chip via an inline mark — the text is
// never concealed (always editable). Regex-scan (the wikilink.ts pattern), but
// mark-only (no widget, no click for now).
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { tagRegex } from "../lib/markdown";
import { isInExcludedRegion, isInHtml, isInLinkContext, frontmatterRange, treeChanged } from "./regions";

const TAG = Decoration.mark({ class: "cm-tag" });

/** Where Live Preview shows tag chips in `ranges` of the document. */
export function findTags(state: EditorState, ranges: readonly { from: number; to: number }[]): [number, number][] {
  const out: [number, number][] = [];
  const fm = frontmatterRange(state);
  for (const { from, to } of ranges) {
    const text = state.doc.sliceString(from, to);
    const re = tagRegex();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const hashIdx = m[0].indexOf("#");
      const tagStart = from + m.index + hashIdx;
      const tagEnd = tagStart + m[1].length;
      if (/^\d+$/.test(m[2])) continue; // pure-numeric isn't a tag (Obsidian rule)
      if (fm && tagStart < fm.to) continue; // YAML `tags:` lines aren't chips
      if (isInExcludedRegion(state, tagStart)) continue; // code / tables
      if (isInHtml(state, tagStart)) continue; // `fill="#e8710a"` is a colour
      if (isInLinkContext(state, tagStart)) continue; // link text / destinations
      // `>#tag` only where the `>` opens a quote line.
      if (text[tagStart - from - 1] === ">" && syntaxTree(state).resolveInner(tagStart - 1, 1).name !== "QuoteMark") continue;
      out.push([tagStart, tagEnd]);
    }
  }
  return out;
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const [from, to] of findTags(view.state, view.visibleRanges)) builder.add(from, to, TAG);
  return builder.finish();
}

export const tags: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || treeChanged(update))
        this.decorations = build(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);
