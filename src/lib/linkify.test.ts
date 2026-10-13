import { describe, expect, it } from "vitest";
import { EMPHASIS_CHECK_LIMIT, keepsEmphasis, linkifyMention, linkUntilSettled, maskForMentions, mentionLines, mentionLinesFor } from "./linkify";
import { setStrictLineBreaks } from "./render";

describe("linkifyMention", () => {
  it("wraps the first bare occurrence, preserving surrounding text + casing", () => {
    expect(linkifyMention("see Project Alpha today", "Project Alpha")).toBe("see [[Project Alpha]] today");
    expect(linkifyMention("PROJECT is here", "project")).toBe("[[PROJECT]] is here"); // case-insensitive match, keeps surface
  });
  it("only the FIRST occurrence on the line is linked", () => {
    expect(linkifyMention("Alpha and Alpha", "Alpha")).toBe("[[Alpha]] and Alpha");
  });
  it("skips a mention inside inline code or an existing link", () => {
    expect(linkifyMention("`Alpha` code", "Alpha")).toBeNull();
    expect(linkifyMention("[[Alpha]] already", "Alpha")).toBeNull();
    expect(linkifyMention("[Alpha](x.md) md-link", "Alpha")).toBeNull();
  });
  it("respects word boundaries (no partial match)", () => {
    expect(linkifyMention("Alphabet soup", "Alpha")).toBeNull();
    expect(linkifyMention("an Alpha-bet", "Alpha")).toBe("an [[Alpha]]-bet");
  });
  it("returns null when the name isn't present", () => {
    expect(linkifyMention("nothing here", "Beta")).toBeNull();
  });
});

describe("linkifyMention with aliases", () => {
  it("links a mention of an alias to its note, keeping the alias as the text", () => {
    expect(linkifyMention("See the kubectl reference here", ["Kubernetes CLI Tools", "kubectl reference"], "Kubernetes CLI Tools")).toBe(
      "See the [[Kubernetes CLI Tools|kubectl reference]] here",
    );
  });
});

describe("linkifyMention, Obsidian's link form", () => {
  it("writes a folder path with the surface text as alias when given one", () => {
    expect(linkifyMention("met about meeting notes", "Meeting", "Work/Meeting")).toBe("met about [[Work/Meeting|meeting]] notes");
    expect(linkifyMention("the Meeting today", "Meeting", "Meeting")).toBe("the [[Meeting]] today");
  });
  it("leaves mentions inside URLs and tags alone", () => {
    expect(linkifyMention("see https://wiki.example/Meeting for it", "Meeting")).toBeNull();
    expect(linkifyMention("tagged #Meeting only", "Meeting")).toBeNull();
    expect(linkifyMention("https://x.example/Meeting and Meeting", "Meeting")).toBe("https://x.example/Meeting and [[Meeting]]");
  });
});

describe("Link all leaves links, URLs and autolinks alone", () => {
  it("skips a linked image, a URL holding an @, and an autolink", () => {
    expect(linkifyMention("[![s](Zqimg.png)](Zqimg.png)", "Zqimg")).toBeNull();
    expect(linkifyMention("ssh://git@github.com/owen/Zqrepo.git", "Zqrepo")).toBeNull();
    expect(linkifyMention("List of <key:Zqval> pairs", "Zqval")).toBeNull();
    expect(linkifyMention("See <urn:isbn:Zqval> and <tel:Zqval>", "Zqval")).toBeNull();
    expect(linkifyMention("mail <me@Zqhost.com> now", "Zqhost")).toBeNull();
  });
  it("still skips callout types, footnotes, references and emails", () => {
    expect(linkifyMention("> [!Zqnote] title", "Zqnote")).toBeNull();
    expect(linkifyMention("text[^Zqfn] more", "Zqfn")).toBeNull();
    expect(linkifyMention("[Zqref]: https://example.com", "Zqref")).toBeNull();
    expect(linkifyMention("[Zqref]: <https://example.com>", "Zqref")).toBeNull();
    expect(linkifyMention("write to owen@Zqmail.com", "Zqmail")).toBeNull();
    expect(linkifyMention("a <b>Zqword</b> c", "Zqword")).toBe("a <b>[[Zqword]]</b> c");
  });
});

describe("mentionLines pairs $$ outside code and comments", () => {
  it("a $$ in indented code or a comment doesn't shift the math pairs", () => {
    const indented = "Intro\n\n    code $$ here\n\nZqword here $$x$$ and Zqword\n";
    expect(mentionLines(indented)[4]).toContain("Zqword here");
    expect(mentionLines(indented)[4].trimEnd().endsWith("Zqword")).toBe(true);
    const comment = "%% a $$ in a comment %%\nZqword here $$x$$ and Zqword\n";
    expect(mentionLines(comment)[1]).toContain("Zqword here");
    expect(mentionLines(comment)[1].trimEnd().endsWith("Zqword")).toBe(true);
  });
});

