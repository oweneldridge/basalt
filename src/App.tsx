import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createNote,
  nameFromRel,
  openVaultBackend,
  pickVault,
  readNote,
  readVault,
  startWatching,
  writeNote,
  type ChangedNote,
  type VaultNote,
} from "./lib/vault";
import { VaultIndex } from "./lib/vaultIndex";
import { clearImageCache, resolveImage } from "./lib/assets";
import { normalizeName, targetPathPart } from "./lib/markdown";
import { Sidebar } from "./components/Sidebar";
import { EditorPane } from "./components/EditorPane";
import { Backlinks } from "./components/Backlinks";
import { GraphView } from "./components/GraphView";
import { Palette } from "./components/Palette";
import { fuzzyRank } from "./lib/fuzzy";
import { searchVault, type SearchHit } from "./lib/search";
import "./styles.css";

const LAST_VAULT_KEY = "basalt.lastVault";

// Diagnostic bridge: mirrors frontend events into the dev terminal.
function jsLog(msg: string): void {
  console.log("[basalt]", msg);
  invoke("debug_log", { msg }).catch(() => {});
}
const SAVE_DEBOUNCE_MS = 500;
// Bound on the self-write suppression map (rel -> last written content).
const SELF_WRITES_MAX = 128;

interface ActiveNote {
  path: string;
  doc: string;
  /** 1-based line to scroll to on open (from search / backlinks). */
  scrollToLine?: number;
}

type ModalKind = "switcher" | "search" | null;

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Known non-Markdown attachment extension at the end of a link target. */
function isAttachmentTarget(pathPart: string): boolean {
  return /\.[a-z0-9]{1,8}$/i.test(pathPart) && !/\.md$/i.test(pathPart);
}

/** Resolve `./`/`../` segments in a creation target against the source folder.
 * Returns a vault-relative folder-qualified name, or null if it escapes root. */
function normalizeCreateTarget(target: string, sourceRel: string | null): string | null {
  const segments = target.split(/[/\\]/);
  if (!segments.some((s) => s === "." || s === "..")) return target;
  const srcFolder = (sourceRel ?? "").split(/[/\\]/).slice(0, -1);
  const stack = [...srcFolder];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.join("/");
}

