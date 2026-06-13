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
    expect(idx.resolve("../../A", "/v/Folder/B.md")).toBeNull(); // escapes root
  });
  it("ambiguous bare link prefers shallower then alphabetical", () => {
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
});
