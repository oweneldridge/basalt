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
import { parseMarkdownLink, targetNoteName } from "./markdown";
import { parseFm } from "./frontmatter";

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
    ]
      .map((r) => r.source)
      .join("|"),
    "gi",
  );
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
      out += `<img class="md-embed" data-basalt-img="${escapeHtml(inner)}" alt="${escapeHtml(inner)}" />`;
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
        ? `<input type="checkbox" disabled${it.task !== " " ? " checked" : ""} /> ${it.html}`
        : it.html;
    out += it.task !== null ? `<li class="md-task">${body}` : `<li>${body}`;
    openItem = true;
  }
  if (openItem) out += "</li>";
  while (stack.length) out += stack.pop()!.ordered ? "</ol>" : "</ul>";
  return out;
}

/** Render a full Markdown document to an HTML string. */
export function renderMarkdown(md: string): string {
  const lines = md.split("\n");
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
        const titleText = callout[3].trim() || callout[1];
        const bodyMd = inner.slice(1).join("\n");
        parts.push(
          `<div class="md-callout md-callout-${escapeHtml(type)}"><div class="md-callout-title">${renderInline(
            titleText,
          )}</div>${bodyMd.trim() ? `<div class="md-callout-body">${renderMarkdown(bodyMd)}</div>` : ""}</div>`,
        );
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
      if (l.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) break;
      para.push(l);
      i++;
    }
    if (para.length) parts.push(`<p>${renderInline(para.join("\n"))}</p>`);
  }
  return parts.join("\n");
}
