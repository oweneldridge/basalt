import { useEffect } from "react";
import type { ThemeMode } from "../lib/theme";
import type { ObsidianConfig, PluginInfo } from "../lib/vault";

interface Props {
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  /** The vault's read-only Obsidian settings Basalt honors (informational). */
  obsConfig: ObsidianConfig | null;
  /** Installed Basalt plugins (from .basalt/plugins/). */
  plugins: PluginInfo[];
  /** Currently-enabled plugin ids. */
  enabledPlugins: string[];
  onTogglePlugin: (info: PluginInfo, enabled: boolean) => void;
  readableWidth: boolean;
  onReadableWidth: (on: boolean) => void;
  onClose: () => void;
}

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** A single read-only "Obsidian honors" row; renders nothing for empty values. */
function ConfigRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (value == null || value === "") return null;
  return (
    <div className="settings-config-row">
      <span className="settings-config-key">{label}</span>
      <span className="settings-config-val">{value}</span>
    </div>
  );
}

export function SettingsModal({
  themeMode,
  onThemeMode,
  obsConfig,
  plugins,
  enabledPlugins,
  onTogglePlugin,
  readableWidth,
  onReadableWidth,
  onClose,
}: Props) {
  const enabled = new Set(enabledPlugins);
  // Esc closes (the overlay handles click-away).
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

  const fmt = obsConfig?.useMarkdownLinks
    ? "Markdown [text](note.md)"
    : "Wikilinks [[note]]";
  const linkPath = obsConfig?.newLinkFormat ?? "shortest";

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="graph-close" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        <section className="settings-section">
          <div className="settings-label">Appearance</div>
          <div className="settings-row">
            <span className="settings-row-label">Theme</span>
            <div className="seg">
              {THEME_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  className={themeMode === o.value ? "seg-btn active" : "seg-btn"}
                  onClick={() => onThemeMode(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Readable line length</span>
            <input
              type="checkbox"
              checked={readableWidth}
              onChange={(e) => onReadableWidth(e.target.checked)}
            />
          </div>
          <p className="settings-hint">
            “System” follows your OS appearance. Stored per app, not in the vault.
          </p>
        </section>

        <section className="settings-section">
          <div className="settings-label">Vault (from Obsidian, read-only)</div>
          {obsConfig ? (
            <div className="settings-config">
              <ConfigRow label="New links" value={`${fmt} · ${linkPath} path`} />
              <ConfigRow label="Attachments" value={obsConfig.attachmentFolderPath} />
              <ConfigRow label="Daily notes folder" value={obsConfig.dailyNotesFolder} />
              <ConfigRow label="Daily notes format" value={obsConfig.dailyNotesFormat} />
              <ConfigRow label="Daily notes template" value={obsConfig.dailyNotesTemplate} />
            </div>
          ) : (
            <p className="settings-hint">No .obsidian config found — Basalt uses its defaults.</p>
          )}
          <p className="settings-hint">
            Basalt reads these from <code>.obsidian/</code> and never writes them.
          </p>
        </section>

        <section className="settings-section">
          <div className="settings-label">Plugins</div>
          {plugins.length === 0 ? (
            <p className="settings-hint">
              No plugins found. Add one under <code>.basalt/plugins/&lt;id&gt;/</code> (a{" "}
              <code>manifest.json</code> + <code>main.js</code>).
            </p>
          ) : (
            <div className="plugin-list">
              {plugins.map((p) => (
                <div key={p.id} className="plugin-row">
                  <label className="plugin-toggle">
                    <input
                      type="checkbox"
                      checked={enabled.has(p.id)}
                      onChange={(e) => onTogglePlugin(p, e.target.checked)}
                    />
                    <span className="plugin-name">{p.name}</span>
                    {p.version && <span className="plugin-version">v{p.version}</span>}
                  </label>
                  {p.description && <div className="plugin-desc">{p.description}</div>}
                </div>
              ))}
            </div>
          )}
          <p className="settings-hint">
            ⚠ Plugins run with full app access. Enable only plugins you trust. Enabled
            per-vault on this device.
          </p>
        </section>
      </div>
    </div>
  );
}
