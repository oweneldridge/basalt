import { useMemo, useState } from "react";
import type { Note } from "../lib/vault";

interface Props {
  notes: Note[];
  activePath: string | null;
  vaultName: string | null;
  onOpen: (note: Note) => void;
  onNewNote: () => void;
}

export function Sidebar({ notes, activePath, vaultName, onOpen, onNewNote }: Props) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter(
      (n) => n.name.toLowerCase().includes(q) || n.rel.toLowerCase().includes(q),
    );
  }, [notes, filter]);

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
        {filtered.map((n) => (
          <button
            key={n.path}
            className={`note-item${n.path === activePath ? " active" : ""}`}
            onClick={() => onOpen(n)}
            title={n.rel}
          >
            {n.name}
          </button>
        ))}
        {filtered.length === 0 && <div className="empty">No notes</div>}
      </div>
    </aside>
  );
}
