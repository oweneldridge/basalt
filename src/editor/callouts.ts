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
import { treeChanged } from "./regions";
import { calloutIcon } from "../lib/callouticons";

/** The callout type's icon, rendered where the `[!type]` token was. */
class IconWidget extends WidgetType {
  constructor(readonly type: string) {
    super();
  }
  eq(o: IconWidget): boolean {
    return o.type === this.type;
  }
  toDOM(): HTMLElement {
    const s = document.createElement("span");
    s.className = "cm-callout-icon";
    s.textContent = calloutIcon(this.type);
    return s;
  }
}

const CALLOUT_RE = /^\s*>\s*\[!(\w+)\]([+-]?)/;

// Map the ~25 built-in callout types to a small set of color groups.
function calloutGroup(type: string): string {
  const t = type.toLowerCase();
  if (["tip", "success", "check", "done", "hint", "important"].includes(t)) return "green";
  if (["warning", "caution", "attention", "todo"].includes(t)) return "orange";
  if (["danger", "error", "bug", "failure", "fail", "missing"].includes(t)) return "red";
  if (["question", "help", "faq"].includes(t)) return "purple";
  if (["quote", "cite", "example"].includes(t)) return "gray";
  return "blue"; // note/info/abstract/summary/tldr and unknown types
}


function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const { doc } = state;
  const sel = state.selection;
  const lineTouched = (from: number, lineTo: number): boolean =>
    sel.ranges.some((r) => r.from <= lineTo && r.to >= from);

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Blockquote") return;
      const startLine = doc.lineAt(node.from).number;
      const endLine = doc.lineAt(Math.min(node.to, doc.length)).number;
      const head = CALLOUT_RE.exec(doc.line(startLine).text);
      const group = head ? calloutGroup(head[1]) : null;

      for (let n = startLine; n <= endLine; n++) {
        const line = doc.line(n);
        const cls = group
          ? `cm-callout cm-callout-${group}${n === startLine ? " cm-callout-title" : ""}`
          : "cm-blockquote";
        // Line decoration at line.from, then (title line) the [!type] conceal at a
        // later offset — added in order so the RangeSetBuilder stays sorted.
        builder.add(line.from, line.from, Decoration.line({ class: cls }));
        if (group && n === startLine && !lineTouched(line.from, line.to)) {
          const m = /\[!(\w+)\][+-]?\s?/.exec(line.text);
          if (m) {
            const cFrom = line.from + m.index;
            // Replace the `[!type]` token with the type's icon (Obsidian shows one).
            builder.add(cFrom, cFrom + m[0].length, Decoration.replace({ widget: new IconWidget(m[1]) }));
          }
        }
      }
      return false; // don't descend (nested quotes left as-is for now)
    },
  });
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
