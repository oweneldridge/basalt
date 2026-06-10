// Live Preview: render Markdown inline and conceal its syntax unless the cursor
// is editing that element. The raw Markdown always remains the document's source
// of truth — this is pure presentation (see ARCHITECTURE.md, Principle 2).
//
// Handles: heading / emphasis / strong / inline-code / strikethrough / blockquote
// marks, unordered list bullets, task checkboxes, and inline [text](url) links.
// Tables are handled in tables.ts (block widgets); fenced code is left raw.
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { parseMarkdownLink } from "../lib/markdown";
import { frontmatterRange } from "./regions";

export interface LivePreviewOptions {
  /** Open an external URL (a clicked Markdown link). */
  onOpenUrl: (url: string) => void;
  /** Resolve an image reference to a displayable URL (or null if missing). */
  resolveImage: (target: string) => Promise<string | null>;
}

/** Parse an image alt that may carry Obsidian's `|width` or `|WxH`. */
export function parseImageAlt(alt: string): { alt: string; width?: number } {
  const pipe = alt.lastIndexOf("|");
  if (pipe < 0) return { alt };
  const size = alt.slice(pipe + 1).trim();
  // `|123` or `|123x456` is a size (width); otherwise it's just dropped. Either
  // way the pipe is stripped from the alt.
  const width = /^\d+(x\d+)?$/.test(size) ? parseInt(size, 10) : undefined;
  return { alt: alt.slice(0, pipe).trim(), width };
}

export class ImgWidget extends WidgetType {
  constructor(
    readonly alt: string,
    readonly src: string,
    readonly width: number | undefined,
    readonly resolve: (target: string) => Promise<string | null>,
  ) {
    super();
  }
  eq(other: ImgWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.width === this.width;
  }
  toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.alt = this.alt;
    if (this.width) img.style.maxWidth = `${this.width}px`;
    // Resolve async; retry once after the negative-cache TTL so an image
    // referenced before it exists self-heals without a reload.
    const load = (retry: boolean) => {
      this.resolve(this.src).then((url) => {
        if (url) img.src = url;
        else if (retry) window.setTimeout(() => load(false), 4500);
        else img.replaceWith(missingImage(this.alt || this.src));
      });
    };
    load(true);
    return img;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function missingImage(label: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "cm-md-image-missing";
  span.textContent = `🖼 ${label}`;
  return span;
}

const CONCEAL = Decoration.replace({});

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-list-bullet";
    span.textContent = "•";
    return span;
  }
  // Let clicks through so the caret can land on the line (revealing the raw '-').
  ignoreEvent(): boolean {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-task-checkbox";
    // Toggle on a real click (not mousedown — that would fire when starting a
    // drag-select). Resolve the marker's LIVE position from the DOM so we never
    // write to a stale offset.
    box.addEventListener("click", (e) => {
      if (e.detail > 1) return;
      e.preventDefault();
      const pos = view.posAtDOM(box);
      const line = view.state.doc.lineAt(pos);
      const m = /\[[ xX]\]/.exec(line.text);
      if (!m) return;
      const from = line.from + m.index;
      const to = from + 3;
      const checked = /\[[xX]\]/.test(view.state.doc.sliceString(from, to));
      view.dispatch({ changes: { from, to, insert: checked ? "[ ]" : "[x]" } });
    });
    return box;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const hr = document.createElement("span");
    hr.className = "cm-hr";
    return hr;
  }
}

class LinkWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly href: string,
  ) {
    super();
  }
  eq(other: LinkWidget): boolean {
    return other.text === this.text && other.href === this.href;
  }
  toDOM(): HTMLElement {
    const a = document.createElement("a");
    a.className = "cm-md-link";
    a.dataset.href = this.href;
    a.textContent = this.text || this.href;
    a.title = this.href;
    return a;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

// Mark node -> the parent element it must belong to (so we don't, e.g., conceal
// a fenced code block's ``` delimiters, which are also CodeMark).
const PARENT_TOUCH_MARKS: Record<string, string[]> = {
  HeaderMark: [
    "ATXHeading1",
    "ATXHeading2",
    "ATXHeading3",
    "ATXHeading4",
    "ATXHeading5",
    "ATXHeading6",
  ],
  EmphasisMark: ["Emphasis", "StrongEmphasis"],
  CodeMark: ["InlineCode"],
  StrikethroughMark: ["Strikethrough"],
};

function buildDecorations(
  view: EditorView,
  resolveImage: (target: string) => Promise<string | null>,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const { doc } = state;
  const sel = state.selection;
  const touches = (from: number, to: number): boolean =>
    sel.ranges.some((r) => r.from <= to && r.to >= from);
  const lineTouched = (pos: number): boolean => {
    const line = doc.lineAt(pos);
    return touches(line.from, line.to);
  };
  // Frontmatter is rendered by frontmatter.ts; don't apply Markdown decorations
  // (e.g. bullets to YAML `- list` lines) inside it.
  const fm = frontmatterRange(state);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        // Skip nodes that lie ENTIRELY within the frontmatter. Must test
        // `node.to <= fm.to`, not `node.from < fm.to` — the root Document node
        // starts at 0, so the latter would abort the whole walk.
        if (fm && node.to <= fm.to) return false;
        // Tables (tables.ts) and code blocks are handled/left alone elsewhere.
        if (name === "Table" || name === "FencedCode" || name === "CodeBlock") {
          return false;
        }
        // Reference definitions: leave raw (their URL must not be mis-marked).
        if (name === "LinkReference") return false;

        // Image: render an <img> (async-loaded), reveal raw when editing.
        if (name === "Image") {
          if (touches(node.from, node.to)) return false;
          const raw = doc.sliceString(node.from, node.to);
          if (raw.includes("![[")) return false; // embeds.ts owns embedded ![[…]]
          const parsed = parseMarkdownLink(raw);
          if (!parsed) return false;
          const { alt, width } = parseImageAlt(parsed.text);
          builder.add(
            node.from,
            node.to,
            Decoration.replace({ widget: new ImgWidget(alt, parsed.href, width, resolveImage) }),
          );
          return false;
        }

        const parents = PARENT_TOUCH_MARKS[name];
        if (parents) {
          const parent = node.node.parent;
          if (!parent || !parents.includes(parent.name)) return;
          if (touches(parent.from, parent.to)) return;
          let end = node.to;
          if (name === "HeaderMark" && doc.sliceString(end, end + 1) === " ") end += 1;
          if (end > node.from) builder.add(node.from, end, CONCEAL);
          return;
        }

        if (name === "QuoteMark") {
          if (lineTouched(node.from)) return;
          let end = node.to;
          if (doc.sliceString(end, end + 1) === " ") end += 1;
          if (end > node.from) builder.add(node.from, end, CONCEAL);
          return;
        }

        if (name === "ListMark") {
          if (lineTouched(node.from)) return;
          const isTask = /^\s?\[[ xX]\]/.test(doc.sliceString(node.to, node.to + 4));
          if (isTask) {
            builder.add(node.from, node.to, CONCEAL); // hide '-', checkbox renders
            return;
          }
          const marker = doc.sliceString(node.from, node.to);
          if (marker !== "-" && marker !== "*" && marker !== "+") return; // ordered: keep
          builder.add(node.from, node.to, Decoration.replace({ widget: new BulletWidget() }));
          return;
        }

        if (name === "TaskMarker") {
          if (lineTouched(node.from)) return;
          const checked = /\[[xX]\]/.test(doc.sliceString(node.from, node.to));
          builder.add(node.from, node.to, Decoration.replace({ widget: new CheckboxWidget(checked) }));
          return;
        }

        if (name === "HorizontalRule") {
          if (lineTouched(node.from)) return; // editing: show raw ---
          builder.add(node.from, node.to, Decoration.replace({ widget: new HrWidget() }));
          return;
        }

        if (name === "Link") {
          if (touches(node.from, node.to)) return false;
          const parsed = parseMarkdownLink(doc.sliceString(node.from, node.to));
          if (!parsed) return false; // reference-style / unusual: leave raw
          builder.add(
            node.from,
            node.to,
            Decoration.replace({ widget: new LinkWidget(parsed.text, parsed.href) }),
          );
          return false; // don't also process the LinkMark children
        }

        // Angle autolink <https://…>: conceal the <> and render a clickable link.
        if (name === "Autolink") {
          if (touches(node.from, node.to)) return false;
          let url = doc.sliceString(node.from, node.to);
          if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
          builder.add(node.from, node.to, Decoration.replace({ widget: new LinkWidget(url, url) }));
          return false;
        }

        // Bare URL / email (GFM): no syntax to hide — just style it clickable.
        // URL children of Link/Image/Autolink/LinkReference aren't reached (those
        // branches return false).
        if (name === "URL") {
          if (touches(node.from, node.to)) return;
          const url = doc.sliceString(node.from, node.to);
          const isEmail = !/^[a-z][a-z0-9+.-]*:/i.test(url) && url.includes("@");
          const href = isEmail ? `mailto:${url}` : url;
          builder.add(
            node.from,
            node.to,
            Decoration.mark({ class: "cm-md-link", attributes: { "data-href": href } }),
          );
          return;
        }

        return;
      },
    });
  }
  return builder.finish();
}

export function livePreview(opts: LivePreviewOptions): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, opts.resolveImage);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, opts.resolveImage);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const linkClick = EditorView.domEventHandlers({
    mousedown: (event) => {
      const el = (event.target as HTMLElement | null)?.closest(".cm-md-link") as HTMLElement | null;
      if (el && el.dataset.href) {
        opts.onOpenUrl(el.dataset.href);
        event.preventDefault();
        return true;
      }
      return false;
    },
  });

  return [plugin, linkClick];
}
