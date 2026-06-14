// Pure split-pane layout tree. A binary-ish tree whose leaves reference panes
// by id; same-direction splits flatten into one node (so three side-by-side
// panes are even thirds, not nested halves). Panes themselves (tabs/active/doc)
// live in App state keyed by id — this module only owns the LAYOUT, so it stays
// pure and testable.

export type Dir = "row" | "col";

export type LayoutNode =
  | { kind: "leaf"; id: string }
  | { kind: "split"; dir: Dir; sizes: number[]; children: LayoutNode[] };

/** All pane ids, left-to-right / top-to-bottom. */
export function leafIds(node: LayoutNode): string[] {
  if (node.kind === "leaf") return [node.id];
  return node.children.flatMap(leafIds);
}

export function firstLeafId(node: LayoutNode): string | null {
  return leafIds(node)[0] ?? null;
}

function evenSizes(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

/**
 * Split the leaf `targetId` along `dir`, inserting a fresh leaf `newId`
 * before/after it. If the target already sits in a split of the same
 * direction, the new leaf is added as a sibling (flattened) rather than nested.
 */
export function splitLeaf(
  node: LayoutNode,
  targetId: string,
  newId: string,
  dir: Dir,
  before = false,
): LayoutNode {
  if (node.kind === "leaf") {
    if (node.id !== targetId) return node;
    const fresh: LayoutNode = { kind: "leaf", id: newId };
    const children = before ? [fresh, node] : [node, fresh];
    return { kind: "split", dir, sizes: [0.5, 0.5], children };
  }
  // Same-direction split holding the target as a direct child → insert sibling.
  if (node.dir === dir) {
    const idx = node.children.findIndex((c) => c.kind === "leaf" && c.id === targetId);
    if (idx !== -1) {
      const insertAt = before ? idx : idx + 1;
      const children = [
        ...node.children.slice(0, insertAt),
        { kind: "leaf", id: newId } as LayoutNode,
        ...node.children.slice(insertAt),
      ];
      return { ...node, children, sizes: evenSizes(children.length) };
    }
  }
  return { ...node, children: node.children.map((c) => splitLeaf(c, targetId, newId, dir, before)) };
}

/**
 * Remove the leaf `targetId`. Splits left with one child collapse into that
 * child; an emptied tree returns null. Remaining siblings share the space
 * evenly.
 */
export function removeLeaf(node: LayoutNode, targetId: string): LayoutNode | null {
  if (node.kind === "leaf") return node.id === targetId ? null : node;
  const children = node.children
    .map((c) => removeLeaf(c, targetId))
    .filter((c): c is LayoutNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children, sizes: evenSizes(children.length) };
}

/** Replace the sizes of the split node at `path` (indices from the root). */
export function setSizes(node: LayoutNode, path: number[], sizes: number[]): LayoutNode {
  if (path.length === 0) {
    if (node.kind !== "split") return node;
    return { ...node, sizes };
  }
  if (node.kind !== "split") return node;
  const [head, ...rest] = path;
  return {
    ...node,
    children: node.children.map((c, i) => (i === head ? setSizes(c, rest, sizes) : c)),
  };
}

/** The id of the leaf after/before `targetId` (for focus-cycling / fallback). */
export function neighborLeaf(node: LayoutNode, targetId: string): string | null {
  const ids = leafIds(node);
  const i = ids.indexOf(targetId);
  if (i === -1) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}
