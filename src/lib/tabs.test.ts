import { describe, expect, it } from "vitest";
import { reorderTabs, insertTab } from "./tabs";

describe("reorderTabs", () => {
  const T = ["A", "B", "C", "D"];
  it("moves a tab rightward to the intended slot (off-by-one compensated)", () => {
    // drag A, drop before C (slot 2) → A lands just before C
    expect(reorderTabs(T, "A", 2)).toEqual(["B", "A", "C", "D"]);
    // drag A to the very end (slot 4)
    expect(reorderTabs(T, "A", 4)).toEqual(["B", "C", "D", "A"]);
  });
  it("moves a tab leftward without adjustment", () => {
    // drag D, drop before B (slot 1)
    expect(reorderTabs(T, "D", 1)).toEqual(["A", "D", "B", "C"]);
    // drag C to the front (slot 0)
    expect(reorderTabs(T, "C", 0)).toEqual(["C", "A", "B", "D"]);
  });
  it("is a no-op when dropped on its own slot", () => {
    expect(reorderTabs(T, "B", 1)).toEqual(T); // origIdx 1, drop before self
    expect(reorderTabs(T, "B", 2)).toEqual(T); // drop just after self
  });
  it("ignores an unknown path", () => {
    expect(reorderTabs(T, "Z", 0)).toEqual(T);
  });
});

describe("insertTab (cross-pane)", () => {
  it("inserts at the slot, clamped, de-duping", () => {
    expect(insertTab(["A", "B"], "X", 1)).toEqual(["A", "X", "B"]);
    expect(insertTab(["A", "B"], "X", 99)).toEqual(["A", "B", "X"]);
    expect(insertTab(["A", "B", "X"], "X", 0)).toEqual(["X", "A", "B"]); // already present → moved
  });
});
