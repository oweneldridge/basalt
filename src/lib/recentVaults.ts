// Recent-vaults list, persisted in localStorage and shared across windows.

const RECENT_VAULTS_KEY = "basalt.recentVaults";
const RECENT_VAULTS_MAX = 12;

/** A recently-opened vault, most-recent first. */
export interface RecentVault {
  path: string;
  name: string;
  ts: number;
}

/** The display name of a vault path (its final folder). */
export function vaultName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function loadRecentVaults(): RecentVault[] {
  try {
    const raw = localStorage.getItem(RECENT_VAULTS_KEY);
    const arr = raw ? (JSON.parse(raw) as RecentVault[]) : [];
    return Array.isArray(arr)
      ? arr.filter((r) => r && typeof r.path === "string" && typeof r.name === "string")
      : [];
  } catch {
    return [];
  }
}

/** Record `path` as most-recent (deduped), capped, timestamped with `now`. */
export function pushRecentVault(path: string, now: number): RecentVault[] {
  const list = loadRecentVaults().filter((r) => r.path !== path);
  list.unshift({ path, name: vaultName(path), ts: now });
  const capped = list.slice(0, RECENT_VAULTS_MAX);
  try {
    localStorage.setItem(RECENT_VAULTS_KEY, JSON.stringify(capped));
  } catch {
    /* quota — non-fatal */
  }
  return capped;
}

/** Per-window workspace-layout key. The main window keeps the historic
 * unprefixed key (existing saved layouts still restore); other windows are
 * session-scoped so two windows on one vault don't clobber each other. */
export function workspaceKey(vault: string, windowLabel: string): string {
  return windowLabel === "main" ? `basalt.workspace.${vault}` : `basalt.workspace.${vault}::${windowLabel}`;
}
