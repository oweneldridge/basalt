// Blockquotes and Obsidian callouts (`> [!type] Title`). lezer already tags
// Blockquote; we add per-line decorations (a left border / tinted box) and, for
// callouts, conceal the `[!type]` token on the title line. Folding (+/-) lives
// in calloutFold.ts (a StateField, since it needs replace decorations). Line
// decorations are legal from a ViewPlugin.
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { treeChanged } from "./regions";
import { calloutColor, calloutIcon } from "../lib/callouticons";

/** The callout type's icon, rendered where the `[!type]` token was, with the
 * type as the title when the header has none ("> [!warning]" shows "Warning",
 * as in Obsidian). */
class IconWidget extends WidgetType {
  constructor(
    readonly type: string,
    readonly defaultTitle: string,
  ) {
    super();
  }
  eq(o: IconWidget): boolean {
    return o.type === this.type && o.defaultTitle === this.defaultTitle;
  }
  toDOM(): HTMLElement {
    const s = document.createElement("span");
    s.className = "cm-callout-icon";
    s.textContent = calloutIcon(this.type);
    if (!this.defaultTitle) return s;
    const wrap = document.createElement("span");
    const title = document.createElement("span");
    title.className = "cm-callout-default-title";
    title.textContent = this.defaultTitle;
    wrap.append(s, title);
    return wrap;
  }
}

// A quote's head: its own `>` and then `[!type]` (the quote node starts at
// its own `>`, so this reads a nested one the same way).
const CALLOUT_RE = /^>\s*\[!([\w-]+)\]([+-]?)\s?/;

/** Only the lines on screen. A quote inside a quote (one level) gets its own
 * bar and tint inside its parent's, and a callout there its own title. */
function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const { doc } = state;
  const sel = state.selection;
  const lineTouched = (from: number, lineTo: number): boolean =>
    sel.ranges.some((r) => r.from <= lineTo && r.to >= from);
  const classes = new Map<number, string[]>();
  const icons: { from: number; to: number; deco: Decoration }[] = [];

  const quote = (node: SyntaxNode, inner: boolean, first: number, last: number) => {
    const startLine = doc.lineAt(node.from).number;
    const endLine = doc.lineAt(Math.min(node.to, doc.length)).number;
    const headLine = doc.line(startLine);
    const head = CALLOUT_RE.exec(doc.sliceString(node.from, headLine.to));
    const group = head ? calloutColor(head[1]) : null;
    for (let n = Math.max(startLine, first); n <= Math.min(endLine, last); n++) {
      const cls = inner
        ? `cm-quote-inner${group ? ` cm-callout-inner cm-callout-inner-${group}${n === startLine ? " cm-callout-inner-title" : ""}` : ""}`
        : group
          ? `cm-callout cm-callout-${group}${n === startLine ? " cm-callout-title" : ""}`
          : "cm-blockquote";
      classes.set(n, [...(classes.get(n) ?? []), cls]);
    }
    if (head && startLine >= first && startLine <= last && !icons.some((x) => x.from === node.from + head[0].indexOf("[!")) && !lineTouched(headLine.from, headLine.to)) {
      // Replace the `[!type]` token with the type's icon (Obsidian shows one).
      const at = head[0].indexOf("[!");
      const cFrom = node.from + at;
      const untitled = doc.sliceString(node.from + head[0].length, headLine.to).trim() === "";
      const title = untitled ? head[1].charAt(0).toUpperCase() + head[1].slice(1).toLowerCase() : "";
      icons.push({ from: cFrom, to: node.from + head[0].length, deco: Decoration.replace({ widget: new IconWidget(head[1], title) }) });
    }
    if (!inner) {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.name === "Blockquote") quote(c.node, true, first, last);
      }
    }
  };

  for (const { from, to } of view.visibleRanges) {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Blockquote") return;
        quote(node.node, false, first, last);
        return false;
      },
    });
  }

  // Line decorations, then each line's icon, in document order.
  icons.sort((a, b) => a.from - b.from);
  let i = 0;
  for (const n of [...classes.keys()].sort((a, b) => a - b)) {
    const line = doc.line(n);
    builder.add(line.from, line.from, Decoration.line({ class: classes.get(n)!.join(" ") }));
    while (i < icons.length && icons[i].from <= line.to) {
      if (icons[i].from >= line.from) builder.add(icons[i].from, icons[i].to, icons[i].deco);
      i++;
    }
  }
  return builder.finish();
}

export const callouts: Extension = ViewPlugin.fromClass(
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
