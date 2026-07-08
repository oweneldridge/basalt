import { describe, expect, it } from "vitest";
import { linkifyMention } from "./linkify";

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
