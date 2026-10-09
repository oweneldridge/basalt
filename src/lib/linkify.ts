// Convert an UNLINKED mention (a bare occurrence of a note's name) into a
// `[[wikilink]]`, matching Obsidian's "Link"/"Link all" backlink actions. Pure
// + length-preserving masking so we splice into the ORIGINAL line by offset,
// never touching a mention that sits inside inline code or an existing link.
import { wikilinkRegex, mdLinkRegexGlobal, tagRegex, proseMask } from "./markdown";
import { commentRanges, indentedCodeRanges } from "./render";

// A code span: a run of backticks, closed by a run of the same length.
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g;
const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>()[\]]+/gi;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const INLINE_MATH_RE = /\$(?=[^\s$])(?:[^$\n]*?[^\s$])?\$(?!\d)/g;
// An HTML tag as CommonMark reads one, so prose with a `<` in it isn't taken
// for one.
const HTML_TAG_RE =
  /<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^'\n]*'|"[^"\n]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>/g;
// An autolink, `<scheme:...>` or `<user@host>`.
const AUTOLINK_RE = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>|<[\w.+-]+@[\w-]+(?:\.[\w-]+)+>/g;
// A link reference definition, in a quote or a list item too: a label (not a
// footnote's), an address and maybe a title, with nothing after them.
const REF_DEF_RE =
  /^[ \t>]*((?:[-*+]|\d{1,9}[.)])[ \t]+)?\[(?!\^)([^\]\n]+)\]:[ \t]*(?:<[^<>\n]*>|[^\s<]\S*)(?:[ \t]+("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\((?:[^()\\\n]|\\.)*\)))?[ \t\r]*$/;
// A definition's title on the line after it.
const DEF_TITLE_RE = /^[ \t>]*(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\((?:[^()\\\n]|\\.)*\))[ \t\r]*$/;
// A reference link or image, `[text][label]`, `![alt][label]` or `[label][]`.
const REF_LINK_RE = /!?\[[^\]\n]*\]\[[^\]\n]*\]/g;
// A shortcut reference link, `[label]`, a link only when the note defines it.
const SHORTCUT_RE = /!?\[([^\][\n]+)\]/g;
// A callout's type, a footnote reference and an email address. Run after the
// links and URLs are masked, so a linked image's `[![` isn't read as a callout.
const OTHER_RE = /\[![^\]\n]*\]|\[\^[^\]\n]+\]|(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** A reference label as links match it: case and runs of spaces ignored. */
const label = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/** `line` with what can't hold a linkable mention (inline code and math, HTML
 * tags, autolinks, links and reference links, URLs, tags, callout types,
 * footnotes, references, emails) blanked to spaces, same length, so offsets
 * still match the line. `refs` are the labels the note defines. */
export function maskForMentions(line: string, refs: ReadonlySet<string> = new Set()): string {
  return maskRest(blankLinks(maskCode(line), refs), refs);
}

/** `line` with definitions, code, math, HTML and wikilinks blanked: what
 * can hold brackets that aren't a link's. */
function maskCode(line: string): string {
  if (REF_DEF_RE.test(line)) return " ".repeat(line.length);
  return line
    .replace(INLINE_CODE_RE, (m) => " ".repeat(m.length))
    .replace(INLINE_MATH_RE, (m) => " ".repeat(m.length))
    .replace(AUTOLINK_RE, (m) => " ".repeat(m.length))
    .replace(HTML_TAG_RE, (m) => " ".repeat(m.length))
    .replace(wikilinkRegex(), (m) => " ".repeat(m.length));
}

/** `line`, its inline links already blanked, with the rest blanked too. */
function maskRest(line: string, refs: ReadonlySet<string>): string {
  return line
    .replace(mdLinkRegexGlobal(), (m) => " ".repeat(m.length))
    .replace(REF_LINK_RE, (m) => " ".repeat(m.length))
    .replace(SHORTCUT_RE, (m, text: string) => (refs.has(label(text)) ? " ".repeat(m.length) : m))
    .replace(URL_RE, (m) => " ".repeat(m.length))
    .replace(OTHER_RE, (m) => " ".repeat(m.length))
    .replace(tagRegex(), (m) => " ".repeat(m.length));
}

// A line that ends a paragraph: blank, a heading, a thematic break or a
// heading's `===` underline.
const ENDS_RE = /^[ \t>]*(?:\r?$|#{1,6}(?:[ \t]|\r?$)|([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$|=+[ \t]*\r?$)/;
// A line that starts a block of its own: a bullet item or a table row. A
// numbered item does when it's 1 or follows another item.
const STARTS_RE = /^[ \t>]*(?:[-*+](?:[ \t]|\r?$)|\|)/;
const NUMBERED_RE = /^[ \t>]*(\d{1,9})[.)](?:[ \t]|\r?$)/;
const ITEM_RE = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|\r?$)/;
const starts = (next: string, line: string) => {
  const n = NUMBERED_RE.exec(next);
  return STARTS_RE.test(next) || (!!n && (parseInt(n[1], 10) === 1 || ITEM_RE.test(line)));
};
// A line that is a block by itself: a heading or a table row.
const SINGLE_RE = /^[ \t>]*(?:#{1,6}(?:[ \t]|\r?$)|\|)/;
// Spaces with at most one line break, and the quote marks after it.
const SPACE_RE = /[ \t]*(?:\n[ \t>]*)?/y;
// A link's title, if any, on at most two lines, and the `)` that ends the link.
const TITLE_RE =
  /(?:"(?:[^"\\\n]|\\.)*(?:\n(?:[^"\\\n]|\\.)*)?"|'(?:[^'\\\n]|\\.)*(?:\n(?:[^'\\\n]|\\.)*)?'|\((?:[^()\\\n]|\\.)*(?:\n(?:[^()\\\n]|\\.)*)?\))?[ \t]*(?:\n[ \t>]*)?\)/y;
// A reference link's label, after its text.
const LABEL_RE = /\[[^[\]\n]*\]/y;
// Characters a backslash escapes.
const PUNCT_RE = /[!-/:-@[-`{-~]/;
// The quote marks a line starts with.
const quotes = (line: string) => (/^[ \t>]*/.exec(line)![0].match(/>/g) ?? []).length;
// Whether a line ends a paragraph: it's blank, a heading, a break or underline.
const endsPara = (line: string) => ENDS_RE.test(line);

/** `text` with each inline link and image blanked, however deep the brackets
 * in its text or the parentheses in its address go, and whichever lines its
 * text, address or title run onto, along with each `[text][label]`. A `](`
 * with no `[` before it in its paragraph ends a link whose text began above. */
function blankLinks(text: string, refs: ReadonlySet<string>): string {
  const open: number[] = [];
  const links: [number, number][] = [];
  const marks = /[\\\n[\]]/g;
  let lineStart = 0;
  for (let m; (m = marks.exec(text)); ) {
    const j = m.index;
    if (text[j] === "\\") {
      if (PUNCT_RE.test(text[j + 1] ?? "")) marks.lastIndex = j + 2;
    } else if (text[j] === "\n") {
      if (open.length) {
        // A bracket left open ends with its paragraph.
        const line = text.slice(lineStart, j);
        const nextEnd = text.indexOf("\n", j + 1);
        const next = text.slice(j + 1, nextEnd < 0 ? text.length : nextEnd);
        if (SINGLE_RE.test(line) || endsPara(next) || starts(next, line) || quotes(next) > quotes(line)) open.length = 0;
      }
      lineStart = j + 1;
    } else if (text[j] === "[") open.push(j);
    else {
      const i = open.pop() ?? j;
      let end = -1;
      if (text[j + 1] === "(") end = addressEnd(text, j + 2);
      else if (text[j + 1] === "[") {
        LABEL_RE.lastIndex = j + 1;
        if (LABEL_RE.test(text)) end = LABEL_RE.lastIndex;
      } else if (i < j && refs.has(label(text.slice(i + 1, j).replace(/\n[ \t>]*/g, " ")))) end = j + 1;
      if (end < 0) continue;
      links.push([text[i - 1] === "!" ? i - 1 : i, end]);
      marks.lastIndex = end;
      const nl = text.slice(j, end).lastIndexOf("\n");
      if (nl >= 0) lineStart = j + nl + 1;
    }
  }
  return blank(text, links);
}

/** Where a link's `(address "title")` ends, from where its address starts,
 * or -1 if it isn't one. An address in angle brackets may hold a `)`. */
function addressEnd(text: string, at: number): number {
  SPACE_RE.lastIndex = at;
  let j = at + SPACE_RE.exec(text)![0].length;
  if (text[j] === "<") {
    for (j++; text[j] !== ">"; j++) {
      if (j >= text.length || text[j] === "<" || text[j] === "\n") return -1;
      if (text[j] === "\\" && PUNCT_RE.test(text[j + 1] ?? "")) j++;
    }
    j++;
  } else {
    for (let depth = 0; j < text.length && !/\s/.test(text[j]); j++) {
      if (text[j] === "\\" && PUNCT_RE.test(text[j + 1] ?? "")) j++;
      else if (text[j] === "(") depth++;
      else if (text[j] === ")" && depth-- === 0) return j + 1;
    }
  }
  SPACE_RE.lastIndex = j;
  TITLE_RE.lastIndex = j + SPACE_RE.exec(text)![0].length;
  return TITLE_RE.test(text) ? TITLE_RE.lastIndex : -1;
}

/** The labels a note defines, from `lines` with what isn't prose blanked. A
 * definition can't break into a paragraph, though a list item or a quote that
 * starts there can hold one. */
function definedLabels(lines: string[]): Set<string> {
  const refs = new Set<string>();
  let para = -1; // the quote depth of the paragraph the line before is in, if any
  let untitled = false; // the line before is a definition with no title
  for (const line of lines) {
    const depth = quotes(line);
    const m = REF_DEF_RE.exec(line);
    if (m && (m[1] || para < 0 || depth > para)) refs.add(label(m[2]));
    const title = untitled && DEF_TITLE_RE.test(line);
    para = m || title || endsPara(line) ? -1 : depth;
    untitled = !!m && !m[3];
  }
  return refs;
}

/** Each line of a note as `maskForMentions` leaves it, with what spans lines
 * blanked too: frontmatter, fenced and indented code, `%%comments%%`, `$$`
 * math and HTML comments. What's left is where a mention can be linked. */
export function mentionLines(content: string, indented = true): string[] {
  const lines = content.split("\n");
  const prose = proseMask(lines);
  const text = blank(content, hiddenSpans(content, indented, lines, prose))
    .split("\n")
    .map((l, i) => (prose[i] ? l : " ".repeat(l.length)));
  const refs = content.includes("]:") ? definedLabels(text) : new Set<string>();
  // A definition's title may sit on the line after it.
  const code = text.map((l, i) => {
    if (!prose[i]) return l;
    const def = i > 0 ? REF_DEF_RE.exec(text[i - 1]) : null;
    return def && !def[3] && DEF_TITLE_RE.test(l) ? " ".repeat(l.length) : maskCode(l);
  });
  // Links are found across lines: a link's text, address or title may run on.
  return blankLinks(code.join("\n"), refs)
    .split("\n")
    .map((l, i) => (prose[i] ? maskRest(l, refs) : l));
}

/** Where a note's text isn't prose though its lines are: `%%comments%%`, `$$`
 * math, HTML comments and (unless `indented` is false, which skips a parse)
 * indented code. Frontmatter and fenced code are `proseMask`'s. */
export function hiddenSpans(content: string, indented = true, lines = content.split("\n"), prose = proseMask(lines)): [number, number][] {
  const spans: [number, number][] = content.includes("%%") ? commentRanges(content) : [];
  if (indented) spans.push(...indentedCodeRanges(content));
  if (content.includes("$$") || content.includes("<!--")) {
    // Paired outside code and comments, so a `$$` in them can't shift the pairs.
    const outside = blank(content, spans)
      .split("\n")
      .map((l, i) => (prose[i] ? l.replace(INLINE_CODE_RE, (m) => " ".repeat(m.length)) : " ".repeat(l.length)))
      .join("\n");
    for (const m of outside.matchAll(/\$\$[\s\S]*?\$\$|<!--[\s\S]*?-->/g)) spans.push([m.index!, m.index! + m[0].length]);
  }
  return spans;
}

/** `text` with each span blanked to spaces, its newlines kept. */
function blank(text: string, spans: [number, number][]): string {
  if (!spans.length) return text;
  let out = "";
  let at = 0;
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const start = Math.max(from, at);
    if (to <= start) continue;
    out += text.slice(at, start) + text.slice(start, to).replace(/[^\n]/g, " ");
    at = to;
  }
  return out + text.slice(at);
}

/** A note's names (longest first) as whole words, ignoring case. */
export function mentionRegex(names: string[], flags = "iu"): RegExp {
  const needles = names.map((n) => n.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${needles.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}_])`, flags);
}

/** Wrap the FIRST bare, word-bounded occurrence of `name` on `line` in a link.
 * Occurrences inside inline code, URLs, tags or existing links are skipped
 * (masked out first). `linkText` is what the link should point at (the bare
 * name, or a folder path when the name alone would resolve elsewhere); when it
 * differs from the matched text the result is `[[linkText|text]]`, as Obsidian
 * writes it. Returns the new line, or null if there's no mention. */
export function linkifyMention(line: string, names: string | string[], linkText?: string, masked = maskForMentions(line)): string | null {
  const list = Array.isArray(names) ? names : [names];
  if (!list.some((n) => n.trim())) return null;
  // Matched in the masked copy, spliced into the original by the same offset.
  const m = mentionRegex(list).exec(masked);
  if (!m) return null;
  const start = m.index;
  const end = start + m[0].length;
  const surface = line.slice(start, end); // preserve the original casing
  // Resolution ignores case, so only a different target needs the alias form.
  const same = !linkText || linkText.toLowerCase() === surface.toLowerCase();
  const link = same ? `[[${surface}]]` : `[[${linkText}|${surface}]]`;
  return `${line.slice(0, start)}${link}${line.slice(end)}`;
}
