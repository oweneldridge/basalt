// Basalt's appearance theme — a GLOBAL app preference (not per-vault, and
// distinct from the read-only `.obsidian` appearance). Persisted in
// localStorage and applied by flipping `data-theme` on <html>, which swaps the
// CSS-variable palette in styles.css. The CM6 editor's `dark` flag is swapped
// separately (editor/setup.ts `setEditorTheme`) so its built-in heuristics
// match. A no-flash inline script in index.html applies the same logic before
// React mounts, so the first paint is already correct.

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const THEME_KEY = "basalt.theme";

export function loadThemeMode(): ThemeMode {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export function saveThemeMode(mode: ThemeMode): void {
  localStorage.setItem(THEME_KEY, mode);
}

/** Resolve a mode to a concrete theme. Explicit modes pass through; "system"
 * follows the OS preference. Pure, so the precedence is unit-testable. */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "light" || mode === "dark") return mode;
  return prefersDark ? "dark" : "light";
}

function systemPrefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Flip the CSS-variable palette by setting `data-theme` on the document root. */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
}

/** Resolve `mode` against the live system preference and apply it; returns the
 * concrete theme so callers can sync the editor's dark flag. */
export function applyThemeMode(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode, systemPrefersDark());
  applyResolvedTheme(resolved);
  return resolved;
}

/** Subscribe to OS preference changes (only meaningful while mode is "system").
 * Returns an unsubscribe function. */
export function watchSystemTheme(onChange: (resolved: ResolvedTheme) => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const handler = () => onChange(mq.matches ? "dark" : "light");
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
