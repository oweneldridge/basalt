// Regression tests for the 2026-06 hardening audit: Obsidian-parity link
// resolution, fence/frontmatter-aware extraction, and the multiline-wikilink
// crash fix. Pure logic — no DOM, no Tauri.
import { describe, expect, it } from "vitest";
import { VaultIndex, extractTags } from "./vaultIndex";
import { proseMask, wikilinkRegex } from "./markdown";
import type { VaultNote } from "./vault";

function note(rel: string, content = ""): VaultNote {
  const name = (rel.split("/").pop() ?? rel).replace(/\.md$/i, "");
  return { path: `/v/${rel}`, rel, name, content };
}

function indexOf(notes: VaultNote[]): VaultIndex {
  const idx = new VaultIndex();
  idx.build(notes);
  return idx;
}

describe("wikilinkRegex", () => {
  it("matches single-line links with aliases", () => {
    const m = wikilinkRegex().exec("see [[Note|alias]] here");
    expect(m?.[1]).toBe("Note");
    expect(m?.[2]).toBe("alias");
  });
  it("never matches across a newline (CM6 RangeError regression)", () => {
    expect(wikilinkRegex().exec("[[foo\nbar]]")).toBeNull();
    expect(wikilinkRegex().exec("[[foo|a\nb]]")).toBeNull();
  });
});

describe("proseMask", () => {
  it("masks frontmatter and fenced code, with CommonMark close rules", () => {
    const lines = [
      "---", // 0 fm
      "tags: [x]", // 1 fm
      "---", // 2 fm close
      "prose", // 3
      "````md", // 4 fence open (4 backticks)
      "```", // 5 still inside (shorter run doesn't close)
      "````", // 6 closes
      "after", // 7
      "~~~", // 8 tilde fence
      "``` not a close (wrong char)", // 9 inside
      "~~~", // 10 closes
      "end", // 11
    ];
    const mask = proseMask(lines);
    expect(mask).toEqual([
      false, false, false, true, false, false, false, true, false, false, false, true,
    ]);
  });
  it("masks fenced code inside a quote or callout, which ends with the quote", () => {
    const lines = [
      "> [!example] Run", // 0
      "> ```bash", // 1 opens inside the quote
      "> ~/.cfg/x.sh [[Note]]", // 2 inside
      ">", // 3 inside
      "> ```", // 4 closes
      "> after", // 5
      "> > ```", // 6 opens two quotes deep
      "> > code", // 7 inside
      "> back to one", // 8 the inner quote ended, and the code with it
      "plain", // 9
      "> ```", // 10 opens
      "> code", // 11 inside
      "", // 12 the quote ended, so the code did
      "text", // 13
    ];
    expect(proseMask(lines)).toEqual([true, false, false, false, false, true, false, false, true, true, false, false, true, true]);
  });
  it("doesn't open a fence on backticks with a backtick after them", () => {
    const lines = [
      "> [!tip] Shell", // 0
      "> ```ls -la``` lists files", // 1 inline code, not a fence
      "> See [[Old]]", // 2
      "```ls``` too", // 3
      "after", // 4
      "~~~ a`b", // 5 a tilde fence may have backticks after it
      "inside", // 6
      "~~~", // 7
      "end", // 8
    ];
    expect(proseMask(lines)).toEqual([true, true, true, true, true, false, false, false, true]);
  });
  it("treats an unterminated frontmatter fence as prose-ish (no infinite mask)", () => {
    const mask = proseMask(["---", "a: b"]);
    // No closing --- : not frontmatter; first line also isn't a code fence.
    expect(mask[1]).toBe(true);
  });
});

