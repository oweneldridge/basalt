// Pasting from a web page or a document turns its HTML into Markdown, as
// Obsidian does. A paste into code, or HTML with nothing a plain paste would
// lose, stays plain text.
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { htmlToMarkdown, pastedHtmlMatters } from "../lib/htmlToMarkdown";

const CODE = /^(FencedCode|CodeBlock|InlineCode|CodeText)$/;

export const pasteHtml: Extension = EditorView.domEventHandlers({
  paste: (event, view) => {
    // Files (an image copied from a page) are the attachments handler's.
    if (event.clipboardData?.files.length) return false;
    const html = event.clipboardData?.getData("text/html");
    if (!html || !pastedHtmlMatters(html)) return false;
    for (let n: { name: string; parent: unknown } | null = syntaxTree(view.state).resolveInner(view.state.selection.main.head, -1); n; n = n.parent as typeof n) {
      if (CODE.test(n.name)) return false;
    }
    const md = htmlToMarkdown(html);
    if (!md) return false;
    event.preventDefault();
    view.dispatch({ ...view.state.replaceSelection(md), userEvent: "input.paste", scrollIntoView: true });
    return true;
  },
});
