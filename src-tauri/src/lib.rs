// Basalt — local-first Markdown knowledge base.
// Copyright (C) 2026 Owen Eldridge
// Licensed under AGPL-3.0-or-later. See LICENSE.
//
// The vault is a plain folder of Markdown files (Obsidian-compatible). All file
// IO lives here in Rust rather than being exposed to the webview. The canonical
// vault root is held in managed state, set once by `open_vault`; every other
// command validates its paths against that root, so the webview can never name
// an arbitrary filesystem location. All writes are atomic (temp + fsync +
// rename), and symlinks are never followed or created through.
//
// Paths are matched between read_vault and the filesystem watcher by VAULT-
// RELATIVE path (not absolute), because macOS FSEvents reports firmlink/symlink-
// resolved absolute paths that won't string-match the dialog-derived path.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// A note plus its full content — returned in bulk so the frontend can build
/// its link/metadata index in a single IPC round-trip. File stats (ms epoch /
/// bytes; 0 when unavailable) feed Bases' file.mtime/ctime/size.
#[derive(Serialize, Clone)]
struct VaultNote {
    path: String,
    rel: String,
    name: String,
    content: String,
    mtime: u64,
    ctime: u64,
    size: u64,
}

/// (mtime ms, ctime ms, size bytes) for a file, all 0 on error — stat data is
/// display metadata, never worth failing a vault scan over.
fn file_stats(md: Option<&fs::Metadata>) -> (u64, u64, u64) {
    let Some(m) = md else { return (0, 0, 0) };
    let to_ms = |t: std::io::Result<SystemTime>| -> u64 {
        t.ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    };
    (to_ms(m.modified()), to_ms(m.created()), m.len())
}

/// A changed note reported by the watcher: absolute path (for reading) plus the
/// vault-relative path (the stable key the frontend matches on).
#[derive(Serialize, Clone)]
struct ChangedNote {
    path: String,
    rel: String,
}

/// The canonical vault root PER WINDOW (keyed by window label), set by
/// `open_vault`. Each window is an independent vault + workspace, so a command
/// validates its paths against the calling WINDOW's root — one window can never
/// name a location outside its own open vault, and never reach into another
/// window's vault.
struct VaultState(Mutex<HashMap<String, PathBuf>>);
/// The live vault watcher per window (kept alive so it isn't dropped, which
/// would stop watching).
struct WatcherState(Mutex<HashMap<String, notify::RecommendedWatcher>>);

static WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Notes larger than this are listed without content (the editor still opens
/// them on demand via read_note); keeps the bulk IPC message bounded.
const MAX_INDEXED_NOTE_BYTES: u64 = 5_000_000;
/// A plugin's main.js larger than this is skipped (a plugin is code, not data).
const MAX_PLUGIN_BYTES: u64 = 10_000_000;

/// The canonical root of the vault open in `label`'s window.
fn current_root(state: &State<VaultState>, label: &str) -> Result<PathBuf, String> {
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(label)
        .cloned()
        .ok_or_else(|| "no vault open".into())
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
    let bytes = upper.as_bytes();
    if upper.len() == 4 && (upper.starts_with("COM") || upper.starts_with("LPT")) {
        let d = bytes[3];
        return d.is_ascii_digit() && d != b'0';
    }
    false
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

/// True if any component of the (relative) path is dotted/ignored.
fn rel_has_ignored_component(rel: &str) -> bool {
    Path::new(rel)
        .components()
        .any(|c| is_ignored_dir(&c.as_os_str().to_string_lossy()))
}

/// Resolve `path` and confirm it lives inside `root`. For not-yet-existing
/// files, the parent is canonicalized and the final segment must not be a
/// symlink (a dangling symlink would otherwise let a write escape the vault).
fn ensure_in_vault(root: &Path, path: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(path);
    let resolved = if target.exists() {
        fs::canonicalize(&target).map_err(|e| format!("path: {e}"))?
    } else {
        let is_dangling_symlink = fs::symlink_metadata(&target)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        if is_dangling_symlink {
            return Err("path is a symlink".into());
        }
        let parent = target.parent().ok_or("invalid path")?;
        let cparent = fs::canonicalize(parent).map_err(|e| format!("path: {e}"))?;
        let name = target.file_name().ok_or("invalid path")?;
        cparent.join(name)
    };
    if resolved.starts_with(root) {
        Ok(resolved)
    } else {
        Err("path escapes vault".into())
    }
}

/// Atomically replace `path` with `content`: write a hidden non-`.md` temp in
/// the same directory, fsync it, then rename over the target. A crash mid-write
/// can no longer truncate the note, and we never write through a symlink.
fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    if fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("refusing to write through a symlink".into());
    }
    let parent = path.parent().ok_or("invalid path")?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(".basalt-tmp-{nanos}-{n}.tmp"));
    let result = (|| -> Result<(), String> {
        let mut f = fs::File::create(&temp).map_err(|e| format!("temp: {e}"))?;
        f.write_all(content).map_err(|e| format!("write: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync: {e}"))?;
        fs::rename(&temp, path).map_err(|e| format!("rename: {e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Remove stale atomic-write temp files (left by a crash) under `dir`.
fn sweep_temps(dir: &Path, depth: usize) {
    if depth > 32 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if ft.is_dir() {
            if !is_ignored_dir(&name) {
                sweep_temps(&entry.path(), depth + 1);
            }
        } else if name.starts_with(".basalt-tmp-") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn collect_vault(dir: &Path, root: &Path, out: &mut Vec<VaultNote>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
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
            // Cap what we inline: oversized notes are listed with empty content
            // (still openable via read_note); lossily decode non-UTF8 rather
            // than blanking; skip on a hard IO error.
            let md = entry.metadata().ok();
            let too_big = md
                .as_ref()
                .map(|m| m.len() > MAX_INDEXED_NOTE_BYTES)
                .unwrap_or(false);
            let content = if too_big {
                String::new()
            } else {
                match fs::read(&path) {
                    Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                    Err(_) => continue,
                }
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
            let (mtime, ctime, size) = file_stats(md.as_ref());
            out.push(VaultNote {
                path: path.to_string_lossy().to_string(),
                rel,
                name,
                content,
                mtime,
                ctime,
                size,
            });
        }
    }
}

/// Open a vault: canonicalize the root, store it in managed state, sweep stale
/// write temps, and return the canonical root (the path form every subsequent
/// command and event will use).
#[tauri::command]
fn open_vault(
    path: String,
    window: tauri::Window,
    state: State<VaultState>,
    watcher_state: State<WatcherState>,
) -> Result<String, String> {
    let root = fs::canonicalize(&path).map_err(|e| format!("vault: {e}"))?;
    if !root.is_dir() {
        return Err("vault is not a directory".into());
    }
    sweep_temps(&root, 0);
    let label = window.label().to_string();
    // Switching vaults: stop watching the OLD root now so its watcher can't emit
    // stale events to this window against the new vault (start_watching installs
    // a fresh one). Drop the old watcher outside the lock.
    let old = watcher_state.0.lock().map_err(|e| e.to_string())?.remove(&label);
    drop(old);
    state.0.lock().map_err(|e| e.to_string())?.insert(label, root.clone());
    Ok(root.to_string_lossy().to_string())
}

/// Open a NEW app window. If `vault` is given, that window's frontend opens it
/// (via a `?vault=` URL param); otherwise the new window shows the vault picker.
/// Each window gets a unique label and its own independent VaultState entry.
#[tauri::command]
fn open_new_window(app: AppHandle, vault: Option<String>) -> Result<String, String> {
    // Lowest free `w<n>` label. Reusing labels keeps per-window localStorage keys
    // (workspace layouts) bounded by the max concurrent window count instead of
    // growing forever, and the capability glob `w*` (capabilities/default.json)
    // covers all of them so their event/dialog/opener permissions are granted.
    let existing: std::collections::HashSet<String> = app.webview_windows().into_keys().collect();
    let mut n = 1u32;
    while existing.contains(&format!("w{n}")) {
        n += 1;
    }
    let label = format!("w{n}");
    let mut url = "index.html".to_string();
    if let Some(v) = vault {
        // percent-encode the path into the query so the frontend can read it.
        url = format!("index.html?vault={}", percent_encode(&v));
    }
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Basalt")
        .inner_size(1100.0, 760.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(label)
}

/// Minimal percent-encoding for a URL query value (path → ?vault=…).
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Read every note in the open vault *with its content*, in one call. Powers
/// the frontend link/metadata index. Async so the walk stays off the main thread.
#[tauri::command]
async fn read_vault(window: tauri::Window, state: State<'_, VaultState>) -> Result<Vec<VaultNote>, String> {
    let root = current_root(&state, window.label())?;
    let mut out = Vec::new();
    collect_vault(&root, &root, &mut out);
    out.sort_by_key(|a| a.rel.to_lowercase());
    Ok(out)
}

/// Log a frontend diagnostic message to the dev terminal.
#[tauri::command]
fn debug_log(msg: String) {
    #[cfg(debug_assertions)]
    eprintln!("[basalt-js] {msg}");
    #[cfg(not(debug_assertions))]
    let _ = msg;
}

/// Read a note's contents as UTF-8. Errors on non-UTF8 rather than lossily
/// decoding, so that a later save can't silently re-encode and corrupt the file.
#[tauri::command]
fn read_note(path: String, window: tauri::Window, state: State<VaultState>) -> Result<String, String> {
    let root = current_root(&state, window.label())?;
    let resolved = ensure_in_vault(&root, &path)?;
    fs::read_to_string(&resolved).map_err(|e| format!("read {}: {e}", resolved.display()))
}

/// Atomically write a note's contents, only within the vault.
#[tauri::command]
fn write_note(path: String, content: String, window: tauri::Window, state: State<VaultState>) -> Result<(), String> {
    let root = current_root(&state, window.label())?;
    let resolved = ensure_in_vault(&root, &path)?;
    // Defense in depth: write_note IS the Markdown-note pipeline, so it must only
    // ever touch a `.md` file. This turns the "never write back a .canvas (or any
    // attachment) opened in a read-only viewer" rule — otherwise enforced only by
    // frontend discipline (isMarkdownPath) — into a hard filesystem boundary that
    // a future regression can't bypass.
    let is_md = resolved
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"));
    if !is_md {
        return Err(format!(
            "write_note refuses a non-Markdown path: {}",
            resolved.display()
        ));
    }
    atomic_write(&resolved, content.as_bytes())
}

/// Atomically write a `.canvas` file (the editable JSON Canvas), only within the
/// vault. Extension-gated like write_note so this pipeline can only ever touch a
/// `.canvas` — never a note or another attachment.
#[tauri::command]
fn write_canvas(
    path: String,
    content: String,
    window: tauri::Window,
    state: State<VaultState>,
) -> Result<(), String> {
    let root = current_root(&state, window.label())?;
    let resolved = ensure_in_vault(&root, &path)?;
    let is_canvas = resolved
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("canvas"));
    if !is_canvas {
        return Err(format!(
            "write_canvas refuses a non-.canvas path: {}",
            resolved.display()
        ));
    }
    // The file must already exist — canvas editing only modifies canvases opened
    // from the vault; it never creates arbitrary files.
    if !resolved.is_file() {
        return Err("canvas file does not exist".into());
    }
    atomic_write(&resolved, content.as_bytes())
}

/// Atomically write a `.base` file (the editable Bases definition YAML), only
/// within the vault. Extension-gated like write_canvas so this pipeline can only
/// ever touch a `.base`.
#[tauri::command]
fn write_base(
    path: String,
    content: String,
    window: tauri::Window,
    state: State<VaultState>,
) -> Result<(), String> {
    let root = current_root(&state, window.label())?;
    let resolved = ensure_in_vault(&root, &path)?;
    let is_base = resolved
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("base"));
    if !is_base {
        return Err(format!("write_base refuses a non-.base path: {}", resolved.display()));
    }
    if !resolved.is_file() {
        return Err("base file does not exist".into());
    }
    atomic_write(&resolved, content.as_bytes())
}

/// Build `<root>/<name>.md` from a folder-qualified note name, sanitizing each
/// segment and rejecting `..`/absolute/dot-leading/reserved segments.
fn build_note_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    let segments: Vec<String> = name
        .split(['/', '\\'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if segments.is_empty() {
        return Err("invalid note name".into());
    }
    let mut path = root.to_path_buf();
    let last = segments.len() - 1;
    for (i, seg) in segments.iter().enumerate() {
        // These characters are link syntax — a name containing them can't be
        // round-tripped through [[wikilinks]], so reject rather than mangle.
        if seg.chars().any(|c| matches!(c, '#' | '^' | '[' | ']' | '|')) {
            return Err("note names cannot contain # ^ [ ] |".into());
        }
        let safe: String = seg
            .chars()
            .filter(|c| !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
            .collect();
        let safe = safe.trim().trim_end_matches('.');
        if safe.is_empty() || safe.starts_with('.') {
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
    Ok(path)
}

/// True if a file/symlink already occupies `path`.
fn occupied(path: &Path) -> bool {
    path.exists()
        || fs::symlink_metadata(path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
}

/// Create a new empty note, returning its canonical path. `name` may be folder-
/// qualified (`sub/New`); parent folders are created.
#[tauri::command]
fn create_note(name: String, window: tauri::Window, state: State<VaultState>) -> Result<String, String> {
    let root = current_root(&state, window.label())?;
    let path = build_note_path(&root, &name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    if occupied(&path) {
        return Err("note already exists".into());
    }
    atomic_write(&path, b"")?;
    let canonical = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !canonical.starts_with(&root) {
        let _ = fs::remove_file(&canonical);
        return Err("path escapes vault".into());
    }
    Ok(canonical.to_string_lossy().to_string())
}

/// Move a note to `<vault>/.trash/` (Obsidian-compatible, recoverable). A name
/// collision in the trash gets a timestamp suffix.
#[tauri::command]
fn delete_note(path: String, window: tauri::Window, state: State<VaultState>) -> Result<(), String> {
    let root = current_root(&state, window.label())?;
    let resolved = ensure_in_vault(&root, &path)?;
    if !resolved.is_file() {
        return Err("not a file".into());
    }
    let trash = root.join(".trash");
    fs::create_dir_all(&trash).map_err(|e| format!("trash: {e}"))?;
    let name = resolved
        .file_name()
        .ok_or("invalid path")?
        .to_string_lossy()
        .to_string();
    let mut dest = trash.join(&name);
    if occupied(&dest) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let stem = name.strip_suffix(".md").unwrap_or(&name);
        dest = trash.join(format!("{stem} {nanos}.md"));
    }
    fs::rename(&resolved, &dest).map_err(|e| format!("trash move: {e}"))
}

/// Move a whole FOLDER (by vault-relative path) to the vault trash —
/// recoverable, like note deletion. Refuses the root and dot-folders
/// (.obsidian/.basalt/.trash live outside the note tree).
#[tauri::command]
fn delete_folder(rel: String, window: tauri::Window, state: State<VaultState>) -> Result<(), String> {
    let root = current_root(&state, window.label())?;
    let r = rel.trim().trim_matches(['/', '\\']);
    if r.is_empty() {
        return Err("cannot delete the vault root".into());
    }
    let rp = Path::new(r);
    if rp.components().any(|c| !matches!(c, Component::Normal(_)))
        || rp.components().any(|c| {
            matches!(c, Component::Normal(s) if s.to_string_lossy().starts_with('.'))
        })
    {
        return Err("invalid folder path".into());
    }
    let resolved = root.join(rp);
    let canon = fs::canonicalize(&resolved).map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) || !canon.is_dir() {
        return Err("not a folder in the vault".into());
    }
    // Re-validate the RESOLVED location too (a symlink could alias a dot-folder).
    let crel = canon.strip_prefix(&root).map_err(|_| "path escapes vault")?;
    if crel.as_os_str().is_empty()
        || crel.components().any(|c| {
            matches!(c, Component::Normal(s) if s.to_string_lossy().starts_with('.'))
        })
    {
        return Err("invalid folder path".into());
    }
    let trash = root.join(".trash");
    fs::create_dir_all(&trash).map_err(|e| format!("trash: {e}"))?;
    let name = canon.file_name().ok_or("invalid path")?.to_string_lossy().to_string();
    let mut dest = trash.join(&name);
    if occupied(&dest) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        dest = trash.join(format!("{name} {nanos}"));
    }
    fs::rename(&canon, &dest).map_err(|e| format!("trash move: {e}"))
}

/// Remove a folder ONLY if it is empty (recursively: empty subfolders count as
/// empty). Used to clean up after a folder rename moved every note out.
#[tauri::command]
fn remove_empty_folder(rel: String, window: tauri::Window, state: State<VaultState>) -> Result<(), String> {
    let root = current_root(&state, window.label())?;
    let r = rel.trim().trim_matches(['/', '\\']);
    if r.is_empty() {
        return Err("cannot remove the vault root".into());
    }
    let rp = Path::new(r);
    if rp.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("invalid folder path".into());
    }
    let canon = fs::canonicalize(root.join(rp)).map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) || !canon.is_dir() {
        return Err("not a folder in the vault".into());
    }
    // Bottom-up remove_dir: each removal fails atomically with ENOTEMPTY if
    // anything appeared since we looked — no TOCTOU window can delete content.
    fn remove_if_empty(dir: &Path) -> Result<(), String> {
        let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                remove_if_empty(&p)?;
            } else {
                return Err("folder is not empty".into());
            }
        }
        fs::remove_dir(dir).map_err(|e| format!("remove: {e}"))
    }
    remove_if_empty(&canon)
}

/// Every file under `rel` that is NOT a Markdown note (any extension, dotfiles
/// included; .DS_Store ignored) — a folder rename must refuse when these exist,
/// or the rename would silently split the folder. Capped at 20 entries.
#[tauri::command]
fn list_foreign_files(rel: String, window: tauri::Window, state: State<VaultState>) -> Result<Vec<String>, String> {
    let root = current_root(&state, window.label())?;
    let r = rel.trim().trim_matches(['/', '\\']);
    if r.is_empty() {
        return Err("invalid folder path".into());
    }
    let rp = Path::new(r);
    if rp.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("invalid folder path".into());
    }
    let canon = fs::canonicalize(root.join(rp)).map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) || !canon.is_dir() {
        return Err("not a folder in the vault".into());
    }
    let mut out = Vec::new();
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            if out.len() >= 20 {
                return;
            }
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if p.is_dir() {
                walk(&p, root, out);
            } else if name != ".DS_Store"
                && !p.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("md"))
            {
                if let Ok(rp) = p.strip_prefix(root) {
                    out.push(rp.to_string_lossy().to_string());
                }
            }
        }
    }
    walk(&canon, &root, &mut out);
    Ok(out)
}

