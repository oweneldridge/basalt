import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openApp, openNote, ROOT } from "./fixture";

// A second vault on its own server, for a switch the test can hold.
async function otherVault(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "basalt-e2e-other-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  const port = await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, BASALT_PORT: String(port), BASALT_HOST: "127.0.0.1", BASALT_WEB_DIR: join(ROOT, "dist") };
  delete env.BASALT_AUTH;
  delete env.BASALT_VAULT;
  const proc = spawn(join(ROOT, "target/debug/basalt-server"), ["--vault", dir], { env, stdio: "ignore" });
  let root = "";
  for (let i = 0; i < 100 && !root; i++) {
    root = await fetch(`${url}/api/vault-root`).then(async (r) => (r.ok ? ((await r.json()) as { root: string }).root : "")).catch(() => "");
    if (!root) await new Promise((r) => setTimeout(r, 50));
  }
  return {
    url,
    root,
    files: () => readdirSync(dir, { recursive: true }).map(String).filter((p) => !p.startsWith(".")),
    exists: (rel: string) => existsSync(join(dir, rel)),
    stop: () =>
      new Promise<void>((res) => (proc.exitCode !== null ? res() : (proc.once("exit", () => res()), proc.kill()))).then(() =>
        rmSync(dir, { recursive: true, force: true }),
      ),
  };
}

const BAD = "/nonexistent/basalt-e2e-vault-B";

// Models the desktop core: its commands run one at a time, and opening the
// other vault takes `delay`; after it, every command goes to that vault.
// `holdAfter` slows a command once the other vault is open; BAD fails to open.
// `holdBefore` slows a command (by its args) while the old vault is still open.
async function holdSwitch(
  page: Page,
  from: string,
  to: { url: string; root: string },
  delay: number,
  holdAfter: Record<string, number> = {},
  holdBefore: (cmd: string, args: Record<string, unknown>) => number = () => 0,
) {
  let backend = from;
  let queue: Promise<unknown> = Promise.resolve();
  const one = <T,>(fn: () => Promise<T>) => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };
  const sent: string[] = [];
  await page.addInitScript(
    ([r, b]) =>
      localStorage.setItem(
        "basalt.recentVaults",
        JSON.stringify([
          { path: r, name: "A", ts: Date.now() },
          { path: b, name: "B", ts: Date.now() - 1000 },
        ]),
      ),
    [to.root, BAD],
  );
  await page.route("**/api/invoke", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (body.cmd === "open_vault" && body.args?.path === to.root) {
      await one(async () => {
        await new Promise((r) => setTimeout(r, delay));
        backend = to.url;
      });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: to.root }) });
    }
    if (body.cmd === "open_vault" && body.args?.path === BAD) {
      await one(async () => {});
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ error: "not a folder" }) });
    }
    const h = holdAfter[body.cmd];
    if (h && backend === to.url) await new Promise((r) => setTimeout(r, h));
    const resp = await one(async () => {
      const before = backend === from ? holdBefore(body.cmd, body.args ?? {}) : 0;
      if (before) await new Promise((r) => setTimeout(r, before));
      // A vault's server stops when its test ends, maybe with a call on the way.
      return route.fetch({ url: `${backend}/api/invoke` }).catch(() => null);
    });
    if (!resp) return;
    sent.push(`${body.cmd}@${backend === to.url ? "new" : "old"}`);
    return route.fulfill({ response: resp }).catch(() => {});
  });
  return sent;
}

const inert = (page: Page) => page.evaluate(() => document.querySelector("main.main")?.hasAttribute("inert") ?? null);

async function switchTo(page: Page, root: string, fromKeyboard = false) {
  if (fromKeyboard) await page.keyboard.press("ControlOrMeta+p");
  else await page.getByRole("button", { name: /Command palette/ }).click();
  await page.locator(".palette-input").first().fill("Switch vault");
  await expect(page.locator(".palette-item").first()).toContainText("Switch vault");
  await page.keyboard.press("Enter");
  await page.locator(".vault-item", { hasText: root }).first().click();
}

const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

test.describe("while a slow vault switch is under way", () => {
  test.use({
    vaultFiles: {
      "Note X.md": "x\n",
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "XDaily", template: "XTpl" }),
      "XTpl.md": "x template\n",
    },
  });

  test("the old vault's note takes no typing, and nothing is saved to or made in the new vault", async ({ page, vault }) => {
    test.setTimeout(60000);
    const a = await otherVault({ "Welcome A.md": "a\n" });
    try {
      const sent = await holdSwitch(page, vault.url, a, 3000);
      await openApp(page, vault);
      await openNote(page, "Note X");
      await page.waitForTimeout(800);
      await switchTo(page, a.root);
      await page.waitForTimeout(300);
      // Typing, and today's daily note from the keyboard, while A's open waits.
      await page.locator(".pane:not(.dock) .cm-content").first().click({ force: true }).catch(() => {});
      await page.keyboard.type("lost?");
      // The command palette still opens, to switch again, but offers nothing else.
      await page.keyboard.press("ControlOrMeta+p");
      await page.locator(".palette-input").first().fill("daily");
      await expect(page.getByText("No matching command")).toBeVisible();
      await page.locator(".palette-input").first().fill("vault");
      await expect(page.locator(".palette-item")).toHaveText([/Switch vault/]);
      await page.keyboard.press("Escape");
      // Other shortcuts wait: the quick switcher could make a note.
      await page.keyboard.press("ControlOrMeta+o");
      await page.waitForTimeout(200);
      await expect(page.locator(".palette-input")).toHaveCount(0);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1500);
      expect(vault.read("Note X.md")).toBe("x\n");
      expect(a.files().sort()).toEqual(["Welcome A.md"]);
      expect(a.exists(`XDaily/${today}.md`)).toBe(false);
      expect(sent.filter((s) => s.startsWith("write_note") || s.startsWith("create_note"))).toEqual([]);
      await expect(page.getByText(/Not saved|escapes/)).toHaveCount(0);
      // And the new vault takes typing again.
      await expect(page.locator("main.main")).not.toHaveAttribute("inert");
    } finally {
      await a.stop();
    }
  });
});

