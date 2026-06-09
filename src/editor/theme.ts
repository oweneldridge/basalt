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
    // NOTE: never set max-width/margin on .cm-content — it desyncs CodeMirror's
    // click→position mapping (posAtCoords). And keep horizontal padding here at 0,
    // or the selection/active-line background bleeds into it. Reading-column width
    // and side gutters live on the editor host instead (see styles.css).
    ".cm-content": {
      caretColor: "var(--accent)",
      fontFamily: "var(--font-text)",
      lineHeight: "1.6",
      padding: "16px 0 40vh 0",
    },
    ".cm-scroller": { overflow: "auto" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--selection)",
    },
    ".cm-activeLine": { backgroundColor: "transparent" },
    // Reading column at the LINE level (not .cm-content) so the scroller stays
    // full-width (scrollbar flush with the panel) and click mapping is unaffected
    // (CM's content origin still fills the editor). Left-aligned with a left
    // gutter; padding (not margin) keeps the selection from bleeding into it.
    ".cm-line": { padding: "0 2px 0 48px", maxWidth: "868px" },
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
    // Horizontal rule (---)
    ".cm-hr": {
      display: "inline-block",
      width: "100%",
      borderTop: "1px solid var(--border)",
      verticalAlign: "middle",
    },
    // Fenced/indented code blocks
    ".cm-code-line": {
      fontFamily: "var(--font-mono)",
      fontSize: "0.88em",
      background: "var(--bg-elev)",
    },
    ".cm-code-first": { borderRadius: "6px 6px 0 0", paddingTop: "6px" },
    ".cm-code-last": { borderRadius: "0 0 6px 6px", paddingBottom: "6px" },
    // Rendered tables — align with the text gutter (50px ≈ .cm-line 48 + 2 pad)
    ".cm-md-table-wrap": { overflowX: "auto", margin: "10px 0 10px 50px", maxWidth: "820px" },
    ".cm-md-table": { borderCollapse: "collapse", fontSize: "0.95em" },
    ".cm-md-table th, .cm-md-table td": {
      border: "1px solid var(--border)",
      padding: "5px 11px",
      textAlign: "left",
    },
    ".cm-md-table th": { background: "var(--bg-elev)", fontWeight: "700" },
    // Frontmatter "Properties" view
    ".cm-properties": {
      border: "1px solid var(--border)",
      borderRadius: "8px",
      padding: "4px 4px",
      margin: "4px 0 18px 50px",
      maxWidth: "820px",
      background: "rgba(255,255,255,0.015)",
    },
    ".cm-properties-empty": { color: "var(--text-faint)", padding: "8px 10px", fontSize: "0.85em" },
    ".cm-prop-row": {
      display: "grid",
      gridTemplateColumns: "minmax(90px, 160px) 1fr",
      gap: "10px",
      alignItems: "start",
      padding: "4px 8px",
    },
    ".cm-prop-key": {
      color: "var(--text-muted)",
      fontSize: "0.85em",
      fontWeight: "600",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
    ".cm-prop-values": { fontSize: "0.9em", display: "flex", flexWrap: "wrap", gap: "5px" },
    ".cm-prop-pill": {
      background: "var(--bg-elev)",
      border: "1px solid var(--border)",
      borderRadius: "10px",
      padding: "1px 9px",
      fontSize: "0.85em",
      color: "var(--accent)",
    },
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