/// Empty-inclusive list of every subfolder under `rel` (vault-relative paths),
/// so a folder rename can recreate structure the note moves alone wouldn't.
#[tauri::command]
fn list_subfolders(rel: String, window: tauri::Window, state: State<VaultState>) -> Result<Vec<String>, String> {
    let root = current_root(&state, window.label())?;
    let r = rel.trim().trim_matches(['/', '\\']);
    if r.is_empty() {
        return Err("invalid folder path".into());
    }
    let rp = Path::new(r);
    if rp.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("invalid folder path".into());
    }
    let canon = fs::canonicalize(root.join(rp)).map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) || !canon.is_dir() {
        return Err("not a folder in the vault".into());
    }
    let mut out = Vec::new();
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                if let Ok(rp) = p.strip_prefix(root) {
                    out.push(rp.to_string_lossy().to_string());
                }
                walk(&p, root, out);
            }
        }
    }
    walk(&canon, &root, &mut out);
    Ok(out)
}

/// Create a folder (validated, vault-contained). Used to preserve empty
/// subfolder structure across a folder rename.
#[tauri::command]
fn create_folder(rel: String, window: tauri::Window, state: State<VaultState>) -> Result<(), String> {
    let root = current_root(&state, window.label())?;
    let r = rel.trim().trim_matches(['/', '\\']);
    if r.is_empty() {
        return Err("invalid folder path".into());
    }
    let rp = Path::new(r);
    if rp.components().any(|c| !matches!(c, Component::Normal(_)))
        || rp.components().any(|c| {
            matches!(c, Component::Normal(s) if s.to_string_lossy().starts_with('.'))
        })
    {
        return Err("invalid folder path".into());
    }
    let target = root.join(rp);
    // Parent-canonicalized containment (the dir may not exist yet).
    let parent = target.parent().ok_or("invalid path")?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    let cparent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !cparent.starts_with(&root) {
        return Err("path escapes vault".into());
    }
    fs::create_dir_all(&target).map_err(|e| format!("mkdir: {e}"))
}

