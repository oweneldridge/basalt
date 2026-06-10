// Regression tests for the 2026-06 hardening audit: Obsidian-parity link
// resolution, fence/frontmatter-aware extraction, and the multiline-wikilink
// crash fix. Pure logic — no DOM, no Tauri.
import { describe, expect, it } from "vitest";
import { VaultIndex } from "./vaultIndex";
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
    expect(idx.resolve("A^block", "/v/Folder/B.md")).toBe("/v/A.md");
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
