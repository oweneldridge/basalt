// Import an Obsidian vault's CONFIG (not its plugins) into Basalt: appearance
// (theme / accent / font / enabled snippets), custom hotkeys, and the list of
// community plugins the user had (for a report — Basalt can't run them). Pure
// and testable; the host reads the raw .obsidian/*.json and applies the result.

import type { Bindings } from "./hotkeys";

export type ThemeMode = "system" | "light" | "dark";

/** Raw contents read from `.obsidian/` (any may be absent). */
export interface ObsidianImportRaw {
  appearance: string | null; // appearance.json
  hotkeys: string | null; // hotkeys.json
  communityPlugins: string[]; // enabled community plugin ids
}

export interface ObsidianImportResult {
  theme: ThemeMode | null;
  accent: string | null; // hex, e.g. "#7b6cd9"
  fontSize: number | null;
  /** Enabled CSS-snippet names, or null when appearance.json didn't say. */
  enabledSnippets: string[] | null;
  /** Basalt commandId → chord, for the Obsidian hotkeys we could map. */
  hotkeys: Bindings;
  /** Obsidian command ids we couldn't map (unknown command or unrepresentable chord). */
  unmappedHotkeys: string[];
  /** Community plugin ids the vault had — reported, not run. */
  plugins: string[];
}

// Obsidian command id → Basalt command id, for the overlapping core commands.
// Obsidian has hundreds (many plugin-specific); anything absent is reported as
// unmapped rather than guessed.
const COMMAND_MAP: Record<string, string> = {
  "app:open-settings": "settings",
  "app:toggle-left-sidebar": "toggle-left-sidebar",
  "app:toggle-right-sidebar": "toggle-right-sidebar",
  "app:open-vault": "switch-vault",
  "workspace:split-vertical": "split-right",
  "workspace:split-horizontal": "split-down",
  "workspace:new-window": "new-window",
  "workspace:move-to-new-window": "move-to-new-window",
  "file-explorer:new-file": "new-note",
  "file-explorer:new-folder": "new-folder",
  "markdown:toggle-preview": "reading-mode",
  "editor:toggle-source": "source-mode",
  "editor:toggle-spellcheck": "toggle-spellcheck",
  "graph:open": "graph",
  "global-search:open": "search",
  "theme:toggle": "toggle-theme",
  "daily-notes": "daily-note",
  "daily-notes:open": "daily-note",
  "insert-template": "insert-template",
  "templates:insert-template": "insert-template",
  "random-note:open": "random-note",
  "random-note": "random-note",
  "workspaces:load": "workspaces",
  "bookmarks:bookmark-current-view": "toggle-bookmark",
  "starred:toggle-star": "toggle-bookmark",
  "audio-recorder:start": "record-audio",
  "open-with-default-app:open": "reveal-in-finder",
  "window:zoom-in": "zoom-in",
  "window:zoom-out": "zoom-out",
  "window:reset-zoom": "zoom-reset",
};

/** Obsidian hotkey {modifiers, key} → Basalt chord ("mod+alt+shift+key"), or
 * null when it can't be represented (Basalt supports mod/alt/shift only, and a
 * non-function key needs at least one modifier). */
export function obsidianChord(modifiers: string[], key: string): string | null {
  const mods = new Set(modifiers);
  const parts: string[] = [];
  // Obsidian's Mod = Cmd/Ctrl; Ctrl/Meta collapse to Basalt's single "mod".
  if (mods.has("Mod") || mods.has("Ctrl") || mods.has("Meta")) parts.push("mod");
  if (mods.has("Alt")) parts.push("alt");
  if (mods.has("Shift")) parts.push("shift");
  const k = (key ?? "").toLowerCase();
  if (!k) return null;
  const isFn = /^f\d{1,2}$/.test(k);
  if (parts.length === 0 && !isFn) return null;
  parts.push(k);
  return parts.join("+");
}

/** Parse + map an Obsidian config export into Basalt settings. Never throws —
 * malformed JSON in any file is ignored, leaving that part unset. */
export function parseObsidianImport(raw: ObsidianImportRaw): ObsidianImportResult {
  const out: ObsidianImportResult = {
    theme: null,
    accent: null,
    fontSize: null,
    enabledSnippets: null,
    hotkeys: {},
    unmappedHotkeys: [],
    plugins: [...(raw.communityPlugins ?? [])],
  };

  if (raw.appearance) {
    try {
      const a = JSON.parse(raw.appearance) as Record<string, unknown>;
      if (a.theme === "obsidian") out.theme = "dark";
      else if (a.theme === "moonstone") out.theme = "light";
      else if (a.theme === "system") out.theme = "system";
      if (typeof a.accentColor === "string" && /^#[0-9a-f]{6}$/i.test(a.accentColor.trim())) {
        out.accent = a.accentColor.trim();
      }
      if (typeof a.baseFontSize === "number" && a.baseFontSize >= 8 && a.baseFontSize <= 40) {
        out.fontSize = Math.round(a.baseFontSize);
      }
      if (Array.isArray(a.enabledCssSnippets)) {
        out.enabledSnippets = a.enabledCssSnippets.filter((x): x is string => typeof x === "string");
      }
    } catch {
      /* malformed appearance.json — leave appearance unset */
    }
  }

  if (raw.hotkeys) {
    try {
      const h = JSON.parse(raw.hotkeys) as Record<string, { modifiers?: string[]; key?: string }[]>;
      for (const [obsId, arr] of Object.entries(h)) {
        const first = Array.isArray(arr) ? arr[0] : undefined;
        const basaltId = COMMAND_MAP[obsId];
        const chord = first ? obsidianChord(first.modifiers ?? [], first.key ?? "") : null;
        if (basaltId && chord) out.hotkeys[basaltId] = chord;
        else out.unmappedHotkeys.push(obsId);
      }
    } catch {
      /* malformed hotkeys.json — no hotkeys imported */
    }
  }

  return out;
}