/// Move a whole FOLDER to a new vault-relative path in ONE `fs::rename` — every
/// note, attachment, and (empty or not) subfolder moves together with its
/// basename preserved verbatim, so a single link-rewrite pass on the frontend
/// fixes cross-folder links. Refuses the root, dot-folders, moving into itself,
/// and overwriting an existing target. Returns the canonical new absolute path.
#[tauri::command]
fn rename_folder(from_rel: String, to_rel: String, window: tauri::Window, state: State<VaultState>) -> Result<String, String> {
    let root = current_root(&state, window.label())?;
    let clean = |r: &str| -> Result<PathBuf, String> {
        let t = r.trim().trim_matches(['/', '\\']);
        if t.is_empty() {
            return Err("cannot name the vault root".into());
        }
        let rp = Path::new(t);
        if rp.components().any(|c| !matches!(c, Component::Normal(_)))
            || rp.components().any(|c| matches!(c, Component::Normal(s) if s.to_string_lossy().starts_with('.')))
        {
            return Err("invalid folder path".into());
        }
        Ok(rp.to_path_buf())
    };
    let fromp = clean(&from_rel)?;
    let top = clean(&to_rel)?;
    // Refuse moving a folder into itself or its own descendant. Compare case-
    // insensitively too so a self-nesting rename on a case-insensitive FS gives
    // our clear error rather than the kernel's.
    let lower = |p: &Path| p.to_string_lossy().to_lowercase();
    if top == fromp || top.starts_with(&fromp) || lower(&top).starts_with(&lower(&fromp)) {
        return Err("cannot move a folder into itself".into());
    }
    let from_abs = root.join(&fromp);
    let from_canon = fs::canonicalize(&from_abs).map_err(|e| e.to_string())?;
    if !from_canon.starts_with(&root) || !from_canon.is_dir() {
        return Err("not a folder in the vault".into());
    }
    let to_abs = root.join(&top);
    // Confirm the destination's nearest EXISTING ancestor is inside the vault
    // BEFORE creating any directories — a symlinked ancestor in `to_rel` must
    // not let create_dir_all scatter folders outside the vault.
    let mut anc = to_abs.parent();
    while let Some(a) = anc {
        match fs::canonicalize(a) {
            Ok(canon) => {
                if !canon.starts_with(&root) {
                    return Err("path escapes vault".into());
                }
                break;
            }
            Err(_) => anc = a.parent(),
        }
    }
    // Refuse overwriting anything already at the destination (a case-only rename
    // on a case-insensitive FS resolves to the same dir — the frontend routes
    // those away, so a hit here is a genuine collision).
    if to_abs.symlink_metadata().is_ok() {
        return Err("a file or folder already exists at the destination".into());
    }
    // Create the destination's PARENT (now known contained), then move.
    let parent = to_abs.parent().ok_or("invalid path")?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    let cparent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !cparent.starts_with(&root) {
        return Err("path escapes vault".into());
    }
    fs::rename(&from_canon, &to_abs).map_err(|e| format!("move folder: {e}"))?;
    let final_canon = fs::canonicalize(&to_abs).map_err(|e| e.to_string())?;
    Ok(final_canon.to_string_lossy().to_string())
}

/// Rename/move a note to a new folder-qualified name (no `.md`), creating
/// parent folders. Refuses to overwrite. Returns the canonical new path.
#[tauri::command]
fn rename_note(path: String, new_name: String, window: tauri::Window, state: State<VaultState>) -> Result<String, String> {
    let root = current_root(&state, window.label())?;
    let from = ensure_in_vault(&root, &path)?;
    if !from.is_file() {
        return Err("not a file".into());
    }
    let to = build_note_path(&root, &new_name)?;
    if to == from {
        return Ok(from.to_string_lossy().to_string());
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        // Validate the destination BEFORE moving (a symlinked subfolder would
        // otherwise carry the note outside the vault).
        let cparent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
        if !cparent.starts_with(&root) {
            return Err("path escapes vault".into());
        }
    }
    // Case-only rename on a case-insensitive filesystem: `to` stats the SAME
    // file, so occupied() would falsely refuse. Detect same-file and go through
    // a dot-prefixed temp (ignored by the watcher) in two steps.
    let same_file = fs::canonicalize(&to)
        .ok()
        .is_some_and(|c| fs::canonicalize(&from).ok() == Some(c));
    if same_file {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let temp = from
            .parent()
            .ok_or("invalid path")?
            .join(format!(".basalt-tmp-{nanos}-case.tmp"));
        fs::rename(&from, &temp).map_err(|e| format!("rename: {e}"))?;
        fs::rename(&temp, &to).map_err(|e| format!("rename: {e}"))?;
    } else {
        if occupied(&to) {
            return Err("a note with that name already exists".into());
        }
        fs::rename(&from, &to).map_err(|e| format!("rename: {e}"))?;
    }
    let canonical = fs::canonicalize(&to).map_err(|e| e.to_string())?;
    if !canonical.starts_with(&root) {
        let _ = fs::rename(&canonical, &from); // undo
        return Err("path escapes vault".into());
    }
    Ok(canonical.to_string_lossy().to_string())
}

