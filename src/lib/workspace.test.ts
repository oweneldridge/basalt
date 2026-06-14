import { describe, expect, it } from "vitest";
import {
  type LayoutNode,
  leafIds,
  firstLeafId,
  splitLeaf,
  removeLeaf,
  neighborLeaf,
  setSizes,
} from "./workspace";

const leaf = (id: string): LayoutNode => ({ kind: "leaf", id });

describe("splitLeaf", () => {
  it("splits a single leaf into a binary split", () => {
    const next = splitLeaf(leaf("a"), "a", "b", "row");
    expect(next).toEqual({
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [leaf("a"), leaf("b")],
    });
  });

  it("inserts `before` when asked", () => {
    const next = splitLeaf(leaf("a"), "a", "b", "row", true);
    expect(leafIds(next)).toEqual(["b", "a"]);
  });

  it("flattens a same-direction split into even thirds (not nested halves)", () => {
    let t: LayoutNode = leaf("a");
    t = splitLeaf(t, "a", "b", "row"); // [a|b]
    t = splitLeaf(t, "b", "c", "row"); // [a|b|c] — sibling, not nested
    expect(t.kind).toBe("split");
    if (t.kind === "split") {
      expect(t.children.map(leafIds).flat()).toEqual(["a", "b", "c"]);
      expect(t.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
    }
  });

  it("nests when the new split is the other direction", () => {
    let t: LayoutNode = leaf("a");
    t = splitLeaf(t, "a", "b", "row"); // [a|b]
    t = splitLeaf(t, "b", "c", "col"); // a | (b over c)
    expect(leafIds(t)).toEqual(["a", "b", "c"]);
    if (t.kind === "split") {
      expect(t.dir).toBe("row");
      expect(t.children[1].kind).toBe("split");
    }
  });
});

describe("removeLeaf", () => {
  it("collapses a binary split to its surviving child", () => {
    const t = splitLeaf(leaf("a"), "a", "b", "row");
    expect(removeLeaf(t, "b")).toEqual(leaf("a"));
  });

  it("keeps a 3-way split as a 2-way and re-evens sizes", () => {
    let t: LayoutNode = leaf("a");
    t = splitLeaf(t, "a", "b", "row");
    t = splitLeaf(t, "b", "c", "row");
    const next = removeLeaf(t, "b")!;
    expect(leafIds(next)).toEqual(["a", "c"]);
    if (next.kind === "split") expect(next.sizes).toEqual([0.5, 0.5]);
  });

  it("returns null when the last leaf is removed", () => {
    expect(removeLeaf(leaf("a"), "a")).toBeNull();
  });

  it("collapses nested splits correctly", () => {
    let t: LayoutNode = leaf("a");
    t = splitLeaf(t, "a", "b", "row"); // [a|b]
    t = splitLeaf(t, "b", "c", "col"); // a | (b/c)
    const next = removeLeaf(t, "c")!; // a | b  → the (b/c) split collapses to b
    expect(leafIds(next)).toEqual(["a", "b"]);
  });
});

describe("neighborLeaf / firstLeafId / setSizes", () => {
  it("finds the neighbor (right then left)", () => {
    let t: LayoutNode = leaf("a");
    t = splitLeaf(t, "a", "b", "row");
    t = splitLeaf(t, "b", "c", "row"); // a|b|c
    expect(neighborLeaf(t, "b")).toBe("c"); // right
    expect(neighborLeaf(t, "c")).toBe("b"); // last → left
  });
  it("firstLeafId returns the leftmost pane", () => {
    let t: LayoutNode = leaf("a");
    t = splitLeaf(t, "a", "b", "row");
    expect(firstLeafId(t)).toBe("a");
  });
  it("setSizes replaces a split's sizes at a path", () => {
    let t: LayoutNode = leaf("a");
    t = splitLeaf(t, "a", "b", "row");
    const next = setSizes(t, [], [0.7, 0.3]);
    if (next.kind === "split") expect(next.sizes).toEqual([0.7, 0.3]);
  });
});
