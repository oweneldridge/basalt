// JSON Canvas (jsoncanvas.org, the open format Obsidian .canvas files use).
// A tolerant, read-only parser: anything malformed is skipped, never thrown, so
// a viewer always gets a usable {nodes, edges}. Coordinates are screen-style
// (x,y = a node's TOP-LEFT corner, y increasing downward).

export type Side = "top" | "right" | "bottom" | "left";
export type End = "none" | "arrow";

interface NodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Preset "1".."6" or a "#rrggbb" hex. */
  color?: string;
  /** The original parsed object, so serializeCanvas can round-trip fields
   * Basalt doesn't model (Obsidian extensions like styleAttributes, future
   * JSON Canvas fields) instead of silently dropping them on save. */
  raw?: Record<string, unknown>;
}
export interface CanvasTextNode extends NodeBase {
  type: "text";
  text: string;
}
export interface CanvasFileNode extends NodeBase {
  type: "file";
  file: string; // vault-relative path
  subpath?: string; // #heading / #^block
}
export interface CanvasLinkNode extends NodeBase {
  type: "link";
  url: string;
}
export interface CanvasGroupNode extends NodeBase {
  type: "group";
  label?: string;
}
export type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasLinkNode | CanvasGroupNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: Side;
  fromEnd?: End;
  toNode: string;
  toSide?: Side;
  toEnd?: End;
  color?: string;
  label?: string;
  /** Original parsed object — preserves unmodeled fields on save (see NodeBase.raw). */
  raw?: Record<string, unknown>;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Source nodes/edges Basalt can't model (unknown/future/plugin node types,
   * malformed payloads). Kept verbatim and re-emitted on save so editing a
   * canvas never deletes entries Basalt merely doesn't understand. Not rendered. */
  passNodes?: unknown[];
  passEdges?: unknown[];
  /** Top-level canvas keys other than nodes/edges, preserved on save. */
  topRaw?: Record<string, unknown>;
}

/** Serialize a CanvasData back to JSON Canvas text (tab-indented, like
 * Obsidian). Fields Basalt models are written from the live node/edge; any OTHER
 * field present in the original file (`raw`) is preserved so an edit never
 * silently drops Obsidian extensions or future spec fields. Geometry is rounded
 * so drags don't produce noisy sub-pixel diffs. */
