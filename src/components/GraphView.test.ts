import { describe, expect, it } from "vitest";
import { filterGraph } from "./GraphView";

const data = {
  nodes: [
    { id: "/a.md", name: "Alpha" },
    { id: "/b.md", name: "Beta" },
    { id: "/c.md", name: "Orphan" },
  ],
  links: [{ source: "/a.md", target: "/b.md" }],
};

describe("filterGraph", () => {
  it("filters nodes by name and keeps only links between kept nodes", () => {
    const r = filterGraph(data as any, "al", false); // "Alpha" matches
    expect(r.nodes.map((n) => n.name)).toEqual(["Alpha"]);
    expect(r.links.length).toBe(0); // Beta filtered out → link dropped
  });
  it("hides orphans (no links)", () => {
    const r = filterGraph(data as any, "", true);
    expect(r.nodes.map((n) => n.name).sort()).toEqual(["Alpha", "Beta"]); // Orphan dropped
    expect(r.links.length).toBe(1);
  });
  it("no filter returns everything", () => {
    const r = filterGraph(data as any, "", false);
    expect(r.nodes.length).toBe(3);
  });
});
