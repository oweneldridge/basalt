// Obsidian IMAGE embeds `![[img.png]]` render as an <img> in Live Preview (note
// transclusions ![[Note]] live in editor/transcludeBlocks.ts). Regex-scan
// (CommonMark has no embed node); reveal raw `![[…]]` when editing.
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { isInExcludedRegion, treeChanged } from "./regions";
import { ImgWidget } from "./livePreview";
import { targetPathPart } from "../lib/markdown";

const EMBED_SRC = "!\\[\\[([^\\]\\[\\n|]+?)(?:\\|([^\\]\\[\\n]+))?\\]\\]";
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;

export interface EmbedOptions {
  resolveImage: (target: string) => Promise<string | null>;
  onOpen: (target: string) => void;
}

function build(view: EditorView, opts: EmbedOptions): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = view.state.selection;
  const touches = (a: number, b: number): boolean =>
    sel.ranges.some((r) => r.from <= b && r.to >= a);

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const re = new RegExp(EMBED_SRC, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const rawTarget = m[1].trim();
      if (!IMAGE_EXT.test(targetPathPart(rawTarget))) continue; // note embed → transcludeBlocks
      const start = from + m.index;
      const end = start + m[0].length;
      if (isInExcludedRegion(view.state, start)) continue;
      if (touches(start, end)) {
        builder.add(start, end, Decoration.mark({ class: "cm-embed-source" }));
        continue;
      }
      const aliasOrSize = (m[2] ?? "").trim();
      const width = /^\d+(x\d+)?$/.test(aliasOrSize) ? parseInt(aliasOrSize, 10) : undefined;
      builder.add(
        start,
        end,
        Decoration.replace({ widget: new ImgWidget(rawTarget, rawTarget, width, opts.resolveImage) }),
      );
    }
  }
  return builder.finish();
}

export function embeds(opts: EmbedOptions): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, opts);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged || treeChanged(update)) {
          this.decorations = build(update.view, opts);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