test.describe("two switches at once", () => {
  test.use({
    vaultFiles: {
      "Note X.md": "x\n",
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "XDaily", template: "XTpl" }),
      "XTpl.md": "x template\n",
    },
  });

  test("a second switch that fails leaves the first one held until it's open", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault({ "Welcome A.md": "a\n" });
    try {
      const sent = await holdSwitch(page, vault.url, a, 2500, { read_obsidian_config: 5000 });
      await openApp(page, vault);
      await openNote(page, "Note X");
      await page.waitForTimeout(800);
      await switchTo(page, a.root);
      await page.waitForTimeout(300);
      await switchTo(page, BAD, true);
      await page.waitForTimeout(3200); // B has failed; A is still loading
      expect(await inert(page)).toBe(true);
      await page.keyboard.press("ControlOrMeta+p");
      await page.locator(".palette-input").first().fill("daily");
      await expect(page.getByText("No matching command")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await expect(page.locator("main.main")).not.toHaveAttribute("inert");
      expect(a.files().sort()).toEqual(["Welcome A.md"]);
      expect(sent.filter((s) => s.startsWith("create_note") || s.startsWith("write_note"))).toEqual([]);
    } finally {
      await a.stop();
    }
  });

  test("a switch that a newer one overtakes doesn't end the newer one's hold", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault({ "Welcome A.md": "a\n" });
    try {
      await holdSwitch(page, vault.url, a, 2500, { read_obsidian_config: 4000 });
      await openApp(page, vault);
      await page.waitForTimeout(800);
      await switchTo(page, a.root);
      await page.waitForTimeout(400);
      await switchTo(page, a.root, true);
      await page.waitForTimeout(5600); // the first switch has given up; the second is loading
      expect(await inert(page)).toBe(true);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await expect(page.locator("main.main")).not.toHaveAttribute("inert");
    } finally {
      await a.stop();
    }
  });
});

test.describe("hotkeys during a slow switch", () => {
  test.use({ vaultFiles: { "Note X.md": "x\n", ".obsidian/daily-notes.json": JSON.stringify({ folder: "XDaily" }) } });

  for (const [name, keys, bindings] of [
    ["bare F-keys", ["F2", "F3"], { "daily-note": "f2", "new-note": "f3" }],
    ["an Option or Alt hotkey", ["Alt+n"], { "new-note": "alt+n" }],
    ["a Cmd-Shift-P hotkey", ["ControlOrMeta+Shift+p"], { "new-note": "mod+shift+p" }],
  ] as const) {
    test(`${name}: nothing is made in either vault`, async ({ page, vault }) => {
      test.setTimeout(90000);
      const a = await otherVault({ "Welcome A.md": "a\n" });
      try {
        await page.addInitScript((b) => localStorage.setItem("basalt-hotkeys", JSON.stringify(b)), bindings);
        const sent = await holdSwitch(page, vault.url, a, 3000);
        await openApp(page, vault);
        await page.waitForTimeout(800);
        await switchTo(page, a.root);
        await page.waitForTimeout(400);
        for (const k of keys) await page.keyboard.press(k);
        await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
        await page.waitForTimeout(2000);
        expect(a.files().sort()).toEqual(["Welcome A.md"]);
        expect(sent.filter((s) => s.startsWith("create_note"))).toEqual([]);
      } finally {
        await a.stop();
      }
    });
  }
});

test.describe("a canvas during a slow switch", () => {
  const board = {
    nodes: [
      { id: "a1", type: "text", text: "Card A", x: 0, y: 0, width: 200, height: 80 },
      { id: "b2", type: "text", text: "Card B", x: 300, y: 0, width: 200, height: 80 },
    ],
    edges: [],
  };
  test.use({ vaultFiles: { "Board.canvas": JSON.stringify(board, null, "\t"), "Note X.md": "x\n" } });

  test("Delete leaves the selected card, in both vaults", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault({ "Welcome A.md": "a\n" });
    try {
      const sent = await holdSwitch(page, vault.url, a, 3000);
      await openApp(page, vault);
      await page.locator(".tree-row.attachment", { hasText: "Board" }).first().click();
      await expect(page.locator(".canvas-node")).toHaveCount(2);
      await page.locator(".canvas-node", { hasText: "Card B" }).first().click();
      await page.waitForTimeout(300);
      await switchTo(page, a.root);
      await page.waitForTimeout(400);
      await page.keyboard.press("Delete");
      await page.keyboard.press("Backspace");
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1500);
      expect(JSON.parse(vault.read("Board.canvas")).nodes).toHaveLength(2);
      expect(sent.filter((s) => s.startsWith("write_canvas"))).toEqual([]);
    } finally {
      await a.stop();
    }
  });
});

test.describe("the ribbon during a slow switch", () => {
  test.use({ vaultFiles: { "Note X.md": "x\n" } });

  test("Quick switcher, Search, Graph and Settings wait; the command palette doesn't", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault({ "Welcome A.md": "a\n" });
    try {
      await holdSwitch(page, vault.url, a, 4000);
      await openApp(page, vault);
      await page.waitForTimeout(800);
      await switchTo(page, a.root);
      await page.waitForTimeout(400);
      for (const name of [/^Quick switcher/, /^Search/, /^Graph view/, /^Settings/]) {
        const button = page.getByRole("toolbar", { name: "Ribbon" }).getByRole("button", { name });
        await expect(button).toHaveAttribute("aria-disabled", "true");
        await button.click({ force: true }); // a click that ignores aria-disabled, as a mouse does
      }
      await page.waitForTimeout(300);
      await expect(page.locator(".palette-input")).toHaveCount(0);
      await expect(page.locator(".settings")).toHaveCount(0);
      await expect(page.locator(".graph-overlay, .graph-view")).toHaveCount(0);
      await page.getByRole("toolbar", { name: "Ribbon" }).getByRole("button", { name: /^Command palette/ }).click();
      await expect(page.locator(".palette-item")).toHaveText([/Switch vault/]);
      await page.keyboard.press("Escape");
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await expect(page.getByRole("toolbar", { name: "Ribbon" }).getByRole("button", { name: /^Search/ })).not.toHaveAttribute("aria-disabled");
    } finally {
      await a.stop();
    }
  });
});