describe("VaultIndex.resolve — Obsidian semantics", () => {
  const idx = indexOf([
    note("A.md"),
    note("Folder/A.md"),
    note("Folder/B.md"),
    note("Deep/Nest/C.md"),
    note("Other/C.md"),
  ]);

  it("bare link resolves vault-wide to the ROOT-MOST candidate (not same-folder)", () => {
    expect(idx.resolve("A", "/v/Folder/B.md")).toBe("/v/A.md");
  });
  it("folder-qualified link matches by path suffix", () => {
    expect(idx.resolve("Folder/A", "/v/A.md")).toBe("/v/Folder/A.md");
  });
  it("root-anchored /A is exact from the root", () => {
    expect(idx.resolve("/A", "/v/Folder/B.md")).toBe("/v/A.md");
    expect(idx.resolve("/Nest/C", "/v/A.md")).toBeNull(); // not at root
  });
  it("relative ./ and ../ resolve against the source folder", () => {
    expect(idx.resolve("./A", "/v/Folder/B.md")).toBe("/v/Folder/A.md");
    expect(idx.resolve("../A", "/v/Folder/B.md")).toBe("/v/A.md");
    expect(idx.resolve("../../A", "/v/Folder/B.md")).toBe("/v/A.md"); // Obsidian clamps at the root
  });
  it("ambiguous bare link from the root prefers the shortest path", () => {
    expect(idx.resolve("C", "/v/A.md")).toBe("/v/Other/C.md"); // depth 1 beats depth 2
  });
  it("heading/block suffixes are ignored for resolution", () => {
    expect(idx.resolve("A#Heading", "/v/Folder/B.md")).toBe("/v/A.md");
    expect(idx.resolve("A#^block", "/v/Folder/B.md")).toBe("/v/A.md");
  });
});

describe("VaultIndex link extraction", () => {
  it("ignores wikilinks inside fenced code and inline code", () => {
    const target = note("T.md");
    const src = note(
      "S.md",
      ["prose [[T]]", "```", "[[T]] in fence", "```", "and `[[T]] in code`"].join("\n"),
    );
    const idx = indexOf([target, src]);
    const backs = idx.backlinksFor("/v/T.md");
    expect(backs).toHaveLength(1);
    expect(backs[0].line).toBe(1);
  });
  it("ignores wikilink-looking text in frontmatter", () => {
    const idx = indexOf([
      note("T.md"),
      note("S.md", ["---", "up: [[T]]", "---", "body"].join("\n")),
    ]);
    expect(idx.backlinksFor("/v/T.md")).toHaveLength(0);
  });
});

describe("table-escaped links", () => {
  it("resolves [[Note\\|alias]] inside a table row", () => {
    const idx = indexOf([note("T.md"), note("S.md", "| a | b |\n|---|---|\n| [[T\\|tee]] | x |")]);
    expect(idx.backlinksFor("/v/T.md").map((b) => b.path)).toEqual(["/v/S.md"]);
  });
});

describe("links in frontmatter properties", () => {
  it("indexes a property value that is entirely a quoted link", () => {
    const idx = indexOf([
      note("T.md"),
      note("A.md", ["---", 'up: "[[T]]"', "---", "body"].join("\n")),
      note("B.md", ["---", "rel:", '  - "[[T#H]]"', "---"].join("\n")),
      note("C.md", ["---", "x: met [[T]] today", "---"].join("\n")),
      note("D.md", ["---", "ref: \"[t](T.md)\"", "---"].join("\n")),
      note("E.md", ["---", "# [[T]]", "y: 1 # [[T]]", "---"].join("\n")),
    ]);
    expect(idx.backlinksFor("/v/T.md").map((b) => b.path).sort()).toEqual(["/v/A.md", "/v/B.md", "/v/D.md"]);
  });
});

