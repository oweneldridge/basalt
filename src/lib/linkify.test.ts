import { describe, expect, it } from "vitest";
import { linkifyMention, maskForMentions, mentionLines } from "./linkify";

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
    ];
    for (const note of slow) {
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

