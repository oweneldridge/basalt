// A table ends at the first line without a `|`, as in Obsidian. GFM would make
// that line another row, so a sentence written right under a table (no blank
// line) disappeared into it.
import type { MarkdownConfig } from "@lezer/markdown";

export const ObsidianTables: MarkdownConfig = {
  parseBlock: [
    {
      name: "ObsidianTableEnd",
      // GFM's table parser holds its rows once the delimiter line is read.
      endLeaf: (_cx, line, leaf) =>
        leaf.parsers.some((p) => Array.isArray((p as { rows?: unknown }).rows)) &&
        !/(?:^|[^\\])\|/.test(line.text.slice(line.basePos)),
    },
  ],
};
