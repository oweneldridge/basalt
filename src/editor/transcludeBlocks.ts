// Live Preview for note transclusions ![[Note]] / ![[Note#Heading]] /
// ![[Note#^block]] (image embeds stay in embeds.ts). The embedded CONTENT is
// block-level, so — like mermaid/query — it must be a block widget from a
// StateField. Caret outside renders the embed; inside reveals the raw source.
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { isInExcludedRegion } from "./regions";
import { renderEmbedSource, getTranscludeHost } from "../lib/transclude";
import { mediaKind, mediaPath, buildMediaElement, type MediaKind } from "../lib/media";
import { internalLinkTarget, targetPathPart } from "../lib/markdown";
import { clickedLink } from "../lib/anchors";
import { notePathFacet } from "./query";
import { blockEdges } from "./blockEdges";

const EMBED_RE = /!\[\[([^\]\[\n|]+?)(?:\|([^\]\[\n]+))?\]\]/g;
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;

class MediaWidget extends WidgetType {
  constructor(
    readonly rawTarget: string,
    readonly kind: MediaKind,
    readonly notePath: string,
  ) {
    super();
  }
  eq(o: MediaWidget): boolean {
    return o.rawTarget === this.rawTarget && o.kind === this.kind && o.notePath === this.notePath;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-embed cm-media";
    const host = getTranscludeHost();
    if (!host) return wrap;
    void host.resolveImage(mediaPath(this.rawTarget), this.notePath).then((url) => {
      if (!wrap.isConnected) return;
      if (url) wrap.append(buildMediaElement(this.kind, url, this.rawTarget));
      else {
        wrap.textContent = `🎬 ${this.rawTarget} (not found)`;
        wrap.classList.add("md-media-missing");
      }
    });
    return wrap;
  }
  ignoreEvent(): boolean {
    return true; // let the player's own controls handle events
  }
}

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
    const pathPart = targetPathPart(rawTarget);
    if (IMAGE_EXT.test(pathPart)) continue; // images → embeds.ts
    if (isInExcludedRegion(state, start)) continue;
    if (sel.ranges.some((r) => r.from <= end && r.to >= start)) continue; // editing → raw
    const media = mediaKind(pathPart);
    builder.add(
      start,
      end,
      Decoration.replace({
        widget: media
          ? new MediaWidget(rawTarget, media, notePath)
          : new TranscludeWidget(rawTarget, notePath),
        block: true,
      }),
    );
  }
  return builder.finish();
}

const transcludeField = StateField.define<DecorationSet>({
  create: (state) => compute(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? compute(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

interface LinkOpeners {
  onOpenInternal: (target: string) => void;
  onOpenUrl: (url: string) => void;
}

// A link inside an embed opens as it would in the embedded note (Obsidian
// does the same); a click anywhere else on the embed (but not its title)
// places the caret inside for editing.
const transcludeClick = (open: LinkOpeners) => EditorView.domEventHandlers({
  mousedown: (event, view) => {
    const t = event.target as HTMLElement | null;
    if (!t) return false;
    const link = event.button === 0 && t.closest(".cm-embed") ? t.closest<HTMLElement>("a, area") : null;
    if (link) {
      event.preventDefault();
      if (link.classList.contains("md-wikilink")) open.onOpenInternal(link.dataset.target ?? "");
      else {
        const href = link.dataset.href ?? clickedLink(link)?.href ?? "";
        const internal = internalLinkTarget(href);
        if (internal !== null) open.onOpenInternal(internal);
        else if (href) open.onOpenUrl(href);
      }
      return true;
    }
    if (t.closest(".embed-title, a, button, input")) return false;
    const el = t.closest(".cm-embed") as HTMLElement | null;
    if (!el) return false;
    const pos = view.posAtDOM(el);
    const line = view.state.doc.lineAt(Math.min(pos + 1, view.state.doc.length));
    view.dispatch({ selection: { anchor: line.from } });
    event.preventDefault();
    return true;
  },
});

// The click that follows a link's mousedown must not navigate the window.
const keepWindow = EditorView.domEventHandlers({
  click: (event) => {
    const t = event.target as HTMLElement | null;
    if (!t?.closest(".cm-embed") || !clickedLink(t)) return false;
    event.preventDefault();
    return true;
  },
});

export function transcludeBlocks(open: LinkOpeners): Extension {
  return [transcludeField, transcludeClick(open), keepWindow, blockEdges(transcludeField)];
}
