// Shared "is this position inside a region where Markdown rendering should be
// suppressed?" check, so the regex-scanning extensions (wikilinks) agree with
// the tree-walking ones about boundaries — and never decorate inside code or
// inside a table block widget.
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { syntaxTree } from "@codemirror/language";

const EXCLUDED = new Set(["Table", "FencedCode", "CodeBlock", "InlineCode"]);

export function isInExcludedRegion(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  while (node) {
    if (EXCLUDED.has(node.name)) return true;
    node = node.parent;
  }
  return false;
}
