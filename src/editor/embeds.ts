// Obsidian embeds `![[…]]`: image files render as an <img>; note embeds render
// as a titled box that opens the note (full transclusion is a later phase).
// Regex-scan (CommonMark has no embed node); reveal raw `![[…]]` when editing.
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { isInExcludedRegion } from "./regions";
import { ImgWidget } from "./livePreview";
import { targetPathPart } from "../lib/markdown";

const EMBED_SRC = "!\\[\\[([^\\]\\[\\n|]+?)(?:\\|([^\\]\\[\\n]+))?\\]\\]";
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;

export interface EmbedOptions {
  resolveImage: (target: string) => Promise<string | null>;
  onOpen: (target: string) => void;
}

class NoteEmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly label: string,
  ) {
    super();
  }
  eq(other: NoteEmbedWidget): boolean {
    return other.target === this.target && other.label === this.label;
  }
  toDOM(): HTMLElement {
    const box = document.createElement("div");
    box.className = "cm-embed-note";
    box.dataset.target = this.target;
    box.textContent = this.label;
    box.setAttribute("role", "link");
    return box;
  }
  ignoreEvent(): boolean {
    return false;
  }
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
      const start = from + m.index;
      const end = start + m[0].length;
      if (isInExcludedRegion(view.state, start)) continue;
      if (touches(start, end)) {
        builder.add(start, end, Decoration.mark({ class: "cm-embed-source" }));
        continue;
      }
      const rawTarget = m[1].trim();
      const aliasOrSize = (m[2] ?? "").trim();
      const pathPart = targetPathPart(rawTarget);
      if (IMAGE_EXT.test(pathPart)) {
        const width = /^\d+(x\d+)?$/.test(aliasOrSize) ? parseInt(aliasOrSize, 10) : undefined;
        builder.add(
          start,
          end,
          Decoration.replace({ widget: new ImgWidget(rawTarget, rawTarget, width, opts.resolveImage) }),
        );
      } else {
        const label = aliasOrSize || (pathPart.split("/").pop() ?? pathPart);
        builder.add(start, end, Decoration.replace({ widget: new NoteEmbedWidget(rawTarget, label) }));
      }
    }
  }
  return builder.finish();
}

export function embeds(opts: EmbedOptions): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, opts);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = build(update.view, opts);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const click = EditorView.domEventHandlers({
    mousedown: (event) => {
      const el = (event.target as HTMLElement | null)?.closest(".cm-embed-note") as HTMLElement | null;
      if (el && el.dataset.target) {
        opts.onOpen(el.dataset.target);
        event.preventDefault();
        return true;
      }
      return false;
    },
  });

  return [plugin, click];
}
