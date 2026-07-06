// Paste a URL over a non-empty selection → a Markdown link [selection](url),
// matching Obsidian. Only fires when the clipboard is a single bare URL and
// text is selected; otherwise the default paste runs (files handled elsewhere).
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

const URL_RE = /^(https?:\/\/|obsidian:\/\/|mailto:)\S+$/i;

export const pasteLink: Extension = EditorView.domEventHandlers({
  paste: (event, view) => {
    const text = event.clipboardData?.getData("text/plain")?.trim();
    if (!text || !URL_RE.test(text)) return false;
    const sel = view.state.selection.main;
    if (sel.empty) return false; // no selection → paste the URL as-is
    const selected = view.state.sliceDoc(sel.from, sel.to);
    if (/[\n\]]/.test(selected)) return false; // multi-line / bracket → leave default
    event.preventDefault();
    const insert = `[${selected}](${text})`;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      // caret after the inserted link
      selection: { anchor: sel.from + insert.length },
    });
    return true;
  },
});
