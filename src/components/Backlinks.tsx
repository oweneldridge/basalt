import { useState } from "react";
import type { Backlink } from "../lib/vaultIndex";

interface Props {
  noteName: string | null;
  backlinks: Backlink[];
  unlinked: Backlink[];
  onOpen: (path: string, line: number) => void;
}

/** Backlinks grouped by source file, each under a collapsible header with its
 * mention count (Obsidian's layout). */
function RefList({
  items,
  onOpen,
  empty,
}: {
  items: Backlink[];
  onOpen: (p: string, line: number) => void;
  empty: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  if (items.length === 0) return <div className="empty">{empty}</div>;
  // Group by source path, preserving first-seen order.
  const groups: { path: string; name: string; refs: Backlink[] }[] = [];
  const byPath = new Map<string, { path: string; name: string; refs: Backlink[] }>();
  for (const b of items) {
    let g = byPath.get(b.path);
    if (!g) {
      g = { path: b.path, name: b.name, refs: [] };
      byPath.set(b.path, g);
      groups.push(g);
    }
    g.refs.push(b);
  }
  const toggle = (p: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  return (
    <>
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.path);
        return (
          <div key={g.path} className="ref-group">
            <button className="ref-group-head" onClick={() => toggle(g.path)} title={g.path}>
              <span className={`ref-chevron${isCollapsed ? "" : " open"}`}>▸</span>
              <span className="ref-name">{g.name}</span>
              <span className="count">{g.refs.length}</span>
            </button>
            {!isCollapsed &&
              g.refs.map((b, i) => (
                <button
                  key={`${b.line}:${i}`}
                  className="ref ref-child"
                  onClick={() => onOpen(b.path, b.line)}
                  title={`line ${b.line}`}
                >
                  <span className="ref-snippet">{b.snippet || "(empty line)"}</span>
                </button>
              ))}
          </div>
        );
      })}
    </>
  );
}

/** Backlinks + unlinked mentions for the active note. Rendered inside the
 * tabbed RightPanel, so it returns content (no outer <aside>). */
export function Backlinks({ noteName, backlinks, unlinked, onOpen }: Props) {
  if (!noteName) return <div className="empty">No note selected</div>;
  return (
    <>
      <div className="panel-section">
        <div className="panel-title">
          Backlinks <span className="count">{backlinks.length}</span>
        </div>
        <RefList items={backlinks} onOpen={onOpen} empty="No backlinks" />
      </div>
      <div className="panel-section">
        <div className="panel-title">
          Unlinked mentions <span className="count">{unlinked.length}</span>
        </div>
        <RefList items={unlinked} onOpen={onOpen} empty="None" />
      </div>
    </>
  );
}
