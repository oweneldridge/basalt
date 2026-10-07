// Markdown → HTML for Reading mode and export. The CM6 editor is virtualized
// (only on-screen lines exist in the DOM), so a complete, static render needs
// its own pass. This is a pure string renderer (no DOM) so it's unit-testable
// and reusable for file export; ALL user text is HTML-escaped, and only a fixed
// set of tags/classes is emitted, so the output is safe to insert via
// innerHTML. Vault-relative images are emitted as <img data-basalt-img> for the
// Reading component to resolve asynchronously (same as the editor).
//
// Parsing is @lezer/markdown, the parser Live Preview runs on (CommonMark +
// GFM), extended with Obsidian's syntax: wikilinks and embeds, highlights,
// math, footnotes, tags and tasks of any status. `%%comments%%`, `^block` ids,
// footnote definitions and frontmatter are taken out first, line for line, so
// a task's checkbox still points at its source line.
import { parser as baseParser, GFM } from "@lezer/markdown";
import type { BlockContext, DelimiterType, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import { mdImageTarget, proseMask, TAG_BEFORE, TAG_NAME, wikilinkLabel } from "./markdown";

const TAG_AT = new RegExp(`^#(${TAG_NAME})`, "u");
import { parseFm } from "./frontmatter";
import { calloutColor, calloutIcon } from "./callouticons";
import { ObsidianTasks } from "./mdTasks";
import { ObsidianTables } from "./mdTables";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A line opening a BLOCK-LEVEL HTML tag (CommonMark type-6-ish list). Used by
// Live Preview's HTML block detection (htmlBlocks.ts).
export const HTML_BLOCK =
  /^<\/?(?:div|table|thead|tbody|tfoot|tr|td|th|colgroup|col|section|article|aside|header|footer|nav|figure|figcaption|blockquote|details|summary|dl|dt|dd|ul|ol|li|p|h[1-6]|hr|pre|form|fieldset|video|audio|canvas|main|address|center|font|span|svg)(?:[\s/>]|$)/i;

// Obsidian's "Strict line breaks" (app.json `strictLineBreaks`, off by
// default). Off, every newline inside a paragraph is a line break; on, only a
// line ending in two spaces or a backslash breaks.
let strictLineBreaks = false;
export function setStrictLineBreaks(on: boolean): void {
  strictLineBreaks = on;
}

// ---------------------------------------------------------------------------
// Obsidian syntax for the lezer parser.

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\p{P}\p{S}]/u;
const HighlightDelim: DelimiterType = { resolve: "Highlight", mark: "HighlightMark" };
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === -1;

function closeOf(cx: InlineContext, from: number, close: string): number {
  const s = cx.slice(from, cx.end);
  const i = s.indexOf(close);
  return i < 0 || s.slice(0, i).includes("\n") ? -1 : from + i;
}

// A `$$` line that opens a display-math block (one with no closing `$$` and
// nothing after it on the same line is a block; `$$x$$` alone is one too).
function mathBlockStart(line: Line): "one" | "open" | null {
  if (line.next !== 36 || line.text.charCodeAt(line.pos + 1) !== 36) return null;
  const rest = line.text.slice(line.pos + 2);
  const close = rest.indexOf("$$");
  if (close < 0) return "open";
  return rest.slice(close + 2).trim() === "" && rest.slice(0, close).trim() !== "" ? "one" : null;
}

