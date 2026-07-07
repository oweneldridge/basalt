// Custom hotkeys: user-assigned chords for command-palette commands. Pure
// chord logic (testable) + a localStorage store (global — hotkeys are a user
// preference, not vault data).
//
// A chord is stored normalized as "mod+alt+shift+key" (mod = Cmd on mac,
// Ctrl elsewhere; segments in that fixed order; key lowercased, from
// KeyboardEvent.key). Bindings map commandId → chord.

export type Bindings = Record<string, string>;

const STORE_KEY = "basalt-hotkeys";

/** Normalize a keyboard event to a chord string, or null when it's just a
 * modifier / unmodified printable key (those are never valid hotkeys). */
export function chordOf(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}, isMac: boolean): string | null {
  const key = e.key.toLowerCase();
  if (["meta", "control", "alt", "shift"].includes(key)) return null;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const extraMod = isMac ? e.ctrlKey : e.metaKey; // the "other" modifier — rejected for simplicity
  if (extraMod) return null;
  // Function keys may bind bare; anything else needs a real modifier.
  const isFnKey = /^f\d{1,2}$/.test(key);
  if (!mod && !e.altKey && !isFnKey) return null;
  const parts: string[] = [];
  if (mod) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

/** Human-readable form of a chord ("mod+shift+k" → "⌘⇧K" on mac). */
export function chordLabel(chord: string, isMac: boolean): string {
  return chord
    .split("+")
    .map((p) => {
      if (p === "mod") return isMac ? "⌘" : "Ctrl+";
      if (p === "alt") return isMac ? "⌥" : "Alt+";
      if (p === "shift") return isMac ? "⇧" : "Shift+";
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join("");
}

/** The commandId bound to this event's chord, or null. */
export function matchChord(
  e: Parameters<typeof chordOf>[0],
  bindings: Bindings,
  isMac: boolean,
): string | null {
  const chord = chordOf(e, isMac);
  if (!chord) return null;
  for (const [id, c] of Object.entries(bindings)) if (c === chord) return id;
  return null;
}

export function loadBindings(): Bindings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Bindings = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
      return out;
    }
  } catch {
    /* corrupted store — start fresh */
  }
  return {};
}

export function saveBindings(b: Bindings): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(b));
  } catch {
    /* quota — non-fatal */
  }
}
