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
import { parser as baseParser } from "@lezer/markdown";
import type { BlockContext, DelimiterType, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import { blockDepths, frontmatterEnd, mdImageTarget, proseMask, TAG_BEFORE, TAG_NAME, wikilinkLabel } from "./markdown";

const TAG_AT = new RegExp(`^#(${TAG_NAME})`, "u");
import { parseFm } from "./frontmatter";
import { calloutColor, calloutIcon } from "./callouticons";
import { ObsidianTasks } from "./mdTasks";
import { ObsidianTables, SafeGFM } from "./mdTables";
import { LinearParsers } from "./mdLinear";

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
export const strictLineBreaksOn = (): boolean => strictLineBreaks;
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

const mdParser = baseParser.configure([...SafeGFM, ObsidianTasks, ObsidianTables, ObsidianSyntax, LinearParsers]);
// The same blocks with no inline parse, for scans that only need blocks: most
// of a parse's time goes on inline content.
const blockParser = mdParser.configure({
  remove: ["Escape", "Entity", "InlineCode", "HTMLTag", "Emphasis", "Strikethrough", "HardBreak", "Link", "Image", "Autolink", "LinkEnd"].concat(
    ObsidianSyntax.parseInline!.map((p) => p.name),
  ),
});
// With every inline parser removed, the inline parse finds nothing but still
// walks each character, a table cell's included.
blockParser.parseInline = () => [];

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
  callouts: number; // callouts the block being rendered sits in
  // Set to read only where link definitions are: the lines Reading view hides
  // as one and the labels it knows, with no text rendered.
  seen?: Seen;
}

interface Seen {
  lines: Set<number>;
  // The definitions each source line sees: those of the piece it's read in.
  parts: Map<number, Doc["links"]>;
}

