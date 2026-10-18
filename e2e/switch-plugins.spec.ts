import { test, expect, type Page } from "@playwright/test";

type W = { __log: string[]; __at: string; __mockHook: (cmd: string, a: Record<string, unknown>) => unknown };
const plugin = (id: string, code: string) => ({ id, name: id, version: "1", description: "", author: "", minAppVersion: "", data: null, code });
const g = (page: Page, key: string) => page.evaluate((k) => (globalThis as unknown as Record<string, unknown>)[k], key);
const log = (page: Page) => page.evaluate(() => (window as unknown as W).__log);

// Vaults /mock/vault (the mock's own), /mock/b and /mock/c; `plugins` are each
// vault's, and every note made or plugin data saved is logged as "vault:cmd:name"
// (data as "vault:write_plugin_data:id:its from", when it says where it's from).
async function setup(page: Page, plugins: Record<string, object[]>, enabled: Record<string, string[]>, slow: Record<string, number> = {}) {
  await page.addInitScript(
    ([ps, en, sl]) => {
      localStorage.setItem("basalt.recentVaults", JSON.stringify(["b", "c", "vault"].map((n, i) => ({ path: `/mock/${n}`, name: n, ts: Date.now() - i }))));
      for (const [v, ids] of Object.entries(en)) localStorage.setItem(`basalt.plugins.enabled./mock/${v}`, JSON.stringify(ids));
      const w = window as unknown as W;
      w.__log = [];
      w.__at = "vault";
      const after = (ms: number, v: unknown) => new Promise((r) => setTimeout(() => r({ result: v }), ms));
      w.__mockHook = (cmd, a) => {
        const from = cmd === "write_plugin_data" ? (JSON.parse(String(a.data)) as { from?: string }).from : undefined;
        if (cmd === "create_note" || cmd === "write_plugin_data") w.__log.push(`${w.__at}:${cmd}:${String(a.name ?? a.id ?? "")}${from ? `:${from}` : ""}`);
        if (cmd === "create_note") return { result: `/mock/${w.__at}/${String(a.name)}.md` };
        if (cmd === "list_plugins") return { result: ps[w.__at] ?? [] };
        if (cmd === "open_vault") return after(sl[`open:${String(a.path)}`] ?? 0, a.path).then((r) => ((w.__at = String(a.path).split("/").pop()!), r));
        if (cmd === "read_obsidian_config" && sl[`config:${w.__at}`]) return after(sl[`config:${w.__at}`], {});
        if (w.__at === "vault") return;
        if (cmd === "read_vault") return after(sl[`read:${w.__at}`] ?? 0, []);
        if (cmd === "list_attachments" || cmd === "list_folders") return { result: [] };
      };
    },
    [plugins, enabled, slow] as const,
  );
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
}

async function pick(page: Page, root: string) {
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Switch vault");
  await page.locator(".palette-item", { hasText: "Switch vault" }).first().click();
  await page.locator(".vault-item", { hasText: root }).first().click();
}
const opened = (page: Page) => expect(page.locator("main.main")).not.toHaveAttribute("inert", { timeout: 15000 });

// Counts its loads and live copies per vault, and while `__go` is set makes a
// note and saves its data every 100 ms.
const counter = [
  'const { Plugin } = require("basalt");',
  "module.exports = class extends Plugin {",
  "  onload() {",
  "    const g = globalThis; const mine = (this.mine = this.app.vault.getName());",
  "    g.__loads = g.__loads || {}; g.__loads[mine] = (g.__loads[mine] || 0) + 1;",
  "    g.__live = g.__live || {}; g.__live[mine] = (g.__live[mine] || 0) + 1;",
  "    this.addRibbonIcon('R', 'Ribbon ' + mine, () => {});",
  "    let n = 0;",
  "    this.registerInterval(() => { if (!g.__go) return; this.app.vault.create(mine + ' ' + n++, mine).catch(() => {}); this.saveData({ from: mine, n }).catch(() => {}); }, 100);",
  "  }",
  "  onunload() { globalThis.__live[this.mine]--; }",
  "};",
].join("\n");

test("a plugin turned off just before a switch writes nothing into the new vault", async ({ page }) => {
  const slow = [
    'const { Plugin } = require("basalt");',
    "module.exports = class extends Plugin {",
    "  onload() {",
    "    let n = 0;",
    "    this.registerInterval(() => {",
    "      if (!this.unloading) return;",
    '      this.app.vault.create("Leak " + n++, "leak").catch(() => {});',
    "      this.saveData({ n }).catch(() => {});",
    "    }, 150);",
    "  }",
    "  async onunload() { this.unloading = true; await new Promise((r) => setTimeout(r, 2500)); }",
    "};",
  ].join("\n");
  await setup(page, { vault: [plugin("slow", slow)] }, { vault: ["slow"] });
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Open settings");
  await page.keyboard.press("Enter");
  const box = page.locator(".plugin-row", { hasText: "slow" }).locator('input[type="checkbox"]');
  await expect(box).toBeChecked();
  await box.click(); // off: its onunload takes a while
  await page.keyboard.press("Escape");
  await pick(page, "/mock/b");
  await opened(page);
  await page.waitForTimeout(3000);
  const writes = await log(page);
  // It went on writing as it stopped, in its own vault.
  expect(writes).toContainEqual("vault:create_note:Leak 0");
  expect(writes.filter((l) => !l.startsWith("vault:"))).toEqual([]);
});

const dailyAsker = (onload: string, onunload: string) =>
  `const { Plugin } = require("basalt"); module.exports = class extends Plugin { onload() { ${onload} } async onunload() { ${onunload} } };`;