export function serializeCanvas(data: CanvasData): string {
  const r = (n: number) => Math.round(n);
  // Set `k` to `v` when defined, else delete it (so removing an optional value —
  // e.g. clearing a node's color — actually drops the key rather than letting a
  // stale value from `raw` survive).
  const put = (o: Record<string, unknown>, k: string, v: unknown) => {
    if (v === undefined || v === null || v === "") delete o[k];
    else o[k] = v;
  };
  const nodes = data.nodes.map((n) => {
    const o: Record<string, unknown> = { ...(n.raw ?? {}) };
    o.id = n.id;
    o.type = n.type;
    o.x = r(n.x);
    o.y = r(n.y);
    o.width = r(n.width);
    o.height = r(n.height);
    put(o, "color", n.color);
    if (n.type === "text") put(o, "text", n.text);
    else if (n.type === "file") {
      put(o, "file", n.file);
      put(o, "subpath", n.subpath);
    } else if (n.type === "link") put(o, "url", n.url);
    else if (n.type === "group") put(o, "label", n.label);
    return o;
  });
  const edges = data.edges.map((e) => {
    const o: Record<string, unknown> = { ...(e.raw ?? {}) };
    o.id = e.id;
    o.fromNode = e.fromNode;
    o.toNode = e.toNode;
    put(o, "fromSide", e.fromSide);
    put(o, "toSide", e.toSide);
    put(o, "fromEnd", e.fromEnd);
    put(o, "toEnd", e.toEnd);
    put(o, "color", e.color);
    put(o, "label", e.label);
    return o;
  });
  // Re-append verbatim the entries Basalt didn't model, and preserve any
  // top-level keys, so a save is non-destructive.
  const top: Record<string, unknown> = { ...(data.topRaw ?? {}) };
  top.nodes = [...nodes, ...(data.passNodes ?? [])];
  top.edges = [...edges, ...(data.passEdges ?? [])];
  return JSON.stringify(top, null, "\t");
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function side(v: unknown): Side | undefined {
  return v === "top" || v === "right" || v === "bottom" || v === "left" ? v : undefined;
}
function end(v: unknown): End | undefined {
  return v === "none" || v === "arrow" ? v : undefined;
}

/** Parse JSON Canvas text. Returns null only if the JSON itself is unparseable;
 * otherwise returns the valid nodes/edges (malformed entries are dropped). */
export function parseCanvas(json: string): CanvasData | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as { nodes?: unknown; edges?: unknown };

  const nodes: CanvasNode[] = [];
  const passNodes: unknown[] = [];
  const seenNodes = new Set<string>();
  // ids the edge validation accepts as endpoints — modeled nodes AND preserved
  // unknown nodes (so an edge touching a plugin node is kept, not deleted).
  const knownIds = new Set<string>();
  for (const raw of Array.isArray(d.nodes) ? d.nodes : []) {
    if (!raw || typeof raw !== "object") {
      passNodes.push(raw);
      continue;
    }
    const n = raw as Record<string, unknown>;
    const id = str(n.id);
    const base = {
      id: id ?? "",
      x: num(n.x),
      y: num(n.y),
      // Clamp to a positive minimum: negative w/h would invert canvasBounds and
      // blank the whole edge SVG (negative viewBox dimensions).
      width: Math.max(1, num(n.width, 200)),
      height: Math.max(1, num(n.height, 60)),
      color: str(n.color),
      raw: n, // keep the original so a later save preserves unmodeled fields
    };
    // A node Basalt can model AND with a unique id becomes interactive; anything
    // else (unknown type, bad payload, missing/duplicate id) is preserved
    // verbatim so a save never deletes it.
    if (id && !seenNodes.has(id)) {
      if (n.type === "text" && typeof n.text === "string") {
        nodes.push({ ...base, type: "text", text: n.text });
      } else if (n.type === "file" && typeof n.file === "string") {
        nodes.push({ ...base, type: "file", file: n.file, subpath: str(n.subpath) });
      } else if (n.type === "link" && typeof n.url === "string") {
        nodes.push({ ...base, type: "link", url: n.url });
      } else if (n.type === "group") {
        nodes.push({ ...base, type: "group", label: str(n.label) });
      } else {
        passNodes.push(raw); // unknown/future/plugin node type
      }
      seenNodes.add(id);
      knownIds.add(id); // its edges are still valid endpoints
    } else {
      passNodes.push(raw); // missing or duplicate id
    }
  }

  const edges: CanvasEdge[] = [];
  const passEdges: unknown[] = [];
  const seenEdges = new Set<string>();
  for (const raw of Array.isArray(d.edges) ? d.edges : []) {
    if (!raw || typeof raw !== "object") {
      passEdges.push(raw);
      continue;
    }
    const e = raw as Record<string, unknown>;
    const id = str(e.id);
    const fromNode = str(e.fromNode);
    const toNode = str(e.toNode);
    if (!id || seenEdges.has(id) || !fromNode || !toNode || !knownIds.has(fromNode) || !knownIds.has(toNode)) {
      passEdges.push(raw); // malformed or dangling — keep verbatim, don't delete
      continue;
    }
    seenEdges.add(id);
    edges.push({
      id,
      fromNode,
      toNode,
      fromSide: side(e.fromSide),
      toSide: side(e.toSide),
      fromEnd: end(e.fromEnd),
      toEnd: end(e.toEnd),
      color: str(e.color),
      label: str(e.label),
      raw: e,
    });
  }

  // Preserve any top-level keys besides nodes/edges (Obsidian metadata, etc.).
  const topRaw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    if (k !== "nodes" && k !== "edges") topRaw[k] = v;
  }
  return { nodes, edges, passNodes, passEdges, topRaw };
}

/** Bounding box over all nodes (for fit-to-view). Null when empty. */
export function canvasBounds(
  nodes: CanvasNode[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  return { minX, minY, maxX, maxY };
}

/** JSON Canvas preset colors (1-6); a hex string passes through. */
export function canvasColor(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  if (color.startsWith("#")) return color;
  // Only "1".."6" are valid presets. Guard with an explicit pattern test so
  // inherited Object.prototype keys ("__proto__", "constructor", "toString")
  // can't slip a non-string through the index lookup.
  if (!/^[1-6]$/.test(color)) return fallback;
  const presets: Record<string, string> = {
    "1": "#fb464c", // red
    "2": "#e9973f", // orange
    "3": "#e0de71", // yellow
    "4": "#44cf6e", // green
    "5": "#53dfdd", // cyan
    "6": "#a882ff", // purple
  };
  return presets[color];
}
