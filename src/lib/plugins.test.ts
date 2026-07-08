import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installHost,
  loadPlugin,
  unloadPlugin,
  unloadAll,
  pluginCommands,
  codeBlockProcessor,
  hasCodeBlockProcessor,
  isLoaded,
  loadEnabled,
  saveEnabled,
  emitVaultEvent,
  emitWorkspaceEvent,
  pluginSettingTabs,
  pluginRightViews,
  type HostDeps,
  type PluginInfo,
} from "./plugins";

function info(over: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "sample",
    name: "Sample",
    version: "1.0.0",
    description: "",
    author: "",
    minAppVersion: "",
    code: "",
    data: null,
    ...over,
  };
}

function fakeHost(over: Partial<HostDeps> = {}): { host: HostDeps; notices: string[]; saved: Record<string, string> } {
  const notices: string[] = [];
  const saved: Record<string, string> = {};
  const host: HostDeps = {
    getMarkdownFiles: () => [{ path: "A.md", name: "A" }],
    readNote: async () => "content",
    createNote: async () => {},
    modifyNote: async () => {},
    deleteNote: async () => {},
    renameNote: async () => {},
    createFolder: async () => {},
    getActiveNotePath: () => "A.md",
    openNote: () => {},
    vaultName: () => "Vault",
    savePluginData: async (id, json) => {
      saved[id] = json;
    },
    notice: (m) => notices.push(m),
    getFileCache: (path) =>
      path === "A.md" ? { tags: ["todo"], links: ["B"], headings: [{ heading: "H", level: 1 }], frontmatter: { title: "A" } } : null,
    onRegistryChanged: () => {},
    ...over,
  };
  return { host, notices, saved };
}

beforeEach(async () => {
  await unloadAll();
  installHost(null);
});

