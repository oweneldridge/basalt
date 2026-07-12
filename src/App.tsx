import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import {
  createNote,
  createFolder,
  deleteNote,
  listAttachments,
  nameFromRel,
  renameNote,
  writeAttachment,
  openVaultBackend,
  openNewWindow,
  takePendingDeepLink,
  pickVault,
  readNote,
  readVault,
  startWatching,
  writeNote,
  writeCanvas,
  writeBase,
  readObsidianConfig,
  readObsidianImport,
  readObsidianBookmarks,
  toggleFileBookmark,
  exportFile,
  type Attachment,
  type Bookmark,
  type ChangedNote,
  type ObsidianConfig,
  type VaultNote,
} from "./lib/vault";
import { VaultIndex } from "./lib/vaultIndex";
import {
  loadRecentVaults,
  pushRecentVault,
  vaultName,
  workspaceKey as wsKey,
  type RecentVault,
} from "./lib/recentVaults";
import { setQueryHost } from "./lib/queryHost";
import { setTranscludeHost, splitSubpath, subpathToLine, extractHeadings, extractBlockIds } from "./lib/transclude";
import { recordSnapshot, listSnapshots, clearSnapshots, renameSnapshots, type Snapshot } from "./lib/snapshots";
import { installHoverPreview } from "./lib/hoverPreview";
import { linkifyMention } from "./lib/linkify";
import { reorderTabs, insertTab } from "./lib/tabs";
import { loadBindings, saveBindings, matchChord, type Bindings } from "./lib/hotkeys";
import { parseObsidianImport, type ObsidianImportResult } from "./lib/obsidianImport";
import { resolveThemePalettes, applyThemePalette, type ThemePalette } from "./lib/obsidianTheme";
import { noteRow, tasksForNote } from "./lib/vaultRows";
import { parseQuery, runQuery, type Task } from "./lib/query";
import { applyTemplate, type TemplateCtx } from "./lib/templates";
import { parseProperties } from "./lib/bases";
import {
  installHost,
  loadPlugin,
  unloadPlugin,
  unloadAll,
  pluginCommands,
  loadEnabled,
  saveEnabled,
  emitVaultEvent,
  emitWorkspaceEvent,
  pluginRightViews,
  type HostDeps,
} from "./lib/plugins";
import { listPlugins, writePluginData, listCssSnippets, deleteFolder, renameFolder, type PluginInfo, type CssSnippet } from "./lib/vault";
import type { EditorApi } from "./components/EditorPane";
import type { NoteRef } from "./editor/wikilink";
import { clearImageCache, resolveImage } from "./lib/assets";
import { normalizeName, targetPathPart } from "./lib/markdown";
import { Sidebar } from "./components/Sidebar";
import { Ribbon } from "./components/Ribbon";
import { WorkspacesModal } from "./components/WorkspacesModal";
import { StackedTabs } from "./components/StackedTabs";
import { SlidesView } from "./components/SlidesView";
import { StatusBar } from "./components/StatusBar";
import { InlineTitle } from "./components/InlineTitle";
import { EditorPane } from "./components/EditorPane";
import { TabBar, type TabItem } from "./components/TabBar";
import { PaneTree } from "./components/PaneTree";
import { isViewPath, parseViewPath, viewLabel, viewPath, type ViewSpec, type BuiltinView } from "./lib/leafViews";
import { parseBasaltUri } from "./lib/deeplink";
import { Outline } from "./components/Outline";
import { Backlinks } from "./components/Backlinks";
import { Tags } from "./components/Tags";
import { Bookmarks } from "./components/Bookmarks";
import { Properties } from "./components/Properties";
import { PluginViewMount } from "./components/PluginViewMount";
import { ReadingView } from "./components/ReadingView";
import { CanvasView } from "./components/CanvasView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { VaultSwitcher } from "./components/VaultSwitcher";
import { VersionHistory } from "./components/VersionHistory";
// Lazy: the Bases engine pulls in a YAML parser — keep it out of the initial
// bundle until a .base pane is actually opened (same reasoning as mermaid).
const BaseView = lazy(() =>
  import("./components/BaseView").then((m) => ({ default: m.BaseView })),
);
import { renderMarkdown, toggleTaskLine } from "./lib/render";
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
import { linkTargetForFormat, rewriteLinks, folderMoveMapper } from "./lib/rename";
import { rewriteCanvasFileRefs } from "./lib/canvas";
import { looksLikeAttachment, resolveAttachment } from "./lib/attachments";
import { fillTemplate, formatMoment, UnsupportedTokenError } from "./lib/daily";
import type { LinkFormat } from "./lib/rename";
import { fuzzyRank } from "./lib/fuzzy";
import { searchVault, type SearchHit } from "./lib/search";
import "./styles.css";

const LAST_VAULT_KEY = "basalt.lastVault";

/** This window's Tauri label ("main" for the first window). Each window is an
 * independent vault + workspace. Falls back to "main" outside Tauri (tests). */
const WINDOW_LABEL: string = (() => {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
})();

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
const isMac = /Mac/.test(navigator.platform);

/** Keep only pins whose tab survived; drop the field when none did. */
function prunePins(pane: Pane, keep: string[]): string[] | undefined {
  const p = pane.pinned?.filter((x) => keep.includes(x));
  return p && p.length ? p : undefined;
}

interface Pane {
  id: string;
  tabs: string[]; // open note paths, in tab order
  active: string | null; // the live note path
  doc: string; // content of the active note (initial/reconciled for its editor)
  scrollToLine?: number;
  /** Pinned tab paths — a pinned tab can't be closed until unpinned. */
  pinned?: string[];
  /** Linked pane: follows the note navigated in another pane (Obsidian's
   * "Link with pane"). */
  linked?: boolean;
  /** Stacked tab group: show all open tabs as a horizontal spread (Obsidian's
   * "Stack tab group") instead of one editor. */
  stacked?: boolean;
  /** Marks a sidebar dock pane (holds view tabs). Left = file tree/search;
   * right = backlinks/outline/properties/… Undefined = a normal editor pane. */
  dock?: "left" | "right";
}

// The view tabs a fresh right dock opens with (Obsidian's right sidebar).
const RIGHT_DOCK_VIEWS: BuiltinView[] = ["backlinks", "outline", "properties", "tags", "bookmarks"];

/** A fresh right-dock pane (view tabs, backlinks active). */
function makeRightDock(id: string): Pane {
  const tabs = RIGHT_DOCK_VIEWS.map((type) => viewPath({ type }));
  return { id, tabs, active: tabs[0], doc: "", dock: "right" };
}

/** A fresh left-dock pane (the file explorer). */
function makeLeftDock(id: string): Pane {
  const tabs = [viewPath({ type: "filetree" })];
  return { id, tabs, active: tabs[0], doc: "", dock: "left" };
}

type ModalKind = "switcher" | "search" | "commands" | "settings" | "vaults" | "templates" | "history" | "workspaces" | null;

interface AppCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

const RECENT_MAX = 50;
const recentKey = (vault: string) => `basalt.recent.${vault}`;
/** Sentinel path for the quick-switcher's "Create <query>" row. */
const SWITCHER_CREATE = "\u0000create";
const rightTabKey = (vault: string) => `basalt.rightTab.${vault}`;
// Layout is per-WINDOW so two windows on the same vault don't clobber each
// other's tabs (see lib/recentVaults.ts::workspaceKey).
const workspaceKey = (vault: string) => wsKey(vault, WINDOW_LABEL);
/** Named saved workspaces (Obsidian's Workspaces plugin), per vault. */
const namedWsKey = (vault: string) => `basalt.workspaces.${vault}`;

// Bumped when the persisted workspace shape changes. Unversioned (v1) data is
// still read — tabs are just note paths, which remain valid — so old workspaces
// migrate transparently. Anything unparseable falls back to an empty workspace.
const WORKSPACE_VERSION = 3;

/** The serializable shape of a workspace (no live doc — restored from disk). A
 * tab path may be a note/attachment path or a view sentinel (see leafViews). */
interface SavedWorkspace {
  version?: number;
  layout: LayoutNode;
  panes: Record<string, { tabs: string[]; active: string | null; pinned?: string[]; linked?: boolean; stacked?: boolean; dock?: "left" | "right" }>;
  focusedId: string | null;
}

function loadNamedWorkspaces(vault: string): Record<string, SavedWorkspace> {
  try {
    const raw = localStorage.getItem(namedWsKey(vault));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, SavedWorkspace>;
    }
  } catch {
    /* corrupted — start fresh */
  }
  return {};
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

/** Markdown notes are editable + indexed; other openable files (.canvas,
 * .base) are read-only viewers — autosave/conflict logic must skip them. */
const isMarkdownPath = (p: string) => /\.md$/i.test(p);

/** Files that open in a pane as a READ-ONLY viewer rather than an editor. */
const isViewerPath = (p: string) => /\.(canvas|base)$/i.test(p);

/** Find a task's CURRENT line in freshly-read content, verifying identity
 * (text + status + indent) so a toggle never flips the wrong line or
 * double-flips a task an external edit already changed. Returns the captured
 * line if it still matches, else the unique matching line, else -1 (ambiguous
 * or gone → the caller refuses to write). */
function locateTask(lines: string[], task: Task): number {
  const matches = (line: string): boolean => {
    const m = /^(\s*)[-*+]\s+\[(.)\]\s+(.*)$/.exec(line.replace(/\r$/, ""));
    return !!m && m[3] === task.text && m[2] === task.status && m[1].length === task.indent;
  };
  if (task.line < lines.length && matches(lines[task.line])) return task.line;
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    if (matches(lines[i])) {
      if (found >= 0) return -1; // ambiguous — refuse rather than guess
      found = i;
    }
  }
  return found;
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