/// Non-Markdown file types surfaced in the tree and addressable by links.
const ATTACHMENT_EXTS: [&str; 20] = [
    "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif", "ico", "pdf", "mp3", "wav", "m4a",
    "ogg", "flac", "mp4", "mov", "webm", "canvas", "base",
];

fn is_attachment_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| ATTACHMENT_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// A non-Markdown vault file (no content shipped; opened via the OS). Stats
/// (ms epoch / bytes; 0 when unavailable) feed Bases' file.mtime/ctime/size.
#[derive(Serialize, Clone)]
struct AttachmentEntry {
    path: String,
    rel: String,
    name: String,
    mtime: u64,
    ctime: u64,
    size: u64,
}

fn collect_attachments(dir: &Path, root: &Path, out: &mut Vec<AttachmentEntry>, depth: usize) {
    if depth > 32 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if ft.is_dir() {
            if !is_ignored_dir(&file_name) {
                collect_attachments(&path, root, out, depth + 1);
            }
        } else if is_attachment_ext(&path) {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            let (mtime, ctime, size) = file_stats(entry.metadata().ok().as_ref());
            out.push(AttachmentEntry {
                path: path.to_string_lossy().to_string(),
                rel,
                name: file_name,
                mtime,
                ctime,
                size,
            });
        }
    }
}

