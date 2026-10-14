import { describe, expect, it } from "vitest";
import { parser, GFM } from "@lezer/markdown";
import { LinearParsers } from "./mdLinear";
import { ObsidianTasks } from "./mdTasks";
import { ObsidianTables } from "./mdTables";

const stock = parser.configure([GFM, ObsidianTasks, ObsidianTables]);
const linear = stock.configure([LinearParsers]);
const nodes = (p: typeof stock, md: string) => {
  const out: string[] = [];
  p.parse(md).iterate({ enter: (n) => void out.push(`${n.name}:${n.from}-${n.to}`) });
  return out.join(" ");
};

describe("the linear parsers", () => {
  it("read link definitions and hard breaks as lezer's own do", () => {
    for (const md of [
      "[a]: b",
      '[a]: b "t"\n[c]: d',
      "[a]:\nb\n'title'\nafter",
      "[a]: <b> (t\nu)",
      '[a]: b "x\\"y"\nz',
      "[a]: b 'x\\'\ny'",
      "[a]: b (x\\)\ny)",
      '[a]: b "x\n"y',
      '[a]: b "x" y\nz',
      "> [a]: b\n> 't'",
      "- [a]: b\n  \"t\"",
      "[ ]: x",
      "[a\\]]: b",
      "[" + "x".repeat(998) + "]: b",
      "[" + "x".repeat(999) + "]: b",
      "[" + "x".repeat(994) + "\nxx]: b",
      "a  \nb",
      "a \nb",
      "a\\\nb",
      "a    b  \nc",
    ])
      expect(nodes(linear, md), JSON.stringify(md)).toBe(nodes(stock, md));
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const parts = ["[a]:", "[a]: b", "[a]: <b>", "[a]: <b", " \"t\"", " 't'", " (t)", " \"t", " 't", " (t", "t\"", "t)", "x", " ", "  ", "\\", "\"", "(", ")", "> ", "- ", "===", "|a|b|", "|-|-|", "$$", "```", "", "[", "]", ":"];
    for (let n = 0; n < 3000; n++) {
      const lines: string[] = [];
      for (let l = 0, len = 1 + Math.floor(rnd() * 5); l < len; l++) {
        let line = "";
        for (let k = 0, m = 1 + Math.floor(rnd() * 4); k < m; k++) line += parts[Math.floor(rnd() * parts.length)];
        lines.push(line);
      }
      const md = lines.join("\n");
      expect(nodes(linear, md), JSON.stringify(md)).toBe(nodes(stock, md));
    }
  });

  it("take time linear in a definition left open and a run of spaces", () => {
    for (const md of [
      '[a]: b "\n' + "Foo text text\n".repeat(40000),
      "[a]: b 'x\n" + ("Foo ' y " + "z".repeat(50) + "\n").repeat(20000),
      "[" + "x".repeat(1200) + "\n" + "Foo text text\n".repeat(40000),
      "x" + " ".repeat(200000) + "c\n",
    ]) {
      const t0 = performance.now();
      linear.parse(md);
      expect(performance.now() - t0, md.slice(0, 12)).toBeLessThan(2000);
    }
  });
});
