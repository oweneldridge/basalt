// Typed wrappers over the Rust vault commands. This is the *only* path the
// frontend has to the filesystem — see src-tauri/src/lib.rs. The canonical
// vault root lives in Rust managed state (set by openVaultBackend), so no
// command here can name a location outside the open vault.
import { invoke, open } from "./platform";

export interface Note {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the vault root. */
  rel: string;
  /** File stem (the wikilink-able name). */
  name: string;
}

/** File stats shipped by the backend (ms epoch / bytes; 0 or absent when
 * unavailable) — they feed Bases' file.mtime/ctime/size. Optional because
 * frontend-constructed entries (e.g. a just-created note) omit them. */
export interface FileStats {
  mtime?: number;
  ctime?: number;
  size?: number;
}

/** A note plus its content, returned in bulk for indexing. */
export interface VaultNote extends Note, FileStats {
  content: string;
}

/** A note reported changed by the watcher: absolute path + vault-relative path. */
export interface ChangedNote {
  path: string;
  rel: string;
}

/** A non-Markdown vault file (image/PDF/audio/video) — no content shipped. */
export interface Attachment extends FileStats {
  path: string;
  rel: string;
  /** Filename including extension (the link-able name). */
  name: string;
}

/** Open a vault in the backend; returns the CANONICAL root path. */
export function openVaultBackend(path: string): Promise<string> {
  return invoke<string>("open_vault", { path });
}

/** Read every note in the open vault with content (one IPC call) for indexing. */
export function readVault(): Promise<VaultNote[]> {
  return invoke<VaultNote[]>("read_vault");
}

/** Open a new app window. With `vault`, that window opens it directly; with
 * `note` (a vault-relative path), it also opens that note. Returns the label. */
export function openNewWindow(vault?: string, note?: string): Promise<string> {
  return invoke<string>("open_new_window", { vault: vault ?? null, note: note ?? null });
}

/** The `basalt://` URL the app was launched with (consumed once), or null. */
export function takePendingDeepLink(): Promise<string | null> {
  return invoke<string | null>("take_pending_deep_link");
}

export function readNote(path: string): Promise<string> {
  return invoke<string>("read_note", { path });
}

/** Error text the core returns when a write's `expected` no longer matches the
 * file on disk (basalt-core WRITE_CONFLICT; keep the two identical). */
export const WRITE_CONFLICT = "Changed on disk since Basalt last read it";

export function isWriteConflict(e: unknown): boolean {
  return String(e).includes(WRITE_CONFLICT);
}

/** Write a note. With `expected` (what the caller last saw on disk) the core
 * refuses with WRITE_CONFLICT if someone else changed the file in between. */
// Text being written right now, by path. A write can land, and the watcher
// read it, before its reply comes back; that text is Basalt's own.
const inFlight = new Map<string, string[]>();

async function tracked(path: string, content: string, write: Promise<void>): Promise<void> {
  const list = inFlight.get(path) ?? [];
  list.push(content);
  inFlight.set(path, list);
  try {
    await write;
  } finally {
    // Dropped a tick later, so a read racing the caller's own bookkeeping
    // after the reply still matches.
    setTimeout(() => {
      const l = inFlight.get(path);
      if (!l) return;
      l.splice(l.indexOf(content), 1);
      if (l.length === 0) inFlight.delete(path);
    }, 0);
  }
}

/** Whether Basalt is writing to `path` right now. */
export function isWriting(path: string): boolean {
  return inFlight.has(path);
}

/** Whether `content` is what Basalt is writing to `path` right now. */
export function isBeingWritten(path: string, content: string): boolean {
  return inFlight.get(path)?.includes(content) ?? false;
}

export function writeNote(path: string, content: string, expected?: string): Promise<void> {
  return tracked(path, content, invoke<void>("write_note", { path, content, expected: expected ?? null }));
}

/** Atomically write an existing `.canvas` file (extension-gated in Rust). */
export function writeCanvas(path: string, content: string, expected?: string): Promise<void> {
  return tracked(path, content, invoke<void>("write_canvas", { path, content, expected: expected ?? null }));
}

/** Atomically write an existing `.base` file (extension-gated in Rust). */
export function writeBase(path: string, content: string, expected?: string): Promise<void> {
  return tracked(path, content, invoke<void>("write_base", { path, content, expected: expected ?? null }));
}

export function createNote(name: string): Promise<string> {
  return invoke<string>("create_note", { name });
}

/** Move a note to the vault's .trash/ (recoverable, Obsidian-compatible). */
export function deleteNote(path: string): Promise<void> {
  return invoke<void>("delete_note", { path });
}

/** Rename/move a note to a folder-qualified name (no .md); returns the new path. */
export function renameNote(path: string, newName: string): Promise<string> {
  return invoke<string>("rename_note", { path, newName });
}

/** Rename/move an attachment, canvas or base: `newName` is folder-qualified,
 * without the extension, which the file keeps. Returns the new path. */
export function renameAttachment(path: string, newName: string): Promise<string> {
  return invoke<string>("rename_attachment", { path, newName });
}

/** Move a whole folder (vault-relative path) to the vault's .trash/. */
export function deleteFolder(rel: string): Promise<void> {
  return invoke<void>("delete_folder", { rel });
}

