export interface TabItem {
  path: string;
  name: string;
}

interface Props {
  tabs: TabItem[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onNew: () => void;
}

export function TabBar({ tabs, activePath, onSelect, onClose, onNew }: Props) {
  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((t) => (
        <div
          key={t.path}
          className={t.path === activePath ? "tab active" : "tab"}
          role="tab"
          aria-selected={t.path === activePath}
          title={t.name}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onClose(t.path); // middle-click closes
            } else if (e.button === 0) {
              onSelect(t.path);
            }
          }}
        >
          <span className="tab-name">{t.name}</span>
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
        </div>
      ))}
      <button className="tab-new" title="Open a note (⌘O)" onClick={onNew}>
        +
      </button>
    </div>
  );
}
