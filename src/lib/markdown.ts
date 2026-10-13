// Pure Markdown/wikilink helpers shared by the editor and the index, so the two
// can never disagree about what a link is or what it points to.

/**
 * Returns a fresh global wikilink regex each call. Group 1 = target, group 2 =
 * optional alias. A new instance avoids shared `lastIndex` bugs between callers.
 * Matches `[[Target]]` and `[[Target|Alias]]`; target/alias forbid `[ ] |` and
 * NEWLINES — a multiline match would emit a line-break-replacing decoration
 * from a ViewPlugin, which is a CM6 RangeError crash. Brackets right after the
 * `[[` are the target's, as in Obsidian: `[[[Foo]]]` links to "[Foo". An
 * escaped `\[[` (an odd run of backslashes before it) opens no link.
 */
export function wikilinkRegex(): RegExp {
  // A match can't start two brackets into a run: one from a bracket earlier
  // would have matched first, and trying every start makes a long run quadratic.
  return /(?<!(?:^|[^\\])\\(?:\\\\)*)(?<!\[\[)\[\[(\[*[^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]/g;
}

/**
 * Per-line "is this prose?" mask: false for YAML frontmatter lines and fenced
 * code-block lines, in a quote or callout too (CommonMark rules: no backtick
 * after a backtick fence's opening run, and a fence closes only on the same
 * marker char, at least the same run length, nothing else on the line, or
 * where its quote ends). Shared by
 * link extraction and unlinked-mention scanning so they can never disagree.
 */
export function proseMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(true);
  let i = 0;
  // Leading frontmatter block.
  if (lines.length > 1 && lines[0].trim() === "---") mask[0] = false;
  const end = frontmatterEnd(lines);
  if (end !== -1) {
    for (let j = 1; j <= end; j++) mask[j] = false;
    i = end + 1;
  }
  maskFrom(lines, i, mask, 0);
  return mask;
}

/** How deep in quotes and lists the block each line is part of sits, as
 * Reading view counts it (past 1,000 the markers are read as text). */
export function blockDepths(lines: string[]): number[] {
  const depths = new Array<number>(lines.length);
  maskFrom(lines, 0, new Array<boolean>(lines.length), 0, depths);
  if (depths.length) depths[0] ??= 0;
  for (let k = 1; k < depths.length; k++) depths[k] ??= depths[k - 1];
  return depths;
}

/** proseMask's work from line `start` on, for a note or, `depth` deep, for what
 * follows an HTML block's closing line, which Reading view reads as a note of
 * its own. Blocks are read as the editor's parser (@lezer/markdown) reads them,
 * line by line through the quotes and list items they sit in. With `depths`,
 * the depth of each block is set at its first line. */
function maskFrom(lines: string[], start: number, mask: boolean[], depth: number, depths?: number[]): void {
  // Only a fence makes code here, so a note without one needs no closer look.
  let fenced = !!depths;
  for (let j = start; j < lines.length && !fenced; j++) fenced = lines[j].includes("```") || lines[j].includes("~~~");
  if (!fenced) return;
  const n = lines.length;
  const stack: Container[] = [];
  const line = new Line();
  // Reads line `i` through the open containers, as far as it goes on with them.
  const read = (i: number) => {
    line.reset(lines[i]);
    while (line.depth < stack.length) {
      const c = stack[line.depth];
      const goesOn = c === QUOTE ? line.skipQuote() : line.indent >= line.baseIndent + c.value || line.next < 0;
      if (goesOn && c !== QUOTE) line.moveBaseColumn(line.baseIndent + c.value);
      line.forward();
      if (!goesOn) break;
      line.depth++;
    }
  };
  // An HTML block from line `i`. Reading view ends it at the line closing its
  // first tag and reads the rest as a note of its own. Returns the line after.
  const html = (i: number, kind: number): number => {
    const rest = line.text.slice(line.pos);
    const end = HTML_STARTS[kind][1] ?? BLANK_LINE;
    const tag = rest.includes(">") ? /^\s*<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest)?.[1] : undefined;
    const close = tag ? new RegExp(`</${tag}\\s*>`, "i") : null;
    let closed = close?.test(rest) ? i : -1;
    let last = i;
    let after = n;
    for (;;) {
      if (end.test(lines[last])) {
        if (end === BLANK_LINE) after = last--;
        else if ((after = last + 1) < n) read(after);
        break;
      }
      if (last + 1 === n) break;
      read(last + 1);
      if (line.depth < stack.length) {
        after = last + 1;
        break;
      }
      last++;
      if (closed < 0 && close?.test(lines[last])) closed = last;
    }
    // Past Reading view's nesting limit the rest shows as its source.
    const at = depth + stack.length + 1;
    if (closed >= 0 && at <= MAX_DEPTH) {
      const sub = new Array<boolean>(last - closed).fill(true);
      const subDepths = depths && new Array<number>(last - closed);
      maskFrom(lines.slice(closed + 1, last + 1), 0, sub, at, subDepths);
      for (let k = 0; k < sub.length; k++) mask[closed + 1 + k] = sub[k];
      if (subDepths) for (let k = 0; k < subDepths.length; k++) depths![closed + 1 + k] = subDepths[k];
    } else if (closed >= 0 && depths) for (let k = closed + 1; k <= last; k++) depths[k] = at;
    return after;
  };
  let i = start;
  if (i < n) read(i);
  next: while (i < n) {
    if (stack.length > line.depth) stack.length = line.depth;
    if (line.pos === line.text.length) {
      if (++i < n) read(i);
      continue;
    }
    // Containers this line opens, then the block inside them.
    for (;;) {
      if (depths) depths[i] = depth + stack.length;
      if (line.indent >= line.baseIndent + 4) {
        // Indented code, to a line that isn't (blank lines in between are).
        const base = line.baseIndent + 4;
        while (++i < n) {
          read(i);
          if (line.depth < stack.length || (line.pos < line.text.length && line.indent < base)) break;
        }
        continue next;
      }
      const c = line.next;
      const run = c === 96 || c === 126 ? fenceAt(line) : 0;
      if (run) {
        const char = line.next;
        mask[i] = false;
        while (++i < n) {
          read(i);
          if (line.depth < stack.length) continue next;
          mask[i] = false;
          let k = line.pos;
          if (line.indent - line.baseIndent < 4) while (k < line.text.length && line.text.charCodeAt(k) === char) k++;
          if (k - line.pos >= run && skipSpace(line.text, k) === line.text.length) {
            if (++i < n) read(i);
            continue next;
          }
        }
        continue next;
      }
      if (c === 62 /* > */ && stack.length < MAX_CONTAINERS) {
        stack.push(QUOTE);
        line.moveBase(line.pos + (line.text.charCodeAt(line.pos + 1) === 32 ? 2 : 1));
        line.forward();
        continue;
      }
      if ((c === 42 || c === 45 || c === 95) && breakAt(line)) {
        if (++i < n) read(i);
        continue next;
      }
      const marker =
        stack.length >= MAX_CONTAINERS ? 0 : c === 42 || c === 43 || c === 45 ? bulletAt(line, false, stack) : c >= 48 && c <= 57 ? orderedAt(line, false, stack) : 0;
      if (marker) {
        const col = listIndent(line, line.pos + marker);
        stack.push({ value: col - line.baseIndent, ordered: marker > 1 });
        line.moveBaseColumn(col);
        line.forward();
        continue;
      }
      if (c === 35 && headingAt(line)) {
        if (++i < n) read(i);
        continue next;
      }
      const kind = c === 60 ? htmlAt(line, false) : -1;
      if (kind >= 0) {
        i = html(i, kind);
        continue next;
      }
      break;
    }
    // A quote or list marker with nothing after it starts no paragraph.
    if (line.pos === line.text.length) {
      if (++i < n) read(i);
      continue;
    }
    // A paragraph: to a blank line, a line that starts a block (a table too,
    // unless the paragraph may be one), the line after a link reference
    // definition, or an underline.
    const ref = line.next === 91 /* [ */ ? new LinkRef(line.text.slice(line.pos)) : null;
    const head = i;
    const headPos = line.pos;
    while (++i < n) {
      read(i);
      if (line.pos === line.text.length) continue next;
      if (line.indent < line.baseIndent + 4 && (interrupts(line, stack) || (tableAt(line, lines[i + 1]) && !hasPipe(lines[head], headPos)))) continue next;
      if (ref?.nextLine(line.baseIndent ? " ".repeat(line.basePos) + line.text.slice(line.basePos) : line.text)) continue next;
      if (line.depth === stack.length && underlineAt(line)) {
        if (++i < n) read(i);
        continue next;
      }
    }
  }
}

// A quote, or a list item: its text's column past its container's, and
// whether it's numbered.
interface Container {
  value: number;
  ordered: boolean;
}
const QUOTE: Container = { value: 0, ordered: false };

// Past this many containers in one another a line's markers are read as text.
const MAX_CONTAINERS = 1000;

// A line as the editor's parser walks it: past the containers it goes on with
// (`depth` of them), where their text starts (`basePos`, column `baseIndent`),
// and the next character that isn't a space (`next`, -1 for none) and its column.
class Line {
  text = "";
  pos = 0;
  basePos = 0;
  baseIndent = 0;
  indent = 0;
  next = -1;
  depth = 0;
  // The column basePos is at (past baseIndent when a tab spans it), so the
  // next container's column is counted on from there.
  baseAt = 0;
  // Where the line ends in nothing but `breakChar` and spaces, once asked.
  breakChar = -1;
  breakFrom = 0;

  reset(text: string) {
    if (text.charCodeAt(text.length - 1) === 13) text = text.slice(0, -1);
    const p = skipSpace(text, 0);
    this.text = text;
    this.basePos = this.baseIndent = this.baseAt = this.depth = 0;
    this.breakChar = -1;
    this.pos = p;
    this.indent = p && columnAt(text, p, 0, 0);
    this.next = p === text.length ? -1 : text.charCodeAt(p);
  }

  forward() {
    const to = skipSpace(this.text, this.basePos);
    this.indent = columnAt(this.text, to, this.pos, this.indent);
    this.pos = to;
    this.next = to === this.text.length ? -1 : this.text.charCodeAt(to);
  }

  moveBase(to: number) {
    this.basePos = to;
    this.baseIndent = this.baseAt = columnAt(this.text, to, this.pos, this.indent);
  }

  moveBaseColumn(col: number) {
    this.baseIndent = col;
    let i = 0;
    let c = 0;
    if (col >= this.baseAt) (i = this.basePos), (c = this.baseAt);
    for (; i < this.text.length && c < col; i++) c += this.text.charCodeAt(i) === 9 ? 4 - (c % 4) : 1;
    this.basePos = i;
    this.baseAt = c;
  }

  skipQuote(): boolean {
    if (this.next !== 62) return false;
    this.moveBase(this.pos + (isSpace(this.text.charCodeAt(this.pos + 1)) ? 2 : 1));
    return true;
  }
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

// Long runs of spaces, as in indented code, are quicker to skip with a regex.
const NOT_SPACE = /[^ \t\n\r]/g;
function skipSpace(text: string, i: number): number {
  if (i >= text.length || !isSpace(text.charCodeAt(i))) return i;
  NOT_SPACE.lastIndex = i;
  return NOT_SPACE.test(text) ? NOT_SPACE.lastIndex - 1 : text.length;
}

/** The column at `to`, counting from `from` at column `col` (tabs to the next
 * stop of 4). */
function columnAt(text: string, to: number, from: number, col: number): number {
  if (to - from > 8 && text.lastIndexOf("\t", to - 1) < from) return col + to - from;
  for (let i = from; i < to; i++) col += text.charCodeAt(i) === 9 ? 4 - (col % 4) : 1;
  return col;
}

/** The length of the fence the line starts with, or 0. */
function fenceAt(line: Line): number {
  const c = line.next;
  if (c !== 96 && c !== 126) return 0;
  let p = line.pos + 1;
  while (p < line.text.length && line.text.charCodeAt(p) === c) p++;
  if (p < line.pos + 3 || (c === 96 && line.text.indexOf("`", p) >= 0)) return 0;
  return p - line.pos;
}

/** Whether the line is a thematic break (`---`, `* * *`). */
function breakAt(line: Line): boolean {
  const c = line.next;
  if (c !== 42 && c !== 45 && c !== 95) return false;
  const t = line.text;
  if (line.breakChar !== c) {
    let from = t.length;
    while (from > 0 && (t.charCodeAt(from - 1) === c || isSpace(t.charCodeAt(from - 1)))) from--;
    (line.breakChar = c), (line.breakFrom = from);
  }
  if (line.pos < line.breakFrom) return false;
  let count = 0;
  for (let p = line.pos; p < t.length && count < 3; p++) if (t.charCodeAt(p) === c) count++;
  return count >= 3;
}

/** Whether the line underlines a paragraph as a heading (`===`, `---`). */
function underlineAt(line: Line): boolean {
  const c = line.next;
  if ((c !== 45 && c !== 61) || line.indent >= line.baseIndent + 4) return false;
  let p = line.pos + 1;
  while (p < line.text.length && line.text.charCodeAt(p) === c) p++;
  return skipSpace(line.text, p) === line.text.length;
}

function inList(stack: Container[], ordered: boolean): boolean {
  return stack.some((c) => c !== QUOTE && c.ordered === ordered);
}

/** The length of the bullet the line starts with, or 0. In a paragraph one
 * needs text after it, or a bullet list around it. */
function bulletAt(line: Line, inParagraph: boolean, stack: Container[]): number {
  const c = line.next;
  if (c !== 45 && c !== 43 && c !== 42) return 0;
  if (line.pos < line.text.length - 1 && !isSpace(line.text.charCodeAt(line.pos + 1))) return 0;
  if (inParagraph && skipSpace(line.text, line.pos + 2) >= line.text.length && !inList(stack, false)) return 0;
  return 1;
}

/** The length of the number and `.` or `)` the line starts with, or 0. In a
 * paragraph only a `1` with text after it starts a list, unless a numbered
 * list is around it. */
function orderedAt(line: Line, inParagraph: boolean, stack: Container[]): number {
  const t = line.text;
  let p = line.pos;
  let c = line.next;
  while (c >= 48 && c <= 57) {
    if (++p === t.length) return 0;
    c = t.charCodeAt(p);
  }
  if (p === line.pos || p > line.pos + 9 || (c !== 46 && c !== 41) || (p < t.length - 1 && !isSpace(t.charCodeAt(p + 1)))) return 0;
  if (inParagraph && (skipSpace(t, p + 1) === t.length || p > line.pos + 1 || line.next !== 49) && !inList(stack, true)) return 0;
  return p + 1 - line.pos;
}

/** The column a list item's text starts at, its marker ending at `pos`: past
 * the spaces after it, or one past the marker when that's five or more. */
function listIndent(line: Line, pos: number): number {
  const after = columnAt(line.text, pos, line.pos, line.indent);
  const text = columnAt(line.text, skipSpace(line.text, pos), pos, after);
  return text >= after + 5 ? after + 1 : text;
}

/** Whether the line is an ATX heading (`# x`). */
function headingAt(line: Line): boolean {
  if (line.next !== 35) return false;
  let p = line.pos + 1;
  while (p < line.text.length && line.text.charCodeAt(p) === 35) p++;
  return (p === line.text.length || line.text.charCodeAt(p) === 32) && p - line.pos <= 6;
}

/** The kind of HTML block the line starts (an index into HTML_STARTS), or -1. */
function htmlAt(line: Line, inParagraph: boolean): number {
  if (line.next !== 60) return -1;
  const rest = line.text.slice(line.pos);
  for (let k = 0; k < HTML_STARTS.length - (inParagraph ? 1 : 0); k++) if (HTML_STARTS[k][0].test(rest)) return k;
  return -1;
}

/** Whether the line ends the paragraph before it by starting a block. */
function interrupts(line: Line, stack: Container[]): boolean {
  switch (line.next) {
    case 35:
      return headingAt(line);
    case 96:
    case 126:
      return fenceAt(line) > 0;
    case 62:
      return true;
    case 60:
      return htmlAt(line, true) >= 0;
    case 42:
    case 45:
      return bulletAt(line, true, stack) > 0 || breakAt(line);
    case 43:
      return bulletAt(line, true, stack) > 0;
    case 95:
      return breakAt(line);
    default:
      return line.next >= 48 && line.next <= 57 && orderedAt(line, true, stack) > 0;
  }
}

/** Whether the line starts a table: it has a `|` and the line after it is a
 * delimiter row (`--|--`) with as many cells. */
function tableAt(line: Line, after: string | undefined): boolean {
  if (after === undefined) return false;
  const c = after.charCodeAt(0);
  if ((c >= 48 && c <= 57) || ((c | 32) >= 97 && (c | 32) <= 122) || !/^[|:\-\s]/.test(after)) return false;
  if (!hasPipe(line.text, line.basePos)) return false;
  if (after.endsWith("\r")) after = after.slice(0, -1);
  return DELIMITER_ROW.test(after) && cellsOf(line.text, line.basePos) === cellsOf(after, line.basePos);
}
const DELIMITER_ROW = /^\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;

function hasPipe(text: string, from: number): boolean {
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 124) return true;
    if (c === 92) i++;
  }
  return false;
}

/** How many cells a table row has, from `from`. */
function cellsOf(text: string, from: number): number {
  let count = 0;
  let first = true;
  let cell = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 124 && !escaped) {
      if (!first || cell) count++;
      first = false;
      cell = false;
    } else if (escaped || (c !== 32 && c !== 9)) cell = true;
    escaped = !escaped && c === 92;
  }
  return cell ? count + 1 : count;
}

// A link reference definition (`[a]: url "title"`) a paragraph starts with, read
// as the editor's parser reads one: a line at a time, as far as it gets. The
// paragraph ends where the definition does.
class LinkRef {
  stage = 0; // the label, the URL, after the URL, after the title, or -1: not one
  pos = 0;
  content: string;
  // A title still open: where it starts, how far it's been read, and whether
  // that stopped after a backslash. Each line goes on from there.
  title = { from: -1, at: 0, escaped: false };

  constructor(first: string) {
    this.content = first;
    this.advance();
  }

  /** Reads another line; true when the definition ended on the line before. */
  nextLine(text: string): boolean {
    if (this.stage < 0) return false;
    this.content += "\n" + text;
    if (this.advance() > -1) return true;
    // Only an open title runs on line after line.
    if (this.stage === 2 && this.title.from >= 0 && this.content.length > LINK_REF_LIMIT) this.stage = -1;
    return false;
  }

  // Where the definition ends, or -1 for not yet (or not one).
  advance(): number {
    const c = this.content;
    for (;;) {
      if (this.stage < 0) return -1;
      if (this.stage === 0) {
        const end = labelEnd(c, this.pos);
        if (end === PENDING && c.length < this.pos + 1000) return -1;
        if (end < 0 || c.charCodeAt(end) !== 58 /* : */) return (this.stage = -1);
        this.pos = end + 1;
        this.stage = 1;
      } else if (this.stage === 1) {
        const end = urlEnd(c, skipSpace(c, this.pos));
        if (end === PENDING) return -1;
        if (end < 0) return (this.stage = -1);
        this.pos = end;
        this.stage = 2;
      } else if (this.stage === 2) {
        const at = skipSpace(c, this.pos);
        let end = 0;
        if (at > this.pos) {
          const title = this.titleEnd(c, at);
          const after = title < 0 ? -1 : lineEnd(c, title);
          if (after > 0) (this.stage = 3), (this.pos = title), (end = after);
        }
        if (!end) end = lineEnd(c, this.pos);
        return end > 0 && end < c.length ? end : -1;
      } else return lineEnd(c, this.pos);
    }
  }

  titleEnd(text: string, start: number): number {
    const open = text.charCodeAt(start);
    if (open !== 39 && open !== 34 && open !== 40) return -1;
    const close = open === 40 ? 41 : open;
    let { at: p, escaped } = this.title.from === start ? this.title : { at: start + 1, escaped: false };
    for (; p < text.length; p++) {
      const c = text.charCodeAt(p);
      if (escaped) escaped = false;
      else if (c === close) return p + 1;
      else if (c === 92) escaped = true;
    }
    this.title = { from: start, at: p, escaped };
    return PENDING;
  }
}
// Past this length a link reference definition whose title is still open is read as text.
const LINK_REF_LIMIT = 1_000_000;
// A part of a link reference definition that may go on to the next line.
const PENDING = -2;

function labelEnd(text: string, start: number): number {
  let blank = true;
  let escaped = false;
  for (let p = start + 1, end = Math.min(text.length, p + 999); p < end; p++) {
    const c = text.charCodeAt(p);
    if (escaped) escaped = false;
    else if (c === 93) return blank ? -1 : p + 1;
    else {
      if (!isSpace(c)) blank = false;
      if (c === 91) return -1;
      if (c === 92) escaped = true;
    }
  }
  return PENDING;
}

function urlEnd(text: string, start: number): number {
  if (text.charCodeAt(start) === 60) {
    for (let p = start + 1; p < text.length; p++) {
      const c = text.charCodeAt(p);
      if (c === 62) return p + 1;
      if (c === 60 || c === 10) return -1;
    }
    return PENDING;
  }
  let depth = 0;
  let p = start;
  for (let escaped = false; p < text.length; p++) {
    const c = text.charCodeAt(p);
    if (isSpace(c)) break;
    if (escaped) escaped = false;
    else if (c === 40) depth++;
    else if (c === 41) {
      if (!depth) break;
      depth--;
    } else if (c === 92) escaped = true;
  }
  return p > start ? p : p === text.length ? PENDING : -1;
}

/** Where the line from `pos` ends, if only spaces are left on it, else -1. */
function lineEnd(text: string, pos: number): number {
  for (; pos < text.length; pos++) {
    const c = text.charCodeAt(pos);
    if (c === 10) break;
    if (!isSpace(c)) return -1;
  }
  return pos;
}

// HTML blocks as the editor's parser starts them, and what ends each (a line it
// matches), or null for a blank line. The last kind, a lone tag, can't break
// into a paragraph.
const HTML_STARTS: [RegExp, RegExp | null][] = [
  [/^<(?:script|pre|style)(?:\s|>|$)/i, /<\/(?:script|pre|style)>/i],
  [/^\s*<!--/, /-->/],
  [/^\s*<\?/, /\?>/],
  [/^\s*<![A-Z]/, />/],
  [/^\s*<!\[CDATA\[/, /\]\]>/],
  [
    /^\s*<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i,
    null,
  ],
  [/^\s*(?:<\/[a-z][\w-]*\s*>|<[a-z][\w-]*(\s+[a-z:_][\w-.]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*>)\s*$/i, null],
];
const BLANK_LINE = /^[ \t\r]*$/;

// Reading view's nesting limit: deeper, a block shows as its source.
const MAX_DEPTH = 40;

/** Index of the line closing a leading `---` frontmatter block, or -1. */
export function frontmatterEnd(lines: string[]): number {
  if (lines.length < 2 || lines[0].trim() !== "---") return -1;
  for (let j = 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === "---" || t === "...") return j;
  }
  return -1;
}

/** Per-line mask of frontmatter lines that can hold a property link: inside
 * the block, but not the text of a `|` or `>` block scalar, which is one
 * multi-line string and never a link. */
export function yamlValueLines(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  const end = frontmatterEnd(lines);
  let block = -1; // column the block scalar's text must be indented past, or -1
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    if (block !== -1) {
      if (line.trim() === "" || indent > block) continue;
      block = -1;
    }
    mask[i] = true;
    // The value part, without a trailing comment (a `#` outside quotes).
    let cut = line.length;
    for (let j = 0; j < line.length; j++) {
      if (line[j] === "#" && (j === 0 || /\s/.test(line[j - 1])) && yamlContextAt(line, j).quote === null) {
        cut = j;
        break;
      }
    }
    const value = line.slice(0, cut).trimEnd();
    if (!/(?::|^\s*-)\s+[|>](?:[+-]?\d?|\d[+-])$/.test(value)) continue;
    // `key: |` and `- key: |` indent past the key; a bare `- |` past its dash.
    const lead = /^(\s*)((?:-\s+)*)/.exec(value)!;
    const rest = value.slice(lead[0].length);
    block = /^[|>]/.test(rest) && lead[2] ? lead[1].length + lead[2].trimEnd().lastIndexOf("-") : lead[0].length;
  }
  return mask;
}

