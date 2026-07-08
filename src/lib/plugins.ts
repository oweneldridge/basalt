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

/** The concrete capabilities App wires into the host. Keeping the host UI- and
 * Tauri-agnostic makes it unit-testable and keeps the trust surface explicit. */
export interface HostDeps {
  getMarkdownFiles: () => { path: string; name: string }[];
  readNote: (path: string) => Promise<string>;
  createNote: (path: string, content: string) => Promise<void>;
  modifyNote: (path: string, content: string) => Promise<void>;
  getActiveNotePath: () => string | null;
  openNote: (target: string) => void;
  vaultName: () => string;
  savePluginData: (id: string, json: string) => Promise<void>;
  notice: (message: string, timeoutMs?: number) => void;
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
const RESERVED_LANGS = new Set(["mermaid", "dataview", "query", "basalt-query"]);

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

  const app = {
    vault: {
      getName: () => host.vaultName(),
      getMarkdownFiles: () => host.getMarkdownFiles(),
      read: (file: { path: string } | string) =>
        host.readNote(typeof file === "string" ? file : file.path),
      create: (path: string, content: string) => host.createNote(path, content),
      modify: (file: { path: string } | string, content: string) =>
        host.modifyNote(typeof file === "string" ? file : file.path, content),
      /** Subscribe to a vault event: create/delete/modify → (file); rename →
       * (file, oldPath). Pass the returned ref to plugin.registerEvent(). */
      on: (name: VaultEventName, cb: (...args: unknown[]) => void): EventRef =>
        subscribe(vaultListeners, name, cb),
    },
    workspace: {
      getActiveFile: () => {
        const p = host.getActiveNotePath();
        return p ? { path: p } : null;
      },
      openLinkText: (target: string) => host.openNote(target),
      /** Subscribe to a workspace event: file-open → (file|null);
       * active-leaf-change → (file|null). */
      on: (name: WorkspaceEventName, cb: (...args: unknown[]) => void): EventRef =>
        subscribe(workspaceListeners, name, cb),
    },
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
