import { describe, expect, it } from "vitest";
import { internalLinkTarget, proseMask, tagRegex, wikilinkRegex } from "./markdown";

describe("internalLinkTarget", () => {
  it("reads any href that isn't a URL as a vault link, decoded", () => {
    expect(internalLinkTarget("Note.md")).toBe("Note.md");
    expect(internalLinkTarget("Note")).toBe("Note");
    expect(internalLinkTarget("My%20Note#Some%20heading")).toBe("My Note#Some heading");
    expect(internalLinkTarget("docs/paper.pdf#page=3")).toBe("docs/paper.pdf#page=3");
    expect(internalLinkTarget("#Far%20heading")).toBe("#Far heading");
    expect(internalLinkTarget("Note#^blk")).toBe("Note#^blk");
  });

  it("leaves URLs and query links alone", () => {
    expect(internalLinkTarget("https://example.com/a#b")).toBeNull();
    expect(internalLinkTarget("mailto:a@b.c")).toBeNull();
    expect(internalLinkTarget("//cdn.example/x")).toBeNull();
    expect(internalLinkTarget("?tab=t.0")).toBeNull();
    expect(internalLinkTarget("")).toBeNull();
  });

  it("keeps a malformed escape as written", () => {
    expect(internalLinkTarget("100%25%")).toBe("100%25%");
  });
});

describe("tags", () => {
  const tags = (s: string) => [...s.matchAll(tagRegex())].map((m) => m[2]);
  it("take letters of any script, digits, emoji, - _ and /", () => {
    expect(tags("#café #日本 #plain #a-b_c/d #🎉party")).toEqual(["café", "日本", "plain", "a-b_c/d", "🎉party"]);
    expect(tags("line one\n#second-line")).toEqual(["second-line"]);
  });
  it("start the text or follow a space or a formatting mark, as in Obsidian", () => {
    expect(tags("a#b \\#escaped (#paren) http://x.com/#frag")).toEqual([]);
    expect(tags("**#bold** ==#lit==")).toEqual(["bold", "lit"]);
  });
  it("start a quote's text, right after its marks", () => {
    expect(tags(">#one\n>>#two\n> >#three\nx\n>a\n>#four")).toEqual(["one", "two", "three", "four"]);
    expect(tags("a>#no -#no")).toEqual([]);
    expect(tags(" >#five\n+ >#six\n> - >#seven\n1. > >#eight")).toEqual(["five", "six", "seven", "eight"]);
  });
  it("end at punctuation", () => {
    expect(tags("see #tag, then #other. and #q?")).toEqual(["tag", "other", "q"]);
  });
});

describe("wikilinkRegex on runs of brackets", () => {
  const before = () => /(?<!(?:^|[^\\])\\(?:\\\\)*)\[\[(\[*[^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]/g;
  const all = (re: RegExp, s: string) => [...s.matchAll(re)].map((m) => [m.index, m[0], m[1], m[2]]);

  it("stays linear on a long run", () => {
    for (const s of ["[".repeat(100_000) + "x", "[".repeat(100_000) + "x\n" + "y".repeat(1000), "a [[" + "[".repeat(50_000) + "b]] c"]) {
      const t0 = performance.now();
      all(wikilinkRegex(), s);
      expect(performance.now() - t0).toBeLessThan(250);
    }
  });

  it("finds exactly the links it found before", () => {
    for (const s of ["\\[[[Foo]]", "\\[[[[Foo]]", "[[[Foo]]]", "x[[[[a]]", "\\\\[[[a]]", "[[a]] [[[b|c]]"]) {
      expect(all(wikilinkRegex(), s), s).toEqual(all(before(), s));
      expect(all(wikilinkRegex(), s), s).not.toEqual([]);
    }
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const chars = ["[", "[", "[", "]", "]", "\\", "a", "|", "\n", " ", "#"];
    for (let n = 0; n < 20_000; n++) {
      let s = "";
      for (let k = 0, len = 1 + Math.floor(rnd() * 16); k < len; k++) s += chars[Math.floor(rnd() * chars.length)];
      expect(all(wikilinkRegex(), s), JSON.stringify(s)).toEqual(all(before(), s));
    }
  });
});

describe("proseMask and list items", () => {
  const mask = (md: string) => proseMask(md.split("\n"));

  it("reads an empty `-` after a paragraph as a heading's underline, not an item", () => {
    expect(mask("text\n-\n  ~~~\n> [[Foo]] #tagA")).toEqual([true, true, false, false]);
  });

  it("lets an ordered item interrupt a paragraph only from 1", () => {
    expect(mask("para\n2. b\n   ~~~\n   x\nc")).toEqual([true, true, false, false, false]);
    expect(mask("para\n1. b\n   ~~~\n   x\nc")).toEqual([true, true, false, false, true]);
  });

  it("still opens an empty item where nothing is interrupted", () => {
    expect(mask("- a\n-\n  ~~~\n  x\nc")).toEqual([true, true, false, false, true]);
    expect(mask("- a\n  b\n-\n  ~~~\n  x\nc")).toEqual([true, true, true, false, false, true]);
  });

  it("opens an empty item after indented code, which is no paragraph", () => {
    expect(mask("    code\n-\n  ~~~\n  x\nc")).toEqual([true, true, false, false, true]);
  });

  it("reads an empty `-` after a quote's paragraph as more of it", () => {
    expect(mask("> text\n-\n  ~~~\n  x\nc")).toEqual([true, true, false, false, false]);
  });

  it("opens a quoted fence on the line that ends a list item's fence", () => {
    expect(mask("- a\n  ```\n  [[Foo]] #tagA\n> ```\n> [[Bar]] #tagB\n> ```\nafter")).toEqual([true, false, false, false, false, false, true]);
  });

  it("opens a fence on a list marker's line", () => {
    expect(mask("- ```\n  [[Foo]]\n  ```\nafter")).toEqual([false, false, false, true]);
    expect(mask("1. ~~~\n   x\n\nafter\n")).toEqual([false, false, false, true, true]);
    expect(mask("-     ```\n  x")).toEqual([true, true]);
  });
});
