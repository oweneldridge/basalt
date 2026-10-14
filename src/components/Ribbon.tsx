import { pluginRibbonItems } from "../lib/plugins";
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
  /** Bumps when the plugin registry changes → re-read plugin ribbon icons. */
  pluginVersion: number;
  /** A vault is opening: only the command palette (to switch again) works. */
  held?: boolean;
}

export function Ribbon({
  onQuickSwitcher,
  onSearch,
  onCommandPalette,
  onGraph,
  onToggleSidebar,
  onSettings,
  pluginVersion,
  held = false,
}: Props) {
  // Plugin-contributed icons (re-read on registry change).
  void pluginVersion;
  const pluginIcons = pluginRibbonItems();
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
        {top.map((a) => {
          const off = held && a.id !== "palette" && a.id !== "sidebar";
          return (
            <button
              key={a.id}
              className="ribbon-btn"
              title={a.label}
              aria-label={a.label}
              aria-disabled={off || undefined}
              onClick={off ? undefined : a.onClick}
            >
              {a.icon}
            </button>
          );
        })}
        {pluginIcons.map((r, i) => (
          <button
            key={`plugin:${r.pluginId}:${i}`}
            className="ribbon-btn ribbon-plugin-btn"
            title={r.title}
            aria-label={r.title}
            aria-disabled={held || undefined}
            onClick={held ? undefined : () => r.callback()}
          >
            {r.icon}
          </button>
        ))}
      </div>
      <div className="ribbon-bottom">
        <button
          className="ribbon-btn"
          title="Settings (⌘,)"
          aria-label="Settings"
          aria-disabled={held || undefined}
          onClick={held ? undefined : onSettings}
        >
          ⚙
        </button>
      </div>
    </div>
  );
}
