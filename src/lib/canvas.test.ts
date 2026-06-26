import { describe, expect, it } from "vitest";
import { parseCanvas, canvasBounds, canvasColor } from "./canvas";

describe("parseCanvas", () => {
  it("parses text/file/link/group nodes and validated edges", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "a", type: "text", text: "# Hi", x: 0, y: 0, width: 200, height: 100 },
        { id: "b", type: "file", file: "notes/Foo.md", subpath: "#H", x: 300, y: 0, width: 200, height: 100, color: "4" },
        { id: "c", type: "link", url: "https://x.com", x: 0, y: 200, width: 200, height: 80 },
        { id: "g", type: "group", label: "Section", x: -20, y: -20, width: 600, height: 400 },
      ],
      edges: [
        { id: "e1", fromNode: "a", toNode: "b", toEnd: "arrow", fromSide: "right", toSide: "left", label: "rel" },
        { id: "bad", fromNode: "a", toNode: "missing" }, // dropped: target absent
      ],
    });
    const c = parseCanvas(json)!;
    expect(c.nodes.map((n) => [n.id, n.type])).toEqual([
      ["a", "text"],
      ["b", "file"],
      ["c", "link"],
      ["g", "group"],
    ]);
    const file = c.nodes.find((n) => n.id === "b");
    expect(file).toMatchObject({ type: "file", file: "notes/Foo.md", subpath: "#H", color: "4" });
    expect(c.edges).toHaveLength(1);
    expect(c.edges[0]).toMatchObject({ id: "e1", fromNode: "a", toNode: "b", toEnd: "arrow", label: "rel" });
  });

  it("is tolerant: drops malformed nodes/edges, never throws", () => {
    expect(parseCanvas("not json")).toBeNull();
    expect(parseCanvas("{}")).toEqual({ nodes: [], edges: [] });
    const c = parseCanvas(
      JSON.stringify({
        nodes: [
          { type: "text", text: "no id" }, // dropped (no id)
          { id: "x", type: "text" }, // dropped (no text)
          { id: "ok", type: "text", text: "y" },
          null,
        ],
        edges: "nonsense",
      }),
    )!;
    expect(c.nodes.map((n) => n.id)).toEqual(["ok"]);
    expect(c.edges).toEqual([]);
  });

  it("defaults missing geometry", () => {
    const c = parseCanvas(JSON.stringify({ nodes: [{ id: "a", type: "text", text: "t" }] }))!;
    expect(c.nodes[0]).toMatchObject({ x: 0, y: 0, width: 200, height: 60 });
  });

  it("drops duplicate node and edge ids (keeps first)", () => {
    const c = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", text: "first" },
          { id: "a", type: "text", text: "second" }, // dup id dropped
          { id: "b", type: "text", text: "b" },
        ],
        edges: [
          { id: "e", fromNode: "a", toNode: "b" },
          { id: "e", fromNode: "b", toNode: "a" }, // dup id dropped
        ],
      }),
    )!;
    expect(c.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect((c.nodes[0] as { text: string }).text).toBe("first");
    expect(c.edges).toHaveLength(1);
  });

  it("clamps negative/zero geometry to a positive minimum (no inverted bounds)", () => {
    const c = parseCanvas(
      JSON.stringify({ nodes: [{ id: "a", type: "text", text: "x", width: -100, height: 0 }] }),
    )!;
    expect(c.nodes[0]).toMatchObject({ width: 1, height: 1 });
    const b = canvasBounds(c.nodes)!;
    expect(b.maxX).toBeGreaterThanOrEqual(b.minX);
    expect(b.maxY).toBeGreaterThanOrEqual(b.minY);
  });
});

describe("canvasBounds / canvasColor", () => {
  it("computes the bounding box", () => {
    expect(
      canvasBounds([
        { id: "a", type: "text", text: "", x: 0, y: 0, width: 100, height: 50 },
        { id: "b", type: "text", text: "", x: 200, y: 100, width: 100, height: 50 },
      ]),
    ).toEqual({ minX: 0, minY: 0, maxX: 300, maxY: 150 });
    expect(canvasBounds([])).toBeNull();
  });
  it("maps preset colors and passes hex through", () => {
    expect(canvasColor("4", "#000")).toBe("#44cf6e");
    expect(canvasColor("#abcdef", "#000")).toBe("#abcdef");
    expect(canvasColor(undefined, "#fallback")).toBe("#fallback");
  });
  it("falls back for invalid presets and prototype keys (always returns a string)", () => {
    for (const bad of ["__proto__", "constructor", "toString", "0", "7", "hasOwnProperty"]) {
      const out = canvasColor(bad, "#fallback");
      expect(typeof out).toBe("string");
      expect(out).toBe("#fallback");
    }
  });
});
