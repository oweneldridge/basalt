import { useEffect, useRef, useState } from "react";
import type { ThemeMode } from "../lib/theme";
import { chordOf, chordLabel, type Bindings } from "../lib/hotkeys";
import type { ObsidianImportResult } from "../lib/obsidianImport";
import type { ObsidianConfig, PluginInfo } from "../lib/vault";
import { pluginSettingTabs, type SettingTab } from "../lib/plugins";

/** Expandable panel that mounts a plugin's own settings DOM (containerEl) and
 * calls its display() when opened. */
function PluginSettings({ tab }: { tab: SettingTab }) {
  const [open, setOpen] = useState(false);
  const mount = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = mount.current;
    if (!open || !el) return;
    el.appendChild(tab.containerEl);
    tab.display();
    return () => {
      tab.hide?.();
      if (tab.containerEl.parentNode === el) el.removeChild(tab.containerEl);
    };
  }, [open, tab]);
  return (
    <div className="plugin-settings">
      <button className="plugin-settings-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} Settings
      </button>
      {open && <div className="plugin-settings-mount" ref={mount} />}
    </div>
  );
}

interface Props {
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  /** The vault's read-only Obsidian settings Basalt honors (informational). */
  obsConfig: ObsidianConfig | null;
  /** Run the one-shot "Import from Obsidian" (appearance + hotkeys + snippets). */
  onImportFromObsidian: () => void;
  /** Result of the last import (for the summary), or null. */
  importReport: ObsidianImportResult | null;
  /** Installed Basalt plugins (from .basalt/plugins/). */
  plugins: PluginInfo[];
  /** Currently-enabled plugin ids. */
  enabledPlugins: string[];
  onTogglePlugin: (info: PluginInfo, enabled: boolean) => void;
  readableWidth: boolean;
  onReadableWidth: (on: boolean) => void;
  spellcheck: boolean;
  onSpellcheck: (on: boolean) => void;
  vim: boolean;
  onVim: (on: boolean) => void;
  rtl: boolean;
  onRtl: (on: boolean) => void;
  fontSize: number;
  onFontSize: (px: number) => void;
  /** Current accent color as a hex string (the effective value for the picker). */
  accent: string;
  /** Set the accent override; "" resets to the theme default. */
  onAccent: (hex: string) => void;
  /** Palette commands (id + label) for hotkey assignment. */
  commands: { id: string; label: string }[];
  hotkeys: Bindings;
  onSetHotkey: (commandId: string, chord: string | null) => void;
  /** CSS snippet names discovered in .basalt/snippets/. */
  cssSnippets: string[];
  disabledSnippets: Set<string>;
  onToggleSnippet: (name: string, enabled: boolean) => void;
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
  onImportFromObsidian,
  importReport,
  plugins,
  enabledPlugins,
  onTogglePlugin,
  readableWidth,
  onReadableWidth,
  spellcheck,
  onSpellcheck,
  vim,
  onVim,
  rtl,
  onRtl,
  fontSize,
  onFontSize,
  accent,
  onAccent,
  commands,
  hotkeys,
  onSetHotkey,
  cssSnippets,
  disabledSnippets,
  onToggleSnippet,
  onClose,
}: Props) {
  // Command id currently recording a chord (next keydown is captured).
  const [recording, setRecording] = useState<string | null>(null);
  // Plugin-contributed settings panels, keyed by plugin id (live registry).
  const settingTabById = new Map(pluginSettingTabs().map((t) => [t.pluginId, t.tab]));
  const isMac = /Mac/.test(navigator.platform);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const chord = chordOf(e, isMac);
      if (!chord) return; // lone modifier / unmodified key — keep listening
      onSetHotkey(recording, chord);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onSetHotkey, isMac]);
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
          <div className="settings-row">
            <span className="settings-row-label">Spellcheck</span>
            <input type="checkbox" checked={spellcheck} onChange={(e) => onSpellcheck(e.target.checked)} />
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Vim key bindings</span>
            <input type="checkbox" checked={vim} onChange={(e) => onVim(e.target.checked)} />
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Right-to-left (RTL)</span>
            <input type="checkbox" checked={rtl} onChange={(e) => onRtl(e.target.checked)} />
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Font size</span>
            <span className="settings-inline">
              <input
                type="range"
                min={12}
                max={24}
                step={1}
                value={fontSize}
                onChange={(e) => onFontSize(Number(e.target.value))}
                aria-label="Font size"
              />
              <span className="settings-num">{fontSize}px</span>
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Accent color</span>
            <span className="settings-inline">
              <input
                type="color"
                value={accent}
                onChange={(e) => onAccent(e.target.value)}
                aria-label="Accent color"
              />
              <button className="settings-reset" onClick={() => onAccent("")}>
                Reset
              </button>
            </span>
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
          <div className="settings-row">
            <span className="settings-row-label">Import settings from Obsidian</span>
            <button className="settings-import-btn" onClick={onImportFromObsidian}>
              Import
            </button>
          </div>
          {importReport && (
            <div className="import-report">
              <div>
                Applied: theme {importReport.theme ?? "—"}, accent {importReport.accent ?? "—"}, font{" "}
                {importReport.fontSize ? `${importReport.fontSize}px` : "—"}
                {importReport.fontText ? ` ${importReport.fontText}` : ""}.
              </div>
              {importReport.themePaletteApplied && <div>Community theme palette applied.</div>}
              <div>
                {Object.keys(importReport.hotkeys).length} hotkeys imported
                {importReport.unmappedHotkeys.length > 0 && ` · ${importReport.unmappedHotkeys.length} couldn’t be mapped`}.
              </div>
              {importReport.plugins.length > 0 && (
                <div className="import-plugins">
                  <span className="settings-hint">
                    {importReport.plugins.length} Obsidian community plugins found — Basalt can’t run these; find or build
                    Basalt-native equivalents:
                  </span>
                  <ul>
                    {importReport.plugins.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <p className="settings-hint">
            Appearance, hotkeys, and enabled CSS snippets copy over. Plugins are listed but not run.
          </p>
        </section>

        <section className="settings-section">
          <div className="settings-label">Hotkeys</div>
          <div className="hotkey-list">
            {commands.map((c) => (
              <div key={c.id} className="hotkey-row">
                <span className="hotkey-label" title={c.id}>
                  {c.label}
                </span>
                <button
                  className={recording === c.id ? "hotkey-chord recording" : "hotkey-chord"}
                  onClick={() => setRecording(recording === c.id ? null : c.id)}
                  title={recording === c.id ? "Press a key combination (Esc to cancel)" : "Click to record a hotkey"}
                >
                  {recording === c.id ? "Press keys…" : hotkeys[c.id] ? chordLabel(hotkeys[c.id], isMac) : "—"}
                </button>
                {hotkeys[c.id] && recording !== c.id && (
                  <button className="hotkey-clear" title="Remove hotkey" onClick={() => onSetHotkey(c.id, null)}>
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="settings-hint">
            Click a binding, then press the combination. One command per chord; built-in
            shortcuts (⌘O, ⌘P, …) take precedence.
          </p>
        </section>

        <section className="settings-section">
          <div className="settings-label">CSS snippets</div>
          {cssSnippets.length === 0 ? (
            <p className="settings-hint">
              No snippets found. Add <code>.css</code> files under{" "}
              <code>.basalt/snippets/</code> to restyle Basalt.
            </p>
          ) : (
            <div className="plugin-list">
              {cssSnippets.map((name) => (
                <div key={name} className="plugin-row">
                  <label className="plugin-toggle">
                    <input
                      type="checkbox"
                      checked={!disabledSnippets.has(name)}
                      onChange={(e) => onToggleSnippet(name, e.target.checked)}
                    />
                    <span className="plugin-name">{name}</span>
                  </label>
                </div>
              ))}
            </div>
          )}
          <p className="settings-hint">
            Enabled per-vault on this device. CSS can restyle, never run code.
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
                  {enabled.has(p.id) && settingTabById.get(p.id) && (
                    <PluginSettings tab={settingTabById.get(p.id)!} />
                  )}
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