/// List every attachment (non-md supported file) in the open vault.
#[tauri::command]
async fn list_attachments(window: tauri::Window, state: State<'_, VaultState>) -> Result<Vec<AttachmentEntry>, String> {
    let root = current_root(&state, window.label())?;
    let mut out = Vec::new();
    collect_attachments(&root, &root, &mut out, 0);
    out.sort_by_key(|a| a.rel.to_lowercase());
    Ok(out)
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u32, String> {
        match c {
            b'A'..=b'Z' => Ok((c - b'A') as u32),
            b'a'..=b'z' => Ok((c - b'a' + 26) as u32),
            b'0'..=b'9' => Ok((c - b'0' + 52) as u32),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("invalid base64".into()),
        }
    }
    let bytes: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        if chunk.len() < 2 {
            return Err("invalid base64".into());
        }
        let pad = chunk.iter().filter(|&&c| c == b'=').count();
        if pad > 0 && chunk.len() < 4 {
            return Err("invalid base64".into());
        }
        let n = val(chunk[0])? << 18
            | val(chunk[1])? << 12
            | if chunk.len() > 2 && chunk[2] != b'=' { val(chunk[2])? << 6 } else { 0 }
            | if chunk.len() > 3 && chunk[3] != b'=' { val(chunk[3])? } else { 0 };
        out.push((n >> 16) as u8);
        if chunk.len() > 2 && pad < 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 && pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

/// Where Obsidian's `attachmentFolderPath` setting says new attachments go:
/// absent or "/" = vault root; "./" = the note's folder; "./sub" = a subfolder
/// of the note's folder; anything else = that vault folder.
fn attachment_dir(root: &Path, source_rel: &str) -> PathBuf {
    let setting = fs::read_to_string(root.join(".obsidian/app.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("attachmentFolderPath").and_then(|p| p.as_str().map(String::from)));
    let source_folder = Path::new(source_rel)
        .parent()
        .map(|p| root.join(p))
        .unwrap_or_else(|| root.to_path_buf());
    match setting.as_deref() {
        None | Some("/") | Some("") => root.to_path_buf(),
        Some("./") | Some(".") => source_folder,
        Some(rest) if rest.starts_with("./") => source_folder.join(&rest[2..]),
        Some(folder) => root.join(folder.trim_start_matches(['/', '\\'])),
    }
}

/// Save a pasted/dropped attachment (base64 payload) into the configured
/// attachment folder, uniquifying the name. Returns the new entry.
#[tauri::command]
async fn write_attachment(
    name: String,
    data_b64: String,
    source_rel: String,
    window: tauri::Window, state: State<'_, VaultState>,
) -> Result<AttachmentEntry, String> {
    let root = current_root(&state, window.label())?;
    // Single path segment only; reuse the note-name sanitation rules.
    if name.contains('/') || name.contains('\\') {
        return Err("invalid attachment name".into());
    }
    let safe: String = name
        .chars()
        .filter(|c| !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' | '[' | ']') && !c.is_control())
        .collect();
    let safe = safe.trim().trim_start_matches('.').trim_end_matches('.');
    if safe.is_empty() {
        return Err("invalid attachment name".into());
    }
    if safe.len() > 200 {
        return Err("attachment name is too long".into());
    }
    let stem_for_check = safe.split('.').next().unwrap_or(safe);
    if is_reserved_name(stem_for_check) {
        return Err(format!("'{stem_for_check}' is a reserved name"));
    }
    let bytes = base64_decode(&data_b64)?; // decode before any filesystem effects

    let dir = attachment_dir(&root, &source_rel);
    // Lexical containment BEFORE creating anything: no `..`, no escape, and no
    // dot-prefixed folder (every reader skips those — the file would be
    // invisible and its embed broken immediately).
    if dir
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
        || !dir.starts_with(&root)
    {
        return Err("attachment folder escapes vault".into());
    }
    if let Ok(rel_dir) = dir.strip_prefix(&root) {
        let rel_str = rel_dir.to_string_lossy();
        if !rel_str.is_empty() && rel_has_ignored_component(&rel_str) {
            return Err(
                "attachmentFolderPath points at a hidden (dot-prefixed) folder; choose a visible one"
                    .into(),
            );
        }
    }
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let cdir = fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    if !cdir.starts_with(&root) {
        return Err("attachment folder escapes vault".into());
    }
    // Uniquify by atomically RESERVING the name (create_new) — a plain
    // exists-then-write check races with concurrent pastes and would silently
    // overwrite the first file.
    let (stem, ext) = match safe.rfind('.') {
        Some(i) if i > 0 => (&safe[..i], &safe[i..]),
        _ => (safe, ""),
    };
    let mut counter = 0;
    let (mut file, dest) = loop {
        let candidate = if counter == 0 {
            cdir.join(safe)
        } else {
            cdir.join(format!("{stem} {counter}{ext}"))
        };
        match fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(f) => break (f, candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                counter += 1;
                if counter > 1000 {
                    return Err("could not find a free attachment name".into());
                }
            }
            Err(e) => return Err(format!("create: {e}")),
        }
    };
    file.write_all(&bytes).map_err(|e| format!("write: {e}"))?;
    file.sync_all().map_err(|e| format!("fsync: {e}"))?;
    drop(file);
    let canonical = fs::canonicalize(&dest).map_err(|e| e.to_string())?;
    let rel = canonical
        .strip_prefix(&root)
        .map_err(|_| "path escapes vault")?
        .to_string_lossy()
        .to_string();
    let fname = canonical
        .file_name()
        .ok_or("invalid path")?
        .to_string_lossy()
        .to_string();
    let (mtime, ctime, size) = file_stats(fs::metadata(&canonical).ok().as_ref());
    Ok(AttachmentEntry {
        path: canonical.to_string_lossy().to_string(),
        rel,
        name: fname,
        mtime,
        ctime,
        size,
    })
}

/// Write a user-chosen export file. The path comes from the OS save dialog, so
/// it is user-authorized and may live outside the vault (no containment check).
/// Written atomically (temp + rename) so a failed/partial export can't leave a
/// half-written file in place of an existing one.
#[tauri::command]
fn export_file(path: String, content: String) -> Result<(), String> {
    let dest = PathBuf::from(&path);
    // The export dialog targets .html; refuse to overwrite an existing Markdown
    // note or any known attachment (incl. .canvas), so a mistyped Save-As name
    // can't truncate a real vault file.
    if dest.exists() {
        if let Some(ext) = dest.extension().and_then(|e| e.to_str()) {
            let ext = ext.to_ascii_lowercase();
            if ext == "md" || ATTACHMENT_EXTS.contains(&ext.as_str()) {
                return Err(format!(
                    "refusing to overwrite a vault file ({}): {}",
                    ext,
                    dest.display()
                ));
            }
        }
    }
    atomic_write(&dest, content.as_bytes())
}

/// Read-only view of the Obsidian settings Basalt honors. Basalt never writes
/// `.obsidian/` — the shared vault's config belongs to Obsidian.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct ObsidianConfig {
    /// "shortest" | "relative" | "absolute"
    new_link_format: Option<String>,
    use_markdown_links: Option<bool>,
    attachment_folder_path: Option<String>,
    daily_notes_folder: Option<String>,
    daily_notes_format: Option<String>,
    daily_notes_template: Option<String>,
    /// Folder holding templates (core Templates plugin, or Templater's setting).
    templates_folder: Option<String>,
}

#[tauri::command]
fn read_obsidian_config(window: tauri::Window, state: State<VaultState>) -> Result<ObsidianConfig, String> {
    let root = current_root(&state, window.label())?;
    let mut cfg = ObsidianConfig::default();
    if let Ok(raw) = fs::read_to_string(root.join(".obsidian/app.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            cfg.new_link_format = v.get("newLinkFormat").and_then(|x| x.as_str()).map(String::from);
            cfg.use_markdown_links = v.get("useMarkdownLinks").and_then(|x| x.as_bool());
            cfg.attachment_folder_path =
                v.get("attachmentFolderPath").and_then(|x| x.as_str()).map(String::from);
        }
    }
    // Honor daily-notes.json only when the core plugin isn't explicitly
    // disabled (core-plugins.json: old schema = array of enabled ids, new
    // schema = id -> bool map). Missing/unparseable file = default-enabled.
    let daily_enabled = match fs::read_to_string(root.join(".obsidian/core-plugins.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    {
        Some(serde_json::Value::Array(ids)) => {
            ids.iter().any(|v| v.as_str() == Some("daily-notes"))
        }
        Some(serde_json::Value::Object(map)) => map
            .get("daily-notes")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        _ => true,
    };
    if daily_enabled {
        if let Ok(raw) = fs::read_to_string(root.join(".obsidian/daily-notes.json")) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                cfg.daily_notes_folder = v.get("folder").and_then(|x| x.as_str()).map(String::from);
                cfg.daily_notes_format = v.get("format").and_then(|x| x.as_str()).map(String::from);
                cfg.daily_notes_template =
                    v.get("template").and_then(|x| x.as_str()).map(String::from);
            }
        }
    }
    // Templates folder: prefer Templater's setting, then the core Templates
    // plugin's. Basalt reuses whichever the vault already configured.
    cfg.templates_folder = fs::read_to_string(root.join(".obsidian/plugins/templater-obsidian/data.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("templates_folder").and_then(|x| x.as_str()).map(String::from))
        .filter(|s| !s.is_empty())
        .or_else(|| {
            fs::read_to_string(root.join(".obsidian/templates.json"))
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|v| v.get("folder").and_then(|x| x.as_str()).map(String::from))
                .filter(|s| !s.is_empty())
        });
    Ok(cfg)
}

/// One flattened entry from `.obsidian/bookmarks.json`. Obsidian nests
/// bookmarks in `group` items; we flatten them, carrying the group title for
/// display. `path` is vault-relative; `subpath` is a `#heading`/`#^block` ref.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bookmark {
    #[serde(rename = "type")]
    kind: String,
    title: String,
    path: Option<String>,
    subpath: Option<String>,
    query: Option<String>,
    group: Option<String>,
}

fn collect_bookmarks(items: &[serde_json::Value], group: Option<String>, out: &mut Vec<Bookmark>) {
    for item in items {
        let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let title_opt = item.get("title").and_then(|v| v.as_str()).map(String::from);
        if kind == "group" {
            if let Some(children) = item.get("items").and_then(|v| v.as_array()) {
                collect_bookmarks(children, title_opt.or(group.clone()), out);
            }
            continue;
        }
        let path = item.get("path").and_then(|v| v.as_str()).map(String::from);
        let subpath = item.get("subpath").and_then(|v| v.as_str()).map(String::from);
        let query = item.get("query").and_then(|v| v.as_str()).map(String::from);
        // Display title: explicit title, else derive from the path (+subpath) or query.
        let title = title_opt.unwrap_or_else(|| {
            if let Some(p) = &path {
                let base = std::path::Path::new(p)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.clone());
                match &subpath {
                    Some(s) => format!("{base} {s}"),
                    None => base,
                }
            } else if let Some(q) = &query {
                format!("Search: {q}")
            } else {
                kind.clone()
            }
        });
        out.push(Bookmark { kind, title, path, subpath, query, group: group.clone() });
    }
}

/// Read `.obsidian/bookmarks.json` (Obsidian's Bookmarks core plugin),
/// flattened. Missing/unparseable file = no bookmarks (never an error).
#[tauri::command]
fn read_obsidian_bookmarks(window: tauri::Window, state: State<VaultState>) -> Result<Vec<Bookmark>, String> {
    let root = current_root(&state, window.label())?;
    let raw = match fs::read_to_string(root.join(".obsidian/bookmarks.json")) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    if let Some(items) = v.get("items").and_then(|x| x.as_array()) {
        collect_bookmarks(items, None, &mut out);
    }
    Ok(out)
}

