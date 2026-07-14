// Basalt web backend.
// Copyright (C) 2026 Owen Eldridge. AGPL-3.0-or-later.
//
// Serves the Basalt web app + the vault over HTTP/SSE, using the SAME
// `basalt-core` vault engine (and its hardened path/atomic-write invariants) as
// the desktop app. One security-critical file layer, two front-ends.
//
// Transport contract (identical to the desktop's Tauri IPC, so the frontend's
// platform shim is a thin invoke/listen swap):
//   POST /api/invoke   {cmd, args}         -> {result} | {error}
//   GET  /api/events   (SSE)               -> data: {"event","payload"}\n\n
//   GET  /api/vault-root                   -> {root}
//   GET  /* (fallback)                     -> the built web app (dist/)
//
// Single-vault per process (the root is fixed at boot). Meant to sit behind
// Tailscale Serve (tailnet-only); optional HTTP Basic auth is defence in depth.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::sse::{Event, KeepAlive, Sse},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use notify::{RecursiveMode, Watcher};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, Semaphore};
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};

struct AppState {
    root: PathBuf,
    /// Watcher → SSE fan-out. Each frame is a serialized `{"event","payload"}`.
    tx: broadcast::Sender<String>,
    /// Caps concurrent (blocking, memory-heavy) command execution so a burst of
    /// read_vault calls can't amplify to an OOM.
    sem: Semaphore,
}

#[derive(Deserialize)]
struct InvokeReq {
    cmd: String,
    #[serde(default)]
    args: Value,
}

fn cli_arg(flag: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1).cloned())
}

#[tokio::main]
async fn main() {
    let vault = cli_arg("--vault")
        .or_else(|| std::env::var("BASALT_VAULT").ok())
        .unwrap_or_else(|| {
            eprintln!("usage: basalt-server --vault <path>   (or set BASALT_VAULT)");
            std::process::exit(1);
        });
    // Reuse the core's open_vault: canonicalize + is_dir + sweep stale temps.
    let root = basalt_core::open_vault(&vault).unwrap_or_else(|e| {
        eprintln!("vault: {e}");
        std::process::exit(1);
    });
    let port: u16 = std::env::var("BASALT_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(8799);
    let web_dir = PathBuf::from(std::env::var("BASALT_WEB_DIR").unwrap_or_else(|_| "dist".into()));
    // BASALT_AUTH="user:pass" enables HTTP Basic auth. Unset = no auth (rely on
    // the Tailscale-only network boundary — fine for a trusted tailnet). Present
    // but malformed (no ':') is a misconfiguration — fail CLOSED (exit) rather
    // than silently booting with auth disabled.
    let auth = match std::env::var("BASALT_AUTH") {
        Ok(s) => match s.split_once(':') {
            Some((u, p)) => Some((u.to_string(), p.to_string())),
            None => {
                eprintln!("BASALT_AUTH must be in 'user:pass' form; refusing to start with auth misconfigured");
                std::process::exit(1);
            }
        },
        Err(_) => None,
    };

    // Bounded fan-out channel; slow/absent SSE clients just lag and get dropped
    // frames (the frontend reconciles from disk on the next event anyway).
    let (tx, _rx) = broadcast::channel::<String>(256);
    // Keep the watcher alive for the life of the process (drop = stop watching).
    let _watcher = start_watcher(root.clone(), tx.clone()).unwrap_or_else(|e| {
        eprintln!("watch: {e}");
        std::process::exit(1);
    });

    let state = Arc::new(AppState { root: root.clone(), tx, sem: Semaphore::new(16) });

    let index = web_dir.join("index.html");
    let mut app = Router::new()
        .route("/api/invoke", post(invoke))
        .route("/api/events", get(events))
        .route("/api/vault-root", get(vault_root))
        // SPA fallback: unknown paths serve index.html so client routing works.
        .fallback_service(ServeDir::new(&web_dir).fallback(ServeFile::new(index)))
        .with_state(state)
        .layer(CompressionLayer::new()) // gzip — the 43MB read_vault → ~9MB
        // Room for base64 attachment writes (desktop has no limit; axum's 2MB
        // default would reject routine screenshot pastes with an opaque 413).
        .layer(DefaultBodyLimit::max(128 * 1024 * 1024));
    // NO CORS layer: the app is same-origin in prod (server serves dist/) and in
    // dev (vite proxies /api), so it never needs cross-origin access. Permissive
    // CORS would only let a drive-by website read/destroy the vault — the
    // browser's same-origin policy is the intended barrier and we keep it.

    if let Some((u, p)) = &auth {
        // Outermost layer → checked first. NOTE: browser EventSource can't set an
        // Authorization header, but once the page load prompts + the browser
        // caches Basic creds for the origin, it sends them on the SSE request too
        // (same-origin prod). Leave auth unset for the cross-origin dev setup.
        let expected = Arc::new(format!("Basic {}", b64(format!("{u}:{p}").as_bytes())));
        app = app.layer(middleware::from_fn_with_state(expected, basic_auth));
        println!("[basalt-server] HTTP Basic auth: ON");
    } else {
        println!("[basalt-server] HTTP Basic auth: OFF (set BASALT_AUTH=user:pass to enable)");
    }

    // Bind host: default 127.0.0.1 (safe on bare metal — only localhost or a
    // reverse proxy like Tailscale Serve can reach it). In Docker, set
    // BASALT_HOST=0.0.0.0 so the container's published port (bound to 127.0.0.1
    // on the host) can forward into it; the LAN still can't reach it.
    let host: std::net::IpAddr = std::env::var("BASALT_HOST")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| std::net::IpAddr::from([127, 0, 0, 1]));
    let addr = SocketAddr::new(host, port);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| {
            eprintln!("bind {addr}: {e}");
            std::process::exit(1);
        });
    println!("[basalt-server] vault {} on http://{addr}", root.display());
    axum::serve(listener, app).await.unwrap();
}

