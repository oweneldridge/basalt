// A table ends at the first line without a `|`, as in Obsidian, and a table
// whose rows start with `|` ends at the first line that doesn't. GFM would
// make that line another row, so a sentence written right under a table (no
// blank line) disappeared into it.
import { Autolink, Strikethrough, Table, TaskList, type BlockParser, type MarkdownConfig } from "@lezer/markdown";

const CELLS = /^\|?(?:\s*:?-+:?\s*\|)+(?:\s*:?-+:?\s*)?$/;
/** GFM's delimiter row test, read without its leading `[>\s]*` so a long run of spaces isn't tried every way. */
export function delimiterRow(text: string): boolean {
  let i = 0;
  while (i < text.length && (text[i] === ">" || /\s/.test(text[i]))) i++;
  return CELLS.test(text.slice(i));
}

const stock = Table.parseBlock![0] as BlockParser;
// GFM's own check of the line after a piped one took seconds on a long run of spaces.
const SafeTable: MarkdownConfig = {
  defineNodes: Table.defineNodes,
  parseBlock: [{ ...stock, endLeaf: (cx, line, leaf) => line.text.includes("|", line.basePos) && delimiterRow(cx.peekLine()) && stock.endLeaf!(cx, line, leaf) }],
};
/** GFM, with tables that stay quick on any line. */
export const SafeGFM = [SafeTable, TaskList, Strikethrough, Autolink];

export const ObsidianTables: MarkdownConfig = {
  parseBlock: [
    {
      name: "ObsidianTableEnd",
      // GFM's table parser holds its rows once the delimiter line is read.
      endLeaf: (_cx, line, leaf) => {
        if (!leaf.parsers.some((p) => Array.isArray((p as { rows?: unknown }).rows))) return false;
        const text = line.text.slice(line.basePos);
        return leaf.content.trimStart().startsWith("|") ? !text.trimStart().startsWith("|") : !/(?:^|[^\\])\|/.test(text);
      },
    },
  ],
};