/** Remove a folder only if it's (recursively) empty — post-rename cleanup. */
export function removeEmptyFolder(rel: string): Promise<void> {
  return invoke<void>("remove_empty_folder", { rel });
}

/** Non-Markdown files under a folder (any type; capped at 20) — a folder
 * rename refuses when these exist rather than silently splitting the folder. */
export function listForeignFiles(rel: string): Promise<string[]> {
  return invoke<string[]>("list_foreign_files", { rel });
}

/** Every subfolder under `rel` (vault-relative), including empty ones. */
export function listSubfolders(rel: string): Promise<string[]> {
  return invoke<string[]>("list_subfolders", { rel });
}

/** Create a folder (validated, vault-contained). */
export function createFolder(rel: string): Promise<void> {
  return invoke<void>("create_folder", { rel });
}

/** Move a whole folder to `toRel` in one fs::rename (contents + basenames
 * preserved). Returns the canonical new absolute path. */
export function renameFolder(fromRel: string, toRel: string): Promise<string> {
  return invoke<string>("rename_folder", { fromRel, toRel });
}

/** Every folder in the open vault, empty ones included (not dot-folders). */
export function listFolders(): Promise<string[]> {
  return invoke<string[]>("list_folders");
}

/** List every attachment (supported non-md file) in the open vault. */
export function listAttachments(): Promise<Attachment[]> {
  return invoke<Attachment[]>("list_attachments");
}

/** Save a pasted/dropped attachment; returns the created entry. */
export function writeAttachment(
  name: string,
  dataB64: string,
  sourceRel: string,
): Promise<Attachment> {
  return invoke<Attachment>("write_attachment", { name, dataB64, sourceRel });
}

/** Read-only view of the Obsidian settings Basalt honors. */
export interface ObsidianConfig {
  newLinkFormat?: string | null;
  useMarkdownLinks?: boolean | null;
  strictLineBreaks?: boolean | null;
  promptDelete?: boolean | null;
  showLineNumber?: boolean | null;
  readableLineLength?: boolean | null;
  attachmentFolderPath?: string | null;
  dailyNotesFolder?: string | null;
  dailyNotesFormat?: string | null;
  dailyNotesTemplate?: string | null;
  templatesFolder?: string | null;
  templatesDateFormat?: string | null;
  templatesTimeFormat?: string | null;
}

export function readObsidianConfig(): Promise<ObsidianConfig> {
  return invoke<ObsidianConfig>("read_obsidian_config");
}

/** Raw `.obsidian/` config for the "Import from Obsidian" flow. */
export interface ObsidianImportRaw {
  appearance: string | null;
  hotkeys: string | null;
  communityPlugins: string[];
  /** The active community theme's CSS (for the palette bridge), or null. */
  themeCss: string | null;
}
export function readObsidianImport(): Promise<ObsidianImportRaw> {
  return invoke<ObsidianImportRaw>("read_obsidian_import");
}

/** A CSS snippet from `.basalt/snippets/*.css`. */
export interface CssSnippet {
  name: string;
  css: string;
  /** From `.obsidian/snippets` (else `.basalt/snippets`). */
  fromObsidian?: boolean;
  /** Listed in Obsidian's appearance.json `enabledCssSnippets`. */
  enabledInObsidian?: boolean;
}
export function listCssSnippets(): Promise<CssSnippet[]> {
  return invoke<CssSnippet[]>("list_css_snippets");
}

/** Raw plugin as read from `.basalt/plugins/<id>/`. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  minAppVersion: string;
  code: string;
  data: string | null;
}
export function listPlugins(): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>("list_plugins");
}
export function writePluginData(id: string, data: string): Promise<void> {
  return invoke<void>("write_plugin_data", { id, data });
}

/** A flattened entry from `.obsidian/bookmarks.json`. */
export interface Bookmark {
  type: string; // file | folder | heading | block | search | graph
  title: string;
  path?: string | null; // vault-relative (file / folder / heading / block)
  subpath?: string | null; // #heading / #^block
  query?: string | null; // search bookmarks
  group?: string | null; // containing group's title
}

export function readObsidianBookmarks(): Promise<Bookmark[]> {
  return invoke<Bookmark[]>("read_obsidian_bookmarks");
}

/** Toggle a file bookmark in `.obsidian/bookmarks.json`; resolves to the new
 * state (true = now bookmarked). Preserves all other bookmarks/groups. */
export function toggleFileBookmark(path: string): Promise<boolean> {
  return invoke<boolean>("toggle_file_bookmark", { path });
}

/** Show the native save dialog and write the export there; null if cancelled. */
export function exportFile(defaultName: string, content: string): Promise<string | null> {
  return invoke<string | null>("export_file", { defaultName, content });
}

/** Start (or restart) watching the open vault for on-disk changes. */
export function startWatching(): Promise<void> {
  return invoke<void>("start_watching");
}

/** Display name (file stem) from a vault-relative path. */
export function nameFromRel(rel: string): string {
  const base = rel.split(/[/\\]/).pop() ?? rel;
  return base.replace(/\.md$/i, "");
}

/** Show the OS folder picker and return the chosen vault path, or null. */
export async function pickVault(): Promise<string | null> {
  const result = await open({ directory: true, multiple: false, title: "Open vault" });
  return typeof result === "string" ? result : null;
}
