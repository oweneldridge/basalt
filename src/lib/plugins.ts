// Basalt's plugin system. Plugins are Basalt's OWN API (not Obsidian's), but —
// per the user's chosen model — they run as trusted in-webview JavaScript: a
// plugin's main.js is executed here with full webview access. That is powerful
// and, like Obsidian, means you install only plugins you trust. Loading is
// OFF by default and each plugin is enabled explicitly in Settings.
//
// A plugin's main.js is a CommonJS module:
//   const { Plugin, Notice } = require("basalt");
//   module.exports = class extends Plugin {
//     async onload() {
//       this.addCommand({ id: "hi", name: "Say hi", callback: () => new Notice("hi") });
//       this.registerMarkdownCodeBlockProcessor("chart", (src, el) => { el.textContent = src; });
//     }
//   };

import type { Extension } from "@codemirror/state";

/** What a plugin main.js exports (a class extending Plugin, or a plain object). */
type PluginModule =
  | (new (ctx: PluginContext) => PluginInstance)
  | ((ctx: PluginContext) => PluginInstance)
  | PluginInstance;

interface PluginInstance {
  onload?: () => void | Promise<void>;
  onunload?: () => void | Promise<void>;
}

/** Raw plugin as read from disk by the Rust `list_plugins` command. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  minAppVersion: string;
  code: string;
  data: string | null;
}

/** A markdown code-block processor: render `source` into `el` for a fenced
 * block of the registered language. `ctx` carries the host note's path. */
export type CodeBlockProcessor = (
  source: string,
  el: HTMLElement,
  ctx: { notePath: string },
) => void;

/** Parsed metadata for one note (Obsidian's metadataCache.getFileCache). */
export interface FileCache {
  /** Tags in the note (frontmatter + inline `#tag`), each without the `#`. */
  tags: string[];
  /** Resolved-or-not outgoing link targets. */
  links: string[];
  /** Headings, in document order. */
  headings: { heading: string; level: number }[];
  /** Parsed YAML frontmatter (empty object if none). */
  frontmatter: Record<string, unknown>;
}

/** The concrete capabilities App wires into the host. Keeping the host UI- and
 * Tauri-agnostic makes it unit-testable and keeps the trust surface explicit. */
export interface HostDeps {
  /** A note's text as the app last saw it on disk, without a round trip
   * (null when it doesn't hold it, e.g. a note over the index cap). */
  cachedRead?: (rel: string) => string | null;
  /** Vault notes. `ctime`/`mtime` are epoch-ms (for Dataview-style file dates);
   * older callers may omit them. */
  getMarkdownFiles: () => { path: string; name: string; ctime?: number; mtime?: number }[];
  /** Every file in the vault, notes and attachments (vault-relative paths). */
  getFiles?: () => { path: string; ctime?: number; mtime?: number; size?: number }[];
  /** Every folder in the vault (vault-relative paths). */
  getFolders?: () => string[];
  readNote: (path: string) => Promise<string>;
  createNote: (path: string, content: string) => Promise<void>;
  /** With `expected`, the write is refused unless the note still reads so. */
  modifyNote: (path: string, content: string, expected?: string) => Promise<void>;
  /** Move a note (by vault-relative path) to the vault trash. */
  deleteNote: (path: string) => Promise<void>;
  /** Rename/move a note; `newPath` is a vault-relative path (with or without .md). */
  renameNote: (path: string, newPath: string) => Promise<void>;
  /** Create a folder (by vault-relative path). */
  createFolder: (path: string) => Promise<void>;
  getActiveNotePath: () => string | null;
  openNote: (target: string) => void;
  vaultName: () => string;
  savePluginData: (id: string, json: string) => Promise<void>;
  notice: (message: string, timeoutMs?: number) => void;
  /** Parsed metadata for a note (by vault-relative path), or null if unknown. */
  getFileCache: (path: string) => FileCache | null;
  /** Obsidian's resolvedLinks: source note → the files it links to → count. */
  resolvedLinks?: () => Record<string, Record<string, number>>;
  /** Obsidian's unresolvedLinks: source note → names it links to that aren't
   * in the vault → count. */
  unresolvedLinks?: () => Record<string, Record<string, number>>;
  /** Insert text at the focused editor's caret (replacing any selection); place
   * the caret `caretOffset` chars into the inserted text. No-op if no editor.
   * Optional so older host wirings still satisfy the type. */
  insertAtCursor?: (text: string, caretOffset?: number) => void;
  /** Open (creating if needed) the daily note for a date, using the vault's
   * Daily notes settings: folder, date format and template. `folderIfUnset` is
   * used only when the vault has no Daily notes settings. */
  openDailyNote?: (date: Date, folderIfUnset?: string) => Promise<void>;
  /** Whether the daily note for a date exists. */
  hasDailyNote?: (date: Date, folderIfUnset?: string) => boolean;
  /** Re-render open editors/reading views after processors/commands change. */
  onRegistryChanged: () => void;
}