/** YAML scalar context at `pos` on one frontmatter line: the quote style of the
 * scalar it sits in, and whether it's inside a `# comment`. */
export function yamlContextAt(line: string, pos: number): { quote: '"' | "'" | null; comment: boolean } {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < pos && i < line.length; i++) {
    const c = line[i];
    if (quote === '"') {
      if (c === "\\") i++;
      else if (c === '"') quote = null;
    } else if (quote === "'") {
      if (c === "'") {
        if (line[i + 1] === "'") i++;
        else quote = null;
      }
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return { quote: null, comment: true };
    } else if (c === '"' || c === "'") {
      // Quotes only open a scalar at the start of a value, not mid-word (it's).
      const prev = line.slice(0, i).trimEnd().slice(-1);
      if (prev === "" || prev === ":" || prev === "-" || prev === "[" || prev === "," || prev === "{") quote = c;
    }
  }
  return { quote, comment: false };
}

/** Whether a link of length `len` at `pos` on a frontmatter line is a property
 * link. Obsidian only treats a string value that is entirely one link as a
 * link, which in YAML means the whole quoted scalar: `key: "[[x]]"` or a quoted
 * list item. Unquoted `key: [[x]]` parses as a nested list and isn't one. */
export function yamlLinkAt(line: string, pos: number, len: number): { ok: boolean; quote: '"' | "'" | null } {
  const { quote, comment } = yamlContextAt(line, pos);
  const ok = !comment && quote !== null && line[pos - 1] === quote && line[pos + len] === quote;
  return { ok, quote };
}

