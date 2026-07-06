import { describe, expect, it } from "vitest";
import { splitSubpath, stripFrontmatter, extractSection, subpathToLine, extractHeadings } from "./transclude";

describe("splitSubpath", () => {
  it("splits target and subpath on the first #", () => {
    expect(splitSubpath("Note")).toEqual({ target: "Note", subpath: "" });
    expect(splitSubpath("Note#Heading")).toEqual({ target: "Note", subpath: "Heading" });
    expect(splitSubpath("folder/Note#^abc")).toEqual({ target: "folder/Note", subpath: "^abc" });
    expect(splitSubpath("Note#A#B")).toEqual({ target: "Note", subpath: "A#B" });
  });
});

describe("stripFrontmatter", () => {
  it("drops a leading YAML block, leaves the rest", () => {
    expect(stripFrontmatter("---\na: 1\n---\nbody\nmore")).toBe("body\nmore");
    expect(stripFrontmatter("no fm\nhere")).toBe("no fm\nhere");
    expect(stripFrontmatter("---\nunclosed\nbody")).toBe("---\nunclosed\nbody");
  });
});

const DOC = [
  "---",
  "tags: x",
  "---",
  "Intro paragraph.",
  "",
  "# First",
  "first body line",
  "more first",
  "",
  "## Sub",
  "sub body",
  "",
  "# Second",
  "second body",
  "",
  "A block paragraph. ^b1",
  "",
  "Another para",
  "spanning lines",
  "^b2",
].join("\n");

describe("extractSection", () => {
  it("returns the whole note (minus frontmatter) for an empty subpath", () => {
    const s = extractSection(DOC, "");
    expect(s.startsWith("Intro paragraph.")).toBe(true);
    expect(s).not.toContain("tags: x");
  });

  it("extracts a heading section up to the next same-or-higher heading", () => {
    const first = extractSection(DOC, "First");
    expect(first).toBe("# First\nfirst body line\nmore first\n\n## Sub\nsub body");
    const sub = extractSection(DOC, "Sub");
    expect(sub).toBe("## Sub\nsub body");
    const second = extractSection(DOC, "Second");
    expect(second.startsWith("# Second\nsecond body")).toBe(true);
    expect(second).toContain("^b1"); // extends to EOF (no later heading)
  });

  it("is case/space-insensitive on heading match; empty when not found", () => {
    expect(extractSection(DOC, "  first  ")).toContain("first body line");
    expect(extractSection(DOC, "Nope")).toBe("");
  });

  it("extracts an inline ^block (stripping the marker)", () => {
    expect(extractSection(DOC, "^b1")).toBe("A block paragraph.");
  });

  it("extracts an own-line ^block (the preceding paragraph)", () => {
    expect(extractSection(DOC, "^b2")).toBe("Another para\nspanning lines");
  });

  it("returns empty for a missing block id", () => {
    expect(extractSection(DOC, "^missing")).toBe("");
  });

  it("a block right after a heading does not pull in the heading", () => {
    const doc = "# Steps\nmix well ^s1\n";
    expect(extractSection(doc, "^s1")).toBe("mix well");
  });

  it("heading section boundary ignores # lines inside a code fence (#2/#9)", () => {
    const doc = "# Setup\nrun it\n```bash\n# a comment\n## also not a heading\n```\ntail line\n# Next\nx";
    const sec = extractSection(doc, "Setup");
    expect(sec).toContain("tail line"); // not truncated at the fenced `#` lines
    expect(sec).not.toContain("# Next");
  });

  it("block id inside a code fence is ignored (#4)", () => {
    const doc = "real para ^b\n```\nfake ^b\n```\n";
    expect(extractSection(doc, "^b")).toBe("real para");
  });

  it("a list-item block ref grabs only that item, not siblings (#3)", () => {
    const doc = "- one\n- two ^t\n- three\n";
    expect(extractSection(doc, "^t")).toBe("- two");
  });

  it("supports setext headings (#11)", () => {
    // Next is a sibling level-1 setext (===), so it bounds the Title section.
    const doc = "Title\n=====\nbody\n\nNext\n=====\nmore";
    expect(extractSection(doc, "Title")).toBe("Title\n=====\nbody");
    expect(extractSection(doc, "Next")).toBe("Next\n=====\nmore");
  });

  it("keeps a literal trailing # in a heading name (#12)", () => {
    const doc = "## C#\ncsharp notes\n## D\nx";
    expect(extractSection(doc, "C#")).toBe("## C#\ncsharp notes");
    expect(extractSection(doc, "C")).toBe(""); // 'C' must NOT match '## C#'
  });
});

describe("subpathToLine + extractHeadings", () => {
  const doc = ["---", "a: 1", "---", "# Intro", "text", "## Details", "more ^b1", "final"].join("\n");
  it("finds the 1-based line of a heading (frontmatter included)", () => {
    expect(subpathToLine(doc, "Intro")).toBe(4);
    expect(subpathToLine(doc, "Details")).toBe(6);
    expect(subpathToLine(doc, "Nope")).toBeNull();
  });
  it("finds the line of a ^block id", () => {
    expect(subpathToLine(doc, "^b1")).toBe(7);
    expect(subpathToLine(doc, "^missing")).toBeNull();
  });
  it("lists headings in order", () => {
    expect(extractHeadings(doc)).toEqual(["Intro", "Details"]);
  });
});