describe("markdown-style link indexing (useMarkdownLinks vaults)", () => {
  it("indexes [text](Note.md) links as backlinks, decoding %20 and stripping #fragments", () => {
    const idx = indexOf([
      note("My Note.md"),
      note("S.md", "see [the note](My%20Note.md#Heading) here"),
    ]);
    const backs = idx.backlinksFor("/v/My Note.md");
    expect(backs).toHaveLength(1);
    expect(backs[0].line).toBe(1);
  });
  it("resolves relative md hrefs against the source folder", () => {
    const idx = indexOf([
      note("inbox/Todo.md"),
      note("projects/S.md", "[todo](../inbox/Todo.md)"),
    ]);
    expect(idx.backlinksFor("/v/inbox/Todo.md")).toHaveLength(1);
  });
  it("ignores external, anchor-only, non-md, and code-span hrefs", () => {
    const idx = indexOf([
      note("T.md"),
      note(
        "S.md",
        [
          "[x](https://example.com/T.md)",
          "[y](#section)",
          "[z](image.png)",
          "`[c](T.md)`",
        ].join("\n"),
      ),
    ]);
    expect(idx.backlinksFor("/v/T.md")).toHaveLength(0);
  });
  it("does not count linked text as an unlinked mention", () => {
    const idx = indexOf([note("T.md"), note("S.md", "[T](T.md) only")]);
    const notes = [note("T.md"), note("S.md", "[T](T.md) only")];
    expect(idx.unlinkedMentionsFor("T", notes)).toHaveLength(0);
  });
  it("indexes md links whose text contains brackets or a nested image", () => {
    const idx = indexOf([
      note("T.md"),
      note("S.md", ["[see [1]](T.md)", "[![alt](img.png)](T.md)"].join("\n")),
    ]);
    expect(idx.backlinksFor("/v/T.md")).toHaveLength(2);
  });
});

describe("extractTags", () => {
  it("collects body #tags and nested tags, skipping code and headings", () => {
    const t = extractTags(
      ["# Heading not a tag", "Body with #alpha and #foo/bar.", "`#incode` ignored", "```", "#fenced", "```"].join("\n"),
    );
    expect(t.sort()).toEqual(["alpha", "foo/bar"]);
  });
  it("reads frontmatter tags in inline-array, comma, and list forms", () => {
    expect(extractTags(["---", "tags: [a, b]", "---", "body"].join("\n")).sort()).toEqual(["a", "b"]);
    expect(extractTags(["---", "tags: c, d", "---"].join("\n")).sort()).toEqual(["c", "d"]);
    expect(extractTags(["---", "tags:", "  - e", "  - f", "---"].join("\n")).sort()).toEqual(["e", "f"]);
  });
  it("strips a leading # in frontmatter and dedupes against body, case-insensitively", () => {
    const t = extractTags(["---", "tags: [Project]", "---", "see #project and #PROJECT"].join("\n"));
    expect(t).toEqual(["Project"]); // first-seen casing kept, single entry
  });
  it("returns nothing for a note with no tags", () => {
    expect(extractTags("just prose, no tags here")).toEqual([]);
  });
  it("finds tags in any script, and not numbers or escaped ones", () => {
    expect(extractTags("#café and #日本, issue #42, \\#escaped").sort()).toEqual(["café", "日本"]);
  });
});

describe("VaultIndex.allTags", () => {
  it("counts notes per tag and sorts by count then name", () => {
    const idx = indexOf([
      note("A.md", "#shared #only-a"),
      note("B.md", "#shared"),
      note("C.md", ["---", "tags: [shared, zed]", "---"].join("\n")),
    ]);
    const tags = idx.allTags();
    expect(tags[0]).toEqual({ tag: "shared", count: 3 }); // in all three
    const names = tags.map((t) => t.tag).sort();
    expect(names).toEqual(["only-a", "shared", "zed"]);
  });
  it("drops a note's tags when it is removed", () => {
    const idx = indexOf([note("A.md", "#x"), note("B.md", "#x")]);
    idx.removeNote("/v/B.md");
    expect(idx.allTags()).toEqual([{ tag: "x", count: 1 }]);
  });
});

