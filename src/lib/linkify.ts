// Convert an UNLINKED mention (a bare occurrence of a note's name) into a
// `[[wikilink]]`, matching Obsidian's "Link"/"Link all" backlink actions. Pure
// + length-preserving masking so we splice into the ORIGINAL line by offset,
// never touching a mention that sits inside inline code or an existing link.
import { wikilinkRegex, mdLinkRegexGlobal } from "./markdown";

const INLINE_CODE_RE = /`[^`\n]*`/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wrap the FIRST bare, word-bounded occurrence of `name` on `line` in `[[ ]]`.
 * Occurrences inside inline code / existing wiki or markdown links are skipped
 * (they're masked out first). Returns the new line, or null if none. When the
 * note's basename differs from what a bare `[[name]]` resolves to, an alias
 * form `[[name|name]]` isn't needed — Obsidian links the surface text as-is. */
export function linkifyMention(line: string, name: string): string | null {
  const needle = name.trim();
  if (!needle) return null;
  // Mask code + existing links to spaces (length-preserving) so a match found
  // in the masked copy splices cleanly into the original by the same offset.
  const masked = line
    .replace(INLINE_CODE_RE, (m) => " ".repeat(m.length))
    .replace(wikilinkRegex(), (m) => " ".repeat(m.length))
    .replace(mdLinkRegexGlobal(), (m) => " ".repeat(m.length));
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escapeRegex(needle)})([^\\p{L}\\p{N}_]|$)`, "iu");
  const m = re.exec(masked);
  if (!m) return null;
  // Offset of the matched name within the line (group 2 starts after group 1).
  const start = m.index + m[1].length;
  const end = start + m[2].length;
  const surface = line.slice(start, end); // preserve the original casing
  return `${line.slice(0, start)}[[${surface}]]${line.slice(end)}`;
}
