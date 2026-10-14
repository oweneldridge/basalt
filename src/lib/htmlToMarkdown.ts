// Pasted HTML (a web page, a document, Reading view) as Markdown, as Obsidian
// converts it. Headings, paragraphs, lists and tasks, links, images, bold,
// italics, strikethrough, highlights, code, quotes, rules and tables come
// across; anything else keeps only its text. Text is never escaped (Obsidian
// doesn't escape either). Inline styles count where documents use them for
// emphasis (Google Docs writes bold as `font-weight:700` and wraps a whole
// paste in `<b style="font-weight:normal">`).

const BLOCK = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER",
  "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
  "TABLE", "UL",
]);
const LIST = new Set(["UL", "OL"]);
const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD", "TITLE", "META", "LINK"]);

/** Whether pasted HTML is worth converting: it has some formatting a plain
 * paste would lose, and it isn't code from an editor, which pastes coloured
 * spans in a `white-space: pre` box and is best taken as plain text. Google
 * Docs marks its spans `pre` too, but its pastes are documents. */
export function pastedHtmlMatters(html: string): boolean {
  // Apple's apps keep a tab in a `pre` span, which isn't code.
  const probe = html.replace(/<span[^>]*\bApple-tab-span\b[^>]*>/gi, "<span>");
  const code =
    /white-space:\s*pre\s*(?:[;"']|$)/im.test(probe) &&
    !/docs-internal-guid/i.test(html) &&
    !/<(h[1-6]|ul|ol|table|blockquote|a\s)/i.test(html);
  if (code) return false;
  return /<(h[1-6]|ul|ol|li|table|blockquote|pre|code|a\s|img|strong|b|em|i|s|del|strike|mark|hr)\b/i.test(html) ||
    /font-weight:\s*(bold|[6-9]00)|font-style:\s*italic/i.test(html);
}

function styleOf(el: Element): string {
  return (el.getAttribute("style") ?? "").toLowerCase();
}

function isBold(el: Element): boolean {
  const style = styleOf(el);
  if (/font-weight:\s*(normal|[1-5]00)/.test(style)) return false;
  return el.nodeName === "B" || el.nodeName === "STRONG" || /font-weight:\s*(bold|[6-9]00)/.test(style);
}

function isItalic(el: Element): boolean {
  const style = styleOf(el);
  if (/font-style:\s*normal/.test(style)) return false;
  return el.nodeName === "I" || el.nodeName === "EM" || /font-style:\s*italic/.test(style);
}

/** Wrap inline text in a marker, keeping its outer spaces outside it. */
function wrap(text: string, mark: string): string {
  const body = text.trim();
  if (!body) return text;
  const start = text.length - text.trimStart().length;
  return text.slice(0, start) + mark + body + mark + text.slice(text.trimEnd().length);
}

/** Inline code, fenced with more backticks than any run inside it. */
function codeSpan(text: string): string {
  const code = text.replace(/\r?\n|\r/g, " ");
  if (!code) return "";
  const longest = (code.match(/`+/g) ?? []).reduce((n, r) => Math.max(n, r.length), 0);
  const fence = "`".repeat(longest + 1);
  const spaced = code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "";
  const pad = code.startsWith("`") || code.endsWith("`") || spaced ? " " : "";
  return fence + pad + code + pad + fence;
}

/** A code block, fenced with more backticks than any fence inside it. */
function codeBlock(code: string, lang: string): string {
  let fence = 3;
  for (const m of code.matchAll(/^ {0,3}(`{3,})/gm)) fence = Math.max(fence, m[1].length + 1);
  const f = "`".repeat(fence);
  return `${f}${lang}\n${code.replace(/\n$/, "")}\n${f}\n\n`;
}

/** A code block's text as it shows: a `<br>` or a block inside it (how IDEs
 * copy each line) breaks the line. */
function preText(node: Node): string {
  let out = "";
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType === 3) out += c.textContent ?? "";
    else if (c.nodeType !== 1) continue;
    else if (c.nodeName === "BR") out += "\n";
    else if (BLOCK.has(c.nodeName)) {
      if (out && !out.endsWith("\n")) out += "\n";
      out += preText(c);
      if (!out.endsWith("\n")) out += "\n";
    } else out += preText(c);
  }
  return out;
}

/** A link or image address, written so Markdown keeps it whole. */
function address(href: string): string {
  return href.replace(/ /g, "%20").replace(/([()])/g, "\\$1");
}

/** An inline run's text: no trailing spaces on its lines, at most one blank line. */
function tidy(run: string): string {
  return run
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Continuation lines of a list item, indented under its marker. */
function indent(text: string): string[] {
  return text.split("\n").map((l) => (l ? `\t${l}` : l));
}

type Part = { text: string; kind: "para" | "list" | "quote" | "other" };

class Converter {
  private inCell = 0;

  inline(node: Node, pre = false): string {
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      return pre ? text : text.replace(/[ \t\n\r\f]+/g, " "); // a non-breaking space stays
    }
    if (node.nodeType !== 1) return "";
    const el = node as Element;
    const name = el.nodeName;
    if (SKIP.has(name)) return "";
    if (name === "BR") return "\n";
    if (name === "IMG") {
      const src = (el.getAttribute("src") ?? "").trim();
      // Obsidian saves a large inline image as an attachment; a small one stays.
      if (!src || (src.startsWith("data:") && src.length > 1000)) return "";
      const alt = (el.getAttribute("alt") ?? "").replace(/(\n+\s*)+/g, "\n");
      return `![${alt}](${address(src)})`;
    }
    if (name === "INPUT" && el.getAttribute("type") === "checkbox") return el.hasAttribute("checked") ? "[x] " : "[ ] ";
    if (name === "CODE" && !pre) return codeSpan(el.textContent ?? "");
    let inner = this.children(el, pre);
    if (name === "A") {
      const href = (el.getAttribute("href") ?? "").trim();
      if (!href || /^javascript:/i.test(href) || href.startsWith("#")) return inner;
      // Spaces at the link's edges go outside it, as the text reads.
      const text = inner.trim();
      const lead = inner.slice(0, inner.length - inner.trimStart().length);
      const tail = text ? inner.slice(inner.trimEnd().length) : "";
      if ((!text || text === href) && /^[a-z][a-z0-9+.-]*:/i.test(href)) return `${lead}<${href.replace(/ /g, "%20")}>${tail}`;
      return `${lead}[${text || href}](${address(href)})${tail}`;
    }
    if (name === "MARK") inner = wrap(inner, "==");
    if (/^(S|DEL|STRIKE)$/.test(name)) inner = wrap(inner, "~~");
    if (isItalic(el)) inner = wrap(inner, "*");
    if (isBold(el)) inner = wrap(inner, "**");
    return inner;
  }

  children(el: Element, pre = false): string {
    let out = "";
    for (const c of Array.from(el.childNodes)) {
      out += c.nodeType === 1 && BLOCK.has(c.nodeName) ? `\n${this.block(c as Element).trim()}\n` : this.inline(c, pre);
    }
    return out;
  }

  block(el: Element): string {
    const name = el.nodeName;
    if (SKIP.has(name)) return "";
    if (/^H[1-6]$/.test(name)) return `${"#".repeat(Number(name[1]))} ${this.children(el).replace(/\s+/g, " ").trim()}\n\n`;
    if (name === "HR") return "---\n\n";
    if (name === "PRE") {
      const cls = `${el.querySelector("code")?.className ?? ""} ${el.className} ${el.parentElement?.className ?? ""}`;
      const lang = /(?:language|lang|highlight-(?:text|source))-([\w+-]+)/.exec(cls)?.[1] ?? "";
      return codeBlock(preText(el), lang);
    }
    if (name === "BLOCKQUOTE") {
      const body = this.blocks(el).trim();
      return body.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") + "\n\n";
    }
    if (LIST.has(name)) return this.list(el, name === "OL") + "\n\n";
    if (name === "TABLE") return this.inCell ? this.cellText(el) : this.table(el as HTMLTableElement);
    // P, DIV and the like: their inline content, then any blocks inside.
    return this.blocks(el) + "\n\n";
  }

  /** A container's content: runs of inline content as paragraphs, blocks as blocks. */
  blocks(el: Element): string {
    let out = "";
    let run = "";
    const flush = () => {
      const t = tidy(run);
      if (t) out += t + "\n\n";
      run = "";
    };
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === 1 && BLOCK.has(c.nodeName)) {
        flush();
        out += this.block(c as Element);
      } else run += this.inline(c);
    }
    flush();
    return out.replace(/\n{3,}/g, "\n\n");
  }

  /** A list, its items one per marker. Whatever else sits in the list keeps
   * its text: a list beside an item (how Chromium indents) nests under it,
   * a wrapper's items join the list, and bare text becomes an item. */
  list(el: Element, ordered: boolean): string {
    const start = Number(el.getAttribute("start") ?? 1);
    let n = Number.isInteger(start) ? start : 1;
    const lines: string[] = [];
    const add = (body: string) => {
      const [first, ...rest] = body.split("\n");
      lines.push((ordered ? `${n++}. ` : "- ") + first);
      if (rest.length) lines.push(...indent(rest.join("\n")));
    };
    const visit = (parent: Element) => {
      for (const c of Array.from(parent.childNodes)) {
        if (c.nodeType === 1) {
          const e = c as Element;
          if (SKIP.has(e.nodeName)) continue;
          if (e.nodeName === "LI") {
            add(this.item(e));
            continue;
          }
          if (LIST.has(e.nodeName)) {
            const nested = this.list(e, e.nodeName === "OL");
            lines.push(...(lines.length ? indent(nested) : nested.split("\n")));
            continue;
          }
          if (e.querySelector("li")) {
            visit(e);
            continue;
          }
        }
        const text = tidy(this.inline(c));
        if (text) add(text);
      }
    };
    visit(el);
    return lines.join("\n");
  }

  /** A list item's content: its text on the marker's line, then any code,
   * quotes, nested lists and further paragraphs indented beneath it. */
  item(li: Element): string {
    const parts: Part[] = [];
    let run = "";
    const flush = () => {
      const t = tidy(run).replace(/^(\[[ x]\]) +/, "$1 ");
      if (t) parts.push({ text: t, kind: "para" });
      run = "";
    };
    for (const c of Array.from(li.childNodes)) {
      if (c.nodeType === 1 && BLOCK.has(c.nodeName)) {
        flush();
        const name = c.nodeName;
        const text = this.block(c as Element).trim();
        const kind = LIST.has(name) ? "list" : name === "BLOCKQUOTE" ? "quote" : name === "PRE" || name === "TABLE" || name === "HR" || /^H\d$/.test(name) ? "other" : "para";
        if (text) parts.push({ text, kind });
      } else run += this.inline(c);
    }
    flush();
    // A paragraph after a quote or a list would join it; one after another
    // paragraph would merge with it. Code and lists can follow text directly.
    return parts
      .map((p, i) => (i === 0 ? "" : p.kind !== "para" && parts[i - 1].kind !== "quote" && parts[i - 1].kind !== "list" ? "\n" : "\n\n") + p.text)
      .join("");
  }

  /** A cell's content on one line, its line breaks as `<br>` (as Obsidian
   * writes them); a table inside it gives just its text. */
  cellText(c: Element): string {
    this.inCell++;
    let text: string;
    if (c.nodeName === "TABLE") {
      const inner = Array.from(c.children).filter((e) => e.nodeName === "CAPTION");
      text = [...inner, ...Array.from((c as HTMLTableElement).rows).flatMap((r) => Array.from(r.cells))]
        .map((cell) => this.cellText(cell))
        .filter(Boolean)
        .join(" ");
    } else text = this.children(c);
    this.inCell--;
    return text
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("<br>");
  }

  table(el: HTMLTableElement): string {
    const caption = Array.from(el.children)
      .filter((c) => c.nodeName === "CAPTION")
      .map((c) => this.cellText(c))
      .filter(Boolean)
      .join(" ");
    const lead = caption ? `${caption}\n\n` : "";
    const rows = Array.from(el.rows);
    if (!rows.length) return lead;
    const grid = rows.map((r) => {
      const cells: string[] = [];
      for (const c of Array.from(r.cells)) {
        cells.push(this.cellText(c).replace(/\|/g, "\\|"));
        // A merged cell is followed by empty ones, as Obsidian writes it.
        const span = Math.min(Number(c.getAttribute("colspan")) || 1, 1000);
        for (let i = 1; i < span; i++) cells.push("");
      }
      return cells;
    });
    const width = grid.reduce((w, r) => Math.max(w, r.length), 1);
    const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
    return lead + [line(grid[0]), line(Array(width).fill("---")), ...grid.slice(1).map(line)].join("\n") + "\n\n";
  }
}

/** Markdown for pasted HTML. */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return new Converter().blocks(doc.body).replace(/\n{3,}/g, "\n\n").trim();
}
