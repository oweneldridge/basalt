// Transclusion: embedding note CONTENT inline via ![[Note]], ![[Note#Heading]],
// and ![[Note#^blockid]]. This module has two layers:
//   1. Pure extraction (splitSubpath / extractSection) — node-testable.
//   2. A DOM renderer (renderEmbedElement) that resolves the target through a
//      host, renders the extracted Markdown (reusing the escaped renderMarkdown),
//      resolves images relative to the EMBEDDED note, and recurses into nested
//      embeds with a cycle + depth guard.
// Both the Live Preview widget and the Reading view use the same renderer.

import { renderMarkdown } from "./render";
import { proseMask } from "./markdown";

/** Split a raw wikilink target into the note part and the subpath (after #). */
export function splitSubpath(raw: string): { target: string; subpath: string } {
  const hash = raw.indexOf("#");
  if (hash < 0) return { target: raw.trim(), subpath: "" };
  return { target: raw.slice(0, hash).trim(), subpath: raw.slice(hash + 1).trim() };
}

/** Drop a leading YAML frontmatter block. */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const lines = content.split("\n");
  if (lines[0].replace(/\r$/, "") !== "---") return content;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].replace(/\r$/, "");
    if (t === "---" || t === "...") return lines.slice(i + 1).join("\n");
  }
  return content;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Extract the section of `content` a subpath refers to. Empty subpath → the
 * whole note (minus frontmatter). "#Heading" → that heading's section (up to
 * the next same-or-higher heading). "#^id" → that block. Returns "" if the
 * heading/block isn't found. */
export function extractSection(content: string, subpath: string): string {
  const body = stripFrontmatter(content);
  if (!subpath) return body.trim();
  if (subpath.startsWith("^")) return extractBlock(body, subpath.slice(1));
  return extractHeading(body, subpath);
}

const ATX_RE = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/; // trailing #s only when space-separated
const LIST_RE = /^\s*([-*+]|\d+[.)])\s/;

/** True if line `i` is an ATX or setext heading (in prose, not code); returns
 * its level, or 0. */
function headingLevel(lines: string[], mask: boolean[], i: number): number {
  if (!mask[i]) return 0;
  const l = lines[i].replace(/\r$/, "");
  const atx = ATX_RE.exec(l);
  if (atx) return atx[1].length;
  // setext: a non-blank text line underlined by === (h1) or --- (h2).
  const next = lines[i + 1]?.replace(/\r$/, "") ?? "";
  if (l.trim() !== "" && !LIST_RE.test(l) && mask[i + 1]) {
    if (/^=+\s*$/.test(next)) return 1;
    if (/^-+\s*$/.test(next) && !/^-\s/.test(l)) return 2;
  }
  return 0;
}

function headingText(lines: string[], i: number): string {
  const l = lines[i].replace(/\r$/, "");
  const atx = ATX_RE.exec(l);
  return atx ? atx[2] : l.trim();
}

/** The 1-based line of a subpath (`Heading` or `^blockid`) in `content`, or
 * null — for scroll-to-target when following `[[Note#…]]`. Operates on the
 * WHOLE file (frontmatter included) so the line number is absolute. */
export function subpathToLine(content: string, subpath: string): number | null {
  if (!subpath) return null;
  const lines = content.split("\n");
  const mask = proseMask(lines);
  if (subpath.startsWith("^")) {
    const esc = subpath.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const inlineRe = new RegExp(`\\s\\^${esc}\\s*$`);
    const ownRe = new RegExp(`^\\^${esc}\\s*$`);
    for (let i = 0; i < lines.length; i++) {
      if (!mask[i]) continue;
      const l = lines[i].replace(/\r$/, "");
      if (inlineRe.test(l) || ownRe.test(l.trim())) return i + 1;
    }
    return null;
  }
  const want = norm(subpath);
  for (let i = 0; i < lines.length; i++) {
    if (headingLevel(lines, mask, i) && norm(headingText(lines, i)) === want) return i + 1;
  }
  return null;
}

/** All heading texts in a note (in document order) — for `[[Note#…` completion. */
export function extractHeadings(content: string): string[] {
  const lines = content.split("\n");
  const mask = proseMask(lines);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (headingLevel(lines, mask, i)) out.push(headingText(lines, i));
  }
  return out;
}

