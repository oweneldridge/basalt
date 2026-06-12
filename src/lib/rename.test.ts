// Tests for vault-wide link rewriting on rename — the riskiest text surgery in
// the app: it edits OTHER notes' content, so every preserved detail matters.
import { describe, expect, it } from "vitest";
import { linkTargetFor, rewriteLinks } from "./rename";
import { targetPathPart } from "./markdown";

// A mapper that renames targets whose path part matches `oldName`.
const renameMap = (oldName: string, newName: string) => (raw: string) =>
  targetPathPart(raw).toLowerCase() === oldName.toLowerCase() ? newName : null;

describe("rewriteLinks", () => {
  it("rewrites a plain wikilink", () => {
    expect(rewriteLinks("see [[Old]] here", renameMap("Old", "New"))).toBe("see [[New]] here");
  });
  it("preserves the alias", () => {
    expect(rewriteLinks("see [[Old|the doc]]", renameMap("Old", "New"))).toBe(
      "see [[New|the doc]]",
    );
  });
  it("preserves #heading and #^block suffixes", () => {
    expect(rewriteLinks("[[Old#Goals]] and [[Old#^abc123]]", renameMap("Old", "New"))).toBe(
      "[[New#Goals]] and [[New#^abc123]]",
    );
  });
  it("treats a bare ^ as part of the name (not a block ref)", () => {
    expect(rewriteLinks("[[Old^draft]]", renameMap("Old^draft", "New"))).toBe("[[New]]");
  });
  it("preserves suffix AND alias together", () => {
    expect(rewriteLinks("[[Old#Goals|see goals]]", renameMap("Old", "New"))).toBe(
      "[[New#Goals|see goals]]",
    );
  });
  it("rewrites embeds (![[…]]) too", () => {
    expect(rewriteLinks("inline ![[Old]] embed", renameMap("Old", "New"))).toBe(
      "inline ![[New]] embed",
    );
  });
  it("rewrites folder-qualified targets the mapper matches", () => {
    const map = (raw: string) =>
      targetPathPart(raw).toLowerCase() === "work/old" ? "work/New" : null;
    expect(rewriteLinks("[[work/Old]]", map)).toBe("[[work/New]]");
  });
  it("leaves unrelated links alone and returns null when nothing changed", () => {
    expect(rewriteLinks("see [[Other]] here", renameMap("Old", "New"))).toBeNull();
  });
  it("does not touch links inside inline code spans", () => {
    expect(rewriteLinks("Use the `[[Old]]` syntax", renameMap("Old", "New"))).toBeNull();
    expect(rewriteLinks("`[[Old]]` then real [[Old]]", renameMap("Old", "New"))).toBe(
      "`[[Old]]` then real [[New]]",
    );
  });
  it("does not touch links inside fenced code or frontmatter", () => {
    const doc = ["---", "up: [[Old]]", "---", "```", "[[Old]]", "```", "real [[Old]]"].join("\n");
    expect(rewriteLinks(doc, renameMap("Old", "New"))).toBe(
      ["---", "up: [[Old]]", "---", "```", "[[Old]]", "```", "real [[New]]"].join("\n"),
    );
  });
  it("rewrites multiple links on one line independently", () => {
    expect(rewriteLinks("[[Old]] then [[Other]] then [[Old|x]]", renameMap("Old", "New"))).toBe(
      "[[New]] then [[Other]] then [[New|x]]",
    );
  });
  it("ignores [[#heading]] self-references", () => {
    expect(rewriteLinks("[[#Section]]", () => "New")).toBeNull();
  });
});

describe("linkTargetFor", () => {
  it("uses the bare name when unique", () => {
    expect(linkTargetFor("folder/New Note", false)).toBe("New Note");
  });
  it("uses the folder-qualified path when the basename is taken", () => {
    expect(linkTargetFor("folder/New Note", true)).toBe("folder/New Note");
  });
});