/// A filesystem watcher on the vault root that fans changes out to SSE clients,
/// reusing the core's exact classification (metadata-skip, `.md` → changed,
/// dir/attachment → rescan).
fn start_watcher(root: PathBuf, tx: broadcast::Sender<String>) -> notify::Result<notify::RecommendedWatcher> {
    let root_for_cb = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let metadata_only = matches!(
            event.kind,
            notify::EventKind::Modify(notify::event::ModifyKind::Metadata(_))
        );
        let (changed, rescan) = basalt_core::classify_change(&root_for_cb, metadata_only, &event.paths);
        if !changed.is_empty() {
            if let Ok(payload) = serde_json::to_value(&changed) {
                let _ = tx.send(frame("vault-changed", payload));
            }
        }
        if rescan {
            let _ = tx.send(frame("vault-rescan", Value::Null));
        }
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    Ok(watcher)
}

fn frame(event: &str, payload: Value) -> String {
    json!({ "event": event, "payload": payload }).to_string()
}

/// HTTP Basic auth as a small middleware we control (tower-http 0.6 dropped
/// `ValidateRequestHeaderLayer::basic`). Compares the whole `Authorization`
/// header to the precomputed `Basic <b64(user:pass)>`; a 401 with a
/// `WWW-Authenticate` challenge makes the browser prompt (and then cache creds,
/// which is what lets same-origin EventSource carry them).
async fn basic_auth(State(expected): State<Arc<String>>, req: Request, next: Next) -> Response {
    let provided = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    if provided.is_some_and(|p| ct_eq(p.as_bytes(), expected.as_bytes())) {
        next.run(req).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Basic realm=\"Basalt\"")],
            "Unauthorized\n",
        )
            .into_response()
    }
}

/// Length-checked, content-constant-time byte compare (no early-out on the
/// first differing byte) so the auth check doesn't leak how many leading bytes
/// of the credential matched.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

fn b64(data: &[u8]) -> String {
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

async fn vault_root(State(app): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({ "root": app.root.to_string_lossy() }))
}

