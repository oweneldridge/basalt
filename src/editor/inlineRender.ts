// Minimal inline-Markdown → DOM, used to render the contents of block widgets
// (e.g. table cells) where the CodeMirror tree decorations don't reach. Builds
// real DOM nodes (never innerHTML) and reuses the app's link classes, so clicks
// inside a table are handled by the same delegated handlers as everywhere else.
import type { EditorView } from "@codemirror/view";
import { parseMarkdownLink, TAG_BEFORE, TAG_NAME, targetNoteName } from "../lib/markdown";
import { fillMath } from "./mathRender";

// One alternation: inline code | wikilink | md-link/image | math | highlight |
// strikethrough | bold | italic | tag. Math comes before emphasis, so `$a*b$`
// stays math.
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
    /(\$(?!\s)(?:\\.|[^$\n\\`])+?(?<!\s)\$(?!\d))/, // 4: inline math ($5 and $10 is text)
    /(==[^=\n]+?==)/, // 5: highlight
    /(~~[^~\n]+?~~)/, // 6: strikethrough
    /(\*\*[^*\n]+?\*\*|(?<![A-Za-z0-9])__[^_\n]+?__(?![A-Za-z0-9]))/, // 7: bold
    /(\*[^*\n]+?\*|(?<![A-Za-z0-9])_[^_\n]+?_(?![A-Za-z0-9]))/, // 8: italic
    new RegExp(`((?<=^|${TAG_BEFORE.source})#${TAG_NAME})`), // 9: tag
  ]
    .map((r) => r.source)
    .join("|"),
  "g",
);

/** `view` is redrawn once KaTeX has loaded, if a formula here had to wait. */
export function renderInline(text: string, view?: EditorView): DocumentFragment {
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
      const span = document.createElement("span");
      span.className = "cm-math";
      fillMath(span, tok.slice(1, -1), false, view);
      frag.append(span);
    } else if (m[5]) {
      const mark = document.createElement("mark");
      mark.className = "cm-highlight";
      mark.textContent = tok.slice(2, -2);
      frag.append(mark);
    } else if (m[6]) {
      const s = document.createElement("s");
      s.textContent = tok.slice(2, -2);
      frag.append(s);
    } else if (m[7]) {
      const strong = document.createElement("strong");
      strong.textContent = tok.slice(2, -2); // both ** and __ are 2-char delimiters
      frag.append(strong);
    } else if (m[8]) {
      const em = document.createElement("em");
      em.textContent = tok.slice(1, -1);
      frag.append(em);
    } else if (/^#\d+$/.test(tok)) {
      frag.append(document.createTextNode(tok)); // a number isn't a tag
    } else {
      const span = document.createElement("span");
      span.className = "cm-tag";
      span.textContent = tok;
      frag.append(span);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
}