const dailyNow = {
  ".basalt/plugins/daily-now/main.js":
    'const { Plugin } = require("basalt"); module.exports = class extends Plugin { onload() { globalThis.__daily = () => this.app.dailyNotes.open(new Date()); } };',
  ".basalt/plugins/daily-now/manifest.json": JSON.stringify({ id: "daily-now", name: "Daily Now", version: "0.0.1" }),
};

async function enablePlugin(page: Page, name: string, ready: string) {
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Open settings");
  await page.keyboard.press("Enter");
  await page.locator(".plugin-row", { hasText: name }).locator('input[type="checkbox"]').click();
  await expect.poll(() => page.evaluate((g) => typeof (globalThis as Record<string, unknown>)[g], ready)).not.toBe("undefined");
  await page.keyboard.press("Escape");
}

test.describe("the old vault's plugin asking for a daily note during a slow switch", () => {
  test.use({ vaultFiles: { "Note X.md": "x\n", ".obsidian/daily-notes.json": JSON.stringify({ folder: "XDaily" }), ...dailyNow } });

  test("makes none, in either vault", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault({ "Welcome A.md": "a\n", ".obsidian/daily-notes.json": JSON.stringify({ folder: "ADaily" }) });
    try {
      await holdSwitch(page, vault.url, a, 3000);
      await openApp(page, vault);
      await enablePlugin(page, "Daily Now", "__daily");
      await switchTo(page, a.root);
      await page.waitForTimeout(400);
      const asked = await page.evaluate(() => (globalThis as unknown as { __daily: () => Promise<void> }).__daily().then(() => "made", (e) => String(e)));
      expect(asked).toMatch(/unloaded/);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1500);
      expect(a.files().sort()).toEqual(["Welcome A.md"]);
      expect(vault.exists(`XDaily/${today}.md`)).toBe(false);
    } finally {
      await a.stop();
    }
  });
});

test.describe("the new vault's plugin asking for a daily note as it loads, during two switches", () => {
  test.use({ vaultFiles: { "Note X.md": "x\n", ".obsidian/daily-notes.json": JSON.stringify({ folder: "XDaily" }) } });

  test("has it made once the second has opened the vault, with its settings", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault({
      "Welcome A.md": "a\n",
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "ADaily" }),
      ".basalt/plugins/daily-load/main.js":
        'const { Plugin } = require("basalt"); module.exports = class extends Plugin { onload() { if (globalThis.__asked) return; globalThis.__asked = 1; this.app.dailyNotes.open(new Date()).then(() => (globalThis.__made = 1)); } };',
      ".basalt/plugins/daily-load/manifest.json": JSON.stringify({ id: "daily-load", name: "Daily Load", version: "0.0.1" }),
    });
    try {
      await page.addInitScript((r) => localStorage.setItem(`basalt.plugins.enabled.${r}`, JSON.stringify(["daily-load"])), a.root);
      const sent = await holdSwitch(page, vault.url, a, 1000, { read_vault: 3000 });
      await openApp(page, vault);
      await switchTo(page, a.root);
      // A's notes are still coming; its plugin has asked, and waits.
      await expect.poll(() => page.evaluate(() => (globalThis as { __asked?: number }).__asked), { timeout: 10000 }).toBe(1);
      expect(sent.filter((x) => x.startsWith("create_note"))).toEqual([]);
      await switchTo(page, a.root, true);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await expect.poll(() => a.exists(`ADaily/${today}.md`), { timeout: 10000 }).toBe(true);
      expect(vault.exists(`XDaily/${today}.md`)).toBe(false);
    } finally {
      await a.stop();
    }
  });
});

const maker = {
  ".basalt/plugins/maker/main.js":
    'const { Plugin } = require("basalt"); module.exports = class extends Plugin { onload() { globalThis.__make = () => this.app.vault.create("Plugin Made.md", "p"); globalThis.__folder = () => this.app.vault.createFolder("PluginFolder"); } async onunload() { await this.saveData({ from: "X" }); } };',
  ".basalt/plugins/maker/manifest.json": JSON.stringify({ id: "maker", name: "Maker", version: "0.0.1" }),
};

test.describe("the old vault's plugin during a switch", () => {
  test.use({ vaultFiles: { "Note X.md": "x\n", ...maker } });

  test("makes nothing in the new vault while it opens", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault({ "Welcome A.md": "a\n", ...maker });
    try {
      const sent = await holdSwitch(page, vault.url, a, 1500, { read_obsidian_config: 4000 });
      await openApp(page, vault);
      await enablePlugin(page, "Maker", "__make");
      await switchTo(page, a.root);
      await page.waitForTimeout(2500); // A has opened; its settings are slow
      expect(await inert(page)).toBe(true);
      const tried = await page.evaluate(() => {
        const g = globalThis as unknown as { __make: () => Promise<void>; __folder: () => Promise<void> };
        return Promise.all([g.__make(), g.__folder()].map((p) => p.then(() => "done", (e) => String(e))));
      });
      expect(tried).toEqual([expect.stringMatching(/unloaded/), expect.stringMatching(/unloaded/)]);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1500);
      expect(a.files().sort()).toEqual(["Welcome A.md"]);
      expect(vault.exists("Plugin Made.md")).toBe(false);
      expect(sent.filter((x) => /^(create_note|create_folder)@/.test(x))).toEqual([]);
    } finally {
      await a.stop();
    }
  });

  test("saves what it saves as it stops to its own vault", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault({ "Welcome A.md": "a\n", ...maker, ".basalt/plugins/maker/data.json": '{"from":"A"}' });
    try {
      const sent = await holdSwitch(page, vault.url, a, 0);
      await openApp(page, vault);
      await enablePlugin(page, "Maker", "__make");
      await switchTo(page, a.root);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1000);
      expect(JSON.parse(vault.read(".basalt/plugins/maker/data.json"))).toEqual({ from: "X" });
      const { readFileSync } = await import("node:fs");
      expect(JSON.parse(readFileSync(join(a.root, ".basalt/plugins/maker/data.json"), "utf8"))).toEqual({ from: "A" });
      expect(sent.filter((x) => x.startsWith("write_plugin_data"))).toEqual(["write_plugin_data@old"]);
    } finally {
      await a.stop();
    }
  });
});