const ObsidianSyntax: MarkdownConfig = {
  defineNodes: [
    "Wikilink",
    "Embed",
    "Highlight",
    "HighlightMark",
    "InlineMath",
    "DisplayMathInline",
    "FootnoteRef",
    "InlineFootnote",
    "Tag",
    { name: "MathBlock", block: true },
  ],
  parseBlock: [
    {
      name: "MathBlock",
      before: "FencedCode",
      parse(cx: BlockContext, line: Line) {
        const kind = mathBlockStart(line);
        if (!kind) return false;
        const from = cx.lineStart + line.pos;
        // Still inside the quote or list item the block opened in? (lezer's own
        // fenced code makes the same check; the fields aren't in its types.)
        const inside = () => {
          const depth = (line as unknown as { depth?: number }).depth;
          const stack = (cx as unknown as { stack?: unknown[] }).stack;
          return depth === undefined || stack === undefined || depth >= stack.length;
        };
        if (kind === "open") {
          while (cx.nextLine() && inside()) {
            if (line.text.slice(line.pos).trimEnd().endsWith("$$")) {
              cx.nextLine();
              break;
            }
          }
        } else cx.nextLine();
        cx.addElement(cx.elt("MathBlock", from, cx.prevLineEnd()));
        return true;
      },
      endLeaf: (_cx, line) => mathBlockStart(line) === "open",
    },
    {
      // A line led by a block-level tag (a drawing, a div) ends the paragraph
      // above it, as in Live Preview, so it renders as HTML of its own.
      name: "HtmlInterrupt",
      endLeaf: (_cx, line) => {
        const t = line.text.slice(line.pos).trim();
        return HTML_BLOCK.test(t) && t.includes(">");
      },
    },
  ],
  parseInline: [
    {
      name: "Embed",
      before: "Image",
      parse(cx, next, pos) {
        if (next !== 33 || cx.char(pos + 1) !== 91 || cx.char(pos + 2) !== 91) return -1;
        const end = closeOf(cx, pos + 3, "]]");
        if (end < 0 || !cx.slice(pos + 3, end).trim()) return -1;
        return cx.addElement(cx.elt("Embed", pos, end + 2));
      },
    },
    {
      name: "Wikilink",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== 91 || cx.char(pos + 1) !== 91) return -1;
        const end = closeOf(cx, pos + 2, "]]");
        if (end < 0 || !cx.slice(pos + 2, end).trim()) return -1;
        return cx.addElement(cx.elt("Wikilink", pos, end + 2));
      },
    },
    {
      name: "FootnoteRef",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== 91 || cx.char(pos + 1) !== 94) return -1;
        const m = /^\[\^([^\]\s]+)\]/.exec(cx.slice(pos, cx.end));
        return m ? cx.addElement(cx.elt("FootnoteRef", pos, pos + m[0].length)) : -1;
      },
    },
    {
      name: "InlineFootnote",
      before: "Emphasis",
      parse(cx, next, pos) {
        if (next !== 94 || cx.char(pos + 1) !== 91) return -1;
        const end = closeOf(cx, pos + 2, "]");
        return end < 0 ? -1 : cx.addElement(cx.elt("InlineFootnote", pos, end + 1));
      },
    },
    {
      // `$…$` and `$$…$$`. A `$` followed by a digit, or after a space, closes
      // nothing (`$5 and $10` stays text, as in Obsidian); code binds tighter.
      name: "Math",
      before: "Emphasis",
      parse(cx, next, pos) {
        if (next !== 36) return -1;
        if (cx.char(pos + 1) === 36) {
          const end = closeOf(cx, pos + 2, "$$");
          return end <= pos + 2 ? -1 : cx.addElement(cx.elt("DisplayMathInline", pos, end + 2));
        }
        if (isSpace(cx.char(pos + 1))) return -1;
        for (let i = pos + 1; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 92) {
            i++;
            continue;
          }
          if (c === 10 || c === 96) return -1;
          if (c !== 36) continue;
          if (isSpace(cx.char(i - 1))) continue;
          const after = cx.char(i + 1);
          if (after >= 48 && after <= 57) continue;
          return cx.addElement(cx.elt("InlineMath", pos, i + 1));
        }
        return -1;
      },
    },
    {
      name: "Highlight",
      after: "Emphasis",
      parse(cx, next, pos) {
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = PUNCT.test(before);
        const pAfter = PUNCT.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        );
      },
    },
    {
      // `#tag`, `#nested/tag`, as Obsidian reads them (TAG_NAME, TAG_BEFORE);
      // `#42` isn't a tag.
      name: "Tag",
      before: "Emphasis",
      parse(cx, next, pos) {
        if (next !== 35) return -1;
        const prev = cx.slice(pos - 1, pos);
        if (prev && !TAG_BEFORE.test(prev)) return -1;
        const m = TAG_AT.exec(cx.slice(pos, cx.end));
        if (!m || /^\d+$/.test(m[1])) return -1;
        return cx.addElement(cx.elt("Tag", pos, pos + m[0].length));
      },
    },
  ],
};

const mdParser = baseParser.configure([GFM, ObsidianTasks, ObsidianTables, ObsidianSyntax]);

// ---------------------------------------------------------------------------
// Render state for one document.

interface FnEntry {
  num: number;
  content: string;
}
interface Ctx {
  defs: Map<string, string>; // footnote definitions
  refs: Map<string, FnEntry>;
  order: string[];
  inlineSeq: number;
  lines: boolean; // mark blocks with their source line (data-line)
}
const newCtx = (defs = new Map<string, string>(), lines = false): Ctx => ({
  defs,
  refs: new Map(),
  order: [],
  inlineSeq: 0,
  lines,
});

/** One parsed piece of Markdown: its text, link definitions, and the source
 * line each of its lines came from. */
interface Doc {
  src: string;
  lineStarts: number[];
  map: number[];
  links: Map<string, { url: string }>;
}

const MAX_DEPTH = 40;

/** A math placeholder the reader / editor / export fills with KaTeX (data-tex
 * holds the escaped TeX; render.ts stays synchronous + KaTeX-free). */
function mathPlaceholder(tex: string, display: boolean): string {
  const tag = display ? "div" : "span";
  return `<${tag} class="math ${display ? "math-block" : "math-inline"}" data-math="${
    display ? "block" : "inline"
  }" data-tex="${escapeHtml(tex)}"></${tag}>`;
}

