import { Fragment, useRef } from "react";
import type { ReactNode } from "react";
import type { LayoutNode } from "../lib/workspace";

interface Props {
  node: LayoutNode;
  /** Render one pane's content (tab bar + editor) by id. */
  renderPane: (paneId: string) => ReactNode;
  /** Commit new sizes for the split at `path` (indices from the root). */
  onSizes: (path: number[], sizes: number[]) => void;
  path?: number[];
}

/** Divider between two children of a split; dragging shifts their two sizes.
 * Reports the drag as a fraction of the split container's size. */
function Resizer({ dir, onDelta }: { dir: "row" | "col"; onDelta: (fraction: number) => void }) {
  const last = useRef(0);
  const span = useRef(1);
  return (
    <div
      className={dir === "row" ? "pane-resizer pane-resizer-v" : "pane-resizer pane-resizer-h"}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const parent = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        last.current = dir === "row" ? e.clientX : e.clientY;
        span.current = Math.max(dir === "row" ? parent.width : parent.height, 1);
      }}
      onPointerMove={(e) => {
        if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
        const pos = dir === "row" ? e.clientX : e.clientY;
        onDelta((pos - last.current) / span.current);
        last.current = pos;
      }}
    />
  );
}

export function PaneTree({ node, renderPane, onSizes, path = [] }: Props) {
  if (node.kind === "leaf") return <>{renderPane(node.id)}</>;

  const shift = (i: number, fraction: number) => {
    // Move `fraction` of the total from child i+1 to child i, clamped so neither
    // collapses below a small minimum.
    const sizes = node.sizes.slice();
    const min = 0.08;
    const delta = Math.max(-(sizes[i] - min), Math.min(sizes[i + 1] - min, fraction));
    sizes[i] += delta;
    sizes[i + 1] -= delta;
    onSizes(path, sizes);
  };

  return (
    <div className={node.dir === "row" ? "pane-split pane-split-row" : "pane-split pane-split-col"}>
      {node.children.map((child, i) => (
        <Fragment key={child.kind === "leaf" ? child.id : `split:${i}`}>
          <div className="pane-cell" style={{ flexGrow: node.sizes[i] }}>
            <PaneTree node={child} renderPane={renderPane} onSizes={onSizes} path={[...path, i]} />
          </div>
          {i < node.children.length - 1 && <Resizer dir={node.dir} onDelta={(f) => shift(i, f)} />}
        </Fragment>
      ))}
    </div>
  );
}
