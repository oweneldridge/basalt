// Parse a `basalt://` deep link. The CLI (and, later, other tools) emit
//   basalt://open?vault=<abs path>&note=<vault-relative path>
// to navigate a running app. Only the `open` action is understood; a missing
// or malformed URL yields null so callers can ignore it safely.
export interface DeepLinkOpen {
  vault: string;
  note?: string;
}

export function parseBasaltUri(raw: string): DeepLinkOpen | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "basalt:") return null;
  // `basalt://open?…` parses host = "open"; be lenient about a slashless form.
  const action = (u.host || u.pathname.replace(/^\/+/, "")).toLowerCase();
  if (action !== "open") return null;
  const vault = u.searchParams.get("vault");
  if (!vault) return null;
  const note = u.searchParams.get("note");
  return { vault, note: note || undefined };
}

/** What to do with a link's vault: a link can come from any web page, so only
 * vaults the user has opened before open straight away. Network paths are
 * refused, since merely resolving one can send the user's credentials. */
export function deepLinkVaultPolicy(vault: string, known: readonly string[]): "open" | "confirm" | "refuse" {
  const v = vault.trim();
  if (/^(\\\\|\/\/)/.test(v) || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return "refuse";
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  return known.some((k) => norm(k) === norm(v)) ? "open" : "confirm";
}

/** An `obsidian://` link Basalt can follow itself: open a note, or search. */
export type ObsidianLink =
  | { action: "open"; vault?: string; file?: string; path?: string }
  | { action: "search"; vault?: string; query: string };

/**
 * Parse the `obsidian://` actions that only navigate: `open` (by vault and
 * file, or by absolute path) and `search`, plus the shorthands
 * `obsidian://vault/<vault>/<file>` and `obsidian:///<absolute path>`.
 * Anything else, including an `open` that would prepend or append text, is
 * null and goes to the system as before.
 */
export function parseObsidianUri(raw: string): ObsidianLink | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "obsidian:") return null;
  const q = (k: string) => u.searchParams.get(k) ?? undefined;
  const segments = () =>
    u.pathname
      .split("/")
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });
  const action = u.host.toLowerCase();
  if (action === "" && u.pathname.length > 1) return { action: "open", path: "/" + segments().join("/") };
  if (action === "vault") {
    const [vault, ...file] = segments();
    return vault ? { action: "open", vault, file: file.length ? file.join("/") : undefined } : null;
  }
  if (action === "open") {
    if (q("prepend") !== undefined || q("append") !== undefined) return null;
    return { action: "open", vault: q("vault"), file: q("file"), path: q("path") };
  }
  if (action === "search") return { action: "search", vault: q("vault"), query: q("query") ?? "" };
  return null;
}