// ---------------------------------------------------------------------------
// Registries (shared with the command palette + the code-block renderers).

export interface PluginCommand {
  id: string; // namespaced: "<pluginId>:<id>"
  name: string;
  callback: () => void;
}

// Languages Basalt renders itself — a plugin can't shadow them.
const RESERVED_LANGS = new Set(["mermaid", "dataview", "query", "basalt-query", "base"]);

const commands = new Map<string, PluginCommand>();
const processors = new Map<string, { pluginId: string; fn: CodeBlockProcessor }>();
const editorExtensions: { pluginId: string; ext: Extension }[] = [];

// ---------------------------------------------------------------------------
// Event bus. Plugins subscribe via app.vault.on / app.workspace.on; the host
// (App) emits with emitVaultEvent / emitWorkspaceEvent. A subscription returns
// an EventRef the plugin should pass to registerEvent() for auto-cleanup.

export type VaultEventName = "create" | "delete" | "rename" | "modify";
export type WorkspaceEventName = "file-open" | "active-leaf-change";
/** A minimal file handle passed to event callbacks. */
export interface PluginFile {
  path: string;
  name: string;
}
export interface EventRef {
  off: () => void;
}
type Listener = (...args: unknown[]) => void;

const vaultListeners = new Map<string, Set<Listener>>();
const workspaceListeners = new Map<string, Set<Listener>>();
// Live vault subscriptions per plugin and event ("id:event"), so the host can
// tell whether a plugin will act on a note it makes.
const listening = new Map<string, number>();

/** Whether plugin `id` is subscribed to vault event `name` right now. */
export function listensFor(id: string, name: VaultEventName): boolean {
  return (listening.get(`${id}:${name}`) ?? 0) > 0;
}

function subscribe(map: Map<string, Set<Listener>>, name: string, cb: Listener): EventRef {
  let set = map.get(name);
  if (!set) {
    set = new Set();
    map.set(name, set);
  }
  set.add(cb);
  return { off: () => map.get(name)?.delete(cb) };
}
function emit(map: Map<string, Set<Listener>>, name: string, args: unknown[]): void {
  const set = map.get(name);
  if (!set) return;
  for (const h of [...set]) {
    try {
      h(...args);
    } catch (e) {
      console.error(`plugin ${name} handler failed:`, e);
    }
  }
}
export function emitVaultEvent(name: VaultEventName, ...args: unknown[]): void {
  emit(vaultListeners, name, args);
}
export function emitWorkspaceEvent(name: WorkspaceEventName, ...args: unknown[]): void {
  emit(workspaceListeners, name, args);
}

export function pluginCommands(): PluginCommand[] {
  return [...commands.values()];
}
export function codeBlockProcessor(lang: string): CodeBlockProcessor | null {
  return processors.get(lang.toLowerCase())?.fn ?? null;
}
export function hasCodeBlockProcessor(lang: string): boolean {
  return processors.has(lang.toLowerCase());
}
export function pluginEditorExtensions(): Extension[] {
  return editorExtensions.map((e) => e.ext);
}

/** A plugin settings panel: the plugin owns `containerEl` and fills it in
 * `display()`; the Settings UI mounts it on demand. */
export interface SettingTab {
  containerEl: HTMLElement;
  display: () => void;
  hide?: () => void;
}
const settingTabs = new Map<string, SettingTab>(); // pluginId -> tab
export function pluginSettingTabs(): { pluginId: string; name: string; tab: SettingTab }[] {
  return [...settingTabs.entries()].map(([pluginId, tab]) => ({
    pluginId,
    name: loaded.get(pluginId)?.info.name ?? pluginId,
    tab,
  }));
}

// Plugin-owned status bar items (a <span> per addStatusBarItem call). The status
// bar mounts them; the plugin fills/updates them.
const statusBarItems: { pluginId: string; el: HTMLElement }[] = [];
export function pluginStatusBarItems(): HTMLElement[] {
  return statusBarItems.map((s) => s.el);
}

