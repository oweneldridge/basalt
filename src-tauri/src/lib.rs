// Basalt — local-first Markdown knowledge base.
// Copyright (C) 2026 Owen Eldridge
// Licensed under AGPL-3.0-or-later. See LICENSE.
//
// The vault is a plain folder of Markdown files (Obsidian-compatible). All file
// IO lives here in Rust rather than being exposed to the webview, so the
// frontend can only touch the filesystem through these explicit commands, and
// every path is validated to live inside the open vault.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// A single Markdown note discovered within a vault.
#[derive(Serialize, Clone)]
struct NoteEntry {
    /// Absolute path on disk.
    path: String,
    /// Path relative to the vault root (used for display / wikilink resolution).
    rel: String,
    /// File stem without extension (the wikilink-able name).
    name: String,
}

/// A note plus its full content — returned in bulk so the frontend can build
/// its link/metadata index in a single IPC round-trip.
#[derive(Serialize, Clone)]
struct VaultNote {
    path: String,
    rel: String,
    name: String,
    content: String,
}

/// Directories we never descend into. `.obsidian` keeps Basalt and Obsidian
/// able to share a vault without fighting over config.
fn is_ignored_dir(name: &str) -> bool {
    matches!(name, ".obsidian" | ".git" | ".trash" | "node_modules") || name.starts_with('.')
}

/// Windows reserved device names — rejected on every platform for portability.
fn is_reserved_name(stem: &str) -> bool {
    let upper = stem.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    // COM1-9 and LPT1-9
    let bytes = upper.as_bytes();
    if upper.len() == 4 && (upper.starts_with("COM") || upper.starts_with("LPT")) {
        let d = bytes[3];
        return d.is_ascii_digit() && d != b'0';
    }
    false
}

/// Resolve `path` and confirm it lives inside `vault`. Existing files are
/// canonicalized directly; for not-yet-existing files (new notes) we canonicalize
/// the parent directory and rejoin the name. Returns the resolved absolute path.
fn ensure_in_vault(vault: &str, path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(vault).map_err(|e| format!("vault: {e}"))?;
    let target = PathBuf::from(path);
    let resolved = if target.exists() {
        fs::canonicalize(&target).map_err(|e| format!("path: {e}"))?
    } else {
        let parent = target.parent().ok_or("invalid path")?;
        let cparent = fs::canonicalize(parent).map_err(|e| format!("path: {e}"))?;
        let name = target.file_name().ok_or("invalid path")?;
        cparent.join(name)
    };
    if resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err("path escapes vault".into())
    }
}

fn collect_md(dir: &Path, root: &Path, out: &mut Vec<NoteEntry>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        // Never follow symlinks — a dir symlink to an ancestor would loop forever.
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if ft.is_dir() {
            if !is_ignored_dir(&file_name) {
                collect_md(&path, root, out);
            }
        } else if path.extension().and_then(|s| s.to_str()) == Some("md") {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| file_name.clone());
            out.push(NoteEntry {
                path: path.to_string_lossy().to_string(),
                rel,
                name,
            });
        }
    }
}

fn collect_vault(dir: &Path, root: &Path, out: &mut Vec<VaultNote>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if ft.is_dir() {
            if !is_ignored_dir(&file_name) {
                collect_vault(&path, root, out);
            }
        } else if path.extension().and_then(|s| s.to_str()) == Some("md") {
            // Lossily decode non-UTF8 (preserving links) rather than blanking the
            // note; skip on a hard IO error rather than inserting empty content.
            let content = match fs::read(&path) {
                Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                Err(_) => continue,
            };
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| file_name.clone());
            out.push(VaultNote {
                path: path.to_string_lossy().to_string(),
                rel,
                name,
                content,
            });
        }
    }
}

/// List every Markdown note in a vault, sorted by relative path.
#[tauri::command]
fn list_notes(vault: String) -> Vec<NoteEntry> {
    let root = PathBuf::from(&vault);
    let mut out = Vec::new();
    collect_md(&root, &root, &mut out);
    out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    out
}

/// Read every note in a vault *with its content*, in one call. Powers the
/// frontend link/metadata index (backlinks, unlinked mentions, graph).
#[tauri::command]
fn read_vault(vault: String) -> Vec<VaultNote> {
    let root = PathBuf::from(&vault);
    let mut out = Vec::new();
    collect_vault(&root, &root, &mut out);
    out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    out
}

/// Read a note's contents as UTF-8. Errors on non-UTF8 rather than lossily
/// decoding, so that a later save can't silently re-encode and corrupt the file.
#[tauri::command]
fn read_note(vault: String, path: String) -> Result<String, String> {
    let resolved = ensure_in_vault(&vault, &path)?;
    fs::read_to_string(&resolved).map_err(|e| format!("read {}: {e}", resolved.display()))
}

/// Write a note's contents, only within the vault.
#[tauri::command]
fn write_note(vault: String, path: String, content: String) -> Result<(), String> {
    let resolved = ensure_in_vault(&vault, &path)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::write(&resolved, content).map_err(|e| format!("write {}: {e}", resolved.display()))
}

/// Create a new empty note `<vault>/<name>.md`, returning its absolute path.
/// Fails if a note with that name already exists or the name is invalid.
#[tauri::command]
fn create_note(vault: String, name: String) -> Result<String, String> {
    let safe: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let safe = safe.trim();
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err("invalid note name".into());
    }
    if is_reserved_name(safe) {
        return Err(format!("'{safe}' is a reserved name"));
    }
    if safe.len() > 200 {
        return Err("note name is too long".into());
    }
    let mut path = PathBuf::from(&vault);
    path.push(format!("{safe}.md"));
    if path.exists() {
        return Err(format!("note already exists: {safe}"));
    }
    fs::write(&path, "").map_err(|e| format!("create {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_notes,
            read_vault,
            read_note,
            write_note,
            create_note
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
