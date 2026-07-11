// Bring an Obsidian community theme's PALETTE (not its DOM styling) into Basalt.
//
// Obsidian themes are CSS written against Obsidian's variable names + DOM. We
// can't apply their rules to Basalt's different DOM, but we can lift their
// COLOR PALETTE: inject the theme CSS into a hidden probe carrying Obsidian's
// theme-mode class, let the browser resolve every variable (handling var()
// indirection / hsl / calc for us), read the concrete values off the probe, and
// map Obsidian's standard variables onto Basalt's. The probe + injected style
// are added and removed synchronously (no repaint between), so the live UI never
// flickers and no theme rule lingers.

// Basalt var ← the first Obsidian var that resolves to a non-empty value.
// Accent is intentionally omitted — the user's explicit accentColor import wins.
const VAR_MAP: { basalt: string; from: string[] }[] = [
  { basalt: "--bg", from: ["--background-primary"] },
  { basalt: "--bg-editor", from: ["--background-primary"] },
  { basalt: "--bg-sidebar", from: ["--background-secondary"] },
  { basalt: "--bg-elev", from: ["--background-secondary-alt", "--background-primary-alt", "--background-secondary"] },
  { basalt: "--border", from: ["--background-modifier-border", "--divider-color"] },
  { basalt: "--text", from: ["--text-normal"] },
  { basalt: "--text-muted", from: ["--text-muted"] },
  { basalt: "--text-faint", from: ["--text-faint"] },
  { basalt: "--code", from: ["--code-normal", "--text-accent"] },
  { basalt: "--selection", from: ["--text-selection"] },
];

export type ThemePalette = Record<string, string>;

/** Resolve an Obsidian theme's palette (Basalt var → value) for one mode. */
export function resolveThemePalette(themeCss: string, mode: "dark" | "light"): ThemePalette {
  const style = document.createElement("style");
  style.textContent = themeCss;
  // Themes scope vars under `.theme-dark`, `body.theme-dark`, or `:root` — put
  // the mode class on <body> so all three match; a child probe inherits the
  // resulting vars. Done synchronously (no repaint), then fully reverted.
  const cls = `theme-${mode}`;
  const hadCls = document.body.classList.contains(cls);
  const probe = document.createElement("div");
  probe.style.display = "none";
  document.body.classList.add(cls);
  document.body.append(style, probe);
  try {
    const cs = getComputedStyle(probe);
    const out: ThemePalette = {};
    for (const { basalt, from } of VAR_MAP) {
      for (const v of from) {
        const val = cs.getPropertyValue(v).trim();
        if (val) {
          out[basalt] = val;
          break;
        }
      }
    }
    return out;
  } finally {
    probe.remove();
    style.remove();
    if (!hadCls) document.body.classList.remove(cls);
  }
}

/** Resolve both light + dark palettes from a theme's CSS. */
export function resolveThemePalettes(themeCss: string): { dark: ThemePalette; light: ThemePalette } {
  return { dark: resolveThemePalette(themeCss, "dark"), light: resolveThemePalette(themeCss, "light") };
}

/** Apply a palette's overrides to the document root (or clear all Basalt vars we
 * manage when `palette` is null). */
export function applyThemePalette(palette: ThemePalette | null): void {
  const root = document.documentElement;
  for (const { basalt } of VAR_MAP) {
    const v = palette?.[basalt];
    if (v) root.style.setProperty(basalt, v);
    else root.style.removeProperty(basalt);
  }
}
