// Convert an UNLINKED mention (a bare occurrence of a note's name) into a
// `[[wikilink]]`, matching Obsidian's "Link"/"Link all" backlink actions. Pure
// + length-preserving masking so we splice into the ORIGINAL line by offset,
// never touching a mention that sits inside inline code or an existing link.
import { mdLinkRegexGlobal, tagRegex, proseMask, TAG_NAME } from "./markdown";
import { commentRanges, INDENTED_RE, mayIndent, mayRunHtml, rawRanges, renderMarkdown } from "./render";

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
// An autolink, `<scheme:...>` or `<user@host>`, as the editor's parser reads one.
const AUTOLINK_RE =
  /<(?:[a-z][-\w+.]+:[^\s>]+|[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*)>/gi;
// A definition's start, wherever its address and title are: its label (not a
// footnote's, and no bracket in it but an escaped one), after any quote marks
// and list markers, and what follows the colon on its line.
const DEF_HEAD_RE = /^((?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*)[ \t]*\[(?!\^)((?:[^[\]\\\n]|\\.)+)\]:([^\n]*)$/;
// The same over lines (a label may run over line breaks), and a label a line
// opens and doesn't close.
const DEF_HEAD_LINES_RE = /^((?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*)[ \t]*\[(?!\^)((?:[^[\]\\]|\\.)+)\]:([^\n]*)$/;
const LABEL_OPEN_RE = /^((?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*)[ \t]*\[(?!\^)(?:[^[\]\\\n]|\\.)*$/;
const DEF_TITLE_RE = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\))$/;

/** Where an address starting at `at` in `s` ends, as the editor's parser reads
 * one, or -1: in angle brackets, or up to a space or a `)` it didn't open (an
 * unclosed `(` is fine). */
function destEnd(s: string, at: number): number {
  if (s[at] === "<") {
    for (let p = at + 1; p < s.length; p++) {
      if (s[p] === ">") return p + 1;
      if (s[p] === "<" || s[p] === "\n") return -1;
    }
    return -1;
  }
  let depth = 0;
  let p = at;
  for (let escaped = false; p < s.length; p++) {
    const c = s[p];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") break;
    if (escaped) escaped = false;
    else if (c === "(") depth++;
    else if (c === ")") {
      if (!depth) break;
      depth--;
    } else if (c === "\\") escaped = true;
  }
  return p > at ? p : -1;
}

/** Whether `line` is a whole definition: label, address and maybe a title. */
function isDefinition(line: string): boolean {
  const m = DEF_HEAD_RE.exec(line.trimEnd());
  if (!m) return false;
  const rest = m[3].replace(/^[ \t]*/, "");
  const end = destEnd(rest, 0);
  if (end < 0) return false;
  const after = rest.slice(end);
  return !after || (/^[ \t]/.test(after) && DEF_TITLE_RE.test(after.trim()));
}
// A reference link or image, `[text][label]`, `![alt][label]` or `[label][]`.
const REF_LINK_RE = /!?\[[^\][\n]*\]\[[^\][\n]*\]/g;
// A shortcut reference link, `[label]`, a link only when the note defines it.
const SHORTCUT_RE = /!?\[([^\][\n]+)\]/g;
// A callout's type, a footnote reference and an email address. Run after the
// links and URLs are masked, so a linked image's `[![` isn't read as a callout.
const OTHER_RE = /\[![^\]\n]*\]|\[\^[^\]\n]+\]|(?<![\w.-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// A word right after `!`, a backslash or `[` (not an escaped one), where a link
// would turn into an embed, lose its first bracket or take that bracket into
// its name.
const AFTER_MARK_RE = /(?:[!\\]|(?<!\\)\[)[\p{L}\p{N}_]+/gu;
// Tags, for blanking (a shared global is safe in `replace`), and one starting a
// table cell.
const TAG_RE = tagRegex();
const CELL_TAG_RE = new RegExp(`(?<=\\|[ \\t]*)#${TAG_NAME}`, "gu");

/** A reference label as links match it: case and runs of spaces ignored. */
const label = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/** `line` with what can't hold a linkable mention (inline code and math, HTML
 * tags, autolinks, links and reference links, URLs, tags, callout types,
 * footnotes, references, emails) blanked to spaces, same length, so offsets
 * still match the line. `refs` are the labels the note defines. */
export function maskForMentions(line: string, refs: ReadonlySet<string> = new Set()): string {
  const code = maskCode(line);
  return cutUnclosed(maskRest(blankLinks(code, refs), refs), unclosedAt(code));
}

/** Where the first `[[` on `line` that no `]]` after it closes is, or -1: a
 * link written after it would close it, so nothing from there can be linked. */
function unclosedAt(line: string): number {
  if (!line.includes("[[")) return -1;
  const last = line.lastIndexOf("]]");
  let at = line.indexOf("[[", last < 0 ? 0 : last - 1);
  while (at > 0 && escapedAt(line, at)) at = line.indexOf("[[", at + 1); // an escaped one opens nothing
  return at;
}

/** Whether the character at `i` in `s` is escaped: an odd run of backslashes
 * before it. */
function escapedAt(s: string, i: number): boolean {
  let n = 0;
  while (s[i - 1 - n] === "\\") n++;
  return n % 2 === 1;
}

/** `line` blanked from `at` on (if `at` isn't -1). */
const cutUnclosed = (line: string, at: number) => (at < 0 ? line : line.slice(0, at) + " ".repeat(line.length - at));

/** `line` with definitions, code, math, HTML and wikilinks blanked: what can
 * hold brackets that aren't a link's. `spans` false leaves code spans and
 * definitions to the caller, which finds them over the whole note. */
function maskCode(line: string, spans = true): string {
  if (spans && isDefinition(line)) return " ".repeat(line.length);
  return (spans ? line.replace(INLINE_CODE_RE, (m) => " ".repeat(m.length)) : line)
    .replace(INLINE_MATH_RE, (m) => " ".repeat(m.length))
    .replace(AUTOLINK_RE, (m) => " ".repeat(m.length))
    .replace(HTML_TAG_RE, (m) => " ".repeat(m.length))
    .replace(/\[\[[^\n]*/g, (m, at: number) => blankWikilinks(m, line.slice(0, at)));
}

/** `text` (from a `[[`) with each `[[` to the first `]]` after it blanked, as
 * Reading view reads a wikilink, brackets and all. One nothing closes is left
 * (see `unclosedAt`). */
function blankWikilinks(text: string, before = ""): string {
  let out = "";
  let at = 0;
  for (let i = text.indexOf("[["); i >= 0; ) {
    if (escapedAt(before + text, before.length + i)) {
      i = text.indexOf("[[", i + 1);
      continue;
    }
    const end = text.indexOf("]]", i + 2);
    if (end < 0) return out + text.slice(at);
    if (!text.slice(i + 2, end).trim()) {
      i = text.indexOf("[[", i + 1);
      continue;
    }
    out += text.slice(at, i) + " ".repeat(end + 2 - i);
    at = end + 2;
    i = text.indexOf("[[", at);
  }
  return out + text.slice(at);
}

/** `line`, its inline links already blanked, with the rest blanked too. */
function maskRest(line: string, refs: ReadonlySet<string>, written = line): string {
  // Tags as the line reads before its code and links are blanked: a `#` after
  // a code span or a link isn't a tag's.
  let tagged = line;
  if (written.includes("#")) for (const m of [...written.matchAll(TAG_RE), ...(written.includes("|#") ? written.matchAll(CELL_TAG_RE) : [])]) tagged = tagged.slice(0, m.index) + " ".repeat(m[0].length) + tagged.slice(m.index! + m[0].length);
  return tagged
    .replace(mdLinkRegexGlobal(), (m) => " ".repeat(m.length))
    .replace(REF_LINK_RE, (m) => " ".repeat(m.length))
    .replace(SHORTCUT_RE, (m, text: string) => (refs.has(label(text)) ? " ".repeat(m.length) : m))
    .replace(URL_RE, (m) => " ".repeat(m.length))
    .replace(OTHER_RE, (m) => " ".repeat(m.length))
    .replace(AFTER_MARK_RE, (m) => m[0] + " ".repeat(m.length - 1));
}

// The quote marks a line starts with, each at most three spaces in.
const QUOTE_RE = /^(?: {0,3}>[ \t]?)*/;
const quotes = (line: string) => (QUOTE_RE.exec(line)![0].match(/>/g) ?? []).length;
// A line that ends a paragraph: blank, a heading or a thematic break.
const ENDS_RE = /^[ \t>]*(?:\r?$|#{1,6}(?:[ \t]|\r?$)|([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$)/;
// A heading's underline, which ends a paragraph in its own quote.
const UNDERLINE_RE = /^[ \t>]*(?:=+|-+)[ \t]*\r?$/;
// A heading or a thematic break inside a list item, which isn't a paragraph.
const ITEM_BLOCK_RE = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)+(?:#{1,6}(?:[ \t]|\r?$)|([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$)/;
// A table's delimiter row, read with its quote marks and spaces trimmed.
const DELIM_RE = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/;
const isDelim = (line: string) => line.includes("-") && DELIM_RE.test(line.replace(QUOTE_RE, "").trim());
const cells = (line: string) => line.replace(QUOTE_RE, "").trim().replace(/^\||(?<!\\)\|$/g, "").split(/(?<!\\)\|/).length;
const isRow = (line: string) => /^[ \t>]*\|/.test(line);
// Spaces with at most one line break, and the quote marks after it.
const SPACE_RE = /[ \t]*(?:\r?\n[ \t>]*)?/y;
// A link's title, if any, on up to ten lines, and the `)` that ends the link.
const TITLE_RE =
  /(?:"(?:[^"\\\n]|\\.)*(?:\n(?:[^"\\\n]|\\.)*){0,9}"|'(?:[^'\\\n]|\\.)*(?:\n(?:[^'\\\n]|\\.)*){0,9}'|\((?:[^()\\\n]|\\.)*(?:\n(?:[^()\\\n]|\\.)*){0,9}\))?[ \t]*(?:\r?\n[ \t>]*)?\)/y;
// A reference link's label, after its text: up to 999 characters, a bracket in
// it escaped, over line breaks but not a blank line.
const LABEL_RE = /\[(?:[^[\]\\\n]|\\[^\n]|\n(?![ \t>]*\n)){0,999}\]/y;
// Characters a backslash escapes.
const PUNCT_RE = /[!-/:-@[-`{-~]/;

/** What the line an open bracket is on says about its paragraph: its quote
 * depth, whether an ordered list holds it, and how far in it is. */
interface Para {
  quoted: number;
  ordered: boolean;
  indent: number;
}

/** A line's indent in columns past its quote marks (a tab to the next stop of
 * four), and what follows it. */
function lead(line: string): { cols: number; rest: string } {
  const body = line.slice(QUOTE_RE.exec(line)![0].length);
  let cols = 0;
  let k = 0;
  for (; k < body.length; k++) {
    if (body[k] === " ") cols++;
    else if (body[k] === "\t") cols += 4 - (cols % 4);
    else break;
  }
  return { cols, rest: body.slice(k) };
}
// After a line's indent: a list marker before text, a heading, a thematic
// break and a heading's underline.
const ITEM_MARK_RE = /^([-*+]|\d{1,9}[.)])([ \t]+)(?=\S)/;
const HEAD_RE = /^#{1,6}(?: |\r?$)/; // not a tab: the editor's parser reads `#\t` as text
const BREAK_RE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$/;
const SETEXT_RE = /^(?:=+|-+)[ \t]*\r?$/;

/** The paragraph `line` is in, as far as the line shows (`above` is the text
 * before it): its quote depth, the column its text starts at, and whether an
 * ordered list holds it. A numbered line starts one only from 1, at a block's
 * start, or under another numbered line; otherwise it carries on a paragraph. */
function paraOf(line: string, above: () => string[]): Para {
  const { cols, rest } = lead(line);
  const item = ITEM_MARK_RE.exec(rest);
  let indent = cols;
  let ordered = false;
  if (item) {
    let col = cols + item[1].length;
    const from = col;
    for (let g = 0; g < item[2].length; g++) col += item[2][g] === "\t" ? 4 - (col % 4) : 1;
    indent = from + (col - from > 4 ? 1 : col - from);
    if (/\d/.test(item[1])) {
      const prev = above().at(-1);
      ordered =
        parseInt(item[1], 10) === 1 ||
        prev === undefined ||
        /^[ \t>]*$/.test(prev) ||
        HEAD_RE.test(lead(prev).rest) ||
        /^\d{1,9}[.)][ \t]/.test(lead(prev).rest);
    }
  }
  return { quoted: quotes(line), ordered, indent };
}

/** Whether a paragraph holding `line` (`above` is the text before it) ends
 * before `next`: at a blank line, after a heading, or where `next` starts a
 * block, no more than three columns past the paragraph's text. */
function endsBefore(line: string, next: string, para: Para, above: () => string[]): boolean {
  if (/^[ \t>]*\r?$/.test(next)) return true;
  const l = lead(line);
  if (l.cols <= para.indent + 3 && HEAD_RE.test(l.rest)) return true;
  const n = lead(next);
  if (n.cols <= para.indent + 3) {
    if (HEAD_RE.test(n.rest) || BREAK_RE.test(n.rest)) return true;
    if (SETEXT_RE.test(n.rest) && quotes(next) === para.quoted) return true;
    const item = ITEM_MARK_RE.exec(n.rest);
    if (item && (!/\d/.test(item[1]) || parseInt(item[1], 10) === 1 || para.ordered)) return true;
  }
  // A table: a header over a delimiter row with as many cells, and its rows.
  if (isDelim(next) && line.includes("|") && cells(next) === cells(line)) return true;
  if (isRow(line) && isRow(next) && inTable(line, above())) return true;
  return quotes(next) > para.quoted;
}

/** The paragraph each of `lines` is in, read from the paragraph's first line:
 * up from a line (fifty lines at most) to a blank line or a line whose
 * paragraph ends after it. Remembered, so a run of lines costs one walk. */
function paragraphs(lines: string[]): (k: number) => Para {
  const above = (n: number) => () => lines.slice(Math.max(0, n - 200), n);
  const firstOf = new Map<number, number>();
  return (k) => {
    let first = k;
    while (first > 0 && k - first < 50) {
      const known = firstOf.get(first - 1);
      const prev = lines[first - 1];
      if (endsBefore(prev, lines[first], paraOf(prev, above(first - 1)), above(first - 1))) break;
      if (known !== undefined) {
        first = Math.max(known, k - 50);
        break;
      }
      first--;
    }
    firstOf.set(k, first);
    return paraOf(lines[first], above(first));
  };
}

/** Whether `line`, a row, is in a table: the rows above it reach a header and
 * its delimiter row. */
function inTable(line: string, above: string[]): boolean {
  const rows = [line];
  for (let k = above.length - 1; k >= 0 && rows.length < 200 && isRow(above[k]); k--) rows.unshift(above[k]);
  return rows.some((r, k) => k > 0 && isDelim(r) && cells(r) === cells(rows[k - 1]));
}

/** A raw address scan that ran to its end without closing: from where, to
 * where, and the bracket depth after each character, so a later scan inside
 * it can tell at once that it won't close either. */
interface DeadScan {
  from: number;
  to: number;
  depth: Int32Array;
  minAfter: Int32Array;
}

/** `text` with each inline link and image blanked, however deep the brackets
 * in its text or the parentheses in its address go, and whichever lines its
 * text, address or title run onto, along with each `[text][label]`. A `](`
 * with no `[` before it in its paragraph ends a link whose text began above.
 * `shape` is the same text with its code not yet blanked, to read the lines,
 * and a line `prose` says isn't reads as blank. */
function blankLinks(text: string, refs: ReadonlySet<string>, shape = text, prose?: boolean[], paraAt?: (k: number) => Para): string {
  const open: number[] = [];
  const links: [number, number][] = [];
  // Line breaks matter only while a bracket is open; otherwise lines are counted when needed.
  const marks = /[\\\n[\]]/g;
  const brackets = /[\\[\]]/g;
  let lineStart = 0;
  let lineNo = 0;
  let nextBreak = text.indexOf("\n"); // the first line break not yet counted
  const countTo = (j: number) => {
    for (; nextBreak !== -1 && nextBreak < j; nextBreak = text.indexOf("\n", nextBreak + 1)) (lineStart = nextBreak + 1), lineNo++;
  };
  let pos = 0;
  let para: Para = { quoted: 0, ordered: false, indent: 0 };
  let paraLine = -1; // the line `para` describes
  const dead: { scan: DeadScan | null } = { scan: null };
  const lineAt = (from: number) => {
    const end = shape.indexOf("\n", from);
    return shape.slice(from, end < 0 ? shape.length : end);
  };
  const above = () => shape.slice(Math.max(0, lineStart - 20000), Math.max(0, lineStart - 1)).split("\n");
  for (;;) {
    const re = open.length ? marks : brackets;
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) break;
    const j = m.index;
    pos = j + 1;
    if (text[j] === "\\") {
      if (PUNCT_RE.test(text[j + 1] ?? "")) pos = j + 2;
    } else if (text[j] === "\n") {
      // A bracket left open ends with its paragraph.
      countTo(j);
      const next = prose && !prose[lineNo + 1] ? "" : lineAt(j + 1);
      if (endsBefore(shape.slice(lineStart, j), next, para, above)) open.length = 0;
    } else if (text[j] === "[") {
      countTo(j);
      if (!open.length && paraLine !== lineNo) {
        para = paraAt ? paraAt(lineNo) : paraOf(lineAt(lineStart), above);
        paraLine = lineNo;
      }
      open.push(j);
    } else {
      const i = open.pop() ?? j;
      let end = -1;
      // An address or a label is read as written, over any code in it, as the
      // editor's parser reads them.
      if (text[j + 1] === "(") end = addressEnd(shape, j + 2, dead);
      else if (i < j && text[j + 1] === "[") {
        // `[text][label]`, and any address after it: left whole either way.
        LABEL_RE.lastIndex = j + 1;
        if (LABEL_RE.test(shape)) {
          end = LABEL_RE.lastIndex;
          if (shape[end] === "(") end = Math.max(end, addressEnd(shape, end + 1, dead));
        }
      } else if (i < j && refs.size && j - i <= 1000 && refs.has(label(text.slice(i + 1, j).replace(/\r?\n[ \t>]*/g, " ")))) end = j + 1;
      if (end < 0) continue;
      links.push([text[i - 1] === "!" ? i - 1 : i, end]);
      pos = end;
    }
  }
  return blank(text, links);
}

/** Where a link's `(address "title")` ends, from where its address starts,
 * or -1 if it isn't one. An address in angle brackets may hold a `)`. */
function addressEnd(text: string, at: number, dead: { scan: DeadScan | null }): number {
  SPACE_RE.lastIndex = at;
  let j = at + SPACE_RE.exec(text)![0].length;
  if (text[j] === "<") {
    for (j++; text[j] !== ">"; j++) {
      if (j >= text.length || text[j] === "<" || text[j] === "\n") return -1;
      if (text[j] === "\\" && PUNCT_RE.test(text[j + 1] ?? "")) j++;
    }
    j++;
  } else {
    // Inside an earlier scan that never closed, this one won't either if no
    // `)` after here dips below the depth it starts at.
    const d = dead.scan;
    if (d && j > d.from && j < d.to && d.minAfter[j - d.from] >= d.depth[j - d.from - 1]) j = d.to;
    else {
      const from = j;
      const depths: number[] = [];
      let depth = 0;
      for (; j < text.length && !/\s/.test(text[j]); j++) {
        if (text[j] === "\\" && PUNCT_RE.test(text[j + 1] ?? "")) (depths.push(depth), j++);
        else if (text[j] === "(") depth++;
        else if (text[j] === ")" && depth-- === 0) return j + 1;
        depths.push(depth);
      }
      const depthAt = Int32Array.from(depths);
      const minAfter = new Int32Array(depthAt.length + 1).fill(2 ** 30);
      for (let k = depthAt.length - 1; k >= 0; k--) minAfter[k] = Math.min(depthAt[k], minAfter[k + 1]);
      dead.scan = { from, to: j, depth: depthAt, minAfter };
    }
  }
  SPACE_RE.lastIndex = j;
  TITLE_RE.lastIndex = j + SPACE_RE.exec(text)![0].length;
  return TITLE_RE.test(text) ? TITLE_RE.lastIndex : -1;
}

/** The definition starting on line `k`, if one does: its label, whether a
 * list item holds it, and its last line (its label may run over up to ten
 * lines, its address sit on the next line, and its title on the line after or
 * over up to ten). */
function definitionAt(lines: string[], k: number): { label: string; item: boolean; end: number } | null {
  let m = DEF_HEAD_RE.exec(lines[k]);
  let head = k; // the line the label closes on
  if (!m && LABEL_OPEN_RE.test(lines[k])) {
    let joined = lines[k];
    for (let n = k + 1; n < lines.length && n - k <= 10 && joined.length < 1000 && !/^[ \t>]*$/.test(lines[n]); n++) {
      joined += "\n" + lines[n].replace(QUOTE_RE, "");
      m = DEF_HEAD_LINES_RE.exec(joined);
      if (m || /(?<!\\)\]/.test(lines[n])) {
        head = n;
        break;
      }
    }
  }
  if (!m || !m[2].trim()) return null;
  const lineAfter = (n: number) => (n < lines.length ? lines[n].replace(QUOTE_RE, "").trim() : null);
  let end = head;
  let rest = m[3].trim();
  if (!rest) {
    const next = lineAfter(head + 1);
    if (!next) return null;
    end = head + 1;
    rest = next;
  }
  const dest = destEnd(rest, 0);
  if (dest < 0) return null;
  const def = { label: label(m[2]), item: /[-*+\d]/.test(m[1]), end };
  let title = rest.slice(dest).trim();
  if (title && !/^[ \t]/.test(rest.slice(dest))) return null;
  if (!title) {
    const next = lineAfter(end + 1);
    if (!next || !/^["'(]/.test(next)) return def;
    title = next;
    end += 1;
  }
  for (let n = end; n - def.end <= 10; n++) {
    if (DEF_TITLE_RE.test(title)) return { ...def, end: n };
    const next = lineAfter(n + 1);
    if (!next) break;
    title += "\n" + next;
  }
  return rest.slice(dest).trim() ? null : def;
}

/** Whether `line` is paragraph text a definition can't break into (unless a
 * table holds it). */
const isParagraph = (line: string) => !ENDS_RE.test(line) && !UNDERLINE_RE.test(line) && !ITEM_BLOCK_RE.test(line);

/** The labels a note defines and the lines its definitions take, from
 * `lines` with what isn't prose blanked (`written` are the lines as the note
 * has them). A definition can't break into a paragraph, though a list item or
 * a quote that starts there can hold one. */
function definitions(lines: string[], written = lines): { labels: Set<string>; taken: Set<number> } {
  const labels = new Set<string>();
  const taken = new Set<number>();
  let para = -1; // the quote depth of the paragraph the line before is in, if any
  let table = false; // whether a table holds the line
  for (let k = 0; k < lines.length; k++) {
    const depth = quotes(lines[k]);
    // A table starts at a header over a delimiter row with as many cells, and
    // runs while its lines have a `|`.
    if (!lines[k].includes("|")) table = false;
    else if (!table && isDelim(lines[k + 1] ?? "") && cells(lines[k + 1]) === cells(lines[k])) table = true;
    // What a definition starts after has to be the note's own text, not a
    // comment, tag or the like blanked to spaces.
    const open = lines[k].indexOf("[");
    const def = open >= 0 && lines[k].slice(0, open) === written[k].slice(0, open) ? definitionAt(lines, k) : null;
    if (def && (def.item || para < 0 || depth > para)) {
      labels.add(def.label);
      for (let n = k; n <= def.end; n++) taken.add(n);
      k = def.end;
      para = -1;
    } else para = !table && isParagraph(lines[k]) ? depth : -1;
  }
  return { labels, taken };
}

/** `code`, a note's lines, with their code spans blanked, as CommonMark pairs
 * them: in order, each backtick run (not an escaped one) with the next run of
 * the same length in its paragraph, which may be lines on. `lines` are the
 * lines as written, to tell where a paragraph ends, `content` the note (to find
 * the backticks fast) and `skip` lines that hold none. */
function blankCodeAcross(code: string[], lines: string[], content: string, skip: ReadonlySet<number>, paraAt: (k: number) => Para): string[] {
  const runs: { line: number; at: number; len: number }[] = [];
  let line = 0;
  let start = 0; // where `line` starts in `content`
  for (let pos = content.indexOf("`"); pos !== -1; ) {
    while (start + code[line].length < pos) (start += code[line].length + 1), line++;
    const l = code[line];
    const at = pos - start;
    if (skip.has(line) || l[at] !== "`") {
      pos = content.indexOf("`", pos + 1);
      continue;
    }
    let end = at + 1;
    while (l.charCodeAt(end) === 96) end++;
    runs.push({ line, at, len: end - at });
    pos = content.indexOf("`", start + end);
  }
  if (!runs.length) return code;
  // Each length's runs in order, for the next run of a length after another.
  const byLen = new Map<number, number[]>();
  runs.forEach((r, k) => {
    const list = byLen.get(r.len);
    if (list) list.push(k);
    else byLen.set(r.len, [k]);
  });
  const nextOf = (len: number, after: number) => {
    const list = byLen.get(len) ?? [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] <= after) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length ? list[lo] : -1;
  };
  // From each line a run opens on: its paragraph, how far it was read, and the
  // line it ends on if that was found.
  const read = new Map<number, { para: Para; to: number; end: number }>();
  const endsBetween = (from: number, to: number) => {
    let r = read.get(from);
    if (!r) {
      r = { para: paraAt(from), to: from, end: -1 };
      read.set(from, r);
    }
    for (; r.end < 0 && r.to < to; r.to++) {
      const k = r.to;
      if (endsBefore(lines[k], lines[k + 1] ?? "", r.para, () => lines.slice(Math.max(0, k - 200), k))) r.end = k;
    }
    return r.end >= 0 && r.end < to;
  };
  let out = code;
  const blankOut = (n: number, from: number, to: number) => {
    if (out === code) out = [...code];
    out[n] = out[n].slice(0, from) + " ".repeat(to - from) + out[n].slice(to);
  };
  // A run after a backslash: CommonMark opens a span with the backticks the
  // escape leaves, the editor's parser with none of them. Either may be how the
  // note is shown, so both pairings are blanked.
  const escaped = runs.map((r) => {
    let slashes = 0;
    while (code[r.line][r.at - 1 - slashes] === "\\") slashes++;
    return slashes % 2;
  });
  const pair = (strict: boolean) => {
    for (let i = 0; i < runs.length; ) {
      const r = runs[i];
      const esc = escaped[i];
      const j = r.len > esc && !(strict && esc) ? nextOf(r.len - esc, i) : -1;
      const c = runs[j];
      if (j >= 0 && (c.line === r.line || !endsBetween(r.line, c.line))) {
        if (c.line === r.line) blankOut(r.line, r.at + esc, c.at + c.len);
        else {
          blankOut(r.line, r.at + esc, code[r.line].length);
          for (let n = r.line + 1; n < c.line; n++) blankOut(n, 0, code[n].length);
          blankOut(c.line, 0, c.at + c.len);
        }
        i = j + 1;
      } else i++;
    }
  };
  pair(false);
  if (escaped.includes(1)) pair(true);
  return out;
}

/** Each line of a note as `maskForMentions` leaves it, with what spans lines
 * blanked too: frontmatter, fenced and indented code, `%%comments%%`, `$$`
 * math and HTML comments. What's left is where a mention can be linked. */
export function mentionLines(content: string, indented = true, html = true): string[] {
  const lines = content.split("\n");
  const prose = proseMask(lines);
  const shape = blank(content, hiddenSpans(content, indented, lines, prose, html));
  const text = shape.split("\n").map((l, i) => (prose[i] ? l : " ".repeat(l.length)));
  const { labels: refs, taken } = content.includes("]:") ? definitions(text, lines) : { labels: new Set<string>(), taken: new Set<number>() };
  // Code spans and links are found across lines: either may run on. Code
  // first, as a backtick that opens one before a link or tag does wins.
  const paraAt = paragraphs(text);
  const spans = blankCodeAcross(text, text, content, taken, paraAt);
  const code = spans.map((l, i) => (!prose[i] ? l : taken.has(i) ? " ".repeat(l.length) : maskCode(l, false)));
  return blankLinks(code.join("\n"), refs, shape, prose, paraAt)
    .split("\n")
    .map((l, i) => (prose[i] ? cutUnclosed(maskRest(l, refs, text[i]), unclosedAt(code[i])) : l));
}

/** `mentionLines` as a scan for the note `named` (a mention regex, not global)
 * runs it: indented code and raw HTML are looked for only near a line naming
 * the note, which skips a parse. The Backlinks list and Link all both read a
 * note this way, so they agree. */
export function mentionLinesFor(content: string, named: RegExp): string[] {
  const code = mayIndent(content);
  const html = mayRunHtml(content);
  if (!code && !html) return mentionLines(content, false, false);
  // Read only the blocks (the lines between blank ones) that name the note.
  const blank = (from: number, to: number) => /^[ \t>]*$/.test(content.slice(from, to));
  const re = new RegExp(named.source, named.flags.replace("g", "") + "g");
  let indented = false;
  let raw = false;
  let last = -1; // the end of the last block read
  for (let m; (m = re.exec(content)); ) {
    if (m.index < last) continue;
    let from = content.lastIndexOf("\n", m.index) + 1;
    for (let up = from; up > 0; ) {
      const prev = content.lastIndexOf("\n", up - 2) + 1;
      if (blank(prev, up - 1)) break;
      from = up = prev;
    }
    let to = content.indexOf("\n", m.index);
    for (to = to < 0 ? content.length : to; to < content.length; ) {
      const next = content.indexOf("\n", to + 1);
      const end = next < 0 ? content.length : next;
      if (blank(to + 1, end)) break;
      to = end;
    }
    for (const l of content.slice(from, to).split("\n")) {
      if (code && !indented && INDENTED_RE.test(l)) indented = true;
      if (html && !raw && l.includes("<") && mayRunHtml(l + "\n")) raw = true;
    }
    last = to;
    if ((indented || !code) && (raw || !html)) break;
  }
  // A `<!`, `<?` or `<script`, `<pre` or `<style` above can run on past blank lines.
  if (html && !raw && last >= 0) raw = /<[!?]|<(?:script|pre|style)\b/i.test(content.slice(0, last));
  return mentionLines(content, indented, raw);
}

/** Where a note's text isn't prose though its lines are: `%%comments%%`, `$$`
 * math, HTML comments, raw HTML (unless `html` is false) and indented code
 * (unless `indented` is false). Frontmatter and fenced code are `proseMask`'s. */
export function hiddenSpans(content: string, indented = true, lines = content.split("\n"), prose = proseMask(lines), html = true): [number, number][] {
  const spans: [number, number][] = content.includes("%%") ? commentRanges(content) : [];
  spans.push(...rawRanges(content, indented, html));
  if (content.includes("$$") || content.includes("<!--")) {
    // Paired outside code and comments, so a `$$` in them can't shift the pairs.
    const outside = blank(content, spans)
      .split("\n")
      .map((l, i) => (prose[i] ? l.replace(INLINE_CODE_RE, (m) => " ".repeat(m.length)) : " ".repeat(l.length)))
      .join("\n");
    // A comment as the editor's parser reads one: no `>` straight after `<!--`,
    // and no `--` inside.
    for (const m of outside.matchAll(/\$\$[\s\S]*?\$\$|<!--[^>](?:-[^-]|[^-])*?-->/g)) spans.push([m.index!, m.index! + m[0].length]);
  }
  return spans;
}

/** `text` with each span blanked to spaces, its newlines kept. */
function blank(text: string, spans: [number, number][]): string {
  if (!spans.length) return text;
  let out = "";
  let at = 0;
  let lineBreak = -1; // the first line break at or after the last span's start
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const start = Math.max(from, at);
    if (to <= start) continue;
    if (lineBreak < start) {
      const k = text.indexOf("\n", start);
      lineBreak = k < 0 ? Infinity : k;
    }
    out += text.slice(at, start) + (lineBreak >= to ? " ".repeat(to - start) : text.slice(start, to).replace(/[^\n]/g, " "));
    at = to;
  }
  return out + text.slice(at);
}

/** A note's names (longest first) as whole words, ignoring case. */
export function mentionRegex(names: string[], flags = "iu"): RegExp {
  const needles = names.map((n) => n.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${needles.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}_])`, flags);
}

/** Whether linking `[from, to)` of `lines[i]` leaves the bold, italics,
 * highlight and strikethrough around it as they were. The link's brackets sit
 * next to any `*` or `_` run, or `==` or `~~` pair, touching the name, so where
 * that run's far side isn't a space it can gain or lose the power to open or
 * close (`a*Foo*b`, `Foo*[x]*`). Only then is the paragraph rendered both ways
 * to see. */
export function keepsEmphasis(lines: string[], i: number, from: number, to: number): boolean {
  const line = lines[i];
  const touches = (side: -1 | 1) => {
    const at = side < 0 ? from - 1 : to;
    const c = line[at];
    if (!c || !"*_~=".includes(c) || !/[\p{L}\p{N}]/u.test(side < 0 ? line[from] : line[to - 1])) return false;
    let far = at;
    if (c === "*" || c === "_") while (line[far] === c) far += side;
    else if (line[at + side] !== c || (side > 0 && line[at + 2] === c)) return false; // `==` and `~~` are a run's last two
    else far = at + 2 * side;
    return far >= 0 && far < line.length && !/\s/.test(line[far]);
  };
  const before = touches(-1);
  if (!before && !touches(1)) return true;
  // `**Foo**:` and the like: with punctuation past it, the run after only
  // gains the power to open, and it closes the run before (left as it was)
  // first. A letter past it (`*Foo*a`) would cost it the power to close.
  const c = line[from - 1];
  if (!before && c && "*_~=".includes(c)) {
    let n = 0;
    while (line[from - 1 - n] === c) n++;
    const past = line[to + n] ?? "";
    if (line.slice(to, to + n) === c.repeat(n) && past !== c && !/[\p{L}\p{N}]/u.test(past)) return true;
  }
  // The paragraph, out to blank lines and fences, without its shared indent.
  const ends = (l: string) => /^[ \t>]*$/.test(l) || /^[ \t>]*(```|~~~)/.test(l);
  let a = i;
  let b = i;
  while (a > 0 && i - a < 50 && !ends(lines[a - 1])) a--;
  while (b < lines.length - 1 && b - i < 50 && !ends(lines[b + 1])) b++;
  const para = lines.slice(a, b + 1);
  const cut = Math.min(...para.map((l) => /^[ \t]*/.exec(l)![0].length));
  const text = (ls: string[]) => ls.map((l) => l.slice(cut)).join("\n");
  const linked = [...para];
  linked[i - a] = `${line.slice(0, from)}[[${line.slice(from, to)}]]${line.slice(to)}`;
  const unlinked = renderMarkdown(text(linked)).replace(/<a class="md-wikilink" data-target="[^"]*">([^<]*)<\/a>/g, "$1");
  return unlinked === renderMarkdown(text(para));
}

/** Wrap the FIRST bare, word-bounded occurrence of `name` on `line` in a link.
 * Occurrences inside inline code, URLs, tags or existing links are skipped
 * (masked out first). `linkText` is what the link should point at (the bare
 * name, or a folder path when the name alone would resolve elsewhere); when it
 * differs from the matched text the result is `[[linkText|text]]`, as Obsidian
 * writes it. `lines` and `i` place `line` in its note, to read the paragraph
 * around it. Returns the new line, or null if there's no mention. */
export function linkifyMention(
  line: string,
  names: string | string[],
  linkText?: string,
  masked = maskForMentions(line),
  lines = [line],
  i = 0,
): string | null {
  const list = Array.isArray(names) ? names : [names];
  if (!list.some((n) => n.trim())) return null;
  // Matched in the masked copy, spliced into the original by the same offset.
  const re = mentionRegex(list, "giu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) && !keepsEmphasis(lines, i, m.index, m.index + m[0].length));
  if (!m) return null;
  const start = m.index;
  const end = start + m[0].length;
  const surface = line.slice(start, end); // preserve the original casing
  // Resolution ignores case, so only a different target needs the alias form.
  const same = !linkText || linkText.toLowerCase() === surface.toLowerCase();
  const link = same ? `[[${surface}]]` : `[[${linkText}|${surface}]]`;
  return `${line.slice(0, start)}${link}${line.slice(end)}`;
}
