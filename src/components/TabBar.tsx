export interface TabItem {
  path: string;
  name: string;
  pinned?: boolean;
}

interface Props {
  tabs: TabItem[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onNew: () => void;
  /** Toggle a tab's pinned state (right-click / the pin glyph). */
  onTogglePin: (path: string) => void;
}

export function TabBar({ tabs, activePath, onSelect, onClose, onNew, onTogglePin }: Props) {
  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((t) => (
        <div
          key={t.path}
          className={`tab${t.path === activePath ? " active" : ""}${t.pinned ? " pinned" : ""}`}
          role="tab"
          aria-selected={t.path === activePath}
          title={t.pinned ? `${t.name} (pinned)` : t.name}
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
            onTogglePin(t.path); // right-click toggles pin (like Obsidian's menu)
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
      <button className="tab-new" title="Open a note (⌘O)" onClick={onNew}>
        +
      </button>
    </div>
  );
}
