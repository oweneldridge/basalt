import { describe, expect, it } from "vitest";
import { splitSlides } from "./SlidesView";

describe("splitSlides", () => {
  it("splits on --- separator lines", () => {
    expect(splitSlides("# A\n\n---\n\n# B\n\n---\n\n# C")).toEqual(["# A", "# B", "# C"]);
  });
  it("drops leading YAML frontmatter", () => {
    const s = splitSlides("---\ntitle: X\n---\n\n# One\n\n---\n\n# Two");
    expect(s).toEqual(["# One", "# Two"]);
  });
  it("a note with no separators is a single slide", () => {
    expect(splitSlides("just one page")).toEqual(["just one page"]);
  });
});