export interface Definitions {
  lines: Set<number>;
  labels: Set<string>;
  // Lines read as a note of their own (after an HTML block's HTML), which see
  // only the labels defined there.
  own: Map<number, Set<string>>;
}
const newCtx = (defs = new Map<string, string>(), lines = false): Ctx => ({
  defs,
  refs: new Map(),
  order: [],
  inlineSeq: 0,
  lines,
  callouts: 0,
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

function inlineHtml(tag: string): string | null {
  const m = /^<(\/?)([a-z][a-z0-9-]*)([^>]*)>$/i.exec(tag);
  const name = m?.[2].toLowerCase() ?? "";
  if (!m || !INLINE_TAGS.has(name)) return null;
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

  /** `n`'s text without its container markup: the quote marks and indent that
   * start each line it runs onto. */
  private content(n: SyntaxNode) {
    let s = "";
    let pos = n.from;
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.name !== "QuoteMark") continue;
      s += this.doc.src.slice(pos, c.from);
      pos = c.to;
    }
    return (s + this.doc.src.slice(pos, n.to)).replace(/\n[ \t]*/g, "\n");
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
        let code = this.content(n).replace(/^`+|`+$/g, "");
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
      case "HTMLTag": {
        // Anything but a tag the sanitizer keeps is text, its line breaks too.
        const html = inlineHtml(this.content(n));
        if (html === null) this.range(n, n.from, n.to);
        else this.out += html;
        return;
      }
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
  if (ctx.seen) return "";
  const r = new Inline(doc, ctx);
  r.range(node, from, to);
  return r.out;
}

/** Inline Markdown in `text`, rendered on its own (a title, a footnote). */
function inlineOf(text: string, ctx: Ctx): string {
  if (ctx.seen) return "";
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

// A line that may start a callout, in a quote however deep or in a list item.
export const CALLOUT_LINE = /(?:^|\n)[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+|>[ \t]*)*>[ \t]*\[![\w-]+\]/;

/** The callout title a quote `n` leads with (CALLOUT's match), if it is one. */
function calloutOf(src: string, n: SyntaxNode): RegExpExecArray | null {
  let lead = n.firstChild;
  while (lead?.name === "QuoteMark") lead = lead.nextSibling;
  // The title is the quote's first line: one under an empty `>` isn't.
  if (!lead || src.slice(n.from, lead.from).includes("\n")) return null;
  // Whatever the first line reads as (`[!note]: x` is a link definition).
  const eol = src.indexOf("\n", lead.from);
  return CALLOUT.exec(src.slice(lead.from, eol < 0 || eol > lead.to ? lead.to : eol).trim());
}

/** A callout's body as Reading view reads it, a note of its own: the quote's
 * lines after its title, each cut past this quote's own `>` (and the quotes
 * and indents around it). With the line each came from and how much was cut. */
function calloutBody(doc: Doc, n: SyntaxNode): { text: string; lines: number[]; cut: number[]; pad: number[] } {
  let depth = 0;
  for (let p: SyntaxNode | null = n; p; p = p.parent) if (p.name === "Blockquote") depth++;
  const lines: number[] = [];
  const cut: number[] = [];
  const pad: number[] = []; // spaces a line's text starts with that stand for part of a tab
  const out: string[] = [];
  for (let l = lineOf(doc, n.from) + 1, last = lineOf(doc, Math.max(n.from, n.to - 1)); l <= last; l++) {
    const line = doc.src.slice(doc.lineStarts[l], Math.min(lineEnd(doc, l), n.to));
    let k = 0;
    let seen = 0;
    while (k < line.length && seen < depth && " \t>".includes(line[k])) {
      if (line[k++] === ">" && ++seen === depth && (line[k] === " " || line[k] === "\t")) k++;
    }
    // A lazy line, with fewer `>` than that, is cut past its own `>`s only:
    // its indent stays, so `    # x` after a paragraph is still its text.
    if (seen < depth) k = /^(?:[ \t]*>[ \t]?)*/.exec(line)![0].length;
    // A tab after the last `>` cut gives it one column: the rest is the
    // text's indent.
    let j = k;
    while (line[j] === " " || line[j] === "\t") j++;
    const mark = line.lastIndexOf(">", k - 1);
    if (mark >= 0 && line.lastIndexOf("\t", j - 1) > mark) {
      let col = 0;
      let from = 0; // the column the text's indent counts from
      for (let i = 0; i < j; i++) {
        if (i === mark + 1) from = col + 1;
        col += line[i] === "\t" ? 4 - (col % 4) : 1;
      }
      const indent = Math.max(0, col - from);
      out.push(" ".repeat(indent) + line.slice(j));
      lines.push(l);
      cut.push(j);
      pad.push(indent);
      continue;
    }
    out.push(line.slice(k));
    lines.push(l);
    cut.push(k);
    pad.push(0);
  }
  return { text: out.join("\n"), lines, cut, pad };
}

/** Whether a line is blank inside `quotes` quotes: nothing on it but their marks. */
function blankIn(line: string, quotes: number): boolean {
  return /^[ \t>\r]*$/.test(line) && line.split(">").length - 1 <= quotes;
}

/** The last line of an HTML block's (or tag-led paragraph's) own HTML, the
 * line closing its first tag, when Markdown follows it; -1 when it's all HTML. */
function htmlLines(lines: string[]): number {
  const tag = /^\s*<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(lines[0])?.[1];
  const close = tag ? new RegExp(`</${tag}\\s*>`, "i") : null;
  const k = close ? lines.findIndex((l) => close.test(l)) : -1;
  return k === lines.length - 1 ? -1 : k;
}

/** Whether there's a blank line between `from` and `to`, inside `quotes` quotes. */
function blankBetween(doc: Doc, from: number, to: number, quotes: number): boolean {
  const lines = doc.src.slice(from, to).split("\n");
  return lines.slice(1, -1).some((l) => blankIn(l, quotes));
}

/** Where a node's text ends: in a quote its range can run on over blank lines. */
function textEnd(doc: Doc, n: SyntaxNode, quotes: number): number {
  let end = n.to;
  for (;;) {
    const ls = doc.src.lastIndexOf("\n", end - 1);
    if (ls < n.from || !blankIn(doc.src.slice(ls + 1, end), quotes)) return end;
    end = ls;
  }
}

const CALLOUT = /^\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/;
// Callouts inside one another past this many read as quotes.
const CALLOUTS_MAX = 4;

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
          // The text ends on the line before the underline (past that line's
          // quote marks, in a quote).
          const under = marks[marks.length - 1].from;
          const eol = this.doc.src.lastIndexOf("\n", under - 1);
          to = eol > from ? eol : under;
          while (to > from && /\s/.test(this.doc.src.charAt(to - 1))) to--;
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
      case "CommentBlock": {
        // Only what follows the comment's end shows, as raw HTML (as a browser
        // shows it); an unclosed comment hides the rest of the note.
        const src = this.src(n);
        const end = src.indexOf("-->");
        const tail = end < 0 ? "" : src.slice(end + 3).trim();
        return tail ? `<div class="raw-html" data-basalt-html="${escapeHtml(tail)}"></div>` : "";
      }
      case "LinkReference":
        if (this.ctx.seen) for (let l = lineOf(this.doc, n.from), last = lineOf(this.doc, n.to - 1); l <= last; l++) this.ctx.seen.lines.add(this.doc.map[l] ?? l);
        return "";
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
    const k = htmlLines(lines);
    if (k < 0) return raw(src);
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

  private quote(n: SyntaxNode): string {
    // Each callout reads its body again, so past a few inside one another the
    // rest are quotes: this way a deep chain can't take time by its depth.
    const callout = this.ctx.callouts < CALLOUTS_MAX ? calloutOf(this.doc.src, n) : null;
    if (!callout) return `<blockquote>${new Blocks(this.doc, this.ctx, this.depth + 1).children(n).join("\n")}</blockquote>`;
    const type = callout[1].toLowerCase();
    const fold = callout[2]; // "", "+" (foldable-open) or "-" (foldable-closed)
    const titleText = callout[3].trim() || callout[1].charAt(0).toUpperCase() + callout[1].slice(1).toLowerCase();
    const icon = `<span class="md-callout-icon">${calloutIcon(type)}</span>`;
    const title = inlineOf(titleText, this.ctx);
    this.ctx.callouts++;
    const inPlace = this.bodyInPlace(n);
    let body: string;
    if (inPlace !== null) body = inPlace ? `<div class="md-callout-body">${inPlace}</div>` : "";
    else {
      const { text, lines } = calloutBody(this.doc, n);
      const map = lines.map((l) => this.doc.map[l] ?? l);
      const inner = text.trim() ? renderDoc(text, map, this.ctx, this.depth + 1, this.doc.links) : "";
      body = inner ? `<div class="md-callout-body">${inner}</div>` : "";
    }
    this.ctx.callouts--;
    const cls = `md-callout md-callout-${escapeHtml(type)} md-callout-color-${calloutColor(type)}`;
    if (fold)
      return `<details class="${cls} md-callout-foldable"${fold === "-" ? "" : " open"}><summary class="md-callout-title">${icon}${title}</summary>${body}</details>`;
    return `<div class="${cls}"><div class="md-callout-title">${icon}${title}</div>${body}</div>`;
  }


  /** A callout's body rendered from the note's own parse, where that reads
   * as the body read on its own would (most bodies: plain text, lists and
   * links, every line in the quote), or null where it might not. A list around the callout changes how the parser reads lines
   * in it, so then it's read again too. */
  private bodyInPlace(n: SyntaxNode): string | null {
    let lead = n.firstChild;
    while (lead?.name === "QuoteMark") lead = lead.nextSibling;
    if (lead?.name !== "Paragraph") return null;
    const src = this.doc.src.slice(n.from, n.to);
    if (/[\t<]|\$\$/.test(src)) return null;
    let depth = 0;
    for (let p: SyntaxNode | null = n; p; p = p.parent) {
      if (p.name === "Blockquote") depth++;
      else if (p.name === "ListItem") return null;
    }
    // Every line after the title in this quote, with room under the limit.
    const first = lineOf(this.doc, n.from);
    // A table's rows are read past the first row's quote marks, so marks
    // laid out another way read differently on their own.
    const table = src.includes("|");
    let marks: string | undefined;
    for (let l = first + 1, last = lineOf(this.doc, n.to - 1); l <= last; l++) {
      const line = this.doc.src.slice(this.doc.lineStarts[l], lineEnd(this.doc, l));
      let k = 0;
      let seen = 0;
      while (k < line.length && " >".includes(line[k])) if (line[k++] === ">") seen++;
      if (seen < depth) return null;
      if (table && (marks ??= line.slice(0, k)) !== line.slice(0, k)) return null;
      // Quotes and list markers past this callout's, each a level at most.
      let m = k;
      while (m < line.length && "-*+.)0123456789 >".includes(line[m])) m++;
      if (this.depth + 1 + seen - depth + m - k > MAX_DEPTH) return null;
    }
    const titleEnd = lineEnd(this.doc, first);
    const parts: string[] = [];
    if (lead.to > titleEnd) {
      // The title's paragraph runs on: into plain text, with nothing inline
      // across the title's end.
      // Past this quote's marks (each with a space after it, if any) and no
      // further: an indent would make code.
      let rest = titleEnd + 1;
      for (let q = 0; q < depth; q++) {
        while (this.doc.src[rest] === " ") rest++;
        if (this.doc.src[rest] === ">") rest++;
        if (this.doc.src[rest] === " ") rest++;
      }
      if (!/^(?!\d+[.)])[\p{L}\p{N}]/u.test(this.doc.src.slice(rest, rest + 12))) return null;
      for (let c = lead.firstChild; c; c = c.nextSibling) if (c.from < titleEnd && c.to > titleEnd) return null;
      const at = lineOf(this.doc, rest);
      const attr = this.ctx.lines ? ` data-line="${this.doc.map[at] ?? at}"` : "";
      parts.push(`<p${attr}>${inlineNode(this.doc, this.ctx, lead, rest, lead.to)}</p>`);
    }
    const inner = new Blocks(this.doc, this.ctx, this.depth + 1);
    for (let c = lead.nextSibling; c; c = c.nextSibling) {
      const html = inner.block(c);
      if (html) parts.push(html);
    }
    return parts.join("\n");
  }

  private list(n: SyntaxNode): string {
    const items: SyntaxNode[] = [];
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === "ListItem") items.push(c);
    // Loose (paragraphs in <p>) when items, or blocks inside one, are apart.
    let quotes = 0;
    for (let p = n.parent; p; p = p.parent) if (p.name === "Blockquote") quotes++;
    const apart = (a: SyntaxNode, b: SyntaxNode) => blankBetween(this.doc, textEnd(this.doc, a, quotes), b.from, quotes);
    let loose = items.some((it, i) => i > 0 && apart(items[i - 1], it));
    if (!loose) {
      loose = items.some((it) => {
        const blocks: SyntaxNode[] = [];
        for (let c = it.firstChild; c; c = c.nextSibling) if (c.name !== "ListMark" && c.name !== "QuoteMark") blocks.push(c);
        return blocks.some((b, i) => i > 0 && apart(blocks[i - 1], b));
      });
    }
    const ordered = n.name === "OrderedList";
    const firstMark = items[0]?.getChild("ListMark");
    const start = ordered && firstMark ? parseInt(this.src(firstMark), 10) : 1;
    const inner = new Blocks(this.doc, this.ctx, this.depth + 1);
    const lis = items
      .map((it) => {
        // Past the nesting limit its text shows as source, so no checkbox either.
        const task = this.depth + 1 > MAX_DEPTH ? null : it.getChild("Task");
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
      // A row with more cells than the header keeps them, as Obsidian shows.
      const cs = cells(c);
      rows.push(`<tr>${Array.from({ length: Math.max(cols, cs.length) }, (_, i) => cell("td", cs[i] ?? "", i)).join("")}</tr>`);
    }
    return `<table class="md-table"><thead><tr>${head.map((h, i) => cell("th", h, i)).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
  }
}

/** Collect link reference definitions (`[label]: url`). */
function collectLinks(doc: Doc, top: SyntaxNode) {
  // In document order, the first definition of a label winning, without
  // recursion, as lists can nest thousands deep.
  const todo: SyntaxNode[] = [];
  const childrenOf = (n: SyntaxNode) => {
    const kids: SyntaxNode[] = [];
    for (let c = n.firstChild; c; c = c.nextSibling) kids.push(c);
    for (let i = kids.length - 1; i >= 0; i--) todo.push(kids[i]);
  };
  childrenOf(top);
  for (let c = todo.pop(); c; c = todo.pop()) {
    if (c.name === "LinkReference") {
      const label = c.getChild("LinkLabel");
      const url = c.getChild("URL");
      if (label && url) {
        const key = refKey(doc.src.slice(label.from, label.to));
        if (!doc.links.has(key)) doc.links.set(key, { url: doc.src.slice(url.from, url.to).replace(/^<|>$/g, "") });
      }
    } else if (["Blockquote", "ListItem", "BulletList", "OrderedList"].includes(c.name)) childrenOf(c);
  }
}

function renderDoc(text: string, map: number[] | undefined, ctx: Ctx, depth: number, links?: Doc["links"]): string {
  const doc = makeDoc(text, map);
  // Where definitions are doesn't hang on inline syntax.
  const tree = (ctx.seen ? blockParser : mdParser).parse(text);
  // A callout's body sees the note's link definitions, as the rest does.
  if (links) doc.links = links;
  collectLinks(doc, tree.topNode);
  if (ctx.seen && !links) for (let l = 0; l < doc.lineStarts.length; l++) ctx.seen.parts.set(doc.map[l], doc.links);
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
/** Code (left alone: ``` and ~~~ fences, `` `` `` and ` spans) or an
 * Obsidian `%%comment%%`, inline or over lines. */
const COMMENT_OR_CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|``[^\n]*?``|`[^`\n]*`)|%%[\s\S]*?%%/g;

/** A line indented four spaces or a tab past any quote or list markers, which
 * may be code depending on the lines around it (more than that, as it only
 * decides whether to parse). The markers are matched once, as read: the
 * lookahead and its backreference keep a long run of them from being tried
 * every way it could split. */
export const INDENTED_RE = /^(?=((?: {0,3}(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*))\1(?: {4}|[ \t]*\t)/;
const INDENTED_LINES = new RegExp(INDENTED_RE.source, "m");
/** Whether any line of `md` may be indented code. */
export const mayIndent = (md: string) => INDENTED_LINES.test(md);
const INDENTED_COMMENT = new RegExp(INDENTED_RE.source + ".*%%", "m");

/** Whether an indented line holds a `%%`, which may be code rather than a
 * comment depending on the lines around it. */
export function mayHaveIndentedComment(md: string): boolean {
  return INDENTED_COMMENT.test(md);
}

/** Indented code blocks (four spaces or a tab, outside a list), whose text is
 * literal. Only parsed for when an indented line holds a `%%`. */
function indentedCode(md: string): [number, number][] {
  return mayHaveIndentedComment(md) ? indentedCodeRanges(md) : [];
}

/** Offsets of the `>` marks that open quote lines, as Reading view reads them:
 * with comments taken out, frontmatter and footnote definitions blanked, and
 * what follows an HTML block's closing line read as a note of its own. */
export function quoteMarkOffsets(md: string): Set<number> {
  const { text, at } = withoutComments(md);
  const lines = text.split("\n");
  const kept = extractFootnoteDefs(text).text.split("\n");
  const fm = lines[0]?.trim() === "---" && parseFm(text) ? frontmatterEnd(lines) : -1;
  const prepared = lines.map((l, i) => (i <= fm || (kept[i] === "" && l !== "") ? " ".repeat(l.length) : l)).join("\n");
  const out = new Set<number>();
  const collect = (doc: string, offset: number, depth: number) => {
    blockParser.parse(doc).iterate({
      enter: (n) => {
        if (n.name === "QuoteMark") out.add(at(offset + n.from));
        if (n.name !== "HTMLBlock") return;
        const ls = doc.slice(n.from, n.to).split("\n");
        const tag = ls[0].includes(">") ? /^\s*<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(ls[0])?.[1] : undefined;
        const close = tag ? new RegExp(`</${tag}\\s*>`, "i") : null;
        const k = close ? ls.findIndex((l) => close.test(l)) : -1;
        if (k < 0 || k === ls.length - 1 || depth + 1 > MAX_DEPTH) return false;
        const end = n.from + ls.slice(0, k + 1).join("\n").length;
        collect(doc.slice(end + 1, n.to), offset + end + 1, depth + 1);
        return false;
      },
    });
  };
  collect(prepared, 0, 0);
  return out;
}

/** Where the indented code blocks are (four spaces or a tab, outside a list),
 * as [from, to) offsets. The note is parsed only if a line is indented. */
export function indentedCodeRanges(md: string): [number, number][] {
  if (!INDENTED_LINES.test(md)) return [];
  const out: [number, number][] = [];
  blockParser.parse(md).iterate({
    enter: (n) => {
      if (n.name === "CodeBlock") out.push([n.from, n.to]);
      return n.name !== "CodeBlock";
    },
  });
  return out;
}

/** Whether `md` has HTML a line's own mask can't see: `<!` or `<?`, a tag
 * still open at a line break, or a line led by a tag (after any quote and list
 * marks). */
export function mayRunHtml(md: string): boolean {
  if (!md.includes("<")) return false;
  // The next `>` and line break, found again only once passed, so this stays linear.
  const next = (c: string, from: number) => {
    const at = md.indexOf(c, from);
    return at < 0 ? Infinity : at;
  };
  let gt = -1;
  let nl = -1;
  for (let i = md.indexOf("<"); i >= 0; i = md.indexOf("<", i + 1)) {
    const c = md[i + 1] ?? "";
    if (c === "!" || c === "?") return true;
    if (!/[A-Za-z/]/.test(c)) continue;
    if (gt <= i) gt = next(">", i + 1);
    if (nl <= i) nl = next("\n", i + 1);
    if (nl < gt) return true;
    let k = i;
    // Back to the line's start over its quote and list markers, so far. A
    // longer run of them is past Reading view's nesting limit, where the line
    // shows as its source, but a long indent is left to the parse.
    while (k > 0 && i - k < 200 && " \t>-*+.)0123456789".includes(md[k - 1])) k--;
    if (i - k >= 200 && /^[ \t]*$/.test(md.slice(k, i))) return true;
    if ((k === 0 || md[k - 1] === "\n") && /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+|>[ \t]*)*$/.test(md.slice(k, i))) return true;
  }
  return false;
}

/** Where `md` shows as raw HTML, escaped or not at all, as Reading view renders
 * it: an HTML block or a paragraph led by a block-level tag up to the line
 * closing its tag (all of it when nothing closes it or its first line has no
 * `>`), comments, processing instructions and inline HTML (unless `withHtml`
 * is false). With `indented`, indented code too. One parse, and only when a
 * line is indented or HTML could run past what a line's own mask sees. With
 * `fences`, fenced code too: what follows a paragraph led by a tag is read
 * apart from it here, where the note's own mask doesn't split it. */
const NESTING = new Set(["Blockquote", "BulletList", "OrderedList"]);

export function rawRanges(
  md: string,
  indented: boolean,
  withHtml = true,
  depth = 0,
  fences = false,
  deep = true,
  inCallouts = 0,
): [number, number][] {
  const code = indented && INDENTED_LINES.test(md);
  const html = withHtml && mayRunHtml(md);
  // What follows an HTML block is always read, for how deep it sits, and a
  // callout's body, which Reading view reads as a note of its own (where only
  // a fence, math or nesting can hide more). With `deep` false the caller
  // found no deep line or callout near what it needs.
  let nested: boolean | undefined;
  const isNested = () => (nested ??= deep && mayNestDeep(md));
  const callouts =
    deep &&
    !code &&
    !html &&
    !depth &&
    md.includes("[!") &&
    (((md.includes("```") || md.includes("~~~") || md.includes("$$")) && CALLOUT_FENCE.test(md)) || (isNested() && !HUGE_NESTING.test(md) && mayTitleAtLimit(md))) &&
    CALLOUT_LINE.test(md);
  if (!code && !html && !depth && !callouts && !isNested()) return [];
  // Reading view leaves frontmatter out before it reads the note (blanked
  // only now, as a blanked line would look indented).
  if (!depth && FRONTMATTER_START.test(md)) md = blankFrontmatter(md);
  // A math block isn't a paragraph, so what follows one deep down isn't part
  // of it: only the parse knows.
  if (!code && !html && !depth && !callouts && !(md.includes("$$") && MATH_LINE.test(md))) return tooDeep(md);
  const out: [number, number][] = [];
  let doc: Doc | undefined;
  const hasCallout = md.includes("[!");
  // Each quote and list a block sits in takes it a level deeper, as in Reading view.
  let nest = 0;
  (html ? mdParser : blockParser).parse(md).iterate({
    leave: (n) => {
      if (NESTING.has(n.name)) nest--;
    },
    enter: (n) => {
      // Too deep, Reading view shows a block as its source; a callout at the
      // limit still shows its title.
      if (depth + nest > MAX_DEPTH) {
        out.push([n.from, n.to]);
        return false;
      }
      if (n.name === "Blockquote" && hasCallout && inCallouts < CALLOUTS_MAX && calloutOf(md, n.node)) {
        const eol = md.indexOf("\n", n.from);
        if (eol < 0 || eol >= n.to) return false;
        if (depth + nest === MAX_DEPTH) {
          out.push([eol + 1, n.to]);
          return false;
        }
        if (!bodyMayHide(md.slice(eol + 1, n.to), MAX_DEPTH - depth - nest - 1)) return false;
        // Its body, read on its own, with each range taken back to the note.
        doc ??= makeDoc(md, undefined);
        const body = calloutBody(doc, n.node);
        const starts = [0];
        for (let i = body.text.indexOf("\n"); i !== -1; i = body.text.indexOf("\n", i + 1)) starts.push(i + 1);
        const back = (x: number) => {
          // The body line holding x: the last that starts at or before it.
          let lo = 0;
          for (let hi = starts.length - 1; lo < hi; ) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= x) lo = mid;
            else hi = mid - 1;
          }
          return doc!.lineStarts[body.lines[lo]] + body.cut[lo] + Math.max(0, x - starts[lo] - body.pad[lo]);
        };
        for (const [f, t] of rawRanges(body.text, indented, withHtml, depth + nest + 1, true, true, inCallouts + 1)) out.push([back(f), back(t)]);
        return false;
      }
      if (NESTING.has(n.name)) nest++;
      switch (n.name) {
        case "FencedCode":
          if (fences) out.push([n.from, n.to]);
          return false;
        case "MathBlock":
          out.push([n.from, n.to]);
          return false;
        case "CodeBlock":
          if (code) out.push([n.from, n.to]);
          return false;
        case "CommentBlock":
        case "ProcessingInstructionBlock":
          if (html) out.push([n.from, n.to]);
          return false;
        case "HTMLTag":
        case "Comment":
        case "ProcessingInstruction":
          if (html) out.push([n.from, n.to]);
          return false;
        case "HTMLBlock":
        case "Paragraph": {
          if (!html) return;
          const lines = md.slice(n.from, n.to).split("\n");
          if (n.name === "Paragraph" && !(HTML_BLOCK.test(lines[0].trim()) && lines[0].includes(">"))) return;
          const tag = lines[0].includes(">") ? /^\s*<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(lines[0])?.[1] : undefined;
          const close = tag ? new RegExp(`</${tag}\\s*>`, "i") : null;
          const k = close ? lines.findIndex((l) => close.test(l)) : -1;
          const end = k < 0 || k === lines.length - 1 ? n.to : n.from + lines.slice(0, k + 1).join("\n").length;
          out.push([n.from, end]);
          // What follows the closing line shows as a note of its own, and past
          // Reading view's nesting limit as its source, escaped.
          const at = depth + nest + 1;
          if (end < n.to) {
            if (at > MAX_DEPTH) out.push([end + 1, n.to]);
            else {
              for (const [f, t] of rawRanges(md.slice(end + 1, n.to), indented, withHtml, at, fences || n.name === "Paragraph", true)) out.push([f + end + 1, t + end + 1]);
            }
          }
          return false;
        }
      }
    },
  });
  return out;
}

/** Whether a callout's body (`src`, its lines as written) may hold anything
 * `rawRanges` finds: code, math or HTML, an indented line, or markers that
 * could nest a block more than `room` deeper. Most bodies don't, and then
 * reading them again is skipped. */
function bodyMayHide(src: string, room: number): boolean {
  if (/[`~<\t]|\$\$| {4}/.test(src)) return true;
  for (let k = 0; k < src.length; k = src.indexOf("\n", k) + 1 || src.length) {
    let i = k;
    while (i < src.length && i - k <= room && " >*+-.)0123456789".includes(src[i])) i++;
    if (i - k > room) return true;
  }
  return false;
}

/** The lines of blocks nested past Reading view's limit, which show as their
 * source, read without a parse: a line of thousands of markers makes one slow.
 * A note with a callout is parsed instead, as a callout's title at the limit
 * shows. */
function tooDeep(md: string): [number, number][] {
  const lines = md.split("\n");
  const depths = blockDepths(lines);
  const out: [number, number][] = [];
  for (let k = 0, at = 0; k < lines.length; at += lines[k].length + 1, k++) if (depths[k] > MAX_DEPTH) out.push([at, at + lines[k].length]);
  return out;
}

// A fence or math in a quote, or on the line after a callout's title (which
// its body takes in even without a `>`).
const CALLOUT_FENCE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*>[^\n]*(?:```|~~~|\$\$)|\[![\w-]+\][^\n]*\n[^\n]*(?:```|~~~|\$\$)/m;
/** Whether a callout's title may sit just past Reading view's nesting limit,
 * where it still shows: its line's quote and list markers, and its indent
 * (two columns a level), reach that deep. */
function mayTitleAtLimit(md: string): boolean {
  for (let i = md.indexOf("[!"); i >= 0; ) {
    const start = md.lastIndexOf("\n", i) + 1;
    const lead = md.slice(start, i);
    // Only a line's first `[!` has nothing but markers before it.
    const eol = md.indexOf("\n", i);
    i = eol < 0 ? -1 : md.indexOf("[!", eol);
    if (!lead.includes(">") || !/^(?:[ \t>]|(?:[-*+]|\d{1,9}[.)])[ \t])*$/.test(lead)) continue;
    let levels = 0;
    let indent = 0;
    for (let k = 0; k < lead.length; k++) {
      const c = lead[k];
      if (c === ">" || c === "-" || c === "*" || c === "+" || c === "." || c === ")") levels++;
      else if ((c === " " || c === "\t") && lead[k - 1] !== ">") indent += c === "\t" ? 4 : 1;
    }
    if (levels + (indent >> 1) > MAX_DEPTH) return true;
  }
  return false;
}
// A line of a thousand quote or list markers, which a parse takes long over
// and whose blocks show as their source anyway.
const HUGE_NESTING = /(?:^|\n)[ \t>*+\-.)0-9]{1000}/;
// A line that may open a math block, past its quote and list markers.
const MATH_LINE = /^(?:[ \t>]|(?:[-*+]|\d{1,9}[.)])[ \t])*\$\$/m;
// A note that may open with frontmatter (after a byte order mark or spaces).
const FRONTMATTER_START = /^\s*---/;

/** Every math block in `md`, by where it starts, to where it ends, as Reading
 * view reads the note (comments out, frontmatter blanked). */
export function mathBlocks(md: string): Map<number, number> {
  const { text, at } = withoutComments(md);
  const out = new Map<number, number>();
  // Each piece to read: its text, where it starts and how deep it sits.
  const todo: [string, number, number][] = [[FRONTMATTER_START.test(text) ? blankFrontmatter(text) : text, 0, 0]];
  for (let piece; (piece = todo.pop()); ) {
    const [src, from, depth] = piece;
    let nest = 0;
    blockParser.parse(src).iterate({
      leave: (n) => {
        if (NESTING.has(n.name)) nest--;
      },
      enter: (n) => {
        // Past Reading view's nesting limit a block shows as its source.
        if (depth + nest > MAX_DEPTH) return false;
        if (n.name === "MathBlock") out.set(at(from + n.from), n.to > n.from ? at(from + n.to - 1) + 1 : at(from + n.from));
        // What follows an HTML block's own HTML reads as a note of its own, a level deeper.
        else if (n.name === "HTMLBlock") {
          const lines = src.slice(n.from, n.to).split("\n");
          const k = lines[0].includes(">") ? htmlLines(lines) : -1;
          if (k >= 0) {
            const rest = n.from + lines.slice(0, k + 1).join("\n").length + 1;
            todo.push([src.slice(rest, n.to), from + rest, depth + nest + 1]);
          }
        }
        if (NESTING.has(n.name)) nest++;
        return n.type.isTop || NESTING.has(n.name) || n.name === "ListItem";
      },
    });
  }
  return out;
}

/** `md` with its frontmatter blanked to spaces, keeping every offset. */
function blankFrontmatter(md: string): string {
  const first = md.indexOf("\n");
  if (first < 0 || md.slice(0, first).trim() !== "---") return md;
  for (let at = first + 1; ; ) {
    const nl = md.indexOf("\n", at);
    const end = nl < 0 ? md.length : nl;
    const t = md.slice(at, end).trim();
    if (t === "---" || t === "...") return md.slice(0, end).replace(/[^\n]/g, " ") + md.slice(end);
    if (nl < 0) return md;
    at = nl + 1;
  }
}

/** Whether a line's quote and list markers and indent are wide enough to put
 * a block past Reading view's nesting limit: each level takes a column. */
export function mayNestDeep(md: string): boolean {
  if (!DEEP_HINT.test(md)) return false;
  for (let i = 0; i < md.length; ) {
    let col = 0;
    let k = i;
    for (; k < md.length && col <= MAX_DEPTH; k++) {
      const c = md.charCodeAt(k);
      if (c === 9) col += 4 - (col % 4);
      else if (c === 32 || c === 62 || c === 42 || c === 43 || c === 45 || c === 46 || c === 41 || (c >= 48 && c <= 57)) col++;
      else break;
    }
    if (col > MAX_DEPTH) return true;
    const next = md.indexOf("\n", k);
    if (next < 0) return false;
    i = next + 1;
  }
  return false;
}
// A tab is up to four columns, so a line needs at least this many of them.
const DEEP_HINT = new RegExp(`(?:^|\\n)[ \\t>*+\\-.)0-9]{${Math.ceil((MAX_DEPTH + 1) / 4)}}`);

/** `md` with its `%%comments%%` taken out, as Reading view takes them out, and
 * where each offset of that text was in `md`. */
function withoutComments(md: string): { text: string; at: (p: number) => number } {
  if (!md.includes("%%")) return { text: md, at: (p) => p };
  const kept: [number, number][] = []; // where each kept stretch starts: [in the text, in md]
  let text = "";
  let last = 0;
  for (const r of commentsAndCode(md)) {
    if (r.code || r.from < last) continue;
    kept.push([text.length, last]);
    text += md.slice(last, r.from);
    last = r.to;
  }
  kept.push([text.length, last]);
  text += md.slice(last);
  const at = (p: number) => {
    let lo = 0;
    for (let hi = kept.length - 1; lo < hi; ) {
      const mid = (lo + hi + 1) >> 1;
      if (kept[mid][0] <= p) lo = mid;
      else hi = mid - 1;
    }
    return kept[lo][1] + p - kept[lo][0];
  };
  return { text, at };
}

/** `rawRanges` as Reading view sees the note: with its `%%comments%%` taken
 * out first. The ranges are offsets into `md`. */
export function rawRangesBeyondComments(md: string, indented: boolean, withHtml = true, deep = true): [number, number][] {
  const { text, at } = withoutComments(md);
  const back = ([f, t]: [number, number]): [number, number] => [at(f), t > f ? at(t - 1) + 1 : at(f)];
  return rawRanges(text, indented, withHtml, 0, false, deep).map(back);
}

/** The code and comments in `md`, in order: `code` is true for code (left as
 * written), false for a `%%comment%%`. */
function* commentsAndCode(md: string): Generator<{ from: number; to: number; code: boolean }> {
  const re = new RegExp(COMMENT_OR_CODE.source, "g");
  const blocks = indentedCode(md);
  let b = 0;
  for (let m; (m = re.exec(md)); ) {
    while (b < blocks.length && blocks[b][1] <= m.index) b++;
    const block = blocks[b];
    if (block && block[0] <= m.index) {
      yield { from: block[0], to: block[1], code: true };
      re.lastIndex = block[1];
      continue;
    }
    yield { from: m.index, to: m.index + m[0].length, code: m[1] !== undefined };
  }
}

/** Where each `%%comment%%` is, as [from, to) offsets, skipping code. */
export function commentRanges(md: string): [number, number][] {
  const out: [number, number][] = [];
  for (const r of commentsAndCode(md)) if (!r.code) out.push([r.from, r.to]);
  return out;
}

export function stripCommentsMapped(md: string): { text: string; map: number[] } {
  const map = [0];
  if (!md.includes("%%")) {
    for (let p = md.indexOf("\n"); p !== -1; p = md.indexOf("\n", p + 1)) map.push(map.length);
    return { text: md, map };
  }
  let text = "";
  let src = 0; // source line at the current position
  const copy = (chunk: string) => {
    text += chunk;
    for (let p = chunk.indexOf("\n"); p !== -1; p = chunk.indexOf("\n", p + 1)) map.push(++src);
  };
  let last = 0;
  for (const r of commentsAndCode(md)) {
    if (r.from < last) continue;
    const found = md.slice(r.from, r.to);
    copy(md.slice(last, r.from));
    if (r.code) copy(found);
    else for (let p = found.indexOf("\n"); p !== -1; p = found.indexOf("\n", p + 1)) src++;
    last = r.to;
  }
  copy(md.slice(last));
  return { text, map };
}

/** Conceal Obsidian block-reference markers (`^blockid` at a line's end or on
 * its own line) — they're anchors, not content, and Obsidian hides them. Only
 * in prose lines, so a `^id` inside a code block is left intact. */
export function stripBlockIds(md: string): string {
  if (!md.includes("^")) return md;
  const lines = md.split("\n");
  const mask = proseMask(lines);
  return lines
    .map((l, i) =>
      mask[i] ? l.replace(/(?<![ \t])[ \t]+\^[A-Za-z0-9-]+\s*$/, "").replace(/^\^[A-Za-z0-9-]+[ \t]*$/, "") : l,
    )
    .join("\n");
}

/** Pull footnote definitions (`[^id]: text` + indented continuations, in prose)
 * out of the doc, blanking their lines so line numbers hold. */
function extractFootnoteDefs(md: string): { text: string; defs: Map<string, string> } {
  if (!md.includes("[^")) return { text: md, defs: new Map() };
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

/** A property value, its links live as in Obsidian: `[[Note]]`s anywhere in
 * it, and a value that is a URL or a Markdown link. Everything else is text. */
function propertyValue(v: string): string {
  const md = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(v.trim());
  if (md) return `<a class="md-link" data-href="${escapeHtml(md[2])}">${escapeHtml(md[1] || md[2])}</a>`;
  if (/^https?:\/\/\S+$/.test(v.trim())) return `<a class="md-link" data-href="${escapeHtml(v.trim())}">${escapeHtml(v.trim())}</a>`;
  let out = "";
  let last = 0;
  for (const m of v.matchAll(/\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]/g)) {
    const target = m[1].trim();
    out += escapeHtml(v.slice(last, m.index));
    out += `<a class="md-wikilink" data-target="${escapeHtml(target)}">${escapeHtml(m[2]?.trim() ?? wikilinkLabel(target))}</a>`;
    last = m.index! + m[0].length;
  }
  return out + escapeHtml(v.slice(last));
}

/** Render a full Markdown document to an HTML string. With `lines`, each block
 * carries the source line it starts on as `data-line`, for Reading view. */
export function renderMarkdown(src: string, opts: { lines?: boolean } = {}): string {
  return render(src, opts);
}

/** The lines Reading view hides as link reference definitions, and the labels
 * the note defines, as rendering it finds them. */
export function linkDefinitions(src: string): Definitions {
  const seen: Seen = { lines: new Set(), parts: new Map() };
  const md = HUGE_NESTING.test(src) ? src.split("\n").map(shallower).join("\n") : src;
  render(md, {}, seen);
  // The note's first line is always in the note's own piece.
  const top = seen.parts.get(0) ?? new Map();
  const labels = new Set(top.keys());
  const own = new Map<number, Set<string>>();
  const sets = new Map([[top, labels]]);
  for (const [l, links] of seen.parts) {
    if (links === top) continue;
    let set = sets.get(links);
    if (!set) sets.set(links, (set = new Set(links.keys())));
    own.set(l, set);
  }
  const defs = { lines: seen.lines, labels, own };
  if (!md.includes("%%")) return defs;
  // A comment over lines joins them into one, all of it the definition's.
  const { map } = stripCommentsMapped(md);
  const lines = md.split("\n").length;
  for (let s = 0; s < map.length; s++) {
    const set = own.get(map[s]);
    const hidden = seen.lines.has(map[s]);
    if (!set && !hidden) continue;
    for (let l = map[s] + 1, end = s + 1 < map.length ? map[s + 1] : lines; l < end; l++) {
      if (hidden) seen.lines.add(l);
      if (set) own.set(l, set);
    }
  }
  return defs;
}

/** A line nested a thousand deep or more, cut to that depth (the parse takes
 * long over each level past it): blocks past the nesting limit show as their
 * source whatever their depth, and a line under it can't reach further. */
function shallower(line: string): string {
  const lead = /^[ \t>*+\-.)0-9]*/.exec(line)![0].length;
  if (lead < 1000) return line;
  let cut = 1000;
  while (cut > 0 && !" \t>".includes(line[cut - 1])) cut--;
  return line.slice(0, cut) + line.slice(lead);
}

function render(src: string, opts: { lines?: boolean }, seen?: Seen): string {
  const { text: stripped, map } = stripCommentsMapped(src);
  let md = stripBlockIds(stripped);
  const parts: string[] = [];

  // Leading frontmatter → a Properties table; its lines become blank.
  const lines = md.split("\n");
  if (lines[0]?.trim() === "---") {
    const fm = parseFm(md);
    if (fm) {
      const rows = fm.props
        .map((p) => `<tr><th>${escapeHtml(p.key)}</th><td>${p.values.map(propertyValue).join(", ")}</td></tr>`)
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
  ctx.seen = seen;
  const body = renderDoc(text, map, ctx, 0);
  if (body) parts.push(body);
  return parts.join("\n") + emitFootnotes(ctx);
}
