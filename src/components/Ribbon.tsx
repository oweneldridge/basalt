// The left ribbon — a thin vertical strip of quick-action icons (Obsidian's
// ribbon). Every action already exists as a command/shortcut; the ribbon just
// surfaces the common ones for the mouse. Pure presentational: it calls back to
// the app, holds no state.
interface RibbonAction {
  id: string;
  label: string; // tooltip
  icon: string; // a glyph (kept text so it themes with the font)
  onClick: () => void;
}

interface Props {
  onQuickSwitcher: () => void;
  onSearch: () => void;
  onCommandPalette: () => void;
  onGraph: () => void;
  onToggleSidebar: () => void;
  onSettings: () => void;
}

export function Ribbon({
  onQuickSwitcher,
  onSearch,
  onCommandPalette,
  onGraph,
  onToggleSidebar,
  onSettings,
}: Props) {
  const top: RibbonAction[] = [
    { id: "sidebar", label: "Toggle sidebar (⌘\\)", icon: "☰", onClick: onToggleSidebar },
    { id: "switcher", label: "Quick switcher (⌘O)", icon: "⌕", onClick: onQuickSwitcher },
    { id: "search", label: "Search (⌘⇧F)", icon: "⌂", onClick: onSearch },
    { id: "palette", label: "Command palette (⌘P)", icon: "⌘", onClick: onCommandPalette },
    { id: "graph", label: "Graph view", icon: "☊", onClick: onGraph },
  ];
  return (
    <div className="ribbon" role="toolbar" aria-label="Ribbon">
      <div className="ribbon-top">
        {top.map((a) => (
          <button key={a.id} className="ribbon-btn" title={a.label} aria-label={a.label} onClick={a.onClick}>
            {a.icon}
          </button>
        ))}
      </div>
      <div className="ribbon-bottom">
        <button className="ribbon-btn" title="Settings (⌘,)" aria-label="Settings" onClick={onSettings}>
          ⚙
        </button>
      </div>
    </div>
  );
}
