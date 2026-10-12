import { describe, expect, it } from "vitest";
import { blockDepths, internalLinkTarget, proseMask, tagRegex, wikilinkRegex } from "./markdown";

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

describe("proseMask reads lists as the editor's parser does", () => {
  const mask = (md: string) => proseMask(md.split("\n"));

  it("reads a number a list can't start with as more of the paragraph before", () => {
    expect(mask("- a\n2. ```\n   see [[Foo]] #t")).toEqual([true, true, true]);
    expect(mask("1. step\n\n- note\n2. ```\n   see [[Foo]] #t\n   ```")).toEqual([true, true, true, true, true, false]);
    expect(mask("- step one\n2. ```js see Foo")).toEqual([true, true]);
    expect(mask("1. a\n2) ```\n   x")).toEqual([true, false, false]);
  });

  it("keeps a list item open across a line that only goes on with its text", () => {
    expect(mask("   - b\n    - c\n\t\t```")).toEqual([true, true, false]);
    expect(mask("- a\n2.\n     ~~~")).toEqual([true, true, false]);
    expect(mask("   - b\n---\n\t\t```")).toEqual([true, true, true]);
  });

  it("reads on into an empty quote line or an empty item, as the parser does", () => {
    expect(mask(">\n2. ```")).toEqual([true, true]);
    expect(mask("> -\n2. ```")).toEqual([true, true]);
    expect(mask(">\n1. ```")).toEqual([true, false]);
    expect(mask("-\nfoo\n     ~~~")).toEqual([true, true, true]);
    expect(mask("-\nfoo\n   ~~~")).toEqual([true, true, false]);
  });

  it("opens no fence inside an HTML block", () => {
    expect(mask("<div>\n- ```\nx")).toEqual([true, true, true]);
    expect(mask("<div>\n```\nx\n\n```\ny")).toEqual([true, true, true, true, false, false]);
    expect(mask("<!--\n```\n-->\n```\nx")).toEqual([true, true, true, false, false]);
    expect(mask("<div>\n>\n> - ```")).toEqual([true, true, true]);
    expect(mask("text\n<span>\n```\nx")).toEqual([true, true, false, false]);
  });

  it("opens an item for each marker on a line", () => {
    expect(mask("1. - ```\n     x\n     ```\ny")).toEqual([false, false, false, true]);
    expect(mask("- ```a`b\n  x")).toEqual([true, true]);
    expect(mask("# h\n2. ```\n   x")).toEqual([true, false, false]);
    expect(mask("   - b\n    - ```\n      [[Foo]] #t")).toEqual([true, true, true]);
  });
});

describe("proseMask reads HTML blocks as Reading view shows them", () => {
  const mask = (md: string) => proseMask(md.split("\n"));

  it("reads a fence after a line that closes its tag as code", () => {
    expect(mask('<p align="center">hi</p>\n~~~\nFoo\n~~~')).toEqual([true, false, false, false]);
    expect(mask("<div>x</div>\n```\nFoo")).toEqual([true, false, false]);
    expect(mask("</div>\n~~~\nFoo")).toEqual([true, false, false]);
    expect(mask("<div>\nx\n</div>\n```\nFoo")).toEqual([true, true, true, false, false]);
  });

  it("opens no HTML block where the editor's parser doesn't", () => {
    for (const open of ["<br/>", "<br />", '<img src="a.png"/>', "<x a:b>", "<!doctype html>"]) {
      expect(mask(`${open}\n\`\`\`\n[[L]] #t\n\`\`\``), open).toEqual([true, false, false, false]);
    }
  });

  it("opens one where it does, and in a list item", () => {
    for (const open of ["<a_b>", "<source>", "<search>", "<pre>", "<!DOCTYPE html"]) expect(mask(`${open}\n\`\`\`\nx`), open).toEqual([true, true, true]);
    expect(mask("- <div>\n  ```\n  x")).toEqual([true, true, true]);
    expect(mask("<textarea>\n\n```\nx\n```")).toEqual([true, true, false, false, false]);
    expect(mask("<pre>\n\n```\nx\n```\n</pre>")).toEqual([true, true, true, true, true, true]);
    expect(mask("<!-- a -->\n```\nx")).toEqual([true, false, false]);
    expect(mask("text\n<source>\n```\nx")).toEqual([true, true, true, true]);
    expect(mask("text\n<search>\n```\nx")).toEqual([true, true, false, false]);
    expect(mask("<!x\n```\nfoo")).toEqual([true, false, false]);
  });
});

