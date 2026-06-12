import { describe, expect, it } from "vitest";
import { fillTemplate, formatMoment, UnsupportedTokenError } from "./daily";
import { linkTargetForFormat, relativeLinkTarget } from "./rename";

const d = new Date(2026, 5, 12, 9, 5, 7); // Fri Jun 12 2026, 09:05:07

describe("formatMoment", () => {
  it("formats the default daily pattern", () => {
    expect(formatMoment(d, "YYYY-MM-DD")).toBe("2026-06-12");
  });
  it("handles names, short forms, and path patterns", () => {
    expect(formatMoment(d, "dddd, MMMM D")).toBe("Friday, June 12");
    expect(formatMoment(d, "YYYY/MM/YYYY-MM-DD ddd")).toBe("2026/06/2026-06-12 Fri");
    expect(formatMoment(d, "YY-M-D H:m:s")).toBe("26-6-12 9:5:7");
    expect(formatMoment(d, "HH:mm:ss")).toBe("09:05:07");
  });
  it("passes bracket literals through untouched", () => {
    expect(formatMoment(d, "[Week of] MMM D")).toBe("Week of Jun 12");
  });
  it("supports ordinals, weeks, week-years, 12-hour, quarters", () => {
    expect(formatMoment(d, "MMMM Do, YYYY")).toBe("June 12th, 2026");
    expect(formatMoment(d, "gggg-[W]ww")).toBe("2026-W24");
    expect(formatMoment(d, "h:mm A")).toBe("9:05 AM");
    expect(formatMoment(d, "[Q]Q YYYY")).toBe("Q2 2026");
    expect(formatMoment(d, "dd")).toBe("Fr");
  });
  it("THROWS on unsupported tokens instead of writing wrong filenames", () => {
    expect(() => formatMoment(d, "DDD")).toThrow(UnsupportedTokenError);
    expect(() => formatMoment(d, "YYYYY")).toThrow(UnsupportedTokenError);
    expect(() => formatMoment(d, "x")).toThrow(UnsupportedTokenError);
  });
});

describe("fillTemplate", () => {
  it("substitutes date/time/title with optional formats", () => {
    expect(fillTemplate("# {{title}}\n{{date}} {{time}}", d, "My Day")).toBe(
      "# My Day\n2026-06-12 09:05",
    );
    expect(fillTemplate("{{date:dddd}}", d, "x")).toBe("Friday");
  });
});

describe("relativeLinkTarget", () => {
  it("computes sibling and ancestor paths", () => {
    expect(relativeLinkTarget("projects/A.md", "projects/B")).toBe("./B");
    expect(relativeLinkTarget("projects/deep/A.md", "inbox/Todo")).toBe("../../inbox/Todo");
    expect(relativeLinkTarget("A.md", "inbox/Todo")).toBe("./inbox/Todo");
  });
});

describe("linkTargetForFormat", () => {
  it("honors absolute, relative, and shortest", () => {
    expect(linkTargetForFormat("absolute", "folder/Note", false, "src/S.md")).toBe("folder/Note");
    expect(linkTargetForFormat("relative", "folder/Note", false, "src/S.md")).toBe(
      "../folder/Note",
    );
    expect(linkTargetForFormat("shortest", "folder/Note", false, "src/S.md")).toBe("Note");
    expect(linkTargetForFormat("shortest", "folder/Note", true, "src/S.md")).toBe("folder/Note");
  });
});
