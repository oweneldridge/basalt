// Editor theme + Markdown syntax highlighting. Dark, Obsidian-adjacent.
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

export const basaltTheme: Extension = EditorView.theme(
  {
    "&": {
      color: "var(--text)",
      backgroundColor: "var(--bg-editor)",
      height: "100%",
      fontSize: "16px",
    },
    ".cm-content": {
      caretColor: "var(--accent)",
      fontFamily: "var(--font-text)",
      lineHeight: "1.6",
      padding: "16px 0 40vh 0",
      maxWidth: "780px",
      margin: "0 auto",
    },
    ".cm-scroller": { overflow: "auto" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--selection)",
    },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-line": { padding: "0 2px" },
    // Wikilinks
    ".cm-wikilink": {
      color: "var(--accent)",
      cursor: "pointer",
      textDecoration: "none",
    },
    ".cm-wikilink:hover": { textDecoration: "underline" },
    ".cm-wikilink-source": { color: "var(--accent)" },
    // Markdown links
    ".cm-md-link": { color: "var(--accent)", textDecoration: "none", cursor: "pointer" },
    ".cm-md-link:hover": { textDecoration: "underline" },
    // Inline code (in rendered widgets like table cells)
    ".cm-inline-code": {
      fontFamily: "var(--font-mono)",
      background: "var(--bg-elev)",
      padding: "1px 5px",
      borderRadius: "4px",
      color: "var(--code)",
      fontSize: "0.9em",
    },
    // List bullets + task checkboxes
    ".cm-list-bullet": { color: "var(--text-muted)" },
    ".cm-task-checkbox": { marginRight: "6px", verticalAlign: "middle", cursor: "pointer" },
    // Rendered tables
    ".cm-md-table-wrap": { overflowX: "auto", margin: "10px 0" },
    ".cm-md-table": { borderCollapse: "collapse", fontSize: "0.95em" },
    ".cm-md-table th, .cm-md-table td": {
      border: "1px solid var(--border)",
      padding: "5px 11px",
      textAlign: "left",
    },
    ".cm-md-table th": { background: "var(--bg-elev)", fontWeight: "700" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.8em", fontWeight: "700", lineHeight: "1.3" },
  { tag: t.heading2, fontSize: "1.5em", fontWeight: "700", lineHeight: "1.3" },
  { tag: t.heading3, fontSize: "1.3em", fontWeight: "700" },
  { tag: t.heading4, fontSize: "1.15em", fontWeight: "700" },
  { tag: [t.heading5, t.heading6], fontWeight: "700", color: "var(--text-muted)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--text-muted)" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--text-muted)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", color: "var(--code)" },
  { tag: t.quote, color: "var(--text-muted)", fontStyle: "italic" },
  { tag: t.list, color: "var(--text)" },
  { tag: t.contentSeparator, color: "var(--text-muted)" },
  { tag: [t.meta, t.processingInstruction], color: "var(--text-faint)" },
  { tag: t.comment, color: "var(--text-faint)", fontStyle: "italic" },
]);

export const basaltHighlight: Extension = syntaxHighlighting(highlight);
