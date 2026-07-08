import { useState } from "react";

export interface TabItem {
  path: string;
  name: string;
  pinned?: boolean;
  /** True for a view tab (file tree, outline, plugin view…) vs a note tab. */
  view?: boolean;
}

interface Props {
  /** This pane's id — carried in the drag payload so a drop knows the source. */
  paneId: string;
  tabs: TabItem[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onNew: () => void;
  /** Toggle a tab's pinned state (right-click / the pin glyph). */
  onTogglePin: (path: string) => void;
  /** A tab was dropped: move `path` from `fromPaneId` into this pane at `index`. */
  onTabDrop: (fromPaneId: string, path: string, toIndex: number) => void;
  /** Right-click a tab → open a context menu at (x, y). */
  onContextMenu: (path: string, x: number, y: number) => void;
  /** Fired when a tab drag starts (true) / ends (false) — drives the pane edge
   * drop-zones for drag-to-split. */
  onDragStateChange: (active: boolean) => void;
  /** Whether this pane is "linked" (follows notes opened elsewhere). */
  linked: boolean;
  onToggleLink: () => void;
  /** Whether this pane's tabs are shown as a stacked spread. */
  stacked: boolean;
  onToggleStacked: () => void;
}

// A tab drag carries "<paneId>\n<path>" under this private MIME type.
const TAB_MIME = "application/x-basalt-tab";

export function TabBar({ paneId, tabs, activePath, onSelect, onClose, onNew, onTogglePin, onTabDrop, onContextMenu, onDragStateChange, linked, onToggleLink, stacked, onToggleStacked }: Props) {
  // Index the drop indicator sits before (null = none, tabs.length = at end).
  const [dropAt, setDropAt] = useState<number | null>(null);

  const readDrag = (dt: DataTransfer): { from: string; path: string } | null => {
    const raw = dt.getData(TAB_MIME);
    if (!raw) return null;
    const nl = raw.indexOf("\n");
    return nl < 0 ? null : { from: raw.slice(0, nl), path: raw.slice(nl + 1) };
  };

  return (
    <div
      className="tab-bar"
      role="tablist"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TAB_MIME)) {
          e.preventDefault();
          if (dropAt === null) setDropAt(tabs.length); // over empty space → end
        }
      }}
      onDragLeave={(e) => {
        // Only clear when leaving the bar itself, not moving between children.
        if (e.currentTarget === e.target) setDropAt(null);
      }}
      onDrop={(e) => {
        const d = readDrag(e.dataTransfer);
        const at = dropAt ?? tabs.length;
        setDropAt(null);
        if (d) {
          e.preventDefault();
          onTabDrop(d.from, d.path, at);
        }
      }}
    >
      {tabs.map((t, i) => (
        <div
          key={t.path}
          className={`tab${t.path === activePath ? " active" : ""}${t.pinned ? " pinned" : ""}${t.view ? " view-tab" : ""}${dropAt === i ? " drop-before" : ""}`}
          role="tab"
          aria-selected={t.path === activePath}
          title={t.pinned ? `${t.name} (pinned)` : t.name}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(TAB_MIME, `${paneId}\n${t.path}`);
            // WKWebView (the Tauri webview) drops a drag that carries ONLY a
            // custom MIME type — a text/plain payload keeps it a valid drag.
            e.dataTransfer.setData("text/plain", t.name);
            e.dataTransfer.effectAllowed = "move";
            onDragStateChange(true);
          }}
          onDragEnd={() => onDragStateChange(false)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(TAB_MIME)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            // Drop before this tab or after it, based on which half we're over.
            const r = e.currentTarget.getBoundingClientRect();
            setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1);
          }}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              if (!t.pinned) onClose(t.path); // middle-click closes (unless pinned)
            } else if (e.button === 0) {
              onSelect(t.path);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu(t.path, e.clientX, e.clientY);
          }}
        >
          {t.pinned && (
            <button
              className="tab-pin"
              aria-label={`Unpin ${t.name}`}
              title="Unpin"
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onTogglePin(t.path);
              }}
            >
              📌
            </button>
          )}
          <span className="tab-name">{t.name}</span>
          {!t.pinned && (
            <button
              className="tab-close"
              aria-label={`Close ${t.name}`}
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onClose(t.path);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <span className={`tab-drop-end${dropAt === tabs.length ? " active" : ""}`} aria-hidden />
      <button className="tab-new" title="Open a note (⌘O)" onClick={onNew}>
        +
      </button>
      <button
        className={`tab-link${linked ? " active" : ""}`}
        title={linked ? "Linked — follows notes opened elsewhere (click to unlink)" : "Link this pane (follow notes opened elsewhere)"}
        aria-pressed={linked}
        onClick={onToggleLink}
      >
        🔗
      </button>
      {tabs.length > 1 && (
        <button
          className={`tab-link tab-stack${stacked ? " active" : ""}`}
          title={stacked ? "Unstack tabs" : "Stack tabs (spread all open notes)"}
          aria-pressed={stacked}
          onClick={onToggleStacked}
        >
          ▤
        </button>
      )}
    </div>
  );
}
