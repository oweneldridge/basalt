import { useEffect, useRef } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
} from "d3-force";
import type { SimulationNodeDatum } from "d3-force";
import type { GraphData } from "../lib/vaultIndex";

interface GNode extends SimulationNodeDatum {
  id: string;
  name: string;
}
interface GLink {
  source: GNode | string;
  target: GNode | string;
}

type Mode = "global" | "local";

interface Props {
  data: GraphData;
  activePath: string | null;
  mode: Mode;
  onSetMode: (m: Mode) => void;
  onOpenNode: (path: string) => void;
  onClose: () => void;
}

export function GraphView({ data, activePath, mode, onSetMode, onOpenNode, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const redrawRef = useRef<() => void>(() => {});

  // Rebuild the simulation when the data (or mode) changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !wrap || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let W = wrap.clientWidth;
    let H = wrap.clientHeight;
    const resize = () => {
      W = wrap.clientWidth;
      H = wrap.clientHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      redrawRef.current();
    };
    resize();

    const nodes: GNode[] = data.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      x: (Math.random() - 0.5) * 300,
      y: (Math.random() - 0.5) * 300,
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: GLink[] = data.links
      .filter((l) => byId.has(l.source) && byId.has(l.target))
      .map((l) => ({ source: l.source, target: l.target }));

    const transform = { x: W / 2, y: H / 2, k: nodes.length > 400 ? 0.4 : 0.9 };

    const sim = forceSimulation<GNode>(nodes)
      .force("charge", forceManyBody<GNode>().strength(-70))
      .force(
        "link",
        forceLink<GNode, GLink>(links)
          .id((d) => d.id)
          .distance(46)
          .strength(0.35),
      )
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide<GNode>(9))
      .alpha(1)
      .alphaDecay(0.03);

    let hover: GNode | null = null;

    const draw = () => {
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, W, H);
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.k, transform.k);

      const active = activePathRef.current;
      const neighbors = new Set<string>();
      if (hover) {
        for (const l of links) {
          const s = l.source as GNode;
          const t = l.target as GNode;
          if (s === hover) neighbors.add(t.id);
          if (t === hover) neighbors.add(s.id);
        }
      }
      const special = (n: GNode) => n.id === active || n === hover || neighbors.has(n.id);

      // Edges: one batched stroke for normal edges, one for highlighted.
      ctx.lineWidth = 1 / transform.k;
      ctx.strokeStyle = "rgba(150,150,160,0.16)";
      ctx.beginPath();
      for (const l of links) {
        const s = l.source as GNode;
        const t = l.target as GNode;
        if (hover && (s === hover || t === hover)) continue;
        ctx.moveTo(s.x ?? 0, s.y ?? 0);
        ctx.lineTo(t.x ?? 0, t.y ?? 0);
      }
      ctx.stroke();
      if (hover) {
        ctx.strokeStyle = "rgba(169,139,224,0.6)";
        ctx.beginPath();
        for (const l of links) {
          const s = l.source as GNode;
          const t = l.target as GNode;
          if (s === hover || t === hover) {
            ctx.moveTo(s.x ?? 0, s.y ?? 0);
            ctx.lineTo(t.x ?? 0, t.y ?? 0);
          }
        }
        ctx.stroke();
      }

      // Normal nodes: one batched fill.
      ctx.fillStyle = "#7d7f88";
      ctx.beginPath();
      for (const n of nodes) {
        if (special(n)) continue;
        const x = n.x ?? 0;
        const y = n.y ?? 0;
        ctx.moveTo(x + 5, y);
        ctx.arc(x, y, 5, 0, Math.PI * 2);
      }
      ctx.fill();

      // Special nodes individually (active / hover / neighbors).
      for (const n of nodes) {
        if (!special(n)) continue;
        const x = n.x ?? 0;
        const y = n.y ?? 0;
        const r = n.id === active ? 8 : n === hover ? 7 : 6;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.id === active ? "#a98be0" : n === hover ? "#cbb6f0" : "#9a86c4";
        ctx.fill();
      }

      // Labels: special nodes always; everything in view when zoomed in.
      const showAll = transform.k > 1.3;
      const vx0 = -transform.x / transform.k;
      const vy0 = -transform.y / transform.k;
      const vx1 = (W - transform.x) / transform.k;
      const vy1 = (H - transform.y) / transform.k;
      ctx.fillStyle = "rgba(220,221,222,0.92)";
      ctx.font = `${11 / transform.k}px -apple-system, BlinkMacSystemFont, sans-serif`;
      for (const n of nodes) {
        if (!special(n) && !showAll) continue;
        const x = n.x ?? 0;
        const y = n.y ?? 0;
        if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue; // off-screen
        ctx.fillText(n.name, x + 8 / transform.k, y + 3.5 / transform.k);
      }
      ctx.restore();
    };
    redrawRef.current = draw;
    sim.on("tick", draw);

    // ---------- interaction ----------
    const toGraph = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left - transform.x) / transform.k,
        y: (clientY - rect.top - transform.y) / transform.k,
      };
    };
    const nodeAt = (clientX: number, clientY: number): GNode | null => {
      const { x, y } = toGraph(clientX, clientY);
      const rr = (12 / transform.k) ** 2;
      let best: GNode | null = null;
      let bestD = rr;
      for (const n of nodes) {
        const dx = (n.x ?? 0) - x;
        const dy = (n.y ?? 0) - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      return best;
    };

    let dragNode: GNode | null = null;
    let panning = false;
    let moved = false;
    let downX = 0;
    let downY = 0;
    let lastX = 0;
    let lastY = 0;

    const onDown = (e: MouseEvent) => {
      downX = e.clientX;
      downY = e.clientY;
      lastX = e.clientX;
      lastY = e.clientY;
      moved = false;
      const n = nodeAt(e.clientX, e.clientY);
      if (n) {
        dragNode = n;
        n.fx = n.x;
        n.fy = n.y;
        sim.alphaTarget(0.2).restart();
      } else {
        panning = true;
      }
    };
    const onMove = (e: MouseEvent) => {
      if (Math.abs(e.clientX - downX) > 3 || Math.abs(e.clientY - downY) > 3) moved = true;
      if (dragNode) {
        const { x, y } = toGraph(e.clientX, e.clientY);
        dragNode.fx = x;
        dragNode.fy = y;
      } else if (panning) {
        transform.x += e.clientX - lastX;
        transform.y += e.clientY - lastY;
        draw();
      } else {
        const n = nodeAt(e.clientX, e.clientY);
        if (n !== hover) {
          hover = n;
          canvas.style.cursor = n ? "pointer" : "grab";
          draw();
        }
      }
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onUp = () => {
      if (dragNode) {
        const n = dragNode;
        dragNode = null;
        n.fx = null;
        n.fy = null;
        sim.alphaTarget(0);
        if (!moved) onOpenNode(n.id);
      }
      panning = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const k = Math.max(0.08, Math.min(8, transform.k * Math.exp(-e.deltaY * 0.0015)));
      transform.x = px - (px - transform.x) * (k / transform.k);
      transform.y = py - (py - transform.y) * (k / transform.k);
      transform.k = k;
      draw();
    };

    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", resize);

    return () => {
      sim.stop();
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", resize);
    };
  }, [data, onOpenNode]);

  // Redraw (highlight) when the active note changes, without resetting layout.
  useEffect(() => {
    redrawRef.current();
  }, [activePath]);

  return (
    <div className="graph-overlay">
      <div className="graph-header">
        <div className="graph-modes">
          <button
            className={`graph-mode${mode === "global" ? " active" : ""}`}
            onClick={() => onSetMode("global")}
          >
            Global
          </button>
          <button
            className={`graph-mode${mode === "local" ? " active" : ""}`}
            onClick={() => onSetMode("local")}
          >
            Local
          </button>
        </div>
        <span className="graph-count">
          {data.nodes.length} notes · {data.links.length} links
        </span>
        <button className="graph-close" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </div>
      <div className="graph-canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
