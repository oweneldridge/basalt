// Pasted HTML (a web page, a document, Reading view) as Markdown, as Obsidian
// converts it. Headings, paragraphs, lists and tasks, links, images, bold,
// italics, strikethrough, code, quotes, rules and tables come across; anything
// else keeps only its text. Inline styles count where documents use them for
// emphasis (Google Docs writes bold as `font-weight:700` and wraps a whole
// paste in `<b style="font-weight:normal">`).

const BLOCK = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER",
  "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
  "TABLE", "UL",
]);
const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD", "TITLE", "META", "LINK"]);

/** Whether pasted HTML is worth converting: it has some formatting a plain
 * paste would lose, and it isn't code from an editor (which pastes coloured
 * spans in a `white-space: pre` box, best taken as plain text). */
export function pastedHtmlMatters(html: string): boolean {
  if (/white-space:\s*pre/i.test(html) && !/<(h[1-6]|ul|ol|table|blockquote|a\s)/i.test(html)) return false;
  return /<(h[1-6]|ul|ol|li|table|blockquote|pre|code|a\s|img|strong|b|em|i|s|del|strike|hr)\b/i.test(html) ||
    /font-weight:\s*(bold|[6-9]00)|font-style:\s*italic/i.test(html);
}

/** Escape what would otherwise turn text into Markdown. */
function escapeText(s: string): string {
  return s.replace(/([\\`*_[\]])/g, "\\$1");
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
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : text;
}

class Converter {
  private listDepth = 0;

  inline(node: Node, pre = false): string {
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      return pre ? text : escapeText(text.replace(/\s+/g, " "));
    }
    if (node.nodeType !== 1) return "";
    const el = node as Element;
    const name = el.nodeName;
    if (SKIP.has(name)) return "";
    if (name === "BR") return "\n";
    if (name === "IMG") {
      const src = el.getAttribute("src") ?? "";
      return src && !src.startsWith("data:") ? `![${el.getAttribute("alt") ?? ""}](${src})` : "";
    }
    if (name === "INPUT" && el.getAttribute("type") === "checkbox") return el.hasAttribute("checked") ? "[x] " : "[ ] ";
    if (name === "CODE" && !pre) return "`" + (el.textContent ?? "").replace(/`/g, "\\`") + "`";
    let inner = this.children(el, pre);
    if (name === "A") {
      const href = el.getAttribute("href") ?? "";
      if (!href || href.startsWith("javascript:") || href.startsWith("#")) return inner;
      const text = inner.trim();
      return !text || text === href || text === escapeText(href) ? `<${href}>` : `[${text}](${href.replace(/ /g, "%20")})`;
    }
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
      const code = el.textContent ?? "";
      const lang = /language-([\w+-]+)/.exec(el.querySelector("code")?.className ?? "")?.[1] ?? "";
      return "```" + lang + "\n" + code.replace(/\n$/, "") + "\n```\n\n";
    }
    if (name === "BLOCKQUOTE") {
      const body = this.blocks(el).trim();
      return body.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") + "\n\n";
    }
    if (name === "UL" || name === "OL") return this.list(el, name === "OL") + (this.listDepth ? "" : "\n");
    if (name === "TABLE") return this.table(el);
    // P, DIV and the like: their inline content, then any blocks inside.
    return this.blocks(el) + "\n\n";
  }

  /** A container's content: runs of inline content as paragraphs, blocks as blocks. */
  blocks(el: Element): string {
    let out = "";
    let run = "";
    const flush = () => {
      const t = run.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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

  list(el: Element, ordered: boolean): string {
    let n = Number(el.getAttribute("start")) || 1;
    const indent = "\t".repeat(this.listDepth);
    let out = "";
    for (const li of Array.from(el.children)) {
      if (li.nodeName !== "LI") continue;
      this.listDepth++;
      let text = "";
      let nested = "";
      for (const c of Array.from(li.childNodes)) {
        if (c.nodeType === 1 && (c.nodeName === "UL" || c.nodeName === "OL")) nested += this.list(c as Element, c.nodeName === "OL");
        else if (c.nodeType === 1 && BLOCK.has(c.nodeName)) text += " " + this.blocks(c as Element);
        else text += this.inline(c);
      }
      this.listDepth--;
      const marker = ordered ? `${n++}. ` : "- ";
      const body = text.replace(/\s+/g, " ").trim();
      out += `${indent}${marker}${body}\n${nested}`;
    }
    return out;
  }

  table(el: Element): string {
    const rows = Array.from(el.querySelectorAll("tr"));
    if (!rows.length) return "";
    const cell = (c: Element) => this.children(c).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
    const grid = rows.map((r) => Array.from(r.children).filter((c) => c.nodeName === "TD" || c.nodeName === "TH").map(cell));
    const width = Math.max(...grid.map((r) => r.length));
    const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
    return [line(grid[0]), line(Array(width).fill("---")), ...grid.slice(1).map(line)].join("\n") + "\n\n";
  }
}

/** Markdown for pasted HTML. */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return new Converter().blocks(doc.body).replace(/\n{3,}/g, "\n\n").trim();
}
