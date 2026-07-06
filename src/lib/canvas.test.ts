import { describe, expect, it } from "vitest";
import { parseCanvas, serializeCanvas, canvasBounds, canvasColor } from "./canvas";

describe("serializeCanvas", () => {
  it("round-trips parse → serialize → parse", () => {
    const src = JSON.stringify({
      nodes: [
        { id: "t", type: "text", text: "# Hi", x: 0, y: 0, width: 200, height: 100, color: "4" },
        { id: "f", type: "file", file: "notes/Foo.md", subpath: "#H", x: 300, y: 0, width: 200, height: 100 },
        { id: "l", type: "link", url: "https://x.com", x: 0, y: 200, width: 200, height: 80 },
        { id: "g", type: "group", label: "Section", x: -20, y: -20, width: 600, height: 400 },
      ],
      edges: [{ id: "e1", fromNode: "t", toNode: "f", toEnd: "arrow", fromSide: "right", toSide: "left", label: "rel" }],
    });
    const once = serializeCanvas(parseCanvas(src)!);
    const back = parseCanvas(once)!;
    expect(back.nodes.map((n) => [n.id, n.type])).toEqual([["t", "text"], ["f", "file"], ["l", "link"], ["g", "group"]]);
    expect(back.nodes.find((n) => n.id === "f")).toMatchObject({ file: "notes/Foo.md", subpath: "#H" });
    expect(back.edges[0]).toMatchObject({ id: "e1", fromNode: "t", toNode: "f", toEnd: "arrow", label: "rel" });
    // idempotent: serializing the re-parsed data yields identical text
    expect(serializeCanvas(back)).toBe(once);
  });

  it("omits undefined optional fields and rounds geometry", () => {
    const s = serializeCanvas({
      nodes: [{ id: "a", type: "text", text: "x", x: 1.4, y: 2.6, width: 200, height: 60 }],
      edges: [],
    });
    expect(s).not.toContain("color");
    expect(s).not.toContain("subpath");
    expect(JSON.parse(s).nodes[0]).toMatchObject({ x: 1, y: 3 });
  });

  it("preserves Obsidian/unknown fields Basalt does not model (no silent data loss)", () => {
    const src = JSON.stringify({
      nodes: [
        {
          id: "n1",
          type: "text",
          text: "hi",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          color: "3",
          styleAttributes: { shape: "pill" }, // Obsidian extension Basalt doesn't model
          backgroundColor: "#123456",
        },
      ],
      edges: [{ id: "e1", fromNode: "n1", toNode: "n1", styleAttributes: { pathfindingMethod: "square" } }],
    });
    const out = JSON.parse(serializeCanvas(parseCanvas(src)!));
    expect(out.nodes[0].styleAttributes).toEqual({ shape: "pill" });
    expect(out.nodes[0].backgroundColor).toBe("#123456");
    expect(out.edges[0].styleAttributes).toEqual({ pathfindingMethod: "square" });
    expect(out.nodes[0]).toMatchObject({ text: "hi", color: "3", x: 0 });
  });

  it("preserves an unknown NODE TYPE + its edge across an edit (no drop-on-save)", () => {
    const src = JSON.stringify({
      nodes: [
        { id: "p1", type: "mermaid", x: 0, y: 0, width: 300, height: 200, code: "graph TD;A-->B" },
        { id: "t1", type: "text", x: 0, y: 300, width: 200, height: 60, text: "note" },
      ],
      edges: [{ id: "e1", fromNode: "p1", toNode: "t1" }],
    });
    const data = parseCanvas(src)!;
    // Simulate an edit to the modeled node, then serialize (as CanvasView does).
    data.nodes[0].x = 42;
    const out = JSON.parse(serializeCanvas(data));
    const ids = out.nodes.map((n: { id: string }) => n.id).sort();
    expect(ids).toEqual(["p1", "t1"]); // the mermaid node survived
    expect(out.nodes.find((n: { id: string }) => n.id === "p1")).toMatchObject({ type: "mermaid", code: "graph TD;A-->B" });
    expect(out.edges.map((e: { id: string }) => e.id)).toEqual(["e1"]); // its edge too
  });

  it("preserves top-level canvas keys besides nodes/edges", () => {
    const src = JSON.stringify({ nodes: [], edges: [], obsidianMeta: { zoom: 2 } });
    const out = JSON.parse(serializeCanvas(parseCanvas(src)!));
    expect(out.obsidianMeta).toEqual({ zoom: 2 });
  });

  it("clearing a modeled optional (color) drops the key even if it was in the original", () => {
    const src = JSON.stringify({
      nodes: [{ id: "n", type: "text", text: "x", x: 0, y: 0, width: 200, height: 60, color: "5" }],
      edges: [],
    });
    const data = parseCanvas(src)!;
    data.nodes[0].color = undefined;
    expect(JSON.parse(serializeCanvas(data)).nodes[0].color).toBeUndefined();
  });
});

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

  it("is tolerant: never throws; models valid entries, preserves the rest", () => {
    expect(parseCanvas("not json")).toBeNull();
    expect(parseCanvas("{}")).toMatchObject({ nodes: [], edges: [] });
    const c = parseCanvas(
      JSON.stringify({
        nodes: [
          { type: "text", text: "no id" }, // not modeled (no id) → preserved
          { id: "x", type: "text" }, // not modeled (no text) → preserved
          { id: "ok", type: "text", text: "y" },
          null,
        ],
        edges: "nonsense",
      }),
    )!;
    // only the valid node is interactive…
    expect(c.nodes.map((n) => n.id)).toEqual(["ok"]);
    expect(c.edges).toEqual([]);
    // …but the unmodeled ones are kept verbatim (non-destructive on save).
    expect(c.passNodes).toHaveLength(3);
  });

  it("defaults missing geometry", () => {
    const c = parseCanvas(JSON.stringify({ nodes: [{ id: "a", type: "text", text: "t" }] }))!;
    expect(c.nodes[0]).toMatchObject({ x: 0, y: 0, width: 200, height: 60 });
  });

  it("models only the first of duplicate node/edge ids (dupes preserved, not modeled)", () => {
    const c = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", text: "first" },
          { id: "a", type: "text", text: "second" }, // dup id → not modeled
          { id: "b", type: "text", text: "b" },
        ],
        edges: [
          { id: "e", fromNode: "a", toNode: "b" },
          { id: "e", fromNode: "b", toNode: "a" }, // dup id → not modeled
        ],
      }),
    )!;
    expect(c.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect((c.nodes[0] as { text: string }).text).toBe("first");
    expect(c.edges).toHaveLength(1);
    expect(c.passNodes).toHaveLength(1); // the dup kept verbatim
    expect(c.passEdges).toHaveLength(1);
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
