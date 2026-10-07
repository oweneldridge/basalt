import { describe, expect, it } from "vitest";
import { parser, GFM } from "@lezer/markdown";
import { ObsidianTables } from "./mdTables";

const blocks = (doc: string) => {
  const tree = parser.configure([GFM, ObsidianTables]).parse(doc);
  const out: string[] = [];
  for (let c = tree.topNode.firstChild; c; c = c.nextSibling) out.push(`${c.name}:${doc.slice(c.from, c.to).split("\n").length}`);
  return out;
};

describe("tables", () => {
  it("end at the first line without a pipe, as in Obsidian", () => {
    expect(blocks("| a | b |\n| - | - |\n| 1 | 2 |\nafter\nmore\n")).toEqual(["Table:3", "Paragraph:2"]);
  });
  it("keep rows that have a pipe, and escaped pipes don't count", () => {
    expect(blocks("| a | b |\n| - | - |\n1 | 2\nx \\| y\n")).toEqual(["Table:3", "Paragraph:1"]);
  });
  it("still start right under a paragraph", () => {
    expect(blocks("first\n| a | b |\n| - | - |\n| 1 | 2 |\n")).toEqual(["Paragraph:1", "Table:3"]);
  });
});
