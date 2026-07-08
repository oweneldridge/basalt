import { describe, expect, it } from "vitest";
import { buildTagTree } from "./Tags";

describe("buildTagTree", () => {
  it("nests a/b/c paths and rolls up counts", () => {
    const tree = buildTagTree([
      { tag: "project", count: 1 },
      { tag: "project/alpha", count: 2 },
      { tag: "project/beta", count: 3 },
      { tag: "solo", count: 5 },
    ]);
    // sorted by total desc: project(6) then solo(5)
    expect(tree.map((n) => [n.name, n.total])).toEqual([["project", 6], ["solo", 5]]);
    const project = tree[0];
    expect(project.count).toBe(1); // own
    expect(project.children.map((c) => [c.name, c.total])).toEqual([["beta", 3], ["alpha", 2]]);
  });
  it("creates intermediate nodes even when only a leaf is tagged", () => {
    const tree = buildTagTree([{ tag: "a/b/c", count: 4 }]);
    expect(tree[0].name).toBe("a");
    expect(tree[0].total).toBe(4);
    expect(tree[0].children[0].children[0].name).toBe("c");
  });
});
