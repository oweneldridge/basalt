// Code colours, under Obsidian's --code-* variables (styles.css): one
// highlighter for Live Preview's code blocks and Reading view's, which loads
// each language only when a note has a block in it.
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode, tagHighlighter, tags as t } from "@lezer/highlight";

export const codeHighlighter = tagHighlighter([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], class: "code-keyword" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], class: "code-string" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: "code-function" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.constant(t.name)], class: "code-value" },
  { tag: [t.propertyName, t.attributeName, t.labelName], class: "code-property" },
  { tag: [t.tagName, t.typeName, t.className, t.namespace, t.operator], class: "code-tag" },
  { tag: [t.punctuation, t.bracket, t.separator], class: "code-punctuation" },
  { tag: t.comment, class: "code-comment" },
]);

/** Colour the fenced code blocks under `root` (Reading view). */
export async function highlightCodeBlocks(root: HTMLElement, alive: () => boolean): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre.md-code > code[class^='language-']")];
  for (const code of blocks) {
    const name = /language-(\S+)/.exec(code.className)?.[1] ?? "";
    const desc = LanguageDescription.matchLanguageName(languages, name, true);
    const support = desc ? await desc.load().catch(() => null) : null;
    if (!support || !alive() || !code.isConnected) continue;
    const text = code.textContent ?? "";
    const out = document.createDocumentFragment();
    highlightCode(
      text,
      support.language.parser.parse(text),
      codeHighlighter,
      (piece, classes) => {
        if (!classes) return out.append(piece);
        const span = document.createElement("span");
        span.className = classes;
        span.textContent = piece;
        out.append(span);
      },
      () => out.append("\n"),
    );
    code.replaceChildren(out);
  }
}