describe("markdown-style link rewriting", () => {
  it("rewrites the href, preserving text, title, and fragment, with %20 encoding", () => {
    // Production mapTarget resolves via the index (extension-insensitive);
    // this test map mirrors that by accepting the .md-suffixed path part.
    const map = (to: string) => (raw: string) =>
      targetPathPart(raw).toLowerCase().replace(/\.md$/, "") === "old" ? to : null;
    expect(rewriteLinks('see [the note](Old.md "my title") here', map("New Name"))).toBe(
      'see [the note](New%20Name.md "my title") here',
    );
    expect(rewriteLinks("[t](Old.md#Sec)", map("New"))).toBe("[t](New.md#Sec)");
  });
  it("decodes %20 hrefs when matching and handles angle form", () => {
    const map = (raw: string) =>
      targetPathPart(raw).toLowerCase() === "old note.md" ? "Renamed" : null;
    expect(rewriteLinks("[x](Old%20Note.md)", map)).toBe("[x](Renamed.md)");
    expect(rewriteLinks("[x](<Old Note.md>)", map)).toBe("[x](Renamed.md)");
  });
  it("rewrites image-embed form and leaves externals/code spans alone", () => {
    const map = (raw: string) =>
      targetPathPart(raw).toLowerCase() === "old.md" ? "New" : null;
    expect(rewriteLinks("![e](Old.md)", map)).toBe("![e](New.md)");
    expect(rewriteLinks("[x](https://a.com/Old.md)", map)).toBeNull();
    expect(rewriteLinks("`[x](Old.md)`", map)).toBeNull();
  });
  it("rewrites wikilinks and md links on the same line", () => {
    const map = (raw: string) => {
      const p = targetPathPart(raw).toLowerCase();
      return p === "old" || p === "old.md" ? "New" : null;
    };
    expect(rewriteLinks("[[Old]] and [t](Old.md)", map)).toBe("[[New]] and [t](New.md)");
  });
  it("rewrites links whose text contains brackets or a nested image", () => {
    const map = (raw: string) =>
      targetPathPart(raw).toLowerCase() === "old.md" ? "New" : null;
    expect(rewriteLinks("[see [1]](Old.md)", map)).toBe("[see [1]](New.md)");
    expect(rewriteLinks("[![alt](img.png)](Old.md)", map)).toBe("[![alt](img.png)](New.md)");
  });
  it("keeps the angle form when the fragment needs it (spaces/parens)", () => {
    const map = (raw: string) =>
      targetPathPart(raw).toLowerCase() === "old.md" ? "New" : null;
    expect(rewriteLinks("see [t](<Old.md#My Heading>) here", map)).toBe(
      "see [t](<New.md#My Heading>) here",
    );
    expect(rewriteLinks("[t](<Old.md#a(b)>)", map)).toBe("[t](<New.md#a(b)>)");
    // A safe fragment still un-angles and percent-encodes like Obsidian.
    const spaced = (raw: string) =>
      targetPathPart(raw).toLowerCase() === "old note.md" ? "Renamed" : null;
    expect(rewriteLinks("[x](<Old Note.md#Sec>)", spaced)).toBe("[x](Renamed.md#Sec)");
  });
});

// The rewriter finds matches in a code-MASKED copy of each line; everything it
// re-emits must be sliced from the ORIGINAL or inline code inside link parts
// gets written to disk as blanks (2.9b review: high-severity corruption).
describe("inline code inside link parts survives rewriting", () => {
  const mdMap = (raw: string) =>
    targetPathPart(raw).toLowerCase() === "old.md" ? "New" : null;
  it("md-link text with inline code is preserved", () => {
    expect(rewriteLinks("see [`code`](Old.md) here", mdMap)).toBe("see [`code`](New.md) here");
  });
  it("md-link title with inline code is preserved", () => {
    expect(rewriteLinks('[t](Old.md "a `b` c")', mdMap)).toBe('[t](New.md "a `b` c")');
  });
  it("wikilink alias with inline code is preserved", () => {
    expect(rewriteLinks("see [[Old|`code`]] here", renameMap("Old", "New"))).toBe(
      "see [[New|`code`]] here",
    );
  });
  it("wikilink heading suffix with inline code is preserved", () => {
    expect(rewriteLinks("[[Old#My `code` heading]]", renameMap("Old", "New"))).toBe(
      "[[New#My `code` heading]]",
    );
  });
});