async fn events(State(app): State<Arc<AppState>>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = app.tx.subscribe();
    let stream = BroadcastStream::new(rx).map(|msg| match msg {
        Ok(s) => Ok(Event::default().data(s)),
        // A lagged client fell behind the channel and MISSED frames. Don't drop
        // them silently (the missed change could later be clobbered by autosave)
        // — tell it to fully resync from disk.
        Err(BroadcastStreamRecvError::Lagged(_)) => Ok(Event::default().data(frame("vault-rescan", Value::Null))),
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn invoke(State(app): State<Arc<AppState>>, Json(req): Json<InvokeReq>) -> Json<Value> {
    // Cap concurrent command execution (read_vault is ~150MB peak); excess
    // requests queue as backpressure instead of piling up toward an OOM.
    let _permit = app.sem.acquire().await;
    let root = app.root.clone();
    // Every core op is blocking fs work — keep it off the async worker threads.
    let out = tokio::task::spawn_blocking(move || dispatch(&root, &req.cmd, &req.args)).await;
    match out {
        Ok(Ok(v)) => Json(json!({ "result": v })),
        Ok(Err(e)) => Json(json!({ "error": e })),
        Err(e) => Json(json!({ "error": format!("task failed: {e}") })),
    }
}

fn to_val<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// Map an `{cmd, args}` request to a `basalt_core` call. This is the whole
/// command surface the frontend depends on. Arg key names match src/lib/vault.ts.
fn dispatch(root: &Path, cmd: &str, a: &Value) -> Result<Value, String> {
    let s = |k: &str| {
        a.get(k)
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| format!("missing string arg: {k}"))
    };
    match cmd {
        // Single-vault server: open_vault returns the fixed root (the path arg is
        // ignored — the web app can only ever reach this one vault).
        "open_vault" => Ok(json!(root.to_string_lossy())),
        "read_vault" => to_val(basalt_core::read_vault(root)),
        "list_attachments" => to_val(basalt_core::list_attachments(root)),
        "read_note" => basalt_core::read_note(root, s("path")?).map(|x| json!(x)),
        "write_note" => basalt_core::write_note(root, s("path")?, s("content")?).map(|_| Value::Null),
        "write_canvas" => basalt_core::write_canvas(root, s("path")?, s("content")?).map(|_| Value::Null),
        "write_base" => basalt_core::write_base(root, s("path")?, s("content")?).map(|_| Value::Null),
        "create_note" => basalt_core::create_note(root, s("name")?).map(|x| json!(x)),
        "delete_note" => basalt_core::delete_note(root, s("path")?).map(|_| Value::Null),
        "rename_note" => basalt_core::rename_note(root, s("path")?, s("newName")?).map(|x| json!(x)),
        "delete_folder" => basalt_core::delete_folder(root, s("rel")?).map(|_| Value::Null),
        "remove_empty_folder" => basalt_core::remove_empty_folder(root, s("rel")?).map(|_| Value::Null),
        "list_foreign_files" => basalt_core::list_foreign_files(root, s("rel")?).and_then(|v| to_val(v)),
        "list_subfolders" => basalt_core::list_subfolders(root, s("rel")?).and_then(|v| to_val(v)),
        "create_folder" => basalt_core::create_folder(root, s("rel")?).map(|_| Value::Null),
        "rename_folder" => basalt_core::rename_folder(root, s("fromRel")?, s("toRel")?).map(|x| json!(x)),
        "write_attachment" => {
            basalt_core::write_attachment(root, s("name")?, s("dataB64")?, s("sourceRel")?).and_then(|v| to_val(v))
        }
        "read_obsidian_config" => basalt_core::read_obsidian_config(root).and_then(|v| to_val(v)),
        "read_obsidian_import" => basalt_core::read_obsidian_import(root).and_then(|v| to_val(v)),
        "read_obsidian_bookmarks" => basalt_core::read_obsidian_bookmarks(root).and_then(|v| to_val(v)),
        "toggle_file_bookmark" => basalt_core::toggle_file_bookmark(root, s("path")?).map(|b| json!(b)),
        "read_image" => basalt_core::read_image(root, s("target")?, s("sourceRel")?).map(|x| json!(x)),
        "list_css_snippets" => basalt_core::list_css_snippets(root).and_then(|v| to_val(v)),
        "list_plugins" => basalt_core::list_plugins(root).and_then(|v| to_val(v)),
        "write_plugin_data" => basalt_core::write_plugin_data(root, s("id")?, s("data")?).map(|_| Value::Null),
        // The watcher already runs from boot, so this is a no-op success.
        "start_watching" => Ok(Value::Null),
        // Deep links / multi-window are desktop-only; keep the frontend happy.
        "take_pending_deep_link" => Ok(Value::Null),
        "debug_log" => {
            eprintln!("[basalt-web-js] {}", s("msg").unwrap_or_default());
            Ok(Value::Null)
        }
        // SECURITY: never let a remote client write an arbitrary server-side path.
        // (Desktop export uses a native save dialog; the web equivalent is a
        // browser download, handled on the frontend later — see Phase C notes.)
        "export_file" => Err("Exporting to a file isn't available in the web app yet.".into()),
        "open_new_window" => Err("Opening a second window isn't available in the web app.".into()),
        other => Err(format!("unknown command: {other}")),
    }
}
