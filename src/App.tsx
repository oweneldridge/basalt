import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createNote,
  nameFromRel,
  pickVault,
  readNote,
  readVault,
  startWatching,
  writeNote,
  type ChangedNote,
  type VaultNote,
} from "./lib/vault";
import { VaultIndex } from "./lib/vaultIndex";
import { normalizeName, targetPathPart } from "./lib/markdown";
import { Sidebar } from "./components/Sidebar";
import { EditorPane } from "./components/EditorPane";
import { Backlinks } from "./components/Backlinks";
import "./styles.css";

const LAST_VAULT_KEY = "basalt.lastVault";
const SAVE_DEBOUNCE_MS = 500;
// How long after one of our own writes to ignore the resulting watcher events.
const SELF_WRITE_TTL_MS = 4000;

interface ActiveNote {
  path: string;
  doc: string;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export default function App() {
  const [vault, setVault] = useState<string | null>(null);
  const [notes, setNotes] = useState<VaultNote[]>([]);
  const [active, setActive] = useState<ActiveNote | null>(null);
  const [saving, setSaving] = useState(false);
  const [indexVersion, setIndexVersion] = useState(0);
  const [changedOnDisk, setChangedOnDisk] = useState(false);

  const index = useRef(new VaultIndex());
  const vaultRef = useRef<string | null>(null);
  vaultRef.current = vault;
  const notesRef = useRef<VaultNote[]>([]);
  notesRef.current = notes;
  const activePathRef = useRef<string | null>(null);
  activePathRef.current = active?.path ?? null;
  // The active note's vault-relative path — the key the watcher matches on.
  const activeRelRef = useRef<string | null>(null);
  const changedOnDiskRef = useRef(false);
  changedOnDiskRef.current = changedOnDisk;
  const saveTimer = useRef<number | undefined>(undefined);
  const pending = useRef<{ path: string; doc: string } | null>(null);
  // Vault-relative paths Basalt itself just wrote (rel -> timestamp), to ignore
  // the watcher events our own saves trigger.
  const selfWrites = useRef<Map<string, number>>(new Map());
  // Accumulated external changes (rel -> absolute path), flushed after a debounce.
  const changedBuf = useRef<Map<string, string>>(new Map());
  const watchTimer = useRef<number | undefined>(undefined);
  // Resolves once the vault-changed listener is active, so we never start the
  // watcher before we can hear it.
  const listenerReady = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!listenerReady.current) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    listenerReady.current = { promise, resolve };
  }

  const bumpIndex = useCallback(() => setIndexVersion((v) => v + 1), []);

  const loadVault = useCallback(
    async (path: string) => {
      const list = await readVault(path);
      index.current.build(list);
      setNotes(list);
      bumpIndex();
      return list;
    },
    [bumpIndex],
  );

  const flushSave = useCallback(
    async (path: string, doc: string) => {
      const v = vaultRef.current;
      if (!v) return;
      setSaving(true);
      try {
        await writeNote(v, path, doc);
        const meta = notesRef.current.find((n) => n.path === path);
        if (meta) {
          // Mark AFTER a successful write (a failed write leaves no stale
          // suppression), keyed by the rel the watcher will report.
          selfWrites.current.set(meta.rel, Date.now());
          const updated: VaultNote = { ...meta, content: doc };
          index.current.setNote(updated);
          setNotes((prev) => prev.map((n) => (n.path === path ? updated : n)));
          bumpIndex();
        }
        if (path === activePathRef.current) setChangedOnDisk(false);
      } finally {
        setSaving(false);
      }
    },
    [bumpIndex],
  );

  const flushPending = useCallback(async () => {
    if (saveTimer.current !== undefined) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    const p = pending.current;
    if (p) {
      pending.current = null;
      await flushSave(p.path, p.doc);
    }
  }, [flushSave]);

  const handleChange = useCallback(
    (doc: string) => {
      const path = activePathRef.current;
      if (!path) return;
      pending.current = { path, doc };
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        // While a disk conflict is pending, don't auto-overwrite — keep `pending`
        // and wait for the user to resolve via the badge.
        if (changedOnDiskRef.current) return;
        const p = pending.current;
        if (!p) return;
        pending.current = null;
        flushSave(p.path, p.doc);
      }, SAVE_DEBOUNCE_MS);
    },
    [flushSave],
  );

  const openNoteByPath = useCallback(
    async (path: string) => {
      if (path === activePathRef.current) return;
      await flushPending();
      const v = vaultRef.current;
      if (!v) return;
      const doc = await readNote(v, path);
      setChangedOnDisk(false);
      setActive({ path, doc });
    },
    [flushPending],
  );

  const loadAndWatch = useCallback(
    async (path: string) => {
      await loadVault(path);
      await listenerReady.current?.promise; // ensure we can hear events first
      startWatching(path).catch(() => {
        /* watcher unavailable (e.g. plain vite dev) — degrade gracefully */
      });
    },
    [loadVault],
  );

  const openVault = useCallback(
    async (path: string) => {
      await flushPending();
      setVault(path);
      localStorage.setItem(LAST_VAULT_KEY, path);
      setActive(null);
      setChangedOnDisk(false);
      await loadAndWatch(path);
    },
    [flushPending, loadAndWatch],
  );

  // Restore the last vault on launch.
  useEffect(() => {
    const last = localStorage.getItem(LAST_VAULT_KEY);
    if (last) {
      openVault(last).catch(() => localStorage.removeItem(LAST_VAULT_KEY));
    }
  }, [openVault]);

  // Apply a batch of external (on-disk) changes, matched by vault-relative path.
  const processChanges = useCallback(
    async (changes: ChangedNote[]) => {
      const v = vaultRef.current;
      if (!v) return;
      const byRel = new Map(notesRef.current.map((n) => [n.rel, n]));
      const prevByRel = new Map(notesRef.current.map((n) => [n.rel, n.content]));

      const results = await Promise.all(
        changes.map(async (c) => {
          const existing = byRel.get(c.rel);
          const absPath = existing?.path ?? c.path;
          try {
            return { rel: c.rel, path: absPath, content: await readNote(v, absPath), ok: true as const };
          } catch {
            return { rel: c.rel, path: absPath, content: "", ok: false as const };
          }
        }),
      );

      for (const r of results) {
        if (r.ok) {
          index.current.setNote({ path: r.path, rel: r.rel, name: nameFromRel(r.rel), content: r.content });
        } else {
          const ex = byRel.get(r.rel);
          if (ex) index.current.removeNote(ex.path);
        }
      }
      setNotes((prev) => {
        let next = prev.slice();
        for (const r of results) {
          const i = next.findIndex((n) => n.rel === r.rel);
          if (r.ok) {
            if (i === -1) {
              next.push({ path: r.path, rel: r.rel, name: nameFromRel(r.rel), content: r.content });
            } else {
              next[i] = { ...next[i], content: r.content };
            }
          } else if (i !== -1) {
            next = next.filter((n) => n.rel !== r.rel);
          }
        }
        return next.sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase()));
      });
      bumpIndex();

      // Reconcile the open note per the conflict policy.
      const activeRel = activeRelRef.current;
      const activePath = activePathRef.current;
      if (!activeRel || !activePath) return;
      const open = results.find((r) => r.rel === activeRel);
      if (!open) return;
      const dirty = pending.current?.path === activePath;
      if (!open.ok) {
        if (dirty) setChangedOnDisk(true);
        else setActive(null);
        return;
      }
      if (dirty) {
        setChangedOnDisk(true);
        return;
      }
      // Clean: skip if nothing really changed (e.g. our own leaked save), and
      // re-check dirtiness in case the user just started typing.
      if (open.content === prevByRel.get(activeRel)) return;
      if (pending.current?.path === activePath) {
        setChangedOnDisk(true);
        return;
      }
      // Update content in-place (EditorPane reconciles, preserving the caret).
      setActive({ path: activePath, doc: open.content });
    },
    [bumpIndex],
  );

  // Listen for on-disk changes; suppress our own writes; debounce; then apply.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await listen<ChangedNote[]>("vault-changed", (event) => {
          const now = Date.now();
          for (const [k, t] of selfWrites.current) {
            if (now - t >= SELF_WRITE_TTL_MS) selfWrites.current.delete(k);
          }
          for (const c of event.payload) {
            // Suppress (but keep the entry, so sibling burst events are also
            // suppressed); expired entries were just pruned above.
            if (selfWrites.current.has(c.rel)) continue;
            changedBuf.current.set(c.rel, c.path);
          }
          if (changedBuf.current.size === 0) return;
          window.clearTimeout(watchTimer.current);
          watchTimer.current = window.setTimeout(() => {
            const changes = Array.from(changedBuf.current, ([rel, path]) => ({ rel, path }));
            changedBuf.current.clear();
            void processChanges(changes);
          }, 300);
        });
      } catch {
        /* not running under Tauri */
      } finally {
        listenerReady.current?.resolve();
      }
    })();
    return () => unlisten?.();
  }, [processChanges]);

  // Never lose a pending edit on focus loss or app close.
  useEffect(() => {
    const onBlur = () => {
      void flushPending();
    };
    window.addEventListener("blur", onBlur);
    let unlisten: (() => void) | undefined;
    let closing = false;
    (async () => {
      try {
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested(async (event) => {
          if (closing) return;
          closing = true;
          event.preventDefault();
          await flushPending();
          void win.close();
        });
      } catch {
        /* not running under Tauri */
      }
    })();
    return () => {
      window.removeEventListener("blur", onBlur);
      unlisten?.();
    };
  }, [flushPending]);

  const handleOpenVault = useCallback(async () => {
    const picked = await pickVault();
    if (picked) await openVault(picked);
  }, [openVault]);

  // Conflict resolution: take the on-disk version, discarding local edits.
  const handleReloadFromDisk = useCallback(async () => {
    const v = vaultRef.current;
    const path = activePathRef.current;
    if (!v || !path) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    pending.current = null;
    setChangedOnDisk(false);
    try {
      const doc = await readNote(v, path);
      setActive({ path, doc });
    } catch {
      setActive(null);
    }
  }, []);

  // Conflict resolution: keep local edits, overwriting the on-disk version.
  const handleKeepMine = useCallback(async () => {
    setChangedOnDisk(false);
    await flushPending();
  }, [flushPending]);

  const getNotes = useCallback(() => notesRef.current.map((n) => n.name), []);

  const handleOpenUrl = useCallback((url: string) => {
    void openUrl(url).catch(() => {
      /* opener unavailable or blocked URL — ignore */
    });
  }, []);

  const handleOpenWikilink = useCallback(
    async (target: string) => {
      const resolved = index.current.resolve(target, activePathRef.current ?? "");
      if (resolved) {
        await openNoteByPath(resolved);
        return;
      }
      const v = vaultRef.current;
      if (!v) return;
      try {
        await flushPending();
        // Preserve the folder for `[[sub/New]]` so the created note matches the link.
        const path = await createNote(v, targetPathPart(target));
        await loadVault(v);
        await openNoteByPath(path);
      } catch {
        /* name collision or invalid name — ignore for now */
      }
    },
    [openNoteByPath, flushPending, loadVault],
  );

  const handleNewNote = useCallback(async () => {
    const v = vaultRef.current;
    if (!v) return;
    const existing = new Set(notesRef.current.map((n) => normalizeName(n.name)));
    let name = "Untitled";
    let i = 1;
    while (existing.has(normalizeName(name))) name = `Untitled ${i++}`;
    await flushPending();
    const path = await createNote(v, name);
    await loadVault(v);
    await openNoteByPath(path);
  }, [flushPending, loadVault, openNoteByPath]);

  const activeNote = useMemo(
    () => (active ? (notes.find((n) => n.path === active.path) ?? null) : null),
    [active, notes],
  );
  const activeName = activeNote?.name ?? null;
  activeRelRef.current = activeNote?.rel ?? null;

  // Resolves each link occurrence to a concrete path. Recompute on save (indexVersion).
  const backlinks = useMemo(() => {
    if (!active) return [];
    return index.current.backlinksFor(active.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, indexVersion]);

  // Expensive (full vault text scan). Recompute only when the active note
  // changes — not on every debounced save — to keep typing smooth.
  const unlinked = useMemo(() => {
    if (!activeName || !active) return [];
    return index.current.unlinkedMentionsFor(activeName, notesRef.current, active.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeName, active]);

  if (!vault) {
    return (
      <div className="welcome">
        <h1>Basalt</h1>
        <p>Open a folder of Markdown notes — your existing Obsidian vault works as-is.</p>
        <button className="primary" onClick={handleOpenVault}>
          Open vault…
        </button>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar
        notes={notes}
        activePath={active?.path ?? null}
        vaultName={basename(vault)}
        onOpen={(n) => openNoteByPath(n.path)}
        onNewNote={handleNewNote}
      />
      <main className="main">
        <div className="toolbar">
          <button className="link-btn" onClick={handleOpenVault}>
            Change vault…
          </button>
          {changedOnDisk && (
            <span className="conflict">
              <span className="conflict-label">⚠ Changed on disk</span>
              <button className="badge-btn" onClick={handleReloadFromDisk}>
                Reload
              </button>
              <button className="badge-btn" onClick={handleKeepMine}>
                Keep mine
              </button>
            </span>
          )}
          <span className="spacer" />
          <span className="status">{saving ? "Saving…" : active ? "Saved" : ""}</span>
        </div>
        {active ? (
          <EditorPane
            key={active.path}
            path={active.path}
            doc={active.doc}
            getNotes={getNotes}
            onOpenWikilink={handleOpenWikilink}
            onOpenUrl={handleOpenUrl}
            onChange={handleChange}
          />
        ) : (
          <div className="placeholder">Select a note, or press + to create one.</div>
        )}
      </main>
      <Backlinks
        noteName={activeName}
        backlinks={backlinks}
        unlinked={unlinked}
        onOpen={(path) => openNoteByPath(path)}
      />
    </div>
  );
}
