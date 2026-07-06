import { useState } from "react";
import type { Snapshot } from "../lib/snapshots";

interface Props {
  noteName: string;
  /** Snapshots, newest first. */
  snapshots: Snapshot[];
  onRestore: (content: string) => void;
  onClose: () => void;
}

function when(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `Today ${time}` : `${d.toLocaleDateString()} ${time}`;
}

/** Browse a note's local snapshot history and restore a past version. */
export function VersionHistory({ noteName, snapshots, onRestore, onClose }: Props) {
  const [sel, setSel] = useState(0);
  const current = snapshots[sel];

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="settings version-history" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Version history — {noteName}</h2>
          <button className="graph-close" onClick={onClose} aria-label="Close version history">
            ✕
          </button>
        </div>
        {snapshots.length === 0 ? (
          <div className="vh-empty">
            No snapshots yet. Basalt saves a version periodically as you edit — check back later.
          </div>
        ) : (
          <div className="vh-body">
            <ul className="vh-list">
              {snapshots.map((s, i) => (
                <li key={s.ts}>
                  <button
                    className={i === sel ? "vh-item active" : "vh-item"}
                    onClick={() => setSel(i)}
                  >
                    <span className="vh-when">{when(s.ts)}</span>
                    {i === 0 && <span className="vh-latest">latest</span>}
                  </button>
                </li>
              ))}
            </ul>
            <div className="vh-preview">
              <pre className="vh-content">{current?.content ?? ""}</pre>
              {current && (
                <div className="vh-actions">
                  <button className="vh-restore" onClick={() => onRestore(current.content)}>
                    Restore this version
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
