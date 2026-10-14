import { describe, expect, it } from "vitest";
import { isHiddenRel } from "./hiddenFiles";

describe("isHiddenRel", () => {
  it("hides names starting with a dot, at any depth", () => {
    expect(isHiddenRel(".unisonbak.0.Week 01.md")).toBe(true);
    expect(isHiddenRel("Phase 1/Month 01/.unisonbak.3.Week 01.md")).toBe(true);
    expect(isHiddenRel(".hidden/Note.md")).toBe(true);
    expect(isHiddenRel("Phase 1\\.DS_Store")).toBe(true);
  });
  it("keeps everything else, dots inside names included", () => {
    expect(isHiddenRel("Week 01.md")).toBe(false);
    expect(isHiddenRel("v1.2 notes/Release 1.2.md")).toBe(false);
    expect(isHiddenRel("Folder/Note.with.dots.md")).toBe(false);
  });
});