function footnoteRef(ctx: Ctx, id: string): string {
  let e = ctx.refs.get(id);
  if (!e) {
    if (!ctx.defs.has(id)) return escapeHtml(`[^${id}]`);
    e = { num: ctx.order.length + 1, content: ctx.defs.get(id) ?? "" };
    ctx.refs.set(id, e);
    ctx.order.push(id);
  }
  const eid = escapeHtml(id);
  return `<sup class="footnote-ref" id="fnref-${eid}"><a href="#fn-${eid}">${e.num}</a></sup>`;
}

function inlineFootnote(ctx: Ctx, text: string): string {
  const id = `inline-${(ctx.inlineSeq += 1)}`;
  const num = ctx.order.length + 1;
  ctx.refs.set(id, { num, content: text });
  ctx.order.push(id);
  return `<sup class="footnote-ref" id="fnref-${id}"><a href="#fn-${id}">${num}</a></sup>`;
}

function emitFootnotes(ctx: Ctx): string {
  if (ctx.order.length === 0) return "";
  const ids = [...ctx.order]; // snapshot: rendering content may add more
  const items = ids
    .map((id) => {
      const e = ctx.refs.get(id)!;
      const eid = escapeHtml(id);
      return `<li id="fn-${eid}">${inlineOf(e.content || "", ctx)} <a class="footnote-backref" href="#fnref-${eid}">↩</a></li>`;
    })
    .join("");
  return `<section class="footnotes"><hr /><ol>${items}</ol></section>`;
}

// ---------------------------------------------------------------------------
// Inline rendering.

