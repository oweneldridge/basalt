// Pure Markdown/wikilink helpers shared by the editor and the index, so the two
// can never disagree about what a link is or what it points to.

/**
 * Returns a fresh global wikilink regex each call. Group 1 = target, group 2 =
 * optional alias. A new instance avoids shared `lastIndex` bugs between callers.
 * Matches `[[Target]]` and `[[Target|Alias]]`; target/alias forbid `[ ] |`.
 */
export function wikilinkRegex(): RegExp {
  return /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;
}

/**
 * Case/space-insensitive key for comparing note names. NFC-normalizes first so
 * that visually-identical names with different Unicode composition still match.
 */
export function normalizeName(s: string): string {
  return s.normalize("NFC").trim().toLowerCase();
}

/**
 * Reduce a raw wikilink target to the bare note name it resolves to:
 * strip a `#heading`, a `^block` ref, and any `folder/` path prefix.
 * `"notes/Project#Goals"` → `"Project"`.
 */
export function targetNoteName(raw: string): string {
  let s = raw.split("#")[0];
  s = s.split("^")[0];
  s = s.trim();
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (slash >= 0) s = s.slice(slash + 1);
  return s.trim();
}

// Anchored `[text](url)` / `![alt](url)`. The URL allows one level of balanced
// parens (so `(.../Foo_(bar))` isn't truncated) and an optional "title".
const MD_LINK_RE =
  /^!?\[([^\]]*)\]\(\s*(<[^>]+>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)$/;

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
