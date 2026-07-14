// Platform transport. The frontend talks to its backend the same way whether
// it's the desktop app (Tauri IPC) or the web app (HTTP/SSE to basalt-server).
// Everything funnels through here, chosen at RUNTIME by `isTauri`, so one build
// serves both: in the Tauri webview it uses IPC; served over HTTP it uses fetch.
//
// The desktop path is a straight pass-through to @tauri-apps/api (behaviour is
// identical to importing it directly). The web path mirrors basalt-server's
// contract: POST /api/invoke {cmd,args} and an SSE stream of {event,payload}.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow as tauriGetCurrentWindow } from "@tauri-apps/api/window";
import { open as tauriOpen, save as tauriSave, confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import { openUrl as tauriOpenUrl, openPath as tauriOpenPath, revealItemInDir as tauriReveal } from "@tauri-apps/plugin-opener";

/** True inside the Tauri desktop shell; false in a plain browser (web app). */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// basalt-server is same-origin in production (it serves the built app), and in
// dev vite proxies /api → the server (see vite.config.ts). So a relative base
// works everywhere — no CORS, no cross-origin credentials.
const API = "";

async function httpInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${API}/api/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd, args: args ?? {} }),
  });
  // The server answers with a {result}|{error} JSON envelope. A non-JSON body is
  // a transport-level rejection (413 too-large, 401, 5xx) — surface a clean
  // message rather than letting JSON parsing throw an opaque SyntaxError.
  let j: { result?: T; error?: string };
  try {
    j = await r.json();
  } catch {
    throw new Error(
      r.status === 413 ? "File is too large to save over the web." : `Server error ${r.status} ${r.statusText}`,
    );
  }
  if (j.error) throw new Error(j.error);
  return j.result as T;
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return isTauri ? tauriInvoke<T>(cmd, args) : httpInvoke<T>(cmd, args);
}

// --- events: Tauri events on desktop, one shared EventSource in the browser ---
type WebEvent = { payload: unknown };
const webHandlers = new Map<string, Set<(e: WebEvent) => void>>();
let es: EventSource | null = null;
let connectedBefore = false;
function ensureStream() {
  if (es) return;
  es = new EventSource(`${API}/api/events`);
  es.onopen = () => {
    // On RE-connect (laptop sleep/wake, a network blip, a server restart) the
    // stream missed any frames emitted during the gap, so an open note could be
    // stale and get silently clobbered by autosave. Force a full resync — App's
    // vault-rescan handler reloads the index and reconciles open panes (raising a
    // conflict for dirty ones). The FIRST connect needs none (the app is just
    // loading the vault).
    if (connectedBefore) {
      webHandlers.get("vault-rescan")?.forEach((h) => h({ payload: null }));
    }
    connectedBefore = true;
  };
  es.onmessage = (m) => {
    try {
      const { event, payload } = JSON.parse(m.data);
      webHandlers.get(event)?.forEach((h) => h({ payload }));
    } catch {
      /* keep-alive comment or malformed frame — ignore */
    }
  };
  es.onerror = () => {
    /* the browser auto-reconnects an EventSource; onopen fires again on success */
  };
}
export function listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<UnlistenFn> {
  if (isTauri) return tauriListen<T>(event, handler);
  ensureStream();
  let set = webHandlers.get(event);
  if (!set) {
    set = new Set();
    webHandlers.set(event, set);
  }
  set.add(handler as (e: WebEvent) => void);
  return Promise.resolve(() => set!.delete(handler as (e: WebEvent) => void));
}

// --- current window: the real Tauri window on desktop, a benign stub on web
// (the web app is single-window; close/blur/focus are handled by the browser) ---
export function getCurrentWindow(): ReturnType<typeof tauriGetCurrentWindow> {
  if (isTauri) return tauriGetCurrentWindow();
  return {
    label: "main",
    listen: () => Promise.resolve(() => {}),
    onCloseRequested: () => Promise.resolve(() => {}),
    onFocusChanged: () => Promise.resolve(() => {}),
    setTitle: () => Promise.resolve(),
  } as unknown as ReturnType<typeof tauriGetCurrentWindow>;
}

// --- dialogs ---
// The web "folder picker" can only ever resolve to the one vault the server
// hosts, so it returns that root (pickVault treats a string result as chosen).
export function open(options?: Parameters<typeof tauriOpen>[0]): ReturnType<typeof tauriOpen> {
  if (isTauri) return tauriOpen(options);
  // The web "picker" resolves to the one served vault; if the server is briefly
  // unreachable, resolve null (matching the desktop cancel contract) instead of
  // rejecting into an unhandled promise.
  return webVaultRoot().catch(() => null) as ReturnType<typeof tauriOpen>;
}
// Web export is a browser download (a later enhancement); the server refuses
// export_file, so returning null makes the export flow no-op cleanly for now.
export function save(options?: Parameters<typeof tauriSave>[0]): ReturnType<typeof tauriSave> {
  if (isTauri) return tauriSave(options);
  return Promise.resolve(null) as ReturnType<typeof tauriSave>;
}
export function confirm(message: string, options?: Parameters<typeof tauriConfirm>[1]): Promise<boolean> {
  if (isTauri) return tauriConfirm(message, options);
  return Promise.resolve(window.confirm(message));
}

// --- opener ---
export function openUrl(url: string): Promise<void> {
  if (isTauri) return tauriOpenUrl(url);
  window.open(url, "_blank", "noopener");
  return Promise.resolve();
}
export function openPath(path: string): Promise<void> {
  if (isTauri) return tauriOpenPath(path);
  return Promise.resolve(); // a browser can't open a server-side filesystem path
}
export function revealItemInDir(path: string): Promise<void> {
  if (isTauri) return tauriReveal(path);
  return Promise.resolve();
}

/** The vault root basalt-server hosts (web only) — used to seed the app's
 * last-vault on boot and to answer the web folder picker. */
export async function webVaultRoot(): Promise<string> {
  const { root } = await fetch(`${API}/api/vault-root`).then((r) => r.json());
  return root as string;
}
