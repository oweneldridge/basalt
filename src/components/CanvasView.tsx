import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  parseCanvas,
  serializeCanvas,
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
  onOpenFile: (file: string, subpath?: string) => void;
  onOpenUrl: (url: string) => void;
  resolveImage: (target: string) => Promise<string | null>;
  /** When provided, the canvas is EDITABLE and calls this with the new JSON on
   * every committed change (move/resize/create/edit/delete/color/edge). */
  onChange?: (json: string) => void;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;
const COLORS: (string | undefined)[] = [undefined, "1", "2", "3", "4", "5", "6"];

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
function autoSide(a: CanvasNode, b: CanvasNode): Side {
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.abs(bx - ax) > Math.abs(by - ay) ? (bx > ax ? "right" : "left") : by > ay ? "bottom" : "top";
}
function edgePath(p: { x: number; y: number }, ps: Side, q: { x: number; y: number }, qs: Side): string {
  const d = Math.max(40, Math.hypot(q.x - p.x, q.y - p.y) * 0.4);
  const off = (s: Side) => (s === "top" ? [0, -d] : s === "bottom" ? [0, d] : s === "left" ? [-d, 0] : [d, 0]);
  const [pdx, pdy] = off(ps);
  const [qdx, qdy] = off(qs);
  return `M ${p.x} ${p.y} C ${p.x + pdx} ${p.y + pdy}, ${q.x + qdx} ${q.y + qdy}, ${q.x} ${q.y}`;
}

