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
async function holdSwitch(page: Page, from: string, to: { url: string; root: string }, delay: number, holdAfter: Record<string, number> = {}) {
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
    const resp = await one(() => route.fetch({ url: `${backend}/api/invoke` }));
    sent.push(`${body.cmd}@${backend === to.url ? "new" : "old"}`);
    return route.fulfill({ response: resp });
  });
  return sent;
}

const inert = (page: Page) => page.evaluate(() => document.querySelector("main.main")?.hasAttribute("inert") ?? null);

async function switchTo(page: Page, root: string, fromKeyboard = false) {
  if (fromKeyboard) await page.keyboard.press("ControlOrMeta+p");
  else await page.getByRole("button", { name: /Command palette/ }).click();
  await page.locator(".palette-input").first().fill("Switch vault");
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

test.describe("a plugin's daily note during a slow switch", () => {
  test.use({
    vaultFiles: {
      "Note X.md": "x\n",
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "XDaily" }),
      ".basalt/plugins/daily-now/main.js":
        'const { Plugin } = require("basalt"); module.exports = class extends Plugin { onload() { globalThis.__daily = () => this.app.dailyNotes.open(new Date()); } };',
      ".basalt/plugins/daily-now/manifest.json": JSON.stringify({ id: "daily-now", name: "Daily Now", version: "0.0.1" }),
    },
  });

  test("waits for the new vault, and is made with its settings", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault({ "Welcome A.md": "a\n", ".obsidian/daily-notes.json": JSON.stringify({ folder: "ADaily" }) });
    try {
      await holdSwitch(page, vault.url, a, 3000);
      await openApp(page, vault);
      await page.keyboard.press("ControlOrMeta+p");
      await page.locator(".palette-input").first().fill("Open settings");
      await page.keyboard.press("Enter");
      await page.locator(".plugin-row", { hasText: "Daily Now" }).locator('input[type="checkbox"]').click();
      await expect.poll(() => page.evaluate(() => typeof (globalThis as { __daily?: unknown }).__daily)).toBe("function");
      await page.keyboard.press("Escape");
      await switchTo(page, a.root);
      await page.waitForTimeout(400);
      await page.evaluate(() => void (globalThis as unknown as { __daily: () => Promise<void> }).__daily());
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await expect.poll(() => a.exists(`ADaily/${today}.md`), { timeout: 8000 }).toBe(true);
      expect(a.files().some((f) => f.startsWith("XDaily"))).toBe(false);
      expect(vault.exists(`XDaily/${today}.md`)).toBe(false);
    } finally {
      await a.stop();
    }
  });
});

test.describe("a plugin's daily note during two switches", () => {
  test.use({
    vaultFiles: {
      "Note X.md": "x\n",
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "XDaily" }),
      ".basalt/plugins/daily-now/main.js":
        'const { Plugin } = require("basalt"); module.exports = class extends Plugin { onload() { globalThis.__daily = () => this.app.dailyNotes.open(new Date()); } };',
      ".basalt/plugins/daily-now/manifest.json": JSON.stringify({ id: "daily-now", name: "Daily Now", version: "0.0.1" }),
    },
  });

  test("is made once the second has opened the vault", async ({ page, vault }) => {
    test.setTimeout(90000);
    const a = await otherVault({ "Welcome A.md": "a\n", ".obsidian/daily-notes.json": JSON.stringify({ folder: "ADaily" }) });
    try {
      await holdSwitch(page, vault.url, a, 2500);
      await openApp(page, vault);
      await page.keyboard.press("ControlOrMeta+p");
      await page.locator(".palette-input").first().fill("Open settings");
      await page.keyboard.press("Enter");
      await page.locator(".plugin-row", { hasText: "Daily Now" }).locator('input[type="checkbox"]').click();
      await expect.poll(() => page.evaluate(() => typeof (globalThis as { __daily?: unknown }).__daily)).toBe("function");
      await page.keyboard.press("Escape");
      await switchTo(page, a.root);
      await page.waitForTimeout(400);
      await page.evaluate(() => void (globalThis as unknown as { __daily: () => Promise<void> }).__daily());
      await switchTo(page, a.root, true);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await expect.poll(() => a.exists(`ADaily/${today}.md`), { timeout: 10000 }).toBe(true);
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