describe("2.9b review regressions", () => {
  it("'./Note.md' and bare 'Note' on one line stay distinct occurrences", () => {
    // resolve() treats them differently (source-relative vs vault-wide
    // root-most), so the per-line dedupe must not collapse them.
    const notes = [
      note("Note.md"),
      note("sub/Note.md"),
      note("sub/Src.md", "[a](Note.md) and [b](./Note.md)"),
    ];
    const idx = indexOf(notes);
    expect(idx.backlinksFor("/v/Note.md")).toHaveLength(1); // bare → root-most
    expect(idx.backlinksFor("/v/sub/Note.md")).toHaveLength(1); // ./ → source folder
  });
  it("resolves [[Foo.md]] to a note literally named 'Foo.md' (file Foo.md.md)", () => {
    const idx = indexOf([note("Foo.md.md"), note("S.md")]); // note named "Foo.md"
    expect(idx.resolve("Foo.md", "/v/S.md")).toBe("/v/Foo.md.md");
  });
  it("prefers the stripped name when both 'Foo' and 'Foo.md' notes exist", () => {
    const idx = indexOf([note("Foo.md"), note("Foo.md.md"), note("S.md")]);
    expect(idx.resolve("Foo.md", "/v/S.md")).toBe("/v/Foo.md");
  });
  it("mention scan blanks inline code BEFORE links (CommonMark precedence)", () => {
    // The link-looking text straddles one backtick of a real code span; the
    // 'y' inside it must not surface as a mention.
    const notes = [note("y.md"), note("S.md", "x `y [a](b`c.md) z")];
    const idx = indexOf(notes);
    expect(idx.unlinkedMentionsFor("y", notes)).toHaveLength(0);
    // …while a genuine prose mention still does.
    const notes2 = [note("y.md"), note("S2.md", "plain y here")];
    expect(indexOf(notes2).unlinkedMentionsFor("y", notes2)).toHaveLength(1);
  });
  it("counts each mention on a line, as Obsidian counts matches", () => {
    const notes = [note("Ideas.md"), note("S.md", "Ideas and more ideas, Ideas")];
    expect(indexOf(notes).unlinkedMentionsFor("Ideas", notes)).toHaveLength(3);
  });
  it("leaves out mentions in math, comments, indented code and HTML", () => {
    const body = [
      "Ideas in prose", // 1: listed
      "math $Ideas^2$ here", // 2
      "%% Ideas", // 3: comment over lines
      "still Ideas %%", // 4
      "",
      "    Ideas in code", // 6
      "",
      '<span title="Ideas">x</span>', // 8
      "<!-- Ideas -->", // 9
      "$$",
      "Ideas = 1", // 11
      "$$",
    ].join("\n");
    const notes = [note("Ideas.md"), note("S.md", body)];
    expect(indexOf(notes).unlinkedMentionsFor("Ideas", notes).map((m) => m.line)).toEqual([1]);
  });
  it("leaves out callout types, footnotes, references, emails and code, and keeps prose with < in it", () => {
    const body = [
      "Run `echo $$` here", // 1
      "",
      "$$",
      "Ideas + x = y", // 4: math
      "$$",
      "null<Date coerces Ideas to InputMaybe<Time>", // 6: listed
      "> [!ideas] Title", // 7
      "see ``code Ideas `x` here`` end", // 8
      "a footnote[^Ideas] here", // 9
      "",
      "[Ideas]: https://x.com/a", // 11: a definition, after a blank line
      "",
      "mail ideas@x.com", // 13
    ].join("\n");
    const notes = [note("Ideas.md"), note("S.md", body)];
    expect(indexOf(notes).unlinkedMentionsFor("Ideas", notes).map((m) => m.line)).toEqual([6]);
  });
  it("lists only mentions the Link action can link, not tags or URLs", () => {
    const notes = [note("Ideas.md"), note("S.md", "#ideas\nhttps://x.com/ideas\nsee ideas")];
    expect(indexOf(notes).unlinkedMentionsFor("Ideas", notes).map((m) => m.line)).toEqual([3]);
  });
  it("counts a mention of an alias as an unlinked mention", () => {
    const notes = [note("Kubernetes CLI Tools.md"), note("S.md", "See the kubectl reference here")];
    expect(indexOf(notes).unlinkedMentionsFor(["Kubernetes CLI Tools", "kubectl reference"], notes)).toHaveLength(1);
  });
});

describe("outgoingLinksFor", () => {
  it("splits a note's links into resolved and unresolved (deduped)", () => {
    const idx = indexOf([
      note("A.md", "links [[B]] and [[B]] again, plus [[Ghost]] and [[C]]"),
      note("B.md"),
      note("C.md"),
    ]);
    const out = idx.outgoingLinksFor("/v/A.md");
    expect(out.resolved.map((r) => r.name).sort()).toEqual(["B", "C"]);
    expect(out.resolved.filter((r) => r.name === "B")).toHaveLength(1); // deduped
    expect(out.unresolved).toEqual(["Ghost"]);
  });
  it("is empty for a note with no links", () => {
    const idx = indexOf([note("Solo.md", "no links here")]);
    expect(idx.outgoingLinksFor("/v/Solo.md")).toEqual({ resolved: [], unresolved: [] });
  });
});

