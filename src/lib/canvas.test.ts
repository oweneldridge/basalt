import { describe, expect, it } from "vitest";
import { parseCanvas, serializeCanvas, canvasBounds, canvasColor, canvasText, rewriteCanvasFileRefs, withGroupContents, orderGroups, passInGroups, movePassNodes, pushHistory, stepHistory, CANVAS_HISTORY_LIMIT, type CanvasData, type CanvasNode } from "./canvas";

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
    expect(back.nodes.map((n) => [n.id, n.type])).toEqual([["g", "group"], ["t", "text"], ["f", "file"], ["l", "link"]]);
    expect(back.nodes.find((n) => n.id === "f")).toMatchObject({ file: "notes/Foo.md", subpath: "#H" });
    expect(back.edges[0]).toMatchObject({ id: "e1", fromNode: "t", toNode: "f", label: "rel" });
    expect(once).not.toContain("toEnd");
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

  it("keeps a group's background as the file had it, an empty one too", () => {
    for (const background of ["", null, "img.png"]) {
      const text = JSON.stringify({ nodes: [{ id: "g", type: "group", x: 0, y: 0, width: 10, height: 10, background }], edges: [] });
      expect(JSON.parse(serializeCanvas(parseCanvas(text)!)).nodes[0].background).toBe(background);
    }
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

describe("rewriteCanvasFileRefs", () => {
  it("fixes links in text cards too, when given a fixer", () => {
    const canvas = JSON.stringify({ nodes: [{ id: "t", type: "text", text: "see [[Old]]", x: 0, y: 0, width: 1, height: 1 }], edges: [] });
    const fix = (t: string) => (t.includes("[[Old]]") ? t.replace("[[Old]]", "[[New]]") : null);
    expect(JSON.parse(rewriteCanvasFileRefs(canvas, new Map([["Old.md", "New.md"]]), fix)!).nodes[0].text).toBe("see [[New]]");
    expect(rewriteCanvasFileRefs(canvas, new Map([["Old.md", "New.md"]]))).toBeNull();
  });
  const canvas = JSON.stringify({
    nodes: [
      { id: "a", type: "file", file: "Notes/Old.md", x: 0, y: 0, width: 200, height: 100 },
      { id: "b", type: "file", file: "Notes/Old.md", subpath: "#Heading", x: 0, y: 0, width: 200, height: 100 },
      { id: "c", type: "text", text: "hi", x: 0, y: 0, width: 100, height: 60 },
      { id: "d", type: "file", file: "Other.md", x: 0, y: 0, width: 100, height: 60 },
    ],
    edges: [],
  });
  it("remaps matching file nodes and preserves subpath + other nodes", () => {
    const out = rewriteCanvasFileRefs(canvas, new Map([["Notes/Old.md", "Archive/New.md"]]));
    expect(out).not.toBeNull();
    const d = parseCanvas(out!)!;
    const files = d.nodes.filter((n) => n.type === "file");
    expect(files.map((n) => (n as { file: string }).file)).toEqual(["Archive/New.md", "Archive/New.md", "Other.md"]);
    expect((files[1] as { subpath?: string }).subpath).toBe("#Heading"); // subpath kept
  });
  it("returns null when nothing matches", () => {
    expect(rewriteCanvasFileRefs(canvas, new Map([["Nope.md", "X.md"]]))).toBeNull();
    expect(rewriteCanvasFileRefs("not json", new Map([["a", "b"]]))).toBeNull();
  });
  it("matches case-insensitively as a fallback (case-only divergence)", () => {
    const c = JSON.stringify({ nodes: [{ id: "a", type: "file", file: "notes/old.md", x: 0, y: 0, width: 1, height: 1 }], edges: [] });
    const out = rewriteCanvasFileRefs(c, new Map([["Notes/Old.md", "Notes/New.md"]]));
    expect(out).not.toBeNull();
    expect(parseCanvas(out!)!.nodes.filter((n) => n.type === "file").map((n) => (n as { file: string }).file)).toEqual(["Notes/New.md"]);
  });
});

describe("rewriteCanvasFileRefs — minimal, non-destructive", () => {
  it("preserves fractional geometry and unmodeled fields (no rounding / loss)", () => {
    const raw = JSON.stringify({
      nodes: [
        { id: "a", type: "file", file: "Old.md", x: 10.7, y: -3.2, width: 200.9, height: 100.1, styleAttributes: { z: 1 } },
      ],
      edges: [],
      metadata: { custom: true },
    });
    const out = rewriteCanvasFileRefs(raw, new Map([["Old.md", "New.md"]]))!;
    const o = JSON.parse(out);
    expect(o.nodes[0].file).toBe("New.md");
    expect(o.nodes[0].x).toBe(10.7); // NOT rounded
    expect(o.nodes[0].height).toBe(100.1);
    expect(o.nodes[0].styleAttributes).toEqual({ z: 1 }); // unmodeled field kept
    expect(o.metadata).toEqual({ custom: true }); // top-level unmodeled key kept
  });
});

describe("empty text cards", () => {
  it("keep their required text key, so they reload as cards", () => {
    const data = parseCanvas(JSON.stringify({ nodes: [{ id: "a", type: "text", text: "", x: 0, y: 0, width: 100, height: 50 }], edges: [] }))!;
    const out = serializeCanvas(data);
    expect(JSON.parse(out).nodes[0]).toHaveProperty("text", "");
    expect(parseCanvas(out)!.nodes.map((n) => n.id)).toEqual(["a"]);
  });
});

describe("canvas layout on disk", () => {
  it("writes a canvas as Obsidian does: one line per node, no trailing newline", () => {
    const before =
      '{\n\t"nodes":[\n\t\t{"id":"n1","type":"file","file":"Target.md","x":0,"y":0,"width":300,"height":200},\n' +
      '\t\t{"id":"n2","type":"text","text":"See [[Target]]","x":340,"y":0,"width":300,"height":120}\n\t],\n\t"edges":[]\n}';
    const after = rewriteCanvasFileRefs(before, new Map([["Target.md", "Target Renamed.md"]]), (t) => t.replace("[[Target]]", "[[Target Renamed]]"));
    expect(after).toBe(before.replace('"file":"Target.md"', '"file":"Target Renamed.md"').replace("[[Target]]", "[[Target Renamed]]"));
    const saved = serializeCanvas(parseCanvas(before)!);
    expect(saved.split("\n")).toHaveLength(7);
    expect(saved.endsWith("\n}")).toBe(true);
  });

  // Each file as written, the drag made on it in Obsidian 1.14, and the file
  // Obsidian saved then.
  const SAVES: [string, [string, number, number], string][] = [
      ["{\"nodes\":[{\"id\":\"a1\",\"type\":\"text\",\"text\":\"Drag me a little\",\"x\":0,\"y\":0,\"width\":250,\"height\":60},{\"id\":\"b2\",\"type\":\"text\",\"text\":\"Second card\",\"x\":400,\"y\":0,\"width\":250,\"height\":60}],\"edges\":[{\"id\":\"e1\",\"fromNode\":\"a1\",\"fromSide\":\"right\",\"toNode\":\"b2\",\"toSide\":\"left\"}],\"groups\":[{\"id\":\"g1\",\"label\":\"one\"},{\"id\":\"g2\",\"label\":\"two\"}],\"tags\":[\"x\",\"y\"],\"empty\":[],\"meta\":{\"list\":[1,2],\"note\":\"kept\"}}", ["a1", 20, 0], "{\n\t\"nodes\":[\n\t\t{\"id\":\"b2\",\"type\":\"text\",\"text\":\"Second card\",\"x\":400,\"y\":0,\"width\":250,\"height\":60},\n\t\t{\"id\":\"a1\",\"type\":\"text\",\"text\":\"Drag me a little\",\"x\":20,\"y\":0,\"width\":250,\"height\":60}\n\t],\n\t\"edges\":[\n\t\t{\"id\":\"e1\",\"fromNode\":\"a1\",\"fromSide\":\"right\",\"toNode\":\"b2\",\"toSide\":\"left\"}\n\t],\n\t\"groups\":[\n\t\t{\"id\":\"g1\",\"label\":\"one\"},\n\t\t{\"id\":\"g2\",\"label\":\"two\"}\n\t],\n\t\"tags\":[\"x\",\"y\"],\n\t\"empty\":[],\n\t\"meta\":{\n\t\t\"list\":[1,2],\n\t\t\"note\":\"kept\"\n\t}\n}"],
      ["{\"nodes\":[{\"id\":\"n1\",\"type\":\"text\",\"text\":\"One: drag me\",\"x\":0,\"y\":0,\"width\":250,\"height\":60,\"styleAttributes\":{}},{\"id\":\"n2\",\"type\":\"text\",\"text\":\"Two: click me once\",\"x\":0,\"y\":150,\"width\":250,\"height\":60,\"extra\":{\"a\":[1]}},{\"id\":\"n3\",\"type\":\"text\",\"text\":\"Three\",\"x\":0,\"y\":300,\"width\":250,\"height\":60}],\"edges\":[],\"mixed\":[1,{\"a\":1}],\"arrOfArr\":[[1],[2,3]],\"deep\":{\"inner\":{\"x\":1},\"arr\":[[1,2],[3]],\"objs\":[{\"a\":1},{\"b\":2}],\"empty\":{}},\"emptyObj\":{},\"num\":5,\"str\":\"s\"}", ["n1", 60, 0], "{\n\t\"nodes\":[\n\t\t{\n\t\t\t\"id\":\"n2\",\n\t\t\t\"type\":\"text\",\n\t\t\t\"text\":\"Two: click me once\",\n\t\t\t\"extra\":{\n\t\t\t\t\"a\":[1]\n\t\t\t},\n\t\t\t\"x\":0,\n\t\t\t\"y\":150,\n\t\t\t\"width\":250,\n\t\t\t\"height\":60\n\t\t},\n\t\t{\"id\":\"n3\",\"type\":\"text\",\"text\":\"Three\",\"x\":0,\"y\":300,\"width\":250,\"height\":60},\n\t\t{\n\t\t\t\"id\":\"n1\",\n\t\t\t\"type\":\"text\",\n\t\t\t\"text\":\"One: drag me\",\n\t\t\t\"styleAttributes\":{},\n\t\t\t\"x\":60,\n\t\t\t\"y\":0,\n\t\t\t\"width\":250,\n\t\t\t\"height\":60\n\t\t}\n\t],\n\t\"edges\":[],\n\t\"mixed\":[\n\t\t1,\n\t\t{\"a\":1}\n\t],\n\t\"arrOfArr\":[\n\t\t[1],\n\t\t[2,3]\n\t],\n\t\"deep\":{\n\t\t\"inner\":{\"x\":1},\n\t\t\"arr\":[\n\t\t\t[1,2],\n\t\t\t[3]\n\t\t],\n\t\t\"objs\":[\n\t\t\t{\"a\":1},\n\t\t\t{\"b\":2}\n\t\t],\n\t\t\"empty\":{}\n\t},\n\t\"emptyObj\":{},\n\t\"num\":5,\n\t\"str\":\"s\"\n}"],
      ["{\"edges\":[{\"toNode\":\"f1\",\"label\":\"L\",\"color\":\"3\",\"toEnd\":\"arrow\",\"fromEnd\":\"none\",\"toSide\":\"top\",\"fromSide\":\"bottom\",\"fromNode\":\"t1\",\"id\":\"e1\",\"qq\":1}],\"extra\":1,\"nodes\":[{\"height\":60,\"color\":\"1\",\"x\":0,\"zz\":1,\"text\":\"Text: drag me\",\"width\":250,\"y\":0,\"type\":\"text\",\"id\":\"t1\"},{\"subpath\":\"#H\",\"y\":150,\"file\":\"Missing.md\",\"x\":0,\"id\":\"f1\",\"width\":250,\"height\":60,\"type\":\"file\",\"aa\":2,\"color\":\"2\"},{\"url\":\"https://example.com\",\"id\":\"l1\",\"type\":\"link\",\"x\":300,\"y\":150,\"width\":250,\"height\":60,\"color\":\"#ff0000\"},{\"label\":\"G\",\"background\":\"bg.png\",\"backgroundStyle\":\"cover\",\"type\":\"group\",\"id\":\"g1\",\"x\":-50,\"y\":400,\"width\":400,\"height\":200}]}", ["t1", 50, -40], "{\n\t\"edges\":[\n\t\t{\"id\":\"e1\",\"qq\":1,\"fromNode\":\"t1\",\"fromSide\":\"bottom\",\"toNode\":\"f1\",\"toSide\":\"top\",\"color\":\"3\",\"label\":\"L\"}\n\t],\n\t\"extra\":1,\n\t\"nodes\":[\n\t\t{\"backgroundStyle\":\"cover\",\"type\":\"group\",\"id\":\"g1\",\"x\":-50,\"y\":400,\"width\":400,\"height\":200,\"label\":\"G\",\"background\":\"bg.png\"},\n\t\t{\"subpath\":\"#H\",\"file\":\"Missing.md\",\"id\":\"f1\",\"type\":\"file\",\"aa\":2,\"x\":0,\"y\":150,\"width\":250,\"height\":60,\"color\":\"2\"},\n\t\t{\"url\":\"https://example.com\",\"id\":\"l1\",\"type\":\"link\",\"x\":300,\"y\":150,\"width\":250,\"height\":60,\"color\":\"#ff0000\"},\n\t\t{\"zz\":1,\"text\":\"Text: drag me\",\"type\":\"text\",\"id\":\"t1\",\"x\":50,\"y\":-40,\"width\":250,\"height\":60,\"color\":\"1\"}\n\t]\n}"],
  ];

  it("saves a dragged canvas as Obsidian 1.14 does", () => {
    for (const [before, [id, x, y], saved] of SAVES) {
      const data = parseCanvas(before)!;
      const moved = { ...data.nodes.find((n) => n.id === id)!, x, y };
      expect(serializeCanvas({ ...data, nodes: [...data.nodes.filter((n) => n.id !== id), moved] })).toBe(saved);
    }
  });

  it("lays out a value an entry per line when it holds an object or array", () => {
    for (const [, , saved] of SAVES) expect(canvasText(JSON.parse(saved))).toBe(saved);
    expect(canvasText({ nodes: [], edges: [], tags: ["a", ["b"]] })).toBe('{\n\t"nodes":[],\n\t"edges":[],\n\t"tags":[\n\t\t"a",\n\t\t["b"]\n\t]\n}');
    expect(canvasText({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(canvasText({})).toBe("{}");
  });

  it("writes an edge's ends only when they aren't the defaults, each after its side", () => {
    // Ends first in the file, so only the save puts them in their place.
    const edge = (ends: object) =>
      JSON.stringify(JSON.parse(serializeCanvas(parseCanvas(JSON.stringify({ nodes: ["a", "b"].map((id) => ({ id, type: "text", text: "", x: 0, y: 0, width: 1, height: 1 })), edges: [{ ...ends, id: "e", fromNode: "a", toNode: "b" }] }))!)).edges[0]);
    expect(edge({ fromEnd: "none", toEnd: "arrow" })).toBe('{"id":"e","fromNode":"a","toNode":"b"}');
    expect(edge({ fromEnd: "arrow", toEnd: "none" })).toBe('{"id":"e","fromNode":"a","fromEnd":"arrow","toNode":"b","toEnd":"none"}');
  });

  it("writes a null value as it is, on a line with its card", () => {
    expect(canvasText({ a: [null] })).toBe('{\n\t"a":[null]\n}');
    const card = '{"id":"a","type":"text","text":"","foo":null,"x":0,"y":0,"width":1,"height":1}';
    expect(serializeCanvas(parseCanvas(`{"nodes":[${card}],"edges":[]}`)!)).toBe(`{\n\t"nodes":[\n\t\t${card}\n\t],\n\t"edges":[]\n}`);
  });

  it("puts a group's place, colour and label after its other keys", () => {
    const group = (keys: string) => serializeCanvas(parseCanvas(`{"nodes":[{"id":"g","type":"group",${keys}}],"edges":[]}`)!);
    expect(group('"x":0,"zz":1,"y":0,"width":1,"height":1')).toContain('{"id":"g","type":"group","zz":1,"x":0,"y":0,"width":1,"height":1}');
    expect(group('"color":"1","label":"L","x":0,"y":0,"width":1,"height":1')).toContain('{"id":"g","type":"group","x":0,"y":0,"width":1,"height":1,"color":"1","label":"L"}');
  });

  it("keeps the file's key order and a __proto__ key on save", () => {
    const meta = '{"metadata":{"v":1},"nodes":[],"edges":[],"z":1}';
    expect(serializeCanvas(parseCanvas(meta)!)).toBe('{\n\t"metadata":{"v":1},\n\t"nodes":[],\n\t"edges":[],\n\t"z":1\n}');
    const proto = '{"__proto__":{"a":1},"nodes":[],"edges":[]}';
    const out = serializeCanvas(parseCanvas(proto)!);
    expect(out).toBe('{\n\t"__proto__":{"a":1},\n\t"nodes":[],\n\t"edges":[]\n}');
    expect(Object.getOwnPropertyNames(JSON.parse(out))).toEqual(["__proto__", "nodes", "edges"]);
    // A canvas made here starts with nodes, then edges.
    expect(serializeCanvas({ nodes: [], edges: [] })).toBe('{\n\t"nodes":[],\n\t"edges":[]\n}');
  });
});

describe("canvas groups", () => {
  const g = (id: string, x: number, y: number, width: number, height: number): CanvasNode => ({ id, type: "group", x, y, width, height });
  const t = (id: string, x: number, y: number): CanvasNode => ({ id, type: "text", text: id, x, y, width: 50, height: 20 });

  it("a group moves with what lies wholly inside it, nested groups included", () => {
    const nodes = [g("outer", 0, 0, 400, 300), g("inner", 20, 20, 200, 150), t("a", 30, 30), t("edge", 390, 10), t("out", 500, 0)];
    expect([...withGroupContents(nodes, ["outer"])].sort()).toEqual(["a", "inner", "outer"]);
    expect([...withGroupContents(nodes, ["inner"])].sort()).toEqual(["a", "inner"]);
    expect([...withGroupContents(nodes, ["a"])]).toEqual(["a"]);
    // Only a group holds things; a card over a smaller one moves alone.
    expect([...withGroupContents([{ ...t("big", 0, 0), width: 500, height: 500 }, t("a", 10, 10)], ["big"])]).toEqual(["big"]);
    // Touching the edges still counts as inside.
    expect([...withGroupContents([g("box", 0, 0, 50, 20), t("fit", 0, 0)], ["box"])].sort()).toEqual(["box", "fit"]);
  });

  it("finds the nodes Basalt doesn't model inside a moved group, and moves them keeping their keys", () => {
    const data = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "g", type: "group", x: 0, y: 0, width: 400, height: 300 },
          { id: "in", type: "future", x: 30, y: 150, width: 50, height: 50, extra: { a: 1 } },
          { type: "noid", x: 10, y: 10, width: 10, height: 10 },
          { id: "out", type: "future", x: 390, y: 10, width: 50, height: 50 },
          { id: "nobox", type: "future", x: 10, y: 10 },
          { id: "text", type: "future", x: "10", y: 10, width: 5, height: 5 },
          "junk",
          null,
        ],
      }),
    )!;
    expect(passInGroups(data, new Set(["g"]))).toEqual([0, 1]);
    expect(passInGroups(data, new Set(["other"]))).toEqual([]);
    expect(passInGroups({ ...data, passNodes: undefined }, new Set(["g"]))).toEqual([]);
    const moved = movePassNodes(data.passNodes, [0, 1], 20.4, -5.6)!;
    expect(moved[0]).toEqual({ id: "in", type: "future", x: 50, y: 144, width: 50, height: 50, extra: { a: 1 } });
    expect(Object.keys(moved[0] as object)).toEqual(["id", "type", "x", "y", "width", "height", "extra"]);
    expect(moved[1]).toEqual({ type: "noid", x: 30, y: 4, width: 10, height: 10 });
    expect(moved.slice(2)).toEqual(data.passNodes!.slice(2));
    expect(moved[2]).toBe(data.passNodes![2]);
    expect(data.passNodes![0]).toMatchObject({ x: 30, y: 150 });
    expect(movePassNodes(data.passNodes, [], 5, 5)).toBe(data.passNodes);
    expect(movePassNodes(undefined, [0], 5, 5)).toBeUndefined();
  });

  it("orders a group before the smaller groups inside it, and otherwise keeps the order", () => {
    const ids = (ns: CanvasNode[]) => orderGroups(ns).map((n) => n.id);
    const inner = g("inner", 20, 20, 200, 150);
    const outer = g("outer", 0, 0, 400, 300);
    const other = g("other", 600, 0, 100, 100);
    expect(ids([t("a", 30, 30), inner, other, outer])).toEqual(["other", "outer", "inner", "a"]);
    expect(ids([other, outer, inner])).toEqual(["other", "outer", "inner"]);
    expect(ids([g("deep", 40, 40, 50, 50), inner, outer])).toEqual(["outer", "inner", "deep"]);
    // Two the same size can't hold each other; they keep their order.
    expect(ids([g("b", 0, 0, 10, 10), g("a", 0, 0, 10, 10)])).toEqual(["b", "a"]);
    // A group only partly over another, on any side, doesn't hold it.
    for (const [x, y] of [[-50, 10], [10, -50], [350, 10], [10, 250]])
      expect(ids([g("small", x, y, 100, 100), outer])).toEqual(["small", "outer"]);
  });
});

