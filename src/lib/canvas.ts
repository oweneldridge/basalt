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
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
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
  const seenNodes = new Set<string>();
  for (const raw of Array.isArray(d.nodes) ? d.nodes : []) {
    if (!raw || typeof raw !== "object") continue;
    const n = raw as Record<string, unknown>;
    const id = str(n.id);
    if (!id || seenNodes.has(id)) continue; // ids must be unique (dup → bad React keys)
    seenNodes.add(id);
    const base = {
      id,
      x: num(n.x),
      y: num(n.y),
      // Clamp to a positive minimum: negative w/h would invert canvasBounds and
      // blank the whole edge SVG (negative viewBox dimensions).
      width: Math.max(1, num(n.width, 200)),
      height: Math.max(1, num(n.height, 60)),
      color: str(n.color),
    };
    if (n.type === "text" && typeof n.text === "string") {
      nodes.push({ ...base, type: "text", text: n.text });
    } else if (n.type === "file" && typeof n.file === "string") {
      nodes.push({ ...base, type: "file", file: n.file, subpath: str(n.subpath) });
    } else if (n.type === "link" && typeof n.url === "string") {
      nodes.push({ ...base, type: "link", url: n.url });
    } else if (n.type === "group") {
      nodes.push({ ...base, type: "group", label: str(n.label) });
    }
  }

  const ids = new Set(nodes.map((n) => n.id));
  const edges: CanvasEdge[] = [];
  const seenEdges = new Set<string>();
  for (const raw of Array.isArray(d.edges) ? d.edges : []) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const id = str(e.id);
    const fromNode = str(e.fromNode);
    const toNode = str(e.toNode);
    if (!id || seenEdges.has(id) || !fromNode || !toNode || !ids.has(fromNode) || !ids.has(toNode))
      continue;
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
    });
  }
  return { nodes, edges };
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