const keyer = {
  ".basalt/plugins/keyer/main.js":
    'const { Plugin } = require("basalt"); module.exports = class extends Plugin { onload() { globalThis.__keyer = []; this.registerDomEvent(document, "keydown", (e) => { globalThis.__keyer.push("down:" + e.key); if (e.key === "F2") this.app.vault.create("F2 Made.md", "x"); }); this.registerDomEvent(window, "keyup", (e) => { globalThis.__keyer.push("up:" + e.key); if (e.key === "F4") this.app.vault.create("F4 Made.md", "x"); }); } };',
  ".basalt/plugins/keyer/manifest.json": JSON.stringify({ id: "keyer", name: "Keyer", version: "0.0.1" }),
};

test.describe("the old vault's plugin's own key listeners during a slow switch", () => {
  test.use({ vaultFiles: { "Note X.md": "x\n", ...keyer } });

  test("hear nothing, and make nothing", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault({ "Welcome A.md": "a\n" });
    try {
      const sent = await holdSwitch(page, vault.url, a, 3000);
      await openApp(page, vault);
      await enablePlugin(page, "Keyer", "__keyer");
      await switchTo(page, a.root);
      await page.waitForTimeout(300);
      expect(await inert(page)).toBe(true);
      await page.evaluate(() => ((globalThis as unknown as { __keyer: string[] }).__keyer.length = 0));
      await page.keyboard.press("F2");
      await page.keyboard.press("F4");
      expect(await page.evaluate(() => (globalThis as unknown as { __keyer: string[] }).__keyer)).toEqual([]);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1500);
      expect(a.files().sort()).toEqual(["Welcome A.md"]);
      expect(sent.filter((x) => x.startsWith("create_note"))).toEqual([]);
    } finally {
      await a.stop();
    }
  });
});

test.describe("a save that never answers", () => {
  test.use({ vaultFiles: { "Note X.md": "x\n" } });

  test("can't hold a switch: it asks, keeps the typing if told no, and goes on if told yes", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault({ "Welcome A.md": "a\n" });
    try {
      await holdSwitch(page, vault.url, a, 0);
      let hang = false;
      await page.route("**/api/invoke", async (route) => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        if (hang && body.cmd === "write_note") return; // never answers
        return route.fallback();
      });
      const asked: string[] = [];
      let answer = false;
      page.on("dialog", (d) => {
        asked.push(d.message());
        void (answer ? d.accept() : d.dismiss());
      });
      await openApp(page, vault);
      await openNote(page, "Note X");
      hang = true;
      await page.locator(".pane:not(.dock) .cm-content").first().click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type("y");
      await page.waitForTimeout(1500);
      await switchTo(page, a.root);
      expect(await inert(page)).toBe(true);
      await expect.poll(() => asked.length, { timeout: 10000 }).toBe(1);
      expect(asked[0]).toMatch(/Note X.*aren't saved/);
      await expect(page.locator("main.main")).not.toHaveAttribute("inert");
      await expect(page.locator(".pane:not(.dock) .cm-content").first()).toContainText("xy");
      answer = true;
      await switchTo(page, a.root);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      expect(asked).toHaveLength(2);
    } finally {
      await a.stop();
    }
  });
});

test.describe("typing just before a switch", () => {
  test.use({ vaultFiles: { "Note X.md": "x\n" } });

  test("is saved to the vault it was typed in", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault({ "Welcome A.md": "a\n" });
    try {
      await holdSwitch(page, vault.url, a, 1000);
      await openApp(page, vault);
      await openNote(page, "Note X");
      await page.locator(".pane:not(.dock) .cm-content").first().click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type("kept");
      await switchTo(page, a.root, true);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1000);
      expect(vault.read("Note X.md")).toContain("kept");
      expect(a.files().sort()).toEqual(["Welcome A.md"]);
    } finally {
      await a.stop();
    }
  });

  test("while a save is slow, asks nothing and saves it", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault({ "Welcome A.md": "a\n" });
    try {
      await holdSwitch(page, vault.url, a, 1000);
      await page.route("**/api/invoke", async (route) => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        if (body.cmd === "write_note") await new Promise((r) => setTimeout(r, 2500));
        return route.fallback();
      });
      const asked: string[] = [];
      page.on("dialog", (d) => {
        asked.push(d.message());
        void d.dismiss();
      });
      await openApp(page, vault);
      await openNote(page, "Note X");
      await page.locator(".pane:not(.dock) .cm-content").first().click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type("one");
      await page.waitForTimeout(700); // its save is out, and slow
      await page.keyboard.type("two");
      await switchTo(page, a.root, true);
      // Typing meanwhile, as the switch flushes.
      await page.keyboard.type("three");
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1000);
      expect(asked).toEqual([]);
      expect(vault.read("Note X.md")).toContain("onetwo");
      expect(a.files().sort()).toEqual(["Welcome A.md"]);
    } finally {
      await a.stop();
    }
  });
});

const slowBye = {
  ".basalt/plugins/slow/main.js": [
    'const { Plugin } = require("basalt");',
    "module.exports = class extends Plugin {",
    "  onload() {",
    "    globalThis.__slowLoaded = 1;",
    "    let n = 0;",
    '    this.registerInterval(() => { if (this.unloading) this.app.vault.create("Leak " + n++ + ".md", "leak").catch(() => {}); }, 150);',
    "  }",
    "  async onunload() { this.unloading = true; await new Promise((r) => setTimeout(r, 2500)); }",
    "};",
  ].join("\n"),
  ".basalt/plugins/slow/manifest.json": JSON.stringify({ id: "slow", name: "Slow Plugin", version: "0.0.1" }),
  ".basalt/plugins/dn/main.js":
    'const { Plugin } = require("basalt"); module.exports = class extends Plugin { onload() { globalThis.__dnLoaded = 1; } async onunload() { this.app.dailyNotes.open(new Date()).catch(() => {}); } };',
  ".basalt/plugins/dn/manifest.json": JSON.stringify({ id: "dn", name: "DN Plugin", version: "0.0.1" }),
};

