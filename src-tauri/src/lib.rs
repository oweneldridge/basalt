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

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

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

/// The canonical root of the currently open vault (set by `open_vault`).
struct VaultState(Mutex<Option<PathBuf>>);
/// Holds the live vault watcher so it isn't dropped (which would stop watching).
struct WatcherState(Mutex<Option<notify::RecommendedWatcher>>);

static WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Notes larger than this are listed without content (the editor still opens
/// them on demand via read_note); keeps the bulk IPC message bounded.
const MAX_INDEXED_NOTE_BYTES: u64 = 5_000_000;

fn current_root(state: &State<VaultState>) -> Result<PathBuf, String> {
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
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
            let too_big = entry
                .metadata()
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
            out.push(VaultNote {
                path: path.to_string_lossy().to_string(),
                rel,
                name,
                content,
            });
        }
    }
}

/// Open a vault: canonicalize the root, store it in managed state, sweep stale
/// write temps, and return the canonical root (the path form every subsequent
/// command and event will use).
#[tauri::command]
fn open_vault(path: String, state: State<VaultState>) -> Result<String, String> {
    let root = fs::canonicalize(&path).map_err(|e| format!("vault: {e}"))?;
    if !root.is_dir() {
        return Err("vault is not a directory".into());
    }
    sweep_temps(&root, 0);
    *state.0.lock().map_err(|e| e.to_string())? = Some(root.clone());
    Ok(root.to_string_lossy().to_string())
}

/// Read every note in the open vault *with its content*, in one call. Powers
/// the frontend link/metadata index. Async so the walk stays off the main thread.
#[tauri::command]
async fn read_vault(state: State<'_, VaultState>) -> Result<Vec<VaultNote>, String> {
    let root = current_root(&state)?;
    let mut out = Vec::new();
    collect_vault(&root, &root, &mut out);
    out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
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
fn read_note(path: String, state: State<VaultState>) -> Result<String, String> {
    let root = current_root(&state)?;
    let resolved = ensure_in_vault(&root, &path)?;
    fs::read_to_string(&resolved).map_err(|e| format!("read {}: {e}", resolved.display()))
}

/// Atomically write a note's contents, only within the vault.
#[tauri::command]
fn write_note(path: String, content: String, state: State<VaultState>) -> Result<(), String> {
    let root = current_root(&state)?;
    let resolved = ensure_in_vault(&root, &path)?;
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
fn create_note(name: String, state: State<VaultState>) -> Result<String, String> {
    let root = current_root(&state)?;
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
fn delete_note(path: String, state: State<VaultState>) -> Result<(), String> {
    let root = current_root(&state)?;
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

/// Rename/move a note to a new folder-qualified name (no `.md`), creating
/// parent folders. Refuses to overwrite. Returns the canonical new path.
#[tauri::command]
fn rename_note(path: String, new_name: String, state: State<VaultState>) -> Result<String, String> {
    let root = current_root(&state)?;
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
const ATTACHMENT_EXTS: [&str; 18] = [
    "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif", "ico", "pdf", "mp3", "wav", "m4a",
    "ogg", "flac", "mp4", "mov", "webm",
];

fn is_attachment_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| ATTACHMENT_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// A non-Markdown vault file (no content shipped; opened via the OS).
#[derive(Serialize, Clone)]
struct AttachmentEntry {
    path: String,
    rel: String,
    name: String,
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
            out.push(AttachmentEntry {
                path: path.to_string_lossy().to_string(),
                rel,
                name: file_name,
            });
        }
    }
}

/// List every attachment (non-md supported file) in the open vault.
#[tauri::command]
async fn list_attachments(state: State<'_, VaultState>) -> Result<Vec<AttachmentEntry>, String> {
    let root = current_root(&state)?;
    let mut out = Vec::new();
    collect_attachments(&root, &root, &mut out, 0);
    out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
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
    state: State<'_, VaultState>,
) -> Result<AttachmentEntry, String> {
    let root = current_root(&state)?;
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
    Ok(AttachmentEntry {
        path: canonical.to_string_lossy().to_string(),
        rel,
        name: fname,
    })
}

/// Watch the open vault recursively. Markdown file changes emit `vault-changed`
/// with `{path, rel}` per note; directory-level changes (folder rename/delete,
/// which FSEvents reports only for the folder path) emit a payload-less
/// `vault-rescan` so the frontend reloads the whole index.
#[tauri::command]
fn start_watching(
    app: AppHandle,
    state: State<VaultState>,
    watcher_state: State<WatcherState>,
) -> Result<(), String> {
    let root = current_root(&state)?;
    {
        let mut guard = watcher_state.0.lock().map_err(|e| e.to_string())?;
        *guard = None; // stop the previous watcher before starting the new one
    }
    let handle = app.clone();
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
            } else if p.extension().is_none() {
                // No extension: almost certainly a directory event (folder
                // create/rename/delete). A full rescan keeps the index honest.
                rescan = true;
            }
        }
        if !changed.is_empty() {
            let _ = handle.emit("vault-changed", changed);
        }
        if rescan {
            let _ = handle.emit("vault-rescan", ());
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *watcher_state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    #[cfg(debug_assertions)]
    eprintln!("[basalt] watching {}", root.display());
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
async fn read_image(
    target: String,
    source_rel: String,
    state: State<'_, VaultState>,
) -> Result<String, String> {
    let root = current_root(&state)?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(VaultState(Mutex::new(None)))
        .manage(WatcherState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            open_vault,
            read_vault,
            read_note,
            write_note,
            create_note,
            delete_note,
            rename_note,
            list_attachments,
            write_attachment,
            start_watching,
            read_image,
            debug_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

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
