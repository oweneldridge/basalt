// Editor theme + Markdown syntax highlighting. Dark, Obsidian-adjacent.
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

// All colors are CSS variables (styles.css), so a light/dark switch is a palette
// flip on <html> — this spec is theme-agnostic. Only CM6's built-in `dark` flag
// differs between modes (see basaltThemeFor), which EditorPane swaps via a
// compartment without remounting.
const themeSpec = {
    "&": {
      color: "var(--text)",
      backgroundColor: "var(--bg-editor)",
      height: "100%",
      fontSize: "var(--font-size, 16px)",
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
    // ==highlight==
    ".cm-highlight": {
      background: "var(--highlight)",
      borderRadius: "3px",
      padding: "0 1px",
    },
    // #tags
    ".cm-tag": {
      color: "var(--accent)",
      background: "rgba(169, 139, 224, 0.14)",
      borderRadius: "8px",
      padding: "1px 7px",
      fontSize: "0.86em",
    },
    // Blockquotes + callouts
    ".cm-blockquote": {
      borderLeft: "3px solid var(--border)",
      paddingLeft: "12px",
      color: "var(--text-muted)",
    },
    ".cm-callout": {
      borderLeft: "3px solid var(--cg)",
      background: "var(--cgbg)",
      paddingTop: "1px",
      paddingBottom: "1px",
      paddingLeft: "12px",
    },
    ".cm-callout-title": { fontWeight: "700", color: "var(--cg)" },
    ".cm-callout-blue": { "--cg": "#7aa2f7", "--cgbg": "rgba(122,162,247,0.08)" },
    ".cm-callout-green": { "--cg": "#9ece6a", "--cgbg": "rgba(158,206,106,0.08)" },
    ".cm-callout-orange": { "--cg": "#e0af68", "--cgbg": "rgba(224,175,104,0.08)" },
    ".cm-callout-red": { "--cg": "#f7768e", "--cgbg": "rgba(247,118,142,0.08)" },
    ".cm-callout-purple": { "--cg": "#bb9af7", "--cgbg": "rgba(187,154,247,0.08)" },
    ".cm-callout-gray": { "--cg": "#8a8c90", "--cgbg": "rgba(138,140,144,0.07)" },
    // Images + embeds
    ".cm-md-image": {
      display: "block",
      maxWidth: "100%",
      borderRadius: "6px",
      margin: "6px 0",
    },
    ".cm-md-image-missing": { color: "var(--text-faint)", fontSize: "0.9em" },
    ".cm-embed-source": { color: "var(--accent)" },
    ".cm-embed-note": {
      display: "block",
      border: "1px solid var(--border)",
      borderLeft: "3px solid var(--accent)",
      borderRadius: "6px",
      padding: "8px 12px",
      margin: "6px 0",
      color: "var(--accent)",
      cursor: "pointer",
      background: "rgba(255,255,255,0.015)",
    },
    ".cm-embed-note:hover": { background: "var(--bg-elev)" },
    // Find/replace panel (Cmd-F)
    ".cm-panels": {
      backgroundColor: "var(--bg-elev)",
      color: "var(--text)",
      borderColor: "var(--border)",
    },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
    ".cm-panel.cm-search": { padding: "6px 10px", fontSize: "0.85rem" },
    ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
      fontSize: "0.85rem",
      color: "var(--text)",
    },
    ".cm-panel.cm-search input": {
      background: "var(--bg)",
      border: "1px solid var(--border)",
      borderRadius: "5px",
      padding: "2px 7px",
      outline: "none",
    },
    ".cm-panel.cm-search button": {
      background: "var(--bg)",
      border: "1px solid var(--border)",
      borderRadius: "5px",
      padding: "2px 9px",
      cursor: "pointer",
      backgroundImage: "none",
      textTransform: "none",
    },
    ".cm-panel.cm-search button:hover": { background: "var(--bg-sidebar)" },
    ".cm-panel.cm-search [name='close']": {
      color: "var(--text-muted)",
      fontSize: "1.1rem",
      padding: "0 6px",
      background: "transparent",
      border: "none",
    },
    ".cm-searchMatch": { background: "rgba(224, 175, 104, 0.25)" },
    ".cm-searchMatch-selected": { background: "rgba(224, 175, 104, 0.5)" },
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
      gridTemplateColumns: "minmax(90px, 160px) 1fr auto",
      gap: "10px",
      alignItems: "center",
      padding: "3px 8px",
    },
    ".cm-prop-key": {
      color: "var(--text-muted)",
      fontSize: "0.85em",
      fontWeight: "600",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
    ".cm-prop-values": {
      fontSize: "0.9em",
      display: "flex",
      flexWrap: "wrap",
      gap: "5px",
      alignItems: "center",
    },
    // Editable value inputs — styled as text until hovered/focused.
    ".cm-prop-input": {
      background: "transparent",
      border: "1px solid transparent",
      borderRadius: "4px",
      color: "var(--text)",
      font: "inherit",
      fontSize: "0.95em",
      padding: "1px 5px",
      outline: "none",
      width: "100%",
      minWidth: "40px",
    },
    ".cm-prop-input:hover": { borderColor: "var(--border)" },
    ".cm-prop-input:focus": { borderColor: "var(--accent)", background: "var(--bg)" },
    ".cm-prop-input.cm-prop-invalid": { borderColor: "var(--danger)" },
    ".cm-prop-pill": {
      display: "inline-flex",
      alignItems: "center",
      gap: "1px",
      background: "var(--bg-elev)",
      border: "1px solid var(--border)",
      borderRadius: "10px",
      padding: "0 2px 0 5px",
    },
    ".cm-prop-pill .cm-prop-input": {
      color: "var(--accent)",
      width: "auto",
      minWidth: "24px",
      padding: "1px 2px",
    },
    ".cm-prop-removeitem, .cm-prop-del": {
      background: "transparent",
      border: "none",
      color: "var(--text-faint)",
      cursor: "pointer",
      fontSize: "1em",
      lineHeight: "1",
      padding: "0 4px",
    },
    ".cm-prop-removeitem:hover, .cm-prop-del:hover": { color: "var(--danger)" },
    ".cm-prop-del": { opacity: "0", fontSize: "1.15em" },
    ".cm-prop-row:hover .cm-prop-del": { opacity: "0.7" },
    ".cm-prop-additem": {
      background: "transparent",
      border: "1px dashed var(--border)",
      borderRadius: "10px",
      color: "var(--text-faint)",
      cursor: "pointer",
      fontSize: "0.85em",
      padding: "1px 8px",
    },
    ".cm-prop-additem:hover": { color: "var(--text)", borderColor: "var(--accent)" },
    ".cm-prop-complex": {
      fontFamily: "var(--font-mono)",
      fontSize: "0.84em",
      color: "var(--text-muted)",
      whiteSpace: "pre-wrap",
      padding: "1px 5px",
    },
    ".cm-prop-footer": {
      display: "flex",
      gap: "12px",
      padding: "6px 8px 2px",
      marginTop: "4px",
      borderTop: "1px solid var(--border)",
    },
    ".cm-prop-add, .cm-prop-raw": {
      background: "transparent",
      border: "none",
      color: "var(--text-faint)",
      cursor: "pointer",
      fontSize: "0.8em",
      padding: "2px 2px",
    },
    ".cm-prop-add:hover, .cm-prop-raw:hover": { color: "var(--accent)" },
    // Heading fold gutter — quiet by default, Obsidian-style. Open markers fade
    // in on gutter hover; a folded heading's marker stays visible.
    ".cm-gutters": { backgroundColor: "transparent", border: "none" },
    ".cm-foldGutter": { width: "14px" },
    ".cm-foldGutter .cm-gutterElement": {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
    },
    ".cm-fold-marker": {
      color: "var(--text-faint)",
      fontSize: "0.7em",
      opacity: "0",
      transition: "opacity 0.1s ease",
    },
    ".cm-foldGutter:hover .cm-fold-marker": { opacity: "0.65" },
    ".cm-foldGutter .cm-gutterElement:hover .cm-fold-marker": { color: "var(--text)", opacity: "1" },
    ".cm-fold-marker.closed": { opacity: "0.8" },
    // Mermaid diagram block.
    ".cm-mermaid": {
      display: "block",
      textAlign: "center",
      margin: "8px 0",
      padding: "8px 0",
      color: "var(--text-muted)",
      cursor: "pointer",
    },
    ".cm-mermaid svg": { maxWidth: "100%", height: "auto" },
    ".cm-mermaid-error": {
      textAlign: "left",
      color: "var(--danger)",
      fontFamily: "var(--font-mono)",
      fontSize: "0.85em",
      whiteSpace: "pre-wrap",
    },
    // The "…" placeholder for a folded section; click to unfold.
    ".cm-foldPlaceholder": {
      background: "var(--bg-elev)",
      border: "1px solid var(--border)",
      borderRadius: "4px",
      color: "var(--text-muted)",
      padding: "0 6px",
      margin: "0 4px",
      cursor: "pointer",
    },
};

/** The editor theme for a given mode. `dark` only sets CM6's built-in flag; the
 * actual colors come from the CSS-variable palette, which the document root
 * flips. */
export function basaltThemeFor(dark: boolean): Extension {
  return EditorView.theme(themeSpec, { dark });
}

export const basaltTheme: Extension = basaltThemeFor(true);

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