const ENTITY = /^&(?:#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z\d]{1,31});$/i;
const MARKS = new Set([
  "EmphasisMark",
  "CodeMark",
  "LinkMark",
  "StrikethroughMark",
  "HighlightMark",
  "QuoteMark",
  "HeaderMark",
  "ListMark",
  "TaskMarker",
  "TableDelimiter",
]);

// Inline HTML a note may use: shown as markup, everything else as text. Only a
// few harmless attributes; links and images go through the app's own link and
// image handling.
const INLINE_TAGS = new Set([
  "abbr", "b", "bdi", "bdo", "big", "br", "cite", "code", "del", "dfn", "em", "font", "i", "ins", "kbd",
  "mark", "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time", "u", "var", "wbr", "a", "img",
]);
const SAFE_ATTRS = new Set(["title", "dir", "lang", "color", "size", "face", "datetime"]);

function inlineHtml(tag: string): string {
  const m = /^<(\/?)([a-z][a-z0-9-]*)([^>]*)>$/i.exec(tag);
  const name = m?.[2].toLowerCase() ?? "";
  if (!m || !INLINE_TAGS.has(name)) return escapeHtml(tag);
  if (m[1]) return name === "img" || name === "br" || name === "wbr" ? "" : `</${name}>`;
  const attrs: Record<string, string> = {};
  for (const a of m[3].matchAll(/([a-z][a-z0-9-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/gi))
    attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
  const safe = Object.entries(attrs)
    .filter(([k]) => SAFE_ATTRS.has(k))
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join("");
  if (name === "a") return `<a class="md-link" data-href="${escapeHtml(attrs.href ?? "")}"${safe}>`;
  if (name === "img") {
    const size = ["width", "height"].map((k) => (/^\d+$/.test(attrs[k] ?? "") ? ` ${k}="${attrs[k]}"` : "")).join("");
    return `<img class="md-image" data-basalt-img="${escapeHtml(mdImageTarget(attrs.src ?? ""))}" alt="${escapeHtml(attrs.alt ?? "")}"${size}${safe} />`;
  }
  return `<${name}${safe}>`;
}

/** `name|300` or `name|300x200` → the name and a size. */
function sized(label: string): { name: string; size: string } {
  const m = /^(.*?)\|\s*(\d+)(?:x(\d+))?\s*$/.exec(label);
  if (!m) return { name: label, size: "" };
  return { name: m[1], size: ` width="${m[2]}"${m[3] ? ` height="${m[3]}"` : ""}` };
}

const IMG_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;
const MEDIA_EXT = /\.(mp3|wav|ogg|oga|m4a|flac|mp4|m4v|webm|mov|pdf)$/i;

function embed(inner: string): string {
  const text = inner.replace(/\\\|/g, "|");
  const { name, size } = sized(text);
  const target = name.trim();
  const pathPart = target.split("#")[0];
  if (IMG_EXT.test(pathPart))
    return `<img class="md-embed" data-basalt-img="${escapeHtml(target)}" alt="${escapeHtml(target)}"${size} />`;
  if (MEDIA_EXT.test(pathPart)) return `<span class="md-media-ref" data-basalt-media="${escapeHtml(target)}"></span>`;
  return `<span class="md-embed-ref" data-basalt-embed="${escapeHtml(text.split("|")[0].trim())}"></span>`;
}

const refKey = (s: string) => s.replace(/^\[|\]$/g, "").trim().replace(/\s+/g, " ").toLowerCase();
const unescapeMd = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, "$1");

class Inline {
  out = "";
  private atLineStart = false;
  constructor(
    private readonly doc: Doc,
    private readonly ctx: Ctx,
  ) {}

  private text(from: number, to: number) {
    if (from >= to) return;
    let s = this.doc.src.slice(from, to);
    if (this.atLineStart) s = s.replace(/^[ \t]+/, "");
    const lines = s.split("\n");
    for (let k = 0; k < lines.length; k++) {
      let line = lines[k];
      if (k > 0) line = line.replace(/^[ \t]+/, "");
      if (k < lines.length - 1) {
        line = line.replace(/[ \t]+$/, "");
        this.out += escapeHtml(line) + (strictLineBreaks ? "\n" : "<br>\n");
      } else this.out += escapeHtml(line);
    }
    this.atLineStart = s.endsWith("\n") || (this.atLineStart && s.trim() === "");
  }

  /** The inline content of `node` between `from` and `to`, skipping markup. */
  range(node: SyntaxNode, from: number, to: number) {
    let pos = from;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.to <= from || c.from >= to) continue;
      this.text(pos, Math.max(pos, c.from));
      this.node(c);
      pos = Math.max(pos, c.to);
    }
    this.text(pos, to);
  }

  private inner(node: SyntaxNode) {
    const first = node.firstChild;
    const last = node.lastChild;
    const from = first && MARKS.has(first.name) ? first.to : node.from;
    const to = last && last !== first && MARKS.has(last.name) ? last.from : node.to;
    this.range(node, from, to);
  }

  private wrap(open: string, close: string, node: SyntaxNode) {
    this.out += open;
    this.inner(node);
    this.out += close;
  }

  private src(n: SyntaxNode) {
    return this.doc.src.slice(n.from, n.to);
  }

  node(n: SyntaxNode) {
    const wasStart = this.atLineStart;
    this.atLineStart = false;
    switch (n.name) {
      case "Emphasis":
        return this.wrap("<em>", "</em>", n);
      case "StrongEmphasis":
        return this.wrap("<strong>", "</strong>", n);
      case "Strikethrough":
        return this.wrap("<del>", "</del>", n);
      case "Highlight":
        return this.wrap('<mark class="md-highlight">', "</mark>", n);
      case "InlineCode": {
        let code = this.src(n).replace(/^`+|`+$/g, "");
        if (/^ .*[^ ].* $/s.test(code)) code = code.slice(1, -1);
        this.out += `<code class="md-code-inline">${escapeHtml(code.replace(/\n/g, " "))}</code>`;
        return;
      }
      case "Escape":
        this.out += escapeHtml(this.src(n).slice(1));
        return;
      case "Entity":
        this.out += ENTITY.test(this.src(n)) ? this.src(n) : escapeHtml(this.src(n));
        return;
      case "HardBreak":
        this.out += "<br>\n";
        this.atLineStart = true;
        return;
      case "HTMLTag":
        this.out += inlineHtml(this.src(n));
        return;
      case "Comment":
      case "ProcessingInstruction":
        return;
      case "Link":
      case "Image":
        return this.link(n);
      case "Autolink": {
        const url = n.getChild("URL");
        const href = url ? this.src(url) : this.src(n).slice(1, -1);
        this.out += `<a class="md-link" data-href="${escapeHtml(href)}">${escapeHtml(href)}</a>`;
        return;
      }
      case "URL": {
        const raw = this.src(n);
        const href = /^www\./i.test(raw)
          ? `https://${raw}`
          : !/^[a-z][a-z0-9+.-]*:/i.test(raw) && raw.includes("@")
            ? `mailto:${raw}`
            : raw;
        this.out += `<a class="md-link" data-href="${escapeHtml(href)}">${escapeHtml(raw)}</a>`;
        return;
      }
      case "Wikilink": {
        const inner = this.src(n).slice(2, -2).replace(/\\\|/g, "|");
        const bar = inner.indexOf("|");
        const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
        const label = bar < 0 ? wikilinkLabel(target) : inner.slice(bar + 1).trim();
        this.out += `<a class="md-wikilink" data-target="${escapeHtml(target)}">${escapeHtml(label)}</a>`;
        return;
      }
      case "Embed":
        this.out += embed(this.src(n).slice(3, -2));
        return;
      case "InlineMath":
        this.out += mathPlaceholder(this.src(n).slice(1, -1), false);
        return;
      case "DisplayMathInline":
        this.out += mathPlaceholder(this.src(n).slice(2, -2), true);
        return;
      case "FootnoteRef":
        this.out += footnoteRef(this.ctx, this.src(n).slice(2, -1));
        return;
      case "InlineFootnote":
        this.out += inlineFootnote(this.ctx, this.src(n).slice(2, -1));
        return;
      case "Tag":
        this.out += `<span class="md-tag">${escapeHtml(this.src(n))}</span>`;
        return;
      default:
        if (MARKS.has(n.name)) {
          // Container markup inside a paragraph (`>` of a quoted line).
          this.atLineStart = wasStart || n.name === "QuoteMark";
          return;
        }
        this.inner(n);
    }
  }

  private link(n: SyntaxNode) {
    const isImage = n.name === "Image";
    const marks: SyntaxNode[] = [];
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === "LinkMark") marks.push(c);
    const open = marks[0];
    const close = marks.find((m, i) => i > 0 && this.src(m) === "]");
    if (!open || !close) {
      this.out += escapeHtml(this.src(n));
      return;
    }
    const urlNode = n.getChild("URL");
    const label = n.getChild("LinkLabel");
    let href: string | null = null;
    if (urlNode) href = this.src(urlNode).replace(/^<|>$/g, "");
    else {
      const key = refKey(label ? this.src(label) : this.doc.src.slice(open.to, close.from));
      href = this.doc.links.get(key)?.url ?? null;
    }
    if (href === null) {
      // `[text]` with no definition stays text (its inside still renders).
      this.out += isImage ? "![" : "[";
      this.range(n, open.to, close.from);
      this.out += "]";
      if (label) this.out += escapeHtml(this.src(label));
      return;
    }
    href = unescapeMd(href);
    if (isImage) {
      const { name, size } = sized(this.doc.src.slice(open.to, close.from));
      this.out += `<img class="md-image" data-basalt-img="${escapeHtml(mdImageTarget(href))}" alt="${escapeHtml(unescapeMd(name))}"${size} />`;
      return;
    }
    this.out += `<a class="md-link" data-href="${escapeHtml(href)}">`;
    const before = this.out.length;
    this.range(n, open.to, close.from);
    if (this.out.length === before) this.out += escapeHtml(href);
    this.out += "</a>";
  }
}

