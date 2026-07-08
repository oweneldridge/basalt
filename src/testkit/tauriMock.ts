// In-memory mock of the Tauri IPC surface, so the FULL <App/> can run in a
// plain browser (Playwright/CI) and its panes, sidebar resizing, tab drag-drop,
// splits, etc. can be exercised — things the editor-only harness can't reach.
//
// Wired in via Vite `resolve.alias` in vite.harness.config.ts, which points
// @tauri-apps/api/{core,event,window} and plugin-dialog at this module.
import type { VaultNote, Attachment, ObsidianConfig } from "../lib/vault";

const VAULT = "/mock/vault";
const now = 1_700_000_000_000;

// A tiny fixture vault: a couple of top-level notes + one in a folder.
const notes = new Map<string, VaultNote>();
function seed(rel: string, content: string) {
  const path = `${VAULT}/${rel}`;
  const name = (rel.split("/").pop() ?? rel).replace(/\.md$/i, "");
  notes.set(path, { path, rel, name, content, mtime: now, ctime: now, size: content.length });
}
seed("Welcome.md", "# Welcome\n\nThis is the mock vault used for automated UI tests.\n\nSee [[Ideas]] and the [[Projects/Roadmap]].\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n");
seed("Ideas.md", "# Ideas\n\n- first\n- second\n  - nested\n\n#tag/one\n");
seed("Projects/Roadmap.md", "# Roadmap\n\n- [ ] ship v0.1.1\n- [x] release v0.1.0\n");

const config: ObsidianConfig = { newLinkFormat: "shortest" };

// A .canvas attachment fixture (for exercising the canvas editor / multi-select).
const CANVAS_PATH = `${VAULT}/Board.canvas`;
const canvasContent = JSON.stringify({
  nodes: [
    { id: "a1", type: "text", text: "Node A", x: 0, y: 0, width: 160, height: 60 },
    { id: "a2", type: "text", text: "Node B", x: 240, y: 0, width: 160, height: 60 },
    { id: "a3", type: "text", text: "Node C", x: 0, y: 160, width: 160, height: 60 },
  ],
  edges: [],
});
// A .base attachment fixture (for exercising the Bases view + editor).
const BASE_PATH = `${VAULT}/Notes.base`;
const baseContent = "views:\n  - type: table\n    name: All notes\n    order:\n      - file.name\n";
const files = new Map<string, string>([
  [CANVAS_PATH, canvasContent],
  [BASE_PATH, baseContent],
]);

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const a = args ?? {};
  const ok = <R>(v: R) => Promise.resolve(v as unknown as T);
  switch (cmd) {
    case "open_vault":
      return ok(VAULT);
    case "read_vault":
      return ok([...notes.values()]);
    case "read_note":
      return ok(files.get(String(a.path)) ?? notes.get(String(a.path))?.content ?? "");
    case "write_note":
    case "write_canvas":
    case "write_base": {
      const path = String(a.path);
      if (files.has(path)) files.set(path, String(a.content));
      const n = notes.get(path);
      if (n) n.content = String(a.content);
      return ok(undefined);
    }
    case "create_note": {
      const name = String(a.name);
      const rel = name.endsWith(".md") ? name : `${name}.md`;
      seed(rel, `# ${name.replace(/\.md$/i, "")}\n\n`);
      return ok(`${VAULT}/${rel}`);
    }
    case "rename_note":
      return ok(`${VAULT}/${String(a.newName)}.md`);
    case "read_obsidian_config":
      return ok(config);
    case "list_attachments":
      return ok([
        { path: CANVAS_PATH, rel: "Board.canvas", name: "Board.canvas", mtime: now, ctime: now, size: canvasContent.length },
        { path: BASE_PATH, rel: "Notes.base", name: "Notes.base", mtime: now, ctime: now, size: baseContent.length },
      ] as Attachment[]);
    case "read_obsidian_bookmarks":
    case "list_css_snippets":
    case "list_plugins":
    case "list_subfolders":
    case "list_foreign_files":
      return ok([]);
    case "read_image":
      return ok("");
    // Fire-and-forget / no-op side effects.
    case "start_watching":
    case "debug_log":
    case "write_plugin_data":
    case "write_attachment":
    case "create_folder":
    case "delete_note":
    case "delete_folder":
    case "remove_empty_folder":
    case "rename_folder":
    case "export_file":
    case "open_new_window":
      return ok(undefined);
    default:
      // Surface anything unmocked so tests fail loudly rather than hang.
      console.warn(`[tauriMock] unhandled invoke: ${cmd}`);
      return ok(undefined);
  }
}

// @tauri-apps/api/event
export function listen(): Promise<() => void> {
  return Promise.resolve(() => {});
}

// @tauri-apps/api/window
export function getCurrentWindow() {
  return {
    label: "main",
    listen: () => Promise.resolve(() => {}),
    onCloseRequested: () => Promise.resolve(() => {}),
    onFocusChanged: () => Promise.resolve(() => {}),
    setTitle: () => Promise.resolve(),
  };
}

// @tauri-apps/plugin-dialog
export function open() {
  return Promise.resolve(VAULT);
}
export function save() {
  return Promise.resolve(`${VAULT}/export.md`);
}
export function confirm() {
  return Promise.resolve(true);
}
export function ask() {
  return Promise.resolve(true);
}
export function message() {
  return Promise.resolve();
}

// @tauri-apps/plugin-opener
export function openUrl() {
  return Promise.resolve();
}
export function openPath() {
  return Promise.resolve();
}
export function revealItemInDir() {
  return Promise.resolve();
}
