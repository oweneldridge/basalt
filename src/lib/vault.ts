// Typed wrappers over the Rust vault commands. This is the *only* path the
// frontend has to the filesystem — see src-tauri/src/lib.rs. The canonical
// vault root lives in Rust managed state (set by openVaultBackend), so no
// command here can name a location outside the open vault.
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface Note {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the vault root. */
  rel: string;
  /** File stem (the wikilink-able name). */
  name: string;
}

/** A note plus its content, returned in bulk for indexing. */
export interface VaultNote extends Note {
  content: string;
}

/** A note reported changed by the watcher: absolute path + vault-relative path. */
export interface ChangedNote {
  path: string;
  rel: string;
}

/** Open a vault in the backend; returns the CANONICAL root path. */
export function openVaultBackend(path: string): Promise<string> {
  return invoke<string>("open_vault", { path });
}

/** Read every note in the open vault with content (one IPC call) for indexing. */
export function readVault(): Promise<VaultNote[]> {
  return invoke<VaultNote[]>("read_vault");
}

export function readNote(path: string): Promise<string> {
  return invoke<string>("read_note", { path });
}

export function writeNote(path: string, content: string): Promise<void> {
  return invoke<void>("write_note", { path, content });
}

export function createNote(name: string): Promise<string> {
  return invoke<string>("create_note", { name });
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
