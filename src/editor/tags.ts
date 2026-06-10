// Tags `#tag` / `#nested/tag`. Styled as a chip via an inline mark — the text is
// never concealed (always editable). Regex-scan (the wikilink.ts pattern), but
// mark-only (no widget, no click for now).
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { tagRegex } from "../lib/markdown";
import { isInExcludedRegion, isInLinkContext, frontmatterRange, treeChanged } from "./regions";

const TAG = Decoration.mark({ class: "cm-tag" });

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const fm = frontmatterRange(view.state);
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const re = tagRegex();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const hashIdx = m[0].indexOf("#");
      const tagStart = from + m.index + hashIdx;
      const tagEnd = tagStart + m[1].length;
      if (/^\d+$/.test(m[2])) continue; // pure-numeric isn't a tag (Obsidian rule)
      if (fm && tagStart < fm.to) continue; // YAML `tags:` lines aren't chips
      if (isInExcludedRegion(view.state, tagStart)) continue; // code / tables
      if (isInLinkContext(view.state, tagStart)) continue; // link text / destinations
      builder.add(tagStart, tagEnd, TAG);
    }
  }
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