test.describe("a plugin stopping as a switch starts", () => {
  test.use({ vaultFiles: { "Note X.md": "x\n", ".obsidian/daily-notes.json": JSON.stringify({ folder: "XDaily" }), ...slowBye } });

  test("turned off just before it, writes nothing into the new vault", async ({ page, vault }) => {
    test.setTimeout(60000);
    const a = await otherVault({ "Welcome A.md": "a\n" });
    try {
      await holdSwitch(page, vault.url, a, 200);
      await openApp(page, vault);
      await enablePlugin(page, "Slow Plugin", "__slowLoaded");
      await page.keyboard.press("ControlOrMeta+p");
      await page.locator(".palette-input").first().fill("Open settings");
      await page.keyboard.press("Enter");
      await page.locator(".plugin-row", { hasText: "Slow Plugin" }).locator('input[type="checkbox"]').click(); // off; it's slow to stop
      await page.keyboard.press("Escape");
      await switchTo(page, a.root, true);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(3000);
      expect(a.files()).toEqual(["Welcome A.md"]);
      expect(vault.exists("Leak 0.md")).toBe(true);
    } finally {
      await a.stop();
    }
  });

  test("asking for today's daily note as it stops, has it made in neither vault", async ({ page, vault }) => {
    test.setTimeout(60000);
    const a = await otherVault({ "Welcome A.md": "a\n" });
    try {
      await holdSwitch(page, vault.url, a, 200);
      await openApp(page, vault);
      await enablePlugin(page, "DN Plugin", "__dnLoaded");
      await switchTo(page, a.root, true);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1500);
      expect(a.files()).toEqual(["Welcome A.md"]);
      expect(vault.exists(`XDaily/${today}.md`)).toBe(false);
    } finally {
      await a.stop();
    }
  });
});

const linking = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`Src ${i}.md`, `see [[Target]] ${i}\n`]));
const mentioning = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`Src ${i}.md`, `Target ${i}\n`]));
const srcPath = (args: Record<string, unknown>) => /\/Src \d+\.md$/.test(String(args.path ?? ""));
// The old vault's link fixes (all of them, or from the `from`th on) each take
// `ms`; the `hang`th takes 6 s, longer than a switch waits for one.
const slowFixes = (ms: number, hang = -1) => {
  let n = 0;
  return (cmd: string, args: Record<string, unknown>) => (cmd === "write_note" && srcPath(args) ? (n++ === hang ? 6000 : ms) : 0);
};

async function renameTarget(page: Page) {
  await page.locator(".tree-row.file", { hasText: "Target" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".prompt-input").fill("Renamed");
  await page.locator(".prompt-input").press("Enter");
}

async function linkAllTarget(page: Page) {
  await openNote(page, "Target");
  await page.locator(".pane.dock .tab.view-tab", { hasText: "Backlinks" }).click();
  const unlinked = page.locator(".panel-section").nth(1);
  await expect(unlinked.locator(".ref-group")).toHaveCount(16);
  await unlinked.locator(".link-all-btn").click();
}

for (const [what, files, start, fixed] of [
  ["a rename", linking, renameTarget, (t: string) => t.includes("[[Renamed]]")],
  ["Link all", mentioning, linkAllTarget, (t: string) => t.includes("[[Target]]")],
] as const) {
  test.describe(`${what} under way when a switch starts`, () => {
    test.use({ vaultFiles: { "Target.md": "t\n", ...files } });
    const sources = Object.keys(files);

    for (const [how, ms] of [
      ["", 150],
      [", even one slower than a switch waits for a save,", 450],
    ] as const) {
      test(`finishes in the old vault first${how} and leaves the new one alone`, async ({ page, vault }) => {
        test.setTimeout(90000);
        const a = await otherVault({ "Welcome A.md": "a\n", ...files });
        try {
          const sent = await holdSwitch(page, vault.url, a, 0, {}, slowFixes(ms));
          await openApp(page, vault);
          await start(page);
          await expect.poll(() => sent.filter((x) => x === "write_note@old").length).toBeGreaterThan(0);
          await switchTo(page, a.root, true);
          await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 30000 });
          expect(sources.filter((f) => !fixed(vault.read(f)))).toEqual([]);
          const { readFileSync } = await import("node:fs");
          expect(sources.filter((f) => readFileSync(join(a.root, f), "utf8") !== files[f as keyof typeof files])).toEqual([]);
          expect(sent.filter((x) => x === "write_note@new")).toEqual([]);
        } finally {
          await a.stop();
        }
      });
    }

    test("goes on in the old vault when a switch that stopped waiting for it fails", async ({ page, vault }) => {
      test.setTimeout(90000);
      await holdSwitch(page, vault.url, { url: vault.url, root: "/unused" }, 0, {}, slowFixes(50, 3));
      await openApp(page, vault);
      await start(page);
      await expect.poll(() => sources.filter((f) => fixed(vault.read(f))).length, { timeout: 10000 }).toBe(3);
      await switchTo(page, BAD, true);
      await expect.poll(() => sources.filter((f) => !fixed(vault.read(f))), { timeout: 30000 }).toEqual([]);
    });

    test("stops once the switch has stopped waiting for it, asking nothing of the new vault", async ({ page, vault }) => {
      test.setTimeout(90000);
      const a = await otherVault({ "Welcome A.md": "a\n", ...files });
      try {
        await holdSwitch(page, vault.url, a, 0, {}, slowFixes(50, 0));
        // In the order they reach the core, which runs them one at a time.
        const asked: string[] = [];
        await page.route("**/api/invoke", (route) => {
          const body = JSON.parse(route.request().postData() ?? "{}");
          asked.push(`${body.cmd}:${String(body.args?.path ?? "")}`);
          return route.fallback();
        });
        await openApp(page, vault);
        await start(page);
        await expect.poll(() => asked.filter((x) => x.startsWith("write_note:")).length).toBeGreaterThan(0);
        await switchTo(page, a.root, true);
        await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(3000); // the slow fix has answered
        const later = asked.slice(asked.indexOf(`open_vault:${a.root}`));
        expect(later.filter((x) => x.includes(vault.dir))).toEqual([]);
        await expect(page.getByRole("alert")).toHaveText("");
        await expect(page.locator(".notice")).toHaveCount(0);
      } finally {
        await a.stop();
      }
    });
  });
}

