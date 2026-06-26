import { useEffect, useMemo, useRef } from "react";
import {
  parseCanvas,
  canvasBounds,
  canvasColor,
  type CanvasData,
  type CanvasNode,
  type CanvasEdge,
  type Side,
} from "../lib/canvas";
import { renderMarkdown } from "../lib/render";

interface Props {
  /** The .canvas file's JSON content. */
  doc: string;
  /** Open a referenced vault file (file node click). */
  onOpenFile: (file: string, subpath?: string) => void;
  onOpenUrl: (url: string) => void;
  /** Resolve a vault image path to a URL (for image file nodes). */
  resolveImage: (target: string) => Promise<string | null>;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;

/** Outward anchor point on a node's side (canvas coords). */
function anchor(n: CanvasNode, s: Side): { x: number; y: number } {
  switch (s) {
    case "top":
      return { x: n.x + n.width / 2, y: n.y };
    case "bottom":
      return { x: n.x + n.width / 2, y: n.y + n.height };
    case "left":
      return { x: n.x, y: n.y + n.height / 2 };
    case "right":
      return { x: n.x + n.width, y: n.y + n.height / 2 };
  }
}

/** Pick the side facing the other node when an edge omits its side. */
function autoSide(a: CanvasNode, b: CanvasNode): Side {
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.abs(bx - ax) > Math.abs(by - ay) ? (bx > ax ? "right" : "left") : by > ay ? "bottom" : "top";
}

/** A cubic bezier between two side anchors, bowing out along each side. */
function edgePath(p: { x: number; y: number }, ps: Side, q: { x: number; y: number }, qs: Side): string {
  const d = Math.max(40, Math.hypot(q.x - p.x, q.y - p.y) * 0.4);
  const off = (s: Side) =>
    s === "top" ? [0, -d] : s === "bottom" ? [0, d] : s === "left" ? [-d, 0] : [d, 0];
  const [pdx, pdy] = off(ps);
  const [qdx, qdy] = off(qs);
  return `M ${p.x} ${p.y} C ${p.x + pdx} ${p.y + pdy}, ${q.x + qdx} ${q.y + qdy}, ${q.x} ${q.y}`;
}

/** Read-only JSON Canvas viewer: HTML node cards in a pan/zoom world, SVG edges. */
export function CanvasView({ doc, onOpenFile, onOpenUrl, resolveImage }: Props) {
  const data: CanvasData = useMemo(() => parseCanvas(doc) ?? { nodes: [], edges: [] }, [doc]);
  const viewport = useRef<HTMLDivElement | null>(null);
  const world = useRef<HTMLDivElement | null>(null);
  const t = useRef({ x: 0, y: 0, k: 1 });

  const apply = () => {
    if (world.current) {
      world.current.style.transform = `translate(${t.current.x}px, ${t.current.y}px) scale(${t.current.k})`;
    }
  };

  // Fit the whole canvas into the viewport on first render.
  useEffect(() => {
    const vp = viewport.current;
    const b = canvasBounds(data.nodes);
    if (!vp || !b) {
      apply();
      return;
    }
    const pad = 60;
    const w = b.maxX - b.minX || 1;
    const h = b.maxY - b.minY || 1;
    const k = Math.min(1.5, Math.max(0.1, Math.min((vp.clientWidth - pad) / w, (vp.clientHeight - pad) / h)));
    t.current = {
      k,
      x: (vp.clientWidth - w * k) / 2 - b.minX * k,
      y: (vp.clientHeight - h * k) / 2 - b.minY * k,
    };
    apply();
  }, [data]);

  // Pan (drag empty space) + zoom (wheel toward the cursor).
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    let panning = false;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest(".canvas-node")) return; // let node clicks through
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      vp.setPointerCapture(e.pointerId);
      vp.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      if (!panning) return;
      t.current.x += e.clientX - lastX;
      t.current.y += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      apply();
    };
    const onUp = (e: PointerEvent) => {
      panning = false;
      vp.releasePointerCapture?.(e.pointerId);
      vp.style.cursor = "grab";
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const k = Math.max(0.05, Math.min(4, t.current.k * Math.exp(-e.deltaY * 0.0015)));
      t.current.x = px - (px - t.current.x) * (k / t.current.k);
      t.current.y = py - (py - t.current.y) * (k / t.current.k);
      t.current.k = k;
      apply();
    };
    vp.addEventListener("pointerdown", onDown);
    vp.addEventListener("pointermove", onMove);
    vp.addEventListener("pointerup", onUp);
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      vp.removeEventListener("pointerdown", onDown);
      vp.removeEventListener("pointermove", onMove);
      vp.removeEventListener("pointerup", onUp);
      vp.removeEventListener("wheel", onWheel);
    };
  }, []);

  const byId = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data]);
  const b = canvasBounds(data.nodes);

  if (data.nodes.length === 0) {
    return <div className="canvas-view canvas-empty">Empty canvas</div>;
  }

  return (
    <div className="canvas-view" ref={viewport}>
      <div className="canvas-world" ref={world}>
        {b && (
          <svg
            className="canvas-edges"
            style={{ left: b.minX, top: b.minY }}
            width={b.maxX - b.minX}
            height={b.maxY - b.minY}
            viewBox={`${b.minX} ${b.minY} ${b.maxX - b.minX} ${b.maxY - b.minY}`}
          >
            <defs>
              <marker id="cv-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--text-muted)" />
              </marker>
            </defs>
            {data.edges.map((e: CanvasEdge) => {
              const from = byId.get(e.fromNode);
              const to = byId.get(e.toNode);
              if (!from || !to) return null;
              const fs = e.fromSide ?? autoSide(from, to);
              const ts = e.toSide ?? autoSide(to, from);
              const p = anchor(from, fs);
              const q = anchor(to, ts);
              const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
              return (
                <g key={e.id}>
                  <path
                    d={edgePath(p, fs, q, ts)}
                    fill="none"
                    stroke={canvasColor(e.color, "var(--text-muted)")}
                    strokeWidth={2}
                    markerEnd={(e.toEnd ?? "arrow") === "arrow" ? "url(#cv-arrow)" : undefined}
                    markerStart={e.fromEnd === "arrow" ? "url(#cv-arrow)" : undefined}
                  />
                  {e.label && (
                    <text className="canvas-edge-label" x={mid.x} y={mid.y} textAnchor="middle">
                      {e.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {data.nodes.map((n) => (
          <CanvasNodeView
            key={n.id}
            node={n}
            onOpenFile={onOpenFile}
            onOpenUrl={onOpenUrl}
            resolveImage={resolveImage}
          />
        ))}
      </div>
    </div>
  );
}

function CanvasNodeView({
  node,
  onOpenFile,
  onOpenUrl,
  resolveImage,
}: {
  node: CanvasNode;
  onOpenFile: (file: string, subpath?: string) => void;
  onOpenUrl: (url: string) => void;
  resolveImage: (target: string) => Promise<string | null>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const accent = canvasColor(node.color, node.type === "group" ? "var(--border)" : "var(--accent)");
  const style: React.CSSProperties = {
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    borderColor: accent,
  };

  // Render text-node markdown / image-file thumbnails into the card.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (node.type === "text") {
      el.innerHTML = renderMarkdown(node.text); // escaped + fixed tags = safe
    } else if (node.type === "file" && IMAGE_EXT.test(node.file)) {
      let cancelled = false;
      void resolveImage(node.file).then((url) => {
        if (cancelled || !url) return;
        el.innerHTML = "";
        const img = document.createElement("img");
        img.src = url;
        img.className = "canvas-img";
        el.append(img);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [node, resolveImage]);

  if (node.type === "group") {
    return (
      <div className="canvas-node canvas-group" style={style}>
        {node.label && <div className="canvas-group-label">{node.label}</div>}
      </div>
    );
  }
  if (node.type === "file") {
    if (IMAGE_EXT.test(node.file)) {
      return <div className="canvas-node canvas-file-image" style={style} ref={ref} />;
    }
    const name = node.file.split("/").pop() ?? node.file;
    return (
      <div
        className="canvas-node canvas-file"
        style={style}
        onClick={() => onOpenFile(node.file, node.subpath)}
        title={node.file}
      >
        <span className="canvas-file-icon">📄</span>
        <span className="canvas-file-name">{name}</span>
      </div>
    );
  }
  if (node.type === "link") {
    return (
      <div className="canvas-node canvas-link" style={style} onClick={() => onOpenUrl(node.url)} title={node.url}>
        <span className="canvas-link-icon">🔗</span>
        <span className="canvas-link-url">{node.url}</span>
      </div>
    );
  }
  // text
  return <div className="canvas-node canvas-text reading-view" style={style} ref={ref} />;
}