export function yamlUnescape(s: string, quote: '"' | "'" | null): string {
  if (quote === "'") return s.replace(/''/g, "'");
  if (quote === '"') return s.replace(/\\(["\\])/g, "$1");
  return s;
}

export function yamlEscape(s: string, quote: '"' | "'" | null): string {
  if (quote === "'") return s.replace(/'/g, "''");
  if (quote === '"') return s.replace(/(["\\])/g, "\\$1");
  return s;
}

/**
 * Case/space-insensitive key for comparing note names. NFC-normalizes first so
 * that visually-identical names with different Unicode composition still match.
 */
export function normalizeName(s: string): string {
  return s.normalize("NFC").trim().toLowerCase();
}

/** Obsidian `==highlight==`. Group 1 = inner text. Forbids `=`/newline inside
 * (single-pass, no catastrophic backtracking). Fresh instance per call. */
export function highlightRegex(): RegExp {
  return /==([^=\n]+)==/g;
}

/** A tag's name as Obsidian reads it: letters of any script, digits, emoji,
 * `-`, `_` and `/`; anything but spaces and punctuation. */
export const TAG_NAME = "[^\\u2000-\\u206F\\u2E00-\\u2E7F'!\"#$%&()*+,.:;<=>?@^`{|}~\\[\\]\\\\\\s]+";

/** What may come right before a tag's `#`: nothing, a space, or the opening
 * of bold, italics, highlight or strikethrough (`**#tag**` is a tag to
 * Obsidian's index). So `a#b`, `\#escaped`, `(#x)` and a URL's `/#frag` aren't. */
export const TAG_BEFORE = /[\s*_~=]/;

// A quote's last `>` at the start of a line, after any list marks and quote
// marks before it: the quote's text starts right after it.
const QUOTE_START = String.raw`(?:^|\n)[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+|>[ \t]*)*>`;

/** Tags `#tag` / `#nested/tag`, as Obsidian finds them (see TAG_BEFORE), and
 * right after a quote's marks, where the quote's text starts.
 * Group 1 = `#tag`, group 2 = bare name; a name of digits only (`#42`) is for
 * the caller to skip. */
export function tagRegex(): RegExp {
  return new RegExp(`(?=#)(?<=^|${TAG_BEFORE.source}|${QUOTE_START})(#(${TAG_NAME}))`, "gu");
}

/**
 * Strip a `#heading` / `#^block` ref from a raw wikilink target, KEEPING any
 * `folder/` path. Block refs always follow a `#` in Obsidian, so a bare `^`
 * is an ordinary name character. `"notes/Project#Goals"` → `"notes/Project"`.
 */
export function targetPathPart(raw: string): string {
  return raw.split("#")[0].trim();
}

/** What an unaliased wikilink shows, as Obsidian shows it: the link text with
 * each `#` read as " > " (`Folder/Note#Heading` is "Folder/Note > Heading",
 * `#Heading` is "Heading"). */
export function wikilinkLabel(target: string): string {
  return target
    .split("#")
    .filter(Boolean)
    .join(" > ")
    .trim();
}

/**
 * Reduce a raw wikilink target to the bare note name it resolves to:
 * strip a `#heading`, a `^block` ref, and any `folder/` path prefix.
 * `"notes/Project#Goals"` → `"Project"`.
 */
export function targetNoteName(raw: string): string {
  let s = targetPathPart(raw);
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (slash >= 0) s = s.slice(slash + 1);
  return s.trim();
}

// Anchored `[text](url)` / `![alt](url)`. The text allows one level of
// balanced brackets (`[see [1]](url)`, image-in-link) and the URL one level of
// balanced parens (so `(.../Foo_(bar))` isn't truncated), plus optional "title".
// The bracket alternation is first-char-disjoint, so matching stays linear.
const MD_LINK_RE =
  /^!?\[((?:[^\][\n]|\[[^\][\n]*\])*)\]\(\s*(<[^>]+>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)$/;

/**
 * Parse a single Markdown link/image. The one place link syntax is interpreted,
 * so the body editor and table cells never disagree. Returns null if `raw`
 * isn't a plain inline link (e.g. reference-style).
 */
export function parseMarkdownLink(raw: string): { text: string; href: string } | null {
  const m = MD_LINK_RE.exec(raw);
  if (!m) return null;
  let href = m[2];
  if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
  return { text: m[1], href };
}

/** Global scanner for inline markdown links/images. Same ReDoS-safe character
 * classes as the anchored MD_LINK_RE; each match is re-parsed for parts. */
export function mdLinkRegexGlobal(): RegExp {
  return /!?\[(?:[^\][\n]|\[[^\][\n]*\])*?\]\((?:[^()\n]|\([^()\n]*\))*\)/g;
}

/**
 * Interpret an href as an INTERNAL note link: relative, ending in `.md`
 * (Obsidian always writes the extension for markdown-style note links).
 * Returns the percent-decoded vault path and the raw `#fragment`, or null for
 * external/anchor/non-md hrefs.
 */
export function internalMdHref(href: string): { path: string; fragment: string } | null {
  const file = internalFileHref(href);
  return file && /\.md$/i.test(file.path) ? file : null;
}

/** Like internalMdHref, but for any vault file with an extension: a note or an
 * attachment such as `assets/pic.png` or `paper.pdf#page=3`. */
export function internalFileHref(href: string): { path: string; fragment: string } | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) {
    return null;
  }
  const hashAt = href.indexOf("#");
  const fragment = hashAt >= 0 ? href.slice(hashAt) : "";
  let path = hashAt >= 0 ? href.slice(0, hashAt) : href;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* malformed escapes: keep raw */
  }
  if (!/\.[a-z0-9]{1,10}$/i.test(path)) return null;
  return { path, fragment };
}

/** Where a markdown link's href points inside the vault, as a link target
 * (`Note#Heading`, `paper.pdf`, or `#Heading` for this note), decoded. Obsidian
 * reads every href that isn't a URL this way, with or without `.md`. Null for
 * URLs and for empty or `?query` hrefs. */
export function internalLinkTarget(href: string): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("?")) return null;
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const hashAt = href.indexOf("#");
  if (hashAt < 0) return decode(href);
  return decode(href.slice(0, hashAt)) + "#" + decode(href.slice(hashAt + 1));
}

/** The file a markdown image names: a URL as written, a vault path without
 * its `#fragment` and percent-decoded (`shot%20one.png` is `shot one.png`). */
export function mdImageTarget(href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return href;
  const hashAt = href.indexOf("#");
  const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Percent-encode a vault path for a markdown href the way Obsidian does:
 * spaces and parens encoded, slashes kept. */
export function encodeMdPath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/\(/g, "%28").replace(/\)/g, "%29"))
    .join("/");
}
