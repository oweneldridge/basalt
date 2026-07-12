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