// Plugin-contributed ribbon icons.
export interface RibbonItem {
  pluginId: string;
  icon: string;
  title: string;
  callback: () => void;
}
const ribbonItems: RibbonItem[] = [];
export function pluginRibbonItems(): RibbonItem[] {
  return [...ribbonItems];
}

// Plugin-contributed right-panel views. `mount` receives a container the plugin
// fills; its optional return is a cleanup run when the view is hidden/unloaded.
export interface PluginView {
  pluginId: string;
  id: string;
  name: string;
  mount: (container: HTMLElement) => (() => void) | void;
}
const pluginViews = new Map<string, PluginView>(); // keyed by view id
export function pluginRightViews(): PluginView[] {
  return [...pluginViews.values()];
}

// ---------------------------------------------------------------------------
// Host.

let deps: HostDeps | null = null;
export function installHost(d: HostDeps | null): void {
  deps = d;
}

interface LoadedPlugin {
  info: PluginInfo;
  instance: PluginInstance;
  cleanups: (() => void)[];
}
const loaded = new Map<string, LoadedPlugin>();

/** True if a plugin currently seems to be enabled (loaded). */
export function isLoaded(id: string): boolean {
  return loaded.has(id);
}
export function loadedIds(): string[] {
  return [...loaded.keys()];
}

class PluginContext {
  cleanups: (() => void)[] = [];
  constructor(public readonly info: PluginInfo) {}
}