// Which edge of a pane a tab is being dropped on (for drag-to-split), or
// "center" (no split — the tab bar handles moving a tab into a pane).
type PaneEdge = "left" | "right" | "top" | "bottom";
function pickEdge(fx: number, fy: number): PaneEdge | "center" {
  const d: Record<PaneEdge, number> = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  const min = Math.min(d.left, d.right, d.top, d.bottom);
  if (min > 0.3) return "center"; // near the middle → don't split
  return (Object.keys(d) as PaneEdge[]).find((k) => d[k] === min)!;
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
  const [versionSnapshots, setVersionSnapshots] = useState<Snapshot[]>([]);
  const [recentVaults, setRecentVaults] = useState<RecentVault[]>(() => loadRecentVaults());
  // Sidebar visibility + UI zoom (Obsidian parity: ⌘\ / ⌘⌥\ , ⌘+ / ⌘- / ⌘0).
  // Resizable sidebar widths (persisted). Clamped so neither can swallow the editor.
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    document.documentElement.style.fontSize = `${Math.round(16 * zoom)}px`;
  }, [zoom]);
  const zoomBy = useCallback((d: number) => setZoom((z) => Math.max(0.6, Math.min(2, Math.round((z + d) * 20) / 20))), []);
  // A pending template prompt (tp.system.prompt) awaiting user input.
  const [templatePrompt, setTemplatePrompt] = useState<{
    message: string;
    def: string;
    resolve: (v: string | null) => void;
  } | null>(null);
  // Imperative handle to the FOCUSED editor (for inserting a template at the caret).
  const editorApiRef = useRef<EditorApi | null>(null);
  // Plugins: installed manifests, a version that bumps when the plugin registry
  // (commands/processors) changes, and transient notices (toasts).
  const [installedPlugins, setInstalledPlugins] = useState<PluginInfo[]>([]);
  const [pluginVersion, setPluginVersion] = useState(0);
  const [notices, setNotices] = useState<{ id: number; msg: string }[]>([]);
  const noticeSeq = useRef(0);
  const [graphOpen, setGraphOpen] = useState(false);
  const [slidesOpen, setSlidesOpen] = useState(false);
  // Caret position for the status bar (from the focused editor).
  const [cursor, setCursor] = useState<{ line: number; col: number; sel: number } | null>(null);
  const handleCursor = useCallback((line: number, col: number, sel: number) => setCursor({ line, col, sel }), []);
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
  // Readable line length (Obsidian default ON): constrains editor/reading width.
  const [readableWidth, setReadableWidth] = useState(
    () => localStorage.getItem("basalt-readable-width") !== "false",
  );
  useEffect(() => {
    localStorage.setItem("basalt-readable-width", String(readableWidth));
  }, [readableWidth]);
  const [vim, setVim] = useState(() => localStorage.getItem("basalt-vim") === "true");
  useEffect(() => localStorage.setItem("basalt-vim", String(vim)), [vim]);
  const [rtl, setRtl] = useState(() => localStorage.getItem("basalt-rtl") === "true");
  useEffect(() => localStorage.setItem("basalt-rtl", String(rtl)), [rtl]);
  // Appearance: base font size (px) + accent override ("" = theme default).
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem("basalt-font-size")) || 16);
  useEffect(() => {
    document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
    localStorage.setItem("basalt-font-size", String(fontSize));
  }, [fontSize]);
  const [accent, setAccent] = useState(() => localStorage.getItem("basalt-accent") ?? "");
  useEffect(() => {
    if (accent) {
      document.documentElement.style.setProperty("--accent", accent);
      localStorage.setItem("basalt-accent", accent);
    } else {
      document.documentElement.style.removeProperty("--accent");
      localStorage.removeItem("basalt-accent");
    }
  }, [accent]);
  // Font families ("" = Basalt default). Imported from Obsidian; a single family
  // is prepended to Basalt's fallback stack so it degrades if not installed.
  const [fontText, setFontText] = useState(() => localStorage.getItem("basalt-font-text") ?? "");
  useEffect(() => {
    if (fontText) {
      document.documentElement.style.setProperty("--font-text", `"${fontText}", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`);
      localStorage.setItem("basalt-font-text", fontText);
    } else {
      document.documentElement.style.removeProperty("--font-text");
      localStorage.removeItem("basalt-font-text");
    }
  }, [fontText]);
  const [fontMono, setFontMono] = useState(() => localStorage.getItem("basalt-font-mono") ?? "");
  useEffect(() => {
    if (fontMono) {
      document.documentElement.style.setProperty("--font-mono", `"${fontMono}", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`);
      localStorage.setItem("basalt-font-mono", fontMono);
    } else {
      document.documentElement.style.removeProperty("--font-mono");
      localStorage.removeItem("basalt-font-mono");
    }
  }, [fontMono]);
  // An imported Obsidian theme's palette (per mode), bridged onto Basalt's vars.
  const [importedPalette, setImportedPalette] = useState<{ dark: ThemePalette; light: ThemePalette } | null>(() => {
    try {
      const raw = localStorage.getItem("basalt-imported-palette");
      return raw ? (JSON.parse(raw) as { dark: ThemePalette; light: ThemePalette }) : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (importedPalette) localStorage.setItem("basalt-imported-palette", JSON.stringify(importedPalette));
    else localStorage.removeItem("basalt-imported-palette");
  }, [importedPalette]);
  // Apply the palette for the CURRENT resolved theme; re-applies on theme switch.
  useEffect(() => {
    applyThemePalette(importedPalette ? (dark ? importedPalette.dark : importedPalette.light) : null);
  }, [importedPalette, dark]);
  const [spellcheck, setSpellcheck] = useState(() => localStorage.getItem("basalt-spellcheck") !== "false");
  useEffect(() => {
    localStorage.setItem("basalt-spellcheck", String(spellcheck));
  }, [spellcheck]);
  // User-assigned command hotkeys (global preference; see lib/hotkeys.ts).
  const [hotkeys, setHotkeys] = useState<Bindings>(() => loadBindings());
  useEffect(() => saveBindings(hotkeys), [hotkeys]);
  const [rightTab, setRightTab] = useState<string>("backlinks");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  // Seeds the search palette when opened from a tag / search bookmark.
  const [searchSeed, setSearchSeed] = useState("");
  const [fileMenu, setFileMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ paneId: string; path: string; x: number; y: number } | null>(null);
  // Editor right-click context menu position (uses editorApiRef for its actions).
  const [editorMenu, setEditorMenu] = useState<{ x: number; y: number } | null>(null);
  // A tab drag is in progress (show the pane edge drop-zones) + the hovered edge.
  const [tabDragging, setTabDragging] = useState(false);
  const [dropEdge, setDropEdge] = useState<{ paneId: string; edge: PaneEdge } | null>(null);
  const [attMenu, setAttMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folderRel: string; x: number; y: number } | null>(null);
  // Parent rel for a pending "New folder…" prompt ("" = vault root).
  const [subfolderParent, setSubfolderParent] = useState<string | null>(null);
  // Folder rel pending a "Rename folder…" prompt.
  const [renameFolderTarget, setRenameFolderTarget] = useState<string | null>(null);
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
  // A focused .canvas/.base is a read-only viewer, not an editable note: the
  // toolbar, outline, export/print, and reading/source toggles must not treat
  // it as one.
  const activeIsViewer = !!active && isViewerPath(active.path);
  // .base is read-only; .canvas is editable (autosaves), so only .base shows the
  // "Read-only" status. Export/outline/reading toggles stay off for both.
  const activeIsBase = !!active && /\.base$/i.test(active.path);

  const activePathRef = useRef<string | null>(null);
  activePathRef.current = active?.path ?? null;
  // The most recently active REAL note (not a view tab) — view leaves (Outline,
  // Backlinks…) track this rather than the pane they happen to live in.
  const [lastNotePath, setLastNotePath] = useState<string | null>(null);
  const lastNotePathRef = useRef<string | null>(null);
  lastNotePathRef.current = lastNotePath;
  useEffect(() => {
    if (active?.path && !isViewPath(active.path)) setLastNotePath(active.path);
  }, [active?.path]);
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

  // Stable index accessors for the Bases viewer (index is a ref, so these
  // never change identity; BaseView invalidates its rows via structureVersion
  // plus per-note object identity).
  const tagsOf = useCallback((path: string) => index.current.tagsOf(path), []);
  const linkKeysOf = useCallback((path: string) => index.current.linkKeysOf(path), []);

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
          // Local version-history snapshot (throttled + pruned inside).
          const vkey = vaultRef.current;
          if (vkey) void recordSnapshot(vkey, meta.rel, doc, Date.now());
          // Refresh stats so a Bases view sorting/filtering on file.mtime/size
          // reflects this save immediately (ctime is preserved).
          const updated: VaultNote = {
            ...meta,
            content: doc,
            mtime: Date.now(),
            size: new TextEncoder().encode(doc).length,
          };
          index.current.setNote(updated);
          setNotes((prev) => prev.map((n) => (n.path === path ? updated : n)));
          bumpIndex();
          emitVaultEvent("modify", { path: meta.rel, name: meta.name });
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
        // the failed write, and never resurrect pending for a note that has
        // been deleted meanwhile (a phantom entry would block vault switches).
        if (!pending.current.has(path) && notesRef.current.some((n) => n.path === path)) {
          pending.current.set(path, doc);
        }
        setSaveError(String(e));
      } finally {
        setSaving(false);
      }
    },
    [bumpIndex, rememberSelfWrite],
  );

  // Flush ONE editable viewer's (.canvas / .base) pending edit. Same
  // pending/conflict discipline as flushSave, but writes via the extension-gated
  // writeCanvas/writeBase and updates the attachment (not the note index).
  const flushViewer = useCallback(
    async (path: string, doc: string) => {
      setSaving(true);
      try {
        const att = attachmentsRef.current.find((a) => a.path === path);
        const rel = att?.rel;
        const write = /\.base$/i.test(path) ? writeBase : writeCanvas;
        // Pre-write conflict guard (closes the race where an external edit lands
        // during the async rescan window): if disk has diverged from the last
        // content Basalt knew was there — and isn't already what we're writing —
        // raise a conflict instead of clobbering the external change.
        if (rel !== undefined) {
          const onDisk = await readNote(path).catch(() => null);
          const baseline = selfWrites.current.get(rel);
          if (onDisk !== null && baseline !== undefined && onDisk !== baseline && onDisk !== doc) {
            addConflict(path);
            if (!pending.current.has(path)) pending.current.set(path, doc);
            return;
          }
        }
        await write(path, doc);
        setSaveError(null);
        if (rel !== undefined) rememberSelfWrite(rel, doc); // AFTER a successful write
        if (conflictsRef.current.has(path)) {
          if (!pending.current.has(path)) pending.current.set(path, doc);
        } else if (pending.current.get(path) === doc) {
          pending.current.delete(path);
          const t = saveTimers.current.get(path);
          if (t !== undefined) {
            window.clearTimeout(t);
            saveTimers.current.delete(path);
          }
        }
      } catch (e) {
        if (!pending.current.has(path) && attachmentsRef.current.some((a) => a.path === path)) {
          pending.current.set(path, doc);
        }
        setSaveError(String(e));
      } finally {
        setSaving(false);
      }
    },
    [rememberSelfWrite, addConflict],
  );

  // An edit from an editable viewer (CanvasView / BaseView): same debounced,
  // conflict-safe, sibling-syncing path as note autosave (keyed by path).
  const handleViewerChange = useCallback(
    (paneId: string, path: string, doc: string) => {
      pending.current.set(path, doc);
      patchPane(paneId, { doc }); // keep the pane's doc current (restore/rescan)
      for (const p of Object.values(panesRef.current)) {
        if (p.id !== paneId && p.active === path) patchPane(p.id, { doc });
      }
      const existing = saveTimers.current.get(path);
      if (existing !== undefined) window.clearTimeout(existing);
      saveTimers.current.set(
        path,
        window.setTimeout(() => {
          saveTimers.current.delete(path);
          if (conflictsRef.current.has(path)) return;
          const d = pending.current.get(path);
          if (d === undefined) return;
          void flushViewer(path, d);
        }, SAVE_DEBOUNCE_MS),
      );
    },
    [flushViewer, patchPane],
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
      if (isViewerPath(path)) await flushViewer(path, doc);
      else await flushSave(path, doc); // both delete `pending` on success
    },
    [flushSave, flushViewer],
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
    // Notes must never open into a sidebar dock — only into an editor pane.
    if (cur && panesRef.current[cur] && !panesRef.current[cur].dock) return cur;
    const editor = Object.values(panesRef.current).find((p) => !p.dock);
    if (editor) {
      focusedIdRef.current = editor.id;
      setFocusedId(editor.id);
      return editor.id;
    }
    // Only docks (or empty): make a fresh editor pane on the left of the layout.
    const id = `pane${(paneCounter.current += 1)}`;
    const pane: Pane = { id, tabs: [], active: null, doc: "" };
    const lay = layoutRef.current;
    const leaf: LayoutNode = { kind: "leaf", id };
    const nextLayout: LayoutNode = lay
      ? { kind: "split", dir: "row", sizes: [0.78, 0.22], children: [leaf, lay] }
      : leaf;
    panesRef.current = { ...panesRef.current, [id]: pane };
    layoutRef.current = nextLayout;
    focusedIdRef.current = id;
    setPanes((ps) => ({ ...ps, [id]: pane }));
    setLayout(nextLayout);
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

  // Show/hide the right sidebar dock (a leaf in the layout tree). Hiding removes
  // its leaf; showing grafts a fresh dock onto the right of the whole layout.
  const toggleRightDock = useCallback(() => {
    const dockEntry = Object.entries(panesRef.current).find(([, p]) => p.dock === "right");
    if (dockEntry) {
      removePaneFromWorkspace(dockEntry[0]);
      return;
    }
    const lay = layoutRef.current;
    const id = `pane${(paneCounter.current += 1)}`;
    const dock = makeRightDock(id);
    const leaf: LayoutNode = { kind: "leaf", id };
    const nextLayout: LayoutNode = lay
      ? { kind: "split", dir: "row", sizes: [0.78, 0.22], children: [lay, leaf] }
      : leaf;
    panesRef.current = { ...panesRef.current, [id]: dock };
    layoutRef.current = nextLayout;
    setPanes((ps) => ({ ...ps, [id]: dock }));
    setLayout(nextLayout);
  }, [removePaneFromWorkspace]);

  // Show/hide the left sidebar dock (the file explorer) as a layout leaf.
  const toggleLeftDock = useCallback(() => {
    const dockEntry = Object.entries(panesRef.current).find(([, p]) => p.dock === "left");
    if (dockEntry) {
      removePaneFromWorkspace(dockEntry[0]);
      return;
    }
    const lay = layoutRef.current;
    const id = `pane${(paneCounter.current += 1)}`;
    const dock = makeLeftDock(id);
    const leaf: LayoutNode = { kind: "leaf", id };
    const nextLayout: LayoutNode = lay
      ? { kind: "split", dir: "row", sizes: [0.18, 0.82], children: [leaf, lay] }
      : leaf;
    panesRef.current = { ...panesRef.current, [id]: dock };
    layoutRef.current = nextLayout;
    setPanes((ps) => ({ ...ps, [id]: dock }));
    setLayout(nextLayout);
  }, [removePaneFromWorkspace]);

  // Open `path` in a specific pane (adds the tab, loads the doc, focuses it).
  // `mirror` marks a follow-open into a linked pane: it doesn't steal focus and
  // doesn't re-mirror, so a linked pair can't ping-pong.
  const openInPane = useCallback(
    async (id: string, path: string, line?: number, mirror = false) => {
      const pane = panesRef.current[id];
      if (!pane) return;
      // A view tab (file tree, outline, plugin view…) has no note to load: just
      // add/activate it. No readNote, recents, or workspace events.
      if (isViewPath(path)) {
        focusPane(id);
        if (pane.active === path) return;
        const tabs = pane.tabs.includes(path) ? pane.tabs : [...pane.tabs, path];
        patchPane(id, { tabs, active: path, doc: "" });
        return;
      }
      // A linked pane follows the note the user opens elsewhere, so mirror BEFORE
      // the same-active early return (the source pane may already show `path`).
      if (!mirror) {
        for (const p of Object.values(panesRef.current)) {
          if (p.id !== id && p.linked && p.active !== path && !isViewerPath(path)) void openInPane(p.id, path, undefined, true);
        }
      }
      if (!mirror) focusPane(id);
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
      // For an editable viewer (.canvas), record the loaded content as the disk
      // baseline: watcher echoes of it are suppressed, and flushCanvas compares
      // against it to refuse clobbering an external change (see flushCanvas).
      if (isViewerPath(path)) {
        const arel = attachmentsRef.current.find((a) => a.path === path)?.rel;
        if (arel) rememberSelfWrite(arel, doc);
      }
      const rel = notesRef.current.find((n) => n.path === path)?.rel;
      if (!mirror) {
        const openedName = rel ? nameFromRel(rel) : (attachmentsRef.current.find((a) => a.path === path)?.name ?? path);
        const openedFile = { path: rel ?? path, name: openedName };
        emitWorkspaceEvent("file-open", openedFile);
        emitWorkspaceEvent("active-leaf-change", openedFile);
      }
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
    [flushPath, focusPane, patchPane, rememberSelfWrite],
  );

  // Restore the default three-region layout (file tree | editor | right dock) —
  // an escape hatch now that every panel can be closed or rearranged. Keeps the
  // last active note open in the fresh editor pane.
  const resetWorkspace = useCallback(() => {
    const keep = lastNotePathRef.current;
    const leftId = `pane${(paneCounter.current += 1)}`;
    const centerId = `pane${(paneCounter.current += 1)}`;
    const rightId = `pane${(paneCounter.current += 1)}`;
    const nextPanes: Record<string, Pane> = {
      [leftId]: makeLeftDock(leftId),
      [centerId]: { id: centerId, tabs: [], active: null, doc: "" },
      [rightId]: makeRightDock(rightId),
    };
    const lay: LayoutNode = {
      kind: "split",
      dir: "row",
      sizes: [0.18, 0.6, 0.22],
      children: [
        { kind: "leaf", id: leftId },
        { kind: "leaf", id: centerId },
        { kind: "leaf", id: rightId },
      ],
    };
    panesRef.current = nextPanes;
    layoutRef.current = lay;
    focusedIdRef.current = centerId;
    setPanes(nextPanes);
    setLayout(lay);
    setFocusedId(centerId);
    if (keep) void openInPane(centerId, keep);
  }, [openInPane]);

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
  // Pin/unpin a tab in a pane (a pinned tab can't be closed).
  const togglePin = useCallback(
    (id: string, path: string) => {
      const pane = panesRef.current[id];
      if (!pane) return;
      const cur = pane.pinned ?? [];
      const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path];
      patchPane(id, { pinned: next.length ? next : undefined });
    },
    [patchPane],
  );

  // Toggle "linked" on a pane — a linked pane follows notes opened elsewhere.
  const toggleLink = useCallback(
    (id: string) => patchPane(id, { linked: !panesRef.current[id]?.linked }),
    [patchPane],
  );

  // Toggle "stacked" on a pane — show all its tabs as a horizontal spread.
  const toggleStacked = useCallback(
    (id: string) => patchPane(id, { stacked: !panesRef.current[id]?.stacked }),
    [patchPane],
  );

  // Bookmark / unbookmark a note (writes .obsidian/bookmarks.json), then refresh.
  const toggleBookmark = useCallback(async (notePath: string) => {
    try {
      await toggleFileBookmark(notePath);
      setBookmarks(await readObsidianBookmarks().catch(() => []));
    } catch (e) {
      setSaveError(`Couldn't update bookmark: ${e}`);
    }
  }, []);

  const closeTab = useCallback(
    async (id: string, path: string) => {
      const pane = panesRef.current[id];
      if (!pane) return;
      if (pane.pinned?.includes(path)) {
        setSaveError("Unpin the tab before closing it");
        return;
      }
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

  // Drag a tab to reorder it within its pane, or move it to another pane. A
  // cross-pane move reuses openInPane (safe content load) + closeTab (safe
  // flush), so the note-content path stays protected; only tab placement moves.
  const handleTabDrop = useCallback(
    async (fromId: string, path: string, toId: string, toIndex: number) => {
      if (fromId === toId) {
        const pane = panesRef.current[toId];
        if (!pane || !pane.tabs.includes(path)) return;
        patchPane(toId, { tabs: reorderTabs(pane.tabs, path, toIndex) });
        return;
      }
      // Moving out of the source: a pinned tab can't be closed, so unpin it
      // there first (the move implies it's no longer pinned in the origin).
      const src = panesRef.current[fromId];
      if (src?.pinned?.includes(path)) {
        const pinned = src.pinned.filter((p) => p !== path);
        patchPane(fromId, { pinned: pinned.length ? pinned : undefined });
      }
      await openInPane(toId, path); // loads content, activates in target, focuses it
      const tp = panesRef.current[toId];
      if (tp) patchPane(toId, { tabs: insertTab(tp.tabs, path, toIndex) });
      await closeTab(fromId, path); // removes the origin tab (note stays open in target)
    },
    [openInPane, closeTab, patchPane],
  );

  // Drop a dragged tab on a pane EDGE → split that pane in the edge's direction
  // and move the tab into the new split (Obsidian's drag-to-split).
  const handleTabDropToEdge = useCallback(
    async (fromId: string, path: string, targetId: string, edge: PaneEdge) => {
      const lay = layoutRef.current;
      const from = panesRef.current[fromId];
      if (!lay || !panesRef.current[targetId]) return;
      // Can't split a pane off itself when the dragged tab is its only tab.
      if (fromId === targetId && from && from.tabs.length <= 1) return;
      const dir: Dir = edge === "left" || edge === "right" ? "row" : "col";
      const before = edge === "left" || edge === "top";
      const newId = `pane${(paneCounter.current += 1)}`;
      const newPane: Pane = { id: newId, tabs: [], active: null, doc: "" };
      const nextLayout = splitLeaf(lay, targetId, newId, dir, before);
      panesRef.current = { ...panesRef.current, [newId]: newPane };
      layoutRef.current = nextLayout;
      setPanes((ps) => ({ ...ps, [newId]: newPane }));
      setLayout(nextLayout);
      // Moving out of the source: unpin there first (a pinned tab can't close).
      if (from?.pinned?.includes(path)) {
        const pinned = from.pinned.filter((p) => p !== path);
        patchPane(fromId, { pinned: pinned.length ? pinned : undefined });
      }
      await openInPane(newId, path); // load + activate + focus the new split
      await closeTab(fromId, path); // remove the origin tab (may drop an emptied pane)
    },
    [openInPane, closeTab, patchPane],
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

  // Tab context-menu actions.
  const closeOtherTabs = useCallback(
    async (id: string, keep: string) => {
      const pane = panesRef.current[id];
      if (!pane) return;
      for (const p of pane.tabs.filter((t) => t !== keep && !pane.pinned?.includes(t))) await closeTab(id, p);
    },
    [closeTab],
  );
  const closeTabsToRight = useCallback(
    async (id: string, path: string) => {
      const pane = panesRef.current[id];
      if (!pane) return;
      const idx = pane.tabs.indexOf(path);
      if (idx < 0) return;
      for (const p of pane.tabs.slice(idx + 1).filter((t) => !pane.pinned?.includes(t))) await closeTab(id, p);
    },
    [closeTab],
  );
  /** Open `path` (from pane `id`) in a fresh vertical split. */
  const splitTabRight = useCallback(
    async (id: string, path: string) => {
      focusPane(id);
      await openInPane(id, path); // make it active so the split carries it
      splitFocused("row");
    },
    [focusPane, openInPane, splitFocused],
  );
  /** Open a note (by path) in a fresh vertical split (file menu "Open to the right"). */
  const openInNewSplit = useCallback(
    async (path: string) => {
      splitFocused("row"); // new pane becomes focused, carrying the current active
      const newId = focusedIdRef.current;
      if (newId) await openInPane(newId, path);
    },
    [splitFocused, openInPane],
  );
  /** Duplicate a note next to itself ("… copy") and open the copy. */
  const handleDuplicateNote = useCallback(
    async (path: string) => {
      const root = vaultRef.current;
      const note = notesRef.current.find((n) => n.path === path);
      if (!root || !note || !isMarkdownPath(path)) return;
      try {
        const content = await readNote(path);
        const dir = note.rel.replace(/[^/\\]+$/, "");
        const copyPath = await createNote(`${dir}${note.name} copy`);
        await writeNote(copyPath, content);
        const rel = copyPath.startsWith(root) ? copyPath.slice(root.length).replace(/^[/\\]+/, "") : copyPath;
        const copy: VaultNote = { path: copyPath, rel, name: nameFromRel(rel), content };
        index.current.setNote(copy);
        setNotes((prev) => [...prev, copy].sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase())));
        rememberSelfWrite(rel, content);
        bumpStructure();
        emitVaultEvent("create", { path: rel, name: copy.name });
        await openNoteByPath(copyPath);
      } catch (e) {
        setSaveError(`Couldn't duplicate: ${e}`);
      }
    },
    [openNoteByPath, rememberSelfWrite, bumpStructure],
  );

  // Rebuild the saved tab/split layout for a vault. Tabs pointing at notes that
  // no longer exist are dropped; emptied panes are removed; active docs are
  // loaded from disk. Every path yields a VALID workspace: malformed/absent
  // state falls back to the default (an editor pane + a right dock), and a
  // restored layout without a right dock gets one grafted on (v1/v2 migration).
  const restoreWorkspace = useCallback(
    async (savedWs: string | null, list: VaultNote[], atts: Attachment[]) => {
      const commit = (rebuilt: Record<string, Pane>, lay: LayoutNode, focus: string | null) => {
        panesRef.current = rebuilt;
        layoutRef.current = lay;
        focusedIdRef.current = focus;
        setPanes(rebuilt);
        setLayout(lay);
        setFocusedId(focus);
      };
      const rightDockLeaf = (): { pane: Pane; leaf: LayoutNode } => {
        const id = `pane${(paneCounter.current += 1)}`;
        return { pane: makeRightDock(id), leaf: { kind: "leaf", id } };
      };
      const leftDockLeaf = (): { pane: Pane; leaf: LayoutNode } => {
        const id = `pane${(paneCounter.current += 1)}`;
        return { pane: makeLeftDock(id), leaf: { kind: "leaf", id } };
      };
      // A fresh workspace: file-tree dock | editor | right dock.
      const buildDefault = () => {
        const left = leftDockLeaf();
        const centerId = `pane${(paneCounter.current += 1)}`;
        const center: Pane = { id: centerId, tabs: [], active: null, doc: "" };
        const right = rightDockLeaf();
        const lay: LayoutNode = {
          kind: "split",
          dir: "row",
          sizes: [0.18, 0.6, 0.22],
          children: [left.leaf, { kind: "leaf", id: centerId }, right.leaf],
        };
        commit({ [left.pane.id]: left.pane, [centerId]: center, [right.pane.id]: right.pane }, lay, centerId);
      };

      if (!savedWs) return buildDefault();
      let ws: SavedWorkspace;
      try {
        ws = JSON.parse(savedWs) as SavedWorkspace;
        if (!ws.layout || !ws.panes) return buildDefault();
      } catch {
        return buildDefault();
      }
      // Notes AND attachments (.canvas) are valid tab paths.
      const exists = new Set([...list.map((n) => n.path), ...atts.map((a) => a.path)]);
      let ids: string[];
      try {
        ids = leafIds(ws.layout);
      } catch {
        return buildDefault();
      }
      const rebuilt: Record<string, Pane> = {};
      let maxN = 0;
      for (const id of ids) {
        const saved = ws.panes[id];
        const m = /(\d+)$/.exec(id);
        if (m) maxN = Math.max(maxN, Number(m[1]));
        // View tabs (sentinels) are always valid; note tabs must exist on disk.
        const tabs = (saved?.tabs ?? []).filter((p) => isViewPath(p) || exists.has(p));
        if (tabs.length === 0) continue; // pane will be pruned from the layout
        const active = saved?.active && tabs.includes(saved.active) ? saved.active : tabs[0];
        let doc = "";
        if (!isViewPath(active)) {
          try {
            doc = await readNote(active);
          } catch {
            doc = "";
          }
        }
        const pinned = (saved?.pinned ?? []).filter((p) => tabs.includes(p));
        rebuilt[id] = { id, tabs, active, doc, pinned: pinned.length ? pinned : undefined, linked: saved?.linked, stacked: saved?.stacked, dock: saved?.dock };
      }
      // Drop layout leaves with no surviving pane.
      let lay: LayoutNode | null = ws.layout;
      for (const id of ids) if (!rebuilt[id] && lay) lay = removeLeaf(lay, id);
      if (!lay || Object.keys(rebuilt).length === 0) return buildDefault();
      paneCounter.current = Math.max(paneCounter.current, maxN);
      // One-time migration: pre-v3 workspaces (fixed sidebars) get docks grafted
      // on. A v3 workspace is respected as-is, so a dock the user closed stays
      // closed across reloads.
      if ((ws.version ?? 1) < WORKSPACE_VERSION) {
        if (!Object.values(rebuilt).some((p) => p.dock === "left")) {
          const dock = leftDockLeaf();
          rebuilt[dock.pane.id] = dock.pane;
          lay = { kind: "split", dir: "row", sizes: [0.18, 0.82], children: [dock.leaf, lay] };
        }
        if (!Object.values(rebuilt).some((p) => p.dock === "right")) {
          const dock = rightDockLeaf();
          rebuilt[dock.pane.id] = dock.pane;
          lay = { kind: "split", dir: "row", sizes: [0.82, 0.18], children: [lay, dock.leaf] };
        }
      }
      const focus = ws.focusedId && rebuilt[ws.focusedId] ? ws.focusedId : firstLeafId(lay);
      commit(rebuilt, lay, focus);
    },
    [],
  );

  const openVault = useCallback(
    async (path: string, openNoteRel?: string) => {
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
        savedTab === "outline" || savedTab === "tags" || savedTab === "bookmarks" || savedTab === "links"
          ? savedTab
          : "backlinks",
      );
      setSourceMode(localStorage.getItem(`basalt.sourceMode.${root}`) === "1");
      setReadingMode(localStorage.getItem(`basalt.reading.${root}`) === "1");
      setVault(root);
      setRecentVaults(pushRecentVault(root, Date.now()));
      if (WINDOW_LABEL === "main") {
        // The main window auto-restores its last vault on next launch.
        localStorage.setItem(LAST_VAULT_KEY, root);
      } else {
        // A secondary window's vault lives in its URL (?vault=) so a reload/F5
        // restores THIS vault — even after the user switched vaults in it.
        try {
          history.replaceState(null, "", `${location.pathname}?vault=${encodeURIComponent(root)}`);
        } catch {
          /* non-fatal */
        }
      }
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
      // "Move tab to new window" spawns a window that opens the note directly —
      // use the freshly loaded list (notesRef isn't updated until a render).
      if (openNoteRel) {
        const target = list.find((n) => n.rel === openNoteRel);
        if (target) await openInPane(ensureWorkspace(), target.path);
      }
      await listenerReady.current?.promise; // ensure we can hear events first
      startWatching().catch(() => {
        /* watcher unavailable — degrade gracefully */
      });
    },
    [flushAll, loadVault, restoreWorkspace, openInPane, ensureWorkspace],
  );

  // Restore the last vault on launch (once — StrictMode double-mounts effects).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    // A window opened via "open in new window" carries its vault in ?vault=.
    // Otherwise the main window restores its last vault; a bare extra window
    // starts at the picker.
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get("vault");
    if (fromUrl) {
      // A window spawned by "move tab to new window" also carries ?note=<rel>.
      openVault(fromUrl, params.get("note") ?? undefined).catch((e) => setSaveError(`Couldn't open vault: ${e}`));
      return;
    }
    if (WINDOW_LABEL !== "main") return;
    const last = localStorage.getItem(LAST_VAULT_KEY);
    if (last) {
      openVault(last).catch(() => localStorage.removeItem(LAST_VAULT_KEY));
    }
  }, [openVault]);

  // Handle `basalt://open?vault=…&note=…` deep links (from the CLI). Only the
  // main window responds. A URL the app launched with is taken once; links that
  // arrive while running come via the `deep-link-open` event. Identical URLs are
  // de-duped (a launch link can surface through both paths on some platforms).
  const lastDeepLink = useRef<string>("");
  useEffect(() => {
    if (WINDOW_LABEL !== "main") return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const handle = (url: string) => {
      if (!url || url === lastDeepLink.current) return;
      lastDeepLink.current = url;
      const parsed = parseBasaltUri(url);
      if (!parsed) return;
      // If the target vault is already open, just navigate — don't reset the
      // workspace by re-opening it.
      if (vaultRef.current === parsed.vault) {
        const target = parsed.note ? notesRef.current.find((n) => n.rel === parsed.note) : null;
        if (target) openInPane(ensureWorkspace(), target.path);
        return;
      }
      openVault(parsed.vault, parsed.note).catch((e) => setSaveError(`Couldn't open link: ${e}`));
    };
    takePendingDeepLink()
      .then((u) => {
        if (!cancelled && u) handle(u);
      })
      .catch(() => {
        /* not running under Tauri (e.g. harness) */
      });
    listen<string>("deep-link-open", (e) => handle(e.payload))
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {
        /* event unavailable */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openVault, openInPane, ensureWorkspace]);

  // Persist the workspace (layout + tabs + active + focus, NOT live docs) per
  // vault. Keyed on the structural projection so per-keystroke doc syncs don't
  // write; restored on the next openVault.
  const lastSavedWs = useRef<string>("");
  useEffect(() => {
    const v = vaultRef.current;
    if (!v) return;
    const projected: SavedWorkspace["panes"] = {};
    for (const [id, p] of Object.entries(panes)) projected[id] = { tabs: p.tabs, active: p.active, pinned: p.pinned, linked: p.linked, stacked: p.stacked, dock: p.dock };
    const json = JSON.stringify({ version: WORKSPACE_VERSION, layout, panes: projected, focusedId });
    if (json === lastSavedWs.current) return;
    lastSavedWs.current = json;
    try {
      localStorage.setItem(workspaceKey(v), json);
    } catch {
      /* ignore */
    }
  }, [layout, panes, focusedId]);

  // Keep plugin-registered views present as tabs in the right dock: add a tab
  // when a plugin registers a view, remove it when the plugin unloads.
  useEffect(() => {
    const dockEntry = Object.entries(panesRef.current).find(([, p]) => p.dock === "right");
    if (!dockEntry) return;
    const [dockId, dock] = dockEntry;
    const views = pluginRightViews();
    const wantIds = new Set(views.map((v) => v.id));
    const kept = dock.tabs.filter((p) => {
      const spec = parseViewPath(p);
      return spec?.type !== "plugin" || wantIds.has(spec.viewId);
    });
    const missing = views
      .map((v) => viewPath({ type: "plugin", viewId: v.id }))
      .filter((p) => !kept.includes(p));
    const next = [...kept, ...missing];
    if (next.length === dock.tabs.length && next.every((p, i) => p === dock.tabs[i])) return;
    const active = dock.active && next.includes(dock.active) ? dock.active : (next[0] ?? null);
    patchPane(dockId, { tabs: next, active });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginVersion]);

  // Named workspaces (save/switch layouts) — Obsidian's Workspaces plugin.
  const [namedWorkspaces, setNamedWorkspaces] = useState<Record<string, SavedWorkspace>>({});
  useEffect(() => {
    setNamedWorkspaces(vault ? loadNamedWorkspaces(vault) : {});
  }, [vault]);
  const persistNamedWorkspaces = useCallback((next: Record<string, SavedWorkspace>) => {
    setNamedWorkspaces(next);
    const v = vaultRef.current;
    if (v) {
      try {
        localStorage.setItem(namedWsKey(v), JSON.stringify(next));
      } catch {
        /* quota — non-fatal */
      }
    }
  }, []);
  /** The current layout as a serializable workspace. */
  const captureWorkspace = useCallback((): SavedWorkspace | null => {
    if (!layoutRef.current) return null;
    const projected: SavedWorkspace["panes"] = {};
    for (const [id, p] of Object.entries(panesRef.current)) {
      projected[id] = { tabs: p.tabs, active: p.active, pinned: p.pinned, linked: p.linked, stacked: p.stacked, dock: p.dock };
    }
    return { layout: layoutRef.current, panes: projected, focusedId: focusedIdRef.current };
  }, []);
  const saveWorkspaceAs = useCallback(
    (name: string) => {
      const ws = captureWorkspace();
      if (!name.trim() || !ws) return;
      persistNamedWorkspaces({ ...namedWorkspaces, [name.trim()]: ws });
    },
    [captureWorkspace, namedWorkspaces, persistNamedWorkspaces],
  );
  const deleteWorkspace = useCallback(
    (name: string) => {
      const next = { ...namedWorkspaces };
      delete next[name];
      persistNamedWorkspaces(next);
    },
    [namedWorkspaces, persistNamedWorkspaces],
  );
  const loadWorkspace = useCallback(
    async (name: string) => {
      const ws = namedWorkspaces[name];
      if (!ws) return;
      await flushAll(); // don't lose unsaved edits from the current layout
      await restoreWorkspace(JSON.stringify(ws), notesRef.current, attachmentsRef.current);
    },
    [namedWorkspaces, flushAll, restoreWorkspace],
  );

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
      // View tabs (sentinels) have no backing file — never prune them.
      const keep = pane.tabs.filter((p) => isViewPath(p) || exists.has(p) || (p === pane.active && conf.has(p)));
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
        nextPanes[id] = { ...pane, tabs: keep, pinned: prunePins(pane, keep), active: null, doc: "", scrollToLine: undefined };
      } else {
        nextPanes[id] = { ...pane, tabs: keep, pinned: prunePins(pane, keep) };
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
    const attByPath = new Map(atts.map((a) => [a.path, a]));
    for (const p of Object.values(panesRef.current)) {
      if (!p.active) continue;
      // Viewer panes (.canvas/.base) are read-only attachments (not in
      // `notes`): re-read the file so external edits show; if it's gone the
      // prune effect closes the pane (attachmentsList was just refreshed).
      if (isViewerPath(p.active)) {
        if (attPaths.has(p.active)) {
          const id = p.id;
          const prevDoc = p.doc;
          const path = p.active;
          const rel = attByPath.get(path)?.rel;
          void readNote(path)
            .then((fresh) => {
              // Our OWN write echoing back through the watcher — ignore it (same
              // content-based suppression notes get via processChanges).
              if (rel !== undefined && selfWrites.current.get(rel) === fresh) return;
              if (fresh === prevDoc) return;
              // An editable canvas with unsaved edits: don't clobber them —
              // raise a conflict so the user chooses Reload / Keep mine.
              if (pending.current.has(path)) addConflict(path);
              else patchPane(id, { doc: fresh });
            })
            .catch(() => {
              /* removed between listing and read — prune handles it */
            });
        } else if (pending.current.has(p.active)) {
          addConflict(p.active); // canvas deleted externally but has unsaved edits
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
      } else if (e.key === "\\") {
        e.preventDefault();
        if (e.altKey) toggleRightDock();
        else toggleLeftDock();
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomBy(0.1);
      } else if (e.key === "-") {
        e.preventDefault();
        zoomBy(-0.1);
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomBy]);

  // Tab keyboard (focused pane): Mod-W closes the active tab; Ctrl-Tab /
  // Ctrl-Shift-Tab cycle.
  useEffect(() => {
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

  // Open a vault in a NEW window (or an empty new window if no vault given).
  const handleOpenInNewWindow = useCallback(async (vaultPath?: string, note?: string) => {
    try {
      await openNewWindow(vaultPath, note);
    } catch (e) {
      setSaveError(`Couldn't open a new window: ${e}`);
    }
  }, []);

  // Open a note in a new window (leaving it open here too).
  const openNoteInNewWindow = useCallback(
    async (path: string) => {
      const v = vaultRef.current;
      const rel = notesRef.current.find((n) => n.path === path)?.rel;
      if (v && rel) await handleOpenInNewWindow(v, rel);
    },
    [handleOpenInNewWindow],
  );

  // Move a note tab out to a new window: open it there, then close it here.
  const moveTabToNewWindow = useCallback(
    async (paneId: string, path: string) => {
      const v = vaultRef.current;
      const rel = notesRef.current.find((n) => n.path === path)?.rel;
      if (!v || !rel) return; // only real notes (not views/attachments) move out
      await handleOpenInNewWindow(v, rel);
      await closeTab(paneId, path);
    },
    [handleOpenInNewWindow, closeTab],
  );

  const openVaultSwitcher = useCallback(() => {
    setRecentVaults(loadRecentVaults()); // freshen (another window may have opened one)
    setModal("vaults");
  }, []);

  // The configured templates folder (Templater / core Templates plugin), else
  // "Templates". Notes under it are offered by the "Insert template" command.
  const templatesFolder = useCallback(
    () => (obsConfigRef.current?.templatesFolder || "Templates").replace(/\/+$/, ""),
    [],
  );
  const templateNotes = useCallback((): VaultNote[] => {
    const folder = templatesFolder().toLowerCase();
    return notesRef.current.filter((n) => n.rel.toLowerCase().startsWith(folder + "/"));
  }, [templatesFolder]);

  const askTemplatePrompt = useCallback(
    (message: string, def?: string) =>
      new Promise<string | null>((resolve) => setTemplatePrompt({ message, def: def ?? "", resolve })),
    [],
  );

  // Apply a template and insert it at the caret of the focused editor.
  const insertTemplate = useCallback(
    async (tpl: VaultNote) => {
      const api = editorApiRef.current;
      if (!api) {
        setSaveError("Open a note in the editor to insert a template");
        return;
      }
      try {
        const text = await readNote(tpl.path);
        const focused = focusedIdRef.current ? panesRef.current[focusedIdRef.current] : null;
        const targetPath = focused?.active ?? "";
        const target = notesRef.current.find((n) => n.path === targetPath);
        const rel = target?.rel ?? "";
        const ctx: TemplateCtx = {
          title: target?.name ?? basename(targetPath).replace(/\.md$/i, ""),
          folder: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
          path: rel,
          ctime: target?.ctime ?? Date.now(),
          now: Date.now(),
          dateFormat: obsConfigRef.current?.templatesDateFormat ?? undefined,
          timeFormat: obsConfigRef.current?.templatesTimeFormat ?? undefined,
          prompt: askTemplatePrompt,
        };
        const res = await applyTemplate(text, ctx);
        if (res.errors.length) setSaveError(res.errors[0]);
        api.insertAtCursor(res.text, res.cursor ?? undefined);
      } catch (e) {
        setSaveError(`Couldn't insert template: ${e}`);
      }
    },
    [askTemplatePrompt],
  );

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
    // A .canvas is an attachment (never in notesRef); check the right registry
    // so Keep-mine writes the local canvas instead of dropping it as "vanished".
    const stillExists = isViewerPath(path)
      ? attachmentsRef.current.some((a) => a.path === path)
      : notesRef.current.some((n) => n.path === path);
    if (!stillExists) {
      // Vanished externally — don't recreate it at a stale path; just close it.
      pending.current.delete(path);
      clearConflict(path);
      void closeTab(id, path);
      return;
    }
    clearConflict(path);
    await flushPath(path, true); // explicit Keep-mine: write despite the conflict
  }, [clearConflict, flushPath, closeTab]);

  // The note whose history is open — captured so a restore always targets it
  // even if focus moved to another note while the modal was up.
  const historyTargetRef = useRef<string | null>(null);

  // Load the focused note's local snapshot history and open the version modal.
  const openVersionHistory = useCallback(async () => {
    const id = focusedIdRef.current;
    const path = id ? panesRef.current[id]?.active : null;
    const vkey = vaultRef.current;
    if (!path || !isMarkdownPath(path) || !vkey) {
      setSaveError("Version history is only available for a note");
      return;
    }
    const meta = notesRef.current.find((n) => n.path === path);
    historyTargetRef.current = path;
    setVersionSnapshots(meta ? await listSnapshots(vkey, meta.rel) : []);
    setModal("history");
  }, []);

  // Restore a snapshot into the note the history was opened for (NOT whatever is
  // focused now): navigate to it if needed, then apply through the normal
  // conflict-safe autosave path.
  const restoreSnapshot = useCallback(
    async (content: string) => {
      const path = historyTargetRef.current;
      if (!path || !isMarkdownPath(path)) {
        setModal(null);
        return;
      }
      // Don't overwrite a note with an unresolved disk conflict — the restore
      // would silently not persist AND drop the conflicted local edits.
      if (conflictsRef.current.has(path)) {
        setSaveError("Resolve the “Changed on disk” conflict before restoring a version");
        setModal(null);
        return;
      }
      setModal(null);
      let id = focusedIdRef.current;
      if (!id || panesRef.current[id]?.active !== path) {
        await openNoteByPath(path); // bring the target note back into focus
        id = focusedIdRef.current;
      }
      if (!id || panesRef.current[id]?.active !== path) return;
      // Force-snapshot the CURRENT content first, so restoring is itself
      // reversible (the pre-restore state stays in the history).
      const vkey = vaultRef.current;
      const rel = notesRef.current.find((n) => n.path === path)?.rel;
      const cur = panesRef.current[id]?.doc;
      if (vkey && rel && cur) await recordSnapshot(vkey, rel, cur, Date.now(), true);
      patchPane(id, { doc: content }); // editor reconciles to the restored text
      handleChange(id, path, content); // mark dirty + autosave
    },
    [patchPane, handleChange, openNoteByPath],
  );

  const getNotes = useCallback(
    (): NoteRef[] => [
      ...notesRef.current.map((n) => ({ name: n.name, rel: n.rel })),
      // Frontmatter aliases as their own completions (picking one inserts the
      // alias text, which resolves via the index).
      ...index.current.allAliases().map((a) => ({ name: a.alias, rel: a.rel, alias: a.name })),
    ],
    [],
  );
  // Headings of the note a `[[Name#…` completion targets.
  const getHeadings = useCallback((name: string): string[] => {
    const path = index.current.resolve(name, activePathRef.current ?? "");
    const note = path ? notesRef.current.find((n) => n.path === path) : null;
    return note ? extractHeadings(note.content) : [];
  }, []);
  // Block ids of the note a `[[Name#^…` completion targets.
  const getBlockIds = useCallback((name: string): { id: string; snippet: string }[] => {
    const path = index.current.resolve(name, activePathRef.current ?? "");
    const note = path ? notesRef.current.find((n) => n.path === path) : null;
    return note ? extractBlockIds(note.content) : [];
  }, []);
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
    if (isViewerPath(path)) {
      setSaveError("Export to HTML is only available for notes.");
      return;
    }
    const note = notesRef.current.find((n) => n.path === path);
    const name = note?.name ?? "note";
    const rel = note?.rel ?? "";
    try {
      const dom = new DOMParser().parseFromString(`<div>${renderMarkdown(pane.doc)}</div>`, "text/html");
      // Render $…$ / $$…$$ math as MathML in-place (self-contained — browsers
      // render it with their own math fonts, no KaTeX assets to inline).
      if (dom.querySelector("[data-math]")) {
        const mathMod = await import("./lib/math");
        mathMod.fillMath(dom.body, true);
      }
      // Sanitize + insert raw HTML blocks.
      if (dom.querySelector("[data-basalt-html]")) {
        const sanMod = await import("./lib/sanitize");
        sanMod.fillRawHtml(dom.body);
      }
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
    if (pane?.active && isViewerPath(pane.active)) {
      setSaveError("Print / PDF is only available for notes.");
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
      // .canvas/.base open in a pane (read-only viewer); other attachments
      // open in the system viewer.
      if (isViewerPath(path)) {
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

  // Audio recorder (Obsidian's core recorder): capture from the mic, save as an
  // attachment, and embed it at the cursor. `recSeconds` drives the UI (null =
  // not recording).
  const recorderRef = useRef<{ rec: MediaRecorder; chunks: BlobPart[]; stream: MediaStream } | null>(null);
  const [recSeconds, setRecSeconds] = useState<number | null>(null);
  const recTimer = useRef<number | null>(null);

  const startRecording = useCallback(async () => {
    if (recorderRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setSaveError("Audio recording isn't available in this environment");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setSaveError("Microphone access was denied");
      return;
    }
    const rec = new MediaRecorder(stream);
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.start();
    recorderRef.current = { rec, chunks, stream };
    setRecSeconds(0);
    recTimer.current = window.setInterval(() => setRecSeconds((s) => (s ?? 0) + 1), 1000);
  }, []);

  const stopRecording = useCallback(
    async (save = true) => {
      const cur = recorderRef.current;
      if (!cur) return;
      if (recTimer.current) {
        clearInterval(recTimer.current);
        recTimer.current = null;
      }
      setRecSeconds(null);
      recorderRef.current = null;
      const blob: Blob = await new Promise((resolve) => {
        cur.rec.onstop = () => resolve(new Blob(cur.chunks, { type: cur.rec.mimeType || "audio/webm" }));
        cur.rec.stop();
      });
      cur.stream.getTracks().forEach((t) => t.stop());
      if (!save || blob.size === 0) return;
      const ext = (cur.rec.mimeType || "audio/webm").includes("ogg") ? "ogg" : "webm";
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const file = new File([blob], `Recording ${stamp}.${ext}`, { type: blob.type });
      const target = await handleSaveAttachment(file);
      if (target) editorApiRef.current?.insertAtCursor(`![[${target}]]`);
    },
    [handleSaveAttachment],
  );

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
      emitVaultEvent("create", { path: rel, name: note.name });
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
        // Follow a `#Heading` / `#^block` subpath: scroll to that line.
        const { subpath } = splitSubpath(target);
        let line: number | undefined;
        if (subpath) {
          const note = notesRef.current.find((n) => n.path === resolved);
          line = (note && subpathToLine(note.content, subpath)) || undefined;
        }
        await openNoteByPath(resolved, line);
        return;
      }
      const pathPart = targetPathPart(target);
      if (!pathPart) return;
      // An attachment target: .canvas/.base open in the in-app viewer pane;
      // everything else opens in the system viewer. Never auto-create a junk
      // "Report.pdf.md" note for one.
      const att = resolveAttachment(attachmentsRef.current, target);
      if (att) {
        if (isViewerPath(att.path)) void openNoteByPath(att.path);
        else void openPath(att.path).catch((e) => setSaveError(`Couldn't open: ${e}`));
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

  // Stable callbacks for the read-only viewers (canvas/base). Keeping these
  // memoized lets BaseView (React.memo) skip re-render on unrelated App ticks.
  // A viewer passes an EXACT vault-relative path, so resolve it directly first
  // (a '#' in a filename must not truncate the target through wikilink parsing).
  const openViewerFile = useCallback(
    (target: string) => {
      const exact =
        notesRef.current.find((n) => n.rel === target) ??
        attachmentsRef.current.find((a) => a.rel === target);
      if (exact) {
        if (isMarkdownPath(exact.path) || isViewerPath(exact.path)) void openNoteByPath(exact.path);
        else void openPath(exact.path).catch((e) => setSaveError(`Couldn't open: ${e}`));
        return;
      }
      void handleOpenWikilink(target, false); // fall back to link resolution, never create
    },
    [openNoteByPath, handleOpenWikilink],
  );
  const resolveImageRel = useCallback(
    (target: string, rel: string) =>
      vaultRef.current ? resolveImage(target, rel) : Promise.resolve(null),
    [],
  );

  // Per-note serialization for task toggles: a read-modify-write must not race
  // another toggle on the same note (the second would read stale content and
  // lose the first's flip). Toggles for a path chain through this promise.
  const toggleChains = useRef(new Map<string, Promise<void>>());

  // Toggle a task's checkbox on disk (from a ```dataview / ```query block).
  const handleToggleTask = useCallback(
    (task: Task): void => {
      const note = notesRef.current.find((n) => n.rel === task.path);
      if (!note) return;
      const key = note.path;
      const prev = toggleChains.current.get(key) ?? Promise.resolve();
      const run = prev.then(async () => {
        const cur = notesRef.current.find((n) => n.path === key);
        if (!cur) return; // note deleted meanwhile
        // Refuse if the note has unsaved editor edits — writing would clobber
        // them. Re-checked after the async read too (it may go dirty in between).
        if (pending.current.has(key)) {
          setSaveError("Save this note before toggling its tasks");
          return;
        }
        try {
          const disk = await readNote(key); // FRESH — don't trust in-memory content
          const lines = disk.split("\n");
          // TOCTOU: the captured line index may be stale (lines inserted above).
          // Only flip if that line is STILL this exact task; otherwise search for
          // the task by its text, and abort rather than risk the wrong line.
          const idx = locateTask(lines, task);
          if (idx < 0) {
            setSaveError("That task moved or changed — refresh the query");
            return;
          }
          if (pending.current.has(key)) {
            setSaveError("Save this note before toggling its tasks");
            return;
          }
          lines[idx] = lines[idx].replace(
            /^(\s*[-*+]\s+\[)(.)(\])/,
            (_m, a, c, b) => a + (c === " " ? "x" : " ") + b,
          );
          const next = lines.join("\n");
          await writeNote(key, next);
          rememberSelfWrite(cur.rel, next); // AFTER a successful write (no stale suppression)
          const updated: VaultNote = {
            ...cur,
            content: next,
            mtime: Date.now(),
            size: new TextEncoder().encode(next).length,
          };
          index.current.setNote(updated);
          setNotes((p) => p.map((n) => (n.path === key ? updated : n)));
          bumpStructure();
          // Reflect in an open pane, but never over an unsaved edit.
          if (!pending.current.has(key)) {
            for (const p of Object.values(panesRef.current)) {
              if (p.active === key) patchPane(p.id, { doc: next });
            }
          }
        } catch (e) {
          setSaveError(`Couldn't update task: ${e}`);
        }
      });
      // Keep the chain but drop it once settled if nothing newer was queued.
      const settled = run.catch(() => {});
      toggleChains.current.set(key, settled);
      void settled.then(() => {
        if (toggleChains.current.get(key) === settled) toggleChains.current.delete(key);
      });
    },
    [rememberSelfWrite, bumpStructure, patchPane],
  );

  // Install the query host (used by ```dataview blocks in the editor + reading
  // view). Installed once; `run`/callbacks read live refs, so it stays current.
  const handleToggleTaskRef = useRef(handleToggleTask);
  handleToggleTaskRef.current = handleToggleTask;
  const openViewerFileRef = useRef(openViewerFile);
  openViewerFileRef.current = openViewerFile;
  // Late-declared handlers the plugin host calls (assigned after their defs).
  const handleDeleteNoteRef = useRef<(path: string, opts?: { skipConfirm?: boolean }) => Promise<void>>(async () => {});
  const handleRenameNoteRef = useRef<(oldPath: string, newName: string) => Promise<void>>(async () => {});
  const structureVersionRef = useRef(structureVersion);
  structureVersionRef.current = structureVersion;
  useEffect(() => {
    setQueryHost({
      run: (source, selfPath) => {
        const v = structureVersionRef.current;
        const rows = notesRef.current.map((n) => noteRow(n, v, tagsOf, linkKeysOf));
        const absToRel = new Map(notesRef.current.map((n) => [n.path, n.rel]));
        return runQuery(parseQuery(source), {
          rows,
          selfPath,
          tasksOf: (rel) => {
            const note = notesRef.current.find((n) => n.rel === rel);
            return note ? tasksForNote(note) : [];
          },
          incomingTo: (target) => {
            const abs = index.current.resolve(target, selfPath);
            const set = new Set<string>();
            if (abs) {
              for (const b of index.current.backlinksFor(abs)) {
                const rel = absToRel.get(b.path);
                if (rel) set.add(rel);
              }
            }
            return set;
          },
        });
      },
      openLink: (target) => openViewerFileRef.current(target),
      toggleTask: (task) => void handleToggleTaskRef.current(task),
    });
    return () => setQueryHost(null);
  }, [tagsOf, linkKeysOf]);

  // Install the transclusion host (used by ![[Note]] embeds in editor + reading).
  useEffect(() => {
    setTranscludeHost({
      resolve: (rawTarget, sourceRel) => {
        const srcAbs = notesRef.current.find((n) => n.rel === sourceRel)?.path ?? "";
        const abs = index.current.resolve(rawTarget, srcAbs);
        if (!abs) return null;
        const note = notesRef.current.find((n) => n.path === abs);
        return note ? { path: abs, rel: note.rel, name: note.name } : null;
      },
      content: (abs) => {
        const note = notesRef.current.find((n) => n.path === abs);
        return note && note.content ? note.content : null; // "" (oversized) → read from disk
      },
      readContent: (abs) => readNote(abs),
      onOpen: (rawTarget) => openViewerFileRef.current(rawTarget),
      resolveImage: (target, rel) =>
        vaultRef.current ? resolveImage(target, rel) : Promise.resolve(null),
    });
    return () => setTranscludeHost(null);
  }, []);

  // Hover page-preview (reuses the transclude host). Install once.
  useEffect(() => installHoverPreview(), []);

  // A transient toast (used by plugins' Notice + a few app messages). Capped so
  // a plugin spamming Notice() can't accumulate unbounded toasts.
  const showNotice = useCallback((msg: string, timeoutMs = 4000) => {
    const id = ++noticeSeq.current;
    setNotices((n) => [...n, { id, msg }].slice(-6));
    window.setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), Math.max(500, timeoutMs));
  }, []);

  // Write a plugin-modified note through the SAME vetted path as autosave
  // (atomic + .md-only backend guard + self-write suppression + index update).
  const pluginModifyNote = useCallback(
    async (rel: string, content: string) => {
      const note = notesRef.current.find((n) => n.rel === rel);
      if (!note) throw new Error(`no such note: ${rel}`);
      // Refuse to be a SECOND uncoordinated writer: if the note has an unsaved
      // editor edit or an unresolved on-disk conflict, writing here would race
      // autosave / clobber the conflicted version and silently lose an update.
      // Fail loudly instead (the plugin gets a rejected promise).
      if (conflictsRef.current.has(note.path)) {
        throw new Error(`"${rel}" has an unresolved "Changed on disk" conflict`);
      }
      if (pending.current.has(note.path)) {
        throw new Error(`"${rel}" has unsaved edits — save it before modifying via a plugin`);
      }
      await writeNote(note.path, content);
      rememberSelfWrite(rel, content); // AFTER a successful write (no stale suppression)
      const updated: VaultNote = {
        ...note,
        content,
        mtime: Date.now(),
        size: new TextEncoder().encode(content).length,
      };
      index.current.setNote(updated);
      setNotes((prev) => prev.map((n) => (n.path === note.path ? updated : n)));
      bumpStructure();
      for (const p of Object.values(panesRef.current)) {
        if (p.active === note.path && !pending.current.has(note.path)) patchPane(p.id, { doc: content });
      }
    },
    [rememberSelfWrite, bumpStructure, patchPane],
  );

  // Install the plugin host once; its deps read live refs / stable callbacks.
  useEffect(() => {
    const deps: HostDeps = {
      getMarkdownFiles: () => notesRef.current.map((n) => ({ path: n.rel, name: n.name, ctime: n.ctime, mtime: n.mtime })),
      readNote: (rel) => {
        const note = notesRef.current.find((n) => n.rel === rel);
        return readNote(note ? note.path : rel);
      },
      createNote: async (rel, content) => {
        const name = rel.replace(/\.md$/i, "");
        const abs = await createNote(name); // sanitized + vault-contained in Rust
        const vrel = abs.startsWith(vaultRef.current ?? "")
          ? abs.slice((vaultRef.current ?? "").length).replace(/^[/\\]+/, "")
          : abs;
        await writeNote(abs, content);
        rememberSelfWrite(vrel, content); // AFTER the content write succeeds
        const note: VaultNote = { path: abs, rel: vrel, name: nameFromRel(vrel), content };
        index.current.setNote(note);
        setNotes((prev) =>
          [...prev, note].sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase())),
        );
        bumpStructure();
      },
      modifyNote: (rel, content) => pluginModifyNote(rel, content),
      deleteNote: async (rel) => {
        const note = notesRef.current.find((n) => n.rel === rel || n.path === rel);
        if (note) await handleDeleteNoteRef.current(note.path, { skipConfirm: true });
      },
      renameNote: async (rel, newPath) => {
        const note = notesRef.current.find((n) => n.rel === rel || n.path === rel);
        if (note) await handleRenameNoteRef.current(note.path, newPath.replace(/\.md$/i, ""));
      },
      createFolder: async (rel) => {
        await createFolder(rel);
        bumpStructure();
      },
      getActiveNotePath: () => {
        const p = focusedIdRef.current ? panesRef.current[focusedIdRef.current]?.active : null;
        if (!p) return null;
        return notesRef.current.find((n) => n.path === p)?.rel ?? null;
      },
      openNote: (target) => openViewerFileRef.current(target),
      vaultName: () => vaultName(vaultRef.current ?? ""),
      savePluginData: (id, json) => writePluginData(id, json),
      notice: (msg, timeoutMs) => showNotice(msg, timeoutMs),
      getFileCache: (rel) => {
        const note = notesRef.current.find((n) => n.rel === rel || n.path === rel);
        if (!note) return null;
        // Headings in document order, skipping frontmatter + fenced code.
        const lines = note.content.split("\n");
        const headings: { heading: string; level: number }[] = [];
        let inCode = false;
        let inFm = false;
        for (let i = 0; i < lines.length; i++) {
          const t = lines[i].trim();
          if (i === 0 && t === "---") {
            inFm = true;
            continue;
          }
          if (inFm) {
            if (t === "---" || t === "...") inFm = false;
            continue;
          }
          if (t.startsWith("```") || t.startsWith("~~~")) {
            inCode = !inCode;
            continue;
          }
          if (inCode) continue;
          const m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(lines[i]);
          if (m) headings.push({ heading: m[2], level: m[1].length });
        }
        return {
          tags: index.current.tagsOf(note.path).map((t) => t.replace(/^#/, "")),
          links: index.current.linkKeysOf(note.path),
          headings,
          frontmatter: parseProperties(note.content),
        };
      },
      insertAtCursor: (text, caretOffset) => editorApiRef.current?.insertAtCursor(text, caretOffset),
      onRegistryChanged: () => setPluginVersion((v) => v + 1),
    };
    installHost(deps);
    return () => installHost(null);
  }, [pluginModifyNote, showNotice, bumpStructure]);

  // Load the enabled plugins for a vault (called on open + on toggle).
  const refreshPlugins = useCallback(async () => {
    const v = vaultRef.current;
    if (!v) return;
    let infos: PluginInfo[] = [];
    try {
      infos = await listPlugins();
    } catch {
      /* no plugins folder */
    }
    if (vaultRef.current !== v) return; // vault changed during the async list
    setInstalledPlugins(infos);
    const enabled = new Set(loadEnabled(v));
    await unloadAll();
    for (const info of infos) {
      if (vaultRef.current !== v) break; // vault switched mid-load — stop
      if (!enabled.has(info.id)) continue;
      try {
        await loadPlugin(info);
      } catch (e) {
        showNotice(`Plugin "${info.name}" failed to load: ${e instanceof Error ? e.message : e}`, 8000);
      }
    }
    setPluginVersion((x) => x + 1);
  }, [showNotice]);

  // Enable/disable a plugin from Settings.
  const setPluginEnabled = useCallback(
    async (info: PluginInfo, enabled: boolean) => {
      const v = vaultRef.current;
      if (!v) return;
      const cur = new Set(loadEnabled(v));
      if (enabled) cur.add(info.id);
      else cur.delete(info.id);
      saveEnabled(v, [...cur]);
      try {
        if (enabled) await loadPlugin(info);
        else await unloadPlugin(info.id);
      } catch (e) {
        showNotice(`Plugin "${info.name}": ${e instanceof Error ? e.message : e}`, 8000);
      }
      setPluginVersion((x) => x + 1);
    },
    [showNotice],
  );

  // (Re)load this vault's enabled plugins whenever the open vault changes.
  useEffect(() => {
    if (vault) void refreshPlugins();
    return () => {
      void unloadAll();
    };
  }, [vault, refreshPlugins]);

  // The vault's available CSS snippets + the set the user has DISABLED (per
  // vault, on this device). CSS only — it can style, never execute.
  const [cssSnippets, setCssSnippets] = useState<CssSnippet[]>([]);
  const [disabledSnippets, setDisabledSnippets] = useState<Set<string>>(new Set());
  // Reload the snippet list + disabled set when the vault changes.
  useEffect(() => {
    if (!vault) {
      setCssSnippets([]);
      setDisabledSnippets(new Set());
      return;
    }
    let cancelled = false;
    try {
      const raw = localStorage.getItem(`basalt.disabledSnippets.${vault}`);
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      setDisabledSnippets(new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []));
    } catch {
      setDisabledSnippets(new Set());
    }
    void listCssSnippets()
      .then((snips) => {
        if (!cancelled) setCssSnippets(snips);
      })
      .catch(() => {
        if (!cancelled) setCssSnippets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [vault]);
  // Inject the ENABLED snippets as <style> tags; re-runs when the list or the
  // disabled set changes. Removed wholesale on switch/close.
  useEffect(() => {
    document.querySelectorAll("style[data-basalt-snippet]").forEach((el) => el.remove());
    for (const s of cssSnippets) {
      if (disabledSnippets.has(s.name)) continue;
      const style = document.createElement("style");
      style.dataset.basaltSnippet = s.name;
      style.textContent = s.css;
      document.head.append(style);
    }
    return () => {
      document.querySelectorAll("style[data-basalt-snippet]").forEach((el) => el.remove());
    };
  }, [cssSnippets, disabledSnippets]);
  const toggleSnippet = useCallback((name: string, enabled: boolean) => {
    setDisabledSnippets((prev) => {
      const next = new Set(prev);
      if (enabled) next.delete(name);
      else next.add(name);
      const v = vaultRef.current;
      if (v) localStorage.setItem(`basalt.disabledSnippets.${v}`, JSON.stringify([...next]));
      return next;
    });
  }, []);

  // One-shot "Import from Obsidian": map .obsidian appearance + hotkeys into
  // Basalt's settings and report the community plugins (which Basalt can't run).
  const [importReport, setImportReport] = useState<ObsidianImportResult | null>(null);
  const handleImportFromObsidian = useCallback(async () => {
    try {
      const raw = await readObsidianImport();
      const r = parseObsidianImport(raw);
      if (r.theme) setThemeMode(r.theme);
      if (r.accent) setAccent(r.accent);
      if (r.fontSize) setFontSize(r.fontSize);
      if (r.fontText) setFontText(r.fontText);
      if (r.fontMono) setFontMono(r.fontMono);
      if (r.enabledSnippets) {
        const enabled = new Set(r.enabledSnippets);
        setDisabledSnippets(new Set(cssSnippets.map((s) => s.name).filter((n) => !enabled.has(n))));
      }
      if (Object.keys(r.hotkeys).length) setHotkeys((h) => ({ ...h, ...r.hotkeys }));
      // The community theme's palette (needs the DOM — outside the pure parse).
      let themePaletteApplied = false;
      if (raw.themeCss) {
        setImportedPalette(resolveThemePalettes(raw.themeCss));
        themePaletteApplied = true;
      }
      setImportReport({ ...r, themePaletteApplied });
    } catch (e) {
      setSaveError(`Import from Obsidian failed: ${e}`);
    }
  }, [cssSnippets]);

  // Create "Untitled" (uniquified) inside `folderRel` ("" = vault root).
  const handleNewNoteIn = useCallback(
    async (folderRel: string) => {
      if (!vaultRef.current) return;
      const prefix = folderRel ? `${folderRel}/` : "";
      const existingRels = new Set(notesRef.current.map((n) => normalizeName(n.rel.replace(/\.md$/i, ""))));
      let base = "Untitled";
      let i = 1;
      while (existingRels.has(normalizeName(prefix + base))) base = `Untitled ${i++}`;
      try {
        await createAndOpen(prefix + base);
      } catch (e) {
        setSaveError(`Couldn't create note: ${e}`);
      }
    },
    [createAndOpen],
  );
  const handleNewNote = useCallback(() => handleNewNoteIn(""), [handleNewNoteIn]);

  const activePath = active?.path ?? null;
  const activeNote = useMemo(
    () => (activePath ? (notes.find((n) => n.path === activePath) ?? null) : null),
    [activePath, notes],
  );
  const activeName = activeNote?.name ?? null;
  activeRelRef.current = activeNote?.rel ?? null;

  // The note that the per-note VIEWS (backlinks/outline/properties…) track: the
  // focused note, or — when a view leaf is focused — the last real note. Keying
  // the panel memos on this keeps the right panel populated when you click into
  // an Outline/Backlinks leaf (activeNote would otherwise be null).
  const lastNote = useMemo(
    () => (lastNotePath ? (notes.find((n) => n.path === lastNotePath) ?? null) : null),
    [lastNotePath, notes],
  );
  const lastNoteName = lastNote?.name ?? null;

  // Tab labels for a given pane's open paths.
  const tabItemsFor = useCallback(
    (paths: string[]): TabItem[] =>
      paths.map((p) => {
        const spec = parseViewPath(p);
        if (spec) {
          const name =
            spec.type === "plugin"
              ? (pluginRightViews().find((v) => v.id === spec.viewId)?.name ?? spec.viewId)
              : viewLabel(spec);
          return { path: p, name, view: true };
        }
        return { path: p, name: notesRef.current.find((n) => n.path === p)?.name ?? basename(p) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notes, pluginVersion],
  );

  // Word/char count for the status bar (from the saved content — updates within
  // the autosave debounce of typing). Only for editable notes.
  const docStats = useMemo(() => {
    if (!active || activeIsViewer || !activeNote) return null;
    const text = activeNote.content;
    return { words: (text.match(/\S+/g) ?? []).length, chars: text.length };
  }, [active, activeIsViewer, activeNote]);

  // Backlinks of the active note can only change when OTHER notes change, so
  // this keys off structureVersion — a local autosave doesn't re-resolve the vault.
  const backlinks = useMemo(() => {
    if (!lastNotePath) return [];
    return index.current.backlinksFor(lastNotePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastNotePath, structureVersion]);

  const outgoing = useMemo(() => {
    if (!lastNotePath) return { resolved: [], unresolved: [] };
    return index.current.outgoingLinksFor(lastNotePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastNotePath, indexVersion, structureVersion]);

  // Expensive (full vault text scan). Recompute only when the tracked note
  // changes — not on every debounced save — to keep typing smooth.
  const unlinked = useMemo(() => {
    if (!lastNoteName || !lastNotePath) return [];
    return index.current.unlinkedMentionsFor(lastNoteName, notesRef.current, lastNotePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastNoteName, lastNotePath]);

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
  const [graphDepth, setGraphDepth] = useState(1);
  const graphKey = graphMode === "local" ? (active?.path ?? null) : null;
  const graphData = useMemo(() => {
    if (!graphOpen) return { nodes: [], links: [] };
    if (graphMode === "local" && graphKey) return index.current.localGraph(graphKey, graphDepth);
    return index.current.graph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphOpen, graphMode, graphKey, graphDepth, indexVersion]);

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
    async (path: string, opts?: { skipConfirm?: boolean }) => {
      const note = notesRef.current.find((n) => n.path === path);
      if (!note) return;
      if (!opts?.skipConfirm) {
        const ok = await confirm(`Move "${note.name}" to the vault trash?`, {
          title: "Delete note",
          kind: "warning",
        });
        if (!ok) return;
      }
      try {
        // Never resurrect a deleted note via autosave / a stale conflict.
        const t = saveTimers.current.get(path);
        if (t !== undefined) window.clearTimeout(t);
        saveTimers.current.delete(path);
        pending.current.delete(path);
        clearConflict(path);
        await deleteNote(path);
        selfWrites.current.delete(note.rel); // a restored copy must not be swallowed
        // Drop the snapshot history so a later note reusing this rel can't
        // inherit — and restore — the deleted note's content.
        if (vaultRef.current) void clearSnapshots(vaultRef.current, note.rel);
        index.current.removeNote(path);
        setNotes((prev) => prev.filter((n) => n.path !== path));
        recents.current = recents.current.filter((r) => r !== note.rel);
        bumpStructure(); // the prune effect closes its tab in every pane
        emitVaultEvent("delete", { path: note.rel, name: note.name });
      } catch (e) {
        setSaveError(`Couldn't delete: ${e}`);
      }
    },
    [bumpStructure, clearConflict],
  );
  handleDeleteNoteRef.current = handleDeleteNote;

  /** Move an ATTACHMENT (image / PDF / audio / video / canvas / base) to
   * .trash. Editable viewers (.canvas/.base) get the flush-then-abort-if-
   * pending discipline so an unsaved edit is never trashed over. */
  const handleDeleteAttachment = useCallback(
    async (path: string) => {
      const att = attachmentsRef.current.find((a) => a.path === path);
      if (!att) return;
      const viewer = isViewerPath(path);
      const ok = await confirm(`Move "${att.name}" to the vault trash?`, {
        title: "Delete attachment",
        kind: "warning",
      });
      if (!ok) return;
      try {
        if (viewer) {
          if (conflictsRef.current.has(path)) {
            setSaveError(`Resolve the "Changed on disk" conflict in ${att.name} before deleting it`);
            return;
          }
          await flushPath(path);
          if (pending.current.has(path)) {
            setSaveError("Couldn't delete: unsaved changes failed to save");
            return;
          }
          const t = saveTimers.current.get(path);
          if (t !== undefined) window.clearTimeout(t);
          saveTimers.current.delete(path);
          pending.current.delete(path);
          clearConflict(path);
        }
        await deleteNote(path); // trashes any vault file (must-exist, contained)
        selfWrites.current.delete(att.rel);
        if (viewer && vaultRef.current) void clearSnapshots(vaultRef.current, att.rel);
        setAttachmentsList((prev) => prev.filter((a) => a.path !== path));
        bumpStructure(); // the prune effect closes any viewer tab
      } catch (e) {
        setSaveError(`Couldn't delete: ${e}`);
      }
    },
    [bumpStructure, clearConflict, flushPath],
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
  // Rewrite canvas file-node references to renamed/moved notes (relMap:
  // oldRel → newRel) across `canvases` (post-move paths), then reconcile any
  // open canvas viewer so its editor isn't left showing stale refs. Reads DISK
  // (authoritative — callers flushAll first, so pending canvas edits are saved).
  const rewriteCanvasRefs = useCallback(
    async (canvases: { path: string; rel: string }[], relMap: Map<string, string>): Promise<string[]> => {
      const failed: string[] = [];
      if (relMap.size === 0) return failed;
      for (const c of canvases) {
        // Never overwrite a canvas with UNSAVED edits (a failed flush leaves it
        // pending): reading disk would miss them and the write would clobber.
        // Its refs stay dangling until the user saves — no data loss.
        if (pending.current.has(c.path) || conflictsRef.current.has(c.path)) continue;
        try {
          const json = await readNote(c.path);
          const next = rewriteCanvasFileRefs(json, relMap);
          if (next === null) continue;
          await writeCanvas(c.path, next);
          rememberSelfWrite(c.rel, next);
          for (const p of Object.values(panesRef.current)) {
            if (p.active === c.path) patchPane(p.id, { doc: next });
          }
        } catch (e) {
          failed.push(c.rel);
          console.error("[basalt] canvas ref rewrite failed", c.rel, e);
        }
      }
      return failed;
    },
    [rememberSelfWrite, patchPane],
  );

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
        // Migrate the local snapshot history so recovery follows the note.
        void renameSnapshots(root, oldNote.rel, newRel);
        emitVaultEvent("rename", { path: newRel, name: newBase }, oldNote.rel);

        // Link text Obsidian would write, honoring the vault's newLinkFormat
        // (shortest: bare name unless another note shares the new basename;
        // relative: per-SOURCE `./`/`../` path; absolute: full vault path).
        const fmt = getLinkFormat();
        // "shortest" format emits a bare `[[NewName]]` only when the name is
        // unambiguous. Another note that has NewName as a basename OR as an
        // ALIAS makes it ambiguous — force the folder-qualified form so rewritten
        // links keep resolving to the renamed note, not the alias owner.
        const newBaseKey = normalizeName(newBase);
        const taken =
          preNotes.some((n) => n.path !== oldPath && normalizeName(n.name) === newBaseKey) ||
          preIndex.allAliases().some((a) => a.rel !== newRel && normalizeName(a.alias) === newBaseKey);
        const newRelNoExt = newRel.replace(/\.md$/i, "");

        // The renamed note's own content, from disk (authoritative), with its
        // self-links retargeted and position-dependent ./.. links re-anchored.
        let renamedContent: string;
        try {
          renamedContent = await readNote(newPath);
        } catch {
          renamedContent = oldNote.content; // disk read failed; best effort
        }
        const selfAliases = new Set(preIndex.aliasesOf(oldPath).map((a) => normalizeName(a)));
        const ownMap = (raw: string): string | null => {
          const dest = preIndex.resolve(raw, oldPath);
          if (!dest) return null;
          if (dest === oldPath) {
            // A self-link via an alias still resolves post-rename — leave it.
            const last = normalizeName(targetPathPart(raw).split(/[/\\]/).pop() ?? "");
            if (selfAliases.has(last) && last !== normalizeName(newBase) && last !== normalizeName(oldNote.name))
              return null;
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
            pinned: pane.pinned?.map((p) => (p === oldPath ? newPath : p)),
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
        // Links that reach the note via one of its ALIASES still resolve after
        // the rename (aliases live in the target's frontmatter, unchanged), so
        // leave them — rewriting would needlessly destroy the alias usage.
        const aliasSet = new Set(preIndex.aliasesOf(oldPath).map((a) => normalizeName(a)));
        const viaAlias = (raw: string): boolean => {
          const last = normalizeName(targetPathPart(raw).split(/[/\\]/).pop() ?? "");
          return aliasSet.has(last) && last !== normalizeName(newBase) && last !== normalizeName(oldNote.name);
        };
        const sourceMap = (notePath: string, noteRel: string) => (raw: string) =>
          preIndex.resolve(raw, notePath) === oldPath && !viaAlias(raw)
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
        // Repoint canvas file-node embeds of the renamed note (canvases aren't
        // in the note link-rewrite loop above; without this they'd dangle).
        const canvasFails = await rewriteCanvasRefs(
          attachmentsRef.current
            .filter((a) => /\.canvas$/i.test(a.path))
            .map((a) => ({ path: a.path, rel: a.rel })),
          new Map([[oldNote.rel, newRel]]),
        );
        const allFails = [...failures, ...canvasFails.map((r) => `${r} (canvas)`)];
        setSaveError(
          allFails.length > 0 ? `Renamed, but link updates failed in: ${allFails.join(", ")}` : null,
        );
      } catch (e) {
        setSaveError(`Couldn't rename: ${e}`);
      }
    },
    [flushAll, bumpStructure, rememberSelfWrite, getLinkFormat, patchPane, rewriteCanvasRefs],
  );
  handleRenameNoteRef.current = handleRenameNote;

  // Convert an unlinked mention into a `[[wikilink]]` in its SOURCE note (the
  // "Link" / "Link all" backlink actions). Reads disk (authoritative), edits
  // the one line, writes, and reconciles index/notes/panes — like a rename's
  // link rewrite. Returns whether it changed anything.
  const linkifyInNote = useCallback(
    async (sourcePath: string, line: number, targetName: string): Promise<boolean> => {
      if (conflictsRef.current.has(sourcePath)) {
        setSaveError("Resolve the “Changed on disk” conflict before linking mentions");
        return false;
      }
      await flushPath(sourcePath);
      let disk: string;
      try {
        disk = await readNote(sourcePath);
      } catch {
        return false;
      }
      const lines = disk.split("\n");
      const idx = line - 1;
      if (idx < 0 || idx >= lines.length) return false;
      const next = linkifyMention(lines[idx], targetName);
      if (next === null) return false;
      lines[idx] = next;
      const content = lines.join("\n");
      try {
        await writeNote(sourcePath, content);
      } catch (e) {
        setSaveError(`Couldn't link mention: ${e}`);
        return false;
      }
      const note = notesRef.current.find((n) => n.path === sourcePath);
      if (note) {
        const updated: VaultNote = { ...note, content };
        index.current.setNote(updated);
        rememberSelfWrite(note.rel, content);
        setNotes((prev) => prev.map((n) => (n.path === sourcePath ? updated : n)));
        for (const p of Object.values(panesRef.current)) {
          if (p.active === sourcePath) patchPane(p.id, { doc: content });
        }
      }
      bumpStructure(); // the mention is now a real link → backlinks/unlinked recompute
      return true;
    },
    [flushPath, rememberSelfWrite, patchPane, bumpStructure],
  );

  const handleLinkMention = useCallback(
    (m: { path: string; line: number }) => {
      const name = notesRef.current.find((n) => n.path === activePathRef.current)?.name;
      if (name) void linkifyInNote(m.path, m.line, name);
    },
    [linkifyInNote],
  );

  const handleLinkAllMentions = useCallback(
    async (mentions: { path: string; line: number }[]) => {
      const name = notesRef.current.find((n) => n.path === activePathRef.current)?.name;
      if (!name) return;
      // Snapshot the list; line numbers stay valid (linkify never adds lines).
      for (const m of [...mentions]) await linkifyInNote(m.path, m.line, name);
    },
    [linkifyInNote],
  );

  // Delete a whole folder to the vault trash (recoverable). All notes under it
  // leave the index/state; the prune effect closes their tabs.
  const handleDeleteFolder = useCallback(
    async (folderRel: string) => {
      const prefix = `${folderRel}/`;
      const inside = notesRef.current.filter((n) => n.rel.startsWith(prefix));
      // Editable viewers (.canvas/.base) share the pending/conflict machinery —
      // they get the SAME flush/conflict discipline as notes.
      const viewers = attachmentsRef.current.filter((a) => a.rel.startsWith(prefix) && isViewerPath(a.path));
      const all = [...inside, ...viewers];
      const ok = await confirm(
        `Move the folder "${folderRel}" (${inside.length} ${inside.length === 1 ? "note" : "notes"} + any attachments) to the vault trash?`,
        { title: "Delete folder", kind: "warning" },
      );
      if (!ok) return;
      try {
        // Flush unsaved edits FIRST so the trashed copies hold the latest
        // content (delete is recoverable; a dropped pending edit is not).
        for (const f of all) {
          if (conflictsRef.current.has(f.path)) {
            setSaveError(`Resolve the "Changed on disk" conflict in ${f.name} before deleting this folder`);
            return;
          }
          await flushPath(f.path);
        }
        // flushPath never throws on a failed write — it leaves the doc in
        // `pending`. ABORT if anything is still unsaved (incl. edits typed
        // during the flushes) rather than trash a stale copy.
        if (all.some((f) => pending.current.has(f.path))) {
          setSaveError("Couldn't delete folder: unsaved changes failed to save");
          return;
        }
        for (const f of all) {
          const t = saveTimers.current.get(f.path);
          if (t !== undefined) window.clearTimeout(t);
          saveTimers.current.delete(f.path);
          pending.current.delete(f.path);
          clearConflict(f.path);
        }
        await deleteFolder(folderRel);
        for (const f of all) {
          selfWrites.current.delete(f.rel);
          if (vaultRef.current) void clearSnapshots(vaultRef.current, f.rel);
        }
        for (const n of inside) index.current.removeNote(n.path);
        setNotes((prev) => prev.filter((n) => !n.rel.startsWith(prefix)));
        setAttachmentsList((prev) => prev.filter((a) => !a.rel.startsWith(prefix)));
        recents.current = recents.current.filter((r) => !r.startsWith(prefix));
        bumpStructure();
      } catch (e) {
        setSaveError(`Couldn't delete folder: ${e}`);
      }
    },
    [bumpStructure, clearConflict, flushPath],
  );

  // Rename/move a whole folder in ONE fs::rename (Rust rename_folder moves the
  // entire subtree — notes, attachments, empty subfolders — preserving every
  // basename), then a SINGLE vault-wide link-rewrite pass fixes the links whose
  // resolution the move changed. O(vault) instead of O(notes × vault), and
  // FS-hostile basenames survive because the move never re-sanitizes them.
  const handleRenameFolder = useCallback(
    async (folderRel: string, newFolderRel: string) => {
      const root = vaultRef.current;
      if (!root || !newFolderRel || newFolderRel === folderRel) return;
      const oldPrefix = `${folderRel}/`;
      const newPrefix = `${newFolderRel}/`;
      if (newPrefix.startsWith(oldPrefix)) {
        setSaveError("Cannot move a folder into itself");
        return;
      }
      // Case-only rename (Notes → notes): fs::rename to a name differing only
      // in case collides on a case-insensitive FS. Refuse with a recipe.
      if (normalizeName(newFolderRel) === normalizeName(folderRel)) {
        setSaveError("Case-only folder renames aren't supported — rename to a different name first, then back");
        return;
      }
      // Every note/viewer under the folder must be flushed first, then the
      // WHOLE operation aborts if anything is still unsaved — a mid-move
      // pending write to a now-moved path would be lost.
      await flushAll();
      const movingNotes = notesRef.current.filter((n) => n.rel.startsWith(oldPrefix));
      const movingAtts = attachmentsRef.current.filter((a) => a.rel.startsWith(oldPrefix));
      for (const f of [...movingNotes, ...movingAtts]) {
        if (conflictsRef.current.has(f.path)) {
          setSaveError(`Resolve the "Changed on disk" conflict in ${f.name} before moving this folder`);
          return;
        }
        if (pending.current.has(f.path)) {
          setSaveError("Couldn't move folder: unsaved changes failed to save");
          return;
        }
      }

      // Pre-move resolver — link decisions read the OLD vault shape.
      const preIndex = new VaultIndex();
      preIndex.build(notesRef.current);
      const preNotes = notesRef.current;

      // Map every moving note old→new (prefix swap; content unchanged; paths
      // are root-based like every other note path — root is already canonical).
      const oldRelByPath = new Map(preNotes.map((n) => [n.path, n.rel]));
      const swap = (rel: string) => newFolderRel + rel.slice(folderRel.length);
      const movedByOld = new Map<string, VaultNote>(); // oldPath → renamed VaultNote
      const postToOld = new Map<string, string>(); // newPath → oldPath
      for (const n of movingNotes) {
        const newRel = swap(n.rel);
        const newPath = `${root}/${newRel}`;
        movedByOld.set(n.path, { ...n, path: newPath, rel: newRel, name: nameFromRel(newRel) });
        postToOld.set(newPath, n.path);
      }

      // Pre-move attachment list + old→new mapping (attachments move with the
      // directory; the note index doesn't cover them, so rewrite their links
      // via a parallel resolver — see FolderMoveCtx.att* in lib/rename.ts).
      const preAtts = attachmentsRef.current;
      const postAtts: Attachment[] = preAtts.map((a) =>
        a.rel.startsWith(oldPrefix) ? { ...a, rel: swap(a.rel), path: `${root}/${swap(a.rel)}` } : a,
      );
      const movedAttNewPathByOld = new Map<string, string>();
      for (const a of movingAtts) movedAttNewPathByOld.set(a.path, `${root}/${swap(a.rel)}`);
      const postAttByPath = new Map(postAtts.map((a) => [a.path, a]));

      // Do the move. One syscall relocates the whole tree.
      try {
        await renameFolder(folderRel, newFolderRel);
      } catch (e) {
        setSaveError(`Couldn't move folder: ${e}`);
        return;
      }

      // Migrate any pending edit / save timer keyed by a moving OLD path to its
      // new path — a keystroke landing during the renameFolder IPC would else
      // be lost (its flush would target the now-gone old path). Attachments too.
      const oldToNewPath = new Map<string, string>();
      for (const [oldP, nn] of movedByOld) oldToNewPath.set(oldP, nn.path);
      for (const a of movingAtts) oldToNewPath.set(a.path, `${root}/${swap(a.rel)}`);
      for (const [oldP, newP] of oldToNewPath) {
        const p = pending.current.get(oldP);
        if (p !== undefined) {
          pending.current.delete(oldP);
          pending.current.set(newP, p);
        }
        const t = saveTimers.current.get(oldP);
        if (t !== undefined) {
          saveTimers.current.delete(oldP);
          saveTimers.current.set(newP, t);
        }
      }

      // Post-move note list + resolver (same content, new rel/path/name).
      const postNotes: VaultNote[] = preNotes.map((n) => movedByOld.get(n.path) ?? n);
      const postIndex = new VaultIndex();
      postIndex.build(postNotes);
      const fmt = getLinkFormat();

      // Shared context for the resolver-based link rewrite (see lib/rename.ts).
      const movedNewPathByOld = new Map([...movedByOld].map(([o, n]) => [o, n.path]));
      const postByPath = new Map(postNotes.map((n) => [n.path, n]));
      const attNorm = (s: string) => normalizeName(s);
      const moveCtx = {
        resolvePre: (raw: string, from: string) => preIndex.resolve(raw, from),
        resolvePost: (raw: string, from: string) => postIndex.resolve(raw, from),
        movedNewPathByOld,
        noteAt: (path: string) => postByPath.get(path),
        nameTaken: (name: string, except: string) =>
          postNotes.some((n) => n.path !== except && normalizeName(n.name) === normalizeName(name)),
        format: fmt,
        resolveAttPre: (raw: string) => resolveAttachment(preAtts, raw)?.path ?? null,
        resolveAttPost: (raw: string) => resolveAttachment(postAtts, raw)?.path ?? null,
        movedAttNewPathByOld,
        attAt: (path: string) => postAttByPath.get(path),
        attNameTaken: (name: string, except: string) =>
          postAtts.some((a) => a.path !== except && attNorm(a.name) === attNorm(name)),
      };
      const makeMapper = (post: VaultNote) =>
        folderMoveMapper(moveCtx, postToOld.get(post.path) ?? post.path, post.path, post.rel);

      // One pass: rewrite affected notes (moved and unmoved), reading DISK so a
      // fresher external edit is never reverted. Cheap in-memory pre-filter.
      const updates = new Map<string, VaultNote>();
      const failures: string[] = [];
      for (const post of postNotes) {
        const mapper = makeMapper(post);
        if (rewriteLinks(post.content, mapper) === null) continue; // unaffected
        try {
          const disk = await readNote(post.path);
          const next = rewriteLinks(disk, mapper);
          if (next === null) continue;
          await writeNote(post.path, next);
          rememberSelfWrite(post.rel, next);
          updates.set(post.path, { ...post, content: next });
        } catch (e) {
          failures.push(post.rel);
          console.error("[basalt] folder-move link rewrite failed", post.rel, e);
        }
      }

      // Commit index/notes/attachments/recents/snapshots/panes in bulk.
      for (const [oldPath, nn] of movedByOld) {
        index.current.removeNote(oldPath);
        const finalNote = updates.get(nn.path) ?? nn;
        index.current.setNote(finalNote);
        const oldRel = oldRelByPath.get(oldPath);
        if (oldRel !== undefined) {
          selfWrites.current.delete(oldRel);
          void renameSnapshots(root, oldRel, nn.rel);
        }
        // Seed the new-rel baseline so the watcher's create-event for the moved
        // file (fs::rename fires delete+create) isn't seen as an external edit.
        rememberSelfWrite(nn.rel, finalNote.content);
      }
      // Unmoved notes whose links were rewritten (their path is unchanged).
      for (const [path, u] of updates) if (!postToOld.has(path)) index.current.setNote(u);
      setNotes(() =>
        postNotes
          .map((n) => updates.get(n.path) ?? n)
          .sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase())),
      );
      setAttachmentsList((prev) =>
        prev.map((a) =>
          a.rel.startsWith(oldPrefix)
            ? { ...a, rel: swap(a.rel), path: `${root}/${swap(a.rel)}` }
            : a,
        ),
      );
      // Moved attachments' self-write baselines follow their new rel.
      for (const a of movingAtts) {
        const nrel = swap(a.rel);
        const base = selfWrites.current.get(a.rel);
        if (base !== undefined) {
          selfWrites.current.delete(a.rel);
          selfWrites.current.set(nrel, base);
        }
      }
      recents.current = recents.current.map((r) => (r.startsWith(oldPrefix) ? swap(r) : r));
      try {
        localStorage.setItem(recentKey(root), JSON.stringify(recents.current));
      } catch {
        /* quota — non-fatal */
      }

      // Repoint every moved note/viewer path in every pane (tabs/active/pinned)
      // AND reconcile the doc of any pane whose active note's links were
      // rewritten — INCLUDING panes with no moved tab (an unmoved note whose
      // outbound links changed), else the editor keeps stale content and the
      // next keystroke reverts the on-disk link fix.
      const pathMap = new Map<string, string>();
      for (const [oldPath, nn] of movedByOld) pathMap.set(oldPath, nn.path);
      for (const a of movingAtts) pathMap.set(a.path, `${root}/${swap(a.rel)}`);
      const repoint = (pane: Pane): Pane => {
        const hasMoved = pane.tabs.some((p) => pathMap.has(p));
        const newActive = pane.active ? (pathMap.get(pane.active) ?? pane.active) : pane.active;
        const activeUpdate = newActive ? updates.get(newActive) : undefined;
        if (!hasMoved && !activeUpdate) return pane; // nothing to change
        const map = (p: string) => pathMap.get(p) ?? p;
        return {
          ...pane,
          tabs: hasMoved ? pane.tabs.map(map) : pane.tabs,
          active: newActive,
          doc: activeUpdate ? activeUpdate.content : pane.doc,
          pinned: hasMoved ? pane.pinned?.map(map) : pane.pinned,
        };
      };
      panesRef.current = Object.fromEntries(
        Object.entries(panesRef.current).map(([id, pane]) => [id, repoint(pane)]),
      );
      setPanes((ps) => Object.fromEntries(Object.entries(ps).map(([id, pane]) => [id, repoint(pane)])));
      bumpStructure();

      // Repoint canvas file-node embeds of every moved note AND moved
      // attachment (canvas file-nodes can embed images/PDFs/nested canvases, not
      // just notes), across ALL canvases (moved ones now at their new path,
      // unmoved at their original path). After the pane repoint so an open moved
      // canvas reconciles at its new path.
      const moveRelMap = new Map([...movingNotes, ...movingAtts].map((f) => [f.rel, swap(f.rel)]));
      const postCanvases = preAtts.map((a) =>
        a.rel.startsWith(oldPrefix) ? { path: `${root}/${swap(a.rel)}`, rel: swap(a.rel) } : { path: a.path, rel: a.rel },
      ).filter((a) => /\.canvas$/i.test(a.path));
      const canvasFails = await rewriteCanvasRefs(postCanvases, moveRelMap);

      const folderFails = [...failures, ...canvasFails.map((r) => `${r} (canvas)`)];
      setSaveError(
        folderFails.length > 0 ? `Folder moved, but link updates failed in: ${folderFails.join(", ")}` : null,
      );
    },
    [flushAll, bumpStructure, rememberSelfWrite, getLinkFormat, rewriteCanvasRefs],
  );

  // Move a note into a folder (rel, "" = root) by renaming — reuses the
  // link-rewriting rename path. No-op if it's already there.
  const handleMoveToFolder = useCallback(
    (notePath: string, folderRel: string) => {
      const note = notesRef.current.find((n) => n.path === notePath);
      if (!note) return;
      const curFolder = note.rel.includes("/") ? note.rel.slice(0, note.rel.lastIndexOf("/")) : "";
      if (normalizeName(curFolder) === normalizeName(folderRel)) return;
      void handleRenameNote(notePath, (folderRel ? `${folderRel}/` : "") + note.name);
    },
    [handleRenameNote],
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
      { id: "random-note", label: "Open random note", hint: "jump to a random note in the vault", run: () => {
        const all = notesRef.current;
        if (all.length) void openNoteByPath(all[Math.floor(Math.random() * all.length)].path);
      } },
      { id: "daily-note", label: "Open today's daily note", hint: "creates it from your template if missing", run: () => void openDailyNote() },
      { id: "slides", label: "Start presentation", hint: "present the active note as `---`-separated slides", run: () => { const p = focusedIdRef.current ? panesRef.current[focusedIdRef.current] : null; if (p?.active && isMarkdownPath(p.active)) setSlidesOpen(true); } },
      { id: "record-audio", label: "Record audio", hint: "record from the mic and embed it in the note", run: () => (recorderRef.current ? void stopRecording(true) : void startRecording()) },
      { id: "toggle-bookmark", label: "Bookmark / unbookmark current note", hint: "add or remove this note in .obsidian/bookmarks.json", run: () => { const p = focusedIdRef.current ? panesRef.current[focusedIdRef.current] : null; if (p?.active && isMarkdownPath(p.active)) void toggleBookmark(p.active); } },
      { id: "workspaces", label: "Manage workspaces…", hint: "save / switch named layouts", run: () => setModal("workspaces") },
      { id: "source-mode", label: "Toggle Source mode", hint: "raw Markdown ↔ Live Preview", run: toggleSourceMode },
      { id: "reading-mode", label: "Toggle Reading view", hint: "rendered, read-only ↔ edit", run: toggleReading },
      { id: "export-html", label: "Export note as HTML…", hint: "self-contained file", run: () => void handleExportHtml() },
      { id: "print-pdf", label: "Print / Save as PDF…", hint: "prints the Reading view", run: handlePrintPdf },
      { id: "open-note", label: "Open note…", hint: "quick switcher (⌘O)", run: () => setModal("switcher") },
      { id: "search", label: "Search vault…", hint: "full-text search (⇧⌘F)", run: () => { setSearchSeed(""); setModal("search"); } },
      { id: "version-history", label: "Show version history", hint: "restore a past snapshot of this note", run: () => void openVersionHistory() },
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
      { id: "toggle-left-sidebar", label: "Toggle left sidebar", hint: "⌘\\", run: () => toggleLeftDock() },
      { id: "reset-layout", label: "Reset to default layout", hint: "file tree | editor | right dock", run: () => resetWorkspace() },
      { id: "toggle-right-sidebar", label: "Toggle right sidebar", hint: "⌘⌥\\", run: () => toggleRightDock() },
      { id: "zoom-in", label: "Zoom in", hint: "⌘+", run: () => zoomBy(0.1) },
      { id: "zoom-out", label: "Zoom out", hint: "⌘-", run: () => zoomBy(-0.1) },
      { id: "zoom-reset", label: "Reset zoom", hint: "⌘0", run: () => setZoom(1) },
      { id: "insert-template", label: "Insert template…", hint: "apply a template at the cursor", run: () => setModal("templates") },
      { id: "switch-vault", label: "Switch vault…", hint: "recent vaults / open a folder", run: openVaultSwitcher },
      { id: "new-window", label: "New window", hint: "open another window", run: () => void handleOpenInNewWindow() },
      {
        id: "move-to-new-window",
        label: "Move note to new window",
        hint: "pop the current note out",
        run: () => {
          const id = focusedIdRef.current;
          const p = id ? panesRef.current[id]?.active : null;
          if (id && p && !isViewPath(p)) void moveTabToNewWindow(id, p);
        },
      },
      { id: "settings", label: "Open settings", hint: "appearance, vault info (⌘,)", run: () => setModal("settings") },
      { id: "toggle-theme", label: "Toggle light/dark theme", hint: "switch appearance", run: toggleTheme },
      { id: "toggle-readable-width", label: "Toggle readable line length", hint: "constrain content width", run: () => setReadableWidth((v) => !v) },
      { id: "reveal-in-finder", label: "Reveal current note in file manager", hint: "show the file on disk", run: () => { const p = focusedIdRef.current ? panesRef.current[focusedIdRef.current]?.active : null; if (p) void revealItemInDir(p).catch((e) => setSaveError(`Couldn't reveal: ${e}`)); } },
      { id: "new-folder", label: "New folder…", hint: "create a folder at the vault root", run: () => setSubfolderParent("") },
      { id: "toggle-spellcheck", label: "Toggle spellcheck", hint: "native browser spellcheck in the editor", run: () => setSpellcheck((v) => !v) },
      { id: "split-right", label: "Split right", hint: "open the current note in a vertical split", run: () => splitFocused("row") },
      { id: "split-down", label: "Split down", hint: "open the current note in a horizontal split", run: () => splitFocused("col") },
      {
        id: "open-outline-tab",
        label: "Open outline in a new tab",
        hint: "the outline as a movable view leaf",
        run: () => void openInPane(ensureWorkspace(), viewPath({ type: "outline" })),
      },
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
      // Commands contributed by enabled plugins (pluginVersion re-derives this).
      ...pluginCommands().map((c) => ({
        id: `plugin:${c.id}`,
        label: c.name,
        hint: "plugin command",
        run: c.callback,
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handleNewNote, handleOpenVault, openVaultSwitcher, handleOpenInNewWindow, moveTabToNewWindow, resetWorkspace, handleReloadFromDisk, handleDeleteNote, openDailyNote, toggleSourceMode, toggleReading, toggleTheme, splitFocused, handleExportHtml, handlePrintPdf, openNoteByPath, pluginVersion],
  );
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  // Run user-assigned hotkeys (checked before nothing else claims the event;
  // built-in shortcuts still win because they preventDefault first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !vaultRef.current) return;
      const id = matchChord(e, hotkeys, isMac);
      if (!id) return;
      const cmd = commandsRef.current.find((c) => c.id === id);
      if (!cmd) return;
      e.preventDefault();
      cmd.run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkeys]);

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

  // Render a VIEW leaf's content (a view tab: Outline, Backlinks, plugin view…).
  // Per-note views track the last active note (`lastNote`), not the pane they
  // live in. Data (backlinks/outgoing/unlinked/tags/bookmarks) is the same the
  // right panel uses, keyed on lastNote.
  const renderLeafView = (spec: ViewSpec): ReactNode => {
    if (spec.type === "plugin") {
      const v = pluginRightViews().find((pv) => pv.id === spec.viewId);
      return v ? <PluginViewMount view={v} /> : <div className="placeholder">Plugin view unavailable.</div>;
    }
    const noteDoc = lastNote?.content ?? null;
    const jump = (line: number) => {
      if (lastNotePath) void openNoteByPath(lastNotePath, line);
    };
    switch (spec.type) {
      case "filetree":
        return (
          <Sidebar
            notes={notes}
            attachments={attachmentsList}
            activePath={lastNotePath}
            vaultName={basename(vault)}
            onOpen={(path) => openNoteByPath(path)}
            onNewNote={handleNewNote}
            onFolderContextMenu={(folderRel, x, y) => setFolderMenu({ folderRel, x, y })}
            onMoveToFolder={handleMoveToFolder}
            onOpenAttachment={handleOpenAttachment}
            onContextMenu={(path, x, y) => setFileMenu({ path, x, y })}
            onAttachmentContextMenu={(path, x, y) => setAttMenu({ path, x, y })}
          />
        );
      case "search":
        return <div className="placeholder">Press ⌘⇧F to search the vault.</div>;
      case "backlinks":
        return (
          <Backlinks
            noteName={lastNoteName}
            backlinks={backlinks}
            unlinked={unlinked}
            onOpen={(path, line) => openNoteByPath(path, line)}
            onLink={handleLinkMention}
            onLinkAll={handleLinkAllMentions}
          />
        );
      case "links":
        return (
          <div className="outgoing">
            {outgoing.resolved.length === 0 && outgoing.unresolved.length === 0 && (
              <div className="panel-empty">No outgoing links</div>
            )}
            {outgoing.resolved.map((l, i) => (
              <button key={`r${i}`} className="outgoing-item" onClick={() => openNoteByPath(l.path, 1)} title={l.path}>
                {l.name}
              </button>
            ))}
            {outgoing.unresolved.length > 0 && (
              <>
                <div className="outgoing-head">Unresolved</div>
                {outgoing.unresolved.map((t, i) => (
                  <button key={`u${i}`} className="outgoing-item unresolved" onClick={() => void handleOpenWikilink(t)} title={`Create “${t}”`}>
                    {t}
                  </button>
                ))}
              </>
            )}
          </div>
        );
      case "outline":
        return <Outline doc={noteDoc} onJump={jump} />;
      case "properties": {
        // Read the LIVE doc of whichever pane shows the tracked note, so an edit
        // here reflects at once (the index content lags the debounced save).
        const hostPane = lastNotePath ? Object.entries(panes).find(([, p]) => p.active === lastNotePath) : undefined;
        return (
          <Properties
            doc={hostPane ? hostPane[1].doc : noteDoc}
            onChange={(nextDoc) => {
              if (!hostPane || !lastNotePath) return;
              patchPane(hostPane[0], { doc: nextDoc });
              handleChange(hostPane[0], lastNotePath, nextDoc);
            }}
          />
        );
      }
      case "tags":
        return <Tags tags={tags} onSelect={handleSelectTag} />;
      case "bookmarks":
        return (
          <Bookmarks
            bookmarks={bookmarks}
            onOpen={handleOpenBookmark}
            onSearch={(query) => {
              setSearchSeed(query);
              setModal("search");
            }}
          />
        );
    }
  };

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
        className={`pane${focused ? " focused" : ""}${pane.dock ? ` dock dock-${pane.dock}` : ""}`}
        onMouseDownCapture={() => focusPane(id)}
      >
        {pane.tabs.length > 0 && (
          <TabBar
            paneId={id}
            tabs={tabItemsFor(pane.tabs).map((t) => ({ ...t, pinned: pane.pinned?.includes(t.path) }))}
            activePath={pane.active}
            onSelect={(p) => void openInPane(id, p)}
            onClose={(p) => void closeTab(id, p)}
            onTogglePin={(p) => togglePin(id, p)}
            onTabDrop={(fromId, p, toIndex) => void handleTabDrop(fromId, p, id, toIndex)}
            onContextMenu={(p, x, y) => setTabMenu({ paneId: id, path: p, x, y })}
            onDragStateChange={(active) => {
              setTabDragging(active);
              if (!active) setDropEdge(null);
            }}
            linked={pane.linked ?? false}
            onToggleLink={() => toggleLink(id)}
            stacked={pane.stacked ?? false}
            onToggleStacked={() => toggleStacked(id)}
            dock={!!pane.dock}
            onNew={() => {
              focusPane(id);
              setModal("switcher");
            }}
          />
        )}
        {path && rel && isMarkdownPath(path) && !pane.stacked && (
          <InlineTitle
            key={`title:${path}`}
            name={nameFromRel(rel)}
            onRename={(newBase) => void handleRenameNote(path, rel.replace(/[^/\\]+$/, "") + newBase)}
          />
        )}
        <div className="pane-body">
        {pane.stacked && pane.tabs.length > 0 ? (
          <StackedTabs
            tabs={pane.tabs.map((p) => ({ path: p, name: tabItemsFor([p])[0]?.name ?? p, rel: notes.find((n) => n.path === p)?.rel ?? "" }))}
            activePath={pane.active}
            readNote={readNote}
            onFocusTab={(p, colDoc) => {
              toggleStacked(id);
              // Carry the column's live (possibly edited) content so unstacking
              // shows it — openInPane would early-return on the already-active
              // tab and reveal the pane's stale doc. A pending edit still flushes.
              if (colDoc !== undefined) {
                const tabs = pane.tabs.includes(p) ? pane.tabs : [...pane.tabs, p];
                patchPane(id, { active: p, doc: colDoc, tabs });
                focusPane(id);
              } else {
                void openInPane(id, p);
              }
            }}
            renderBody={(tab, doc, onDocChange) => (
              <EditorPane
                key={`${id}:stacked:${tab.path}`}
                path={tab.path}
                selfRel={tab.rel}
                pluginVersion={pluginVersion}
                doc={doc}
                getNotes={getNotes}
                getLinkFormat={getLinkFormat}
                getActiveRel={() => tab.rel || null}
                getHeadings={getHeadings}
                getBlockIds={getBlockIds}
                sourceMode={sourceMode}
                dark={dark}
                spellcheck={spellcheck}
                vim={vim}
                rtl={rtl}
                onOpenWikilink={handleOpenWikilink}
                onOpenUrl={handleOpenUrl}
                resolveImage={(target) => (vaultRef.current ? resolveImage(target, tab.rel) : Promise.resolve(null))}
                saveAttachment={handleSaveAttachment}
                replacePlaceholder={handleReplacePlaceholder}
                onChange={(d) => {
                  onDocChange(d);
                  handleChange(id, tab.path, d); // path-scoped save; skips this pane's active doc
                }}
              />
            )}
          />
        ) : path && isViewPath(path) ? (
          <div className="leaf-view" key={`${id}:${path}:view`}>
            {(() => {
              const spec = parseViewPath(path);
              return spec ? renderLeafView(spec) : <div className="placeholder">Unknown view.</div>;
            })()}
          </div>
        ) : path ? (
          /\.canvas$/i.test(path) ? (
            <ErrorBoundary key={`${id}:${path}:canvas`} resetKey={path} onClose={() => void closeTab(id, path)}>
              <CanvasView
                doc={pane.doc}
                onOpenFile={(file, subpath) => openViewerFile(file + (subpath ?? ""))}
                onOpenUrl={handleOpenUrl}
                resolveImage={(target) =>
                  vaultRef.current ? resolveImage(target, rel) : Promise.resolve(null)
                }
                onChange={(json) => handleViewerChange(id, path, json)}
              />
            </ErrorBoundary>
          ) : /\.base$/i.test(path) ? (
            <ErrorBoundary key={`${id}:${path}:base`} resetKey={path} onClose={() => void closeTab(id, path)}>
              <Suspense fallback={<div className="placeholder">Loading base…</div>}>
                <BaseView
                  doc={pane.doc}
                  sourceRel={rel}
                  notes={notes}
                  attachments={attachmentsList}
                  structureVersion={structureVersion}
                  tagsOf={tagsOf}
                  linkKeysOf={linkKeysOf}
                  onOpenFile={openViewerFile}
                  resolveImageRel={resolveImageRel}
                  onChange={(yaml) => handleViewerChange(id, path, yaml)}
                />
              </Suspense>
            </ErrorBoundary>
          ) : readingMode ? (
            <ReadingView
              key={`${id}:${path}:read`}
              doc={pane.doc}
              selfRel={rel}
              dark={dark}
              onOpenInternal={handleOpenWikilink}
              onOpenUrl={handleOpenUrl}
              onToggleTask={(line) => {
                if (!isMarkdownPath(path)) return;
                const next = toggleTaskLine(pane.doc, line);
                if (next === null || next === pane.doc) return;
                patchPane(id, { doc: next }); // reading view re-renders toggled
                handleChange(id, path, next); // pending + debounced save
              }}
              resolveImage={(target) =>
                vaultRef.current ? resolveImage(target, rel) : Promise.resolve(null)
              }
            />
          ) : (
            <EditorPane
              key={`${id}:${path}`}
              path={path}
              selfRel={rel}
              pluginVersion={pluginVersion}
              apiRef={id === focusedId ? editorApiRef : undefined}
              doc={pane.doc}
              scrollToLine={pane.scrollToLine}
              getNotes={getNotes}
              getLinkFormat={getLinkFormat}
              getActiveRel={() => rel || null}
              getHeadings={getHeadings}
              getBlockIds={getBlockIds}
              sourceMode={sourceMode}
              dark={dark}
              spellcheck={spellcheck}
              vim={vim}
              rtl={rtl}
              onOpenWikilink={handleOpenWikilink}
              onOpenUrl={handleOpenUrl}
              resolveImage={(target) =>
                vaultRef.current ? resolveImage(target, rel) : Promise.resolve(null)
              }
              saveAttachment={handleSaveAttachment}
              replacePlaceholder={handleReplacePlaceholder}
              onChange={(doc) => handleChange(id, path, doc)}
              onCursor={id === focusedId ? handleCursor : undefined}
              onContextMenu={id === focusedId ? (x, y) => setEditorMenu({ x, y }) : undefined}
            />
          )
        ) : (
          <div className="placeholder">Select a note, or press + to create one.</div>
        )}
        {tabDragging && (
          <div
            className="pane-dropzone"
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes("application/x-basalt-tab")) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              const edge = pickEdge((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
              setDropEdge(edge === "center" ? null : { paneId: id, edge });
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDropEdge(null);
            }}
            onDrop={(e) => {
              const raw = e.dataTransfer.getData("application/x-basalt-tab");
              setDropEdge(null);
              const nl = raw.indexOf("\n");
              if (nl < 0) return;
              const r = e.currentTarget.getBoundingClientRect();
              const edge = pickEdge((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
              if (edge === "center") return; // center → tab bar handles move-into
              e.preventDefault();
              void handleTabDropToEdge(raw.slice(0, nl), raw.slice(nl + 1), id, edge);
            }}
          >
            {dropEdge?.paneId === id && <div className={`pane-drop-indicator ${dropEdge.edge}`} />}
          </div>
        )}
        </div>
      </div>
    );
  };

  return (
    <div
      className={readableWidth ? "app readable-width" : "app"}
    >
      <div className="workspace">
      <Ribbon
        pluginVersion={pluginVersion}
        onToggleSidebar={() => toggleLeftDock()}
        onQuickSwitcher={() => setModal("switcher")}
        onSearch={() => {
          setSearchSeed("");
          setModal("search");
        }}
        onCommandPalette={() => setModal("commands")}
        onGraph={() => setGraphOpen(true)}
        onSettings={() => setModal("settings")}
      />
      <main className="main">
        <div className="toolbar">
          <button className="link-btn" onClick={openVaultSwitcher} title="Switch vault (recent / open a folder)">
            Vault…
          </button>
          <button className="link-btn" onClick={() => setGraphOpen(true)} title="Graph view">
            Graph
          </button>
          <button
            className={readingMode ? "link-btn toggled" : "link-btn"}
            onClick={toggleReading}
            title="Toggle Reading view (rendered, read-only)"
            disabled={activeIsViewer}
          >
            Reading
          </button>
          <button
            className={sourceMode ? "link-btn toggled" : "link-btn"}
            onClick={toggleSourceMode}
            title="Toggle Source mode (raw Markdown)"
            disabled={readingMode || activeIsViewer}
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
                : activeIsBase
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
      </div>
      <StatusBar cursor={cursor} words={docStats?.words ?? 0} chars={docStats?.chars ?? 0} pluginVersion={pluginVersion} />
      {modal === "switcher" && (
        <Palette<VaultNote>
          placeholder="Open or create a note…"
          getItems={(q) => {
            const items = switcherItems(q);
            const query = q.trim();
            // Offer "Create <query>" when the name doesn't already exist (Obsidian).
            if (query && !items.some((n) => normalizeName(n.name) === normalizeName(query))) {
              return [...items, { path: SWITCHER_CREATE, name: query, rel: "", content: "" }];
            }
            return items;
          }}
          itemKey={(n) => n.path}
          renderItem={(n) =>
            n.path === SWITCHER_CREATE ? (
              <span className="palette-name">Create note: “{n.name}”</span>
            ) : (
              <>
                <span className="palette-name">{n.name}</span>
                <span className="palette-sub">{n.rel}</span>
              </>
            )
          }
          onSelect={(n) => {
            setModal(null);
            if (n.path === SWITCHER_CREATE) void createAndOpen(n.name);
            else openNoteByPath(n.path);
          }}
          onClose={() => setModal(null)}
          emptyText="No notes"
        />
      )}
      {modal === "search" && (
        <Palette<SearchHit>
          placeholder="Search… (path: file: tag: line:(a b) -exclude OR &quot;phrase&quot; /regex/)"
          initialQuery={searchSeed}
          getItems={(q) => searchVault(notesRef.current, q, { tagsOf: (p) => index.current.tagsOf(p) })}
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
          onImportFromObsidian={() => void handleImportFromObsidian()}
          importReport={importReport}
          onThemeMode={setThemeMode}
          obsConfig={obsConfigRef.current}
          plugins={installedPlugins}
          enabledPlugins={vault ? loadEnabled(vault) : []}
          onTogglePlugin={(info, on) => void setPluginEnabled(info, on)}
          readableWidth={readableWidth}
          onReadableWidth={setReadableWidth}
          spellcheck={spellcheck}
          onSpellcheck={setSpellcheck}
          vim={vim}
          onVim={setVim}
          rtl={rtl}
          onRtl={setRtl}
          fontSize={fontSize}
          onFontSize={setFontSize}
          accent={accent || getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#a98be0"}
          onAccent={setAccent}
          cssSnippets={cssSnippets.map((s) => s.name)}
          disabledSnippets={disabledSnippets}
          onToggleSnippet={toggleSnippet}
          commands={commands.map((c) => ({ id: c.id, label: c.label }))}
          hotkeys={hotkeys}
          onSetHotkey={(id, chord) =>
            setHotkeys((prev) => {
              const next = { ...prev };
              // one command per chord: unbind any other command using it
              if (chord) for (const [k, v] of Object.entries(next)) if (v === chord && k !== id) delete next[k];
              if (chord) next[id] = chord;
              else delete next[id];
              return next;
            })
          }
          onClose={() => setModal(null)}
        />
      )}
      {modal === "workspaces" && (
        <WorkspacesModal
          names={Object.keys(namedWorkspaces).sort((a, b) => a.localeCompare(b))}
          onSave={saveWorkspaceAs}
          onLoad={(name) => {
            setModal(null);
            void loadWorkspace(name);
          }}
          onDelete={deleteWorkspace}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "vaults" && (
        <VaultSwitcher
          recents={recentVaults}
          currentVault={vault}
          onOpen={(p) => {
            setModal(null);
            void openVault(p).catch((e) => setSaveError(`Couldn't open vault: ${e}`));
          }}
          onOpenNewWindow={(p) => {
            setModal(null);
            void handleOpenInNewWindow(p);
          }}
          onPickFolder={() => {
            setModal(null);
            void handleOpenVault();
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "templates" && (
        <Palette<VaultNote>
          placeholder="Insert template…"
          getItems={(q) => fuzzyRank(q, templateNotes(), (n) => [n.name, n.rel])}
          itemKey={(n) => n.path}
          renderItem={(n) => (
            <>
              <span className="palette-name">{n.name}</span>
              <span className="palette-sub">{n.rel}</span>
            </>
          )}
          onSelect={(n) => {
            setModal(null);
            void insertTemplate(n);
          }}
          onClose={() => setModal(null)}
          emptyText={`No templates in "${templatesFolder()}/"`}
        />
      )}
      {templatePrompt && (
        <PromptModal
          title={templatePrompt.message}
          defaultValue={templatePrompt.def}
          confirmLabel="OK"
          onConfirm={(v) => {
            templatePrompt.resolve(v);
            setTemplatePrompt(null);
          }}
          onClose={() => {
            templatePrompt.resolve(null);
            setTemplatePrompt(null);
          }}
        />
      )}
      {modal === "history" && (
        <VersionHistory
          noteName={activeName ?? "note"}
          snapshots={versionSnapshots}
          onRestore={restoreSnapshot}
          onClose={() => setModal(null)}
        />
      )}
      {notices.length > 0 && (
        <div className="notices">
          {notices.map((n) => (
            <div key={n.id} className="notice" onClick={() => setNotices((x) => x.filter((y) => y.id !== n.id))}>
              {n.msg}
            </div>
          ))}
        </div>
      )}
      {tabMenu &&
        (() => {
          const pane = panes[tabMenu.paneId];
          const pinned = pane?.pinned?.includes(tabMenu.path) ?? false;
          const idx = pane?.tabs.indexOf(tabMenu.path) ?? -1;
          const hasOthers = (pane?.tabs.length ?? 0) > 1;
          const hasRight = idx >= 0 && idx < (pane?.tabs.length ?? 0) - 1;
          const run = (fn: () => void) => {
            setTabMenu(null);
            fn();
          };
          return (
            <div className="ctx-overlay" onMouseDown={() => setTabMenu(null)} onContextMenu={(e) => e.preventDefault()}>
              <div className="ctx-menu" style={{ left: tabMenu.x, top: tabMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
                <button className="ctx-item" onClick={() => run(() => void closeTab(tabMenu.paneId, tabMenu.path))}>
                  Close
                </button>
                <button className="ctx-item" disabled={!hasOthers} onClick={() => run(() => void closeOtherTabs(tabMenu.paneId, tabMenu.path))}>
                  Close others
                </button>
                <button className="ctx-item" disabled={!hasRight} onClick={() => run(() => void closeTabsToRight(tabMenu.paneId, tabMenu.path))}>
                  Close to the right
                </button>
                <button className="ctx-item" onClick={() => run(() => togglePin(tabMenu.paneId, tabMenu.path))}>
                  {pinned ? "Unpin" : "Pin"}
                </button>
                <button className="ctx-item" onClick={() => run(() => void splitTabRight(tabMenu.paneId, tabMenu.path))}>
                  Split right
                </button>
                {!isViewPath(tabMenu.path) && notes.some((n) => n.path === tabMenu.path) && (
                  <>
                    <button className="ctx-item" onClick={() => run(() => void openNoteInNewWindow(tabMenu.path))}>
                      Open in new window
                    </button>
                    <button className="ctx-item" onClick={() => run(() => void moveTabToNewWindow(tabMenu.paneId, tabMenu.path))}>
                      Move to new window
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })()}
      {editorMenu &&
        (() => {
          const api = editorApiRef.current;
          const hasSel = api?.hasSelection() ?? false;
          const run = (fn: (() => void) | undefined) => {
            setEditorMenu(null);
            fn?.();
          };
          return (
            <div className="ctx-overlay" onMouseDown={() => setEditorMenu(null)} onContextMenu={(e) => e.preventDefault()}>
              <div className="ctx-menu" style={{ left: editorMenu.x, top: editorMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
                <button className="ctx-item" disabled={!hasSel} onClick={() => run(api?.cut)}>
                  Cut
                </button>
                <button className="ctx-item" disabled={!hasSel} onClick={() => run(api?.copy)}>
                  Copy
                </button>
                <button className="ctx-item" onClick={() => run(api?.paste)}>
                  Paste
                </button>
                <div className="ctx-sep" />
                <button className="ctx-item" onClick={() => run(api?.bold)}>
                  Bold
                </button>
                <button className="ctx-item" onClick={() => run(api?.italic)}>
                  Italic
                </button>
              </div>
            </div>
          );
        })()}
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
              className="ctx-item"
              onClick={() => {
                const path = fileMenu.path;
                setFileMenu(null);
                void toggleBookmark(path);
              }}
            >
              {(() => {
                const rel = notes.find((n) => n.path === fileMenu.path)?.rel;
                // Only a WHOLE-file bookmark (no subpath) counts — a heading/block
                // bookmark of the same file must not flip the label.
                return rel && bookmarks.some((b) => b.type === "file" && b.path === rel && !b.subpath)
                  ? "Remove bookmark"
                  : "Bookmark";
              })()}
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                const path = fileMenu.path;
                setFileMenu(null);
                void openInNewSplit(path);
              }}
            >
              Open to the right
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                const path = fileMenu.path;
                setFileMenu(null);
                void openNoteInNewWindow(path);
              }}
            >
              Open in new window
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                const path = fileMenu.path;
                setFileMenu(null);
                void handleDuplicateNote(path);
              }}
            >
              Make a copy
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                const rel = notes.find((n) => n.path === fileMenu.path)?.rel ?? fileMenu.path;
                setFileMenu(null);
                void navigator.clipboard?.writeText(rel).catch(() => {});
              }}
            >
              Copy path
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                const path = fileMenu.path;
                setFileMenu(null);
                void revealItemInDir(path).catch((e) => setSaveError(`Couldn't reveal: ${e}`));
              }}
            >
              Reveal in file manager
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
      {attMenu && (
        <div className="ctx-overlay" onMouseDown={() => setAttMenu(null)} onContextMenu={(e) => e.preventDefault()}>
          <div
            className="ctx-menu"
            style={{ left: attMenu.x, top: attMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="ctx-item"
              onClick={() => {
                const path = attMenu.path;
                setAttMenu(null);
                void revealItemInDir(path).catch((e) => setSaveError(`Couldn't reveal: ${e}`));
              }}
            >
              Reveal in file manager
            </button>
            <button
              className="ctx-item danger"
              onClick={() => {
                const path = attMenu.path;
                setAttMenu(null);
                void handleDeleteAttachment(path);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
      {folderMenu && (
        <div className="ctx-overlay" onMouseDown={() => setFolderMenu(null)} onContextMenu={(e) => e.preventDefault()}>
          <div className="ctx-menu" style={{ left: folderMenu.x, top: folderMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
            <button
              className="ctx-item"
              onClick={() => {
                const folder = folderMenu.folderRel;
                setFolderMenu(null);
                void handleNewNoteIn(folder);
              }}
            >
              New note here
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                const folder = folderMenu.folderRel;
                setFolderMenu(null);
                setSubfolderParent(folder);
              }}
            >
              New folder…
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                const folder = folderMenu.folderRel;
                setFolderMenu(null);
                setRenameFolderTarget(folder);
              }}
            >
              Rename folder…
            </button>
            <button
              className="ctx-item danger"
              onClick={() => {
                const folder = folderMenu.folderRel;
                setFolderMenu(null);
                void handleDeleteFolder(folder);
              }}
            >
              Delete folder
            </button>
          </div>
        </div>
      )}
      {renameFolderTarget !== null && (
        <PromptModal
          title="Rename folder (edit the path to move it)"
          defaultValue={renameFolderTarget}
          confirmLabel="Rename"
          onConfirm={(value) => {
            const from = renameFolderTarget;
            setRenameFolderTarget(null);
            const to = value.trim().replace(/^[\\/]+|[\\/]+$/g, "");
            if (!to || /[#^\[\]|]/.test(to)) {
              if (to) setSaveError("Folder names cannot contain # ^ [ ] |");
              return;
            }
            void handleRenameFolder(from, to);
          }}
          onClose={() => setRenameFolderTarget(null)}
        />
      )}
      {subfolderParent !== null && (
        <PromptModal
          title="New folder name"
          defaultValue=""
          confirmLabel="Create"
          onConfirm={(value) => {
            const parent = subfolderParent;
            setSubfolderParent(null);
            const folder = value.trim().replace(/[\\/]+$/, "");
            if (!folder || /[#^[\]|]/.test(folder)) {
              if (folder) setSaveError("Folder names cannot contain # ^ [ ] |");
              return;
            }
            const full = (parent ? `${parent}/` : "") + folder;
            void handleNewNoteIn(full); // a starter note makes the new folder appear
          }}
          onClose={() => setSubfolderParent(null)}
        />
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
          depth={graphDepth}
          onSetDepth={setGraphDepth}
          onOpenNode={handleOpenGraphNode}
          onClose={handleCloseGraph}
        />
      )}
      {slidesOpen &&
        focusedPane?.active &&
        (() => {
          const srel = notes.find((n) => n.path === focusedPane.active)?.rel ?? "";
          return (
            <SlidesView
              doc={focusedPane.doc}
              selfRel={srel}
              dark={dark}
              onOpenInternal={(t) => {
                setSlidesOpen(false);
                void handleOpenWikilink(t);
              }}
              onOpenUrl={handleOpenUrl}
              resolveImage={(target) => (vaultRef.current ? resolveImage(target, srel) : Promise.resolve(null))}
              onClose={() => setSlidesOpen(false)}
            />
          );
        })()}
      {recSeconds !== null && (
        <div className="rec-indicator" role="status">
          <span className="rec-dot" aria-hidden />
          Recording {Math.floor(recSeconds / 60)}:{String(recSeconds % 60).padStart(2, "0")}
          <button className="rec-stop" onClick={() => void stopRecording(true)}>
            Stop &amp; insert
          </button>
          <button className="rec-discard" onClick={() => void stopRecording(false)}>
            Discard
          </button>
        </div>
      )}
    </div>
  );
}
