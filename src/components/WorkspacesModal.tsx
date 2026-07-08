import { useEffect, useState } from "react";

interface Props {
  names: string[];
  onSave: (name: string) => void;
  onLoad: (name: string) => void;
  onDelete: (name: string) => void;
  onClose: () => void;
}

/** Save / load / delete named workspaces (layouts). Obsidian's Workspaces. */
export function WorkspacesModal({ names, onSave, onLoad, onDelete, onClose }: Props) {
  const [newName, setNewName] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="settings workspaces-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Workspaces</h2>
          <button className="graph-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <section className="settings-section">
          <div className="settings-label">Save current layout</div>
          <form
            className="ws-save-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) {
                onSave(newName.trim());
                setNewName("");
              }
            }}
          >
            <input
              className="palette-input"
              placeholder="Workspace name…"
              value={newName}
              autoFocus
              onChange={(e) => setNewName(e.currentTarget.value)}
            />
            <button className="primary" type="submit" disabled={!newName.trim()}>
              {names.includes(newName.trim()) ? "Overwrite" : "Save"}
            </button>
          </form>
        </section>
        <section className="settings-section">
          <div className="settings-label">Saved workspaces</div>
          {names.length === 0 ? (
            <p className="settings-hint">None yet. Save the current layout above.</p>
          ) : (
            <div className="ws-list">
              {names.map((name) => (
                <div key={name} className="ws-row">
                  <button className="ws-name" onClick={() => onLoad(name)} title="Load this workspace">
                    {name}
                  </button>
                  <button className="ws-delete" onClick={() => onDelete(name)} title="Delete" aria-label={`Delete ${name}`}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