function inlineNode(doc: Doc, ctx: Ctx, node: SyntaxNode, from = node.from, to = node.to): string {
  const r = new Inline(doc, ctx);
  r.range(node, from, to);
  return r.out;
}

/** Inline Markdown in `text`, rendered on its own (a title, a footnote). */
function inlineOf(text: string, ctx: Ctx): string {
  const doc = makeDoc(text, undefined);
  const tree = mdParser.parse(text);
  const para = tree.topNode.getChild("Paragraph");
  if (!para) return escapeHtml(text);
  return inlineNode(doc, ctx, para);
}

/** Render inline Markdown to an HTML string. */
export function renderInline(text: string): string {
  return inlineOf(text, newCtx());
}

// ---------------------------------------------------------------------------
// Blocks.

function makeDoc(src: string, map: number[] | undefined): Doc {
  const lineStarts = [0];
  for (let i = src.indexOf("\n"); i !== -1; i = src.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  return { src, lineStarts, map: map ?? lineStarts.map((_, i) => i), links: new Map() };
}

function lineOf(doc: Doc, pos: number): number {
  let lo = 0;
  let hi = doc.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (doc.lineStarts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function lineEnd(doc: Doc, l: number): number {
  return l + 1 < doc.lineStarts.length ? doc.lineStarts[l + 1] - 1 : doc.src.length;
}

/** Whether there's a blank line between `from` and `to`. */
function blankBetween(doc: Doc, from: number, to: number): boolean {
  return /\n[ \t>]*\n/.test(doc.src.slice(from, to));
}

const CALLOUT = /^\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/;

class Blocks {
  constructor(
    private readonly doc: Doc,
    private readonly ctx: Ctx,
    private readonly depth: number,
  ) {}

  private src(n: SyntaxNode) {
    return this.doc.src.slice(n.from, n.to);
  }

  children(parent: SyntaxNode, tight = false): string[] {
    const parts: string[] = [];
    for (let c = parent.firstChild; c; c = c.nextSibling) {
      const html = this.block(c, tight);
      if (html) parts.push(html);
    }
    return parts;
  }

  /** The source line (0-based) a node starts on. */
  private line(n: SyntaxNode): number {
    const at = lineOf(this.doc, n.from);
    return this.doc.map[at] ?? at;
  }

  private lineAttr(n: SyntaxNode): string {
    return this.ctx.lines ? ` data-line="${this.line(n)}"` : "";
  }

  block(n: SyntaxNode, tight = false): string {
    const html = this.blockHtml(n, tight);
    if (!this.ctx.lines || (tight && n.name === "Paragraph")) return html;
    return html.replace(/^<([a-z][a-z0-9]*)(?=[\s>/])/, `<$1${this.lineAttr(n)}`);
  }

  private blockHtml(n: SyntaxNode, tight: boolean): string {
    if (this.depth > MAX_DEPTH) return `<p>${escapeHtml(this.src(n))}</p>`;
    switch (n.name) {
      case "Paragraph": {
        // A line led by a block-level tag (an Obsidian daily-note header,
        // `<font><center>…`) is HTML for the sanitizer, as Live Preview reads it.
        const first = this.src(n).split("\n", 1)[0].trim();
        if (HTML_BLOCK.test(first) && first.includes(">")) return this.html(n);
        return tight ? inlineNode(this.doc, this.ctx, n) : `<p>${inlineNode(this.doc, this.ctx, n)}</p>`;
      }
      case "ATXHeading1":
      case "ATXHeading2":
      case "ATXHeading3":
      case "ATXHeading4":
      case "ATXHeading5":
      case "ATXHeading6":
      case "SetextHeading1":
      case "SetextHeading2": {
        const level = Number(n.name.slice(-1));
        const marks: SyntaxNode[] = [];
        for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === "HeaderMark") marks.push(c);
        let from = n.from;
        let to = n.to;
        if (n.name.startsWith("ATX")) {
          if (marks[0] && marks[0].from === n.from) from = marks[0].to;
          const last = marks[marks.length - 1];
          if (last && last !== marks[0] && last.to === n.to) to = last.from;
        } else if (marks.length) {
          to = marks[marks.length - 1].from;
          while (to > from && /\s/.test(this.doc.src.charAt(to - 1))) to--; // the line break before the underline
        }
        return `<h${level}>${inlineNode(this.doc, this.ctx, n, from, to).trim()}</h${level}>`;
      }
      case "HorizontalRule":
        return "<hr />";
      case "FencedCode":
      case "CodeBlock":
        return this.code(n);
      case "MathBlock": {
        const tex = this.src(n)
          .split("\n")
          .map((l) => l.replace(/^[ \t]*(?:>[ \t]?)*/, ""))
          .join("\n")
          .replace(/^\s*\$\$/, "")
          .replace(/\$\$\s*$/, "");
        return mathPlaceholder(tex.trim(), true);
      }
      case "HTMLBlock":
        return this.html(n);
      case "CommentBlock":
      case "LinkReference":
      case "QuoteMark":
      case "ListMark":
        return "";
      case "ProcessingInstructionBlock":
        return `<p>${escapeHtml(this.src(n))}</p>`;
      case "Blockquote":
        return this.quote(n);
      case "BulletList":
      case "OrderedList":
        return this.list(n);
      case "Table":
        return this.table(n);
      case "Task":
        return this.taskBody(n);
      default:
        return this.children(n, tight).join("\n");
    }
  }

  /** Raw HTML for the sanitizer, ending at the opening tag's close (as Live
   * Preview does) so Markdown right after it renders. Prose that only looks
   * like a tag (`<address of the sender…`, no `>`) stays text. */
  private html(n: SyntaxNode): string {
    const src = this.src(n);
    const lines = src.split("\n");
    if (!lines[0].includes(">")) return `<p>${escapeHtml(src)}</p>`;
    const raw = (h: string) => `<div class="raw-html" data-basalt-html="${escapeHtml(h)}"></div>`;
    const tag = /^\s*<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(lines[0])?.[1];
    const close = tag ? new RegExp(`</${tag}\\s*>`, "i") : null;
    const k = close ? lines.findIndex((l) => close.test(l)) : -1;
    if (k < 0 || k === lines.length - 1) return raw(src);
    const at = lineOf(this.doc, n.from) + k + 1;
    const restLines = lines.slice(k + 1);
    const map = restLines.map((_, i) => this.doc.map[at + i] ?? at + i);
    return `${raw(lines.slice(0, k + 1).join("\n"))}\n${renderDoc(restLines.join("\n"), map, this.ctx, this.depth + 1)}`;
  }

  private code(n: SyntaxNode): string {
    const info = n.getChild("CodeInfo");
    const lang = info ? this.src(info).trim().split(/\s+/)[0] : "";
    const texts: SyntaxNode[] = [];
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === "CodeText") texts.push(c);
    let body = "";
    if (texts.length) {
      // Line by line: each line's text starts after its container markup.
      const lastText = texts[texts.length - 1];
      const first = lineOf(this.doc, texts[0].from);
      const last = lineOf(this.doc, Math.max(lastText.from, lastText.to - 1));
      const lines: string[] = [];
      for (let l = first; l <= last; l++) {
        const ls = this.doc.lineStarts[l];
        const le = lineEnd(this.doc, l);
        let line = "";
        for (const t of texts) {
          const a = Math.max(ls, t.from);
          const b = Math.min(le, t.to);
          if (a < b) line += this.doc.src.slice(a, b);
        }
        lines.push(line);
      }
      body = lines.join("\n");
    }
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return `<pre class="md-code"><code${cls}>${escapeHtml(body)}</code></pre>`;
  }

  /** The quote's text with one `>` level taken off each line. */
  private unquote(n: SyntaxNode): { text: string; map: number[] } {
    const firstLine = lineOf(this.doc, n.from);
    const lastLine = lineOf(this.doc, n.to);
    const lines: string[] = [];
    const map: number[] = [];
    for (let l = firstLine; l <= lastLine; l++) {
      const ls = l === firstLine ? n.from : this.doc.lineStarts[l];
      const line = this.doc.src.slice(ls, Math.min(lineEnd(this.doc, l), n.to));
      lines.push(line.replace(/^[ \t]{0,3}>[ \t]?/, ""));
      map.push(this.doc.map[l] ?? l);
    }
    return { text: lines.join("\n"), map };
  }

  private quote(n: SyntaxNode): string {
    const { text, map } = this.unquote(n);
    const head = text.split("\n", 1)[0];
    const callout = CALLOUT.exec(head.trim());
    if (!callout) return `<blockquote>${new Blocks(this.doc, this.ctx, this.depth + 1).children(n).join("\n")}</blockquote>`;
    const type = callout[1].toLowerCase();
    const fold = callout[2]; // "", "+" (foldable-open) or "-" (foldable-closed)
    const titleText = callout[3].trim() || callout[1].charAt(0).toUpperCase() + callout[1].slice(1).toLowerCase();
    const bodyMd = text.slice(head.length + 1);
    const icon = `<span class="md-callout-icon">${calloutIcon(type)}</span>`;
    const title = inlineOf(titleText, this.ctx);
    const body = bodyMd.trim()
      ? `<div class="md-callout-body">${renderDoc(bodyMd, map.slice(1), this.ctx, this.depth + 1)}</div>`
      : "";
    const cls = `md-callout md-callout-${escapeHtml(type)} md-callout-color-${calloutColor(type)}`;
    if (fold)
      return `<details class="${cls} md-callout-foldable"${fold === "-" ? "" : " open"}><summary class="md-callout-title">${icon}${title}</summary>${body}</details>`;
    return `<div class="${cls}"><div class="md-callout-title">${icon}${title}</div>${body}</div>`;
  }

  private list(n: SyntaxNode): string {
    const items: SyntaxNode[] = [];
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === "ListItem") items.push(c);
    // Loose (paragraphs in <p>) when items, or blocks inside one, are apart.
    let loose = items.some((it, i) => i > 0 && blankBetween(this.doc, items[i - 1].to, it.from));
    if (!loose) {
      loose = items.some((it) => {
        const blocks: SyntaxNode[] = [];
        for (let c = it.firstChild; c; c = c.nextSibling) if (c.name !== "ListMark") blocks.push(c);
        return blocks.some((b, i) => i > 0 && blankBetween(this.doc, blocks[i - 1].to, b.from));
      });
    }
    const ordered = n.name === "OrderedList";
    const firstMark = items[0]?.getChild("ListMark");
    const start = ordered && firstMark ? parseInt(this.src(firstMark), 10) : 1;
    const inner = new Blocks(this.doc, this.ctx, this.depth + 1);
    const lis = items
      .map((it) => {
        const task = it.getChild("Task");
        const parts = inner.children(it, !loose);
        const sep = loose ? "\n" : "";
        const attr = this.lineAttr(it);
        if (!task) return `<li${attr}>${parts.join(sep)}</li>`;
        const marker = task.getChild("TaskMarker");
        const status = marker ? this.doc.src.charAt(marker.from + 1) : " ";
        const box = `<input type="checkbox" class="md-task-check" data-task-line="${this.line(task)}"${status !== " " ? " checked" : ""} /> `;
        return `<li class="md-task" data-task="${escapeHtml(status)}"${attr}>${box}${parts.join(sep)}</li>`;
      })
      .join("");
    const startAttr = ordered && start !== 1 && Number.isFinite(start) ? ` start="${start}"` : "";
    return ordered ? `<ol${startAttr}>${lis}</ol>` : `<ul>${lis}</ul>`;
  }

  private taskBody(n: SyntaxNode): string {
    const marker = n.getChild("TaskMarker");
    const from = marker ? marker.to : n.from;
    return inlineNode(this.doc, this.ctx, n, from, n.to).replace(/^\s+/, "");
  }

  private table(n: SyntaxNode): string {
    let delim: SyntaxNode | null = null;
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === "TableDelimiter") delim = delim ?? c;
    const align = delim
      ? this.src(delim)
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => {
            const t = c.trim();
            return t.startsWith(":") && t.endsWith(":") ? "center" : t.endsWith(":") ? "right" : t.startsWith(":") ? "left" : "";
          })
      : [];
    const cells = (row: SyntaxNode): string[] => {
      const out: string[] = [];
      let lastWasCell = false;
      let first = true;
      for (let c = row.firstChild; c; c = c.nextSibling) {
        if (c.name === "TableDelimiter") {
          if (!lastWasCell && !first) out.push("");
          lastWasCell = false;
        } else if (c.name === "TableCell") {
          out.push(inlineNode(this.doc, this.ctx, c).trim());
          lastWasCell = true;
        }
        first = false;
      }
      return out;
    };
    const header = n.getChild("TableHeader");
    const head = header ? cells(header) : [];
    const cols = head.length;
    const cell = (tag: string, html: string, i: number) =>
      `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ""}>${html}</${tag}>`;
    const rows: string[] = [];
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.name !== "TableRow") continue;
      const cs = cells(c);
      rows.push(`<tr>${Array.from({ length: cols }, (_, i) => cell("td", cs[i] ?? "", i)).join("")}</tr>`);
    }
    return `<table class="md-table"><thead><tr>${head.map((h, i) => cell("th", h, i)).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
  }
}

/** Collect link reference definitions (`[label]: url`). */
function collectLinks(doc: Doc, top: SyntaxNode) {
  const visit = (n: SyntaxNode) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.name === "LinkReference") {
        const label = c.getChild("LinkLabel");
        const url = c.getChild("URL");
        if (label && url) {
          const key = refKey(doc.src.slice(label.from, label.to));
          if (!doc.links.has(key)) doc.links.set(key, { url: doc.src.slice(url.from, url.to).replace(/^<|>$/g, "") });
        }
      } else if (["Blockquote", "ListItem", "BulletList", "OrderedList"].includes(c.name)) visit(c);
    }
  };
  visit(top);
}

function renderDoc(text: string, map: number[] | undefined, ctx: Ctx, depth: number): string {
  const doc = makeDoc(text, map);
  const tree = mdParser.parse(text);
  collectLinks(doc, tree.topNode);
  return new Blocks(doc, ctx, depth).children(tree.topNode).join("\n");
}

// ---------------------------------------------------------------------------
// Line-preserving pre-passes.

/** Remove Obsidian `%%comments%%` (inline + multi-line) outside code spans, so
 * reading mode and export hide them (matching Obsidian). Fenced and inline code
 * are preserved. */
export function stripComments(md: string): string {
  return stripCommentsMapped(md).text;
}

/** stripComments plus, for each output line, the source line it starts on, so
 * a reading-view checkbox can point back at the right line after a multi-line
 * comment is removed. */
/** Code (left alone) or an Obsidian `%%comment%%`, inline or over lines. */
const COMMENT_OR_CODE = /(```[\s\S]*?```|`[^`\n]*`)|%%[\s\S]*?%%/g;

