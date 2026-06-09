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

function buildDecorations(view: EditorView): DecorationSet {
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
        this.decorations = buildDecorations(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildDecorations(update.view);
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