test.describe("a Link under way when a switch starts", () => {
  test.use({ vaultFiles: { "Target.md": "t\n", "Src 0.md": "Target here\n" } });

  test("finishes in the old vault first", async ({ page, vault }) => {
    test.setTimeout(60000);
    const a = await otherVault({ "Welcome A.md": "a\n", "Src 0.md": "Target here\n" });
    try {
      const sent = await holdSwitch(page, vault.url, a, 0, {}, (cmd, args) => (cmd === "read_note" && srcPath(args) ? 1000 : 0));
      await openApp(page, vault);
      await openNote(page, "Target");
      await page.locator(".pane.dock .tab.view-tab", { hasText: "Backlinks" }).click();
      await page.locator(".panel-section").nth(1).locator(".ref-link-btn").first().click();
      await switchTo(page, a.root, true);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1000);
      expect(vault.read("Src 0.md")).toBe("[[Target]] here\n");
      expect(sent.filter((x) => x === "write_note@new")).toEqual([]);
      await expect(page.getByRole("alert")).toHaveText("");
    } finally {
      await a.stop();
    }
  });
});

test.describe("a folder move a switch gives up on", () => {
  test.use({ vaultFiles: { "Shared/Roadmap.md": "road\n", "Solo.md": "solo\n" } });
  const files = { "Shared/Plan.md": "plan\n", "Hub.md": "see [[Shared/Plan]]\n" };

  async function moveShared(page: Page) {
    await page.locator(".tree-row.folder", { hasText: "Shared" }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: /Rename/ }).first().click();
    await page.locator(".prompt-input").fill("Moved");
    await page.locator(".prompt-input").press("Enter");
  }

  test("held by a save that stops answering, moves nothing in the next vault", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault(files);
    try {
      let slow = false;
      await holdSwitch(page, vault.url, a, 0, {}, (cmd) => (slow && cmd === "write_note" ? 7000 : 0));
      page.on("dialog", (d) => void d.accept());
      await openApp(page, vault);
      await page.locator(".tree-row.folder", { hasText: "Shared" }).first().click();
      await openNote(page, "Roadmap");
      slow = true;
      await page.locator(".pane:not(.dock) .cm-content").first().click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type("typed");
      await page.waitForTimeout(900); // its save is out, and slow
      await moveShared(page);
      await switchTo(page, a.root, true);
      await expect(page.locator(".tree-row.file", { hasText: "Hub" })).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(4000); // the save has answered
      expect(a.files().sort()).toEqual(["Hub.md", "Shared", "Shared/Plan.md"]);
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(join(a.root, "Hub.md"), "utf8")).toBe(files["Hub.md"]);
      await expect(page.getByRole("alert")).toHaveText("");
      await expect(page.locator(".notice")).toHaveCount(0);
    } finally {
      await a.stop();
    }
  });

  test("queued behind a slow note rename, moves nothing in the next vault and asks nothing", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault(files);
    try {
      let slow = false;
      await holdSwitch(page, vault.url, a, 0, {}, (cmd) => (slow && cmd === "rename_note" ? 6000 : 0));
      const asked: string[] = [];
      page.on("dialog", (d) => (asked.push(d.message()), void d.accept()));
      await openApp(page, vault);
      slow = true;
      await page.locator(".tree-row.file", { hasText: "Solo" }).first().click({ button: "right" });
      await page.locator(".ctx-item", { hasText: "Rename…" }).click();
      await page.locator(".prompt-input").fill("Solo2");
      await page.locator(".prompt-input").press("Enter");
      await moveShared(page);
      await switchTo(page, a.root, true);
      await expect(page.locator(".tree-row.file", { hasText: "Hub" })).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(3000);
      expect(a.files().sort()).toEqual(["Hub.md", "Shared", "Shared/Plan.md"]);
      expect(asked).toEqual([]);
      expect(vault.exists("Shared/Roadmap.md")).toBe(true);
      await expect(page.getByRole("alert")).toHaveText("");
      await expect(page.locator(".notice")).toHaveCount(0);
    } finally {
      await a.stop();
    }
  });
});

const hearer = {
  ".basalt/plugins/hearer/main.js":
    'const { Plugin } = require("basalt"); module.exports = class extends Plugin { onload() { globalThis.__heard = []; this.registerEvent(this.app.vault.on("rename", (f, old) => globalThis.__heard.push(old + ">" + f.path))); this.registerEvent(this.app.vault.on("create", (f) => globalThis.__heard.push("+" + f.path))); } };',
  ".basalt/plugins/hearer/manifest.json": JSON.stringify({ id: "hearer", name: "Hearer", version: "0.0.1" }),
};

