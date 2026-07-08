import { describe, expect, it } from "vitest";
import { cellOffsetInLine } from "./tables";

describe("cellOffsetInLine", () => {
  it("locates cell content with a leading pipe", () => {
    expect(cellOffsetInLine("| a | b |", 0)).toBe(2); // "a"
    expect(cellOffsetInLine("| a | b |", 1)).toBe(6); // "b"
  });
  it("skips GFM's up-to-3-space indentation before the border pipe", () => {
    expect(cellOffsetInLine("  | a | b |", 0)).toBe(4); // "a", not the pipe at 2
    expect(cellOffsetInLine("  | a | b |", 1)).toBe(8); // "b"
  });
  it("handles no leading pipe", () => {
    expect(cellOffsetInLine("a | b", 0)).toBe(0);
    expect(cellOffsetInLine("a | b", 1)).toBe(4);
  });
});