/// Watch the open vault recursively. Markdown file changes emit `vault-changed`
/// with `{path, rel}` per note; directory-level changes (folder rename/delete,
/// which FSEvents reports only for the folder path) emit a payload-less
/// `vault-rescan` so the frontend reloads the whole index.
#[tauri::command]
fn start_watching(
    app: AppHandle,
    window: tauri::Window,
    state: State<VaultState>,
    watcher_state: State<WatcherState>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let root = current_root(&state, &label)?;
    let handle = app.clone();
    let emit_label = label.clone();
    let root_for_closure = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else {
            return;
        };
        // Pure metadata events (mtime/xattr/ownership) can't change content, and
        // iCloud emits them constantly — skip them entirely or every cloud touch
        // costs a read+compare (and a root-metadata touch a full vault rescan).
        if matches!(
            event.kind,
            notify::EventKind::Modify(notify::event::ModifyKind::Metadata(_))
        ) {
            return;
        }
        let mut changed: Vec<ChangedNote> = Vec::new();
        let mut rescan = false;
        for p in &event.paths {
            let Some(rel) = rel_under(&root_for_closure, p) else {
                continue;
            };
            if rel_has_ignored_component(&rel) {
                continue;
            }
            if p.extension().and_then(|s| s.to_str()) == Some("md") {
                changed.push(ChangedNote {
                    path: p.to_string_lossy().to_string(),
                    rel,
                });
            } else if p.extension().is_none() || is_attachment_ext(p) {
                // No extension: almost certainly a directory event (folder
                // create/rename/delete). An attachment (.canvas/image/pdf…)
                // created/edited/deleted/renamed: the file tree, the attachment
                // list, and any open .canvas viewer pane must refresh. A full
                // rescan keeps the index honest and prunes panes for a file
                // that's now gone.
                rescan = true;
            }
        }
        // Target ONLY the owning window — a change in one window's vault must
        // not reach another window watching a different vault.
        if !changed.is_empty() {
            let _ = handle.emit_to(emit_label.as_str(), "vault-changed", changed);
        }
        if rescan {
            let _ = handle.emit_to(emit_label.as_str(), "vault-rescan", ());
        }
    })
    .map_err(|e| e.to_string())?;
    // Build-then-swap: fully construct AND .watch() the new watcher BEFORE
    // touching the map, so a build/watch failure (e.g. transient EMFILE) leaves
    // this window's existing watcher — and its conflict-detection safety net —
    // intact instead of leaving the window silently unwatched.
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    // Swap under the lock but drop the OLD watcher AFTER releasing it — a
    // watcher's Drop can block, and it must not stall other windows' commands.
    let old = watcher_state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(label.clone(), watcher);
    drop(old);
    #[cfg(debug_assertions)]
    eprintln!("[basalt] window {label} watching {}", root.display());
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
        // Media embeds (audio/video/PDF players in notes).
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") | Some("oga") => "audio/ogg",
        Some("m4a") => "audio/mp4",
        Some("flac") => "audio/flac",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("pdf") => "application/pdf",
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
async fn read_image(
    target: String,
    source_rel: String,
    window: tauri::Window, state: State<'_, VaultState>,
) -> Result<String, String> {
    let root = current_root(&state, window.label())?;
    let t = target.trim();
    if t.is_empty() {
        return Err("empty image target".into());
    }
    let tp = Path::new(t);
    if tp.is_absolute()
        || tp
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err("invalid image target".into());
    }

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
    if found.is_none() && !t.contains('/') && !t.contains('\\') {
        found = find_file(&root, t, 0);
    }

    let path = found.ok_or_else(|| format!("image not found: {t}"))?;
    let canon = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) {
        return Err("path escapes vault".into());
    }
    let meta = fs::metadata(&canon).map_err(|e| e.to_string())?;
    if meta.len() > 25_000_000 {
        return Err("image too large".into());
    }
    let bytes = fs::read(&canon).map_err(|e| format!("read {}: {e}", canon.display()))?;
    Ok(format!("data:{};base64,{}", mime_for(&canon), base64_encode(&bytes)))
}

/// A Basalt plugin discovered under `.basalt/plugins/<id>/`. `code` is the raw
/// main.js the webview will execute (Basalt plugins are trusted in-webview JS —
/// the user installs only plugins they trust). `data` is its persisted
/// settings JSON (data.json), if any.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginInfo {
    id: String,
    name: String,
    version: String,
    description: String,
    author: String,
    min_app_version: String,
    code: String,
    data: Option<String>,
}

/// A plugin id must be a single safe path segment (no traversal, no separators).
fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id != "."
        && id != ".."
        && !id.contains('/')
        && !id.contains('\\')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !id.starts_with('.')
}

/// A CSS snippet from `.basalt/snippets/*.css` (name = the file stem).
#[derive(Serialize)]
struct CssSnippet {
    name: String,
    css: String,
}

/// List the vault's CSS snippets (each capped at 1MB; non-.css files skipped).
#[tauri::command]
fn list_css_snippets(window: tauri::Window, state: State<VaultState>) -> Result<Vec<CssSnippet>, String> {
    let root = current_root(&state, window.label())?;
    let dir = root.join(".basalt").join("snippets");
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(out); // no snippets folder yet
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()).map(|e| !e.eq_ignore_ascii_case("css")).unwrap_or(true) {
            continue;
        }
        if fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(true) {
            continue;
        }
        let Ok(css) = fs::read_to_string(&path) else {
            continue;
        };
        let name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        out.push(CssSnippet { name, css });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// List installed Basalt plugins (each folder under `.basalt/plugins/` with a
