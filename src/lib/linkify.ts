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
// A link reference definition.
const REF_DEF_RE = /^ {0,3}\[[^\]\n]+\]:\s*\S.*$/g;
// A reference link or image, `[text][label]`, `![alt][label]` or `[label][]`.
const REF_LINK_RE = /!?\[[^\]\n]*\]\[[^\]\n]*\]/g;
// A link's address, `](address)`, whatever brackets its text holds.
const LINK_DEST_RE = /\]\((?:<[^>\n]*>[^)\n]*|[^)\n]*)\)/g;
// A callout's type, a footnote reference and an email address. Run after the
// links and URLs are masked, so a linked image's `[![` isn't read as a callout.
const OTHER_RE = /\[![^\]\n]*\]|\[\^[^\]\n]+\]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** `line` with what can't hold a linkable mention (inline code and math, HTML
 * tags, autolinks, links and reference links, URLs, tags, callout types,
 * footnotes, references, emails) blanked to spaces, same length, so offsets
 * still match the line. */
export function maskForMentions(line: string): string {
  return line
    .replace(REF_DEF_RE, (m) => " ".repeat(m.length))
    .replace(INLINE_CODE_RE, (m) => " ".repeat(m.length))
    .replace(INLINE_MATH_RE, (m) => " ".repeat(m.length))
    .replace(AUTOLINK_RE, (m) => " ".repeat(m.length))
    .replace(HTML_TAG_RE, (m) => " ".repeat(m.length))
    .replace(wikilinkRegex(), (m) => " ".repeat(m.length))
    .replace(mdLinkRegexGlobal(), (m) => " ".repeat(m.length))
    .replace(REF_LINK_RE, (m) => " ".repeat(m.length))
    .replace(LINK_DEST_RE, (m) => " ".repeat(m.length))
    .replace(URL_RE, (m) => " ".repeat(m.length))
    .replace(OTHER_RE, (m) => " ".repeat(m.length))
    .replace(tagRegex(), (m) => " ".repeat(m.length));
}

/** Each line of a note as `maskForMentions` leaves it, with what spans lines
 * blanked too: frontmatter, fenced and indented code, `%%comments%%`, `$$`
 * math and HTML comments. What's left is where a mention can be linked. */
export function mentionLines(content: string, indented = true): string[] {
  const lines = content.split("\n");
  const prose = proseMask(lines);
  return blank(content, hiddenSpans(content, indented, lines, prose))
    .split("\n")
    .map((l, i) => (prose[i] ? maskForMentions(l) : " ".repeat(l.length)));
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
  const chars = text.split("");
  for (const [from, to] of spans) for (let i = from; i < to; i++) if (chars[i] !== "\n") chars[i] = " ";
  return chars.join("");
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