describe("aliases", () => {
  it("resolves [[alias]] to the note declaring it in frontmatter", () => {
    const idx = indexOf([
      note("JS.md", "---\naliases: [JavaScript, ECMAScript]\n---\n# JS"),
      note("Other.md", "see [[JavaScript]] and [[ECMAScript]] and [[JS]]"),
    ]);
    expect(idx.resolve("JavaScript", "/v/Other.md")).toBe("/v/JS.md");
    expect(idx.resolve("ECMAScript", "/v/Other.md")).toBe("/v/JS.md");
    expect(idx.resolve("JS", "/v/Other.md")).toBe("/v/JS.md"); // basename still works
    expect(idx.aliasesOf("/v/JS.md")).toEqual(["JavaScript", "ECMAScript"]);
  });

  it("counts an [[alias]] link as a backlink to the aliased note", () => {
    const idx = indexOf([
      note("JS.md", "---\naliases:\n  - JavaScript\n---"),
      note("Other.md", "uses [[JavaScript]] daily"),
    ]);
    const bl = idx.backlinksFor("/v/JS.md");
    expect(bl.map((b) => b.name)).toContain("Other");
  });

  it("drops old aliases from resolution when frontmatter changes", () => {
    const idx = indexOf([note("N.md", "---\naliases: [Old]\n---")]);
    expect(idx.resolve("Old", "/v/N.md")).toBe("/v/N.md");
    idx.setNote(note("N.md", "---\naliases: [New]\n---"));
    expect(idx.resolve("Old", "/v/N.md")).toBeNull(); // stale alias removed
    expect(idx.resolve("New", "/v/N.md")).toBe("/v/N.md");
  });
});

describe("aliases — precedence and parsing (review fixes)", () => {
  it("a REAL file wins over another note's alias of the same name", () => {
    const idx = indexOf([
      note("Foo.md", "the real foo"),
      note("Bar.md", "---\naliases: [Foo]\n---"),
      note("Src.md", "link [[Foo]]"),
    ]);
    expect(idx.resolve("Foo", "/v/Src.md")).toBe("/v/Foo.md"); // real file, not Bar
  });

  it("aliases only match a BARE name, not a folder-qualified path", () => {
    const idx = indexOf([note("sub/Note.md", "---\naliases: [Alpha]\n---")]);
    expect(idx.resolve("Alpha", "/v/x.md")).toBe("/v/sub/Note.md");
    expect(idx.resolve("sub/Alpha", "/v/x.md")).toBeNull(); // path-qualified alias ≠ match
  });

  it("does not split an inline alias on a comma inside quotes", () => {
    const idx = indexOf([note("N.md", '---\naliases: ["Doe, John", Jane]\n---')]);
    expect(idx.aliasesOf("/v/N.md")).toEqual(["Doe, John", "Jane"]);
  });

  it("dedupes aliases case-insensitively", () => {
    const idx = indexOf([note("N.md", "---\naliases: [Foo, foo, FOO]\n---")]);
    expect(idx.aliasesOf("/v/N.md")).toEqual(["Foo"]);
  });

  it("skips aliases with wikilink-special chars from autocomplete", () => {
    const idx = indexOf([note("N.md", '---\naliases: ["a|b", "c#d", Good]\n---')]);
    expect(idx.allAliases().map((a) => a.alias)).toEqual(["Good"]);
  });
});

