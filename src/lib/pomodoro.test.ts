import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  installHost,
  loadPlugin,
  unloadAll,
  pluginCommands,
  pluginStatusBarItems,
  pluginSettingTabs,
  type HostDeps,
  type PluginInfo,
} from "./plugins";

// Load the actual shipped plugin source (single source of truth).
const code = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../plugins/pomodoro/main.js"), "utf8");

// Minimal DOM stub (vitest runs in node) — just what the plugin touches.
function stubEl(): Record<string, unknown> {
  return {
    className: "",
    textContent: "",
    title: "",
    type: "",
    min: "",
    value: "",
    style: {} as Record<string, string>,
    addEventListener() {},
    appendChild() {},
    replaceChildren() {},
    remove() {},
  };
}
vi.stubGlobal("document", { createElement: () => stubEl() });

function fakeHost(): HostDeps {
  return {
    getMarkdownFiles: () => [],
    readNote: async () => "",
    createNote: async () => {},
    modifyNote: async () => {},
    deleteNote: async () => {},
    renameNote: async () => {},
    createFolder: async () => {},
    getActiveNotePath: () => null,
    openNote: () => {},
    vaultName: () => "Vault",
    savePluginData: async () => {},
    notice: () => {},
    getFileCache: () => null,
    onRegistryChanged: () => {},
  };
}
const info = (): PluginInfo => ({ id: "pomodoro", name: "Pomodoro", version: "1.0.0", description: "", author: "", minAppVersion: "", code, data: null });
const runCmd = (id: string) => pluginCommands().find((c) => c.id === id)!.callback();

beforeEach(async () => {
  await unloadAll();
  installHost(fakeHost());
});

describe("pomodoro plugin", () => {
  it("registers a status-bar timer, three commands, and a settings tab", async () => {
    await loadPlugin(info());
    const items = pluginStatusBarItems();
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe("🍅 25:00 ⏸"); // paused, work phase
    expect(pluginCommands().map((c) => c.id).sort()).toEqual(["pomodoro:reset", "pomodoro:skip", "pomodoro:toggle"]);
    expect(pluginSettingTabs()).toHaveLength(1);
  });

  it("cycles work → break → work, toggles running, and resets", async () => {
    await loadPlugin(info());
    const el = pluginStatusBarItems()[0];
    runCmd("pomodoro:skip"); // work → short break
    expect(el.textContent).toBe("☕ 5:00 ⏸");
    runCmd("pomodoro:skip"); // break → work
    expect(el.textContent).toBe("🍅 25:00 ⏸");
    runCmd("pomodoro:toggle"); // start
    expect(el.textContent).toBe("🍅 25:00"); // no pause glyph while running
    runCmd("pomodoro:reset");
    expect(el.textContent).toBe("🍅 25:00 ⏸");
  });

  it("takes a long break after the configured number of work sessions", async () => {
    await loadPlugin(info());
    const el = pluginStatusBarItems()[0];
    // 4 work sessions (default cycles) → the 4th break is a long break.
    for (let i = 0; i < 3; i++) {
      runCmd("pomodoro:skip"); // work → short break
      runCmd("pomodoro:skip"); // break → work
    }
    runCmd("pomodoro:skip"); // 4th work → long break
    expect(el.textContent).toBe("☕ 15:00 ⏸");
  });
});
