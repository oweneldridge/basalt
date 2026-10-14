import { describe, expect, it } from "vitest";
import { linkpathDest } from "./linkpath";
import { VaultIndex } from "./vaultIndex";

const pick = (link: string, from: string | null, rels: string[]) =>
  linkpathDest(link, from, rels, (r) => r, ".md");

describe("linkpathDest (Obsidian's getLinkpathDest)", () => {
  const meetings = ["Archive/Meeting.md", "Work/Meeting.md"];
  it("prefers a candidate under the linking note's folder", () => {
    expect(pick("Meeting", "Work/Index.md", meetings)).toBe("Work/Meeting.md");
    expect(pick("Meeting", "Archive/Index.md", meetings)).toBe("Archive/Meeting.md");
  });
  it("otherwise takes the shortest path", () => {
    expect(pick("Meeting", "Index.md", meetings)).toBe("Work/Meeting.md");
    // Length, not folder depth: three short folders beat one long one.
    expect(pick("Meeting", "Other/Index.md", ["Long folder/Meeting.md", "a/b/c/Meeting.md"])).toBe("a/b/c/Meeting.md");
  });
  it("an exact vault path wins over the folder preference", () => {
    expect(pick("Meeting", "Work/Index.md", ["Meeting.md", "Work/Meeting.md"])).toBe("Meeting.md");
    expect(pick("Archive/Meeting", "Work/Index.md", meetings)).toBe("Archive/Meeting.md");
  });
  it("matches folder prefixes as plain strings, like Obsidian", () => {
    // "work" is a string prefix of "workshop", so Workshop counts as near.
    expect(pick("Meeting", "Work/Index.md", ["Workshop/Meeting.md", "A/Meeting.md"])).toBe("Workshop/Meeting.md");
  });
  it("resolves ./ and ../ against the source folder and clamps at the root", () => {
    expect(pick("./Meeting", "Work/Index.md", meetings)).toBe("Work/Meeting.md");
    expect(pick("../Archive/Meeting", "Work/Index.md", meetings)).toBe("Archive/Meeting.md");
    expect(pick("../../Meeting", "Work/Index.md", ["Meeting.md"])).toBe("Meeting.md");
  });
  it("a root-anchored link needs an exact path", () => {
    expect(pick("/Meeting", "Work/Index.md", meetings)).toBeNull();
    expect(pick("/Work/Meeting", "Index.md", meetings)).toBe("Work/Meeting.md");
  });
});

describe("rename sees the link Obsidian sees", () => {
  it("Work/Index's [[Meeting]] belongs to Work/Meeting, not the shallower Archive copy", () => {
    const n = (rel: string, content = "") => ({ path: `/v/${rel}`, rel, name: rel.split("/").pop()!.replace(/\.md$/, ""), content });
    const idx = new VaultIndex();
    idx.build([n("Archive/Meeting.md"), n("Work/Meeting.md"), n("Work/Index.md", "[[Meeting]]")]);
    expect(idx.resolve("Meeting", "/v/Work/Index.md")).toBe("/v/Work/Meeting.md");
    expect(idx.backlinksFor("/v/Work/Meeting.md").map((b) => b.path)).toEqual(["/v/Work/Index.md"]);
    expect(idx.backlinksFor("/v/Archive/Meeting.md")).toEqual([]);
  });
});
