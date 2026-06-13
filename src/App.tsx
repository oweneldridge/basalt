import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { confirm } from "@tauri-apps/plugin-dialog";
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
  const [sourceMode, setSourceMode] = useState(false);
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
  const activePathRef = useRef<string | null>(null);
  activePathRef.current = active?.path ?? null;
  // The active note's vault-relative path — the key the watcher matches on.
  const activeRelRef = useRef<string | null>(null);
  const changedOnDiskRef = useRef(false);
  changedOnDiskRef.current = changedOnDisk;
  const saveTimer = useRef<number | undefined>(undefined);
  const pending = useRef<{ path: string; doc: string } | null>(null);
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
      // A failed save can leave another note's edit pending — flush it rather
      // than silently overwriting it with this note's pending.
      if (pending.current && pending.current.path !== path) {
        const p = pending.current;
        pending.current = null;
        void flushSave(p.path, p.doc);
      }
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
      let doc: string;
      try {
        doc = await readNote(path);
      } catch (e) {
        setSaveError(`Couldn't open note: ${e}`);
        return;
      }
      setSaveError(null);
      setChangedOnDisk(false);
      setActive({ path, doc, scrollToLine: line });
      // Track recency for the quick switcher.
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
    [flushPending],
  );

  const openVault = useCallback(
    async (path: string) => {
      await flushPending();
      clearImageCache();
      const root = await openVaultBackend(path); // canonical; sets managed state
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
      setVault(root);
      localStorage.setItem(LAST_VAULT_KEY, root);
      setActive(null);
      setChangedOnDisk(false);
      selfWrites.current.clear();
      // Empty the stale note list immediately — the old vault's entries must not
      // be clickable while the new vault loads.
      setNotes([]);
      index.current.build([]);
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

      // Reconcile the open note per the conflict policy.
      const activeRel = activeRelRef.current;
      const activePath = activePathRef.current;
      if (!activeRel || !activePath) return;
      const open = results.find((r) => r.rel === activeRel);
      if (!open) return;
      // A content-identical "change" (mtime touch, sync-client noise) is a
      // no-op — it must never raise a conflict, even while the user is typing.
      if (open.ok && open.content === prevByRel.get(activeRel)) return;
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

  const getNotes = useCallback(
    () => notesRef.current.map((n) => ({ name: n.name, rel: n.rel })),
    [],
  );
  const getLinkFormat = useCallback((): LinkFormat => {
    const f = obsConfigRef.current?.newLinkFormat;
    return f === "relative" || f === "absolute" ? f : "shortest";
  }, []);
  const getActiveRel = useCallback(() => activeRelRef.current, []);

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
      await flushPending();
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
  }, [openNoteByPath, flushPending, rememberSelfWrite, bumpStructure]);

  const handleOpenUrl = useCallback((url: string) => {
    void openUrl(url).catch(() => {
      /* opener unavailable or blocked URL — ignore */
    });
  }, []);

  const handleResolveImage = useCallback((target: string) => {
    if (!vaultRef.current) return Promise.resolve(null);
    return resolveImage(target, activeRelRef.current ?? "");
  }, []);

  const handleOpenAttachment = useCallback((path: string) => {
    void openPath(path).catch((e) => setSaveError(`Couldn't open: ${e}`));
  }, []);

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
          if (activePathRef.current === holder.path) {
            setActive({ path: holder.path, doc: next });
          }
        } catch (e) {
          setSaveError(`Couldn't finalize attachment: ${e}`);
        }
      })();
    },
    [rememberSelfWrite, bumpIndex],
  );

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
      if (!pathPart) return;
      // An attachment target opens in the system viewer; never auto-create
      // a junk "Report.pdf.md" note for one.
      const att = resolveAttachment(attachmentsRef.current, target);
      if (att) {
        void openPath(att.path).catch((e) => setSaveError(`Couldn't open: ${e}`));
        return;
      }
      if (looksLikeAttachment(pathPart)) return;
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
        if (pending.current?.path === path) {
          window.clearTimeout(saveTimer.current);
          pending.current = null; // never resurrect a deleted note via autosave
        }
        await deleteNote(path);
        selfWrites.current.delete(note.rel); // a restored copy must not be swallowed
        index.current.removeNote(path);
        setNotes((prev) => prev.filter((n) => n.path !== path));
        recents.current = recents.current.filter((r) => r !== note.rel);
        if (activePathRef.current === path) {
          setChangedOnDisk(false);
          setActive(null);
        }
        bumpStructure();
      } catch (e) {
        setSaveError(`Couldn't delete: ${e}`);
      }
    },
    [bumpStructure],
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
        await flushPending();
        if (pending.current) {
          setSaveError("Couldn't rename: unsaved changes failed to save");
          return;
        }
        const oldNote = notesRef.current.find((n) => n.path === oldPath);
        if (!oldNote) return;
        const wasActive = activePathRef.current === oldPath;

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
        if (wasActive) setActive({ path: newPath, doc: renamedContent });

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
          const activeNow = activePathRef.current;
          if (activeNow && byPath.has(activeNow)) {
            // The open note had links rewritten — reconcile in place.
            setActive({ path: activeNow, doc: byPath.get(activeNow)!.content });
          }
        }
        setSaveError(
          failures.length > 0 ? `Renamed, but link updates failed in: ${failures.join(", ")}` : null,
        );
      } catch (e) {
        setSaveError(`Couldn't rename: ${e}`);
      }
    },
    [flushPending, bumpStructure, rememberSelfWrite, getLinkFormat],
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
    [handleNewNote, handleOpenVault, handleReloadFromDisk, handleDeleteNote, openDailyNote, toggleSourceMode, toggleTheme],
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
            className={sourceMode ? "link-btn toggled" : "link-btn"}
            onClick={toggleSourceMode}
            title="Toggle Source mode (raw Markdown)"
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
            {saveError ? `⚠ ${saveError}` : saving ? "Saving…" : active ? "Saved" : ""}
          </span>
        </div>
        {active ? (
          <EditorPane
            key={active.path}
            path={active.path}
            doc={active.doc}
            scrollToLine={active.scrollToLine}
            getNotes={getNotes}
            getLinkFormat={getLinkFormat}
            getActiveRel={getActiveRel}
            sourceMode={sourceMode}
            dark={dark}
            onOpenWikilink={handleOpenWikilink}
            onOpenUrl={handleOpenUrl}
            resolveImage={handleResolveImage}
            saveAttachment={handleSaveAttachment}
            replacePlaceholder={handleReplacePlaceholder}
            onChange={handleChange}
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
        outlineDoc={activeNote?.content ?? active?.doc ?? null}
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