describe("canvas undo history", () => {
  const at = (x: number): CanvasData => ({ nodes: [{ id: "a", type: "text", text: "", x, y: 0, width: 50, height: 20 }], edges: [] });
  const none = { past: [], future: [] };

  it("undoes and redoes each edit in turn, back to the start and forward again", () => {
    const [s0, s1, s2] = [at(0), at(10), at(20)];
    let h = pushHistory(pushHistory(none, s0), s1);
    let shown = s2;
    const go = (dir: "undo" | "redo") => {
      const r = stepHistory(h, shown, dir);
      if (r) [h, shown] = [r.history, r.data];
      return r && shown;
    };
    expect(go("redo")).toBeNull();
    expect(go("undo")).toBe(s1);
    expect(go("undo")).toBe(s0);
    expect(go("undo")).toBeNull();
    expect(shown).toBe(s0);
    expect(go("redo")).toBe(s1);
    expect(go("redo")).toBe(s2);
    expect(go("redo")).toBeNull();
    expect(h).toEqual({ past: [s0, s1], future: [] });
  });

  it("drops what was undone once there's a new edit", () => {
    const [s0, s1, s2] = [at(0), at(10), at(20)];
    const undone = stepHistory(pushHistory(none, s0), s1, "undo")!;
    expect(undone.history).toEqual({ past: [], future: [s1] });
    expect(pushHistory(undone.history, undone.data)).toEqual({ past: [s0], future: [] });
    expect(stepHistory(pushHistory(undone.history, undone.data), s2, "redo")).toBeNull();
  });

  it("keeps the last 100 steps", () => {
    expect(CANVAS_HISTORY_LIMIT).toBe(100);
    const states = Array.from({ length: 105 }, (_, i) => at(i));
    const h = states.reduce((acc, s) => pushHistory(acc, s), { past: [], future: [] } as { past: CanvasData[]; future: CanvasData[] });
    expect(h.past.length).toBe(100);
    expect(h.past[0]).toBe(states[5]);
    expect(h.past[99]).toBe(states[104]);
    expect(pushHistory(none, at(0), 2).past.length).toBe(1);
    expect(pushHistory({ past: [at(0), at(1)], future: [] }, at(2), 2).past.map((d) => d.nodes[0].x)).toEqual([1, 2]);
  });

  it("leaves the history it was given as it was", () => {
    const h = { past: [at(0)], future: [at(5)] };
    pushHistory(h, at(1));
    stepHistory(h, at(2), "undo");
    stepHistory(h, at(2), "redo");
    expect(h).toEqual({ past: [at(0)], future: [at(5)] });
  });
});
