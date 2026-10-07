// Style fenced/indented code blocks as code: a monospace, tinted box. We use
// line decorations (allowed from a ViewPlugin — they don't change block
// structure) so the raw Markdown, including the ``` fences, stays intact and
// editable. Syntax highlighting inside the block still comes from the markdown
// language's nested code-language parsing.
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { treeChanged } from "./regions";

const codeLine = Decoration.line({ class: "cm-code-line" });
const codeFirst = Decoration.line({ class: "cm-code-line cm-code-first" });
const codeLast = Decoration.line({ class: "cm-code-line cm-code-last" });

/** Only the lines on screen: a long note full of code would otherwise be
 * walked line by line on every keystroke. */
function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;
  let done = 0; // the last line decorated (visible ranges may share a block)
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "FencedCode" && node.name !== "CodeBlock") return;
        const startLine = doc.lineAt(node.from).number;
        const endLine = doc.lineAt(Math.min(node.to, doc.length)).number;
        const last = Math.min(endLine, doc.lineAt(to).number);
        for (let n = Math.max(startLine, doc.lineAt(from).number, done + 1); n <= last; n++) {
          const line = doc.line(n);
          const deco = n === startLine ? codeFirst : n === endLine ? codeLast : codeLine;
          builder.add(line.from, line.from, deco);
          done = n;
        }
        return false;
      },
    });
  }
  return builder.finish();
}

export const codeBlocks: Extension = ViewPlugin.fromClass(
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
