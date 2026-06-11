import { useEffect, useMemo, useState } from "react";
import type { VaultNote } from "../lib/vault";
import { ancestorFolders, buildTree, type TreeNode } from "../lib/tree";

interface Props {
  notes: VaultNote[];
  activePath: string | null;
  vaultName: string | null;
  onOpen: (path: string) => void;
  onNewNote: () => void;
  /** Open the file context menu (Rename / Delete) for a note. */
  onContextMenu: (path: string, x: number, y: number) => void;
}

const expandKey = (vault: string | null) => `basalt.tree.expanded.${vault ?? ""}`;

function loadExpanded(vault: string | null): Set<string> {
  try {
    const raw = localStorage.getItem(expandKey(vault));
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveExpanded(vault: string | null, set: Set<string>): void {
  try {
    localStorage.setItem(expandKey(vault), JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

export function Sidebar({ notes, activePath, vaultName, onOpen, onNewNote, onContextMenu }: Props) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildTree(notes), [notes]);

  // Load persisted expansion when the vault changes.
  useEffect(() => {
    setExpanded(loadExpanded(vaultName));
  }, [vaultName]);

  // Persist expansion as it changes.
  useEffect(() => {
    if (vaultName) saveExpanded(vaultName, expanded);
  }, [vaultName, expanded]);

  // Auto-expand the folders leading to the active note so it's visible.
  useEffect(() => {
    if (!activePath) return;
    const note = notes.find((n) => n.path === activePath);
    if (!note) return;
    const anc = ancestorFolders(note.rel);
    if (anc.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const a of anc) {
        if (!next.has(a)) {
          next.add(a);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activePath, notes]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return null;
    return notes.filter(
      (n) => n.name.toLowerCase().includes(q) || n.rel.toLowerCase().includes(q),
    );
  }, [notes, filter]);

  // Flatten the visible (expanded) tree to rows.
  const rows = useMemo(() => {
    if (filtered) return [];
    const out: { node: TreeNode; depth: number }[] = [];
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const node of nodes) {
        out.push({ node, depth });
        if (node.type === "folder" && expanded.has(node.path)) walk(node.children, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  }, [tree, expanded, filtered]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="vault-name" title={vaultName ?? ""}>
          {vaultName ?? "No vault"}
        </span>
        <button className="icon-btn" onClick={onNewNote} title="New note">
          +
        </button>
      </div>
      <input
        className="filter"
        placeholder="Search notes…"
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
      />
      <div className="note-list">
        {filtered ? (
          <>
            {filtered.map((n) => (
              <button
                key={n.path}
                className={`note-item${n.path === activePath ? " active" : ""}`}
                onClick={() => onOpen(n.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContextMenu(n.path, e.clientX, e.clientY);
                }}
                title={n.rel}
              >
                {n.name}
              </button>
            ))}
            {filtered.length === 0 && <div className="empty">No notes</div>}
          </>
        ) : (
          rows.map(({ node, depth }) =>
            node.type === "folder" ? (
              <button
                key={`d:${node.path}`}
                className="tree-row folder"
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => toggle(node.path)}
              >
                <span className={`chevron${expanded.has(node.path) ? " open" : ""}`}>▸</span>
                <span className="tree-name">{node.name}</span>
              </button>
            ) : (
              <button
                key={`f:${node.path}`}
                className={`tree-row file${node.path === activePath ? " active" : ""}`}
                style={{ paddingLeft: 22 + depth * 14 }}
                onClick={() => onOpen(node.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContextMenu(node.path, e.clientX, e.clientY);
                }}
                title={node.name}
              >
                <span className="tree-name">{node.name}</span>
              </button>
            ),
          )
        )}
      </div>
    </aside>
  );
}