export default function App() {
  const [vault, setVault] = useState<string | null>(null);
  const [notes, setNotes] = useState<VaultNote[]>([]);
  const [active, setActive] = useState<ActiveNote | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // indexVersion bumps on every index change (incl. local saves) — graph etc.
  // structureVersion bumps only when OTHER notes change (external edits,
  // rescans, reloads) — backlinks of the active note can't change on its own
  // save, so the backlinks memo keys off this cheaper counter.
  const [indexVersion, setIndexVersion] = useState(0);
  const [structureVersion, setStructureVersion] = useState(0);
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  const [modal, setModal] = useState<ModalKind>(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphMode, setGraphMode] = useState<"global" | "local">("global");

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
  // rel -> exact content Basalt last wrote there. The watcher echo of our own
  // save is identified by CONTENT (not a time window), so a real external edit
  // arriving right after a save is never silently swallowed.
  const selfWrites = useRef<Map<string, string>>(new Map());
  // Accumulated external changes (rel -> absolute path), flushed after a debounce.
  const changedBuf = useRef<Map<string, string>>(new Map());
  const watchTimer = useRef<number | undefined>(undefined);
  const rescanTimer = useRef<number | undefined>(undefined);
  // Resolves once the event listeners are active, so we never start the
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
  const bumpStructure = useCallback(() => {
    setIndexVersion((v) => v + 1);
    setStructureVersion((v) => v + 1);
  }, []);

  const loadVault = useCallback(async () => {
    const list = await readVault();
    index.current.build(list);
    setNotes(list);
    bumpStructure();
    return list;
  }, [bumpStructure]);

  const rememberSelfWrite = useCallback((rel: string, content: string) => {
    selfWrites.current.delete(rel); // re-insert so eviction order is least-recent
    selfWrites.current.set(rel, content);
    if (selfWrites.current.size > SELF_WRITES_MAX) {
      const oldest = selfWrites.current.keys().next().value;
      if (oldest !== undefined) selfWrites.current.delete(oldest);
    }
  }, []);

  const flushSave = useCallback(
    async (path: string, doc: string) => {
      setSaving(true);
      try {
        await writeNote(path, doc);
        setSaveError(null);
        const meta = notesRef.current.find((n) => n.path === path);
        if (meta) {
          // Record AFTER a successful write (a failed write leaves no stale
          // suppression), keyed by the rel + content the watcher will see.
          rememberSelfWrite(meta.rel, doc);
          const updated: VaultNote = { ...meta, content: doc };
          index.current.setNote(updated);
          setNotes((prev) => prev.map((n) => (n.path === path ? updated : n)));
          bumpIndex();
        }
        if (path === activePathRef.current) setChangedOnDisk(false);
      } catch (e) {
        // Keep the edit pending (retried on the next change/flush) and say so —
        // a failed write must never show "Saved".
        pending.current = { path, doc };
        setSaveError(String(e));
      } finally {
        setSaving(false);
      }
    },
    [bumpIndex, rememberSelfWrite],
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
    async (path: string, line?: number) => {
      if (path === activePathRef.current) {
        if (line !== undefined) {
          setActive((a) => (a && a.path === path && a.scrollToLine !== line ? { ...a, scrollToLine: line } : a));
        }
        return;
      }
      await flushPending();
      const doc = await readNote(path);
      setChangedOnDisk(false);
      setActive({ path, doc, scrollToLine: line });
    },
    [flushPending],
  );

  const openVault = useCallback(
    async (path: string) => {
      await flushPending();
      clearImageCache();
      const root = await openVaultBackend(path); // canonical; sets managed state
      setVault(root);
      localStorage.setItem(LAST_VAULT_KEY, root);
      setActive(null);
      setChangedOnDisk(false);
      selfWrites.current.clear();
      await loadVault();
      await listenerReady.current?.promise; // ensure we can hear events first
      startWatching().catch(() => {
        /* watcher unavailable — degrade gracefully */
      });
    },
    [flushPending, loadVault],
  );

  // Restore the last vault on launch (once — StrictMode double-mounts effects).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const last = localStorage.getItem(LAST_VAULT_KEY);
    if (last) {
      openVault(last).catch(() => localStorage.removeItem(LAST_VAULT_KEY));
    }
  }, [openVault]);

  // Apply a batch of external (on-disk) changes, matched by vault-relative path.
  const processChanges = useCallback(
    async (changes: ChangedNote[]) => {
      if (!vaultRef.current) return;
      const byRel = new Map(notesRef.current.map((n) => [n.rel, n]));
      const prevByRel = new Map(notesRef.current.map((n) => [n.rel, n.content]));

      const reads = await Promise.all(
        changes.map(async (c) => {
          const existing = byRel.get(c.rel);
          const absPath = existing?.path ?? c.path;
          try {
            return { rel: c.rel, path: absPath, content: await readNote(absPath), ok: true as const };
          } catch {
            return { rel: c.rel, path: absPath, content: "", ok: false as const };
          }
        }),
      );

      // Drop echoes of our own writes: disk content equals what we last wrote.
      // Do NOT consume the entry on match — one save can produce several event
      // bursts (our rename + iCloud's own touches), and every echo must match.
      // The entry is replaced by the next save or evicted by the size cap.
      const results = reads.filter(
        (r) => !(r.ok && selfWrites.current.get(r.rel) === r.content),
      );
      if (results.length === 0) {
        jsLog("processChanges: all echoes of our own writes, skipped");
        return;
      }
      jsLog(`processChanges: applying ${results.length} external change(s)`);

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
      bumpStructure();

      // Reconcile the open note per the conflict policy.
      const activeRel = activeRelRef.current;
      const activePath = activePathRef.current;
      if (!activeRel || !activePath) return;
      const open = results.find((r) => r.rel === activeRel);
      if (!open) return;
      // A content-identical "change" (mtime touch, sync-client noise) is a
      // no-op — it must never raise a conflict, even while the user is typing.
      if (open.ok && open.content === prevByRel.get(activeRel)) {
        jsLog("reconcile: open note unchanged (no-op)");
        return;
      }
      const dirty = pending.current?.path === activePath;
      if (!open.ok) {
        jsLog(`reconcile: open note deleted on disk (dirty=${dirty})`);
        if (dirty) setChangedOnDisk(true);
        else setActive(null);
        return;
      }
      if (dirty) {
        jsLog("reconcile: open note changed while dirty -> conflict badge");
        setChangedOnDisk(true);
        return;
      }
      jsLog("reconcile: reloading editor with external content");
      // Update content in-place (EditorPane reconciles, preserving the caret).
      setActive({ path: activePath, doc: open.content });
    },
    [bumpStructure],
  );

  // Full-index rescan (folder rename/delete — the watcher can't enumerate the
  // affected notes, so reload everything and reconcile the open note).
  const handleRescan = useCallback(async () => {
    if (!vaultRef.current) return;
    const activePath = activePathRef.current;
    const prevContent = activePath
      ? notesRef.current.find((n) => n.path === activePath)?.content
      : undefined;
    const list = await loadVault();
    changedBuf.current.clear(); // the reload covered anything still buffered
    if (!activePath) return;
    const still = list.find((n) => n.path === activePath);
    const dirty = pending.current?.path === activePath;
    if (!still) {
      if (dirty) setChangedOnDisk(true);
      else setActive(null);
      return;
    }
    if (!dirty && prevContent !== undefined && still.content !== prevContent) {
      setActive({ path: activePath, doc: still.content });
    }
  }, [loadVault]);

  // Listen for on-disk changes; debounce; then apply.
  useEffect(() => {
    let cancelled = false;
    let unlistenChanged: (() => void) | undefined;
    let unlistenRescan: (() => void) | undefined;
    (async () => {
      try {
        const u1 = await listen<ChangedNote[]>("vault-changed", (event) => {
          jsLog(`vault-changed: ${event.payload.length} note(s)`);
          for (const c of event.payload) changedBuf.current.set(c.rel, c.path);
          if (changedBuf.current.size === 0) return;
          window.clearTimeout(watchTimer.current);
          watchTimer.current = window.setTimeout(() => {
            const changes = Array.from(changedBuf.current, ([rel, path]) => ({ rel, path }));
            changedBuf.current.clear();
            void processChanges(changes);
          }, 300);
        });
        if (cancelled) {
          u1();
          return;
        }
        unlistenChanged = u1;
        jsLog("vault-changed listener registered");
        const u2 = await listen("vault-rescan", () => {
          jsLog("vault-rescan received");
          window.clearTimeout(rescanTimer.current);
          rescanTimer.current = window.setTimeout(() => {
            void handleRescan();
          }, 300);
        });
        if (cancelled) {
          u2();
          return;
        }
        unlistenRescan = u2;
        jsLog("vault-rescan listener registered");
      } catch (e) {
        jsLog(`LISTENER REGISTRATION FAILED: ${e}`);
        console.error("[basalt] listen failed", e);
        setSaveError(`Event listeners failed: ${e}`);
      } finally {
        listenerReady.current?.resolve();
      }
    })();
    return () => {
      cancelled = true;
      unlistenChanged?.();
      unlistenRescan?.();
    };
  }, [processChanges, handleRescan]);

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

  // Quick switcher (Cmd/Ctrl-O) and vault search (Cmd/Ctrl-Shift-F).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !vaultRef.current) return;
      const k = e.key.toLowerCase();
      if (k === "o" && !e.shiftKey) {
        e.preventDefault();
        setModal("switcher");
      } else if (k === "f" && e.shiftKey) {
        e.preventDefault();
        setModal("search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleOpenVault = useCallback(async () => {
    const picked = await pickVault();
    if (picked) await openVault(picked);
  }, [openVault]);

  // Conflict resolution: take the on-disk version, discarding local edits.
  const handleReloadFromDisk = useCallback(async () => {
    const path = activePathRef.current;
    if (!path) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    pending.current = null;
    setChangedOnDisk(false);
    try {
      const doc = await readNote(path);
      setActive({ path, doc });
    } catch {
      setActive(null);
    }
  }, []);

  // Conflict resolution: keep local edits, overwriting the on-disk version.
  const handleKeepMine = useCallback(async () => {
    // If the note vanished from the vault (deleted/moved externally), don't
    // recreate it at a stale path from here.
    const path = activePathRef.current;
    if (path && !notesRef.current.some((n) => n.path === path)) {
      setChangedOnDisk(false);
      setActive(null);
      pending.current = null;
      return;
    }
    setChangedOnDisk(false);
    await flushPending();
  }, [flushPending]);

  const getNotes = useCallback(() => notesRef.current.map((n) => n.name), []);

  const handleOpenUrl = useCallback((url: string) => {
    void openUrl(url).catch(() => {
      /* opener unavailable or blocked URL — ignore */
    });
  }, []);

  const handleResolveImage = useCallback((target: string) => {
    if (!vaultRef.current) return Promise.resolve(null);
    return resolveImage(target, activeRelRef.current ?? "");
  }, []);

  /** Create a note (folder-qualified ok) and open it, updating the index
   * incrementally — no full-vault reload. */
  const createAndOpen = useCallback(
    async (name: string) => {
      const root = vaultRef.current;
      if (!root) return;
      await flushPending();
      const path = await createNote(name);
      const rel = path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]+/, "") : path;
      const note: VaultNote = { path, rel, name: nameFromRel(rel), content: "" };
      index.current.setNote(note);
      setNotes((prev) =>
        [...prev, note].sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase())),
      );
      rememberSelfWrite(rel, "");
      bumpStructure();
      await openNoteByPath(path);
    },
    [flushPending, openNoteByPath, rememberSelfWrite, bumpStructure],
  );

  const handleOpenWikilink = useCallback(
    async (target: string) => {
      const resolved = index.current.resolve(target, activePathRef.current ?? "");
      if (resolved) {
        await openNoteByPath(resolved);
        return;
      }
      const pathPart = targetPathPart(target);
      // Never auto-create a junk "Report.pdf.md" for an attachment link.
      if (!pathPart || isAttachmentTarget(pathPart)) return;
      const name = normalizeCreateTarget(pathPart, activeRelRef.current);
      if (!name) return; // relative target escaping the vault root
      try {
        await createAndOpen(name);
      } catch (e) {
        setSaveError(`Couldn't create note: ${e}`);
      }
    },
    [openNoteByPath, createAndOpen],
  );

  const handleNewNote = useCallback(async () => {
    if (!vaultRef.current) return;
    const existing = new Set(notesRef.current.map((n) => normalizeName(n.name)));
    let name = "Untitled";
    let i = 1;
    while (existing.has(normalizeName(name))) name = `Untitled ${i++}`;
    try {
      await createAndOpen(name);
    } catch (e) {
      setSaveError(`Couldn't create note: ${e}`);
    }
  }, [createAndOpen]);

  const activeNote = useMemo(
    () => (active ? (notes.find((n) => n.path === active.path) ?? null) : null),
    [active, notes],
  );
  const activeName = activeNote?.name ?? null;
  activeRelRef.current = activeNote?.rel ?? null;

  // Backlinks of the active note can only change when OTHER notes change, so
  // this keys off structureVersion — a local autosave doesn't re-resolve the vault.
  const backlinks = useMemo(() => {
    if (!active) return [];
    return index.current.backlinksFor(active.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, structureVersion]);

  // Expensive (full vault text scan). Recompute only when the active note
  // changes — not on every debounced save — to keep typing smooth.
  const unlinked = useMemo(() => {
    if (!activeName || !active) return [];
    return index.current.unlinkedMentionsFor(activeName, notesRef.current, active.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeName, active]);

  // Key the local graph on the active PATH (not the whole active object) so an
  // autosave or caret move doesn't rebuild the simulation.
  const graphKey = graphMode === "local" ? (active?.path ?? null) : null;
  const graphData = useMemo(() => {
    if (!graphOpen) return { nodes: [], links: [] };
    if (graphMode === "local" && graphKey) return index.current.localGraph(graphKey, 1);
    return index.current.graph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphOpen, graphMode, graphKey, indexVersion]);

  const handleOpenGraphNode = useCallback(
    (path: string) => {
      setGraphOpen(false);
      void openNoteByPath(path);
    },
    [openNoteByPath],
  );
  const handleCloseGraph = useCallback(() => setGraphOpen(false), []);

  // Esc closes the graph overlay.
  useEffect(() => {
    if (!graphOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGraphOpen(false);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [graphOpen]);

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
        onOpen={(path) => openNoteByPath(path)}
        onNewNote={handleNewNote}
      />
      <main className="main">
        <div className="toolbar">
          <button className="link-btn" onClick={handleOpenVault}>
            Change vault…
          </button>
          <button className="link-btn" onClick={() => setGraphOpen(true)} title="Graph view">
            Graph
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
          <span className={saveError ? "status status-error" : "status"} title={saveError ?? ""}>
            {saveError ? "⚠ Save failed — will retry" : saving ? "Saving…" : active ? "Saved" : ""}
          </span>
        </div>
        {active ? (
          <EditorPane
            key={active.path}
            path={active.path}
            doc={active.doc}
            scrollToLine={active.scrollToLine}
            getNotes={getNotes}
            onOpenWikilink={handleOpenWikilink}
            onOpenUrl={handleOpenUrl}
            resolveImage={handleResolveImage}
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
        onOpen={(path, line) => openNoteByPath(path, line)}
      />
      {modal === "switcher" && (
        <Palette<VaultNote>
          placeholder="Open note…"
          getItems={(q) => fuzzyRank(q, notesRef.current, (n) => [n.name, n.rel])}
          itemKey={(n) => n.path}
          renderItem={(n) => (
            <>
              <span className="palette-name">{n.name}</span>
              <span className="palette-sub">{n.rel}</span>
            </>
          )}
          onSelect={(n) => {
            setModal(null);
            openNoteByPath(n.path);
          }}
          onClose={() => setModal(null)}
          emptyText="No notes"
        />
      )}
      {modal === "search" && (
        <Palette<SearchHit>
          placeholder="Search vault…"
          getItems={(q) => searchVault(notesRef.current, q)}
          itemKey={(h, i) => `${h.path}:${h.line}:${i}`}
          renderItem={(h) => (
            <>
              <span className="palette-name">
                {h.name} <span className="palette-line">:{h.line}</span>
              </span>
              <span className="palette-sub">{h.lineText}</span>
            </>
          )}
          onSelect={(h) => {
            setModal(null);
            openNoteByPath(h.path, h.line);
          }}
          onClose={() => setModal(null)}
          emptyText="Type to search"
        />
      )}
      {graphOpen && (
        <GraphView
          data={graphData}
          activePath={active?.path ?? null}
          mode={graphMode}
          onSetMode={setGraphMode}
          onOpenNode={handleOpenGraphNode}
          onClose={handleCloseGraph}
        />
      )}
    </div>
  );
}
