import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import {
  createNote,
  deleteNote,
  listAttachments,
  nameFromRel,
  renameNote,
  writeAttachment,
  openVaultBackend,
  pickVault,
  readNote,
  readVault,
  startWatching,
  writeNote,
  readObsidianConfig,
  readObsidianBookmarks,
  exportFile,
  type Attachment,
  type Bookmark,
  type ChangedNote,
  type ObsidianConfig,
  type VaultNote,
} from "./lib/vault";
import { VaultIndex } from "./lib/vaultIndex";
import { clearImageCache, resolveImage } from "./lib/assets";
import { normalizeName, targetPathPart } from "./lib/markdown";
import { Sidebar } from "./components/Sidebar";
import { EditorPane } from "./components/EditorPane";
import { RightPanel, type RightTab } from "./components/RightPanel";
import { TabBar, type TabItem } from "./components/TabBar";
import { PaneTree } from "./components/PaneTree";
import { ReadingView } from "./components/ReadingView";
import { CanvasView } from "./components/CanvasView";
import { renderMarkdown } from "./lib/render";
import { renderMermaid } from "./lib/mermaid";
import { buildHtmlDocument } from "./lib/export";
import {
  type LayoutNode,
  type Dir,
  firstLeafId,
  leafIds,
  removeLeaf,
  setSizes,
  splitLeaf,
} from "./lib/workspace";
import { GraphView } from "./components/GraphView";
import { Palette } from "./components/Palette";
import { PromptModal } from "./components/PromptModal";
import { SettingsModal } from "./components/SettingsModal";
import {
  applyResolvedTheme,
  applyThemeMode,
  loadThemeMode,
  saveThemeMode,
  watchSystemTheme,
  type ThemeMode,
} from "./lib/theme";
import { linkTargetForFormat, rewriteLinks } from "./lib/rename";
import { looksLikeAttachment, resolveAttachment } from "./lib/attachments";
import { fillTemplate, formatMoment, UnsupportedTokenError } from "./lib/daily";
import type { LinkFormat } from "./lib/rename";
import { fuzzyRank } from "./lib/fuzzy";
import { searchVault, type SearchHit } from "./lib/search";
import "./styles.css";

const LAST_VAULT_KEY = "basalt.lastVault";

// Mirrors a frontend diagnostic into the dev terminal (used for failures that
// must never be silently swallowed).
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

/** One editor pane: its own tab set, the live (active) note, and that note's
 * loaded content. Multiple panes = multiple independently-live editors. */
interface Pane {
  id: string;
  tabs: string[]; // open note paths, in tab order
  active: string | null; // the live note path
  doc: string; // content of the active note (initial/reconciled for its editor)
  scrollToLine?: number;
}

type ModalKind = "switcher" | "search" | "commands" | "settings" | null;

interface AppCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

const RECENT_MAX = 50;
const recentKey = (vault: string) => `basalt.recent.${vault}`;
const rightTabKey = (vault: string) => `basalt.rightTab.${vault}`;
const workspaceKey = (vault: string) => `basalt.workspace.${vault}`;

/** The serializable shape of a workspace (no live doc — restored from disk). */
interface SavedWorkspace {
  layout: LayoutNode;
  panes: Record<string, { tabs: string[]; active: string | null }>;
  focusedId: string | null;
}

