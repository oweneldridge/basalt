// Pure Markdown/wikilink helpers shared by the editor and the index, so the two
// can never disagree about what a link is or what it points to.

/**
 * Returns a fresh global wikilink regex each call. Group 1 = target, group 2 =
 * optional alias. A new instance avoids shared `lastIndex` bugs between callers.
 * Matches `[[Target]]` and `[[Target|Alias]]`; target/alias forbid `[ ] |` and
 * NEWLINES — a multiline match would emit a line-break-replacing decoration
 * from a ViewPlugin, which is a CM6 RangeError crash.
 */
export function wikilinkRegex(): RegExp {
  return /\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]/g;
}

/**
 * Per-line "is this prose?" mask: false for YAML frontmatter lines and fenced
 * code-block lines (CommonMark rules: fence closes only on the same marker
 * char, at least the same run length, nothing else on the line). Shared by
 * link extraction and unlinked-mention scanning so they can never disagree.
 */
export function proseMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(true);
  let i = 0;
  // Leading frontmatter block.
  if (lines.length > 1 && lines[0].trim() === "---") {
    mask[0] = false;
    let end = -1;
    for (let j = 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === "---" || t === "...") {
        end = j;
        break;
      }
    }
    if (end !== -1) {
      for (let j = 1; j <= end; j++) mask[j] = false;
      i = end + 1;
    }
  }
  let fence: { char: string; len: number } | null = null;
  for (; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (fence) {
      mask[i] = false;
      if (
        m &&
        m[1][0] === fence.char &&
        m[1].length >= fence.len &&
        m[2].trim() === ""
      ) {
        fence = null; // closing fence (itself non-prose)
      }
    } else if (m) {
      mask[i] = false;
      fence = { char: m[1][0], len: m[1].length };
    }
  }
  return mask;
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

/** Tags `#tag` / `#nested/tag`. A zero-width lookbehind keeps `#` from matching
 * after a word char, `/`, or another `#` (so a heading `# `, mid-word `a#b`, a
 * URL `/#frag`, and `#a#b`'s second tag all behave). Group 1 = `#tag`, group 2 =
 * bare name. */
export function tagRegex(): RegExp {
  return /(?<![\w/#])(#([A-Za-z0-9_][\w-]*(?:\/[A-Za-z0-9_][\w-]*)*))/g;
}

/**
 * Strip a `#heading` / `#^block` ref from a raw wikilink target, KEEPING any
 * `folder/` path. Block refs always follow a `#` in Obsidian, so a bare `^`
 * is an ordinary name character. `"notes/Project#Goals"` → `"notes/Project"`.
 */
export function targetPathPart(raw: string): string {
  return raw.split("#")[0].trim();
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
  if (!/\.md$/i.test(path)) return null;
  return { path, fragment };
}

/** Percent-encode a vault path for a markdown href the way Obsidian does:
 * spaces and parens encoded, slashes kept. */
export function encodeMdPath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/\(/g, "%28").replace(/\)/g, "%29"))
    .join("/");
}
