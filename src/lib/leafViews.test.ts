import { describe, expect, it } from "vitest";
import { viewPath, isViewPath, parseViewPath, viewLabel, BUILTIN_VIEWS } from "./leafViews";

describe("leafViews", () => {
  it("round-trips every built-in view through viewPath/parseViewPath", () => {
    for (const type of BUILTIN_VIEWS) {
      const path = viewPath({ type });
      expect(isViewPath(path)).toBe(true);
      expect(parseViewPath(path)).toEqual({ type });
    }
  });

  it("round-trips a plugin view", () => {
    const path = viewPath({ type: "plugin", viewId: "demo-view" });
    expect(isViewPath(path)).toBe(true);
    expect(parseViewPath(path)).toEqual({ type: "plugin", viewId: "demo-view" });
  });

  it("treats a real note path as not-a-view", () => {
    expect(isViewPath("/vault/Notes/Idea.md")).toBe(false);
    expect(parseViewPath("/vault/Notes/Idea.md")).toBeNull();
    expect(parseViewPath("Projects/Roadmap.md")).toBeNull();
  });

  it("rejects an unknown built-in view name and an empty plugin id", () => {
    const prefix = viewPath({ type: "outline" }).replace("outline", "");
    expect(parseViewPath(prefix + "nonsense")).toBeNull();
    expect(parseViewPath(prefix + "plugin:")).toBeNull();
  });

  it("labels built-ins and falls back to the id for plugin views", () => {
    expect(viewLabel({ type: "backlinks" })).toBe("Backlinks");
    expect(viewLabel({ type: "filetree" })).toBe("Files");
    expect(viewLabel({ type: "plugin", viewId: "my-view" })).toBe("my-view");
  });
});
