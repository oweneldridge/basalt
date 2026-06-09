// Typed wrappers over the Rust vault commands. This is the *only* path the
// frontend has to the filesystem — see src-tauri/src/lib.rs.
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

export function listNotes(vault: string): Promise<Note[]> {
  return invoke<Note[]>("list_notes", { vault });
}

/** Read every note in the vault with content (one IPC call) for indexing. */
export function readVault(vault: string): Promise<VaultNote[]> {
  return invoke<VaultNote[]>("read_vault", { vault });
}

export function readNote(vault: string, path: string): Promise<string> {
  return invoke<string>("read_note", { vault, path });
}

export function writeNote(vault: string, path: string, content: string): Promise<void> {
  return invoke<void>("write_note", { vault, path, content });
}

export function createNote(vault: string, name: string): Promise<string> {
  return invoke<string>("create_note", { vault, name });
}

/** Show the OS folder picker and return the chosen vault path, or null. */
export async function pickVault(): Promise<string | null> {
  const result = await open({ directory: true, multiple: false, title: "Open vault" });
  return typeof result === "string" ? result : null;
}