/// manifest.json + main.js). Missing/malformed plugins are skipped, not fatal.
#[tauri::command]
fn list_plugins(window: tauri::Window, state: State<VaultState>) -> Result<Vec<PluginInfo>, String> {
    let root = current_root(&state, window.label())?;
    let dir = root.join(".basalt").join("plugins");
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(out); // no plugins folder yet
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if !valid_plugin_id(&id) {
            continue;
        }
        let pdir = entry.path();
        let Ok(manifest_raw) = fs::read_to_string(pdir.join("manifest.json")) else {
            continue;
        };
        let Ok(m) = serde_json::from_str::<serde_json::Value>(&manifest_raw) else {
            continue;
        };
        // Skip an implausibly large main.js rather than reading it into memory.
        let main = pdir.join("main.js");
        if fs::metadata(&main).map(|md| md.len() > MAX_PLUGIN_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(code) = fs::read_to_string(&main) else {
            continue;
        };
        let get = |k: &str| m.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        out.push(PluginInfo {
            id: id.clone(),
            name: {
                let n = get("name");
                if n.is_empty() {
                    id
                } else {
                    n
                }
            },
            version: get("version"),
            description: get("description"),
            author: get("author"),
            min_app_version: get("minAppVersion"),
            code,
            data: fs::read_to_string(pdir.join("data.json")).ok(),
        });
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

/// Persist a plugin's settings JSON to `.basalt/plugins/<id>/data.json`.
#[tauri::command]
fn write_plugin_data(
    id: String,
    data: String,
    window: tauri::Window,
    state: State<VaultState>,
) -> Result<(), String> {
    if !valid_plugin_id(&id) {
        return Err("invalid plugin id".into());
    }
    let root = current_root(&state, window.label())?;
    let pdir = root.join(".basalt").join("plugins").join(&id);
    if !pdir.is_dir() {
        return Err("plugin not installed".into());
    }
    // Defense in depth beyond valid_plugin_id: confirm the resolved folder is
    // really inside the vault (a symlinked plugin dir can't escape it).
    let canon = fs::canonicalize(&pdir).map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) {
        return Err("plugin path escapes vault".into());
    }
    atomic_write(&canon.join("data.json"), data.as_bytes())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(VaultState(Mutex::new(HashMap::new())))
        .manage(WatcherState(Mutex::new(HashMap::new())))
        .on_window_event(|window, event| {
            // When a window closes, drop its vault + watcher entries so its state
            // can't be reused by a future window that happens to reuse the label.
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label().to_string();
                let app = window.app_handle();
                if let Some(s) = app.try_state::<VaultState>() {
                    if let Ok(mut m) = s.0.lock() {
                        m.remove(&label);
                    }
                }
                if let Some(s) = app.try_state::<WatcherState>() {
                    // Remove under the lock but drop the watcher (its Drop can
                    // block) only after releasing it, so a closing window can't
                    // stall another window's in-flight command.
                    let old = s.0.lock().ok().and_then(|mut m| m.remove(&label));
                    drop(old);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_vault,
            open_new_window,
            read_vault,
            read_note,
            write_note,
            write_canvas,
            write_base,
            list_css_snippets,
            delete_folder,
            remove_empty_folder,
            list_foreign_files,
            list_subfolders,
            create_folder,
            rename_folder,
            create_note,
            delete_note,
            rename_note,
            list_attachments,
            write_attachment,
            read_obsidian_config,
            read_obsidian_bookmarks,
            export_file,
            start_watching,
            read_image,
            list_plugins,
            write_plugin_data,
            debug_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encode_escapes_url_significant_and_reserved_chars() {
        // '#' MUST be encoded (a raw '#' in ?vault= would start a URL fragment
        // and truncate the path); so must space, '/', '&', '?', and non-ASCII.
        assert_eq!(percent_encode("/Users/o/My Vault#2&x"), "%2FUsers%2Fo%2FMy%20Vault%232%26x");
        assert_eq!(percent_encode("a?b=c"), "a%3Fb%3Dc");
        assert_eq!(percent_encode("Notes-2024_v.1~x"), "Notes-2024_v.1~x"); // unreserved kept
        assert_eq!(percent_encode("café"), "caf%C3%A9"); // UTF-8 bytes, uppercase hex
    }

    #[test]
    fn collect_bookmarks_flattens_groups_and_derives_titles() {
        let json = serde_json::json!({
            "items": [
                { "type": "file", "path": "Note.md" },
                { "type": "heading", "path": "Doc.md", "subpath": "#Intro", "title": "Custom" },
                { "type": "search", "query": "todo" },
                { "type": "group", "title": "Refs", "items": [
                    { "type": "block", "path": "Other.md", "subpath": "#^abc" },
                    { "type": "graph" }
                ]}
            ]
        });
        let mut out = Vec::new();
        collect_bookmarks(json["items"].as_array().unwrap(), None, &mut out);
        // group is flattened away; its two leaf children remain (graph included,
        // disabled in the UI).
        assert_eq!(out.len(), 5);
        // file: title derived from basename, no group
        assert_eq!(out[0].title, "Note");
        assert_eq!(out[0].group, None);
        // explicit title wins
        assert_eq!(out[1].title, "Custom");
        // search: derived title + query preserved
        assert_eq!(out[2].title, "Search: todo");
        assert_eq!(out[2].query.as_deref(), Some("todo"));
        // nested block carries the group; title is basename + subpath
        assert_eq!(out[3].title, "Other #^abc");
        assert_eq!(out[3].group.as_deref(), Some("Refs"));
        // a typeless/path-less graph bookmark falls back to its kind for a title
        assert_eq!(out[4].kind, "graph");
        assert_eq!(out[4].group.as_deref(), Some("Refs"));
    }

    #[test]
    fn atomic_write_roundtrip_tmp() {
        let dir = std::env::temp_dir().join(format!("basalt-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("note.md");
        atomic_write(&f, b"hello").expect("atomic_write failed");
        assert_eq!(fs::read_to_string(&f).unwrap(), "hello");
        atomic_write(&f, b"replaced").expect("overwrite failed");
        assert_eq!(fs::read_to_string(&f).unwrap(), "replaced");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Set BASALT_TEST_VAULT to a real vault path to exercise these on a
    /// cloud-synced filesystem (they skip when unset).
    fn test_vault() -> Option<PathBuf> {
        std::env::var("BASALT_TEST_VAULT").ok().map(PathBuf::from).filter(|p| p.is_dir())
    }

    #[test]
    fn atomic_write_on_real_vault() {
        let Some(vault) = test_vault() else { return };
        let root = fs::canonicalize(&vault).expect("canonicalize vault");
        let test = root.join(".basalt-write-test.md");
        let resolved = ensure_in_vault(&root, &test.to_string_lossy()).expect("ensure_in_vault failed");
        atomic_write(&resolved, b"test").expect("atomic_write on icloud failed");
        assert_eq!(fs::read_to_string(&resolved).unwrap(), "test");
        fs::remove_file(&resolved).unwrap();
    }

    #[test]
    fn ensure_in_vault_existing_note_real_vault() {
        let Some(vault) = test_vault() else { return };
        let root = fs::canonicalize(&vault).unwrap();
        // find any real .md note and validate it the way write_note would
        let mut notes = Vec::new();
        collect_vault(&root, &root, &mut notes);
        if let Some(n) = notes.first() {
            ensure_in_vault(&root, &n.path).expect("existing note failed containment");
        }
    }
}
