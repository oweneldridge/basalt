// Basalt — local-first Markdown knowledge base.
// Copyright (C) 2026 Owen Eldridge
// Licensed under AGPL-3.0-or-later. See LICENSE.
//
// The desktop shell. All the vault file IO + hardened invariants live in the
// `basalt-core` crate; this file is the thin `#[tauri::command]` adapter layer
// plus the Tauri glue (per-window state, the filesystem watcher, deep links,
// and window lifecycle). Every command resolves the calling window's vault root
// from managed state (`current_root`) and delegates the actual work to
// `basalt_core`, so the webview can never name a location outside its own vault.
//
// Paths are matched between read_vault and the filesystem watcher by VAULT-
// RELATIVE path (not absolute), because macOS FSEvents reports firmlink/symlink-
// resolved absolute paths that won't string-match the dialog-derived path.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use notify::{RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// The canonical vault root PER WINDOW (keyed by window label), set by
/// `open_vault`. Each window is an independent vault + workspace, so a command
/// validates its paths against the calling WINDOW's root — one window can never
/// name a location outside its own open vault, and never reach into another
/// window's vault.
struct VaultState(Mutex<HashMap<String, PathBuf>>);
/// The live vault watcher per window (kept alive so it isn't dropped, which
/// would stop watching).
struct WatcherState(Mutex<HashMap<String, notify::RecommendedWatcher>>);
/// A `basalt://` URL the app was launched with, held until the frontend is
/// ready to consume it (via `take_pending_deep_link`). Deep links that arrive
/// while the app is already running are delivered by the `deep-link-open` event
/// instead.
struct PendingDeepLink(Mutex<Option<String>>);

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
    let root = basalt_core::open_vault(&path)?;
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
fn open_new_window(app: AppHandle, vault: Option<String>, note: Option<String>) -> Result<String, String> {
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
        url = format!("index.html?vault={}", basalt_core::percent_encode(&v));
        // Optionally tell the new window which note (vault-relative path) to open.
        if let Some(n) = note {
            url = format!("{url}&note={}", basalt_core::percent_encode(&n));
        }
    }
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Basalt")
        .inner_size(1100.0, 760.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(label)
}