for (const [what, cmd, row, to] of [
  ["note rename", "rename_note", ".tree-row.file", "Solo2"],
  ["folder move", "rename_folder", ".tree-row.folder", "Moved"],
] as const) {
  test.describe(`a ${what} whose answer comes after the next vault opened`, () => {
    test.use({ vaultFiles: { "Solo.md": "solo\n", "Hub.md": "see [[Solo]]\n", "Shared/Roadmap.md": "road\n" } });

    test("tells that vault's plugins nothing, and shows or fixes nothing there", async ({ page, vault }) => {
      test.setTimeout(90000);
      const a = await otherVault({ "Welcome A.md": "a\n", "Solo.md": "theirs\n", "Hub.md": "see [[Solo]]\n", ...hearer });
      try {
        const sent = await holdSwitch(page, vault.url, a, 0);
        await page.addInitScript((r) => localStorage.setItem(`basalt.plugins.enabled.${r}`, JSON.stringify(["hearer"])), a.root);
        // Done in the old vault at once; its answer is slow to come back.
        await page.route("**/api/invoke", async (route) => {
          const body = JSON.parse(route.request().postData() ?? "{}");
          if (body.cmd !== cmd) return route.fallback();
          const resp = await route.fetch({ url: `${vault.url}/api/invoke` }).catch(() => null);
          if (!resp) return;
          await new Promise((r) => setTimeout(r, 8000));
          return route.fulfill({ response: resp });
        });
        await openApp(page, vault);
        const from = { rename_note: "Solo", rename_folder: "Shared" }[cmd];
        await page.locator(row, { hasText: from }).first().click({ button: "right" });
        await page.locator(".ctx-item", { hasText: /Rename/ }).first().click();
        await page.locator(".prompt-input").fill(to);
        await page.locator(".prompt-input").press("Enter");
        await expect.poll(() => vault.exists({ rename_note: "Solo2.md", rename_folder: "Moved/Roadmap.md" }[cmd])).toBe(true);
        await switchTo(page, a.root, true);
        await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 30000 });
        await expect.poll(() => page.evaluate(() => Array.isArray((globalThis as { __heard?: string[] }).__heard))).toBe(true);
        // Every file tree row shown from here on.
        await page.evaluate(() => {
          const seen = new Set<string>();
          (window as unknown as { __rows: Set<string> }).__rows = seen;
          new MutationObserver(() => document.querySelectorAll(".tree-row").forEach((r) => seen.add(r.textContent ?? ""))).observe(document.body, { childList: true, subtree: true, characterData: true });
        });
        await page.waitForTimeout(6000); // the rename has answered
        expect(await page.evaluate(() => (globalThis as { __heard?: string[] }).__heard)).toEqual([]);
        expect(await page.evaluate((t) => [...(window as unknown as { __rows: Set<string> }).__rows].filter((r) => r.includes(t)), to)).toEqual([]);
        await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible();
        expect(sent.filter((x) => x === "write_note@new")).toEqual([]);
        await expect(page.locator(".notice")).toHaveCount(0);
      } finally {
        await a.stop();
      }
    });
  });
}

for (const [what, files, start] of [
  ["a rename", { "Target.md": "t\n", ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`Src ${i}.md`, `see [[Target]] ${i}\n`])) }, renameTarget],
  [
    "a folder move",
    { "Box/Target.md": "t\n", ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`Src ${i}.md`, `see [[Box/Target]] ${i}\n`])) },
    async (page: Page) => {
      await page.locator(".tree-row.folder", { hasText: "Box" }).first().click({ button: "right" });
      await page.locator(".ctx-item", { hasText: /Rename/ }).first().click();
      await page.locator(".prompt-input").fill("Crate");
      await page.locator(".prompt-input").press("Enter");
    },
  ],
  [
    "a file rename",
    { "pic.png": "x", ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`Src ${i}.md`, `see ![[pic.png]] ${i}\n`])) },
    async (page: Page) => {
      await page.locator(".tree-row.attachment", { hasText: "pic" }).first().click({ button: "right" });
      await page.locator(".ctx-item", { hasText: "Rename…" }).click();
      await page.locator(".prompt-input").fill("pic2");
      await page.locator(".prompt-input").press("Enter");
    },
  ],
] as const) {
  test.describe(`${what} whose link fix fails after a switch gave up on it`, () => {
    test.use({ vaultFiles: files });

    test("says nothing about it in the next vault", async ({ page, vault }) => {
      test.setTimeout(90000);
      const a = await otherVault({ "Welcome A.md": "a\n" });
      try {
        await holdSwitch(page, vault.url, a, 0);
        let first = true;
        await page.route("**/api/invoke", async (route) => {
          const body = JSON.parse(route.request().postData() ?? "{}");
          if (body.cmd !== "write_note" || !srcPath(body.args ?? {}) || !first) return route.fallback();
          first = false;
          await new Promise((r) => setTimeout(r, 6000));
          return route.fulfill({ contentType: "application/json", body: JSON.stringify({ error: "disk busy" }) });
        });
        await openApp(page, vault);
        await start(page);
        await expect.poll(() => first).toBe(false);
        await switchTo(page, a.root, true);
        await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(3000); // the fix has failed
        await expect(page.locator(".notice")).toHaveCount(0);
        await expect(page.getByRole("alert")).toHaveText("");
      } finally {
        await a.stop();
      }
    });

    test("reports it when that switch fails", async ({ page, vault }) => {
      test.setTimeout(90000);
      await holdSwitch(page, vault.url, { url: vault.url, root: "/unused" }, 0);
      let first = true;
      await page.route("**/api/invoke", async (route) => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        // The vault that fails takes a while to say so.
        if (body.cmd === "open_vault" && body.args?.path === BAD) await new Promise((r) => setTimeout(r, 6000));
        if (body.cmd !== "write_note" || !srcPath(body.args ?? {}) || !first) return route.fallback();
        first = false;
        await new Promise((r) => setTimeout(r, 8000));
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ error: "disk busy" }) });
      });
      await openApp(page, vault);
      await start(page);
      await expect.poll(() => first).toBe(false);
      await switchTo(page, BAD, true);
      await expect(page.locator(".notice")).toContainText("links weren't updated in: Src", { timeout: 20000 });
    });
  });
}