describe("backlink and embed lists for Bases", () => {
  it("lists linking notes and a note's embeds", () => {
    const idx = indexOf([
      note("T.md", "![[pic.png]] and ![[Other]] and [[Other]]"),
      note("A.md", "[[T]]"),
      note("Sub/B.md", "see [[T#h]]"),
      note("Other.md"),
    ]);
    expect(idx.backlinkRels("/v/T.md")).toEqual(["A", "Sub/B"]);
    expect(idx.embedsOf("/v/T.md")).toEqual(["pic.png", "Other"]);
    idx.setNote({ path: "/v/A.md", rel: "A.md", name: "A", content: "no links now" });
    expect(idx.backlinkRels("/v/T.md")).toEqual(["Sub/B"]);
  });
});

describe("resolveFromRel", () => {
  it("resolves a link as if written from another folder", () => {
    const idx = new VaultIndex();
    idx.build([note("A/Plan.md"), note("B/Plan.md"), note("A/Hub.md", "[[Plan]]")]);
    const hub = idx.resolve("Plan", "/v/A/Hub.md");
    expect(hub).toBe(idx.resolveFromRel("Plan", "A/Hub.md"));
    expect(idx.resolveFromRel("Plan", "A/Hub.md")).toMatch(/A\/Plan\.md$/);
    expect(idx.resolveFromRel("Plan", "B/Hub.md")).toMatch(/B\/Plan\.md$/);
    expect(idx.resolveFromRel("./Plan", "B/Hub.md")).toMatch(/B\/Plan\.md$/);
    expect(idx.resolveFromRel("../A/Plan", "B/Hub.md")).toMatch(/A\/Plan\.md$/);
  });
});

describe("property links and block scalars", () => {
  it("a quoted link inside a block scalar isn't a backlink", () => {
    const idx = indexOf([
      note("A.md"),
      note("Quoted.md", '---\nsummary: |\n  "[[A]]"\n---\nBody\n'),
      note("Linked.md", '---\nup: "[[A]]"\n---\nBody\n'),
    ]);
    expect(idx.backlinkRels("/v/A.md")).toEqual(["Linked"]);
  });
});

describe("tags and raw HTML", () => {
  it("doesn't read colours in HTML as tags", () => {
    const note = [
      "#real-tag in prose",
      "",
      '<svg viewBox="0 0 10 10">',
      '<line stroke="#e8710a"/>',
      '<text fill="#1a73e8">#notatag inside the block</text>',
      "</svg>",
      "",
      'Inline <span style="color:#ff0000">red</span> and #second',
    ].join("\n");
    expect(extractTags(note)).toEqual(["real-tag", "second"]);
  });
  it("still reads tags after inline HTML on a line", () => {
    expect(extractTags('<span style="color:red">Important</span> #todo')).toEqual(["todo"]);
    expect(extractTags('<font color="red">Due</font> #deadline')).toEqual(["deadline"]);
    expect(extractTags("<p>Para</p> #ptag")).toEqual(["ptag"]);
    expect(extractTags("x<y and #between z>w")).toEqual(["between"]);
  });
});

describe("resolvedLinks", () => {
  it("counts each note's links by the notes they resolve to, as Obsidian does", () => {
    const idx = new VaultIndex();
    idx.build([
      { path: "/v/A.md", rel: "A.md", name: "A", content: "[[B]] and [[B]] and [[Missing]] and [x](sub/C.md)" },
      { path: "/v/B.md", rel: "B.md", name: "B", content: "no links" },
      { path: "/v/sub/C.md", rel: "sub/C.md", name: "C", content: "[[A]]" },
    ] as never);
    expect(idx.resolvedLinks()).toEqual({ "A.md": { "B.md": 2, "sub/C.md": 1 }, "B.md": {}, "sub/C.md": { "A.md": 1 } });
  });
  it("counts links to attachments and links to nothing, as Obsidian's unresolvedLinks", () => {
    const idx = new VaultIndex();
    idx.build([{ path: "/v/A.md", rel: "A.md", name: "A", content: "![[pic.png]] [[Missing#h]] [[Missing]] [[B]]" }] as never);
    const counts = idx.linkCounts((raw) => (raw === "pic.png" ? "img/pic.png" : null));
    expect(counts.resolved).toEqual({ "A.md": { "img/pic.png": 1 } });
    expect(counts.unresolved).toEqual({ "A.md": { Missing: 2, B: 1 } });
  });
});
