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
  it("preserves #heading and ^block suffixes", () => {
    expect(rewriteLinks("[[Old#Goals]] and [[Old^abc123]]", renameMap("Old", "New"))).toBe(
      "[[New#Goals]] and [[New^abc123]]",
    );
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
