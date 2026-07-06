// File recovery: periodic local snapshots of note content so a past version can
// be restored, matching Obsidian's File Recovery. Snapshots live in the
// webview's IndexedDB — LOCAL to this machine, OUTSIDE the vault (never synced,
// never clutters the vault). Keyed by vault + note-rel.
//
// The capture/prune POLICY is pure (testable); IndexedDB I/O is a thin async
// layer that no-ops when IndexedDB is unavailable (tests / headless).

export interface Snapshot {
  ts: number; // ms epoch
  content: string;
}

export const SNAPSHOT_INTERVAL_MS = 2 * 60 * 1000; // ≥2 min between snapshots per note
export const MAX_SNAPSHOTS = 100; // per note
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Whether a save should be snapshotted. First save always is; otherwise only
 * when the content actually changed AND the interval has elapsed since the last
 * snapshot (so frequent saves don't flood the history). `existing` is ascending
 * by ts. */
export function shouldSnapshot(
  existing: Snapshot[],
  content: string,
  now: number,
  intervalMs: number = SNAPSHOT_INTERVAL_MS,
  force = false,
): boolean {
  if (!content) return false;
  const latest = existing[existing.length - 1];
  if (!latest) return true;
  if (latest.content === content) return false; // dedup, even when forced
  return force || now - latest.ts >= intervalMs;
}

/** Drop snapshots older than the retention window, then keep the newest
 * MAX_SNAPSHOTS. Input/output ascending by ts. */
export function pruneSnapshots(
  list: Snapshot[],
  now: number,
  max: number = MAX_SNAPSHOTS,
  maxAgeMs: number = MAX_AGE_MS,
): Snapshot[] {
  return list.filter((s) => now - s.ts <= maxAgeMs).slice(-max);
}

// ---------------------------------------------------------------------------
// IndexedDB store: one record per note, value = Snapshot[] (ascending by ts).

const DB_NAME = "basalt-snapshots";
const STORE = "notes";
const SEP = "\u0000"; // NUL: can never appear in a vault path/rel

function recordKey(vaultKey: string, rel: string): string {
  return `${vaultKey}${SEP}${rel}`;
}

function openDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<Snapshot[]> {
  return new Promise((resolve) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as Snapshot[]) : []);
    req.onerror = () => resolve([]);
  });
}

/** Read-modify-write a note's record inside ONE transaction (so concurrent
 * captures can't race and drop a snapshot). `fn` returns the new array, or null
 * to leave the record unchanged. Resolves true if it wrote. */
function idbUpdate(
  db: IDBDatabase,
  key: string,
  fn: (existing: Snapshot[]) => Snapshot[] | null,
): Promise<boolean> {
  return new Promise((resolve) => {
    let wrote = false;
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch {
      resolve(false);
      return;
    }
    const store = tx.objectStore(STORE);
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const next = fn(Array.isArray(getReq.result) ? (getReq.result as Snapshot[]) : []);
      if (next !== null) {
        store.put(next, key);
        wrote = true;
      }
    };
    tx.oncomplete = () => resolve(wrote);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

/** All snapshots for a note, newest first. */
export async function listSnapshots(vaultKey: string, rel: string): Promise<Snapshot[]> {
  const db = await openDB();
  if (!db) return [];
  const list = await idbGet(db, recordKey(vaultKey, rel));
  db.close();
  return [...list].reverse();
}

/** Record a snapshot of `content` if the capture policy allows (get+put in one
 * transaction), then prune. `force` bypasses the interval throttle (still
 * deduped) — used to capture the current state right before a restore. Returns
 * true if a snapshot was written. `now` is injected for testing. */
export async function recordSnapshot(
  vaultKey: string,
  rel: string,
  content: string,
  now: number,
  force = false,
): Promise<boolean> {
  const db = await openDB();
  if (!db) return false;
  const wrote = await idbUpdate(db, recordKey(vaultKey, rel), (existing) =>
    shouldSnapshot(existing, content, now, SNAPSHOT_INTERVAL_MS, force)
      ? pruneSnapshots([...existing, { ts: now, content }], now)
      : null,
  );
  db.close();
  return wrote;
}

/** Remove a note's whole snapshot history (called when a note is deleted so a
 * later note reusing the same rel can't inherit — and restore — its content). */
export async function clearSnapshots(vaultKey: string, rel: string): Promise<void> {
  const db = await openDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(recordKey(vaultKey, rel));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

/** Move a note's history from oldRel to newRel on rename (one transaction), so
 * the recovery history follows the note and never strands under the old name. */
export async function renameSnapshots(vaultKey: string, oldRel: string, newRel: string): Promise<void> {
  if (oldRel === newRel) return;
  const db = await openDB();
  if (!db) return;
  const oldK = recordKey(vaultKey, oldRel);
  const newK = recordKey(vaultKey, newRel);
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const g = store.get(oldK);
    g.onsuccess = () => {
      const list = Array.isArray(g.result) ? (g.result as Snapshot[]) : [];
      if (list.length) {
        store.put(list, newK);
        store.delete(oldK);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}
