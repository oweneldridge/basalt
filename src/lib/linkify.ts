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
// A callout's type, a footnote reference, a link reference definition and an
// email address: none of them is prose a link can go into.
const OTHER_RE = /\[![^\]\n]*\]|\[\^[^\]\n]+\]|^ {0,3}\[[^\]\n]+\]:\s*\S.*$|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** `line` with what can't hold a linkable mention (inline code and math, HTML
 * tags, links, URLs, tags, callout types, footnotes, references, emails)
 * blanked to spaces, same length, so offsets still match the line. */
export function maskForMentions(line: string): string {
  return line
    .replace(INLINE_CODE_RE, (m) => " ".repeat(m.length))
    .replace(INLINE_MATH_RE, (m) => " ".repeat(m.length))
    .replace(HTML_TAG_RE, (m) => " ".repeat(m.length))
    .replace(OTHER_RE, (m) => " ".repeat(m.length))
    .replace(wikilinkRegex(), (m) => " ".repeat(m.length))
    .replace(mdLinkRegexGlobal(), (m) => " ".repeat(m.length))
    .replace(URL_RE, (m) => " ".repeat(m.length))
    .replace(tagRegex(), (m) => " ".repeat(m.length));
}

/** Each line of a note as `maskForMentions` leaves it, with what spans lines
 * blanked too: frontmatter, fenced and indented code, `%%comments%%`, `$$`
 * math and HTML comments. What's left is where a mention can be linked. */
export function mentionLines(content: string, indented = true): string[] {
  const spans: [number, number][] = content.includes("%%") ? commentRanges(content) : [];
  const lines = content.split("\n");
  const prose = proseMask(lines);
  if (content.includes("$$") || content.includes("<!--")) {
    // Paired outside code, so a `$$` in code can't shift the pairs.
    const outside = lines
      .map((l, i) => (prose[i] ? l.replace(INLINE_CODE_RE, (m) => " ".repeat(m.length)) : " ".repeat(l.length)))
      .join("\n");
    for (const m of outside.matchAll(/\$\$[\s\S]*?\$\$|<!--[\s\S]*?-->/g)) spans.push([m.index!, m.index! + m[0].length]);
  }
  // Finding indented code takes a parse; `indented: false` skips it when no
  // line that matters is indented.
  if (indented) spans.push(...indentedCodeRanges(content));
  let text = content;
  if (spans.length) {
    const chars = content.split("");
    for (const [from, to] of spans) for (let i = from; i < to; i++) if (chars[i] !== "\n") chars[i] = " ";
    text = chars.join("");
  }
  return text.split("\n").map((l, i) => (prose[i] ? maskForMentions(l) : " ".repeat(l.length)));
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
