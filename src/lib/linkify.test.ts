import { describe, expect, it } from "vitest";
import { linkifyMention, mentionLines } from "./linkify";

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
});
