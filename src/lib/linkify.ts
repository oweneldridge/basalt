// Convert an UNLINKED mention (a bare occurrence of a note's name) into a
// `[[wikilink]]`, matching Obsidian's "Link"/"Link all" backlink actions. Pure
// + length-preserving masking so we splice into the ORIGINAL line by offset,
// never touching a mention that sits inside inline code or an existing link.
import { wikilinkRegex, mdLinkRegexGlobal, tagRegex } from "./markdown";

const INLINE_CODE_RE = /`[^`\n]*`/g;
const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>()[\]]+/gi;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wrap the FIRST bare, word-bounded occurrence of `name` on `line` in a link.
 * Occurrences inside inline code, URLs, tags or existing links are skipped
 * (masked out first). `linkText` is what the link should point at (the bare
 * name, or a folder path when the name alone would resolve elsewhere); when it
 * differs from the matched text the result is `[[linkText|text]]`, as Obsidian
 * writes it. Returns the new line, or null if there's no mention. */
export function linkifyMention(line: string, names: string | string[], linkText?: string): string | null {
  // The note's name or one of its aliases, longest first.
  const needles = (Array.isArray(names) ? names : [names])
    .map((n) => n.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!needles.length) return null;
  // Mask code + existing links to spaces (length-preserving) so a match found
  // in the masked copy splices cleanly into the original by the same offset.
  const masked = line
    .replace(INLINE_CODE_RE, (m) => " ".repeat(m.length))
    .replace(wikilinkRegex(), (m) => " ".repeat(m.length))
    .replace(mdLinkRegexGlobal(), (m) => " ".repeat(m.length))
    .replace(URL_RE, (m) => " ".repeat(m.length))
    .replace(tagRegex(), (m) => " ".repeat(m.length));
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${needles.map(escapeRegex).join("|")})([^\\p{L}\\p{N}_]|$)`, "iu");
  const m = re.exec(masked);
  if (!m) return null;
  // Offset of the matched name within the line (group 2 starts after group 1).
  const start = m.index + m[1].length;
  const end = start + m[2].length;
  const surface = line.slice(start, end); // preserve the original casing
  // Resolution ignores case, so only a different target needs the alias form.
  const same = !linkText || linkText.toLowerCase() === surface.toLowerCase();
  const link = same ? `[[${surface}]]` : `[[${linkText}|${surface}]]`;
  return `${line.slice(0, start)}${link}${line.slice(end)}`;
}
