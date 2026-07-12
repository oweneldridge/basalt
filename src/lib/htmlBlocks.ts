// Find raw-HTML block regions in a note, for Live Preview rendering. This
// mirrors render.ts's block detection (same HTML_BLOCK tag set, same
// "gather to the matching close tag or a blank line" rule, same skipping of
// frontmatter / fenced code / $$ math) so the editor and Reading view agree on
// what is an HTML block. Returns inclusive 0-based line-index ranges.
import { HTML_BLOCK } from "./render";

export interface HtmlBlockRange {
  /** First line of the block (0-based, inclusive). */
  fromLine: number;
  /** Last line of the block (0-based, inclusive). */
  toLine: number;
}

const FENCE = /^(\s*)(`{3,}|~{3,})/;

export function htmlBlockRanges(src: string): HtmlBlockRange[] {
  const lines = src.split("\n");
  const out: HtmlBlockRange[] = [];
  let i = 0;

  // Skip leading frontmatter (--- … --- / …), exactly as render.ts does.
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i].trim() !== "---" && lines[i].trim() !== "...") i++;
    i++; // past the closing fence
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") {
      i++;
      continue;
    }
    // Fenced code consumes its whole block first → HTML-looking lines inside a
    // fence are never treated as HTML.
    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[2][0]}{${fence[2].length},}\\s*$`);
      i++;
      while (i < lines.length && !close.test(lines[i])) i++;
      i++; // past the closing fence
      continue;
    }
    // Block math ($$ … $$) likewise consumes its lines before HTML detection.
    if (trimmed.startsWith("$$")) {
      if (trimmed.length > 4 && trimmed.endsWith("$$")) {
        i++;
        continue;
      }
      i++;
      while (i < lines.length && !lines[i].trim().endsWith("$$")) i++;
      i++;
      continue;
    }
    // Raw HTML block: a line opening a block-level tag AND containing `>`.
    if (HTML_BLOCK.test(trimmed) && trimmed.includes(">")) {
      const tag = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(trimmed)?.[1].toLowerCase() ?? "";
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      const start = i;
      while (i < lines.length && lines[i].trim() !== "") {
        const closed = closeRe.test(lines[i]);
        i++;
        if (closed) break;
      }
      out.push({ fromLine: start, toLine: i - 1 });
      continue;
    }
    i++;
  }
  return out;
}
