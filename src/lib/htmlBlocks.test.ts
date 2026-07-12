import { describe, expect, it } from "vitest";
import { htmlBlockRanges } from "./htmlBlocks";
import { renderMarkdown } from "./render";

// Count the raw-HTML blocks the Reading view would emit, so we can assert the
// Live-Preview scanner agrees with it.
function readingBlocks(src: string): number {
  return (renderMarkdown(src).match(/class="raw-html"/g) || []).length;
}

describe("htmlBlockRanges", () => {
  it("finds the daily-note header (font-led) as a single-line block", () => {
    const src = `<font color="#ff0000"><center>Wednesday<cite>a quote</cite></center></font>`;
    expect(htmlBlockRanges(src)).toEqual([{ fromLine: 0, toLine: 0 }]);
  });

  it("spans a multi-line block to its matching close tag", () => {
    const src = 'intro\n\n<div class="box">\nhello\n</div>\n\nafter';
    expect(htmlBlockRanges(src)).toEqual([{ fromLine: 2, toLine: 4 }]);
  });

  it("ignores HTML-looking lines inside a fenced code block", () => {
    const src = "```html\n<div>not a block</div>\n```\n";
    expect(htmlBlockRanges(src)).toEqual([]);
  });

  it("skips leading frontmatter and finds a block after it", () => {
    const src = "---\ntitle: x\n---\n\n<center>Hi</center>\n";
    expect(htmlBlockRanges(src)).toEqual([{ fromLine: 4, toLine: 4 }]);
  });

  it("agrees with the Reading view on which blocks exist (parity)", () => {
    const samples = [
      `<font color="#f00"><center>H<cite>q</cite></center></font>`,
      'a\n\n<div>\nx\n</div>\n\n<p>y</p>',
      "```\n<div>code</div>\n```",
      "just prose, no html",
      "---\nk: v\n---\n<section>s</section>",
    ];
    for (const s of samples) {
      expect(htmlBlockRanges(s).length).toBe(readingBlocks(s));
    }
  });
});
