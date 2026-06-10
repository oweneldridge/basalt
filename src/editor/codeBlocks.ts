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

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;
  syntaxTree(view.state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode" && node.name !== "CodeBlock") return;
      const startLine = doc.lineAt(node.from).number;
      const endLine = doc.lineAt(Math.min(node.to, doc.length)).number;
      for (let n = startLine; n <= endLine; n++) {
        const line = doc.line(n);
        const deco = n === startLine ? codeFirst : n === endLine ? codeLast : codeLine;
        builder.add(line.from, line.from, deco);
      }
      return false;
    },
  });
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
