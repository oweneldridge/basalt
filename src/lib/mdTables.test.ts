import { describe, expect, it } from "vitest";
import { parser, GFM } from "@lezer/markdown";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { ObsidianTables, SafeGFM, delimiterRow } from "./mdTables";
import { renderMarkdown } from "./render";
import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { editorMarkdown } from "../editor/markdownExt";

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
    expect(blocks("a | b\n--- | ---\n1 | 2\nx \\| y\n")).toEqual(["Table:3", "Paragraph:1"]);
  });
  it("written with leading pipes, end at the first row without one", () => {
    expect(blocks("| a | b |\n| - | - |\n| 1 | 2 |\nx | y\n")).toEqual(["Table:3", "Paragraph:1"]);
    expect(blocks("a | b\n--- | ---\n1 | 2\nx | y\n")).toEqual(["Table:4"]);
  });
  it("still start right under a paragraph", () => {
    expect(blocks("first\n| a | b |\n| - | - |\n| 1 | 2 |\n")).toEqual(["Paragraph:1", "Table:3"]);
  });
});

// GFM's own delimiter row pattern, the oracle for delimiterRow.
const GFM_DELIMITER = /^[>\s]*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;
const tree = (p: typeof parser, doc: string) => {
  const out: string[] = [];
  p.parse(doc).iterate({ enter: (n) => void out.push(`${n.name}:${n.from}-${n.to}`) });
  return out.join(" ");
};

describe("tables on long runs of spaces", () => {
  it("test a delimiter row as GFM does", () => {
    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
    const parts = [" ", "\t", ">", "|", "-", ":", "x", "\u00a0", "  "];
    for (let n = 0; n < 50000; n++) {
      let t = "";
      for (let k = Math.floor(rnd() * 14); k > 0; k--) t += parts[Math.floor(rnd() * parts.length)];
      expect(delimiterRow(t), JSON.stringify(t)).toBe(GFM_DELIMITER.test(t));
    }
  });
  it("parse notes as stock GFM does", () => {
    const stockP = parser.configure([GFM, ObsidianTables]);
    const safeP = parser.configure([...SafeGFM, ObsidianTables]);
    let seed = 11;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
    const lines = ["a | b", "| a | b |", "|-|-|", "--- | ---", " - | :-: ", "> | x |", "> |-|", "x", "", "  |", "- [ ] t", "~~s~~ www.a.com", "\\| y", "   ---"];
    for (let n = 0; n < 3000; n++) {
      const doc = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => lines[Math.floor(rnd() * lines.length)]).join("\n");
      expect(tree(safeP, doc), JSON.stringify(doc)).toBe(tree(stockP, doc));
    }
  });
  it("stay quick in Reading view and the editor", () => {
    const doc = "x\na|b\n" + " ".repeat(60000) + "x";
    let t = performance.now();
    renderMarkdown(doc);
    expect(performance.now() - t).toBeLessThan(1000);
    const state = EditorState.create({ doc, extensions: markdown({ base: commonmarkLanguage, extensions: editorMarkdown }) });
    t = performance.now();
    expect(ensureSyntaxTree(state, state.doc.length, 60000)).not.toBeNull();
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