/** Where each `%%comment%%` is, as [from, to) offsets, skipping code. */
export function commentRanges(md: string): [number, number][] {
  const re = new RegExp(COMMENT_OR_CODE.source, "g");
  const out: [number, number][] = [];
  for (let m; (m = re.exec(md)); ) if (m[1] === undefined) out.push([m.index, m.index + m[0].length]);
  return out;
}

function stripCommentsMapped(md: string): { text: string; map: number[] } {
  const re = new RegExp(COMMENT_OR_CODE.source, "g");
  const map = [0];
  let text = "";
  let src = 0; // source line at the current position
  const copy = (chunk: string) => {
    text += chunk;
    for (let p = chunk.indexOf("\n"); p !== -1; p = chunk.indexOf("\n", p + 1)) map.push(++src);
  };
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    copy(md.slice(last, m.index));
    if (m[1] !== undefined) copy(m[0]);
    else for (let p = m[0].indexOf("\n"); p !== -1; p = m[0].indexOf("\n", p + 1)) src++;
    last = m.index + m[0].length;
  }
  copy(md.slice(last));
  return { text, map };
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

/** Pull footnote definitions (`[^id]: text` + indented continuations, in prose)
 * out of the doc, blanking their lines so line numbers hold. */
function extractFootnoteDefs(md: string): { text: string; defs: Map<string, string> } {
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
      body.push("");
    }
    defs.set(dm[1], content.trim());
    body.push("");
  }
  return { text: body.join("\n"), defs };
}

