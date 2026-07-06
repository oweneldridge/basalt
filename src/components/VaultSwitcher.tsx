import { useEffect, useRef, useState } from "react";

export interface RecentVaultItem {
  path: string;
  name: string;
  ts: number;
}

interface Props {
  recents: RecentVaultItem[];
  currentVault: string | null;
  /** Open a vault in THIS window. */
  onOpen: (path: string) => void;
  /** Open a vault (or the picker, when path is omitted) in a NEW window. */
  onOpenNewWindow: (path?: string) => void;
  /** Pick a folder and open it in this window. */
  onPickFolder: () => void;
  onClose: () => void;
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** Recent-vaults switcher: open in place, open in a new window, or pick a
 * folder. Keyboard: ↑/↓ to move, Enter to open, ⌘/Ctrl-Enter for new window. */
export function VaultSwitcher({
  recents,
  currentVault,
  onOpen,
  onOpenNewWindow,
  onPickFolder,
  onClose,
}: Props) {
  const [sel, setSel] = useState(0);
  const now = useRef(Date.now()).current;
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".vault-item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(recents.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = recents[sel];
      if (!r) return;
      if (e.metaKey || e.ctrlKey) onOpenNewWindow(r.path);
      else onOpen(r.path);
    }
  };

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div
        className="vault-switcher"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        tabIndex={-1}
        ref={(el) => el?.focus()}
      >
        <div className="vault-switcher-title">Switch vault</div>
        <div className="vault-list" ref={listRef}>
          {recents.length === 0 && <div className="vault-empty">No recent vaults yet.</div>}
          {recents.map((r, i) => (
            <div
              key={r.path}
              className={`vault-item${i === sel ? " sel" : ""}${r.path === currentVault ? " current" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => onOpen(r.path)}
            >
              <div className="vault-item-main">
                <span className="vault-item-name">{r.name}</span>
                <span className="vault-item-path" title={r.path}>
                  {r.path}
                </span>
              </div>
              <div className="vault-item-meta">
                {r.path === currentVault ? <span className="vault-badge">open here</span> : ago(r.ts, now)}
                <button
                  className="vault-newwin"
                  title="Open in a new window"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenNewWindow(r.path);
                  }}
                >
                  ⧉
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="vault-actions">
          <button className="link-btn" onClick={onPickFolder}>
            Open folder…
          </button>
          <button className="link-btn" onClick={() => onOpenNewWindow()}>
            New window
          </button>
        </div>
      </div>
    </div>
  );
}