/** The `basalt` module returned to plugins via require("basalt"). */
function makeBasaltApi(ctx: PluginContext, host: HostDeps) {
  class Notice {
    constructor(message: string, timeoutMs = 4000) {
      host.notice(String(message), timeoutMs);
    }
  }

  // Base class for a plugin settings panel. The plugin overrides display() to
  // populate `containerEl`; Settings mounts it on demand.
  class PluginSettingTab {
    app = app;
    plugin: unknown;
    containerEl: HTMLElement = document.createElement("div");
    constructor(_app?: unknown, plugin?: unknown) {
      this.plugin = plugin;
    }
    display(): void {
      /* override */
    }
    hide(): void {
      /* override */
    }
  }

  // Files and folders shaped like Obsidian's TFile and TFolder.
  const fileOf = (f: { path: string; ctime?: number; mtime?: number; size?: number }) => {
    const name = f.path.split("/").pop() ?? f.path;
    const dot = name.lastIndexOf(".");
    return {
      path: f.path,
      name,
      basename: dot > 0 ? name.slice(0, dot) : name,
      extension: dot > 0 ? name.slice(dot + 1) : "",
      stat: { ctime: f.ctime ?? 0, mtime: f.mtime ?? 0, size: f.size ?? 0 },
    };
  };
  const allFiles = () => (host.getFiles?.() ?? host.getMarkdownFiles().map((f) => ({ ...f, path: f.path }))).map(fileOf);
  type Folder = { path: string; name: string; children: unknown[]; parent: Folder | null };
  const allLoaded = () => {
    const root: Folder = { path: "/", name: "", children: [], parent: null };
    const folders = new Map<string, Folder>([["", root]]);
    for (const rel of [...(host.getFolders?.() ?? [])].sort()) {
      folders.set(rel, { path: rel, name: rel.split("/").pop() ?? rel, children: [], parent: null });
    }
    const parentOf = (path: string) => folders.get(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "") ?? root;
    for (const [rel, folder] of folders) {
      if (!rel) continue;
      folder.parent = parentOf(rel);
      folder.parent.children.push(folder);
    }
    const files = allFiles().map((f) => {
      const parent = parentOf(f.path);
      const file = { ...f, parent };
      parent.children.push(file);
      return file;
    });
    return [...folders.values(), ...files];
  };

  const app = {
    vault: {
      getName: () => host.vaultName(),
      getMarkdownFiles: () => host.getMarkdownFiles(),
      /** Every file, notes and attachments, as Obsidian's TFile. */
      getFiles: () => allLoaded().filter((f) => !("children" in f)),
      /** Every file and folder, the vault's root first, as Obsidian gives them. */
      getAllLoadedFiles: () => allLoaded(),
      read: (file: { path: string } | string) =>
        host.readNote(typeof file === "string" ? file : file.path),
      /** Obsidian's cachedRead: the app's copy when it has one, else a read. */
      cachedRead: async (file: { path: string } | string) => {
        const rel = typeof file === "string" ? file : file.path;
        return host.cachedRead?.(rel) ?? host.readNote(rel);
      },
      create: (path: string, content: string) => host.createNote(path, content),
      modify: (file: { path: string } | string, content: string) =>
        host.modifyNote(typeof file === "string" ? file : file.path, content),
      /** Obsidian's process: change a note from its current text in one step;
       * refused if the note changes between the read and the write. */
      process: async (file: { path: string } | string, fn: (data: string) => string) => {
        const rel = typeof file === "string" ? file : file.path;
        const current = await host.readNote(rel);
        const next = fn(current);
        if (next !== current) await host.modifyNote(rel, next, current);
        return next;
      },
      delete: (file: { path: string } | string) =>
        host.deleteNote(typeof file === "string" ? file : file.path),
      rename: (file: { path: string } | string, newPath: string) =>
        host.renameNote(typeof file === "string" ? file : file.path, newPath),
      createFolder: (path: string) => host.createFolder(path),
      /** Subscribe to a vault event: create/delete/modify → (file); rename →
       * (file, oldPath). Pass the returned ref to plugin.registerEvent(). */
      on: (name: VaultEventName, cb: (...args: unknown[]) => void): EventRef => {
        const key = `${ctx.info.id}:${name}`;
        const ref = subscribe(vaultListeners, name, cb);
        listening.set(key, (listening.get(key) ?? 0) + 1);
        let live = true;
        return {
          off: () => {
            ref.off();
            if (live) listening.set(key, (listening.get(key) ?? 1) - 1);
            live = false;
          },
        };
      },
    },
    /** Daily notes as the vault's Daily notes settings define them. Absent on
     * hosts that don't provide them. */
    dailyNotes:
      host.openDailyNote && host.hasDailyNote
        ? {
            open: (date: Date, folderIfUnset?: string) => host.openDailyNote!(date, folderIfUnset),
            has: (date: Date, folderIfUnset?: string) => host.hasDailyNote!(date, folderIfUnset),
          }
        : undefined,
    metadataCache: {
      /** Parsed metadata for a note (accepts a `{path}` or a rel string). */
      getFileCache: (file: { path: string } | string): FileCache | null =>
        host.getFileCache(typeof file === "string" ? file : file.path),
      /** Each note's resolved links, as Obsidian's `resolvedLinks`. */
      get resolvedLinks(): Record<string, Record<string, number>> {
        return host.resolvedLinks?.() ?? {};
      },
      /** Each note's links to files that aren't there, as Obsidian's `unresolvedLinks`. */
      get unresolvedLinks(): Record<string, Record<string, number>> {
        return host.unresolvedLinks?.() ?? {};
      },
    },
    workspace: {
      getActiveFile: () => {
        const p = host.getActiveNotePath();
        return p ? { path: p } : null;
      },
      openLinkText: (target: string) => host.openNote(target),
      /** The focused editor (Obsidian-shaped: `activeEditor.editor`), or null.
       * The editor exposes replaceSelection + a Basalt insertAtCursor that can
       * place the caret inside the inserted text. */
      get activeEditor() {
        return host.getActiveNotePath() ? { editor } : null;
      },
      /** Subscribe to a workspace event: file-open → (file|null);
       * active-leaf-change → (file|null). */
      on: (name: WorkspaceEventName, cb: (...args: unknown[]) => void): EventRef =>
        subscribe(workspaceListeners, name, cb),
    },
  };

  const editor = {
    replaceSelection: (text: string) => host.insertAtCursor?.(String(text)),
    insertAtCursor: (text: string, caretOffset?: number) =>
      host.insertAtCursor?.(String(text), caretOffset),
  };

  class Plugin {
    app = app;
    manifest = ctx.info;
    /** Register a command in the palette; auto-removed on unload. */
    addCommand(cmd: { id: string; name: string; callback: () => void }) {
      const id = `${ctx.info.id}:${cmd.id}`;
      commands.set(id, { id, name: cmd.name, callback: cmd.callback });
      ctx.cleanups.push(() => commands.delete(id));
      host.onRegistryChanged();
    }
    registerMarkdownCodeBlockProcessor(lang: string, fn: CodeBlockProcessor) {
      const key = lang.toLowerCase();
      if (RESERVED_LANGS.has(key)) {
        host.notice(`Plugin ${ctx.info.id}: "${key}" is a built-in block and can't be overridden`);
        return;
      }
      processors.set(key, { pluginId: ctx.info.id, fn });
      ctx.cleanups.push(() => {
        if (processors.get(key)?.pluginId === ctx.info.id) processors.delete(key);
      });
      host.onRegistryChanged();
    }
    registerEditorExtension(ext: Extension) {
      const entry = { pluginId: ctx.info.id, ext };
      editorExtensions.push(entry);
      ctx.cleanups.push(() => {
        const i = editorExtensions.indexOf(entry);
        if (i >= 0) editorExtensions.splice(i, 1);
      });
      host.onRegistryChanged();
    }
    /** Register a settings panel shown under this plugin in Settings. */
    addSettingTab(tab: SettingTab) {
      settingTabs.set(ctx.info.id, tab);
      ctx.cleanups.push(() => {
        if (settingTabs.get(ctx.info.id) === tab) settingTabs.delete(ctx.info.id);
      });
      host.onRegistryChanged();
    }
    /** Add a ribbon icon (an emoji/text glyph + tooltip) that runs `callback`. */
    addRibbonIcon(icon: string, title: string, callback: () => void) {
      const entry: RibbonItem = { pluginId: ctx.info.id, icon, title, callback };
      ribbonItems.push(entry);
      ctx.cleanups.push(() => {
        const i = ribbonItems.indexOf(entry);
        if (i >= 0) ribbonItems.splice(i, 1);
      });
      host.onRegistryChanged();
    }
    /** Register a custom right-panel view (shown as an extra tab). `mount` fills
     * the given container and may return a cleanup run when the view hides. */
    registerView(id: string, name: string, mount: (container: HTMLElement) => (() => void) | void) {
      const view: PluginView = { pluginId: ctx.info.id, id, name, mount };
      pluginViews.set(id, view);
      ctx.cleanups.push(() => {
        if (pluginViews.get(id) === view) pluginViews.delete(id);
      });
      host.onRegistryChanged();
    }
    /** Add an item to the status bar; returns the element to fill. */
    addStatusBarItem(): HTMLElement {
      const el = document.createElement("span");
      el.className = "status-bar-item plugin-status-item";
      const entry = { pluginId: ctx.info.id, el };
      statusBarItems.push(entry);
      ctx.cleanups.push(() => {
        const i = statusBarItems.indexOf(entry);
        if (i >= 0) statusBarItems.splice(i, 1);
        el.remove();
      });
      host.onRegistryChanged();
      return el;
    }
    /** Register an arbitrary cleanup run on unload. */
    register(cleanup: () => void) {
      ctx.cleanups.push(cleanup);
    }
    /** Track an event subscription so it's removed on unload. */
    registerEvent(ref: EventRef) {
      ctx.cleanups.push(() => ref.off());
    }
    /** Add a DOM listener that's removed on unload. */
    registerDomEvent(el: EventTarget, type: string, cb: (ev: Event) => void) {
      el.addEventListener(type, cb);
      ctx.cleanups.push(() => el.removeEventListener(type, cb));
    }
    /** Start an interval cleared on unload; returns the id. */
    registerInterval(cb: () => void, ms: number): number {
      const id = setInterval(cb, ms) as unknown as number;
      ctx.cleanups.push(() => clearInterval(id));
      return id;
    }
    async loadData(): Promise<unknown> {
      if (!ctx.info.data) return null;
      try {
        return JSON.parse(ctx.info.data);
      } catch {
        return null;
      }
    }
    async saveData(data: unknown): Promise<void> {
      const json = JSON.stringify(data ?? null);
      ctx.info.data = json;
      await host.savePluginData(ctx.info.id, json);
    }
  }

  return { Plugin, Notice, PluginSettingTab, app };
}