/** Flip the checkbox on 0-based source `line` (from a reading-view task
 * checkbox's data-task-line). Any status but a space is done, and goes back to
 * open. Returns the new doc, or null if that line isn't a task. */
export function toggleTaskLine(doc: string, line: number): string | null {
  const lines = doc.split("\n");
  if (line < 0 || line >= lines.length) return null;
  // Tasks inside blockquotes and callouts carry a `> ` prefix.
  const re = /^((?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([^\]\n])(\])/;
  const m = re.exec(lines[line]);
  if (!m) return null;
  lines[line] = lines[line].replace(re, (_full, pre, mark, post) => pre + (mark === " " ? "x" : " ") + post);
  return lines.join("\n");
}

/** Render a full Markdown document to an HTML string. With `lines`, each block
 * carries the source line it starts on as `data-line`, for Reading view. */
export function renderMarkdown(src: string, opts: { lines?: boolean } = {}): string {
  const { text: stripped, map } = stripCommentsMapped(src);
  let md = stripBlockIds(stripped);
  const parts: string[] = [];

  // Leading frontmatter → a Properties table; its lines become blank.
  const lines = md.split("\n");
  if (lines[0]?.trim() === "---") {
    const fm = parseFm(md);
    if (fm) {
      const rows = fm.props
        .map((p) => `<tr><th>${escapeHtml(p.key)}</th><td>${p.values.map((v) => escapeHtml(v)).join(", ")}</td></tr>`)
        .join("");
      if (rows) parts.push(`<table class="md-properties"><tbody>${rows}</tbody></table>`);
      let end = 1;
      while (end < lines.length && lines[end].trim() !== "---" && lines[end].trim() !== "...") end++;
      for (let k = 0; k <= Math.min(end, lines.length - 1); k++) lines[k] = "";
      md = lines.join("\n");
    }
  }

  const { text, defs } = extractFootnoteDefs(md);
  const ctx = newCtx(defs, opts.lines);
  const body = renderDoc(text, map, ctx, 0);
  if (body) parts.push(body);
  return parts.join("\n") + emitFootnotes(ctx);
}