test.describe("a Link that stops answering", () => {
  test.use({ vaultFiles: { "Target.md": "t\n", "Src 0.md": "Target here\n" } });

  test("does nothing in the next vault, and says nothing there", async ({ page, vault }) => {
    test.setTimeout(60000);
    const a = await otherVault({ "Welcome A.md": "a\n", "Src 0.md": "Target here\n" });
    try {
      await holdSwitch(page, vault.url, a, 0, {}, (cmd, args) => (cmd === "read_note" && srcPath(args) ? 7000 : 0));
      const asked: string[] = [];
      await page.route("**/api/invoke", (route) => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        asked.push(`${body.cmd}:${String(body.args?.path ?? "")}`);
        return route.fallback();
      });
      await openApp(page, vault);
      await openNote(page, "Target");
      await page.locator(".pane.dock .tab.view-tab", { hasText: "Backlinks" }).click();
      await page.locator(".panel-section").nth(1).locator(".ref-link-btn").first().click();
      await switchTo(page, a.root, true);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(5000); // the read has answered
      const later = asked.slice(asked.indexOf(`open_vault:${a.root}`));
      expect(later.filter((x) => x.includes(vault.dir))).toEqual([]);
      expect(vault.read("Src 0.md")).toBe("Target here\n");
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(join(a.root, "Src 0.md"), "utf8")).toBe("Target here\n");
      await expect(page.getByRole("alert")).toHaveText("");
    } finally {
      await a.stop();
    }
  });

  // Its write is sent in the old vault and fails a while later.
  async function failingWrite(page: Page, ms: number) {
    let sent = false;
    await page.route("**/api/invoke", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (body.cmd !== "write_note" || !srcPath(body.args ?? {})) return route.fallback();
      sent = true;
      await new Promise((r) => setTimeout(r, ms));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ error: "disk busy" }) });
    });
    return () => sent;
  }
  async function linkOne(page: Page) {
    await openNote(page, "Target");
    await page.locator(".pane.dock .tab.view-tab", { hasText: "Backlinks" }).click();
    await page.locator(".panel-section").nth(1).locator(".ref-link-btn").first().click();
  }

  test("whose write fails once the switch gave up on it says nothing in the next vault", async ({ page, vault }) => {
    test.setTimeout(60000);
    const a = await otherVault({ "Welcome A.md": "a\n" });
    try {
      await holdSwitch(page, vault.url, a, 0);
      const sent = await failingWrite(page, 6000);
      await openApp(page, vault);
      await linkOne(page);
      await expect.poll(sent).toBe(true);
      await switchTo(page, a.root, true);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(3000); // the write has failed
      await expect(page.getByRole("alert")).toHaveText("");
    } finally {
      await a.stop();
    }
  });

  test("whose read answers while a switch that gave up on it fails links it", async ({ page, vault }) => {
    test.setTimeout(60000);
    await holdSwitch(page, vault.url, { url: vault.url, root: "/unused" }, 0);
    let sent = false;
    await page.route("**/api/invoke", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (body.cmd === "open_vault" && body.args?.path === BAD) await new Promise((r) => setTimeout(r, 6000));
      if (body.cmd !== "read_note" || !srcPath(body.args ?? {}) || sent) return route.fallback();
      sent = true;
      const resp = await route.fetch({ url: `${vault.url}/api/invoke` }).catch(() => null);
          if (!resp) return;
      await new Promise((r) => setTimeout(r, 7000));
      return route.fulfill({ response: resp });
    });
    await openApp(page, vault);
    await linkOne(page);
    await expect.poll(() => sent).toBe(true);
    await switchTo(page, BAD, true);
    await expect.poll(() => vault.read("Src 0.md"), { timeout: 20000 }).toBe("[[Target]] here\n");
  });
});

// Every file tree the page shows from here on, as its rows' text.
async function watchTree(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __trees: string[][] };
    w.__trees = [];
    new MutationObserver(() => w.__trees.push([...document.querySelectorAll(".tree-row")].map((r) => r.textContent ?? ""))).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  return () => page.evaluate(() => (window as unknown as { __trees: string[][] }).__trees);
}

for (const [what, cmd, act, shown] of [
  [
    "a copy",
    "create_note",
    async (page: Page) => {
      await page.locator(".tree-row.file", { hasText: "Solo" }).first().click({ button: "right" });
      await page.locator(".ctx-item", { hasText: "Make a copy" }).click();
    },
    (tree: string[]) => !tree.some((r) => r.includes("Solo copy")),
  ],
  [
    "a folder delete",
    "delete_folder",
    async (page: Page) => {
      await page.locator(".tree-row.folder", { hasText: "Shared" }).first().click({ button: "right" });
      await page.locator(".ctx-item", { hasText: "Delete folder" }).click();
    },
    (tree: string[]) => tree.some((r) => r.includes("Shared")),
  ],
  [
    "a pasted image",
    "write_attachment",
    async (page: Page) => {
      await openNote(page, "Solo");
      await page.locator(".pane:not(.dock) .cm-content").first().click();
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(["png"], "shot.png", { type: "image/png" }));
        document.querySelector(".pane:not(.dock) .cm-content")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      });
    },
    (tree: string[]) => !tree.some((r) => r.includes("shot")),
  ],
] as const) {
  test.describe(`${what} whose answer comes after the next vault opened`, () => {
    test.use({ vaultFiles: { "Solo.md": "solo\n", "Shared/Roadmap.md": "road\n" } });

    test("shows and tells that vault nothing", async ({ page, vault }) => {
      test.setTimeout(90000);
      const a = await otherVault({ "Welcome A.md": "a\n", "Shared/Plan.md": "plan\n", ...hearer });
      try {
        await holdSwitch(page, vault.url, a, 0);
        await page.addInitScript((r) => localStorage.setItem(`basalt.plugins.enabled.${r}`, JSON.stringify(["hearer"])), a.root);
        page.on("dialog", (d) => void d.accept());
        let sent = false;
        // Done in the old vault at once; its answer is slow to come back.
        await page.route("**/api/invoke", async (route) => {
          const body = JSON.parse(route.request().postData() ?? "{}");
          if (body.cmd !== cmd) return route.fallback();
          sent = true;
          const resp = await route.fetch({ url: `${vault.url}/api/invoke` }).catch(() => null);
          if (!resp) return;
          await new Promise((r) => setTimeout(r, 8000));
          return route.fulfill({ response: resp });
        });
        await openApp(page, vault);
        await act(page);
        await expect.poll(() => sent).toBe(true);
        await switchTo(page, a.root, true);
        await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 30000 });
        await expect.poll(() => page.evaluate(() => Array.isArray((globalThis as { __heard?: string[] }).__heard))).toBe(true);
        const trees = await watchTree(page);
        await page.waitForTimeout(9000); // it has answered
        expect((await trees()).filter((t) => !shown(t))).toEqual([]);
        await expect(page.locator(".tree-row.folder", { hasText: "Shared" })).toHaveCount(1);
        expect(await page.evaluate(() => (globalThis as { __heard?: string[] }).__heard)).toEqual([]);
        expect(a.exists("Shared/Plan.md")).toBe(true);
        await expect(page.getByRole("alert")).toHaveText("");
      } finally {
        await a.stop();
      }
    });
  });
}
