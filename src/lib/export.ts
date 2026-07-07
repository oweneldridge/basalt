// Build a self-contained HTML document for export. The body is the rendered
// note (from lib/render.ts) with images already inlined as data URLs by the
// caller, so the file stands alone. Styles are embedded (a light, print-
// friendly subset of the Reading-view theme).
import { escapeHtml } from "./render";

const EXPORT_CSS = `
:root{--text:#1f2125;--muted:#686b73;--faint:#9a9da6;--accent:#7c5cd0;--border:#d8dade;--elev:#f0f1f3;--code:#b15c00;}
*{box-sizing:border-box}
body{max-width:820px;margin:40px auto;padding:0 24px;color:var(--text);
 font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
 -webkit-font-smoothing:antialiased;}
h1,h2,h3,h4,h5,h6{font-weight:700;line-height:1.3;margin:1em 0 .4em}
h1{font-size:1.8em}h2{font-size:1.5em}h3{font-size:1.3em}h4{font-size:1.15em}
p{margin:.6em 0}
a{color:var(--accent);text-decoration:none}
a.md-wikilink{color:var(--accent)}
ul,ol{padding-left:1.6em;margin:.4em 0}
li.md-task{list-style:none;margin-left:-1.2em}
li.md-task input{margin-right:6px}
blockquote{border-left:3px solid var(--border);margin:.6em 0;padding:0 0 0 12px;color:var(--muted)}
hr{border:none;border-top:1px solid var(--border);margin:1.2em 0}
code.md-code-inline{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em;background:var(--elev);border-radius:4px;padding:1px 5px;color:var(--code)}
pre.md-code{background:var(--elev);border-radius:6px;padding:10px 12px;overflow-x:auto}
pre.md-code code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.88em}
.md-tag{color:var(--accent);background:rgba(124,92,208,.13);border-radius:8px;padding:1px 7px;font-size:.86em}
mark.md-highlight{background:rgba(255,206,84,.5);border-radius:3px;padding:0 1px}
img.md-image,img.md-embed{display:block;max-width:100%;border-radius:6px;margin:6px 0}
.md-image-missing{color:var(--faint);font-size:.9em}
table.md-table,table.md-properties{border-collapse:collapse;margin:10px 0;font-size:.95em}
table.md-table th,table.md-table td,table.md-properties th,table.md-properties td{border:1px solid var(--border);padding:5px 11px;text-align:left}
table.md-table th{background:var(--elev);font-weight:700}
table.md-properties th{color:var(--muted);font-weight:600}
.md-callout{border-left:3px solid var(--accent);background:rgba(124,92,208,.08);border-radius:4px;padding:6px 12px;margin:.6em 0}
.md-callout-title{font-weight:700;color:var(--accent)}
.md-mermaid{text-align:center;margin:12px 0}
.md-mermaid svg{max-width:100%;height:auto}
math{font-size:1.05em}
.math-block math,math[display="block"]{display:block;text-align:center;margin:10px 0;overflow-x:auto}
.math-error{color:#c0392b;font-family:monospace}
`.trim();

/** Wrap rendered note HTML in a standalone, styled HTML document. */
export function buildHtmlDocument(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data:" />
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}