/// Return (and clear) the `basalt://` URL the app was launched with, if any.
/// The frontend calls this once on mount; live deep links use the event.
#[tauri::command]
fn take_pending_deep_link(state: State<PendingDeepLink>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

/// Read every note in the open vault *with its content*, in one call. Powers
/// the frontend link/metadata index. Async so the walk stays off the main thread.
#[tauri::command]
async fn read_vault(window: tauri::Window, state: State<'_, VaultState>) -> Result<Vec<basalt_core::VaultNote>, String> {
    let root = current_root(&state, window.label())?;
    Ok(basalt_core::read_vault(&root))
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
/// decoding, so that a later save can't silently re-encode and corrupt the file
/// — a deliberate data-safety stance (Obsidian vaults are UTF-8). Surfaces a
/// clear, actionable message for that case instead of a raw IO error.
#[tauri::command]
fn read_note(path: String, window: tauri::Window, state: State<VaultState>) -> Result<String, String> {
    let root = current_root(&state, window.label())?;
    basalt_core::read_note(&root, path)
}

/// Atomically write a note's contents, only within the vault.
#[tauri::command]
fn write_note(path: String, content: String, window: tauri::Window, state: State<VaultState>) -> Result<(), String> {
    let root = current_root(&state, window.label())?;
    basalt_core::write_note(&root, path, content)
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
    basalt_core::write_canvas(&root, path, content)
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
    basalt_core::write_base(&root, path, content)
}

/// Create a new empty note, returning its canonical path. `name` may be folder-
/// qualified (`sub/New`); parent folders are created.
#[tauri::command]
fn create_note(name: String, window: tauri::Window, state: State<VaultState>) -> Result<String, String> {
    let root = current_root(&state, window.label())?;
    basalt_core::create_note(&root, name)
}

/// Move a note to `<vault>/.trash/` (Obsidian-compatible, recoverable). A name
/// collision in the trash gets a timestamp suffix.
#[tauri::command]
fn delete_note(path: String, window: tauri::Window, state: State<VaultState>) -> Result<(), String> {
    let root = current_root(&state, window.label())?;
    basalt_core::delete_note(&root, path)
}

/// Move a whole FOLDER (by vault-relative path) to the vault trash —
/// recoverable, like note deletion. Refuses the root and dot-folders
/// (.obsidian/.basalt/.trash live outside the note tree).
#[tauri::command]
fn delete_folder(rel: String, window: tauri::Window, state: State<VaultState>) -> Result<(), String> {
    let root = current_root(&state, window.label())?;
    basalt_core::delete_folder(&root, rel)
}

/// Remove a folder ONLY if it is empty (recursively: empty subfolders count as
/// empty). Used to clean up after a folder rename moved every note out.
#[tauri::command]
fn remove_empty_folder(rel: String, window: tauri::Window, state: State<VaultState>) -> Result<(), String> {
    let root = current_root(&state, window.label())?;
    basalt_core::remove_empty_folder(&root, rel)
}

/// Every file under `rel` that is NOT a Markdown note (any extension, dotfiles
/// included; .DS_Store ignored) — a folder rename must refuse when these exist,
/// or the rename would silently split the folder. Capped at 20 entries.
#[tauri::command]
fn list_foreign_files(rel: String, window: tauri::Window, state: State<VaultState>) -> Result<Vec<String>, String> {
    let root = current_root(&state, window.label())?;
    basalt_core::list_foreign_files(&root, rel)
}

/// Empty-inclusive list of every subfolder under `rel` (vault-relative paths),
/// so a folder rename can recreate structure the note moves alone wouldn't.
#[tauri::command]
fn list_subfolders(rel: String, window: tauri::Window, state: State<VaultState>) -> Result<Vec<String>, String> {
    let root = current_root(&state, window.label())?;
    basalt_core::list_subfolders(&root, rel)
}

/// Create a folder (validated, vault-contained). Used to preserve empty
/// subfolder structure across a folder rename.
#[tauri::command]
fn create_folder(rel: String, window: tauri::Window, state: State<VaultState>) -> Result<(), String> {
    let root = current_root(&state, window.label())?;
    basalt_core::create_folder(&root, rel)
}

/// Move a whole FOLDER to a new vault-relative path in ONE `fs::rename` — every
/// note, attachment, and (empty or not) subfolder moves together with its
/// basename preserved verbatim, so a single link-rewrite pass on the frontend
/// fixes cross-folder links. Refuses the root, dot-folders, moving into itself,
/// and overwriting an existing target. Returns the canonical new absolute path.
#[tauri::command]
fn rename_folder(from_rel: String, to_rel: String, window: tauri::Window, state: State<VaultState>) -> Result<String, String> {
    let root = current_root(&state, window.label())?;
    basalt_core::rename_folder(&root, from_rel, to_rel)
}

/// Rename/move a note to a new folder-qualified name (no `.md`), creating
/// parent folders. Refuses to overwrite. Returns the canonical new path.
#[tauri::command]
fn rename_note(path: String, new_name: String, window: tauri::Window, state: State<VaultState>) -> Result<String, String> {
    let root = current_root(&state, window.label())?;
    basalt_core::rename_note(&root, path, new_name)
}

/// List every attachment (non-md supported file) in the open vault.
#[tauri::command]
async fn list_attachments(window: tauri::Window, state: State<'_, VaultState>) -> Result<Vec<basalt_core::AttachmentEntry>, String> {
    let root = current_root(&state, window.label())?;
    Ok(basalt_core::list_attachments(&root))
}

/// Save a pasted/dropped attachment (base64 payload) into the configured
/// attachment folder, uniquifying the name. Returns the new entry.
#[tauri::command]
async fn write_attachment(
    name: String,
    data_b64: String,
    source_rel: String,
    window: tauri::Window, state: State<'_, VaultState>,
) -> Result<basalt_core::AttachmentEntry, String> {
    let root = current_root(&state, window.label())?;
    basalt_core::write_attachment(&root, name, data_b64, source_rel)
}

/// Write a user-chosen export file. The path comes from the OS save dialog, so
/// it is user-authorized and may live outside the vault (no containment check).
/// Written atomically (temp + rename) so a failed/partial export can't leave a
/// half-written file in place of an existing one.
#[tauri::command]
fn export_file(path: String, content: String) -> Result<(), String> {
    basalt_core::export_file(path, content)
}

#[tauri::command]
fn read_obsidian_config(window: tauri::Window, state: State<VaultState>) -> Result<basalt_core::ObsidianConfig, String> {
    let root = current_root(&state, window.label())?;
    basalt_core::read_obsidian_config(&root)
}

#[tauri::command]
fn read_obsidian_import(
    window: tauri::Window,
    state: State<VaultState>,
) -> Result<basalt_core::ObsidianImport, String> {
    let root = current_root(&state, window.label())?;
    basalt_core::read_obsidian_import(&root)
}

/// Read `.obsidian/bookmarks.json` (Obsidian's Bookmarks core plugin),
/// flattened. Missing/unparseable file = no bookmarks (never an error).
#[tauri::command]
fn read_obsidian_bookmarks(window: tauri::Window, state: State<VaultState>) -> Result<Vec<basalt_core::Bookmark>, String> {
    let root = current_root(&state, window.label())?;
    basalt_core::read_obsidian_bookmarks(&root)
}

/// Toggle a FILE bookmark for `path` in `.obsidian/bookmarks.json`, returning
/// the new state (true = now bookmarked). This is the ONE place Basalt writes
/// into `.obsidian/` — done data-safely: the file is parsed as an opaque
/// serde_json::Value so every group, nested item, and unknown field is
/// preserved; only a top-level `{type:"file", path}` entry is added or removed,
/// and the write is atomic (temp + fsync + rename) so a torn write can't corrupt
/// the bookmarks Obsidian shares.
#[tauri::command]
fn toggle_file_bookmark(
    path: String,
    window: tauri::Window,
    state: State<VaultState>,
) -> Result<bool, String> {
    let root = current_root(&state, window.label())?;
    basalt_core::toggle_file_bookmark(&root, path)
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
        // iCloud emits them constantly — classify_change drops them so every
        // cloud touch doesn't cost a read+compare (or a full vault rescan).
        let metadata_only = matches!(
            event.kind,
            notify::EventKind::Modify(notify::event::ModifyKind::Metadata(_))
        );
        let (changed, rescan) = basalt_core::classify_change(&root_for_closure, metadata_only, &event.paths);
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

/// Resolve an image reference (relative to the note's folder, then the vault
/// root, then a bare-name search) and return it as a base64 `data:` URL.
#[tauri::command]
async fn read_image(
    target: String,
    source_rel: String,
    window: tauri::Window, state: State<'_, VaultState>,
) -> Result<String, String> {
    let root = current_root(&state, window.label())?;
    basalt_core::read_image(&root, target, source_rel)
}

/// List the vault's CSS snippets (each capped at 1MB; non-.css files skipped).
#[tauri::command]
fn list_css_snippets(window: tauri::Window, state: State<VaultState>) -> Result<Vec<basalt_core::CssSnippet>, String> {
    let root = current_root(&state, window.label())?;
    basalt_core::list_css_snippets(&root)
}

/// List installed Basalt plugins (each folder under `.basalt/plugins/` with a
/// manifest.json + main.js). Missing/malformed plugins are skipped, not fatal.
#[tauri::command]
fn list_plugins(window: tauri::Window, state: State<VaultState>) -> Result<Vec<basalt_core::PluginInfo>, String> {
    let root = current_root(&state, window.label())?;
    basalt_core::list_plugins(&root)
}

/// Persist a plugin's settings JSON to `.basalt/plugins/<id>/data.json`.
#[tauri::command]
fn write_plugin_data(
    id: String,
    data: String,
    window: tauri::Window,
    state: State<VaultState>,
) -> Result<(), String> {
    let root = current_root(&state, window.label())?;
    basalt_core::write_plugin_data(&root, id, data)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance MUST be registered first: a second `basalt://…` launch
    // routes into the running app (and, via the `deep-link` feature, forwards
    // the URL to on_open_url) instead of spawning a duplicate.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(VaultState(Mutex::new(HashMap::new())))
        .manage(WatcherState(Mutex::new(HashMap::new())))
        .manage(PendingDeepLink(Mutex::new(None)))
        .setup(|app| {
            use tauri_plugin_deep_link::DeepLinkExt;
            // A URL the app was launched with → stash for the frontend to take.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                if let Some(u) = urls.iter().find(|u| u.scheme() == "basalt") {
                    if let Some(s) = app.try_state::<PendingDeepLink>() {
                        *s.0.lock().unwrap() = Some(u.as_str().to_string());
                    }
                }
            }
            // Links that arrive while running → focus main + emit to the frontend.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if url.scheme() != "basalt" {
                        continue;
                    }
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    let _ = handle.emit("deep-link-open", url.as_str().to_string());
                }
            });
            // Custom schemes need runtime registration on Linux (and dev Windows).
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                let _ = app.deep_link().register_all();
            }
            Ok(())
        })
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
            take_pending_deep_link,
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
            read_obsidian_import,
            read_obsidian_bookmarks,
            toggle_file_bookmark,
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
