// Basalt — local-first Markdown knowledge base.
// Copyright (C) 2026 Owen Eldridge
// Licensed under AGPL-3.0-or-later. See LICENSE.
//
// The vault is a plain folder of Markdown files (Obsidian-compatible). All file
// IO lives here in Rust rather than being exposed to the webview, so the
// frontend can only touch the filesystem through these explicit commands, and
// every path is validated to live inside the open vault.
//
// Paths are matched between read_vault and the filesystem watcher by VAULT-
// RELATIVE path (not absolute), because macOS FSEvents reports firmlink/symlink-
// resolved absolute paths (e.g. /System/Volumes/Data/...) that won't string-
// match the dialog-derived absolute path. The relative path is stable.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// A single Markdown note discovered within a vault.
#[derive(Serialize, Clone)]
struct NoteEntry {
    path: String,
    rel: String,
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

/// A changed note reported by the watcher: absolute path (for reading) plus the
/// vault-relative path (the stable key the frontend matches on).
#[derive(Serialize, Clone)]
struct ChangedNote {
    path: String,
    rel: String,
}

/// Holds the live vault watcher so it isn't dropped (which would stop watching).
struct WatcherState(Mutex<Option<notify::RecommendedWatcher>>);

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
    let bytes = upper.as_bytes();
    if upper.len() == 4 && (upper.starts_with("COM") || upper.starts_with("LPT")) {
        let d = bytes[3];
        return d.is_ascii_digit() && d != b'0';
    }
    false
}

/// The canonicalized vault root (symlinks/firmlinks resolved), or the raw path
/// if canonicalization fails (e.g. it doesn't exist).
fn canonical_root(vault: &str) -> PathBuf {
    fs::canonicalize(vault).unwrap_or_else(|_| PathBuf::from(vault))
}

/// Compute `p` relative to the vault `root`, tolerating macOS firmlink prefixes
/// that FSEvents may prepend to the watched path.
fn rel_under(root: &Path, p: &Path) -> Option<String> {
    if let Ok(r) = p.strip_prefix(root) {
        return Some(r.to_string_lossy().to_string());
    }
    let ps = p.to_string_lossy();
    for prefix in ["/System/Volumes/Data", "/private"] {
        if let Some(rest) = ps.strip_prefix(prefix) {
            if let Ok(r) = Path::new(rest).strip_prefix(root) {
                return Some(r.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Resolve `path` and confirm it lives inside `vault`.
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
    let root = canonical_root(&vault);
    let mut out = Vec::new();
    collect_md(&root, &root, &mut out);
    out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    out
}

/// Read every note in a vault *with its content*, in one call. Powers the
/// frontend link/metadata index (backlinks, unlinked mentions, graph).
#[tauri::command]
fn read_vault(vault: String) -> Vec<VaultNote> {
    let root = canonical_root(&vault);
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

/// Create a new empty note, returning its canonical path. `name` may be folder-
/// qualified (`sub/New`); parent folders are created. Each segment is sanitized
/// and `..`/absolute segments are rejected, so the result stays inside the vault.
#[tauri::command]
fn create_note(vault: String, name: String) -> Result<String, String> {
    let segments: Vec<String> = name
        .split(['/', '\\'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if segments.is_empty() {
        return Err("invalid note name".into());
    }
    let mut path = canonical_root(&vault);
    let last = segments.len() - 1;
    for (i, seg) in segments.iter().enumerate() {
        let safe: String = seg
            .chars()
            .filter(|c| !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
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
        if i == last {
            path.push(format!("{safe}.md"));
        } else {
            path.push(safe);
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    if path.exists() {
        return Err("note already exists".into());
    }
    fs::write(&path, "").map_err(|e| format!("create {}: {e}", path.display()))?;
    let canonical = fs::canonicalize(&path).unwrap_or(path);
    Ok(canonical.to_string_lossy().to_string())
}

/// Watch the vault directory recursively and emit a `vault-changed` event (with
/// the changed notes' absolute + vault-relative paths) whenever files change on
/// disk — so Basalt can live-reload when Obsidian or a sync client edits the same
/// vault. Replaces (and stops) any previous watcher.
#[tauri::command]
fn start_watching(vault: String, app: AppHandle, state: State<WatcherState>) -> Result<(), String> {
    let root = fs::canonicalize(&vault).map_err(|e| e.to_string())?;
    // Stop the previous watcher BEFORE starting the new one.
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }
    let handle = app.clone();
    let root_for_closure = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else {
            return;
        };
        let changed: Vec<ChangedNote> = event
            .paths
            .iter()
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("md"))
            .filter(|p| {
                !p.components().any(|c| {
                    let s = c.as_os_str().to_string_lossy();
                    s == ".obsidian" || s == ".git" || s == ".trash"
                })
            })
            .filter_map(|p| {
                rel_under(&root_for_closure, p).map(|rel| ChangedNote {
                    path: p.to_string_lossy().to_string(),
                    rel,
                })
            })
            .collect();
        if !changed.is_empty() {
            let _ = handle.emit("vault-changed", changed);
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Recursively find the first file named `name` (case-insensitive) under `dir`.
fn find_file(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    if depth > 16 {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
            if !is_ignored_dir(&entry.file_name().to_string_lossy()) {
                if let Some(found) = find_file(&path, name, depth + 1) {
                    return Some(found);
                }
            }
        } else if entry.file_name().to_string_lossy().eq_ignore_ascii_case(name) {
            return Some(path);
        }
    }
    None
}

/// Resolve an image reference (relative to the note's folder, then the vault
/// root, then a bare-name search) and return it as a base64 `data:` URL.
#[tauri::command]
fn read_image(vault: String, target: String, source_rel: String) -> Result<String, String> {
    let t = target.trim();
    if t.is_empty() {
        return Err("empty image target".into());
    }
    // Reject absolute / traversal targets up front (no probing outside the vault).
    let tp = Path::new(t);
    if tp.is_absolute()
        || tp
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err("invalid image target".into());
    }
    let root = fs::canonicalize(&vault).map_err(|e| format!("vault: {e}"))?;

    let mut found: Option<PathBuf> = None;
    if let Some(folder) = Path::new(&source_rel).parent() {
        let c = root.join(folder).join(t);
        if c.is_file() {
            found = Some(c);
        }
    }
    if found.is_none() {
        let c = root.join(t);
        if c.is_file() {
            found = Some(c);
        }
    }
    // Bare-name search only for a separator-less target (don't walk for paths).
    if found.is_none() && !t.contains('/') && !t.contains('\\') {
        found = find_file(&root, t, 0);
    }

    let path = found.ok_or_else(|| format!("image not found: {t}"))?;
    let canon = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) {
        return Err("path escapes vault".into());
    }
    // Check size before reading, so an oversized file isn't loaded into memory.
    let meta = fs::metadata(&canon).map_err(|e| e.to_string())?;
    if meta.len() > 25_000_000 {
        return Err("image too large".into());
    }
    let bytes = fs::read(&canon).map_err(|e| format!("read {}: {e}", canon.display()))?;
    Ok(format!("data:{};base64,{}", mime_for(&canon), base64_encode(&bytes)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            list_notes,
            read_vault,
            read_note,
            write_note,
            create_note,
            start_watching,
            read_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
