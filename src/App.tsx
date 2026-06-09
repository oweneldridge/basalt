import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createNote,
  pickVault,
  readNote,
  readVault,
  writeNote,
  type VaultNote,
} from "./lib/vault";
import { VaultIndex } from "./lib/vaultIndex";
import { normalizeName, targetNoteName } from "./lib/markdown";
import { Sidebar } from "./components/Sidebar";
import { EditorPane } from "./components/EditorPane";
import { Backlinks } from "./components/Backlinks";
import "./styles.css";

const LAST_VAULT_KEY = "basalt.lastVault";
const SAVE_DEBOUNCE_MS = 500;

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

  const index = useRef(new VaultIndex());
  const vaultRef = useRef<string | null>(null);
  vaultRef.current = vault;
  const notesRef = useRef<VaultNote[]>([]);
  notesRef.current = notes;
  const activePathRef = useRef<string | null>(null);
  activePathRef.current = active?.path ?? null;
  // The debounce timer and the pending save it would perform, tracked together
  // so a context switch can flush it instead of letting the next edit clobber it.
  const saveTimer = useRef<number | undefined>(undefined);
  const pending = useRef<{ path: string; doc: string } | null>(null);

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

  const flushSave = useCallback(async (path: string, doc: string) => {
    const v = vaultRef.current;
    if (!v) return;
    setSaving(true);
    try {
      await writeNote(v, path, doc);
      // Keep the in-memory note content and index entry in sync so backlinks and
      // unlinked mentions reflect the edit immediately.
      const meta = notesRef.current.find((n) => n.path === path);
      if (meta) {
        const updated: VaultNote = { ...meta, content: doc };
        index.current.setNote(updated);
        setNotes((prev) => prev.map((n) => (n.path === path ? updated : n)));
        bumpIndex();
      }
    } finally {
      setSaving(false);
    }
  }, [bumpIndex]);

  // Flush any pending save immediately (before switching notes/vault, on blur,
  // or on close) so a debounce in flight is never dropped.
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
      if (path === activePathRef.current) return; // already open; nothing to do
      await flushPending();
      const v = vaultRef.current;
      if (!v) return;
      const doc = await readNote(v, path);
      setActive({ path, doc });
    },
    [flushPending],
  );

  const openVault = useCallback(
    async (path: string) => {
      await flushPending();
      setVault(path);
      localStorage.setItem(LAST_VAULT_KEY, path);
      setActive(null);
      await loadVault(path);
    },
    [flushPending, loadVault],
  );

  // Restore the last vault on launch.
  useEffect(() => {
    const last = localStorage.getItem(LAST_VAULT_KEY);
    if (last) {
      openVault(last).catch(() => localStorage.removeItem(LAST_VAULT_KEY));
    }
  }, [openVault]);

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
          if (closing) return; // second pass: let the close proceed normally
          closing = true;
          event.preventDefault();
          await flushPending();
          void win.close(); // re-issue close; handler re-runs and proceeds
        });
      } catch {
        /* not running under Tauri (e.g. plain vite dev) */
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

  const getNotes = useCallback(() => notesRef.current.map((n) => n.name), []);

  const handleOpenUrl = useCallback((url: string) => {
    void openUrl(url).catch(() => {
      /* opener unavailable or blocked URL — ignore */
    });
  }, []);

  const resolveTarget = useCallback((rawTarget: string): VaultNote | undefined => {
    const want = normalizeName(targetNoteName(rawTarget));
    return notesRef.current.find(
      (n) =>
        normalizeName(n.name) === want ||
        normalizeName(n.rel.replace(/\.md$/i, "")) === want,
    );
  }, []);

  const handleOpenWikilink = useCallback(
    async (target: string) => {
      const existing = resolveTarget(target);
      if (existing) {
        await openNoteByPath(existing.path);
        return;
      }
      const v = vaultRef.current;
      if (!v) return;
      try {
        await flushPending();
        const path = await createNote(v, targetNoteName(target));
        await loadVault(v);
        await openNoteByPath(path);
      } catch {
        /* name collision or invalid name — ignore for now */
      }
    },
    [resolveTarget, openNoteByPath, flushPending, loadVault],
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

  const activeName = useMemo(
    () => (active ? (notes.find((n) => n.path === active.path)?.name ?? null) : null),
    [active, notes],
  );

  // Cheap: scans the precomputed occurrence map. Recompute on save (indexVersion).
  const backlinks = useMemo(() => {
    if (!activeName || !active) return [];
    return index.current.backlinksFor(activeName, active.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeName, active, indexVersion]);

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