function newId(): string {
  // 16 random hex chars, like Obsidian's canvas ids. Crypto-random so two nodes
  // created in the same tick can't collide (a duplicate id would be dedupe-
  // dropped on the next parse → silent node loss).
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const SIDES: Side[] = ["top", "right", "bottom", "left"];

/** JSON Canvas viewer/editor. Read-only unless `onChange` is provided. */
export function CanvasView({ doc, onOpenFile, onOpenUrl, resolveImage, onChange }: Props) {
  const editable = !!onChange;
  const parsed = useMemo(() => parseCanvas(doc) ?? { nodes: [], edges: [] }, [doc]);
  const [data, setData] = useState<CanvasData>(parsed);
  const dataRef = useRef(data);
  dataRef.current = data;
  // Track the JSON we last emitted, so our own echo through the pane doc doesn't
  // reset in-progress edits; an EXTERNAL change (different JSON) re-initializes.
  const lastEmitted = useRef<string | null>(null);
  // Fit-to-view runs only on an EXTERNAL doc change (initial load / reload), not
  // on our own edits — otherwise every drag would reset the user's pan/zoom.
  const pendingFit = useRef(true);
  useEffect(() => {
    if (doc !== lastEmitted.current) {
      setData(parseCanvas(doc) ?? { nodes: [], edges: [] });
      pendingFit.current = true;
    }
  }, [doc]);

  // Multi-select: a set of selected node/edge ids (Obsidian canvas parity).
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const isSel = useCallback((id: string) => selected.has(id), [selected]);
  const selectOne = useCallback((id: string) => setSelected(new Set([id])), []);
  const toggleSel = useCallback(
    (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const clearSel = useCallback(() => setSelected((prev) => (prev.size ? new Set() : prev)), []);
  // Right-click context menu (client coords; world coords for "add card here").
  const [menu, setMenu] = useState<{ x: number; y: number; kind: "node" | "empty"; wx: number; wy: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drawingEdge, setDrawingEdge] = useState<{ from: string; side: Side; x: number; y: number } | null>(null);
  // Rubber-band rectangle (world coords) while Shift-dragging empty space.
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const viewport = useRef<HTMLDivElement | null>(null);
  const world = useRef<HTMLDivElement | null>(null);
  const t = useRef({ x: 0, y: 0, k: 1 });

  const apply = () => {
    if (world.current) {
      world.current.style.transform = `translate(${t.current.x}px, ${t.current.y}px) scale(${t.current.k})`;
    }
  };

  // Emit the current data as JSON (commit a change to disk via the parent).
  const emit = useCallback(
    (next: CanvasData) => {
      setData(next);
      if (!onChange) return;
      const json = serializeCanvas(next);
      lastEmitted.current = json;
      onChange(json);
    },
    [onChange],
  );

  const patchNode = useCallback(
    (id: string, patch: Partial<CanvasNode>) => {
      emit({
        ...dataRef.current,
        nodes: dataRef.current.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as CanvasNode) : n)),
      });
    },
    [emit],
  );

  // Fit the whole canvas into the viewport — only when a fit is pending (first
  // load / external reload), so edits preserve the user's pan/zoom.
  useEffect(() => {
    if (!pendingFit.current) return;
    const vp = viewport.current;
    const b = canvasBounds(data.nodes);
    pendingFit.current = false;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Convert a client point to world (canvas) coordinates.
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = viewport.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - t.current.x) / t.current.k,
      y: (clientY - rect.top - t.current.y) / t.current.k,
    };
  }, []);

  // Pan (drag empty space) + zoom (wheel toward the cursor).
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    let panning = false;
    let banding = false;
    let bandStart = { x: 0, y: 0 };
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement;
      // Ignore drags starting on a node/handle/anchor, the toolbar, or an open
      // context menu — a native listener here would otherwise clear the
      // selection and capture the pointer before the control's click runs.
      if (
        el.closest(".canvas-node") ||
        el.closest(".canvas-handle") ||
        el.closest(".canvas-anchor") ||
        el.closest(".canvas-toolbar") ||
        el.closest(".ctx-overlay")
      )
        return;
      // Shift+drag on empty space = rubber-band select; plain drag = pan.
      if (editable && e.shiftKey) {
        banding = true;
        bandStart = toWorld(e.clientX, e.clientY);
        setBand({ x0: bandStart.x, y0: bandStart.y, x1: bandStart.x, y1: bandStart.y });
        vp.setPointerCapture(e.pointerId);
        return;
      }
      clearSel();
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      vp.setPointerCapture(e.pointerId);
      vp.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      if (banding) {
        const p = toWorld(e.clientX, e.clientY);
        setBand({ x0: bandStart.x, y0: bandStart.y, x1: p.x, y1: p.y });
        return;
      }
      if (!panning) return;
      t.current.x += e.clientX - lastX;
      t.current.y += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      apply();
    };
    const onUp = (e: PointerEvent) => {
      if (banding) {
        banding = false;
        const p = toWorld(e.clientX, e.clientY);
        const x0 = Math.min(bandStart.x, p.x);
        const y0 = Math.min(bandStart.y, p.y);
        const x1 = Math.max(bandStart.x, p.x);
        const y1 = Math.max(bandStart.y, p.y);
        const hit = dataRef.current.nodes
          .filter((n) => n.x < x1 && n.x + n.width > x0 && n.y < y1 && n.y + n.height > y0)
          .map((n) => n.id);
        setSelected(new Set(hit));
        setBand(null);
        vp.releasePointerCapture?.(e.pointerId);
        return;
      }
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

  // Delete every selected node (+ its edges) and any selected edges.
  const deleteSelection = useCallback(() => {
    const sel = selectedRef.current;
    if (sel.size === 0) return;
    const d = dataRef.current;
    const nodeIds = new Set(d.nodes.filter((n) => sel.has(n.id)).map((n) => n.id));
    emit({
      ...d, // keep passNodes/passEdges/topRaw
      nodes: d.nodes.filter((n) => !sel.has(n.id)),
      edges: d.edges.filter((ed) => !sel.has(ed.id) && !nodeIds.has(ed.fromNode) && !nodeIds.has(ed.toNode)),
    });
    setSelected(new Set());
  }, [emit]);

  // Clone the selected nodes (offset +24,+24, fresh ids) and select the copies.
  const duplicateSelection = useCallback(() => {
    const sel = selectedRef.current;
    const d = dataRef.current;
    const clones = d.nodes.filter((n) => sel.has(n.id)).map((n) => ({ ...n, id: newId(), x: n.x + 24, y: n.y + 24 }));
    if (clones.length === 0) return;
    emit({ ...d, nodes: [...d.nodes, ...clones] });
    setSelected(new Set(clones.map((c) => c.id)));
  }, [emit]);

  const addCardAt = useCallback(
    (wx: number, wy: number) => {
      const node: CanvasNode = { id: newId(), type: "text", text: "", x: Math.round(wx - 100), y: Math.round(wy - 30), width: 200, height: 60 };
      emit({ ...dataRef.current, nodes: [...dataRef.current.nodes, node] });
      selectOne(node.id);
      setEditingId(node.id);
    },
    [emit, selectOne],
  );

  // Delete the selection with Delete/Backspace (when not editing text).
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      if (selectedRef.current.size === 0 || editingId) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement;
      if (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;
      e.preventDefault();
      deleteSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, editingId, deleteSelection]);

  // Drag a node body → move. If the node is part of a multi-selection, the
  // whole selection moves together; otherwise it becomes the sole selection.
  const startNodeDrag = (e: React.PointerEvent, id: string) => {
    if (!editable) return;
    e.stopPropagation();
    // Establish the selection this drag operates on.
    const cur = selectedRef.current;
    let moveIds: string[];
    if (e.shiftKey) {
      toggleSel(id);
      moveIds = cur.has(id) ? [...cur].filter((s) => s !== id) : [...cur, id];
    } else if (cur.has(id) && cur.size > 1) {
      moveIds = [...cur]; // drag the existing group
    } else {
      selectOne(id);
      moveIds = [id];
    }
    const moveNodeIds = new Set(dataRef.current.nodes.filter((n) => moveIds.includes(n.id)).map((n) => n.id));
    const node = dataRef.current.nodes.find((n) => n.id === id);
    if (!node) return;
    const start = toWorld(e.clientX, e.clientY);
    // Original positions of every node moving in this drag.
    const orig = new Map(dataRef.current.nodes.filter((n) => moveNodeIds.has(n.id)).map((n) => [n.id, { x: n.x, y: n.y }]));
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    let raf = 0;
    let delta: { dx: number; dy: number } | null = null;
    const move = (ev: PointerEvent) => {
      const p = toWorld(ev.clientX, ev.clientY);
      delta = { dx: p.x - start.x, dy: p.y - start.y };
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (delta)
            setData((d) => ({
              ...d,
              nodes: d.nodes.map((n) => {
                const o = orig.get(n.id);
                return o && delta ? { ...n, x: o.x + delta.dx, y: o.y + delta.dy } : n;
              }),
            }));
        });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (raf) cancelAnimationFrame(raf);
      if (delta) {
        // Commit all moved nodes in one emit (single undo step).
        const d = dataRef.current;
        emit({
          ...d,
          nodes: d.nodes.map((n) => {
            const o = orig.get(n.id);
            return o && delta ? { ...n, x: Math.round(o.x + delta.dx), y: Math.round(o.y + delta.dy) } : n;
          }),
        });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startResize = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const node = dataRef.current.nodes.find((n) => n.id === id);
    if (!node) return;
    const start = toWorld(e.clientX, e.clientY);
    const orig = { w: node.width, h: node.height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    let raf = 0;
    let pending: { width: number; height: number } | null = null;
    const move = (ev: PointerEvent) => {
      const p = toWorld(ev.clientX, ev.clientY);
      pending = {
        width: Math.max(60, orig.w + (p.x - start.x)),
        height: Math.max(40, orig.h + (p.y - start.y)),
      };
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (pending)
            setData((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...pending } : n)) }));
        });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (raf) cancelAnimationFrame(raf);
      if (pending) patchNode(id, pending);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Drag from a side anchor → draw an edge to another node.
  const startEdge = (e: React.PointerEvent, id: string, side: Side) => {
    e.stopPropagation();
    const from = dataRef.current.nodes.find((n) => n.id === id);
    if (!from) return;
    const a = anchor(from, side);
    setDrawingEdge({ from: id, side, x: a.x, y: a.y });
    const move = (ev: PointerEvent) => {
      const p = toWorld(ev.clientX, ev.clientY);
      setDrawingEdge((cur) => (cur ? { ...cur, x: p.x, y: p.y } : cur));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const p = toWorld(ev.clientX, ev.clientY);
      const target = dataRef.current.nodes.find(
        (n) => n.id !== id && p.x >= n.x && p.x <= n.x + n.width && p.y >= n.y && p.y <= n.y + n.height,
      );
      setDrawingEdge(null);
      if (target) {
        const edge: CanvasEdge = {
          id: newId(),
          fromNode: id,
          fromSide: side,
          toNode: target.id,
          toSide: autoSide(target, from),
          toEnd: "arrow",
        };
        emit({ ...dataRef.current, edges: [...dataRef.current.edges, edge] });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Double-click empty space → create a text node there and edit it.
  const onDoubleClick = (e: React.MouseEvent) => {
    if (!editable) return;
    const el = e.target as HTMLElement;
    if (el.closest(".canvas-node")) return;
    const p = toWorld(e.clientX, e.clientY);
    const node: CanvasNode = {
      id: newId(),
      type: "text",
      text: "",
      x: Math.round(p.x - 100),
      y: Math.round(p.y - 30),
      width: 200,
      height: 60,
    };
    emit({ ...dataRef.current, nodes: [...dataRef.current.nodes, node] });
    selectOne(node.id);
    setEditingId(node.id);
  };

  const byId = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data]);
  const b = canvasBounds(data.nodes);

  if (data.nodes.length === 0 && !editable) {
    return <div className="canvas-view canvas-empty">Empty canvas</div>;
  }

  const selectedNodes = data.nodes.filter((n) => selected.has(n.id));
  const colorRef = selectedNodes[0];

  const onEmptyContextMenu = (e: React.MouseEvent) => {
    if (!editable) return;
    if ((e.target as HTMLElement).closest(".canvas-node")) return; // node handler owns it
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    setMenu({ x: e.clientX, y: e.clientY, kind: "empty", wx: w.x, wy: w.y });
  };

  return (
    <div className="canvas-view" ref={viewport} onDoubleClick={onDoubleClick} onContextMenu={onEmptyContextMenu}>
      {editable && (
        <div className="canvas-toolbar">
          <button
            className="link-btn"
            title="Add a card"
            onClick={() => {
              const vp = viewport.current!;
              const p = toWorld(vp.clientWidth / 2, vp.clientHeight / 2);
              const node: CanvasNode = {
                id: newId(),
                type: "text",
                text: "",
                x: Math.round(p.x - 100),
                y: Math.round(p.y - 30),
                width: 200,
                height: 60,
              };
              emit({ ...dataRef.current, nodes: [...dataRef.current.nodes, node] });
              selectOne(node.id);
              setEditingId(node.id);
            }}
          >
            + Card
          </button>
          {colorRef && (
            <div className="canvas-colors">
              {selectedNodes.length > 1 && <span className="canvas-selcount">{selectedNodes.length} selected</span>}
              {COLORS.map((c, i) => (
                <button
                  key={i}
                  className={`canvas-color-dot${colorRef.color === c ? " active" : ""}`}
                  style={{ background: canvasColor(c, "var(--border)") }}
                  title={c ? `Color ${c}` : "No color"}
                  onClick={() => {
                    const ids = new Set(selectedNodes.map((n) => n.id));
                    emit({
                      ...dataRef.current,
                      nodes: dataRef.current.nodes.map((n) => (ids.has(n.id) ? ({ ...n, color: c } as CanvasNode) : n)),
                    });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
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
                <g key={e.id} onClick={(ev) => editable && (ev.shiftKey ? toggleSel(e.id) : selectOne(e.id))} style={{ cursor: editable ? "pointer" : "default" }}>
                  <path
                    d={edgePath(p, fs, q, ts)}
                    fill="none"
                    stroke={isSel(e.id) ? "var(--accent)" : canvasColor(e.color, "var(--text-muted)")}
                    strokeWidth={isSel(e.id) ? 3 : 2}
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
            {drawingEdge &&
              (() => {
                const from = byId.get(drawingEdge.from);
                if (!from) return null;
                const p = anchor(from, drawingEdge.side);
                return (
                  <path
                    d={`M ${p.x} ${p.y} L ${drawingEdge.x} ${drawingEdge.y}`}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                  />
                );
              })()}
            {band && (
              <rect
                className="canvas-band"
                x={Math.min(band.x0, band.x1)}
                y={Math.min(band.y0, band.y1)}
                width={Math.abs(band.x1 - band.x0)}
                height={Math.abs(band.y1 - band.y0)}
              />
            )}
          </svg>
        )}
        {data.nodes.map((n) => (
          <CanvasNodeView
            key={n.id}
            node={n}
            editable={editable}
            selected={isSel(n.id)}
            editing={editingId === n.id}
            onOpenFile={onOpenFile}
            onOpenUrl={onOpenUrl}
            resolveImage={resolveImage}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!selectedRef.current.has(n.id)) selectOne(n.id);
              setMenu({ x: e.clientX, y: e.clientY, kind: "node", wx: 0, wy: 0 });
            }}
            onStartDrag={(e) => startNodeDrag(e, n.id)}
            onStartResize={(e) => startResize(e, n.id)}
            onStartEdge={(e, side) => startEdge(e, n.id, side)}
            onBeginEdit={() => editable && n.type === "text" && setEditingId(n.id)}
            onCommitText={(text) => {
              setEditingId(null);
              if (n.type === "text" && text !== n.text) patchNode(n.id, { text } as Partial<CanvasNode>);
            }}
          />
        ))}
      </div>
      {menu && (
        <div className="ctx-overlay" onMouseDown={() => setMenu(null)} onContextMenu={(e) => e.preventDefault()}>
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
            {menu.kind === "node" ? (
              <>
                <button className="ctx-item" onClick={() => { setMenu(null); duplicateSelection(); }}>
                  Duplicate
                </button>
                <button className="ctx-item danger" onClick={() => { setMenu(null); deleteSelection(); }}>
                  Delete
                </button>
              </>
            ) : (
              <button className="ctx-item" onClick={() => { const { wx, wy } = menu; setMenu(null); addCardAt(wx, wy); }}>
                Add card here
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CanvasNodeView({
  node,
  editable,
  selected,
  editing,
  onOpenFile,
  onOpenUrl,
  resolveImage,
  onContextMenu,
  onStartDrag,
  onStartResize,
  onStartEdge,
  onBeginEdit,
  onCommitText,
}: {
  node: CanvasNode;
  editable: boolean;
  selected: boolean;
  editing: boolean;
  onOpenFile: (file: string, subpath?: string) => void;
  onOpenUrl: (url: string) => void;
  resolveImage: (target: string) => Promise<string | null>;
  onContextMenu: (e: React.MouseEvent) => void;
  onStartDrag: (e: React.PointerEvent) => void;
  onStartResize: (e: React.PointerEvent) => void;
  onStartEdge: (e: React.PointerEvent, side: Side) => void;
  onBeginEdit: () => void;
  onCommitText: (text: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const accent = canvasColor(node.color, node.type === "group" ? "var(--border)" : "var(--accent)");
  const style: React.CSSProperties = {
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    borderColor: selected ? "var(--accent)" : accent,
    boxShadow: selected ? "0 0 0 2px var(--accent-soft)" : undefined,
  };

  // `ref` points at a CONTENT div that is NOT managed by React (no JSX
  // children) — we own its innerHTML. Handles are rendered as SIBLINGS in the
  // wrapper, so React never tries to reconcile children we replaced.
  useEffect(() => {
    const el = ref.current;
    if (!el || editing) return;
    if (node.type === "text") {
      el.innerHTML = renderMarkdown(node.text); // escaped + fixed tags = safe
      if (el.querySelector("[data-math]")) void import("../lib/math").then((m) => m.fillMath(el));
      if (el.querySelector("[data-basalt-html]")) void import("../lib/sanitize").then((m) => m.fillRawHtml(el));
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
  }, [node, resolveImage, editing]);

  const dragProps = editable
    ? { onPointerDown: onStartDrag, onClick: (e: React.MouseEvent) => e.stopPropagation(), onContextMenu }
    : {};
  const handles =
    editable && selected ? (
      <>
        {SIDES.map((s) => (
          <div
            key={s}
            className={`canvas-anchor canvas-anchor-${s}`}
            onPointerDown={(e) => onStartEdge(e, s)}
            title="Drag to connect"
          />
        ))}
        <div className="canvas-handle" onPointerDown={onStartResize} title="Resize" />
      </>
    ) : null;

  if (node.type === "group") {
    return (
      <div className="canvas-node canvas-group" style={style} {...dragProps}>
        {node.label && <div className="canvas-group-label">{node.label}</div>}
        {handles}
      </div>
    );
  }
  if (node.type === "file") {
    if (IMAGE_EXT.test(node.file)) {
      return (
        <div className="canvas-node canvas-file-image" style={style} {...dragProps}>
          <div className="canvas-node-content" ref={ref} />
          {handles}
        </div>
      );
    }
    const name = node.file.split("/").pop() ?? node.file;
    return (
      <div
        className="canvas-node canvas-file"
        style={style}
        {...dragProps}
        onDoubleClick={(e) => (e.stopPropagation(), onOpenFile(node.file, node.subpath))}
        title={node.file}
      >
        <span className="canvas-file-icon">📄</span>
        <span className="canvas-file-name">{name}</span>
        {handles}
      </div>
    );
  }
  if (node.type === "link") {
    return (
      <div
        className="canvas-node canvas-link"
        style={style}
        {...dragProps}
        onDoubleClick={(e) => (e.stopPropagation(), onOpenUrl(node.url))}
        title={node.url}
      >
        <span className="canvas-link-icon">🔗</span>
        <span className="canvas-link-url">{node.url}</span>
        {handles}
      </div>
    );
  }
  // text node
  if (editing) {
    return (
      <div className="canvas-node canvas-text editing" style={style}>
        <textarea
          className="canvas-text-input"
          defaultValue={node.text}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => onCommitText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      </div>
    );
  }
  return (
    <div
      className="canvas-node canvas-text"
      style={style}
      {...dragProps}
      onDoubleClick={(e) => (e.stopPropagation(), onBeginEdit())}
    >
      <div className="canvas-node-content reading-view" ref={ref} />
      {handles}
    </div>
  );
}
