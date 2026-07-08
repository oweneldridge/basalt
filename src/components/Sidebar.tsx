import { useEffect, useMemo, useState, useRef } from "react";
import type { Attachment, VaultNote } from "../lib/vault";
import { ancestorFolders, buildTree, type TreeNode, type SortOrder } from "../lib/tree";

interface Props {
  notes: VaultNote[];
  attachments: Attachment[];
  activePath: string | null;
  vaultName: string | null;
  onOpen: (path: string) => void;
  onNewNote: () => void;
  /** Open an attachment in the system viewer. */
  onOpenAttachment: (path: string) => void;
  /** Open the file context menu (Rename / Delete) for a note. */
  onContextMenu: (path: string, x: number, y: number) => void;
  /** Right-click an attachment (image / PDF / canvas / base). */
  onAttachmentContextMenu: (path: string, x: number, y: number) => void;
  /** Open the folder context menu (New note here) for a folder rel path. */
  onFolderContextMenu: (folderRel: string, x: number, y: number) => void;
  /** Move a note (by path) into a folder (rel, "" = vault root). */
  onMoveToFolder: (notePath: string, folderRel: string) => void;
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

const DND_MIME = "application/x-basalt-note";

export function Sidebar({ notes, attachments, activePath, vaultName, onOpen, onNewNote, onOpenAttachment, onContextMenu, onAttachmentContextMenu, onFolderContextMenu, onMoveToFolder }: Props) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const noteListRef = useRef<HTMLDivElement | null>(null);
  // Expand the active note's ancestor folders and scroll it into view.
  const revealActive = () => {
    if (!activePath) return;
    const note = notes.find((n) => n.path === activePath);
    if (note) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const f of ancestorFolders(note.rel)) next.add(f);
        return next;
      });
    }
    requestAnimationFrame(() => noteListRef.current?.querySelector(".active")?.scrollIntoView({ block: "center" }));
  };
  const [sort, setSort] = useState<SortOrder>(
    () => (localStorage.getItem("basalt.fileSort") as SortOrder | null) ?? "name-asc",
  );
  useEffect(() => localStorage.setItem("basalt.fileSort", sort), [sort]);

  const tree = useMemo(() => buildTree(notes, attachments, sort), [notes, attachments, sort]);

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
    return {
      notes: notes.filter(
        (n) => n.name.toLowerCase().includes(q) || n.rel.toLowerCase().includes(q),
      ),
      attachments: attachments.filter(
        (a) => a.name.toLowerCase().includes(q) || a.rel.toLowerCase().includes(q),
      ),
    };
  }, [notes, attachments, filter]);

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
      <div
        className="sidebar-head"
        title="Drop a note here to move it to the vault root"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DND_MIME)) {
            e.preventDefault();
            e.currentTarget.classList.add("drop-target");
          }
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove("drop-target")}
        onDrop={(e) => {
          e.currentTarget.classList.remove("drop-target");
          const p = e.dataTransfer.getData(DND_MIME);
          if (p) onMoveToFolder(p, ""); // "" = vault root
        }}
      >
        <span className="vault-name" title={vaultName ?? ""}>
          {vaultName ?? "No vault"}
        </span>
        <button className="icon-btn" onClick={revealActive} title="Reveal active file" disabled={!activePath}>
          ⊙
        </button>
        <button className="icon-btn" onClick={() => setExpanded(new Set())} title="Collapse all">
          ⇈
        </button>
        <button className="icon-btn" onClick={onNewNote} title="New note">
          +
        </button>
      </div>
      <div className="sidebar-controls">
        <input
          className="filter"
          placeholder="Search notes…"
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />
        <select
          className="file-sort"
          value={sort}
          onChange={(e) => setSort(e.currentTarget.value as SortOrder)}
          title="Sort order"
          aria-label="Sort files"
        >
          <option value="name-asc">Name (A–Z)</option>
          <option value="name-desc">Name (Z–A)</option>
          <option value="mtime-desc">Modified (newest)</option>
          <option value="ctime-desc">Created (newest)</option>
        </select>
      </div>
      <div className="note-list" ref={noteListRef}>
        {filtered ? (
          <>
            {filtered.notes.map((n) => (
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
            {filtered.attachments.map((a) => (
              <button
                key={a.path}
                className="note-item attachment tree-row"
                onClick={() => onOpenAttachment(a.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onAttachmentContextMenu(a.path, e.clientX, e.clientY);
                }}
                title={a.rel}
              >
                {a.name}
              </button>
            ))}
            {filtered.notes.length === 0 && filtered.attachments.length === 0 && (
              <div className="empty">No notes</div>
            )}
          </>
        ) : (
          rows.map(({ node, depth }) =>
            node.type === "folder" ? (
              <button
                key={`d:${node.path}`}
                className="tree-row folder"
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => toggle(node.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onFolderContextMenu(node.path, e.clientX, e.clientY);
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(DND_MIME)) {
                    e.preventDefault();
                    e.currentTarget.classList.add("drop-target");
                  }
                }}
                onDragLeave={(e) => e.currentTarget.classList.remove("drop-target")}
                onDrop={(e) => {
                  e.currentTarget.classList.remove("drop-target");
                  const p = e.dataTransfer.getData(DND_MIME);
                  if (p) onMoveToFolder(p, node.path);
                }}
              >
                <span className={`chevron${expanded.has(node.path) ? " open" : ""}`}>▸</span>
                <span className="tree-name">{node.name}</span>
              </button>
            ) : (
              <button
                key={`f:${node.path}`}
                className={`tree-row file${node.attachment ? " attachment" : ""}${node.path === activePath ? " active" : ""}`}
                style={{ paddingLeft: 22 + depth * 14 }}
                draggable={!node.attachment}
                onDragStart={(e) => e.dataTransfer.setData(DND_MIME, node.path)}
                onClick={() => (node.attachment ? onOpenAttachment(node.path) : onOpen(node.path))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (node.attachment) onAttachmentContextMenu(node.path, e.clientX, e.clientY);
                  else onContextMenu(node.path, e.clientX, e.clientY);
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
