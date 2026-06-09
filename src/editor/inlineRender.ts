// Minimal inline-Markdown → DOM, used to render the contents of block widgets
// (e.g. table cells) where the CodeMirror tree decorations don't reach. Builds
// real DOM nodes (never innerHTML) and reuses the app's link classes, so clicks
// inside a table are handled by the same delegated handlers as everywhere else.
import { parseMarkdownLink, targetNoteName } from "../lib/markdown";

// One alternation: inline code | wikilink | md-link/image | bold | italic.
// The bracket classes exclude `[` so a run of `[`/`![` fails fast at the first
// inner bracket instead of rescanning to end-of-line (would be O(n²) — ReDoS).
// `_` emphasis requires word boundaries so snake_case isn't mangled. The md-link
// URL allows one level of balanced parens; the token is re-parsed by
// parseMarkdownLink so this and the body editor never disagree.
const INLINE_RE = new RegExp(
  [
    /(`[^`]+`)/, // 1: inline code
    /(\[\[[^\][\n]+?\]\])/, // 2: wikilink
    /(!?\[[^\][\n]*?\]\((?:[^()\n]|\([^()\n]*\))*\))/, // 3: md link / image
    /(\*\*[^*\n]+?\*\*|(?<![A-Za-z0-9])__[^_\n]+?__(?![A-Za-z0-9]))/, // 4: bold
    /(\*[^*\n]+?\*|(?<![A-Za-z0-9])_[^_\n]+?_(?![A-Za-z0-9]))/, // 5: italic
  ]
    .map((r) => r.source)
    .join("|"),
  "g",
);

export function renderInline(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  // Belt-and-suspenders: never run the tokenizer on an absurdly long cell.
  if (text.length > 2000) {
    frag.append(document.createTextNode(text));
    return frag;
  }
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (m[1]) {
      const code = document.createElement("code");
      code.className = "cm-inline-code";
      code.textContent = tok.slice(1, -1);
      frag.append(code);
    } else if (m[2]) {
      const inner = tok.slice(2, -2);
      const [rawTarget, alias] = inner.split("|");
      const span = document.createElement("span");
      span.className = "cm-wikilink";
      span.dataset.target = targetNoteName(rawTarget);
      span.textContent = (alias ?? rawTarget).trim();
      frag.append(span);
    } else if (m[3]) {
      const parsed = parseMarkdownLink(tok);
      if (parsed) {
        const a = document.createElement("a");
        a.className = "cm-md-link";
        a.dataset.href = parsed.href;
        a.textContent = parsed.text || parsed.href;
        frag.append(a);
      } else {
        frag.append(document.createTextNode(tok));
      }
    } else if (m[4]) {
      const strong = document.createElement("strong");
      strong.textContent = tok.slice(2, -2); // both ** and __ are 2-char delimiters
      frag.append(strong);
    } else if (m[5]) {
      const em = document.createElement("em");
      em.textContent = tok.slice(1, -1);
      frag.append(em);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
}