function loadRecents(vault: string): string[] {
  try {
    const raw = localStorage.getItem(recentKey(vault));
    if (raw) return JSON.parse(raw) as string[];
  } catch {
    /* ignore */
  }
  return [];
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Markdown notes are editable + indexed; other openable files (.canvas) are
 * read-only viewers — autosave/conflict logic must skip them. */
const isMarkdownPath = (p: string) => /\.md$/i.test(p);

/** Mirror of the Rust build_note_path sanitization, so frontend existence
 * lookups agree with the filename the backend will actually create. */
function sanitizeNoteRel(relNoExt: string): string {
  return relNoExt
    .split(/[/\\]/)
    .map((seg) =>
      seg
        .replace(/[:*?"<>|\u0000-\u001f]/g, "")
        .trim()
        .replace(/\.+$/, ""),
    )
    .filter(Boolean)
    .join("/");
}

const normRelKey = (rel: string) => rel.replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();

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
  const [attachmentsList, setAttachmentsList] = useState<Attachment[]>([]);
  // Split-pane workspace: a layout tree of panes (by id), the panes map, and
  // which pane has focus (drives the right panel / toolbar / open targets).
  const [panes, setPanes] = useState<Record<string, Pane>>({});
  const [layout, setLayout] = useState<LayoutNode | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // indexVersion bumps on every index change (incl. local saves) — graph etc.
  // structureVersion bumps only when OTHER notes change (external edits,
  // rescans, reloads) — backlinks of the active note can't change on its own
  // save, so the backlinks memo keys off this cheaper counter.
  const [indexVersion, setIndexVersion] = useState(0);
  const [structureVersion, setStructureVersion] = useState(0);
  // Paths with an unresolved on-disk conflict (per note, since panes may each
  // hold a different dirty note). The badge shows for the focused note.
  const [conflicts, setConflicts] = useState<Set<string>>(() => new Set());
  const [modal, setModal] = useState<ModalKind>(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphMode, setGraphMode] = useState<"global" | "local">("global");
  const [sourceMode, setSourceMode] = useState(false);
  // Reading view: a rendered, read-only HTML view (vs the editable CM6 panes).
  const [readingMode, setReadingMode] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadThemeMode);
  // The CONCRETE theme (after resolving "system"), used to flip the editor's
  // dark flag. Seeded from the data-theme the no-flash script already applied.
  const [dark, setDark] = useState<boolean>(
    () => document.documentElement.dataset.theme !== "light",
  );
  const [rightTab, setRightTab] = useState<RightTab>("backlinks");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  // Seeds the search palette when opened from a tag / search bookmark.
  const [searchSeed, setSearchSeed] = useState("");
  const [fileMenu, setFileMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ path: string; rel: string } | null>(null);

  const index = useRef(new VaultIndex());
  const vaultRef = useRef<string | null>(null);
  vaultRef.current = vault;
  const notesRef = useRef<VaultNote[]>([]);
  notesRef.current = notes;
  const attachmentsRef = useRef<Attachment[]>([]);
  attachmentsRef.current = attachmentsList;
  // Read-only .obsidian settings (link format, daily notes, attachment folder).
  const obsConfigRef = useRef<ObsidianConfig | null>(null);

  // Workspace refs (read in callbacks/watcher without re-subscribing).
  const panesRef = useRef<Record<string, Pane>>({});
  panesRef.current = panes;
  const layoutRef = useRef<LayoutNode | null>(null);
  layoutRef.current = layout;
  const focusedIdRef = useRef<string | null>(null);
  focusedIdRef.current = focusedId;
  const paneCounter = useRef(0);

  // The FOCUSED pane and its active note — the "current note" for the right
  // panel, toolbar, image resolution, and where openNoteByPath targets.
  const focusedPane = focusedId ? (panes[focusedId] ?? null) : null;
  const active: ActiveNote | null =
    focusedPane && focusedPane.active
      ? { path: focusedPane.active, doc: focusedPane.doc, scrollToLine: focusedPane.scrollToLine }
      : null;
  const changedOnDisk = !!(active && conflicts.has(active.path));
  // A focused .canvas is a read-only viewer, not an editable note: the toolbar,
  // outline, export/print, and reading/source toggles must not treat it as one.
  const activeIsCanvas = !!active && /\.canvas$/i.test(active.path);

  const activePathRef = useRef<string | null>(null);
  activePathRef.current = active?.path ?? null;
  // The active note's vault-relative path — the key the watcher matches on.
  const activeRelRef = useRef<string | null>(null);
  const conflictsRef = useRef<Set<string>>(conflicts);
  conflictsRef.current = conflicts;
  // Per-note pending edit (path -> latest doc) and per-note debounce timers —
  // panes may each have a different unsaved note, so saving is keyed by path.
  const saveTimers = useRef<Map<string, number>>(new Map());
  const pending = useRef<Map<string, string>>(new Map());
  // Most-recently-opened rels (per vault) — orders the blank-query switcher.
  const recents = useRef<string[]>([]);
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
    const [list, atts] = await Promise.all([readVault(), listAttachments()]);
    index.current.build(list);
    setNotes(list);
    setAttachmentsList(atts);
    bumpStructure();
    return { notes: list, attachments: atts };
  }, [bumpStructure]);

  const rememberSelfWrite = useCallback((rel: string, content: string) => {
    selfWrites.current.delete(rel); // re-insert so eviction order is least-recent
    selfWrites.current.set(rel, content);
    if (selfWrites.current.size > SELF_WRITES_MAX) {
      const oldest = selfWrites.current.keys().next().value;
      if (oldest !== undefined) selfWrites.current.delete(oldest);
    }
  }, []);

  // Conflict helpers also mutate conflictsRef synchronously so same-tick reads
  // (e.g. closeTab's guard right after resolving) see the new state.
  const clearConflict = useCallback((path: string) => {
    if (conflictsRef.current.has(path)) {
      const n = new Set(conflictsRef.current);
      n.delete(path);
      conflictsRef.current = n;
    }
    setConflicts((c) => {
      if (!c.has(path)) return c;
      const n = new Set(c);
      n.delete(path);
      return n;
    });
  }, []);
  const addConflict = useCallback((path: string) => {
    if (!conflictsRef.current.has(path)) {
      conflictsRef.current = new Set(conflictsRef.current).add(path);
    }
    setConflicts((c) => (c.has(path) ? c : new Set(c).add(path)));
  }, []);

  // Update one pane's state (and keep panesRef in sync for same-tick reads).
  const patchPane = useCallback((id: string, patch: Partial<Pane>) => {
    setPanes((ps) => (ps[id] ? { ...ps, [id]: { ...ps[id], ...patch } } : ps));
    if (panesRef.current[id]) {
      panesRef.current = { ...panesRef.current, [id]: { ...panesRef.current[id], ...patch } };
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
        // `pending` is held until the write SUCCEEDS (not deleted before the
        // await), so an external edit landing mid-write still sees this note as
        // dirty and raises a conflict rather than being silently overwritten.
        if (conflictsRef.current.has(path)) {
          // A conflict was raised during the write — keep the local content for
          // Keep-mine and leave the badge up; don't mark this saved.
          if (!pending.current.has(path)) pending.current.set(path, doc);
        } else if (pending.current.get(path) === doc) {
          // No newer edit arrived during the write: fully saved.
          pending.current.delete(path);
          const t = saveTimers.current.get(path);
          if (t !== undefined) {
            window.clearTimeout(t);
            saveTimers.current.delete(path);
          }
        }
      } catch (e) {
        // Keep the edit pending — but never clobber a NEWER edit typed during
        // the failed write.
        if (!pending.current.has(path)) pending.current.set(path, doc);
        setSaveError(String(e));
      } finally {
        setSaving(false);
      }
    },
    [bumpIndex, rememberSelfWrite],
  );

  // Debounced per-note autosave. `pending`/`saveTimers` are keyed by note PATH
  // (one source of truth per note); when the same note is live in more than one
  // pane, the OTHER panes are reconciled to this edit so they never diverge or
  // collide (shared-document semantics). `paneId` is the pane that fired.
  const handleChange = useCallback(
    (paneId: string, path: string, doc: string) => {
      if (!path || !isMarkdownPath(path)) return; // read-only viewers don't autosave
      pending.current.set(path, doc);
      for (const p of Object.values(panesRef.current)) {
        if (p.id !== paneId && p.active === path) patchPane(p.id, { doc });
      }
      const existing = saveTimers.current.get(path);
      if (existing !== undefined) window.clearTimeout(existing);
      saveTimers.current.set(
        path,
        window.setTimeout(() => {
          saveTimers.current.delete(path);
          // Don't auto-overwrite a note with an unresolved disk conflict.
          if (conflictsRef.current.has(path)) return;
          const d = pending.current.get(path);
          if (d === undefined) return;
          flushSave(path, d); // flushSave deletes `pending` only on success
        }, SAVE_DEBOUNCE_MS),
      );
    },
    [flushSave, patchPane],
  );

  // Flush ONE note's pending edit. While a conflict is unresolved, refuse unless
  // `force` (the explicit Keep-mine) — the pending edit and badge survive.
  const flushPath = useCallback(
    async (path: string, force = false) => {
      const t = saveTimers.current.get(path);
      if (t !== undefined) {
        window.clearTimeout(t);
        saveTimers.current.delete(path);
      }
      if (conflictsRef.current.has(path) && !force) return;
      const doc = pending.current.get(path);
      if (doc === undefined) return;
      await flushSave(path, doc); // flushSave deletes `pending` on success
    },
    [flushSave],
  );

  // Flush EVERY pending note (app close / vault switch / focus loss). Respects
  // conflicts unless forced.
  const flushAll = useCallback(
    async (force = false) => {
      for (const path of Array.from(pending.current.keys())) await flushPath(path, force);
    },
    [flushPath],
  );

  // Ensure there is a focused pane; create the first one if the workspace is
  // empty. Refs are updated synchronously so an immediate open finds the pane.
  const ensureWorkspace = useCallback((): string => {
    const cur = focusedIdRef.current;
    if (cur && panesRef.current[cur]) return cur;
    const id = `pane${(paneCounter.current += 1)}`;
    const pane: Pane = { id, tabs: [], active: null, doc: "" };
    const lay: LayoutNode = { kind: "leaf", id };
    panesRef.current = { ...panesRef.current, [id]: pane };
    layoutRef.current = lay;
    focusedIdRef.current = id;
    setPanes((ps) => ({ ...ps, [id]: pane }));
    setLayout(lay);
    setFocusedId(id);
    return id;
  }, []);

  const focusPane = useCallback((id: string) => {
    if (focusedIdRef.current === id) return;
    focusedIdRef.current = id;
    setFocusedId(id);
  }, []);

  // Remove a pane from the layout (its last tab closed). Focus a neighbor.
  const removePaneFromWorkspace = useCallback((id: string) => {
    const next = layoutRef.current ? removeLeaf(layoutRef.current, id) : null;
    const nextFocus =
      focusedIdRef.current === id ? (next ? firstLeafId(next) : null) : focusedIdRef.current;
    layoutRef.current = next;
    focusedIdRef.current = nextFocus;
    const np = { ...panesRef.current };
    delete np[id];
    panesRef.current = np;
    setLayout(next);
    setFocusedId(nextFocus);
    setPanes((ps) => {
      const n = { ...ps };
      delete n[id];
      return n;
    });
  }, []);

  // Open `path` in a specific pane (adds the tab, loads the doc, focuses it).
  const openInPane = useCallback(
    async (id: string, path: string, line?: number) => {
      const pane = panesRef.current[id];
      if (!pane) return;
      focusPane(id);
      if (pane.active === path) {
        if (line !== undefined) patchPane(id, { scrollToLine: line });
        return;
      }
      if (pane.active && conflictsRef.current.has(pane.active)) {
        setSaveError("Resolve the “Changed on disk” conflict (Reload or Keep mine) first");
        return;
      }
      if (pane.active) await flushPath(pane.active);
      let doc: string;
      try {
        doc = await readNote(path);
      } catch (e) {
        setSaveError(`Couldn't open note: ${e}`);
        return;
      }
      setSaveError(null);
      const tabs = pane.tabs.includes(path) ? pane.tabs : [...pane.tabs, path];
      patchPane(id, { tabs, active: path, doc, scrollToLine: line });
      const rel = notesRef.current.find((n) => n.path === path)?.rel;
      const v = vaultRef.current;
      if (rel && v) {
        recents.current = [rel, ...recents.current.filter((r) => r !== rel)].slice(0, RECENT_MAX);
        try {
          localStorage.setItem(recentKey(v), JSON.stringify(recents.current));
        } catch {
          /* ignore */
        }
      }
    },
    [flushPath, focusPane, patchPane],
  );

  // Open a note in the FOCUSED pane (creating the first pane if needed). The
  // sidebar / switcher / backlinks all route through here.
  const openNoteByPath = useCallback(
    async (path: string, line?: number) => {
      const id = ensureWorkspace();
      await openInPane(id, path, line);
    },
    [ensureWorkspace, openInPane],
  );

  // User-initiated close of one pane's tab. Saves first; blocks while that note
  // has an unresolved conflict; removes the pane when its last tab closes.
  const closeTab = useCallback(
    async (id: string, path: string) => {
      const pane = panesRef.current[id];
      if (!pane) return;
      const isActive = pane.active === path;
      if (isActive && conflictsRef.current.has(path)) {
        setSaveError("Resolve the “Changed on disk” conflict before closing this note");
        return;
      }
      if (isActive) await flushPath(path);
      const idx = pane.tabs.indexOf(path);
      const tabs = pane.tabs.filter((p) => p !== path);
      if (tabs.length === 0) {
        removePaneFromWorkspace(id);
        return;
      }
      if (!isActive) {
        patchPane(id, { tabs });
        return;
      }
      const neighbor = tabs[idx] ?? tabs[idx - 1] ?? null;
      let doc = "";
      if (neighbor) {
        try {
          doc = await readNote(neighbor);
        } catch {
          doc = "";
        }
      }
      patchPane(id, { tabs, active: neighbor, doc, scrollToLine: undefined });
    },
    [flushPath, patchPane, removePaneFromWorkspace],
  );

  // Split the focused pane along `dir`, opening the same note in the new pane
  // (Obsidian opens the current note in the split).
  const splitFocused = useCallback(
    (dir: Dir) => {
      const id = focusedIdRef.current;
      const lay = layoutRef.current;
      if (!id || !lay) return;
      const src = panesRef.current[id];
      const newId = `pane${(paneCounter.current += 1)}`;
      const active = src?.active ?? null;
      const newPane: Pane = {
        id: newId,
        tabs: active ? [active] : [],
        active,
        // Carry the live (unsaved) content, not just the last-loaded doc.
        doc: active ? (pending.current.get(active) ?? src?.doc ?? "") : "",
        scrollToLine: src?.scrollToLine,
      };
      const nextLayout = splitLeaf(lay, id, newId, dir);
      panesRef.current = { ...panesRef.current, [newId]: newPane };
      layoutRef.current = nextLayout;
      focusedIdRef.current = newId;
      setPanes((ps) => ({ ...ps, [newId]: newPane }));
      setLayout(nextLayout);
      setFocusedId(newId);
    },
    [],
  );

  // Rebuild the saved tab/split layout for a vault. Tabs pointing at notes that
  // no longer exist are dropped; emptied panes are removed; active docs are
  // loaded from disk. Any malformed state silently leaves the workspace empty.
  const restoreWorkspace = useCallback(
    async (savedWs: string | null, list: VaultNote[], atts: Attachment[]) => {
      if (!savedWs) return;
      let ws: SavedWorkspace;
      try {
        ws = JSON.parse(savedWs) as SavedWorkspace;
        if (!ws.layout || !ws.panes) return;
      } catch {
        return;
      }
      // Notes AND attachments (.canvas) are valid tab paths.
      const exists = new Set([...list.map((n) => n.path), ...atts.map((a) => a.path)]);
      let ids: string[];
      try {
        ids = leafIds(ws.layout);
      } catch {
        return;
      }
      const rebuilt: Record<string, Pane> = {};
      let maxN = 0;
      for (const id of ids) {
        const saved = ws.panes[id];
        const m = /(\d+)$/.exec(id);
        if (m) maxN = Math.max(maxN, Number(m[1]));
        const tabs = (saved?.tabs ?? []).filter((p) => exists.has(p));
        if (tabs.length === 0) continue; // pane will be pruned from the layout
        const active = saved?.active && tabs.includes(saved.active) ? saved.active : tabs[0];
        let doc = "";
        try {
          doc = await readNote(active);
        } catch {
          doc = "";
        }
        rebuilt[id] = { id, tabs, active, doc };
      }
      // Drop layout leaves with no surviving pane.
      let lay: LayoutNode | null = ws.layout;
      for (const id of ids) if (!rebuilt[id] && lay) lay = removeLeaf(lay, id);
      if (!lay || Object.keys(rebuilt).length === 0) return; // nothing to restore
      const focus =
        ws.focusedId && rebuilt[ws.focusedId] ? ws.focusedId : firstLeafId(lay);
      paneCounter.current = Math.max(paneCounter.current, maxN);
      panesRef.current = rebuilt;
      layoutRef.current = lay;
      focusedIdRef.current = focus;
      setPanes(rebuilt);
      setLayout(lay);
      setFocusedId(focus);
    },
    [],
  );

  const openVault = useCallback(
    async (path: string) => {
      await flushAll();
      clearImageCache();
      const root = await openVaultBackend(path); // canonical; sets managed state
      // Read the saved workspace NOW (before any state reset fires the save
      // effect and overwrites it) so it survives until restore below.
      const savedWs = localStorage.getItem(workspaceKey(root));
      recents.current = loadRecents(root);
      obsConfigRef.current = await readObsidianConfig().catch(() => null);
      setBookmarks(await readObsidianBookmarks().catch(() => []));
      const savedTab = localStorage.getItem(rightTabKey(root));
      setRightTab(
        savedTab === "outline" || savedTab === "tags" || savedTab === "bookmarks"
          ? savedTab
          : "backlinks",
      );
      setSourceMode(localStorage.getItem(`basalt.sourceMode.${root}`) === "1");
      setReadingMode(localStorage.getItem(`basalt.reading.${root}`) === "1");
      setVault(root);
      localStorage.setItem(LAST_VAULT_KEY, root);
      // Reset the workspace for the new vault.
      panesRef.current = {};
      layoutRef.current = null;
      focusedIdRef.current = null;
      setPanes({});
      setLayout(null);
      setFocusedId(null);
      setConflicts(new Set());
      pending.current.clear();
      saveTimers.current.forEach((t) => window.clearTimeout(t));
      saveTimers.current.clear();
      selfWrites.current.clear();
      // Empty the stale note list immediately — the old vault's entries must not
      // be clickable while the new vault loads.
      setNotes([]);
      index.current.build([]);
      const { notes: list, attachments: atts } = await loadVault();
      await restoreWorkspace(savedWs, list, atts);
      await listenerReady.current?.promise; // ensure we can hear events first
      startWatching().catch(() => {
        /* watcher unavailable — degrade gracefully */
      });
    },
    [flushAll, loadVault, restoreWorkspace],
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

  // Persist the workspace (layout + tabs + active + focus, NOT live docs) per
  // vault. Keyed on the structural projection so per-keystroke doc syncs don't
  // write; restored on the next openVault.
  const lastSavedWs = useRef<string>("");
  useEffect(() => {
    const v = vaultRef.current;
    if (!v) return;
    const projected: SavedWorkspace["panes"] = {};
    for (const [id, p] of Object.entries(panes)) projected[id] = { tabs: p.tabs, active: p.active };
    const json = JSON.stringify({ layout, panes: projected, focusedId });
    if (json === lastSavedWs.current) return;
    lastSavedWs.current = json;
    try {
      localStorage.setItem(workspaceKey(v), json);
    } catch {
      /* ignore */
    }
  }, [layout, panes, focusedId]);

  // Prune tabs whose note no longer exists (deleted/moved) across ALL panes; a
  // pane that empties is removed from the layout. A pane's active note is kept
  // even if gone WHILE it has an unresolved conflict (awaiting Reload/Keep mine).
  useEffect(() => {
    // Notes AND attachments (.canvas opens in a pane) are valid tab paths.
    const exists = new Set([...notes.map((n) => n.path), ...attachmentsList.map((a) => a.path)]);
    const conf = conflictsRef.current;
    const panesNow = panesRef.current;
    let changed = false;
    const nextPanes: Record<string, Pane> = {};
    const removeIds: string[] = [];
    // Panes whose active note was pruned and need a neighbor loaded from disk.
    const toLoad: { id: string; neighbor: string }[] = [];
    for (const [id, pane] of Object.entries(panesNow)) {
      const keep = pane.tabs.filter((p) => exists.has(p) || (p === pane.active && conf.has(p)));
      if (keep.length === pane.tabs.length) {
        nextPanes[id] = pane;
        continue;
      }
      changed = true;
      if (keep.length === 0) {
        removeIds.push(id);
        continue;
      }
      if (pane.active && !keep.includes(pane.active)) {
        // Active note gone. Show a placeholder until the neighbor's content is
        // read from DISK — never seed the editor from the in-memory notes list
        // (it's empty for oversized notes, which a stray keystroke would then
        // truncate on disk).
        const idx = pane.tabs.indexOf(pane.active);
        toLoad.push({ id, neighbor: keep[Math.min(idx, keep.length - 1)] });
        nextPanes[id] = { ...pane, tabs: keep, active: null, doc: "", scrollToLine: undefined };
      } else {
        nextPanes[id] = { ...pane, tabs: keep };
      }
    }
    if (!changed) return;
    let lay = layoutRef.current;
    for (const id of removeIds) {
      delete nextPanes[id];
      if (lay) lay = removeLeaf(lay, id);
    }
    let focus = focusedIdRef.current;
    if (focus && !nextPanes[focus]) focus = lay ? firstLeafId(lay) : null;
    panesRef.current = nextPanes;
    layoutRef.current = lay;
    focusedIdRef.current = focus;
    setPanes(nextPanes);
    setLayout(lay);
    setFocusedId(focus);
    for (const { id, neighbor } of toLoad) {
      void readNote(neighbor)
        .then((doc) => patchPane(id, { active: neighbor, doc, scrollToLine: undefined }))
        .catch(() => {
          /* neighbor gone too — the next prune pass handles it */
        });
    }
  }, [notes, attachmentsList, patchPane]);

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
      if (results.length === 0) return;

      for (const r of results) {
        if (r.ok) {
          index.current.setNote({ path: r.path, rel: r.rel, name: nameFromRel(r.rel), content: r.content });
        } else {
          selfWrites.current.delete(r.rel); // gone from disk: suppression is stale
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

      // Reconcile EVERY pane whose live note changed, per the conflict policy.
      for (const r of results) {
        // A content-identical "change" (mtime touch, sync noise) is a no-op — it
        // must never raise a conflict, even while the user is typing.
        if (r.ok && r.content === prevByRel.get(r.rel)) continue;
        const dirty = pending.current.has(r.path);
        if (!r.ok) {
          // Vanished from disk. If dirty, keep it open with a conflict badge
          // (the prune effect won't drop a conflicted active); else the prune
          // effect (notes now lack it) closes its tabs.
          if (dirty) addConflict(r.path);
          continue;
        }
        if (dirty) {
          addConflict(r.path);
          continue;
        }
        // Update content in every pane showing it (each EditorPane reconciles,
        // preserving its caret).
        for (const p of Object.values(panesRef.current)) {
          if (p.active === r.path) patchPane(p.id, { doc: r.content });
        }
      }
    },
    [bumpStructure, addConflict, patchPane],
  );

  // Full-index rescan (folder rename/delete — the watcher can't enumerate the
  // affected notes, so reload everything and reconcile the open note).
  const handleRescan = useCallback(async () => {
    if (!vaultRef.current) return;
    // Snapshot each pane's live note content before the reload.
    const prevByPath = new Map(notesRef.current.map((n) => [n.path, n.content]));
    const { notes: list, attachments: atts } = await loadVault();
    changedBuf.current.clear(); // the reload covered anything still buffered
    const byPath = new Map(list.map((n) => [n.path, n]));
    const attPaths = new Set(atts.map((a) => a.path));
    for (const p of Object.values(panesRef.current)) {
      if (!p.active) continue;
      // Canvas panes are read-only attachments (not in `notes`): re-read the file
      // so external edits show; if it's gone the prune effect closes the pane
      // (attachmentsList was just refreshed by loadVault).
      if (/\.canvas$/i.test(p.active)) {
        if (attPaths.has(p.active)) {
          const id = p.id;
          const prevDoc = p.doc;
          void readNote(p.active)
            .then((fresh) => {
              if (fresh !== prevDoc) patchPane(id, { doc: fresh });
            })
            .catch(() => {
              /* removed between listing and read — prune handles it */
            });
        }
        continue;
      }
      const still = byPath.get(p.active);
      const dirty = pending.current.has(p.active);
      if (!still) {
        if (dirty) addConflict(p.active); // keep + badge; else the prune effect drops it
        continue;
      }
      const prev = prevByPath.get(p.active);
      if (!dirty && prev !== undefined && still.content !== prev) {
        patchPane(p.id, { doc: still.content });
      }
    }
  }, [loadVault, addConflict, patchPane]);

  // Listen for on-disk changes; debounce; then apply.
  useEffect(() => {
    let cancelled = false;
    let unlistenChanged: (() => void) | undefined;
    let unlistenRescan: (() => void) | undefined;
    (async () => {
      try {
        const u1 = await listen<ChangedNote[]>("vault-changed", (event) => {
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
        const u2 = await listen("vault-rescan", () => {
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
      void flushAll();
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
          await flushAll();
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
  }, [flushAll]);

  // Quick switcher (Cmd/Ctrl-O) and vault search (Cmd/Ctrl-Shift-F).
  useEffect(() => {
    const isMac = /Mac/.test(navigator.platform);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // CodeMirror already handled it (e.g. mac Ctrl-o)
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || !vaultRef.current) return;
      const k = e.key.toLowerCase();
      if (k === "o" && !e.shiftKey) {
        e.preventDefault();
        setModal("switcher");
      } else if (k === "f" && e.shiftKey) {
        e.preventDefault();
        setSearchSeed("");
        setModal("search");
      } else if (k === "p" && !e.shiftKey) {
        e.preventDefault(); // also suppresses the webview's print dialog
        setModal("commands");
      } else if (e.key === ",") {
        e.preventDefault();
        setModal("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Tab keyboard (focused pane): Mod-W closes the active tab; Ctrl-Tab /
  // Ctrl-Shift-Tab cycle.
  useEffect(() => {
    const isMac = /Mac/.test(navigator.platform);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !vaultRef.current) return;
      const pane = focusedIdRef.current ? panesRef.current[focusedIdRef.current] : null;
      if (!pane || !pane.active) return;
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        void closeTab(pane.id, pane.active);
        return;
      }
      if (e.ctrlKey && e.key === "Tab" && pane.tabs.length > 1) {
        e.preventDefault();
        const cur = pane.tabs.indexOf(pane.active);
        const d = e.shiftKey ? -1 : 1;
        void openInPane(pane.id, pane.tabs[(cur + d + pane.tabs.length) % pane.tabs.length]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeTab, openInPane]);

  const handleOpenVault = useCallback(async () => {
    const picked = await pickVault();
    if (picked) await openVault(picked);
  }, [openVault]);

  // Conflict resolution (focused pane): take the on-disk version, discarding
  // local edits.
  const handleReloadFromDisk = useCallback(async () => {
    const id = focusedIdRef.current;
    const path = id ? panesRef.current[id]?.active : null;
    if (!id || !path) return;
    const t = saveTimers.current.get(path);
    if (t !== undefined) {
      window.clearTimeout(t);
      saveTimers.current.delete(path);
    }
    pending.current.delete(path);
    clearConflict(path);
    try {
      const doc = await readNote(path);
      // Sync every pane showing this note to the on-disk version.
      for (const p of Object.values(panesRef.current)) {
        if (p.active === path) patchPane(p.id, { doc, scrollToLine: undefined });
      }
    } catch {
      void closeTab(id, path); // vanished — close its tab
    }
  }, [clearConflict, patchPane, closeTab]);

  // Conflict resolution (focused pane): keep local edits, overwriting disk.
  const handleKeepMine = useCallback(async () => {
    const id = focusedIdRef.current;
    const path = id ? panesRef.current[id]?.active : null;
    if (!id || !path) return;
    if (!notesRef.current.some((n) => n.path === path)) {
      // Vanished externally — don't recreate it at a stale path; just close it.
      pending.current.delete(path);
      clearConflict(path);
      void closeTab(id, path);
      return;
    }
    clearConflict(path);
    await flushPath(path, true); // explicit Keep-mine: write despite the conflict
  }, [clearConflict, flushPath, closeTab]);

  const getNotes = useCallback(
    () => notesRef.current.map((n) => ({ name: n.name, rel: n.rel })),
    [],
  );
  const getLinkFormat = useCallback((): LinkFormat => {
    const f = obsConfigRef.current?.newLinkFormat;
    return f === "relative" || f === "absolute" ? f : "shortest";
  }, []);

  // Persist + apply the chosen theme mode; keep `dark` (the resolved theme) in
  // sync so the editor's dark flag follows.
  useEffect(() => {
    saveThemeMode(themeMode);
    setDark(applyThemeMode(themeMode) === "dark");
  }, [themeMode]);
  // While on "system", track OS appearance changes live.
  useEffect(() => {
    if (themeMode !== "system") return;
    return watchSystemTheme((resolved) => {
      applyResolvedTheme(resolved);
      setDark(resolved === "dark");
    });
  }, [themeMode]);
  const toggleTheme = useCallback(() => {
    // Toolbar quick-toggle: pick the explicit opposite of what's showing.
    setThemeMode(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  }, []);

  const toggleSourceMode = useCallback(() => {
    setSourceMode((on) => {
      const next = !on;
      const v = vaultRef.current;
      if (v) localStorage.setItem(`basalt.sourceMode.${v}`, next ? "1" : "0");
      return next;
    });
  }, []);

  const toggleReading = useCallback(() => {
    setReadingMode((on) => {
      const next = !on;
      const v = vaultRef.current;
      if (v) localStorage.setItem(`basalt.reading.${v}`, next ? "1" : "0");
      return next;
    });
  }, []);

  // Export the focused note as a self-contained HTML file (images inlined as
  // data URLs so it stands alone).
  const handleExportHtml = useCallback(async () => {
    const pane = focusedIdRef.current ? panesRef.current[focusedIdRef.current] : null;
    const path = pane?.active;
    if (!path) return;
    if (/\.canvas$/i.test(path)) {
      setSaveError("Export to HTML isn't available for canvas files.");
      return;
    }
    const note = notesRef.current.find((n) => n.path === path);
    const name = note?.name ?? "note";
    const rel = note?.rel ?? "";
    try {
      const dom = new DOMParser().parseFromString(`<div>${renderMarkdown(pane.doc)}</div>`, "text/html");
      // Render mermaid diagrams to inline SVG.
      await Promise.all(
        [...dom.querySelectorAll("pre.md-code > code.language-mermaid")].map(async (code) => {
          const r = await renderMermaid(code.textContent ?? "");
          const pre = code.parentElement;
          if (!pre) return;
          const box = dom.createElement("div");
          box.className = "md-mermaid";
          if ("svg" in r) box.innerHTML = r.svg;
          else box.textContent = `Mermaid error: ${r.error}`;
          pre.replaceWith(box);
        }),
      );
      await Promise.all(
        [...dom.querySelectorAll("img[data-basalt-img]")].map(async (img) => {
          const target = img.getAttribute("data-basalt-img") ?? "";
          img.removeAttribute("data-basalt-img");
          if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
            img.setAttribute("src", target);
            return;
          }
          const url = await resolveImage(target, rel).catch(() => null);
          if (url) {
            img.setAttribute("src", url);
          } else {
            const span = dom.createElement("span");
            span.className = "md-image-missing";
            span.textContent = `🖼 ${target}`;
            img.replaceWith(span);
          }
        }),
      );
      const body = dom.body.firstElementChild?.innerHTML ?? "";
      const out = await save({
        defaultPath: `${name}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (out) {
        await exportFile(out, buildHtmlDocument(name, body));
        setSaveError(null);
      }
    } catch (e) {
      setSaveError(`Couldn't export: ${e}`);
    }
  }, []);

  // Print / Save-as-PDF: needs the full (non-virtualized) Reading view, so
  // switch to it first, then print after it renders.
  const handlePrintPdf = useCallback(() => {
    const pane = focusedIdRef.current ? panesRef.current[focusedIdRef.current] : null;
    if (pane?.active && /\.canvas$/i.test(pane.active)) {
      setSaveError("Print / PDF isn't available for canvas files.");
      return;
    }
    setReadingMode(true);
    const v = vaultRef.current;
    if (v) localStorage.setItem(`basalt.reading.${v}`, "1");
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  }, []);

  /** Open (creating if needed) today's daily note, honoring daily-notes.json. */
  const openDailyNote = useCallback(async () => {
    const cfg = obsConfigRef.current;
    const now = new Date();
    const fmt = cfg?.dailyNotesFormat || "YYYY-MM-DD";
    let name: string;
    try {
      name = formatMoment(now, fmt);
    } catch (e) {
      // Never guess at an unsupported format — a wrong filename pollutes the
      // shared vault. Fall back and say so.
      name = formatMoment(now, "YYYY-MM-DD");
      if (e instanceof UnsupportedTokenError) {
        setSaveError(
          `Daily-note format "${fmt}" isn't fully supported (${e.message}); used YYYY-MM-DD`,
        );
      }
    }
    const folder = (cfg?.dailyNotesFolder ?? "").replace(/^\/+|\/+$/g, "");
    // Sanitize exactly like the Rust build_note_path, so the existence lookup
    // finds the file the backend actually created (else every open after the
    // first fails with "note already exists").
    const relNoExt = sanitizeNoteRel(folder ? `${folder}/${name}` : name);
    const want = normRelKey(`${relNoExt}.md`);
    const existing = notesRef.current.find((n) => normRelKey(n.rel) === want);
    if (existing) {
      await openNoteByPath(existing.path);
      return;
    }
    try {
      const path = await createNote(relNoExt);
      const root = vaultRef.current ?? "";
      const rel = path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]+/, "") : path;
      // Apply the configured template, if any.
      let content = "";
      const tplSetting = cfg?.dailyNotesTemplate?.trim();
      if (tplSetting) {
        const tplKey = normRelKey(tplSetting);
        const tpl = notesRef.current.find((n) => normRelKey(n.rel) === tplKey);
        if (tpl) {
          // Read fresh from disk — the index blanks oversized notes' content.
          const tplContent = await readNote(tpl.path).catch(() => "");
          content = fillTemplate(tplContent, now, name.split("/").pop() ?? name);
          if (content) await writeNote(path, content);
        }
      }
      const note: VaultNote = { path, rel, name: nameFromRel(rel), content };
      index.current.setNote(note);
      rememberSelfWrite(rel, content);
      setNotes((prev) =>
        [...prev, note].sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase())),
      );
      bumpStructure();
      await openNoteByPath(path);
    } catch (e) {
      setSaveError(`Couldn't open daily note: ${e}`);
    }
  }, [openNoteByPath, rememberSelfWrite, bumpStructure]);

  const handleOpenUrl = useCallback((url: string) => {
    void openUrl(url).catch(() => {
      /* opener unavailable or blocked URL — ignore */
    });
  }, []);

  const handleOpenAttachment = useCallback(
    (path: string) => {
      // .canvas opens in a pane (read-only viewer); other attachments open in
      // the system viewer.
      if (/\.canvas$/i.test(path)) {
        void openNoteByPath(path);
        return;
      }
      void openPath(path).catch((e) => setSaveError(`Couldn't open: ${e}`));
    },
    [openNoteByPath],
  );

  /** Persist a pasted/dropped file into the vault (honoring Obsidian's
   * attachmentFolderPath) and return the embed link target. */
  const handleSaveAttachment = useCallback(async (file: File): Promise<string | null> => {
    if (!vaultRef.current) return null;
    // Capture the source note BEFORE any await — a note switch mid-encode must
    // not change where attachmentFolderPath "./" resolves.
    const sourceRel = activeRelRef.current ?? "";
    if (file.size > 64_000_000) {
      setSaveError("Attachment too large (max 64 MB)");
      return null;
    }
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
      }
      const b64 = btoa(bin);
      // Clipboard images arrive as generic "image.png" — name them like Obsidian.
      const generic = !file.name || /^(image|blob)\.(png|jpe?g|gif|webp)$/i.test(file.name);
      const ext = (file.name.split(".").pop() || file.type.split("/").pop() || "png").toLowerCase();
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const name = generic ? `Pasted image ${stamp}.${ext}` : file.name;
      const att = await writeAttachment(name, b64, sourceRel);
      setAttachmentsList((prev) =>
        [...prev.filter((a) => a.path !== att.path), att].sort((a, b) =>
          a.rel.toLowerCase().localeCompare(b.rel.toLowerCase()),
        ),
      );
      // Bare filename if unique, else the vault-relative path (with extension).
      const taken = attachmentsRef.current.some(
        (a) => a.path !== att.path && a.name.toLowerCase() === att.name.toLowerCase(),
      );
      return taken ? att.rel : att.name;
    } catch (e) {
      setSaveError(`Couldn't save attachment: ${e}`);
      return null;
    }
  }, []);

  /** Replace an upload placeholder in whichever note still contains it —
   * the editor that received the paste is gone (note switch / reload). */
  const handleReplacePlaceholder = useCallback(
    (placeholder: string, replacement: string) => {
      void (async () => {
        const holder = notesRef.current.find((n) => n.content.includes(placeholder));
        if (!holder) return; // user removed it (or it was never saved) — drop
        try {
          const disk = await readNote(holder.path);
          if (!disk.includes(placeholder)) return;
          const next = disk.split(placeholder).join(replacement);
          await writeNote(holder.path, next);
          rememberSelfWrite(holder.rel, next);
          const updated: VaultNote = { ...holder, content: next };
          index.current.setNote(updated);
          setNotes((prev) => prev.map((n) => (n.path === holder.path ? updated : n)));
          bumpIndex();
          // Reflect the finalized link in any pane showing this note.
          for (const p of Object.values(panesRef.current)) {
            if (p.active === holder.path) patchPane(p.id, { doc: next });
          }
        } catch (e) {
          setSaveError(`Couldn't finalize attachment: ${e}`);
        }
      })();
    },
    [rememberSelfWrite, bumpIndex, patchPane],
  );

  /** Create a note (folder-qualified ok) and open it, updating the index
   * incrementally — no full-vault reload. */
  const createAndOpen = useCallback(
    async (name: string) => {
      const root = vaultRef.current;
      if (!root) return;
      const path = await createNote(name);
      const rel = path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]+/, "") : path;
      const note: VaultNote = { path, rel, name: nameFromRel(rel), content: "" };
      index.current.setNote(note);
      setNotes((prev) =>
        [...prev, note].sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase())),
      );
      rememberSelfWrite(rel, "");
      bumpStructure();
      await openNoteByPath(path); // flushes the focused pane's current note first
    },
    [openNoteByPath, rememberSelfWrite, bumpStructure],
  );

  // `allowCreate` is false for read-only viewers (the canvas): an unresolved
  // file node must NOT silently create a note in the live vault.
  const handleOpenWikilink = useCallback(
    async (target: string, allowCreate = true) => {
      const resolved = index.current.resolve(target, activePathRef.current ?? "");
      if (resolved) {
        await openNoteByPath(resolved);
        return;
      }
      const pathPart = targetPathPart(target);
      if (!pathPart) return;
      // An attachment target opens in the system viewer; never auto-create
      // a junk "Report.pdf.md" note for one.
      const att = resolveAttachment(attachmentsRef.current, target);
      if (att) {
        void openPath(att.path).catch((e) => setSaveError(`Couldn't open: ${e}`));
        return;
      }
      if (looksLikeAttachment(pathPart)) return;
      if (!allowCreate) {
        setSaveError(`File not found: ${pathPart}`);
        return;
      }
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

  const activePath = active?.path ?? null;
  const activeNote = useMemo(
    () => (activePath ? (notes.find((n) => n.path === activePath) ?? null) : null),
    [activePath, notes],
  );
  const activeName = activeNote?.name ?? null;
  activeRelRef.current = activeNote?.rel ?? null;

  // Tab labels for a given pane's open paths.
  const tabItemsFor = useCallback(
    (paths: string[]): TabItem[] =>
      paths.map((p) => ({
        path: p,
        name: notesRef.current.find((n) => n.path === p)?.name ?? basename(p),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notes],
  );

  // Backlinks of the active note can only change when OTHER notes change, so
  // this keys off structureVersion — a local autosave doesn't re-resolve the vault.
  const backlinks = useMemo(() => {
    if (!activePath) return [];
    return index.current.backlinksFor(activePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, structureVersion]);

  // Expensive (full vault text scan). Recompute only when the active note
  // changes — not on every debounced save — to keep typing smooth.
  const unlinked = useMemo(() => {
    if (!activeName || !activePath) return [];
    return index.current.unlinkedMentionsFor(activeName, notesRef.current, activePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeName, activePath]);

  // Vault-wide tags for the tag pane — from the incremental index, so this only
  // recomputes when content (indexVersion) or structure (structureVersion) changes.
  const tags = useMemo(
    () => index.current.allTags(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [indexVersion, structureVersion],
  );

  // Persist the active right-panel tab per vault.
  useEffect(() => {
    const v = vaultRef.current;
    if (!v) return;
    try {
      localStorage.setItem(rightTabKey(v), rightTab);
    } catch {
      /* ignore */
    }
  }, [rightTab]);

  const handleSelectTag = useCallback((tag: string) => {
    setSearchSeed(`#${tag} `);
    setModal("search");
  }, []);
  const handleOpenBookmark = useCallback(
    (b: Bookmark) => {
      if (!b.path) return;
      // Bookmark paths are vault-relative; resolve to a note or attachment.
      const note = notesRef.current.find((n) => n.rel === b.path);
      if (note) {
        void openNoteByPath(note.path);
        return;
      }
      const att = attachmentsRef.current.find((a) => a.rel === b.path);
      if (att) handleOpenAttachment(att.path);
    },
    [openNoteByPath, handleOpenAttachment],
  );

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

  /** Move a note to .trash (with confirmation) and drop it everywhere. */
  const handleDeleteNote = useCallback(
    async (path: string) => {
      const note = notesRef.current.find((n) => n.path === path);
      if (!note) return;
      const ok = await confirm(`Move "${note.name}" to the vault trash?`, {
        title: "Delete note",
        kind: "warning",
      });
      if (!ok) return;
      try {
        // Never resurrect a deleted note via autosave / a stale conflict.
        const t = saveTimers.current.get(path);
        if (t !== undefined) window.clearTimeout(t);
        saveTimers.current.delete(path);
        pending.current.delete(path);
        clearConflict(path);
        await deleteNote(path);
        selfWrites.current.delete(note.rel); // a restored copy must not be swallowed
        index.current.removeNote(path);
        setNotes((prev) => prev.filter((n) => n.path !== path));
        recents.current = recents.current.filter((r) => r !== note.rel);
        bumpStructure(); // the prune effect closes its tab in every pane
      } catch (e) {
        setSaveError(`Couldn't delete: ${e}`);
      }
    },
    [bumpStructure, clearConflict],
  );

  /** Rename/move a note and rewrite every link to it across the vault.
   * Ordering matters (each step's rationale from the 2.7 review):
   * 1. flush pending edits and ABORT if the flush failed;
   * 2. freeze a pre-rename resolver (the live index is committed early);
   * 3. fs rename, then commit the renamed note to index/notes IMMEDIATELY so a
   *    mid-orchestration watcher flush can't corrupt state;
   * 4. re-anchor the renamed note's OWN self/relative links;
   * 5. rewrite each affected source READ FROM DISK (memory may lag external
   *    edits; read_note also refuses non-UTF8 instead of corrupting it), with
   *    per-source failure domains. */
  const handleRenameNote = useCallback(
    async (oldPath: string, newName: string) => {
      const root = vaultRef.current;
      if (!root) return;
      try {
        await flushAll();
        if (pending.current.has(oldPath)) {
          setSaveError("Couldn't rename: unsaved changes failed to save");
          return;
        }
        const oldNote = notesRef.current.find((n) => n.path === oldPath);
        if (!oldNote) return;

        // Pre-rename resolution snapshot — mapTarget decisions must use the
        // OLD vault shape even after the live index is updated below.
        const preIndex = new VaultIndex();
        preIndex.build(notesRef.current);
        const preNotes = notesRef.current;

        const newPath = await renameNote(oldPath, newName);
        if (newPath === oldPath) return;
        const newRel = newPath.startsWith(root)
          ? newPath.slice(root.length).replace(/^[/\\]+/, "")
          : newPath;
        const newBase = nameFromRel(newRel);

        // Link text Obsidian would write, honoring the vault's newLinkFormat
        // (shortest: bare name unless another note shares the new basename;
        // relative: per-SOURCE `./`/`../` path; absolute: full vault path).
        const fmt = getLinkFormat();
        const taken = preNotes.some(
          (n) => n.path !== oldPath && normalizeName(n.name) === normalizeName(newBase),
        );
        const newRelNoExt = newRel.replace(/\.md$/i, "");

        // The renamed note's own content, from disk (authoritative), with its
        // self-links retargeted and position-dependent ./.. links re-anchored.
        let renamedContent: string;
        try {
          renamedContent = await readNote(newPath);
        } catch {
          renamedContent = oldNote.content; // disk read failed; best effort
        }
        const ownMap = (raw: string): string | null => {
          const dest = preIndex.resolve(raw, oldPath);
          if (!dest) return null;
          if (dest === oldPath) {
            return linkTargetForFormat(fmt, newRelNoExt, taken, newRel); // self-link
          }
          const pathPart = targetPathPart(raw);
          const relative = pathPart.split(/[/\\]/).some((seg) => seg === "." || seg === "..");
          if (!relative) return null; // position-independent links still resolve
          const destNote = preNotes.find((n) => n.path === dest);
          if (!destNote) return null;
          const destTaken = preNotes.some(
            (n) => n.path !== dest && normalizeName(n.name) === normalizeName(destNote.name),
          );
          return linkTargetForFormat(fmt, destNote.rel.replace(/\.md$/i, ""), destTaken, newRel);
        };
        const ownRewritten = rewriteLinks(renamedContent, ownMap);
        if (ownRewritten !== null) {
          await writeNote(newPath, ownRewritten);
          renamedContent = ownRewritten;
        }

        // COMMIT the renamed note before any other writes, so a watcher flush
        // landing mid-orchestration sees consistent state.
        selfWrites.current.delete(oldNote.rel);
        rememberSelfWrite(newRel, renamedContent);
        index.current.removeNote(oldPath);
        const renamed: VaultNote = {
          path: newPath,
          rel: newRel,
          name: newBase,
          content: renamedContent,
        };
        index.current.setNote(renamed);
        recents.current = recents.current.map((r) => (r === oldNote.rel ? newRel : r));
        setNotes((prev) =>
          prev
            .map((n) => (n.path === oldPath ? renamed : n))
            .sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase())),
        );
        bumpStructure();
        // Re-point the renamed note in every pane (tabs + active + doc) so the
        // prune effect doesn't drop the now-nonexistent oldPath.
        const repoint = (pane: Pane): Pane => {
          if (!pane.tabs.includes(oldPath)) return pane;
          return {
            ...pane,
            tabs: pane.tabs.map((p) => (p === oldPath ? newPath : p)),
            active: pane.active === oldPath ? newPath : pane.active,
            doc: pane.active === oldPath ? renamedContent : pane.doc,
          };
        };
        panesRef.current = Object.fromEntries(
          Object.entries(panesRef.current).map(([id, pane]) => [id, repoint(pane)]),
        );
        setPanes((ps) =>
          Object.fromEntries(Object.entries(ps).map(([id, pane]) => [id, repoint(pane)])),
        );

        // Rewrite affected sources. Candidates are found via the in-memory
        // snapshot (cheap), but each rewrite reads DISK content so a fresher
        // external edit is never reverted. The replacement text is per-source:
        // "relative" format needs the SOURCE note's folder.
        const sourceMap = (notePath: string, noteRel: string) => (raw: string) =>
          preIndex.resolve(raw, notePath) === oldPath
            ? linkTargetForFormat(fmt, newRelNoExt, taken, noteRel)
            : null;
        const updates: VaultNote[] = [];
        const failures: string[] = [];
        for (const note of preNotes) {
          if (note.path === oldPath) continue;
          if (rewriteLinks(note.content, sourceMap(note.path, note.rel)) === null) continue; // unaffected
          try {
            const disk = await readNote(note.path);
            const next = rewriteLinks(disk, sourceMap(note.path, note.rel));
            if (next === null) continue;
            await writeNote(note.path, next);
            const updated: VaultNote = { ...note, content: next };
            rememberSelfWrite(note.rel, next);
            index.current.setNote(updated);
            updates.push(updated);
          } catch (e) {
            failures.push(note.rel);
            console.error("[basalt] link rewrite failed", note.rel, e);
          }
        }
        if (updates.length > 0) {
          const byPath = new Map(updates.map((u) => [u.path, u]));
          setNotes((prev) => prev.map((n) => byPath.get(n.path) ?? n));
          bumpStructure();
          // Any pane showing a note whose links were rewritten reconciles in place.
          for (const p of Object.values(panesRef.current)) {
            if (p.active && byPath.has(p.active)) patchPane(p.id, { doc: byPath.get(p.active)!.content });
          }
        }
        setSaveError(
          failures.length > 0 ? `Renamed, but link updates failed in: ${failures.join(", ")}` : null,
        );
      } catch (e) {
        setSaveError(`Couldn't rename: ${e}`);
      }
    },
    [flushAll, bumpStructure, rememberSelfWrite, getLinkFormat, patchPane],
  );

  // Blank-query switcher shows recently opened notes first.
  const switcherItems = useCallback(
    (q: string) => {
      const all = notesRef.current;
      if (q.trim()) return fuzzyRank(q, all, (n) => [n.name, n.rel]);
      const order = new Map(recents.current.map((rel, i) => [rel, i]));
      return [...all].sort((a, b) => {
        const ia = order.get(a.rel) ?? Infinity;
        const ib = order.get(b.rel) ?? Infinity;
        return ia - ib || a.rel.toLowerCase().localeCompare(b.rel.toLowerCase());
      });
    },
    [],
  );

  const commands = useMemo<AppCommand[]>(
    () => [
      { id: "new-note", label: "New note", hint: "create an untitled note", run: () => void handleNewNote() },
      { id: "daily-note", label: "Open today's daily note", hint: "creates it from your template if missing", run: () => void openDailyNote() },
      { id: "source-mode", label: "Toggle Source mode", hint: "raw Markdown ↔ Live Preview", run: toggleSourceMode },
      { id: "reading-mode", label: "Toggle Reading view", hint: "rendered, read-only ↔ edit", run: toggleReading },
      { id: "export-html", label: "Export note as HTML…", hint: "self-contained file", run: () => void handleExportHtml() },
      { id: "print-pdf", label: "Print / Save as PDF…", hint: "prints the Reading view", run: handlePrintPdf },
      { id: "open-note", label: "Open note…", hint: "quick switcher (⌘O)", run: () => setModal("switcher") },
      { id: "search", label: "Search vault…", hint: "full-text search (⇧⌘F)", run: () => { setSearchSeed(""); setModal("search"); } },
      { id: "graph", label: "Open graph view", hint: "global link graph", run: () => setGraphOpen(true) },
      {
        id: "graph-local",
        label: "Open local graph",
        hint: "links around the current note",
        run: () => {
          setGraphMode("local");
          setGraphOpen(true);
        },
      },
      { id: "change-vault", label: "Change vault…", hint: "open a different folder", run: () => void handleOpenVault() },
      { id: "settings", label: "Open settings", hint: "appearance, vault info (⌘,)", run: () => setModal("settings") },
      { id: "toggle-theme", label: "Toggle light/dark theme", hint: "switch appearance", run: toggleTheme },
      { id: "split-right", label: "Split right", hint: "open the current note in a vertical split", run: () => splitFocused("row") },
      { id: "split-down", label: "Split down", hint: "open the current note in a horizontal split", run: () => splitFocused("col") },
      {
        id: "rename-note",
        label: "Rename current note…",
        hint: "moves it and rewrites links vault-wide",
        run: () => {
          const path = activePathRef.current;
          const note = path ? notesRef.current.find((n) => n.path === path) : undefined;
          if (note) setRenameTarget({ path: note.path, rel: note.rel });
        },
      },
      {
        id: "delete-note",
        label: "Delete current note",
        hint: "move to .trash",
        run: () => {
          const path = activePathRef.current;
          if (path) void handleDeleteNote(path);
        },
      },
      {
        id: "reload-note",
        label: "Reload note from disk",
        hint: "discard unsaved changes",
        run: () => void handleReloadFromDisk(),
      },
    ],
    [handleNewNote, handleOpenVault, handleReloadFromDisk, handleDeleteNote, openDailyNote, toggleSourceMode, toggleReading, toggleTheme, splitFocused, handleExportHtml, handlePrintPdf],
  );

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

  // Render one pane's content: a tab bar + the live editor for its active note.
  // Mousedown anywhere in the pane focuses it (so it drives the right panel).
  const renderPane = (id: string) => {
    const pane = panes[id];
    if (!pane) return null;
    const focused = id === focusedId;
    const path = pane.active;
    const rel = path ? (notes.find((n) => n.path === path)?.rel ?? "") : "";
    return (
      <div
        className={focused ? "pane focused" : "pane"}
        onMouseDownCapture={() => focusPane(id)}
      >
        {pane.tabs.length > 0 && (
          <TabBar
            tabs={tabItemsFor(pane.tabs)}
            activePath={pane.active}
            onSelect={(p) => void openInPane(id, p)}
            onClose={(p) => void closeTab(id, p)}
            onNew={() => {
              focusPane(id);
              setModal("switcher");
            }}
          />
        )}
        {path ? (
          /\.canvas$/i.test(path) ? (
            <CanvasView
              key={`${id}:${path}:canvas`}
              doc={pane.doc}
              onOpenFile={(file, subpath) =>
                void handleOpenWikilink(file + (subpath ?? ""), false) /* read-only: never create */
              }
              onOpenUrl={handleOpenUrl}
              resolveImage={(target) =>
                vaultRef.current ? resolveImage(target, rel) : Promise.resolve(null)
              }
            />
          ) : readingMode ? (
            <ReadingView
              key={`${id}:${path}:read`}
              doc={pane.doc}
              dark={dark}
              onOpenInternal={handleOpenWikilink}
              onOpenUrl={handleOpenUrl}
              resolveImage={(target) =>
                vaultRef.current ? resolveImage(target, rel) : Promise.resolve(null)
              }
            />
          ) : (
            <EditorPane
              key={`${id}:${path}`}
              path={path}
              doc={pane.doc}
              scrollToLine={pane.scrollToLine}
              getNotes={getNotes}
              getLinkFormat={getLinkFormat}
              getActiveRel={() => rel || null}
              sourceMode={sourceMode}
              dark={dark}
              onOpenWikilink={handleOpenWikilink}
              onOpenUrl={handleOpenUrl}
              resolveImage={(target) =>
                vaultRef.current ? resolveImage(target, rel) : Promise.resolve(null)
              }
              saveAttachment={handleSaveAttachment}
              replacePlaceholder={handleReplacePlaceholder}
              onChange={(doc) => handleChange(id, path, doc)}
            />
          )
        ) : (
          <div className="placeholder">Select a note, or press + to create one.</div>
        )}
      </div>
    );
  };

  return (
    <div className="app">
      <Sidebar
        notes={notes}
        attachments={attachmentsList}
        activePath={active?.path ?? null}
        vaultName={basename(vault)}
        onOpen={(path) => openNoteByPath(path)}
        onNewNote={handleNewNote}
        onOpenAttachment={handleOpenAttachment}
        onContextMenu={(path, x, y) => setFileMenu({ path, x, y })}
      />
      <main className="main">
        <div className="toolbar">
          <button className="link-btn" onClick={handleOpenVault}>
            Change vault…
          </button>
          <button className="link-btn" onClick={() => setGraphOpen(true)} title="Graph view">
            Graph
          </button>
          <button
            className={readingMode ? "link-btn toggled" : "link-btn"}
            onClick={toggleReading}
            title="Toggle Reading view (rendered, read-only)"
            disabled={activeIsCanvas}
          >
            Reading
          </button>
          <button
            className={sourceMode ? "link-btn toggled" : "link-btn"}
            onClick={toggleSourceMode}
            title="Toggle Source mode (raw Markdown)"
            disabled={readingMode || activeIsCanvas}
          >
            Source
          </button>
          <button
            className="link-btn"
            onClick={toggleTheme}
            title={`Switch to ${dark ? "light" : "dark"} theme`}
          >
            {dark ? "☾" : "☀"}
          </button>
          <button
            className="link-btn"
            onClick={() => splitFocused("row")}
            title="Split right"
            disabled={!active}
          >
            ⊟
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
            {saveError
              ? `⚠ ${saveError}`
              : saving
                ? "Saving…"
                : activeIsCanvas
                  ? "Read-only"
                  : active
                    ? "Saved"
                    : ""}
          </span>
        </div>
        {layout ? (
          <PaneTree
            node={layout}
            renderPane={renderPane}
            onSizes={(p, sizes) =>
              setLayout((l) => {
                if (!l) return l;
                const next = setSizes(l, p, sizes);
                layoutRef.current = next;
                return next;
              })
            }
          />
        ) : (
          <div className="placeholder">Select a note, or press + to create one.</div>
        )}
      </main>
      <RightPanel
        tab={rightTab}
        onTab={setRightTab}
        noteName={activeName}
        backlinks={backlinks}
        unlinked={unlinked}
        onOpenRef={(path, line) => openNoteByPath(path, line)}
        outlineDoc={activeIsCanvas ? null : (activeNote?.content ?? active?.doc ?? null)}
        onJumpLine={(line) => {
          if (active) void openNoteByPath(active.path, line);
        }}
        tags={tags}
        onSelectTag={handleSelectTag}
        bookmarks={bookmarks}
        onOpenBookmark={handleOpenBookmark}
        onSearch={(query) => {
          setSearchSeed(query);
          setModal("search");
        }}
      />
      {modal === "switcher" && (
        <Palette<VaultNote>
          placeholder="Open note…"
          getItems={(q) => switcherItems(q)}
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
          initialQuery={searchSeed}
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
      {modal === "commands" && (
        <Palette<AppCommand>
          placeholder="Run command…"
          getItems={(q) => fuzzyRank(q, commands, (c) => [c.label])}
          itemKey={(c) => c.id}
          renderItem={(c) => (
            <>
              <span className="palette-name">{c.label}</span>
              {c.hint && <span className="palette-sub">{c.hint}</span>}
            </>
          )}
          onSelect={(c) => {
            setModal(null);
            c.run();
          }}
          onClose={() => setModal(null)}
          emptyText="No matching command"
        />
      )}
      {modal === "settings" && (
        <SettingsModal
          themeMode={themeMode}
          onThemeMode={setThemeMode}
          obsConfig={obsConfigRef.current}
          onClose={() => setModal(null)}
        />
      )}
      {fileMenu && (
        <div className="ctx-overlay" onMouseDown={() => setFileMenu(null)} onContextMenu={(e) => e.preventDefault()}>
          <div
            className="ctx-menu"
            style={{ left: fileMenu.x, top: fileMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="ctx-item"
              onClick={() => {
                const note = notesRef.current.find((n) => n.path === fileMenu.path);
                setFileMenu(null);
                if (note) setRenameTarget({ path: note.path, rel: note.rel });
              }}
            >
              Rename…
            </button>
            <button
              className="ctx-item danger"
              onClick={() => {
                const path = fileMenu.path;
                setFileMenu(null);
                void handleDeleteNote(path);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
      {renameTarget && (
        <PromptModal
          title="Rename note (edit the folders to move it)"
          defaultValue={renameTarget.rel.replace(/\.md$/i, "")}
          confirmLabel="Rename"
          onConfirm={(value) => {
            const t = renameTarget;
            setRenameTarget(null);
            if (/[#^[\]|]/.test(value)) {
              setSaveError("Note names cannot contain # ^ [ ] |");
              return;
            }
            void handleRenameNote(t.path, value);
          }}
          onClose={() => setRenameTarget(null)}
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