describe("Link all leaves code in quotes and every kind of link alone", () => {
  it("skips fenced code inside a callout", () => {
    const lines = mentionLines("> [!tip] Run\n> ```bash\n> ~/.Qref7/lib/x.sh\n> ```\n> Qref7 here\n");
    expect(lines[2].trim()).toBe("");
    expect(lines[4]).toContain("Qref7");
  });
  it("skips reference links and images and a link's address after nested brackets", () => {
    expect(linkifyMention("see ![][Qref7] and [text][Qref7] and [Qref7][]", "Qref7")).toBeNull();
    expect(linkifyMention("[a [b [c]] d](Zqn.md)", "Zqn")).toBeNull();
    expect(linkifyMention("[a [b [c]] d](<Zqn file.md>)", "Zqn")).toBeNull();
    expect(linkifyMention("Zqn and [Zqn][ref]", "Zqn")).toBe("[[Zqn]] and [Zqn][ref]");
  });
  it("skips a shortcut reference link, an address in angle brackets that holds a ) and nested parentheses", () => {
    const link = (note: string, n: number, name: string) => linkifyMention(note.split("\n")[n], name, undefined, mentionLines(note)[n]);
    expect(link("See [Qsh8] and Qsh8.\n\n[qsh8]: https://e.com\n", 0, "Qsh8")).toBe("See [Qsh8] and [[Qsh8]].");
    expect(link("> [Qsh8]: https://e.com\n", 0, "Qsh8")).toBeNull();
    expect(linkifyMention("[l](<a)b Qsh8.md>)", "Qsh8")).toBeNull();
    expect(linkifyMention("[x [y [z]] w](a(b)Qsh8.md)", "Qsh8")).toBeNull();
    expect(linkifyMention("[see [Qsh8 [v2]] notes](x.md) then Qsh8", "Qsh8")).toBe("[see [Qsh8 [v2]] notes](x.md) then [[Qsh8]]");
    expect(linkifyMention("link text](Qsh8.md) and](<Qsh8 b.md>)", "Qsh8")).toBeNull();
  });
  it("takes a label only from a real definition", () => {
    const link = (note: string, n: number) => linkifyMention(note.split("\n")[n], "Foo", undefined, mentionLines(note)[n]);
    expect(link("%%\n[x Foo]: x.md\n%%\n\nUse [x Foo] here", 4)).toBe("Use [x [[Foo]]] here");
    expect(link("<!--\n[x Foo]: x.md\n-->\n\nUse [x Foo] here", 4)).toBe("Use [x [[Foo]]] here");
    expect(link("Para line\n[x Foo]: x.md\n\nUse [x Foo] here", 3)).toBe("Use [x [[Foo]]] here");
    expect(link("- item\n[x Foo]: x.md\n\nUse [x Foo] here", 3)).toBe("Use [x [[Foo]]] here");
    expect(link("# Heading\n[x Foo]: x.md\n\nUse [x Foo] here", 3)).toBeNull();
    expect(link("> [12:54 PM]: Foo might exist\n", 0)).toBe("> [12:54 PM]: [[Foo]] might exist");
    expect(link("- [x Foo]: x.md\n\nUse [x Foo] here", 2)).toBeNull();
    expect(mentionLines("1. >[r]:Foo\n* + [r]:-z:-:Foo\n2. - 1. [r]:---*Foo").join("")).not.toContain("Foo"); // addresses
    expect(link("- [Foo]: x.md\n\nUse [Foo] here", 0)).toBeNull();
  });
  it("skips a link whose text, address or title runs onto the next line", () => {
    const lines = (note: string) => mentionLines(note).map((l) => l.includes("Foo"));
    expect(lines("[text spanning\nFoo line](x.md \"t\nFoo\") more")).toEqual([false, false, false]);
    expect(lines("[a](\nFoo.md) end")).toEqual([false, false]);
    expect(lines("> [see the\n> Foo docs](x.md) and Foo")).toEqual([false, true]);
    expect(lines("Not [a link\n\nFoo here and Foo")).toEqual([false, false, true]);
  });
  it("masks a line of many links quickly", () => {
    const line = "[a](b.md) ".repeat(32000) + "Foo";
    const t0 = performance.now();
    expect(linkifyMention(line, "Foo")).toBe("[a](b.md) ".repeat(32000) + "[[Foo]]");
    expect(performance.now() - t0).toBeLessThan(500);
  });
  it("never throws on a note that ends inside a link's address", () => {
    for (const note of ["Foo [x](<y", "Foo [x](<y)", "Foo [x](b\\", "Foo ](<a\\\n", "Foo [x](<y\\", "Foo [x](", "Foo [x](<", "Foo [x](\\"]) {
      expect(() => mentionLines(note), note).not.toThrow();
      expect(() => maskForMentions(note), note).not.toThrow();
      expect(mentionLines(note)[0], note).toContain("Foo");
    }
  });
  it("takes a definition after a break, a heading's underline or in a quote, and a title with escapes", () => {
    const link = (note: string, n: number) => linkifyMention(note.split("\n")[n], "Foo", undefined, mentionLines(note)[n]);
    expect(link("Text\n\n---\n[Foo]: https://e.com\n\nUse [Foo] here\n", 5)).toBeNull();
    expect(link("Text\n\n***\n[Foo]: https://e.com\n\nUse [Foo] here\n", 5)).toBeNull();
    expect(link("Title\n===\n[Foo]: https://e.com\n\nUse [Foo] here\n", 4)).toBeNull();
    expect(link("Para\n> [Foo]: https://e.com\n\nUse [Foo] here\n", 3)).toBeNull();
    expect(link('[Foo]: https://e.com "a \\" b"\n\nUse [Foo] here\n', 0)).toBeNull();
    expect(link('[Foo]: https://e.com "a \\" b"\n\nUse [Foo] here\n', 2)).toBeNull();
    expect(link("[r]: https://e.com\n\n[Foo][r](\ny) end", 2)).toBeNull();
  });
  it("ends an open bracket where its paragraph ends", () => {
    const lines = (note: string) => mentionLines(note).map((l) => l.includes("Foo"));
    expect(lines("# Plan [draft\nFoo is here](x.md) more")).toEqual([false, true]);
    expect(lines("| a [ b | c |\n| --- | --- |\n| Foo | x](y.md) |")).toEqual([false, false, true]);
    expect(lines("Text [a \\\n\nFoo](x.md)")).toEqual([false, false, true]);
    expect(lines("Text [a\r\n\r\nFoo](x.md)")).toEqual([false, false, true]);
    expect(lines("Para [a\n> Foo](x.md)")).toEqual([false, true]);
    expect(lines("Text [a \\\nFoo](x.md)")).toEqual([false, false]);
  });
  it("stays quick on lines built to be slow", () => {
    const slow = ["](x".repeat(2000) + ' "' + "\nline".repeat(30000), ("> ".repeat(16) + "[Foo]: x y\n").repeat(50), "a".repeat(100000) + " Foo"];
    for (const note of slow) {
      const t0 = performance.now();
      mentionLines(note);
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });
  it("skips a reference split over two lines, and a definition's title on the next line", () => {
    const lines = (note: string) => mentionLines(note).map((l) => l.includes("Foo"));
    expect(lines("See [Foo\nnotes] end\n\n[foo notes]: https://e.com\n")).toEqual([false, false, false, false, false]);
    expect(lines("[Released in\n2024. Foo notes](x.md)\n")).toEqual([false, false, false]);
    expect(lines('[r]: https://e.com\n"about Foo"\n\nUse [r] here\n')).toEqual([false, false, false, false, false]);
    expect(lines('[r]: https://e.com "t"\n"about Foo"\n')).toEqual([false, true, false]);
    expect(lines("1. [a\n2. Foo](x.md)\n")).toEqual([false, true, false]);
  });
  it("keeps a link whole over a lazy quote line, a lone pipe or a line that only looks like a new block", () => {
    const lines = (note: string) => mentionLines(note).map((l) => l.includes("Foo"));
    expect(lines("> See [the\nFoo notes\n> here](x.md)")).toEqual([false, false, false]);
    expect(lines("Text [a\n| Foo](x.md)")).toEqual([false, false]);
    expect(lines("> [Foo\n=\n](x.md)")).toEqual([false, false, false]);
    expect(lines("[Foo\n    >](x.md)")).toEqual([false, false]);
    expect(lines("- [a\\\n2. Foo](x.md)")).toEqual([false, false]);
    expect(lines("[\n`c`>Foo](x.md)")).toEqual([false, false]);
    expect(lines("[[W]]|[\nFoo](x.md)")).toEqual([false, false]);
  });
  it("reads references and inline links the way they render", () => {
    const link = (note: string, n = 0) => linkifyMention(note.split("\n")[n], "Foo", undefined, mentionLines(note)[n]);
    expect(link("x][](Foo.md) y")).toBeNull();
    expect(link("See [x][y](Foo.md) here")).toBeNull();
    expect(link("x][a Foo] y")).toBe("x][a [[Foo]]] y");
    expect(link('Para\n[r]: https://e.com\n"Foo here"', 2)).toBe('"[[Foo]] here"');
    expect(link("1. [a\n   more\n2. Foo](x.md)", 2)).toBe("2. [[Foo]]](x.md)");
    expect(link("x@y.zz+Foo@bar.com")).toBeNull();
  });
  it("skips a definition with its address or title on the next line, and links over CRLF breaks", () => {
    const link = (note: string, n = 0) => linkifyMention(note.split("\n")[n], "Foo", undefined, mentionLines(note)[n]);
    expect(link("[Foo]:\nhttps://e.com\n\nSee [Foo] here", 0)).toBeNull();
    expect(link("[Foo]:\nhttps://e.com\n\nSee [Foo] here", 3)).toBeNull();
    expect(link('[r]: https://e.com "a Foo\nb"\n\nUse [r]', 0)).toBeNull();
    expect(link('[r]: https://e.com "a\nFoo b"\n\nUse [r]', 1)).toBeNull();
    expect(mentionLines("[x](\r\nFoo.md)\r\n")[1]).not.toContain("Foo");
  });
  it("links again while a pass links something, up to 100 passes", async () => {
    let calls = 0;
    await linkUntilSettled(async () => (++calls < 8 ? 1 : 0));
    expect(calls).toBe(8);
    calls = 0;
    await linkUntilSettled(async () => ++calls);
    expect(calls).toBe(100);
  });
  it("skips mentions Reading view shows as raw HTML or code, however the note is scanned", () => {
    const lines = (note: string) => mentionLines(note).map((l) => +l.includes("Foo"));
    const near = (note: string) => mentionLinesFor(note, /Foo/i).map((l) => +l.includes("Foo"));
    for (const note of [
      ">".repeat(21) + " <div>x</div>\n" + ">".repeat(21) + "\n" + ">".repeat(21) + " Foo",
      "> <div>\n>\n> Foo",
      "> text\n>\n> <div>\n>\n> Foo bar\n>\n> </div>",
      "---\nsnippet: |\n  ```js\n---\n<div>\nFoo\n</div>",
      "---\nsnippet: |\n  ```js\n---\n" + ">".repeat(41) + " Foo",
      "> ".repeat(21) + "<span>Foo</span>",
      "<span>a</span>\n2. ```\n   Foo",
      "<span>a</span>\n    Foo",
    ]) {
      expect(lines(note).some(Boolean), note.slice(0, 40)).toBe(false);
      expect(near(note).some(Boolean), note.slice(0, 40)).toBe(false);
    }
  });
  it("offers a callout's title at Reading view's depth limit, and text an indented line runs on", () => {
    const note = "> ".repeat(41) + "[!note] Foo";
    expect(mentionLines(note)[0]).toContain("Foo");
    // The same where HTML elsewhere has the note parsed.
    expect(mentionLines("<div>\n</div>\n\n" + note)[3]).toContain("Foo");
    expect(mentionLines("> ".repeat(41) + "[!note] T\n" + "> ".repeat(41) + "Foo")[1]).not.toContain("Foo");
    expect(mentionLines("x\n    ---\n[a]: b 'Foo'")[2]).toContain("Foo");
  });
  it("keeps each list item's length to itself when checking emphasis", () => {
    const long = "- (**Foo**) " + "word ".repeat(700);
    const short = "- (**Foo**) here";
    const at = (l: string) => [l.indexOf("Foo"), l.indexOf("Foo") + 3] as const;
    for (const lines of [[long, short], [short, long]]) {
      const keeps = lines.map((l, i) => keepsEmphasis(lines, i, ...at(l)));
      expect(keeps).toEqual(lines.map((l) => l === short));
    }
  });
  it("skips mentions nested past Reading view's 40 levels, which show as their source", () => {
    const has = (note: string) => mentionLines(note).join("\n").includes("Foo");
    // Lists nested by tabs: two columns a level, four to a tab.
    const tabbed = (n: number) =>
      Array.from({ length: n + 1 }, (_, k) => "\t".repeat(Math.floor(k / 2)) + " ".repeat((2 * k) % 4) + "- " + (k === n ? "Foo" : "a")).join("\n");
    expect(has(">".repeat(41) + " Foo")).toBe(false);
    expect(has(">".repeat(40) + " Foo")).toBe(true);
    expect(has("> ".repeat(41) + "# Foo")).toBe(false);
    expect(has("> ".repeat(40) + "# Foo")).toBe(true);
    expect(has("> ".repeat(41) + "| Foo | b |\n" + "> ".repeat(41) + "| - | - |")).toBe(false);
    expect(has("- ".repeat(41) + "Foo\n<!-- x -->")).toBe(false);
    expect(has("- ".repeat(40) + "Foo")).toBe(true);
    expect(has("> a\n\n".repeat(41) + "Foo\n<!-- x -->")).toBe(true);
    expect(has(tabbed(40))).toBe(false);
    expect(has(tabbed(39))).toBe(true);
    // Read without a parse, as a scan that skips indented code does.
    expect(mentionLines(tabbed(40), false, false).join("\n")).not.toContain("Foo");
    expect(mentionLines(tabbed(39), false, false).join("\n")).toContain("Foo");
    expect(mentionLinesFor(">".repeat(41) + " Foo", /Foo/i).join("")).not.toContain("Foo");
  });
  it("stays quick on deeply nested brackets", () => {
    for (const note of ["[x\n".repeat(8000) + "]\n".repeat(8000), "[x ".repeat(30000) + "]".repeat(30000) + " Foo"]) {
      const t0 = performance.now();
      mentionLines(note);
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });
  it("keeps a definition under a heading or break in a list, a dash underline or a table", () => {
    const link = (note: string, n: number) => linkifyMention(note.split("\n")[n], "Quokka", undefined, mentionLines(note)[n]);
    for (const head of ["1. # Heading", "- # Heading", "Title\n--", "Title\n-", "Text\n\n* ---", "| a | b |\n| - | - |\n| 1 | 2 |"]) {
      const note = `${head}\n[Quokka]: https://x.com\n\nSee [Quokka].\n`;
      const k = head.split("\n").length;
      expect(link(note, k), head).toBeNull();
      expect(link(note, k + 2), head).toBeNull();
    }
  });
  it("leaves a reference followed by an address alone, and a table only with matching cells", () => {
    const lines = (note: string) => mentionLines(note).map((l) => l.includes("Quokka"));
    expect(lines('[Quokka][r](y.md)\n\n[r]: https://x.com "a\nb\nc"\n')[0]).toBe(false);
    expect(lines("[Quokka | bar\n:-\n](x.md)\n")).toEqual([false, false, false, false]);
    expect(lines("[a\n| Quokka\n| b](x.md)")).toEqual([false, false, false]);
  });
  it("keeps a link whole over a lone bullet or an indented marker, and skips multi-line code and long titles", () => {
    const lines = (note: string) => mentionLines(note).map((l) => l.includes("Quokka"));
    expect(lines("[a\n*\nQuokka](x.md)")).toEqual([false, false, false]);
    expect(lines("[a\n+\nQuokka](x.md)")).toEqual([false, false, false]);
    expect(lines("[a\n    1. Quokka](x.md)")).toEqual([false, false]);
    expect(lines("Run `a\nQuokka b` now")).toEqual([false, false]);
    expect(lines("Run `` a ` b\nQuokka ` now")).toEqual([false, false]);
    expect(lines('[a](x.md "one\ntwo\nQuokka three") end')).toEqual([false, false, false]);
    expect(lines('[r]: https://x.com "one\ntwo\nQuokka"\n\nUse [r]')).toEqual([false, false, false, false, false]);
  });
  it("doesn't link a name right after !, a backslash or [", () => {
    expect(linkifyMention("See !Quokka here", "Quokka")).toBeNull();
    expect(linkifyMention("See \\Quokka here", "Quokka")).toBeNull();
    expect(linkifyMention("See !Quokka and Quokka", "Quokka")).toBe("See !Quokka and [[Quokka]]");
    // [[[Quokka]]] would link to "[Quokka", in Obsidian and in Reading view
    expect(linkifyMention("See [Quokka] here", "Quokka")).toBeNull();
    expect(linkifyMention("x][Quokka] y", "Quokka")).toBeNull();
    expect(linkifyMention("x \\[Quokka\\] y", "Quokka")).toBe("x \\[[[Quokka]]\\] y"); // an escaped bracket is text
  });
  it("links a name in bold or italics, but not where its brackets would change them", () => {
    expect(linkifyMention("**Quokka**: x", "Quokka")).toBe("**[[Quokka]]**: x");
    expect(linkifyMention("(*Quokka*) and _Quokka_.", "Quokka")).toBe("(*[[Quokka]]*) and _Quokka_.");
    expect(linkifyMention("a*Quokka*b", "Quokka")).toBeNull();
    expect(linkifyMention("*Quokka*a then Quokka", "Quokka")).toBe("*Quokka*a then [[Quokka]]");
    expect(linkifyMention("=Quokka*-* then Quokka", "Quokka")).toBe("=Quokka*-* then [[Quokka]]");
    expect(linkifyMention("'===[===Quokka", "Quokka")).toBeNull();
    const note = "*a\nQuokka*b";
    const lines = note.split("\n");
    expect(linkifyMention(lines[1], "Quokka", undefined, mentionLines(note)[1], lines, 1)).toBeNull();
  });
  it("pairs code spans in order over the paragraph, as CommonMark does", () => {
    const open = (note: string) => mentionLines(note).map((l) => l.includes("Quokka"));
    expect(open("`a\nb `Quokka` c`")).toEqual([false, true]); // `a\nb ` is the span
    expect(open("`z\nQuokka|1*`--2. `")).toEqual([false, false]);
    expect(open("- a `b\n- Quokka` c")).toEqual([false, true]); // a new item ends the paragraph
    expect(open("\\`Quokka` here")).toEqual([true]); // an escaped backtick opens nothing
    // after `\``, a span opens with the second backtick (CommonMark) or not at all (the editor)
    expect(open("`x\\` y \\`` z `Quokka` w")).toEqual([false]);
    expect(open("\\``Quokka` b`")).toEqual([false]);
    expect(open("see <Foo:1--<'Quokka> here")).toEqual([false]); // an autolink
    expect(open("`Quokka [[b` and `Quokka $a`$")).toEqual([false]); // code wins over what starts inside it
    expect(open("`a\n[|\\`[r]: Quokka")).toEqual([false, true]); // a bracket in a label isn't one, so its backtick closes the span
  });
  it("reads where a paragraph ends by columns, so code and links run on as they render", () => {
    const shut = (note: string) => mentionLines(note).every((l) => !l.includes("Quokka"));
    expect(shut("`\n\t- Quokka`")).toBe(true); // a tab is four columns: no list item here
    expect(shut("`\n    # Quokka`")).toBe(true); // nor a heading
    expect(shut("`\n#\tQuokka`")).toBe(true); // `#` and a tab, which the editor reads as text
    expect(shut("o\n2. `\n3)\tQuokka`")).toBe(true); // `2.` carries on the paragraph, so `3)` can't break it
    expect(shut("[r]:`)\nQuokka`")).toBe(true); // an unbalanced `)` isn't an address
    expect(shut("![[\nQuokka]](d)")).toBe(true); // an image's text, not a wikilink
    expect(shut("[][\nQuokka]")).toBe(true); // a label over a line break
    expect(shut("[][\\[:Quokka]")).toBe(true); // and one with an escaped bracket
    expect(shut("[\nQuokka]:a")).toBe(true); // a definition's label over a line break
    expect(shut("[-Quokka\n]:-")).toBe(true);
    expect(shut("[](Quokka`)`")).toBe(true); // an address runs over code, as it's parsed
    expect(shut("|#Quokka|\n|-|")).toBe(true); // a tag starts the table's cell
    expect(shut("[|Quokka<!--]()--->")).toBe(true); // `--` inside: no comment, so a link
    expect(shut("|`Quokka\n[o]:`")).toBe(true); // a `|` alone isn't a table, so no definition can follow it
    expect(shut("o\n    # `Quokka\n`")).toBe(true); // four spaces in, a paragraph's line isn't a heading
    expect(shut("o\n    # [\nQuokka]()")).toBe(true); // nor for a link
    expect(shut("[][![]Quokka]()")).toBe(true); // a bracket after `[]` may open a link of its own
    expect(shut("2\n[o]:[\nQuokka]()")).toBe(true); // in a paragraph, `[o]:[` isn't a definition
    const open = (note: string) => mentionLines(note).some((l) => l.includes("Quokka"));
    expect(open("`a`#Quokka and [x](y)#Quokka")).toBe(true); // a `#` after code or a link isn't a tag's
    expect(open("<o>[o]:Quokka")).toBe(true); // nor is a blanked tag room for a definition
    expect(shut("- a\n    # Quokka")).toBe(false); // in the item, a heading
  });
  it("leaves raw HTML alone, as Reading view shows it", () => {
    const open = (note: string) => mentionLines(note).map((l) => l.includes("Quokka"));
    expect(open("<div>\nQuokka here\n</div>\n\nQuokka")).toEqual([false, false, false, false, true]);
    expect(open("<div>\nx\n</div>\nQuokka after the close")).toEqual([false, false, false, true]);
    expect(open('<img\n  alt="Quokka" src="a.png">')).toEqual([false, false]);
    expect(open("<?x\nQuokka\n?>\n\n<!F x\nQuokka y\n>")).toEqual([false, false, false, false, false, false, false]);
  });
  it("leaves a tag right after a quote's marks alone", () => {
    expect(linkifyMention(">#Quokka", "Quokka")).toBeNull();
    expect(mentionLines("> [!note]\n>#Quokka")[1]).not.toContain("Quokka");
  });
  it("doesn't link after a [[ that nothing closes on its line", () => {
    // the link's ]] would close it: [[a [[Quokka]] reads as one link to "a [[Quokka"
    expect(linkifyMention("See [[a and Quokka", "Quokka")).toBeNull();
    expect(linkifyMention("x.md[[Foo]:b:Quokka", "Quokka")).toBeNull();
    expect(linkifyMention("Quokka then [[a", "Quokka")).toBe("[[Quokka]] then [[a");
    expect(linkifyMention("[[]] Quokka", "Quokka")).toBe("[[]] [[Quokka]]");
    expect(mentionLines("See [[a\nQuokka")[1]).toContain("Quokka");
  });
  it("stays quick on long space runs, long bracket lines, runs of ]( and long runs of quote and list marks", () => {
    const slow = [
      "[a]: b" + " ".repeat(40000) + "c\n",
      "[a\n" + " ".repeat(40000) + "\nb](x.md)\n",
      "[a] ".repeat(400000),
      "[x][y](z) ".repeat(100000),
      "](".repeat(20000),
      "[a\n" + "> ".repeat(20000) + "b](c) #t\n",
      "-  ".repeat(20000) + "b\n",
      "`a\n" + "``".repeat(20000) + "\n`",
      "[x\n".repeat(20000) + "]: y\n",
      "1. ".repeat(30000) + "> [!a] Foo",
      "- >".repeat(30000) + " b\n[a]: Foo",
      "- ".repeat(30000) + "b\n[a]: Foo",
      "- - ".repeat(20000) + "- - b\n[a]: Foo",
      // Callouts 40 deep, none at the limit: nothing to parse for.
      Array.from({ length: 40 }, (_, i) => "> ".repeat(i + 1) + "[!note] T").join("\n") + "\n" + ("> ".repeat(40) + "line\n").repeat(12000),
    ];
    for (const note of slow) {
      const t0 = performance.now();
      mentionLines(note);
      expect(performance.now() - t0, note.slice(0, 12)).toBeLessThan(1500);
    }
  });
  it("reads where a paragraph runs on by its own text's column", () => {
    const offered = (note: string) => [mentionLines(note), mentionLinesFor(note, /Foo/i)].map((ls) => ls.at(-1)!.includes("Foo"));
    for (const [note, want] of [
      ["x\n   ---\n[a]: b 'Foo'", false],
      ["x\n    ---\n[a]: b 'Foo'", true],
      ["x\n\t---\n[a]: b 'Foo'", true],
      ["x\n  \t---\n[a]: b 'Foo'", true],
      ["> x\n> ---\n> [a]: b 'Foo'", false],
      ["> x\n>     ---\n> [a]: b 'Foo'", true],
      ["- x\n    ---\n[a]: b 'Foo'", false],
      ["1. x\n    ---\n[a]: b 'Foo'", false],
      ["- x\n    ===\n[a]: b 'Foo'", false],
      ["- x\n      ---\n[a]: b 'Foo'", true],
      ["1) ".repeat(48) + "</center>\n[a]: b 'Foo'", false],
      ["1. </details>\n[a]: b 'Foo'", false],
    ] as const)
      expect(offered(note), note).toEqual([want, want]);
  });
  it("hides the first of two definitions of a label", () => {
    expect(mentionLines("[Foo]: x\n[Foo]: y\n\n[Foo]")[3]).not.toContain("Foo");
  });
  it("skips mentions in a math block nothing closes, or deep blocks a comment joins", () => {
    for (const [note, want] of [
      ["$$\nx\nFoo", false],
      ["> $$\n> x\n> Foo", false],
      ["$$ x $$\n$$\nFoo", false],
      ["a $$ x\nFoo", true],
      ["- $$\n- Foo", true],
      ["> $$\nFoo", true],
      [">".repeat(41) + " a %%x\n\ny%% Foo", false],
    ] as const) {
      expect(mentionLines(note).join("\n").includes("Foo"), note).toBe(want);
      expect(mentionLinesFor(note, /Foo/i).join("\n").includes("Foo"), note).toBe(want);
    }
  });
  it("reads frontmatter after a byte order mark as frontmatter, through its closing line", () => {
    expect(mentionLines("\uFEFF---\n<div>\n---\nFoo")[3]).toContain("Foo");
    expect(mentionLines("---\na: 1\n---\n    Foo\n<div>")[3]).not.toContain("Foo");
    expect(mentionLines("---\na: 1\n...\n    Foo")[3]).not.toContain("Foo");
  });
  it("reads a callout's body as a note of its own when looking near a mention", () => {
    for (const note of ["> [!note] T\n> 2. ```\n>    Foo", "> [!note] T\n> 2. ```Foo"]) {
      expect(mentionLines(note).at(-1), note).not.toContain("Foo");
      expect(mentionLinesFor(note, /Foo/i).at(-1), note).not.toContain("Foo");
    }
  });
  it("offers a callout's title just past the depth limit only on its quote's first line", () => {
    const q = (n: number) => "> ".repeat(n);
    for (const [note, want] of [
      [q(41) + "[!note] A\n" + q(41) + "\n" + q(41) + "[!note] Foo", false],
      [q(41) + "text\n" + q(41) + "\n" + q(41) + "[!note] Foo", false],
      [q(41) + "[!note] A\n\n" + q(41) + "[!note] Foo", true],
      [q(41) + "[!note] A\n" + q(42) + "[!note] Foo", false],
      [q(42) + "[!note] A\n" + q(41) + "[!note] Foo", false],
      ["- ".repeat(39) + "> > [!tip] Foo", true],
      ["- ".repeat(40) + "> [!tip] Foo", true],
      ["<div>\n</div>\n\n" + "- ".repeat(40) + "> [!tip] Foo", true],
      [q(40) + "- [!note] Foo", false],
      [q(40) + "1. [!note] Foo", false],
      ["- ".repeat(41) + "[!note] Foo", false],
    ] as const) {
      expect(mentionLines(note).at(-1)!.includes("Foo"), note.slice(-30)).toBe(want);
      expect(mentionLinesFor(note, /Foo/i).at(-1)!.includes("Foo"), note.slice(-30)).toBe(want);
    }
  });
  it("reads a line hidden whole, a callout's title and a lone === as Reading view does", () => {
    // Whether the last mention on the last line is offered.
    const offered = (note: string) =>
      [mentionLines(note), mentionLinesFor(note, /Foo/i)].map((ls) => {
        const last = note.split("\n").at(-1)!;
        const at = last.lastIndexOf("Foo");
        return ls.at(-1)!.slice(at, at + 3) === "Foo";
      });
    for (const [note, want] of [
      ["a\n<b>\n[a]: b 'Foo'", true],
      ["a\n$$x$$\n[a]: b 'Foo'", true],
      ["a\n          <b>\n[a]: b 'Foo'", true],
      ["- a\n  <b>\n  [a]: b 'Foo'", true],
      ["> a\n<b>\n[a]: b 'Foo'", true],
      ["Foo\r\n" + " ".repeat(63) + "<script>\n" + "\t".repeat(20) + "[a]: b 'Foo'", true],
      ["a\n<span>x</span>\n[a]: b 'Foo'", false],
      ["a\n<!-- x -->\n[a]: b 'Foo'", false],
      ["a\n> <b>\n[a]: b 'Foo'", false],
      ["a\n>     <b>\n[a]: b 'Foo'", false],
      ["a\n%%x%%\n[a]: b 'Foo'", false],
      ["a\n- <b>\n[a]: b 'Foo'", false],
      ["1. ".repeat(39) + "-|-\n" + " ".repeat(42) + "</pre>\n[a]: b 'Foo'", false],
      ["> - ".repeat(20) + "<div>x</div>\n[a]: b 'Foo'", false],
      ["  Foo\r\n" + ">\t".repeat(42) + "<center>x</center>\n[a]: b 'Foo'", false],
      ["1) ".repeat(20) + "> \n[a]: b 'Foo'", false],
      ["> [!note] Foo\n> [a]: b 'Foo'", false],
      ["> > [!tip] Foo\n[a]: b 'Foo'", false],
      ["===\n[a]: b 'Foo'", true],
      ["> a\n===\n[a]: b 'Foo'", true],
      ["> > [!tip] T\n===\n[a]: b 'Foo'", true],
      ["a\n===\n[a]: b 'Foo'", false],
      ["<b></b>\n[a]: b 'Foo'", true],
      ["<b/>\n[a]: b 'Foo'", true],
      ["a\n> <b></b>\n[a]: b 'Foo'", true],
      ["- <b></b>\n[a]: b 'Foo'", true],
      ["<b>\n[a]: b 'Foo'", false],
      ["</b >\n[a]: b 'Foo'", false],
      ["$$x$$\n[a]: b 'Foo'", false],
      ["-\t-\t\n" + " ".repeat(78) + "[a]: b 'Foo'", false],
      ["- x\n    > [!note] T\n[a]: b 'Foo'", false],
      ["> - ".repeat(20) + "> <pre>\n" + " ".repeat(40) + "> [!note] Foo\n" + " ".repeat(90) + "[a]: b 'Foo'", true],
      [">".repeat(41) + " <!--\n" + "> ".repeat(39) + "[!note]- T\n" + "\t".repeat(50) + "[a]: b 'Foo'", true],
    ] as const)
      expect(offered(note), note).toEqual([want, want]);
  });
  it("ends a definition's open title at a line that starts a block", () => {
    for (const note of ["[a]: b 'x\n- Foo'", "[a]: b 'x\n# Foo'", "[a]: b 'x\n> Foo'", "[a]: b 'x\n" + "* ".repeat(39) + "Foo'"]) {
      expect(mentionLines(note)[1], note).toContain("Foo");
      expect(mentionLinesFor(note, /Foo/i)[1], note).toContain("Foo");
    }
    expect(mentionLines("[a]: b 'x\nFoo'")[1]).not.toContain("Foo");
  });
  it("reads math blocks, HTML split by a closing tag and deep lazy lines as Reading view does", () => {
    const at = (note: string) => {
      const lines = note.split("\n");
      const i = lines.length - 1;
      const c = lines[i].lastIndexOf("Foo");
      return [mentionLines(note), mentionLinesFor(note, /Foo/i)].map((ls) => ls[i].slice(c, c + 3) === "Foo");
    };
    for (const [note, want] of [
      ["  </div>\n$$\n$$ Foo $$", false],
      ["$$\nx\n$$ Foo", false],
      ["---\n<div>\n---\n$$\n" + "\t".repeat(21) + "$$ Foo $$", false],
      ["</pre>\n- $$\n    # Foo", false],
      ["---\n<div>\n---\n</pre>\n" + "- ".repeat(38) + "$$\n" + " ".repeat(129) + "# Foo", false],
      ["> [!note] T\n" + " ".repeat(300) + "<div>Foo", false],
      [">".repeat(41) + " $$ x $$\n Foo | b", true],
      [">".repeat(43) + " ---\nFoo", true],
      ["- ".repeat(99) + "```\nFoo | b", true],
      ["1) ".repeat(43) + "---\nFoo", true],
      ["> ".repeat(21) + "\n" + " ".repeat(78) + "</details>\n[a]: b 'Foo'", false],
      ["- ".repeat(41) + "a b\n" + " ".repeat(76) + ">\n" + " ".repeat(82) + "<script>\n" + " ".repeat(90) + "[a]: b 'Foo'", false],
      ["   %% x\n" + "* ".repeat(38) + "%% Foo", false],
      ["a\n<b>x</b>\n[a]: b 'Foo'", true],
      ["> [!note] T\n> x\n\n```\ncode\n```\n" + "> ".repeat(41) + "Foo", false],
      // A lazy line after the title starts the body; later ones run on its text.
      ["> [!note] T\n2. ```\n   Foo", false],
      ["> [!note] T\n> a\n2. ```\n   Foo", true],
      ["> [!note] T\n> a\n    # Foo", true],
      ["> [!note] T\n> a\n    ```\n> Foo", true],
      ["a\n- $$x$$\n[a]: b 'Foo'", false],
      ["<b></b>\n   ---\n[a]: b 'Foo'", false],
      ["> ".repeat(45) + "<center>\n" + ">".repeat(41) + " <!--\n" + "> ".repeat(39) + "[!note]- T\n" + "\t".repeat(50) + "[a]: b 'Foo'", true],
      ["a\n    > [!note] T\n[a]: b 'Foo'", true],
      ["* ".repeat(38) + "> > [!tip] Foo\n[a]: b 'Foo'", false],
      ["a\n- %%x%%\n[a]: b 'Foo'", false],
      ["    x\nFoo\n\n> [!note] T\n> 2. ```Foo", false],
      ["Foo\n\n> [!note] T\n> 2. ```Foo", false],
      ["a\n    $$x$$\n[a]: b 'Foo'", true],
    ] as const)
      expect(at(note), note.slice(-40)).toEqual([want, want]);
  });
  it("reads definitions, paragraphs, callout titles and math blocks as Reading view does", () => {
    // Whether the mention "Foo" (wherever it is) is offered, by both scans.
    const offered = (note: string) => {
      const lines = note.split("\n");
      const i = lines.findIndex((l) => l.includes("Foo"));
      const c = lines[i].indexOf("Foo");
      return [mentionLines(note), mentionLinesFor(note, /Foo/i)].map((ls) => ls[i].slice(c, c + 3) === "Foo");
    };
    for (const [note, want] of [
      // A definition's title stops at a block that starts by its indent.
      ['[a]: b "x\n    - Foo"', false],
      ['[a]: b "x\n    # Foo"', false],
      ['- [a]: b "x\n      - Foo"', false],
      ['[a]: b "x\n- Foo"', true],
      ['- [a]: b "x\n  - Foo"', true],
      // A paragraph's own indent isn't its container's.
      [' a\n    ---\n[a]: b "Foo"', true],
      ['  a\n    ===\n[a]: b "Foo"', true],
      ['<b>b</b> a\n    ---\n[a]: b "Foo"', true],
      [' a\n    > [!note] T\n[a]: b "Foo"', true],
      ['-   x\n      ---\n[a]: b "Foo"', false],
      // Under a callout's title, `=` underlines it for what's outside.
      ["> [!e]\n> =\n[a]:Foo", false],
      ["> [!e]\n> =\n> [a]:Foo", true],
      ["> [!note] T\n> ===\n> [a]: b 'Foo'", true],
      // A definition's title stops at an underline in its own quote, or a
      // callout's body, and at an empty item outside its list.
      ["[a]:b '\n-\nFoo'", true],
      ["- [a]: b '\n-\nFoo'", true],
      ["- [a]: b '\n*\nFoo'", true],
      ["- [a]: b '\n=\nFoo'", false],
      ["[a]: b '\n*\nFoo'", false],
      ["> [a]: b '\n-\nFoo'", false],
      ["> [!e]\n> [a]: b '\n-\nFoo'", true],
      ["1. >[!e]\n[a]:b '\n-\nFoo'", true],
      // An underline outside a callout's quote is a break, not the title's.
      ["1. >[!e]\n---\n[a]:Foo", false],
      ["- > [!e]\n  > =\n    > [a]:Foo", true],
      // Lazy text stays in its quote's paragraph, unless it starts a block.
      ["> x\n|\n> [a]: b 'Foo'", true],
      ["> x\n- \n[a]: b 'Foo'", true],
      ["> x\n- y\n> [!e]\n[a]:Foo", false],
      ["> x\n|\n>> [!e]\n[a]:Foo", false],
      [">- \n|\n>[!e]\n[a]:Foo", false],
      ["> x\n|\n>[!e]\n[a]:Foo", true],
      ["x\n- \n[a]: b 'Foo'", false],
      ["- \n[a]: b 'Foo'", false],
      // A callout's title opens its own quote, not one a list item holds that
      // it doesn't reach.
      ["- >\n>[!e]\n[a]:Foo", false],
      [">\n- >[!e]\n[a]:Foo", false],
      ["- > a\n> [!e]\n[a]:Foo", false],
      ["- > a\n  > [!e]\n[a]:Foo", true],
      ["-\t> a\n\t> [!e]\n[a]:Foo", true],
      ["-\t> a\n > [!e]\n[a]:Foo", false],
      [">     > a\n> > [!e]\n[a]:Foo", false],
      ["- > > a\n  > - > [!e]\n[a]:Foo", false],
      // Text under a title starts its body, which a lazy line runs on.
      [">>[!e]\n'\n>[a]:Foo", true],
      // A lone marker under a title keeps the quotes open, though the body
      // reads it as an empty item.
      [">>>[!e]\n-\n>>[!e]\n>>[a]:\nFoo", true],
      [">>>[!e]\n-\no\n>>[a]:\nFoo", true],
      ["> - a\n-\n> [!e]\n[a]:Foo", false],
      ["> x\n\n> [!e]\n[a]:Foo", false],
      // A table's header ends a definition's title.
      ["[a]:\n-|-\n-|-\n[a]:Foo", false],
      ["[a]: b '\nx|y\n-|-\nFoo'", true],
      ["[a]: b '\nx|y|z\n-|-\nFoo'", false],
      // A lazy line's indent counts from its own start, so four columns make
      // it text, not a block.
      [">- [a]:b '\n\t# Foo'", false],
      [">- $\n    ---\n[a]:Foo", true],
      [">>]\nT\n>1. >[!e]\n[a]:Foo", false],
      ["> x\n    - y\n> [!e]\n[a]:Foo", true],
      // An item holding only an empty item starts a list, with no paragraph.
      ["$\n- -\n[a]:Foo", false],
      ["$\n- >\n[a]:Foo", false],
      ["> $\n- -\n[a]:Foo", false],
      ["$\n2. -\n[a]:Foo", true],
      ["x\n* \n[a]: b 'Foo'", true],
      // A lone marker starts an item in a list of its kind, and an underline
      // only underlines from inside the paragraph's item.
      ["- a\n-\n[a]: b 'Foo'", false],
      ["* a\n-\n[a]: b 'Foo'", false],
      ["1. a\n2.\n[a]: b 'Foo'", false],
      ["> - a\n-\n[a]: b 'Foo'", false],
      ["1. a\n-\n[a]: b 'Foo'", true],
      ["- a\n2.\n[a]: b 'Foo'", true],
      ["- a\n=\n[a]: b 'Foo'", true],
      ["1. a\n   -\n[a]: b 'Foo'", false],
      ["a\n-\n[a]: b 'Foo'", false],
      ["- a\n\t\t-\n[a]: b 'Foo'", true],
      // A new item starts a new paragraph, at its own column.
      ["- o\n - '\n      =\n[a]:Foo", false],
      ["1. a\n2. b\n      =\n[a]:Foo", false],
      ["1. a\n10. b\n       =\n[a]:Foo", false],
      // A title's quote is read against the paragraph's first line.
      ["- >o\n=\n  >[!e]\n[a]:Foo", true],
      ["- >[!e]\n    1. >[!e]\n[a]:Foo", false],
      // A definition run on lazily in a callout's body is read there.
      [">>[!e]\n[a]:b (\n= =\n>Foo)", false],
      // Text after an HTML block's first lines is part of it to the parser,
      // so a line outside its quote doesn't run that text on.
      ["></v>\n>>g\n)\n>[a]:Foo", false],
      ["></v>\n>>g\n>[a]:Foo", true],
      ["></n>\n>[!e]\n[a]:Foo", false],
      ["><div></div>\n>[!p]\n[a]:Foo", false],
      ["><div></div>\n>\n>[!p]\n[a]:Foo", false],
      ["><div></div>\n\n>x\n[a]:Foo", true],
      ["><!-->\n>->\n[a]:Foo", true],
      ["><pre>\n>x\n)\n>[a]:Foo", false],
      ["><pre></pre>\n>x\n)\n>[a]:Foo", true],
      // A line reads as it does with its comments taken out.
      ["(\n1.%%%%\n[a]:Foo", true],
      ["%%x%% [a]: b 'Foo'", false],
      [">$$x$$\n>g\n)\n>[a]:Foo", true],
      // A break or heading in a list item's quote isn't a paragraph.
      ["- >***\n[a]:Foo", false],
      ["- > # h\n[a]:Foo", false],
      ["- > x\n[a]:Foo", true],
      ["- * * *\n[a]:Foo", false],
      ["- -x- - -\n[a]:Foo", true],
      ["- _ _\n[a]:Foo", true],
      ["- _ _ _\n[a]:Foo", false],
      ["`a\r\n#\r\nFoo`", false],
      ["- - * *\n[a]:Foo", false],
      ["1. ######\n[a]:Foo", false],
      ["1. #######\n[a]:Foo", true],
      // `#` and a tab or a carriage return is text to the parser.
      ["- #\r\n[a]:Foo", true],
      ["a\n#\tb\n[a]: b 'Foo'", true],
      ["a\r\n#\r\n[a]: b 'Foo'", true],
      ["[a]: b '\n#\tx\nFoo'", false],
      ["a\n# \n[a]: b 'Foo'", false],
      [">>>[!e]\n-\n[a]:b (\n= =\n>Foo)", false],
      ["- o\n=\n  >[!e]\n[a]:Foo", false],
      // A quote's empty first line starts nothing.
      ["> \n> [a]: b 'Foo'", false],
      ["> \n[a]: b 'Foo'", false],
      // A fence inside a comment opens nothing.
      ["%%\n~~~\n%%Foo", true],
      ["%%\n~~~\n%%\nFoo", true],
      ["%%x%%\n~~~\nFoo", false],
      ["$$\n```\n$$\nFoo", true],
      ["```\n$$\n```\nFoo", true],
      ["-\t".repeat(50) + "2. ```\n" + " ".repeat(100) + "%%\n" + " ".repeat(200) + "%% Foo", true],
      // Math inside a title's line is its text.
      [">[a]:b \"\n$$$$o\nFoo\"", false],
      // A definition doesn't run onto hidden text.
      ["[a]: b '\n- <div>\nFoo'", true],
      ["[a]: b '\n* <div>\nFoo'", true],
      // A callout's body nested past the limit shows as its source.
      ["> [!note] T\n> " + "- ".repeat(45) + "Foo", false],
      ["> [!tip] x\n> ```\n> ```\n\n> [!note] T\n> " + "- ".repeat(45) + "Foo", false],
      ["> [!note] T\n> [a]:\n> $$$$ Foo", true],
      ["> [!note] T\n> [a]:\n> <i>Foo", true],
      ['[a]:\n- "Foo"', true],
      // Math over lines is a block that opens its line, as parsed.
      ["Cost $$ high\n> $$\n> x\n\nFoo\n$$", true],
      ["x $$\n\t$$ Foo\ny $$", true],
      ["o $$\n1.$$\nFoo\n$$", true],
      ["a $$\nFoo\n$$", true],
      ["- $$\n> [!note]\n\n- > $$ Foo", false],
      ["%%x%%$$\nFoo", false],
      [">[!e]\n$$x$$\nFoo", true],
      // Past four callouts inside one another the next is a quote, its text
      // read in place.
      [Array.from({ length: 5 }, (_, i) => "> ".repeat(i + 1) + "[!note] T").join("\n") + "\n" + "> ".repeat(5) + "2. ```\n" + "> ".repeat(5) + "   Foo", true],
      [Array.from({ length: 4 }, (_, i) => "> ".repeat(i + 1) + "[!note] T").join("\n") + "\n" + "> ".repeat(4) + "2. ```\n" + "> ".repeat(4) + "   Foo", false],
    ] as const)
      expect(offered(note), note).toEqual([want, want]);
  });
  it("stays quick on deep quotes around a paragraph, and long marker runs before HTML", () => {
    for (const note of [
      "[a]: http://x\n\n" + "> ".repeat(40) + "text\n" + "> ".repeat(40),
      ("> ".repeat(500) + "<div>\n").repeat(8000),
      ("1".repeat(500) + " <div>\n").repeat(200),
    ]) {
      const t0 = performance.now();
      mentionLines(note);
      expect(performance.now() - t0, note.slice(0, 12)).toBeLessThan(1500);
    }
  });
  it("reads a definition on a CRLF line, and leaves a bracket with brackets in it after a link's text", () => {
    expect(mentionLines("[Foo]: x.md\r\n[Foo] here\r\n")[1]).not.toContain("Foo");
    expect(mentionLines('[r][["|-|Foo(-[- ===]')[0]).not.toContain("Foo");
    expect(mentionLines("[r][[x][Foo] and [r][a[x][Foo]")[0]).not.toContain("Foo");
  });
});

describe("emphasis around a mention, with another link in the paragraph", () => {
  it("still links it, as when the paragraph has no other link", () => {
    expect(linkifyMention("**Git Workflow**: see [[Other]]", "Workflow")).toBe("**Git [[Workflow]]**: see [[Other]]");
    expect(linkifyMention("==Git Workflow==: a [[Other]]", "Workflow")).toBe("==Git [[Workflow]]==: a [[Other]]");
    const lines = ["**Git Workflow**: see", "[[Other]] too"];
    expect(linkifyMention(lines[0], "Workflow", undefined, undefined, lines, 0)).toBe("**Git [[Workflow]]**: see");
  });

  it("still refuses one that would break the emphasis", () => {
    expect(linkifyMention("*Workflow*a see [[Other]]", "Workflow")).toBeNull();
  });
});

describe("checking emphasis stays quick", () => {
  it("checks each list item on its own, not the whole list", () => {
    const lines = Array.from({ length: 1600 }, (_, i) => `- item ${i} (*Foo*) [[Bar]]`);
    const t0 = performance.now();
    for (let i = 0; i < lines.length; i++) expect(keepsEmphasis(lines, i, lines[i].indexOf("Foo"), lines[i].indexOf("Foo") + 3)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  const keeps = (md: string) => {
    const lines = md.split("\n");
    const i = lines.findIndex((l) => l.includes("Foo"));
    return keepsEmphasis(lines, i, lines[i].indexOf("Foo"), lines[i].indexOf("Foo") + 3);
  };

  it("stops at a heading or another list item", () => {
    expect(keeps("# Head *x\nFoo*y")).toBe(true);
    expect(keeps("- a *x\n- Foo*y")).toBe(true);
    expect(keeps("1. a *x\n2. Foo*y")).toBe(true);
    expect(keeps("a *x\nFoo*y")).toBe(false);
  });

  it("reads on through lines that only look like a new block", () => {
    for (const md of ["**Launched in\n2024. Foo**v2 shipped", "*a\n| Foo*b", "foo *bar\n2. Foo*baz", "*a\n    # Foo*b", "*a\n    - Foo*b", "*a\n*\nFoo*b", "$$\n|*Foo"]) {
      expect(keeps(md), md).toBe(false);
    }
    for (const md of ["o\n2. <span>*Foo", "<span>*Foo\n-", "t\n    - o*Foo\no", "*a\n%%c%%\n- Foo*b", "*a <b>\n- Foo*b"]) expect(keeps(md), md).toBe(true);
  });

  it("reads a number as a list item only where a list can start or go on", () => {
    expect(keepsEmphasis(["x", "", "7. a *x", "8. Foo*y"], 3, 3, 6)).toBe(true);
    expect(keepsEmphasis(["x *x", "8. Foo*y"], 1, 3, 6)).toBe(false);
    expect(keepsEmphasis(["1. a *x", "2) Foo*y"], 1, 3, 6)).toBe(true);
    expect(keepsEmphasis(["1. a *x", "   - b", " 2. Foo*y"], 2, 4, 7)).toBe(true);
    expect(keepsEmphasis(["- a *x", "2. Foo*y"], 1, 3, 6)).toBe(false);
    const long = Array.from({ length: 100_000 }, (_, i) => `${i + 1}. item (*Foo*) x`);
    expect(keepsEmphasis(long, long.length - 1, 10 + String(long.length).length, 13 + String(long.length).length)).toBe(true);
  });

  it("reads a `#` and a tab, a number after a bullet, and HTML inside a line as text", () => {
    expect(keeps("*a\n#\tFoo*b")).toBe(false);
    expect(keeps("1. a\n- b *x\n3. Foo*c")).toBe(false);
    expect(keeps("*a %%\n- c%% Foo*b")).toBe(false);
    const long = "- **x Foo**, y\n" + ("- " + "word ".repeat(15) + "\n").repeat(45) + "- 1 < 2";
    expect(keeps(long)).toBe(true);
  });

  it("stays quick on a long line of mentions by emphasis", () => {
    const line = "*Foo*a".repeat(25_000);
    const t0 = performance.now();
    const lines = [line];
    for (let at = line.indexOf("Foo"); at >= 0; at = line.indexOf("Foo", at + 1)) keepsEmphasis(lines, 0, at, at + 3);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("looks again when a line of the same note changes", () => {
    const lines = ["*a", "- Foo*b"];
    expect(keepsEmphasis(lines, 1, 2, 5)).toBe(true);
    lines[0] = "$$";
    expect(keepsEmphasis(lines, 1, 2, 5)).toBe(false);
  });

  it("checks a numbered list item by item, quickly", () => {
    const lines = Array.from({ length: 1600 }, (_, i) => `${i + 1}. item (*Foo*) [[Bar]]`);
    const t0 = performance.now();
    for (let i = 0; i < lines.length; i++) expect(keepsEmphasis(lines, i, lines[i].indexOf("Foo"), lines[i].indexOf("Foo") + 3)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(2500);
  });

  it("gives the same answer for a mention after another in its paragraph is linked", () => {
    const pad = "x".repeat(3000 - "Foo starts\n\nand then (*Foo*) here".length);
    const lines = ["Foo starts", pad, "and then (*Foo*) here"];
    expect(lines.join("\n").length).toBe(3000);
    const at = lines[2].indexOf("Foo");
    expect(keepsEmphasis(lines, 2, at, at + 3)).toBe(true);
    lines[0] = "[[Foo]] starts";
    expect(keepsEmphasis(lines, 2, at, at + 3)).toBe(true);
    expect(keepsEmphasis(["x".repeat(3001 - 14), "(*Foo*) there"], 1, 2, 5)).toBe(false);
  });

  it("checks again when the line-break setting changes", () => {
    const lines = ["*a", "Foo* b"];
    expect(keepsEmphasis(lines, 1, 0, 3)).toBe(true);
    setStrictLineBreaks(true);
    try {
      expect(keepsEmphasis(lines, 1, 0, 3)).toBe(true);
    } finally {
      setStrictLineBreaks(false);
    }
  });

  it("leaves mentions by emphasis alone in a paragraph too long to check", () => {
    const short = "(*Foo*) ".repeat(10);
    expect(keepsEmphasis([short], 0, 2, 5)).toBe(true);
    const long = "(*Foo*) ".repeat(Math.ceil(EMPHASIS_CHECK_LIMIT / 8) + 1);
    const t0 = performance.now();
    expect(keepsEmphasis([long], 0, 2, 5)).toBe(false);
    expect(linkifyMention(long, "Foo")).toBeNull();
    expect(performance.now() - t0).toBeLessThan(50);
    expect(linkifyMention("Foo and " + long, "Foo")).toBe("[[Foo]] and " + long);
  });
});