/** Execute a plugin's main.js in a CommonJS wrapper and return its export. */
function evalPluginModule(ctx: PluginContext, host: HostDeps): PluginModule {
  const api = makeBasaltApi(ctx, host);
  const require = (name: string) => {
    if (name === "basalt") return api;
    throw new Error(`Plugin ${ctx.info.id}: require("${name}") is not available`);
  };
  const module: { exports: unknown } = { exports: {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("module", "exports", "require", "basalt", ctx.info.code);
  fn(module, module.exports, require, api);
  return module.exports as PluginModule;
}

function instantiate(mod: PluginModule, ctx: PluginContext): PluginInstance {
  if (typeof mod === "function") {
    // class or factory — try `new`, fall back to calling it.
    try {
      return new (mod as new (c: PluginContext) => PluginInstance)(ctx);
    } catch {
      return (mod as (c: PluginContext) => PluginInstance)(ctx);
    }
  }
  return mod as PluginInstance;
}

/** Load and start a single plugin. ATOMIC: if evaluating/instantiating/onload
 * throws, everything the plugin registered before failing is rolled back and it
 * is NOT left in the loaded set. Throws on failure (caller reports). */
export async function loadPlugin(info: PluginInfo): Promise<void> {
  if (!deps) throw new Error("plugin host not installed");
  if (loaded.has(info.id)) return;
  const ctx = new PluginContext(info);
  const entry: LoadedPlugin = { info, instance: {}, cleanups: ctx.cleanups };
  loaded.set(info.id, entry);
  try {
    const mod = evalPluginModule(ctx, deps);
    entry.instance = instantiate(mod, ctx);
    await entry.instance.onload?.();
  } catch (e) {
    await unloadPlugin(info.id); // undo any partial registrations
    throw e;
  }
  deps.onRegistryChanged();
}

/** Stop and unregister a plugin. Never throws. */
export async function unloadPlugin(id: string): Promise<void> {
  const lp = loaded.get(id);
  if (!lp) return;
  loaded.delete(id);
  try {
    await lp.instance.onunload?.();
  } catch (e) {
    console.error(`Plugin ${id} onunload failed:`, e);
  }
  for (const c of lp.cleanups.splice(0).reverse()) {
    try {
      c();
    } catch (e) {
      console.error(`Plugin ${id} cleanup failed:`, e);
    }
  }
  deps?.onRegistryChanged();
}

export async function unloadAll(): Promise<void> {
  for (const id of [...loaded.keys()]) await unloadPlugin(id);
}

// ---------------------------------------------------------------------------
// Enabled-plugin persistence (per vault, in localStorage — keeps it out of the
// synced vault; enabling runs code, so it stays a local, explicit choice).

const enabledKey = (vault: string) => `basalt.plugins.enabled.${vault}`;

export function loadEnabled(vault: string): string[] {
  try {
    const raw = localStorage.getItem(enabledKey(vault));
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveEnabled(vault: string, ids: string[]): void {
  try {
    localStorage.setItem(enabledKey(vault), JSON.stringify([...new Set(ids)]));
  } catch {
    /* quota — non-fatal */
  }
}

// A plugin is enabled for the code the user agreed to run: its main.js hash is
// recorded on enable, and changed code (a sync peer replacing the file) stays
// off until the user turns it on again.
const hashesKey = (vault: string) => `basalt.plugins.hashes.${vault}`;

export async function codeHash(code: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const buf = await subtle.digest("SHA-256", new TextEncoder().encode(code));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // No WebCrypto (a plain-http page): FNV-1a plus length, enough to notice edits.
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) h = Math.imul(h ^ code.charCodeAt(i), 0x01000193) >>> 0;
  return `fnv-${h.toString(16)}-${code.length}`;
}

function loadHashes(vault: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(hashesKey(vault));
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveHashes(vault: string, hashes: Record<string, string>): void {
  try {
    localStorage.setItem(hashesKey(vault), JSON.stringify(hashes));
  } catch {
    /* quota, non-fatal */
  }
}

/** Record the code the user just enabled. */
export async function rememberPluginCode(vault: string, info: PluginInfo): Promise<void> {
  const hashes = loadHashes(vault);
  hashes[info.id] = await codeHash(info.code);
  saveHashes(vault, hashes);
}

/** Split the enabled plugins into those safe to run and those whose code
 * changed since they were enabled (which get switched off). A plugin enabled
 * before hashes were recorded is trusted once and recorded now. */
export async function vetEnabledPlugins(
  vault: string,
  infos: PluginInfo[],
): Promise<{ run: PluginInfo[]; changed: PluginInfo[] }> {
  const enabled = new Set(loadEnabled(vault));
  const hashes = loadHashes(vault);
  const run: PluginInfo[] = [];
  const changed: PluginInfo[] = [];
  for (const info of infos) {
    if (!enabled.has(info.id)) continue;
    const h = await codeHash(info.code);
    if (hashes[info.id] === undefined || hashes[info.id] === h) {
      hashes[info.id] = h;
      run.push(info);
    } else {
      changed.push(info);
      enabled.delete(info.id);
    }
  }
  saveHashes(vault, hashes);
  if (changed.length) saveEnabled(vault, [...enabled]);
  return { run, changed };
}

