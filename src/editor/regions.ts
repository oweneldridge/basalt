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

/**
 * Range of a leading YAML frontmatter block (`---` on line 1 to its closing
 * `---`/`...`), or null. Lezer Markdown doesn't model frontmatter, so we detect
 * it directly — shared by the Properties widget and Live Preview (which must skip
 * it so YAML `- list` lines don't render as Markdown bullets).
 */
export function frontmatterRange(state: EditorState): { from: number; to: number } | null {
  const { doc } = state;
  if (doc.lines < 2) return null;
  const first = doc.line(1);
  if (first.text.trim() !== "---") return null;
  for (let i = 2; i <= doc.lines; i++) {
    const line = doc.line(i);
    const t = line.text.trim();
    if (t === "---" || t === "...") {
      return { from: first.from, to: line.to };
    }
  }
  return null; // unterminated → not frontmatter
}