describe("proseMask reads list lines as Reading view does", () => {
  const mask = (md: string) => proseMask(md.split("\n"));

  it("reads a spaced thematic break as one, not as list items", () => {
    expect(mask("- - -\n2. ```\n   [[L]] #t\n   ```")).toEqual([true, false, false, false]);
    expect(mask("text\n01. ```\nx")).toEqual([true, true, true]);
    expect(mask("text\n1. ```\n   x")).toEqual([true, false, false]);
    expect(mask("* **\n2. ```> Foo")).toEqual([true, false]);
  });

  it("leaves no paragraph open after an item that starts with code or HTML", () => {
    expect(mask("-     code\n2. ```\n   [[L]] #t\n   ```")).toEqual([true, false, false, false]);
  });

  it("reads a lazy dash as more of the paragraph, keeping its list open", () => {
    expect(mask("0. a\n  -\n     ```\n     [[L]] #t\n     ```")).toEqual([true, true, false, false, false]);
  });

  it("remembers the lists a quote held after the quote ends", () => {
    expect(mask("> 1. a\n2. ```\n   [[L]] #t\n   ```")).toEqual([true, false, false, false]);
  });

  it("stays quick on one line of many markers", () => {
    const t0 = performance.now();
    mask("- ".repeat(20_000) + "a\n" + "  x\n".repeat(20_000) + "```");
    mask("1. ".repeat(20_000) + "a\n" + "  x\n".repeat(20_000) + "```");
    mask("> ".repeat(20_000) + "a\n" + "\n".repeat(20_000) + "```");
    mask("- ".repeat(20_000) + "```\n" + "\n".repeat(20_000));
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("proseMask reads containers as the editor's parser does", () => {
  const mask = (md: string) => proseMask(md.split("\n")).map(Number);

  it("reads a quote inside a list item as part of it", () => {
    expect(mask("+ a\n  > a\n001. a\n     ~~~")).toEqual([1, 1, 1, 0]);
    expect(mask("- - ```\n  > a\n    <div>\n<search>\n- ```js")).toEqual([0, 1, 1, 1, 1]);
    expect(mask("- a\n  > ```\n  > [[L]]\n  > ```\n  ```\n  x")).toEqual([1, 0, 0, 0, 0, 0]);
  });

  it("keeps an HTML block in its container, whatever its lines start with", () => {
    expect(mask("</div>\n- <!--\n  > ```\n  > [[L]]")).toEqual([1, 1, 1, 1]);
    expect(mask("> <div>\n>\n> ```\n> [[L]]")).toEqual([1, 1, 1, 1]);
    expect(mask("<textarea>\n\u00a0\n~~~\n[[L]]")).toEqual([1, 1, 1, 1]);
  });

  it("keeps the lists and quote a lazy line goes on in", () => {
    expect(mask("> 1. a\n  -\n2. ```\n   [[L]]")).toEqual([1, 1, 0, 0]);
    expect(mask(">\n001. a\n> \n01. a\n     ```\n     [[L]]")).toEqual([1, 1, 1, 1, 0, 0]);
    expect(mask("> a\n      > ```\n      > [[L]]")).toEqual([1, 0, 0]);
  });

  it("reads indented code where a list item ended", () => {
    expect(mask("   - </div>\n    - c\n  -\n     ```\n     [[L]]")).toEqual([1, 1, 1, 0, 0]);
  });

  it("ends a paragraph after a link reference definition", () => {
    expect(mask("[a]: b\n2. ```\n   [[L]]")).toEqual([1, 0, 0]);
    expect(mask('[a]: <b>\n"t"\n2. ```\n   [[L]]')).toEqual([1, 1, 0, 0]);
    expect(mask("1. [a]: b\n</pre></div>\n     ~~~\n     [[L]]")).toEqual([1, 1, 1, 1]);
  });

  it("ends a paragraph where a table starts", () => {
    expect(mask("- a\nb | c\n--|--\n     ~~~\n     [[L]]")).toEqual([1, 1, 1, 1, 1]);
    expect(mask("- a\nb | c\n--\n     ~~~\n     [[L]]")).toEqual([1, 1, 1, 0, 0]);
  });

  it("reads a note with CRLF line endings as one with LF", () => {
    expect(mask("- a\r\n  ```\r\n  [[L]]\r\n  ```\r\n[[M]]")).toEqual([1, 0, 0, 0, 1]);
    expect(mask("#\r\n2. ```\r\n   [[L]]\r")).toEqual([1, 0, 0]);
    expect(mask("- a\r\n|b|c|\r\n|-|-|\r\n     ~~~\r\n     [[L]]\r")).toEqual([1, 1, 1, 1, 1]);
  });

  const cases = (rows: [string, number[]][]) => {
    for (const [md, want] of rows) expect(mask(md), JSON.stringify(md)).toEqual(want);
  };

  it("reads quote markers and the columns after them", () => {
    cases([
      ["> -\n>  ```\n> a", [1, 0, 1]],
      ["> 1) a\n>\t\t```\n>\t\t[[L]]", [1, 0, 0]],
      [">     x\n>\n\t> ```\n\t> [[L]]", [1, 1, 1, 1]],
      ["> > > > ```\n> > > > [[L]]", [0, 0]],
      ["> ".repeat(100) + "```\n" + "> ".repeat(100) + "[[L]]", [0, 0]],
      // Past 100 containers in one another the markers are read as text.
      ["> ".repeat(101) + "```\n" + "> ".repeat(101) + "[[L]]", [1, 1]],
    ]);
  });

  it("reads list markers, breaks and headings as the editor's parser does", () => {
    cases([
      ["> -\n*\n    ```\n    [[L]]", [1, 1, 0, 0]],
      [" > - a\n  -\n\t```", [1, 1, 0]],
      ["> > a\n+ ```\n  [[L]]", [1, 0, 0]],
      ["1234567890. ```\n[[L]]", [1, 1]],
      ["1.```\n[[L]]", [1, 1]],
      ["- a\n---\n     ```\n     [[L]]", [1, 1, 1, 1]],
      ["a\n    ===\n2. ```\n   [[L]]", [1, 1, 1, 1]],
      ["- [ ] a\n===\n-->\n     ~~~", [1, 1, 1, 0]],
      ["#\t```\n2. ```\n   [[L]]", [1, 1, 1]],
      ["####### a\n2. ```\n   [[L]]", [1, 1, 1]],
      ["  ```\n    ```\n> <!X", [0, 0, 0]],
    ]);
  });

  it("ends an HTML block where its container ends, and splits it to Reading view's depth", () => {
    cases([
      ["> <div>\n- \t```\n  [[L]]", [1, 0, 1]],
      ["- [x] ```\n<a_b>\n````", [1, 1, 0]],
      // A first line with no `>` shows the whole block as text, unsplit.
      ["<div\n</div>\n```\nx", [1, 1, 1, 1]],
    ]);
    const deep = (n: number) => mask("<div>x</div>\n".repeat(n) + "```\n[[L]]").slice(n);
    expect(deep(39)).toEqual([0, 0]);
    expect(deep(41)).toEqual([1, 1]);
  });

  it("reads link reference definitions as the editor's parser does", () => {
    cases([
      ["[ ]: b\n2. ```\n   [[L]]", [1, 1, 1]],
      ["[a[b]: c\n2. ```\n   [[L]]", [1, 1, 1]],
      ["[a]:\n\"t\"\n2. ```\n   [[L]]", [1, 1, 0, 0]],
      ["[a]: b(c)d\n2. ```\n   [[L]]", [1, 0, 0]],
      ["[a]: <b\n]]>\n*\n   <!--\n1. ```", [1, 1, 1, 1, 1]],
      ["1. [a]: b\n(t)\n    ```\n    [[L]]", [1, 1, 0, 0]],
      ["[a]: b (t\n<span>\n> - ```\n>   [[L]]", [1, 1, 0, 0]],
    ]);
  });

  it("starts a table only where the editor's parser does", () => {
    cases([
      ["- a|b\nc | d\n--|--\n     ~~~\n     [[L]]", [1, 1, 1, 0, 0]],
      ["- a\nb \\| c\n|--|\n     ~~~\n     [[L]]", [1, 1, 1, 0, 0]],
      ["- [x] ```\n| a |\n|-|-|\n     ~~~", [1, 1, 1, 0]],
      ["1.\ta\n--- | ---\n|---|\n \t```\n \t[[L]]", [1, 1, 1, 0, 0]],
    ]);
  });
});

describe("blockDepths", () => {
  const depths = (md: string) => blockDepths(md.split("\n"));

  it("counts the quotes and lists around each line's block, lazy lines too", () => {
    expect(depths("> a\nlazy\n- b\n  > c\n    d")).toEqual([1, 1, 1, 2, 2]);
    expect(depths("1. a\n   1. b\n\n      c")).toEqual([1, 2, 2, 2]);
  });

  it("reads what follows an HTML block's closing line a level deeper, as Reading view renders it", () => {
    expect(depths("<div>x</div>\n- d\n  > e")).toEqual([0, 2, 3]);
    expect(depths("> <div>x</div>\n> - y\n\nz")).toEqual([1, 4, 4, 0]);
    expect(depths("- ".repeat(39) + "<div>x</div>\n" + "  ".repeat(39) + "y")).toEqual([39, 40]);
    expect(depths("- ".repeat(40) + "<div>x</div>\n" + "  ".repeat(40) + "y")).toEqual([40, 41]);
  });
});
