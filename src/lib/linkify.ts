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
// A definition's start, wherever its address and title are: its label, and
// what follows the colon on its line.
const DEF_HEAD_RE = /^[ \t>]*((?:[-*+]|\d{1,9}[.)])[ \t]+)?\[(?!\^)([^\]\n]+)\]:[ \t]*(.*?)[ \t\r]*$/;
const DEF_DEST_RE = /^(?:<[^<>\n]*>|[^\s<]\S*)/;
const DEF_TITLE_RE = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))$/;
// A reference link or image, `[text][label]`, `![alt][label]` or `[label][]`.
const REF_LINK_RE = /!?\[[^\][\n]*\]\[[^\][\n]*\]/g;
// A shortcut reference link, `[label]`, a link only when the note defines it.
const SHORTCUT_RE = /!?\[([^\][\n]+)\]/g;
// A callout's type, a footnote reference and an email address. Run after the
// links and URLs are masked, so a linked image's `[![` isn't read as a callout.
const OTHER_RE = /\[![^\]\n]*\]|\[\^[^\]\n]+\]|(?<![\w.-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** A reference label as links match it: case and runs of spaces ignored. */
const label = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/** `line` with what can't hold a linkable mention (inline code and math, HTML
 * tags, autolinks, links and reference links, URLs, tags, callout types,
 * footnotes, references, emails) blanked to spaces, same length, so offsets
 * still match the line. `refs` are the labels the note defines. */
export function maskForMentions(line: string, refs: ReadonlySet<string> = new Set()): string {
  return maskRest(blankLinks(maskCode(line, true), refs), refs);
}

/** `line` with code, math, HTML and wikilinks blanked, and a definition when
 * `defs`: what can hold brackets that aren't a link's. */
function maskCode(line: string, defs: boolean): string {
  if (defs && REF_DEF_RE.test(line)) return " ".repeat(line.length);
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

// The quote marks a line starts with, each at most three spaces in.
const QUOTE_RE = /^(?: {0,3}>[ \t]?)*/;
const quotes = (line: string) => (QUOTE_RE.exec(line)![0].match(/>/g) ?? []).length;
// A line that ends a paragraph: blank, a heading or a thematic break.
const ENDS_RE = /^[ \t>]*(?:\r?$|#{1,6}(?:[ \t]|\r?$)|([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$)/;
// A heading's `===` underline, which ends a paragraph in its own quote.
const UNDERLINE_RE = /^[ \t>]*=+[ \t]*\r?$/;
const HEADING_RE = /^[ \t>]*#{1,6}(?:[ \t]|\r?$)/;
const BULLET_RE = /^[ \t>]*[-*+](?:[ \t]|\r?$)/;
const NUMBERED_RE = /^[ \t>]*(\d{1,9})[.)](?:[ \t]|\r?$)/;
// A table row that starts with a pipe, and the delimiter row under a header.
const ROW_RE = /^[ \t>]*\|/;
const DELIM_RE = /^[ \t>]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*\r?$/;
// Spaces with at most one line break, and the quote marks after it.
const SPACE_RE = /[ \t]*(?:\r?\n[ \t>]*)?/y;
// A link's title, if any, on at most two lines, and the `)` that ends the link.
const TITLE_RE =
  /(?:"(?:[^"\\\n]|\\.)*(?:\n(?:[^"\\\n]|\\.)*)?"|'(?:[^'\\\n]|\\.)*(?:\n(?:[^'\\\n]|\\.)*)?'|\((?:[^()\\\n]|\\.)*(?:\n(?:[^()\\\n]|\\.)*)?\))?[ \t]*(?:\r?\n[ \t>]*)?\)/y;
// A reference link's label, after its text.
const LABEL_RE = /\[[^[\]\n]*\]/y;
// Characters a backslash escapes.
const PUNCT_RE = /[!-/:-@[-`{-~]/;

/** Whether a paragraph holding `line` ends before `next`. `quoted` and
 * `ordered` describe the line the paragraph's open bracket is on. */
function endsBefore(line: string, next: string, quoted: number, ordered: boolean): boolean {
  if (HEADING_RE.test(line) || ENDS_RE.test(next) || BULLET_RE.test(next)) return true;
  if (UNDERLINE_RE.test(next) && quotes(next) === quoted) return true;
  const n = NUMBERED_RE.exec(next);
  if (n && (parseInt(n[1], 10) === 1 || ordered)) return true;
  if (ROW_RE.test(line) && (ROW_RE.test(next) || DELIM_RE.test(next))) return true;
  if (DELIM_RE.test(next) && line.includes("|")) return true;
  return quotes(next) > quoted;
}

/** `text` with each inline link and image blanked, however deep the brackets
 * in its text or the parentheses in its address go, and whichever lines its
 * text, address or title run onto, along with each `[text][label]`. A `](`
 * with no `[` before it in its paragraph ends a link whose text began above.
 * `shape` is the same text with its code not yet blanked, to read the lines,
 * and a line `prose` says isn't reads as blank. */
function blankLinks(text: string, refs: ReadonlySet<string>, shape = text, prose?: boolean[]): string {
  const open: number[] = [];
  const links: [number, number][] = [];
  const marks = /[\\\n[\]]/g;
  let lineStart = 0;
  let lineNo = 0;
  let quoted = 0;
  let ordered = false;
  for (let m; (m = marks.exec(text)); ) {
    const j = m.index;
    if (text[j] === "\\") {
      if (PUNCT_RE.test(text[j + 1] ?? "")) marks.lastIndex = j + 2;
    } else if (text[j] === "\n") {
      if (open.length) {
        // A bracket left open ends with its paragraph.
        const nextEnd = shape.indexOf("\n", j + 1);
        const next = prose && !prose[lineNo + 1] ? "" : shape.slice(j + 1, nextEnd < 0 ? shape.length : nextEnd);
        if (endsBefore(shape.slice(lineStart, j), next, quoted, ordered)) open.length = 0;
      }
      lineStart = j + 1;
      lineNo++;
    } else if (text[j] === "[") {
      if (!open.length) {
        const lineEnd = shape.indexOf("\n", j);
        const line = shape.slice(lineStart, lineEnd < 0 ? shape.length : lineEnd);
        quoted = quotes(line);
        ordered = NUMBERED_RE.test(line);
      }
      open.push(j);
    } else {
      const i = open.pop() ?? j;
      let end = -1;
      if (text[j + 1] === "(") end = addressEnd(text, j + 2);
      else if (i < j && text[j + 1] === "[") {
        LABEL_RE.lastIndex = j + 1;
        if (LABEL_RE.test(text)) {
          const after = LABEL_RE.lastIndex;
          const name = text.slice(j + 2, after - 1);
          // `[x][y](z)` with no `y` defined is text and then the link `[y](z)`.
          if (text[after] !== "(" || (name.trim() !== "" && refs.has(label(name)))) end = after;
        }
      } else if (i < j && refs.size && j - i <= 1000 && refs.has(label(text.slice(i + 1, j).replace(/\r?\n[ \t>]*/g, " ")))) end = j + 1;
      if (end < 0) continue;
      links.push([text[i - 1] === "!" ? i - 1 : i, end]);
      marks.lastIndex = end;
      const span = text.slice(j, end);
      for (let k = span.indexOf("\n"); k >= 0; k = span.indexOf("\n", k + 1)) {
        lineStart = j + k + 1;
        lineNo++;
      }
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

/** The definition starting on line `k`, if one does: its label, whether a
 * list item holds it, and its last line (its address or title may sit on the
 * next one, and its title may run onto it). */
function definitionAt(lines: string[], k: number): { label: string; item: boolean; end: number } | null {
  const m = DEF_HEAD_RE.exec(lines[k]);
  if (!m) return null;
  const nextLine = (n: number) => (n < lines.length ? lines[n].replace(QUOTE_RE, "").trim() : null);
  let end = k;
  let rest = m[3];
  if (!rest) {
    const next = nextLine(k + 1);
    if (!next) return null;
    end = k + 1;
    rest = next;
  }
  const dest = DEF_DEST_RE.exec(rest);
  if (!dest) return null;
  const def = { label: label(m[2]), item: !!m[1], end };
  const title = rest.slice(dest[0].length).trim();
  if (!title) {
    const next = nextLine(end + 1);
    if (next && DEF_TITLE_RE.test(next)) def.end = end + 1;
    return def;
  }
  if (!/^[ \t]/.test(rest.slice(dest[0].length))) return null;
  if (DEF_TITLE_RE.test(title)) return def;
  const next = nextLine(end + 1);
  if (next === null || !DEF_TITLE_RE.test(`${title}\n${next}`)) return null;
  def.end = end + 1;
  return def;
}

/** The labels a note defines and the lines its definitions take, from
 * `lines` with what isn't prose blanked. A definition can't break into a
 * paragraph, though a list item or a quote that starts there can hold one. */
function definitions(lines: string[]): { labels: Set<string>; taken: Set<number> } {
  const labels = new Set<string>();
  const taken = new Set<number>();
  let para = -1; // the quote depth of the paragraph the line before is in, if any
  for (let k = 0; k < lines.length; k++) {
    const depth = quotes(lines[k]);
    const def = lines[k].includes("]:") ? definitionAt(lines, k) : null;
    if (def && (def.item || para < 0 || depth > para)) {
      labels.add(def.label);
      for (let n = k; n <= def.end; n++) taken.add(n);
      k = def.end;
      para = -1;
    } else para = ENDS_RE.test(lines[k]) || UNDERLINE_RE.test(lines[k]) ? -1 : depth;
  }
  return { labels, taken };
}

/** Each line of a note as `maskForMentions` leaves it, with what spans lines
 * blanked too: frontmatter, fenced and indented code, `%%comments%%`, `$$`
 * math and HTML comments. What's left is where a mention can be linked. */
export function mentionLines(content: string, indented = true): string[] {
  const lines = content.split("\n");
  const prose = proseMask(lines);
  const shape = blank(content, hiddenSpans(content, indented, lines, prose));
  const text = shape.split("\n").map((l, i) => (prose[i] ? l : " ".repeat(l.length)));
  const { labels: refs, taken } = content.includes("]:") ? definitions(text) : { labels: new Set<string>(), taken: new Set<number>() };
  const code = text.map((l, i) => (!prose[i] ? l : taken.has(i) ? " ".repeat(l.length) : maskCode(l, false)));
  // Links are found across lines: a link's text, address or title may run on.
  return blankLinks(code.join("\n"), refs, shape, prose)
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