function extractHeading(body: string, heading: string): string {
  const lines = body.split("\n");
  const mask = proseMask(lines);
  const want = norm(heading);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const lvl = headingLevel(lines, mask, i);
    if (lvl && norm(headingText(lines, i)) === want) {
      start = i;
      level = lvl;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const lvl = headingLevel(lines, mask, i);
    if (lvl && lvl <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function extractBlock(body: string, id: string): string {
  const lines = body.split("\n");
  const mask = proseMask(lines);
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inlineRe = new RegExp(`\\s\\^${esc}\\s*$`);
  const ownLineRe = new RegExp(`^\\^${esc}\\s*$`);
  let idx = -1;
  let ownLine = false;
  for (let i = 0; i < lines.length; i++) {
    if (!mask[i]) continue; // ignore ^id inside code / frontmatter
    const l = lines[i].replace(/\r$/, "");
    if (inlineRe.test(l)) {
      idx = i;
      break;
    }
    if (ownLineRe.test(l.trim())) {
      idx = i;
      ownLine = true;
      break;
    }
  }
  if (idx < 0) return "";
  const anchor = ownLine ? idx - 1 : idx;
  if (anchor < 0) return "";
  const anchorIsList = LIST_RE.test(lines[anchor].replace(/\r$/, ""));
  // Walk back to the block's start: stop at a blank line, a heading, or — when
  // the block is a list item — the previous sibling list item (so a block ref
  // on one item doesn't pull in the whole list).
  const boundary = (l: string) => {
    const t = l.replace(/\r$/, "");
    return t.trim() === "" || /^#{1,6}\s/.test(t) || (anchorIsList && LIST_RE.test(t));
  };
  let start = anchor;
  while (start > 0 && !boundary(lines[start - 1])) start--;
  return lines
    .slice(start, anchor + 1)
    .join("\n")
    .replace(inlineRe, "")
    .trimEnd();
}

// ---------------------------------------------------------------------------
// DOM rendering.

export interface TranscludeHost {
  /** Resolve a raw target (may include #sub) from a source note (rel) to the
   * destination note, or null if it can't be found. */
  resolve: (rawTarget: string, sourceRel: string) => { path: string; rel: string; name: string } | null;
  /** In-memory content for an absolute path (null if not loaded / oversized). */
  content: (absPath: string) => string | null;
  /** Read content from disk (for oversized/unloaded notes). */
  readContent: (absPath: string) => Promise<string>;
  /** Open the embedded note when its title is clicked. */
  onOpen: (rawTarget: string) => void;
  /** Resolve an image target relative to `rel` to a displayable URL. */
  resolveImage: (target: string, rel: string) => Promise<string | null>;
}

let host: TranscludeHost | null = null;
export function setTranscludeHost(h: TranscludeHost | null): void {
  host = h;
}
export function getTranscludeHost(): TranscludeHost | null {
  return host;
}

/** Render an embed using the installed host; a placeholder if none is set. */
export function renderEmbedSource(rawTarget: string, sourceRel: string): HTMLElement {
  if (!host) {
    const el = document.createElement("div");
    el.className = "embed embed-loading";
    el.textContent = "…";
    return el;
  }
  return renderEmbedElement(rawTarget, sourceRel, host, [], { n: 0 });
}

const MAX_EMBED_DEPTH = 5;
const MAX_TOTAL_EMBEDS = 200; // breadth cap across the whole tree (fan-out DoS)

function box(cls: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  return el;
}

/** Render an embed of `rawTarget` (from the note at `sourceRel`) as a DOM box:
 * a clickable title header + the transcluded content. `chain` is the stack of
 * resolved abs paths above this embed (cycle + depth guard). */
export function renderEmbedElement(
  rawTarget: string,
  sourceRel: string,
  host: TranscludeHost,
  chain: string[] = [],
  budget: { n: number } = { n: 0 },
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "embed";

  // Breadth cap across the WHOLE tree (a note full of ![[...]] must not fan out
  // exponentially and freeze the main thread).
  if (++budget.n > MAX_TOTAL_EMBEDS) {
    wrap.append(box("embed-error", "Embed limit reached"));
    return wrap;
  }

  const resolved = host.resolve(rawTarget, sourceRel);
  const { subpath } = splitSubpath(rawTarget);
  if (!resolved) {
    wrap.append(box("embed-missing", `Cannot find "${splitSubpath(rawTarget).target}" to embed`));
    return wrap;
  }
  if (chain.includes(resolved.path)) {
    wrap.append(box("embed-error", "Embed cycle — not rendered"));
    return wrap;
  }
  if (chain.length >= MAX_EMBED_DEPTH) {
    wrap.append(box("embed-error", "Embed nesting too deep"));
    return wrap;
  }

  const title = document.createElement("div");
  title.className = "embed-title";
  title.textContent = resolved.name + (subpath ? ` › ${subpath.replace(/^\^/, "^")}` : "");
  title.addEventListener("click", () => host.onOpen(rawTarget));
  wrap.append(title);

  const body = document.createElement("div");
  body.className = "embed-body";
  wrap.append(body);

  const fill = (content: string) => {
    const slice = extractSection(content, subpath);
    if (!slice) {
      body.append(box("embed-missing", subpath ? `"${subpath}" not found in ${resolved.name}` : "(empty note)"));
      return;
    }
    // renderMarkdown escapes all text and emits only known tags → innerHTML-safe.
    body.innerHTML = renderMarkdown(slice);
    const nextChain = [...chain, resolved.path];
    // Resolve images relative to the EMBEDDED note.
    body.querySelectorAll<HTMLImageElement>("img[data-basalt-img]").forEach((img) => {
      const target = img.dataset.basaltImg ?? "";
      img.removeAttribute("data-basalt-img");
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
        img.src = target;
        return;
      }
      void host.resolveImage(target, resolved.rel).then((url) => {
        if (url) img.src = url;
        else img.replaceWith(box("md-image-missing", `🖼 ${target}`));
      });
    });
    // Render math + sanitize raw HTML inside the embed (lazy, like the reader).
    if (body.querySelector("[data-math]")) void import("./math").then((m) => m.fillMath(body));
    if (body.querySelector("[data-basalt-html]")) void import("./sanitize").then((m) => m.fillRawHtml(body));
    // Recurse into nested embeds (breadth-capped via the shared budget).
    body.querySelectorAll<HTMLElement>("[data-basalt-embed]").forEach((marker) => {
      if (budget.n > MAX_TOTAL_EMBEDS) {
        marker.replaceWith(box("embed-error", "Embed limit reached"));
        return;
      }
      const t = marker.dataset.basaltEmbed ?? "";
      marker.replaceWith(renderEmbedElement(t, resolved.rel, host, nextChain, budget));
    });
  };

  const mem = host.content(resolved.path);
  if (mem !== null) {
    fill(mem);
  } else {
    body.append(box("embed-loading", "Loading…"));
    void host
      .readContent(resolved.path)
      .then((c) => {
        body.textContent = "";
        fill(c);
      })
      .catch(() => {
        body.textContent = "";
        body.append(box("embed-error", `Could not read ${resolved.name}`));
      });
  }
  return wrap;
}
