import { useMemo, useState } from "react";
import type { TagCount } from "../lib/vaultIndex";

interface Props {
  tags: TagCount[];
  /** Search the vault for this tag (the bare name, without '#'). */
  onSelect: (tag: string) => void;
}

interface TagNode {
  name: string; // this level's segment
  full: string; // full `a/b/c` path
  count: number; // notes tagged EXACTLY this
  total: number; // rolled-up (self + descendants)
  children: TagNode[];
}

/** Build a nested tree from flat `a/b/c` tag paths, with rolled-up counts. */
export function buildTagTree(tags: TagCount[]): TagNode[] {
  const roots: TagNode[] = [];
  const byFull = new Map<string, TagNode>();
  const ensure = (full: string): TagNode => {
    const existing = byFull.get(full);
    if (existing) return existing;
    const slash = full.lastIndexOf("/");
    const node: TagNode = { name: full.slice(slash + 1), full, count: 0, total: 0, children: [] };
    byFull.set(full, node);
    if (slash < 0) roots.push(node);
    else ensure(full.slice(0, slash)).children.push(node);
    return node;
  };
  for (const t of tags) ensure(t.tag).count += t.count;
  // Roll up totals bottom-up.
  const rollup = (n: TagNode): number => {
    n.total = n.count + n.children.reduce((s, c) => s + rollup(c), 0);
    return n.total;
  };
  roots.forEach(rollup);
  const sortRec = (list: TagNode[]) => {
    list.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    list.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

function Row({
  node,
  depth,
  collapsed,
  toggle,
  onSelect,
}: {
  node: TagNode;
  depth: number;
  collapsed: Set<string>;
  toggle: (full: string) => void;
  onSelect: (tag: string) => void;
}) {
  const hasKids = node.children.length > 0;
  const isCollapsed = collapsed.has(node.full);
  return (
    <>
      <div className="tag-row" style={{ paddingLeft: 6 + depth * 14 }}>
        {hasKids ? (
          <button
            className={`tag-chevron${isCollapsed ? "" : " open"}`}
            onClick={() => toggle(node.full)}
            aria-label={isCollapsed ? "Expand" : "Collapse"}
          >
            ▸
          </button>
        ) : (
          <span className="tag-chevron-spacer" />
        )}
        <button className="tag-name-btn" onClick={() => onSelect(node.full)} title={`Search for #${node.full}`}>
          <span className="tag-name">#{node.name}</span>
          <span className="count">{node.total}</span>
        </button>
      </div>
      {hasKids && !isCollapsed && node.children.map((c) => (
        <Row key={c.full} node={c} depth={depth + 1} collapsed={collapsed} toggle={toggle} onSelect={onSelect} />
      ))}
    </>
  );
}

export function Tags({ tags, onSelect }: Props) {
  const tree = useMemo(() => buildTagTree(tags), [tags]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (full: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(full)) next.delete(full);
      else next.add(full);
      return next;
    });
  if (tags.length === 0) return <div className="empty">No tags</div>;
  return (
    <div className="tag-list">
      {tree.map((n) => (
        <Row key={n.full} node={n} depth={0} collapsed={collapsed} toggle={toggle} onSelect={onSelect} />
      ))}
    </div>
  );
}