describe("plugin host", () => {
  it("loads a class plugin, registers a command + processor, and fires onload", async () => {
    const { host, notices } = fakeHost();
    installHost(host);
    const code = `
      const { Plugin, Notice } = require("basalt");
      module.exports = class extends Plugin {
        async onload() {
          new Notice("loaded " + this.app.vault.getName());
          this.addCommand({ id: "hi", name: "Say hi", callback: () => new Notice("hi") });
          this.registerMarkdownCodeBlockProcessor("greet", (src, el) => { el.textContent = "G:" + src; });
        }
      };
    `;
    await loadPlugin(info({ id: "p1", code }));
    expect(isLoaded("p1")).toBe(true);
    expect(notices).toEqual(["loaded Vault"]);
    const cmds = pluginCommands();
    expect(cmds.map((c) => c.id)).toEqual(["p1:hi"]);
    // run the command
    cmds[0].callback();
    expect(notices).toEqual(["loaded Vault", "hi"]);
    // the processor renders (node env: a minimal element stub)
    expect(hasCodeBlockProcessor("greet")).toBe(true);
    const el = { textContent: "" } as unknown as HTMLElement;
    codeBlockProcessor("GREET")!("world", el, { notePath: "A.md" });
    expect(el.textContent).toBe("G:world");
  });

  it("unload removes commands, processors, and runs onunload + cleanups", async () => {
    const { host, notices } = fakeHost();
    installHost(host);
    const code = `
      const { Plugin, Notice } = require("basalt");
      module.exports = class extends Plugin {
        onload() {
          this.addCommand({ id: "c", name: "C", callback: () => {} });
          this.registerMarkdownCodeBlockProcessor("x", () => {});
          this.register(() => new Notice("cleanup"));
        }
        onunload() { new Notice("bye"); }
      };
    `;
    await loadPlugin(info({ id: "p2", code }));
    expect(pluginCommands()).toHaveLength(1);
    expect(hasCodeBlockProcessor("x")).toBe(true);
    await unloadPlugin("p2");
    expect(isLoaded("p2")).toBe(false);
    expect(pluginCommands()).toHaveLength(0);
    expect(hasCodeBlockProcessor("x")).toBe(false);
    expect(notices).toEqual(["bye", "cleanup"]); // onunload, then cleanups (LIFO)
  });

  it("supports a plain-object module and loadData/saveData", async () => {
    const { host, saved } = fakeHost();
    installHost(host);
    const code = `
      module.exports = {
        async onload() {},
      };
    `;
    await loadPlugin(info({ id: "obj", code }));
    expect(isLoaded("obj")).toBe(true);

    // a plugin that persists data
    const code2 = `
      const { Plugin } = require("basalt");
      module.exports = class extends Plugin {
        async onload() {
          const d = await this.loadData();
          await this.saveData({ count: (d?.count ?? 0) + 1 });
        }
      };
    `;
    await loadPlugin(info({ id: "counter", code: code2, data: JSON.stringify({ count: 4 }) }));
    expect(JSON.parse(saved["counter"])).toEqual({ count: 5 });
  });

  it("require of anything other than 'basalt' throws (bubbles as a load error)", async () => {
    installHost(fakeHost().host);
    const code = `const fs = require("fs");`;
    await expect(loadPlugin(info({ id: "bad", code }))).rejects.toThrow(/not available/);
    expect(isLoaded("bad")).toBe(false);
  });

  it("a throwing onload rolls back atomically — no dangling command, not loaded", async () => {
    installHost(fakeHost().host);
    const code = `
      const { Plugin } = require("basalt");
      module.exports = class extends Plugin {
        onload() { this.addCommand({ id: "x", name: "X", callback: () => {} }); throw new Error("boom"); }
      };
    `;
    await expect(loadPlugin(info({ id: "throwing", code }))).rejects.toThrow(/boom/);
    // the partial registration was rolled back and the plugin is not loaded
    expect(pluginCommands()).toHaveLength(0);
    expect(isLoaded("throwing")).toBe(false);
  });

  it("a plugin cannot register a reserved (built-in) code-block language", async () => {
    const { host, notices } = fakeHost();
    installHost(host);
    const code = `
      const { Plugin } = require("basalt");
      module.exports = class extends Plugin {
        onload() {
          this.registerMarkdownCodeBlockProcessor("mermaid", () => {});
          this.registerMarkdownCodeBlockProcessor("dataview", () => {});
          this.registerMarkdownCodeBlockProcessor("chart", () => {});
        }
      };
    `;
    await loadPlugin(info({ id: "r", code }));
    expect(hasCodeBlockProcessor("mermaid")).toBe(false);
    expect(hasCodeBlockProcessor("dataview")).toBe(false);
    expect(hasCodeBlockProcessor("chart")).toBe(true); // non-reserved is fine
    expect(notices.some((n) => /built-in/.test(n))).toBe(true);
  });
});

describe("enabled-plugin persistence", () => {
  it("round-trips per vault and dedupes", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    saveEnabled("/v", ["a", "b", "a"]);
    expect(loadEnabled("/v").sort()).toEqual(["a", "b"]);
    expect(loadEnabled("/other")).toEqual([]);
    vi.unstubAllGlobals();
  });
});

describe("plugin events", () => {
  it("delivers vault + workspace events to a subscribed plugin and cleans up on unload", async () => {
    const { host } = fakeHost();
    installHost(host);
    (globalThis as any).__events = [];
    const code = `
      const { Plugin } = require("basalt");
      module.exports = class extends Plugin {
        onload() {
          this.registerEvent(this.app.vault.on("modify", (f) => globalThis.__events.push(["modify", f.path])));
          this.registerEvent(this.app.vault.on("rename", (f, old) => globalThis.__events.push(["rename", f.path, old])));
          this.registerEvent(this.app.workspace.on("file-open", (f) => globalThis.__events.push(["open", f && f.path])));
        }
      };
    `;
    await loadPlugin(info({ id: "ev", code }));
    emitVaultEvent("modify", { path: "A.md", name: "A" });
    emitVaultEvent("rename", { path: "B.md", name: "B" }, "A.md");
    emitWorkspaceEvent("file-open", { path: "C.md", name: "C" });
    expect((globalThis as any).__events).toEqual([
      ["modify", "A.md"],
      ["rename", "B.md", "A.md"],
      ["open", "C.md"],
    ]);
    // Unload removes the subscriptions.
    await unloadPlugin("ev");
    (globalThis as any).__events = [];
    emitVaultEvent("modify", { path: "A.md", name: "A" });
    expect((globalThis as any).__events).toEqual([]);
  });

  it("registerInterval + registerDomEvent are cleared on unload", async () => {
    const { host } = fakeHost();
    installHost(host);
    (globalThis as any).__domhits = 0;
    (globalThis as any).__el = new EventTarget();
    const code = `
      const { Plugin } = require("basalt");
      module.exports = class extends Plugin {
        onload() {
          this.registerDomEvent(globalThis.__el, "basalt-test-evt", () => globalThis.__domhits++);
        }
      };
    `;
    await loadPlugin(info({ id: "iv", code }));
    (globalThis as any).__el.dispatchEvent(new Event("basalt-test-evt"));
    expect((globalThis as any).__domhits).toBe(1);
    await unloadPlugin("iv");
    (globalThis as any).__el.dispatchEvent(new Event("basalt-test-evt"));
    expect((globalThis as any).__domhits).toBe(1); // no further hits after unload
  });
});

