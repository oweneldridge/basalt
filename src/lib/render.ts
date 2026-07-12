// Markdown → HTML for Reading mode and export. The CM6 editor is virtualized
// (only on-screen lines exist in the DOM), so a complete, static render needs
// its own pass. This is a pure string renderer (no DOM) so it's unit-testable
// and reusable for file export; ALL user text is HTML-escaped, and only a fixed
// set of tags/classes is emitted, so the output is safe to insert via
// innerHTML. Vault-relative images are emitted as <img data-basalt-img> for the
// Reading component to resolve asynchronously (same as the editor).
//
// Block structure is parsed line-by-line (the same shape proseMask uses for
// fences/frontmatter); inline syntax reuses the app's link/tag/highlight
// semantics so Reading mode and the editor agree on what a link/tag is.
import { parseMarkdownLink, targetNoteName, proseMask } from "./markdown";
import { parseFm } from "./frontmatter";
import { calloutIcon } from "./callouticons";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// One alternation over inline constructs, in precedence order. Bracket/paren
// classes forbid their own brackets so a run fails fast (no O(n^2) rescans). A
// FRESH instance per call — renderInline recurses (emphasis), and a shared
// `lastIndex` would corrupt the parent scan.
function inlineRe(): RegExp {
  return new RegExp(
    [
      /(`[^`\n]+`)/, // 1 inline code
      /(!\[\[[^\][\n]+?\]\])/, // 2 embed ![[...]]
      /(\[\[[^\][\n]+?\]\])/, // 3 wikilink [[...]]
      /(!?\[[^\][\n]*?\]\((?:[^()\n]|\([^()\n]*\))*\))/, // 4 md image / link
      /(<[a-z][a-z0-9+.-]*:[^>\s]+>)/i, // 5 autolink <url>
      /(\*\*[^\n]+?\*\*|(?<![A-Za-z0-9])__[^\n]+?__(?![A-Za-z0-9]))/, // 6 bold
      /(\*[^*\n]+?\*|(?<![A-Za-z0-9])_[^_\n]+?_(?![A-Za-z0-9]))/, // 7 italic
      /(~~[^\n]+?~~)/, // 8 strikethrough
      /(==[^\n]+?==)/, // 9 highlight
      /((?<![\w/#])#[A-Za-z0-9_][\w-]*(?:\/[A-Za-z0-9_][\w-]*)*)/, // 10 tag
      /(\$\$[^\n]+?\$\$)/, // 11 inline display math $$…$$
      /(\$(?!\s)(?:\\.|[^$\n\\])+?(?<!\s)\$)/, // 12 inline math $…$ (no leading/trailing space)
      /(\^\[[^\][\n]+?\])/, // 13 inline footnote ^[text]
      /(\[\^[^\][\s]+?\])/, // 14 footnote reference [^id]
      /(<\/?(?:br|hr|sup|sub|kbd|mark|u|s|abbr|cite|small|ins|del|wbr)\s*\/?>)/i, // 15 safe inline HTML
    ]
      .map((r) => r.source)
      .join("|"),
    "gi",
  );
}

// Footnote state for one renderMarkdown call. Not re-entrant within a single
// call (renderInline recurses but never calls renderMarkdown), and transclusion
// only renders embeds after the host render has returned — so module state is
// safe here and avoids threading a context through every renderInline call.
interface FnEntry {
  num: number;
  content: string;
}
let fnState: { defs: Map<string, string>; refs: Map<string, FnEntry>; order: string[]; inlineSeq: number } | null =
  null;

function footnoteRef(id: string): string {
  if (!fnState) return escapeHtml(`[^${id}]`);
  let e = fnState.refs.get(id);
  if (!e) {
    e = { num: fnState.order.length + 1, content: fnState.defs.get(id) ?? "" };
    fnState.refs.set(id, e);
    fnState.order.push(id);
  }
  const eid = escapeHtml(id);
  return `<sup class="footnote-ref" id="fnref-${eid}"><a href="#fn-${eid}">${e.num}</a></sup>`;
}

function inlineFootnote(text: string): string {
  if (!fnState) return escapeHtml(text);
  const id = `inline-${(fnState.inlineSeq += 1)}`;
  const num = fnState.order.length + 1;
  fnState.refs.set(id, { num, content: text });
  fnState.order.push(id);
  return `<sup class="footnote-ref" id="fnref-${id}"><a href="#fn-${id}">${num}</a></sup>`;
}

function emitFootnotes(): string {
  if (!fnState || fnState.order.length === 0) return "";
  const ids = [...fnState.order]; // snapshot: rendering content may add more
  const items = ids
    .map((id) => {
      const e = fnState!.refs.get(id)!;
      const eid = escapeHtml(id);
      return `<li id="fn-${eid}">${renderInline(e.content || "", 0)} <a class="footnote-backref" href="#fnref-${eid}">↩</a></li>`;
    })
    .join("");
  return `<section class="footnotes"><hr /><ol>${items}</ol></section>`;
}

/** A math placeholder the reader / editor / export fills with KaTeX (data-tex
 * holds the escaped TeX; render.ts stays synchronous + KaTeX-free). */
function mathPlaceholder(tex: string, display: boolean): string {
  const tag = display ? "div" : "span";
  return `<${tag} class="math ${display ? "math-block" : "math-inline"}" data-math="${
    display ? "block" : "inline"
  }" data-tex="${escapeHtml(tex)}"></${tag}>`;
}

/** Render inline markdown to an HTML string. Recurses (bounded) into emphasis
 * wrappers so `**[[link]]**` styles the link. */
export function renderInline(text: string, depth = 0): string {
  if (depth > 6 || text.length > 20000) return escapeHtml(text);
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  const re = inlineRe();
  while ((m = re.exec(text))) {
    if (m.index > last) out += escapeHtml(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) {
      out += `<code class="md-code-inline">${escapeHtml(tok.slice(1, -1))}</code>`;
    } else if (m[2]) {
      const inner = tok.slice(3, -2).split("|")[0].trim();
      const pathPart = inner.split("#")[0];
      // An image → <img>; audio/video/pdf → a media-player marker; anything
      // else → a note transclusion marker the reader resolves inline.
      if (/\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i.test(pathPart)) {
        out += `<img class="md-embed" data-basalt-img="${escapeHtml(inner)}" alt="${escapeHtml(inner)}" />`;
      } else if (/\.(mp3|wav|ogg|oga|m4a|flac|mp4|m4v|webm|mov|pdf)$/i.test(pathPart)) {
        out += `<span class="md-media-ref" data-basalt-media="${escapeHtml(inner)}"></span>`;
      } else {
        out += `<span class="md-embed-ref" data-basalt-embed="${escapeHtml(inner)}"></span>`;
      }
    } else if (m[3]) {
      const [rawTarget, alias] = tok.slice(2, -2).split("|");
      // The full raw target (folder/heading kept) so resolution matches the
      // editor; the display falls back to the note name when there's no alias.
      out += `<a class="md-wikilink" data-target="${escapeHtml(rawTarget.trim())}">${escapeHtml(
        (alias ?? targetNoteName(rawTarget)).trim(),
      )}</a>`;
    } else if (m[4]) {
      const parsed = parseMarkdownLink(tok);
      if (!parsed) {
        out += escapeHtml(tok);
      } else if (tok.startsWith("!")) {
        out += `<img class="md-image" data-basalt-img="${escapeHtml(parsed.href)}" alt="${escapeHtml(
          parsed.text,
        )}" />`;
      } else {
        out += `<a class="md-link" data-href="${escapeHtml(parsed.href)}">${
          renderInline(parsed.text, depth + 1) || escapeHtml(parsed.href)
        }</a>`;
      }
    } else if (m[5]) {
      const url = tok.slice(1, -1);
      out += `<a class="md-link" data-href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    } else if (m[6]) {
      out += `<strong>${renderInline(tok.slice(2, -2), depth + 1)}</strong>`;
    } else if (m[7]) {
      out += `<em>${renderInline(tok.slice(1, -1), depth + 1)}</em>`;
    } else if (m[8]) {
      out += `<del>${renderInline(tok.slice(2, -2), depth + 1)}</del>`;
    } else if (m[9]) {
      out += `<mark class="md-highlight">${renderInline(tok.slice(2, -2), depth + 1)}</mark>`;
    } else if (m[10]) {
      out += `<span class="md-tag">${escapeHtml(tok)}</span>`;
    } else if (m[11]) {
      out += mathPlaceholder(tok.slice(2, -2), true); // $$…$$
    } else if (m[12]) {
      out += mathPlaceholder(tok.slice(1, -1), false); // $…$
    } else if (m[13]) {
      out += inlineFootnote(tok.slice(2, -1)); // ^[inline footnote]
    } else if (m[14]) {
      out += footnoteRef(tok.slice(2, -1)); // [^id]
    } else if (m[15]) {
      // Safe attribute-free inline tag → pass through; normalize to lowercase.
      out += INLINE_HTML.test(tok) ? tok.toLowerCase() : escapeHtml(tok);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out += escapeHtml(text.slice(last));
  return out;
}

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const ATX = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const CALLOUT = /^\[!([A-Za-z]+)\]([+-]?)\s*(.*)$/;
// A line opening a BLOCK-LEVEL HTML tag (CommonMark type-6-ish list). Inline
// tags (`<sup>`, `<span>`, `<a>`) at line start stay a paragraph; a
// `<scheme:…>` autolink isn't matched (no block tag name).
const HTML_BLOCK =
  /^<\/?(?:div|table|thead|tbody|tfoot|tr|td|th|colgroup|col|section|article|aside|header|footer|nav|figure|figcaption|blockquote|details|summary|dl|dt|dd|ul|ol|li|p|h[1-6]|hr|pre|form|fieldset|video|audio|canvas|main|address|center|font|span)(?:[\s/>]|$)/i;
// Safe, attribute-free inline tags passed through literally (no XSS surface).
const INLINE_HTML = /^<\/?(?:br|hr|sup|sub|kbd|mark|u|s|abbr|cite|small|ins|del|wbr)\s*\/?>$/i;
const TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // split on unescaped pipes
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

/** A flat list item with its indent (for nesting). */
interface LI {
  indent: number;
  ordered: boolean;
  task: "" | "x" | " " | null; // null = not a task
  html: string;
  line?: number; // 0-based source line of a task item (for reading-view toggling)
}

function renderList(items: LI[]): string {
  // Build nested lists from indentation. Each level opens when indent grows.
  let out = "";
  const stack: { ordered: boolean; indent: number }[] = [];
  const close = (toIndent: number) => {
    while (stack.length && stack[stack.length - 1].indent >= toIndent) {
      out += stack.pop()!.ordered ? "</li></ol>" : "</li></ul>";
    }
  };
  let openItem = false;
  for (const it of items) {
    if (!stack.length || it.indent > stack[stack.length - 1].indent) {
      if (openItem) out += ""; // nested list lives inside the current <li>
      stack.push({ ordered: it.ordered, indent: it.indent });
      out += it.ordered ? "<ol>" : "<ul>";
    } else {
      close(it.indent + 1);
      if (openItem) out += "</li>";
    }
    const body =
      it.task !== null
        ? `<input type="checkbox" class="md-task-check" data-task-line="${it.line ?? ""}"${it.task !== " " ? " checked" : ""} /> ${it.html}`
        : it.html;
    out += it.task !== null ? `<li class="md-task">${body}` : `<li>${body}`;
    openItem = true;
  }
  if (openItem) out += "</li>";
  while (stack.length) out += stack.pop()!.ordered ? "</ol>" : "</ul>";
  return out;
}

/** Remove Obsidian `%%comments%%` (inline + multi-line) outside code spans, so
 * reading mode and export hide them (matching Obsidian). Fenced and inline code
 * are preserved. */
export function stripComments(md: string): string {
  return md.replace(/(```[\s\S]*?```|`[^`\n]*`)|%%[\s\S]*?%%/g, (_m, code) => code ?? "");
}

/** Conceal Obsidian block-reference markers (`^blockid` at a line's end or on
 * its own line) — they're anchors, not content, and Obsidian hides them. Only
 * in prose lines, so a `^id` inside a code block is left intact. */
export function stripBlockIds(md: string): string {
  const lines = md.split("\n");
  const mask = proseMask(lines);
  return lines
    .map((l, i) =>
      mask[i] ? l.replace(/[ \t]+\^[A-Za-z0-9-]+\s*$/, "").replace(/^\^[A-Za-z0-9-]+[ \t]*$/, "") : l,
    )
    .join("\n");
}

/** Render a full Markdown document to an HTML string. */

/** Flip the `[ ]`↔`[x]` checkbox on 0-based source `line` (from a reading-view
 * task checkbox's data-task-line). Returns the new doc, or null if that line
 * isn't a task. */
export function toggleTaskLine(doc: string, line: number): string | null {
  const lines = doc.split("\n");
  if (line < 0 || line >= lines.length) return null;
  const re = /^(\s*[-*+]\s+\[)([ xX])(\])/;
  const m = re.exec(lines[line]);
  if (!m) return null;
  lines[line] = lines[line].replace(re, (_full, pre, mark, post) => pre + (mark === " " ? "x" : " ") + post);
  return lines.join("\n");
}

export function renderMarkdown(src: string): string {
  const md = stripBlockIds(stripComments(src));
  const lines = extractFootnoteDefs(md);
  let i = 0;
  const parts: string[] = [];

  // Leading frontmatter → a Properties table.
  if (lines[0]?.trim() === "---") {
    const fm = parseFm(md);
    if (fm) {
      const rows = fm.props
        .map(
          (p) =>
            `<tr><th>${escapeHtml(p.key)}</th><td>${p.values
              .map((v) => escapeHtml(v))
              .join(", ")}</td></tr>`,
        )
        .join("");
      if (rows) parts.push(`<table class="md-properties"><tbody>${rows}</tbody></table>`);
      // Skip the frontmatter block lines.
      i = 1;
      while (i < lines.length && lines[i].trim() !== "---" && lines[i].trim() !== "...") i++;
      i++; // past the closing fence
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Block math: a `$$` fence (possibly multi-line). A complete single-line
    // `$$…$$` is left to the inline pass unless it's alone on the line.
    const trimmed = line.trim();
    if (trimmed.startsWith("$$")) {
      const oneLine = trimmed.length > 4 && trimmed.endsWith("$$");
      if (oneLine) {
        parts.push(mathPlaceholder(trimmed.slice(2, -2), true));
        i++;
        continue;
      }
      const body: string[] = [trimmed.slice(2)];
      i++;
      while (i < lines.length && !lines[i].trim().endsWith("$$")) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        body.push(lines[i].trim().replace(/\$\$$/, ""));
        i++;
      }
      parts.push(mathPlaceholder(body.join("\n").trim(), true));
      continue;
    }
    // Raw HTML block: a line that opens a block-level HTML tag AND contains a
    // `>` (so prose like `<address of note` isn't misread as HTML). Gathered to
    // the matching close tag or a blank line, then emitted as a placeholder the
    // reader / export fills with DOMPurify-sanitized HTML.
    if (HTML_BLOCK.test(trimmed) && trimmed.includes(">")) {
      const tag = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(trimmed)?.[1].toLowerCase() ?? "";
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      const html: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        html.push(lines[i]);
        const closed = closeRe.test(lines[i]);
        i++;
        if (closed) break; // stop after the matching close tag → following markdown renders
      }
      parts.push(`<div class="raw-html" data-basalt-html="${escapeHtml(html.join("\n"))}"></div>`);
      continue;
    }
    // Fenced code.
    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[3].trim().split(/\s+/)[0];
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const fm2 = FENCE.exec(lines[i]);
        if (fm2 && fm2[2][0] === fence[2][0] && fm2[2].length >= fence[2].length && !fm2[3].trim())
          break;
        body.push(lines[i]);
        i++;
      }
      i++; // past closing fence
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      parts.push(`<pre class="md-code"><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    // Heading.
    const atx = ATX.exec(line);
    if (atx) {
      const lvl = atx[1].length;
      parts.push(`<h${lvl}>${renderInline(atx[2])}</h${lvl}>`);
      i++;
      continue;
    }
    // Horizontal rule.
    if (HR.test(line)) {
      parts.push("<hr />");
      i++;
      continue;
    }
    // Blockquote / callout.
    const q = QUOTE.exec(line);
    if (q) {
      const inner: string[] = [];
      while (i < lines.length) {
        const qq = QUOTE.exec(lines[i]);
        if (!qq) break;
        inner.push(qq[1]);
        i++;
      }
      const callout = CALLOUT.exec(inner[0] ?? "");
      if (callout) {
        const type = callout[1].toLowerCase();
        const fold = callout[2]; // "", "+" (foldable-open) or "-" (foldable-closed)
        const titleText = callout[3].trim() || callout[1];
        const bodyMd = inner.slice(1).join("\n");
        const icon = `<span class="md-callout-icon">${calloutIcon(type)}</span>`;
        const title = `<div class="md-callout-title">${icon}${renderInline(titleText)}</div>`;
        const body = bodyMd.trim() ? `<div class="md-callout-body">${renderMarkdown(bodyMd)}</div>` : "";
        const cls = `md-callout md-callout-${escapeHtml(type)}`;
        if (fold) {
          // Foldable → native <details>; `-` starts collapsed, `+` open.
          parts.push(
            `<details class="${cls} md-callout-foldable"${fold === "-" ? "" : " open"}><summary class="md-callout-title">${icon}${renderInline(
              titleText,
            )}</summary>${body}</details>`,
          );
        } else {
          parts.push(`<div class="${cls}">${title}${body}</div>`);
        }
      } else {
        parts.push(`<blockquote>${renderMarkdown(inner.join("\n"))}</blockquote>`);
      }
      continue;
    }
    // List.
    if (BULLET.test(line) || ORDERED.test(line)) {
      const items: LI[] = [];
      while (i < lines.length) {
        const b = BULLET.exec(lines[i]);
        const o = !b ? ORDERED.exec(lines[i]) : null;
        if (!b && !o) {
          if (lines[i].trim() === "") {
            i++;
            continue;
          }
          break;
        }
        const indent = (b ?? o)![1].length;
        const content = (b ?? o)![3];
        const task = b ? TASK.exec(content) : null;
        items.push({
          indent,
          ordered: !!o,
          task: task ? ((task[1] === " " ? " " : "x") as " " | "x") : null,
          html: renderInline(task ? task[2] : content),
          line: task ? i : undefined,
        });
        i++;
      }
      parts.push(renderList(items));
      continue;
    }
    // Table (current line has a pipe and the next line is a delimiter row).
    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const head = header.map((c) => `<th>${renderInline(c)}</th>`).join("");
      const body = rows
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
        .join("");
      parts.push(`<table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }
    // Paragraph: gather consecutive lines until a blank or a block starter.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      const l = lines[i];
      if (FENCE.test(l) || ATX.test(l) || HR.test(l) || QUOTE.test(l) || BULLET.test(l) || ORDERED.test(l))
        break;
      // A `$$` line opens a display-math block — end the paragraph so the block
      // loop handles it (unless it's a complete single-line $$…$$, which the
      // inline pass renders).
      if (para.length && l.trim().startsWith("$$") && !(l.trim().length > 4 && l.trim().endsWith("$$")))
        break;
      if (l.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) break;
      para.push(l);
      i++;
    }
    if (para.length) parts.push(`<p>${renderInline(para.join("\n"))}</p>`);
  }
  const footnotes = emitFootnotes();
  fnState = null;
  return parts.join("\n") + footnotes;
}

/** Pull footnote definitions (`[^id]: text` + indented continuations, in prose)
 * out of the doc into `fnState.defs`, blanking their lines; returns the body
 * lines to render. Initializes fnState for this render. */
function extractFootnoteDefs(md: string): string[] {
  const raw = md.split("\n");
  const mask = proseMask(raw);
  const defs = new Map<string, string>();
  const body: string[] = [];
  const DEF = /^\[\^([^\]\s]+)\]:\s?(.*)$/;
  for (let i = 0; i < raw.length; i++) {
    const dm = mask[i] ? DEF.exec(raw[i]) : null;
    if (!dm) {
      body.push(raw[i]);
      continue;
    }
    let content = dm[2];
    while (i + 1 < raw.length && raw[i + 1].trim() !== "" && /^(\s{2,}|\t)/.test(raw[i + 1])) {
      content += "\n" + raw[i + 1].trim();
      i++;
      body.push(""); // preserve line count so nothing else shifts
    }
    defs.set(dm[1], content.trim());
    body.push(""); // the def line itself
  }
  fnState = { defs, refs: new Map(), order: [], inlineSeq: 0 };
  return body;
}
