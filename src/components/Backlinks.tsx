import type { Backlink } from "../lib/vaultIndex";

interface Props {
  noteName: string | null;
  backlinks: Backlink[];
  unlinked: Backlink[];
  onOpen: (path: string) => void;
}

function RefList({ items, onOpen, empty }: { items: Backlink[]; onOpen: (p: string) => void; empty: string }) {
  if (items.length === 0) return <div className="empty">{empty}</div>;
  return (
    <>
      {items.map((b, i) => (
        <button
          key={`${b.path}:${b.line}:${i}`}
          className="ref"
          onClick={() => onOpen(b.path)}
          title={`${b.name} · line ${b.line}`}
        >
          <span className="ref-name">{b.name}</span>
          <span className="ref-snippet">{b.snippet || "(empty line)"}</span>
        </button>
      ))}
    </>
  );
}

export function Backlinks({ noteName, backlinks, unlinked, onOpen }: Props) {
  if (!noteName) {
    return (
      <aside className="backlinks">
        <div className="empty">No note selected</div>
      </aside>
    );
  }
  return (
    <aside className="backlinks">
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
    </aside>
  );
}
