// Live Preview for note transclusions ![[Note]] / ![[Note#Heading]] /
// ![[Note#^block]] (image embeds stay in embeds.ts). The embedded CONTENT is
// block-level, so — like mermaid/query — it must be a block widget from a
// StateField. Caret outside renders the embed; inside reveals the raw source.
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { isInExcludedRegion } from "./regions";
import { renderEmbedSource } from "../lib/transclude";
import { targetPathPart } from "../lib/markdown";
import { notePathFacet } from "./query";

const EMBED_RE = /!\[\[([^\]\[\n|]+?)(?:\|([^\]\[\n]+))?\]\]/g;
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;

class TranscludeWidget extends WidgetType {
  constructor(
    readonly rawTarget: string,
    readonly notePath: string,
  ) {
    super();
  }
  eq(o: TranscludeWidget): boolean {
    return o.rawTarget === this.rawTarget && o.notePath === this.notePath;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-embed";
    wrap.append(renderEmbedSource(this.rawTarget, this.notePath));
    return wrap;
  }
  ignoreEvent(event: Event): boolean {
    return event.type !== "mousedown" && event.type !== "click";
  }
}

function compute(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = state.selection;
  const notePath = state.facet(notePathFacet);
  const text = state.doc.toString();
  EMBED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMBED_RE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    const rawTarget = m[1].trim();
    if (IMAGE_EXT.test(targetPathPart(rawTarget))) continue; // images → embeds.ts
    if (isInExcludedRegion(state, start)) continue;
    if (sel.ranges.some((r) => r.from <= end && r.to >= start)) continue; // editing → raw
    builder.add(start, end, Decoration.replace({ widget: new TranscludeWidget(rawTarget, notePath), block: true }));
  }
  return builder.finish();
}

const transcludeField = StateField.define<DecorationSet>({
  create: (state) => compute(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? compute(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

// Click the embed (but not its title link / a nested link) to place the caret
// inside for editing.
const transcludeClick = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    const t = event.target as HTMLElement | null;
    if (!t || t.closest(".embed-title, a, button, input")) return false;
    const el = t.closest(".cm-embed") as HTMLElement | null;
    if (!el) return false;
    const pos = view.posAtDOM(el);
    const line = view.state.doc.lineAt(Math.min(pos + 1, view.state.doc.length));
    view.dispatch({ selection: { anchor: line.from } });
    event.preventDefault();
    return true;
  },
});

export const transcludeBlocks: Extension = [transcludeField, transcludeClick];