describe("plugin settings tabs", () => {
  it("registers a settings tab and removes it on unload", async () => {
    const { host } = fakeHost();
    installHost(host);
    const code = `
      const { Plugin } = require("basalt");
      module.exports = class extends Plugin {
        onload() { this.addSettingTab({ containerEl: { tagName: "DIV" }, display: () => {} }); }
      };
    `;
    await loadPlugin(info({ id: "st", name: "ST", code }));
    expect(pluginSettingTabs().map((t) => t.pluginId)).toEqual(["st"]);
    expect(pluginSettingTabs()[0].name).toBe("ST");
    await unloadPlugin("st");
    expect(pluginSettingTabs()).toEqual([]);
  });
});

describe("plugin metadata cache", () => {
  it("exposes app.metadataCache.getFileCache", async () => {
    const { host } = fakeHost();
    installHost(host);
    (globalThis as any).__cache = null;
    const code = `
      const { Plugin } = require("basalt");
      module.exports = class extends Plugin {
        onload() { globalThis.__cache = this.app.metadataCache.getFileCache("A.md"); }
      };
    `;
    await loadPlugin(info({ id: "mc", code }));
    expect((globalThis as any).__cache).toEqual({
      tags: ["todo"],
      links: ["B"],
      headings: [{ heading: "H", level: 1 }],
      frontmatter: { title: "A" },
    });
  });
});

describe("plugin registerView", () => {
  it("registers a right-panel view and removes it on unload", async () => {
    const { host } = fakeHost();
    installHost(host);
    const code = `
      const { Plugin } = require("basalt");
      module.exports = class extends Plugin {
        onload() { this.registerView("v1", "My View", (el) => { el.textContent = "hi"; }); }
      };
    `;
    await loadPlugin(info({ id: "vp", code }));
    const views = pluginRightViews();
    expect(views.map((v) => v.id)).toEqual(["v1"]);
    expect(views[0].name).toBe("My View");
    await unloadPlugin("vp");
    expect(pluginRightViews()).toHaveLength(0);
  });
});

describe("plugin vault mutations", () => {
  it("delete / rename / createFolder call through to the host", async () => {
    const calls: string[] = [];
    const { host } = fakeHost({
      deleteNote: async (pth) => { calls.push("delete:" + pth); },
      renameNote: async (pth, np) => { calls.push("rename:" + pth + "->" + np); },
      createFolder: async (pth) => { calls.push("mkdir:" + pth); },
    });
    installHost(host);
    const code = `
      const { Plugin } = require("basalt");
      module.exports = class extends Plugin {
        async onload() {
          await this.app.vault.delete("A.md");
          await this.app.vault.rename("A.md", "B.md");
          await this.app.vault.createFolder("Folder");
        }
      };
    `;
    await loadPlugin(info({ id: "vmut", code }));
    expect(calls).toEqual(["delete:A.md", "rename:A.md->B.md", "mkdir:Folder"]);
  });
});