const askDaily = "this.app.dailyNotes.open(new Date()).then(() => (globalThis.__daily = 'made'), (e) => (globalThis.__daily = String(e)));";

test("a daily note an old vault's plugin asks for as it stops is made in neither vault", async ({ page }) => {
  await setup(page, { vault: [plugin("dn", dailyAsker("", askDaily))] }, { vault: ["dn"] });
  await page.waitForTimeout(300);
  await pick(page, "/mock/b");
  await opened(page);
  await expect.poll(() => g(page, "__daily")).toMatch(/another vault/);
  expect((await log(page)).filter((l) => l.includes("create_note"))).toEqual([]);
});

test("a daily note one plugin asks for while another is slow to stop is made in neither vault", async ({ page }) => {
  const timer = "this.registerInterval(() => { if (globalThis.__ask) { globalThis.__ask = false; " + askDaily + " } }, 50);";
  await setup(page, { vault: [plugin("aslow", dailyAsker("", "await new Promise((r) => setTimeout(r, 1500));")), plugin("btimer", dailyAsker(timer, ""))] }, { vault: ["aslow", "btimer"] });
  await page.waitForTimeout(300);
  await pick(page, "/mock/b");
  await page.evaluate(() => ((globalThis as unknown as { __ask: boolean }).__ask = true));
  await opened(page);
  await expect.poll(() => g(page, "__daily")).toMatch(/another vault/);
  expect((await log(page)).filter((l) => l.includes("create_note"))).toEqual([]);
});

test("a plugin whose onload a switch cuts off leaves nothing in the next vault", async ({ page }) => {
  const late = dailyAsker(
    "return (async () => { globalThis.__late = 1; await new Promise((r) => setTimeout(r, 1500)); this.addCommand({ id: 'x', name: 'Leaky late command', callback: () => {} }); this.addRibbonIcon('L', 'Leaky ribbon', () => {}); this.registerInterval(() => { globalThis.__ticks = (globalThis.__ticks || 0) + 1; }, 100); })();",
    "",
  );
  await setup(page, { vault: [plugin("late", late)] }, { vault: ["late"] }, { "open:/mock/b": 300 });
  await expect.poll(() => g(page, "__late")).toBe(1);
  await pick(page, "/mock/b");
  await opened(page);
  await page.waitForTimeout(1800);
  expect(await g(page, "__ticks")).toBeUndefined();
  await expect(page.locator(".ribbon-plugin-btn")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Leaky late");
  await expect(page.getByText("No matching command")).toBeVisible();
});

test("a vault's plugins load once at startup and once at each switch", async ({ page }) => {
  await setup(page, { vault: [plugin("p", counter)], b: [plugin("p", counter)] }, { vault: ["p"], b: ["p"] });
  await expect.poll(() => g(page, "__loads")).toEqual({ vault: 1 });
  await page.waitForTimeout(500);
  await pick(page, "/mock/b");
  await opened(page);
  await expect(page.locator(".ribbon-plugin-btn")).toHaveCount(1);
  await page.waitForTimeout(500);
  expect(await g(page, "__loads")).toEqual({ vault: 1, b: 1 });
  expect(await g(page, "__live")).toEqual({ vault: 0, b: 1 });
});

test("a vault left by a newer switch while it opens never loads its plugins", async ({ page }) => {
  const all = { vault: [plugin("p", counter)], b: [plugin("p", counter)], c: [plugin("p", counter)] };
  await setup(page, all, { b: ["p"], c: ["p"] }, { "open:/mock/b": 300, "config:b": 1200, "open:/mock/c": 1500 });
  await pick(page, "/mock/b");
  await page.waitForTimeout(700); // B is open; its settings are slow
  await pick(page, "/mock/c");
  await opened(page);
  await expect(page.locator(".ribbon-plugin-btn")).toHaveCount(1);
  await page.waitForTimeout(500);
  expect(await g(page, "__loads")).toEqual({ c: 1 });
});

for (const [first, second] of [
  [200, 200],
  [700, 700],
  [1100, 300],
] as const) {
  test(`switching A to B to C and back to A (${first}, ${second} ms apart) leaves A's plugin alone, writing to A`, async ({ page }) => {
    test.setTimeout(60000);
    const all = { vault: [plugin("p", counter)], b: [plugin("p", counter)], c: [plugin("p", counter)] };
    const slow = { "open:/mock/b": 500, "open:/mock/c": 500, "open:/mock/vault": 500, "read:b": 800, "read:c": 800 };
    await setup(page, all, { vault: ["p"], b: ["p"], c: ["p"] }, slow);
    await page.evaluate(() => ((globalThis as unknown as { __go: boolean }).__go = true));
    await expect.poll(() => g(page, "__loads")).toEqual({ vault: 1 });
    await pick(page, "/mock/b");
    await page.waitForTimeout(first);
    await pick(page, "/mock/c");
    await page.waitForTimeout(second);
    await pick(page, "/mock/vault");
    await opened(page);
    await page.waitForTimeout(1000);
    // Each in the vault of the plugin that wrote it.
    const writes = await log(page);
    const from = (l: string) => (l.includes(":create_note:") ? l.split(":")[2].split(" ")[0] : l.split(":")[3]);
    expect(writes.filter((l) => l.split(":")[0] !== from(l))).toEqual([]);
    expect(writes).toContainEqual(expect.stringMatching(/^vault:create_note:vault /));
    const live = (await g(page, "__live")) as Record<string, number>;
    expect(Object.entries(live).filter(([, n]) => n !== 0)).toEqual([["vault", 1]]);
    await expect(page.locator(".ribbon-plugin-btn")).toHaveCount(1);
  });
}
