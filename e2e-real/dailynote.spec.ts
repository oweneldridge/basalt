import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, expect, openApp, openNote, settle, ROOT } from "./fixture";

// Obsidian's "Default file to open: Daily note" (openBehavior in app.json).
const d = new Date();
const pad = (n: number) => String(n).padStart(2, "0");
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const activeTab = (page: import("@playwright/test").Page) => page.locator(".pane:not(.dock) .tab.active .tab-name").first();

// Turns a plugin on in Settings (opening them again if a busy page missed it).
const enable = async (page: import("@playwright/test").Page, name: string) => {
  const box = page.locator(".plugin-row", { hasText: name }).locator('input[type="checkbox"]');
  await expect(async () => {
    if (!(await box.isVisible())) {
      await page.keyboard.press("ControlOrMeta+p");
      await page.locator(".palette-input").first().fill("Open settings");
      await page.keyboard.press("Enter");
    }
    await expect(box).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
  await box.click(); // it follows the plugin as it loads
  await expect(box).toBeChecked();
  await page.keyboard.press("Escape");
};

test.describe("a vault that opens its daily note", () => {
  test.use({
    vaultFiles: {
      ".obsidian/app.json": JSON.stringify({ openBehavior: "daily" }),
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", template: "Templates/Daily" }),
      "Templates/Daily.md": "## Log\n",
    },
  });

  test("opens today's note at startup, made from the template", async ({ page, vault }) => {
    await openApp(page, vault);
    await expect(activeTab(page)).toHaveText(today);
    await expect.poll(() => vault.exists(`Daily/${today}.md`)).toBe(true);
    await expect.poll(() => vault.read(`Daily/${today}.md`)).toBe("## Log\n");
  });
});

test.describe("a vault that opens its daily note, which exists", () => {
  test.use({
    vaultFiles: {
      ".obsidian/app.json": JSON.stringify({ openBehavior: "daily" }),
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", template: "Templates/Daily" }),
      "Templates/Daily.md": "## Log\n",
      [`Daily/${today}.md`]: "Written on the phone\n",
    },
  });

  test("opens it as it is", async ({ page, vault }) => {
    await openApp(page, vault);
    await expect(activeTab(page)).toHaveText(today);
    await expect(page.locator(".pane:not(.dock) .cm-content").first()).toContainText("Written on the phone");
    await settle(page, 1500);
    expect(vault.read(`Daily/${today}.md`)).toBe("Written on the phone\n");
  });
});

test.describe("a vault that opens its daily note, with Daily notes off", () => {
  test.use({
    vaultFiles: {
      ".obsidian/app.json": JSON.stringify({ openBehavior: "daily" }),
      ".obsidian/core-plugins.json": JSON.stringify({ "daily-notes": false }),
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily" }),
    },
  });

  test("makes no note", async ({ page, vault }) => {
    await openApp(page, vault);
    await settle(page, 2000);
    expect(vault.exists(`Daily/${today}.md`)).toBe(false);
  });
});

test.describe("a vault that opens its daily note from a Templater template", () => {
  test.use({
    vaultFiles: {
      ".obsidian/app.json": JSON.stringify({ openBehavior: "daily" }),
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", template: "Templates/Daily" }),
      ".obsidian/plugins/templater-obsidian/data.json": JSON.stringify({ trigger_on_file_creation: true }),
      "Templates/Daily.md": "created: <% tp.file.creation_date() %>\n",
    },
  });

  test("makes no note when nothing here runs Templater, and says why", async ({ page, vault }) => {
    await openApp(page, vault);
    await expect(page.locator(".notice")).toContainText("Templater Lite isn't on");
    await settle(page, 1500);
    expect(vault.exists(`Daily/${today}.md`)).toBe(false);
  });

  test("says why once a session, and tries again on a reload", async ({ page, vault }) => {
    await openApp(page, vault);
    await expect(page.locator(".notice")).toContainText("Templater");
    await page.reload();
    await settle(page, 2000);
    await expect(page.locator(".notice", { hasText: "daily note wasn't made" })).toHaveCount(0);
    expect(vault.exists(`Daily/${today}.md`)).toBe(false);
  });
});

test.describe("a vault that opens its daily note, with no template file", () => {
  test.use({
    vaultFiles: {
      ".obsidian/app.json": JSON.stringify({ openBehavior: "daily" }),
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", template: "Templates/Gone" }),
    },
  });

  test("makes the note empty and says the template is missing", async ({ page, vault }) => {
    await openApp(page, vault);
    await expect(activeTab(page)).toHaveText(today);
    await expect(page.locator(".notice")).toContainText("Templates/Gone");
    expect(vault.read(`Daily/${today}.md`)).toBe("");
  });
});

test.describe("a vault that opens its daily note, in a format Basalt can't write", () => {
  test.use({
    vaultFiles: {
      ".obsidian/app.json": JSON.stringify({ openBehavior: "daily" }),
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", format: "YYYY-DDDD" }),
    },
  });

  test("says which name it used", async ({ page, vault }) => {
    await openApp(page, vault);
    await expect(page.locator(".notice, .status-error").first()).toContainText("used YYYY-MM-DD");
  });
});

test.describe("a vault that opens its daily note, open twice", () => {
  test.use({
    vaultFiles: {
      ".obsidian/app.json": JSON.stringify({ openBehavior: "daily" }),
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", template: "Templates/Daily" }),
      "Templates/Daily.md": "## Log\n",
    },
  });

  test("two pages opening at once both show the one note", async ({ page, context, vault }) => {
    const other = await context.newPage();
    await Promise.all([openApp(page, vault), openApp(other, vault)]);
    for (const p of [page, other]) {
      await expect(activeTab(p)).toHaveText(today);
      await expect(p.locator(".status-error")).toHaveCount(0);
    }
    expect(vault.read(`Daily/${today}.md`)).toBe("## Log\n");
  });

  test("a reload stays on the note you were on", async ({ page, vault }) => {
    await openApp(page, vault);
    await expect(activeTab(page)).toHaveText(today);
    await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
    await expect(activeTab(page)).toHaveText("Ideas");
    await page.reload();
    await expect(page.locator(".sidebar")).toBeVisible();
    await settle(page, 1500);
    await expect(activeTab(page)).toHaveText("Ideas");
  });
});

const templater = join(ROOT, "plugins", "templater-lite");

test.describe("a vault that opens its daily note, with Templater Lite to fill it", () => {
  test.use({
    vaultFiles: {
      ".obsidian/app.json": JSON.stringify({ openBehavior: "daily" }),
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", template: "Templates/Daily" }),
      ".obsidian/plugins/templater-obsidian/data.json": JSON.stringify({ trigger_on_file_creation: true }),
      "Templates/Daily.md": "title: <% tp.file.title %>\n",
      ".basalt/plugins/templater-lite/main.js": readFileSync(join(templater, "main.js"), "utf8"),
      ".basalt/plugins/templater-lite/manifest.json": readFileSync(join(templater, "manifest.json"), "utf8"),
    },
  });

  test("makes the note with its tags filled once Templater Lite is on", async ({ page, vault }) => {
    await openApp(page, vault);
    await expect(page.locator(".notice")).toContainText("Templater");
    await enable(page, "Templater Lite");
    expect(vault.exists(`Daily/${today}.md`)).toBe(false);
    // Nothing was opened, so a reload tries again, with Templater Lite on now.
    await page.reload();
    await expect(activeTab(page)).toHaveText(today);
    await expect.poll(() => vault.read(`Daily/${today}.md`)).toBe(`title: ${today}\n`);
  });
});

test.describe("a vault that opens its daily note from a Templater template, with the trigger off", () => {
  test.use({
    vaultFiles: {
      ".obsidian/app.json": JSON.stringify({ openBehavior: "daily" }),
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", template: "Templates/Daily" }),
      ".obsidian/plugins/templater-obsidian/data.json": JSON.stringify({ trigger_on_file_creation: false }),
      "Templates/Daily.md": "title: <% tp.file.title %>\n",
      ".basalt/plugins/templater-lite/main.js": readFileSync(join(templater, "main.js"), "utf8"),
      ".basalt/plugins/templater-lite/manifest.json": readFileSync(join(templater, "manifest.json"), "utf8"),
    },
  });

  test("says the trigger is off, and makes no note", async ({ page, vault }) => {
    await openApp(page, vault);
    await enable(page, "Templater Lite");
    const next = await page.context().newPage();
    await openApp(next, vault);
    await expect(next.locator(".notice")).toContainText("Trigger Templater on new file creation");
    await settle(next, 1000);
    expect(vault.exists(`Daily/${today}.md`)).toBe(false);
  });
});

test.describe("a vault that opens its daily note from a Templater template, with an old Templater Lite", () => {
  test.use({
    vaultFiles: {
      ".obsidian/app.json": JSON.stringify({ openBehavior: "daily" }),
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", template: "Templates/Daily" }),
      ".obsidian/plugins/templater-obsidian/data.json": JSON.stringify({ trigger_on_file_creation: true }),
      "Templates/Daily.md": "title: <% tp.file.title %>\n",
      // A copy that loads but never listens for new notes.
      ".basalt/plugins/templater-lite/main.js": 'const { Plugin } = require("basalt"); module.exports = class extends Plugin {};',
      ".basalt/plugins/templater-lite/manifest.json": JSON.stringify({ id: "templater-lite", name: "Templater Lite", version: "0.0.1" }),
    },
  });

  test("says to update it, and makes no note", async ({ page, vault }) => {
    await openApp(page, vault);
    await enable(page, "Templater Lite");
    const next = await page.context().newPage();
    await openApp(next, vault);
    await expect(next.locator(".notice")).toContainText("update it");
    await settle(next, 1000);
    expect(vault.exists(`Daily/${today}.md`)).toBe(false);
  });
});

test.describe("a vault that opens its daily note from a Templater template, with slow plugins", () => {
  test.use({
    vaultFiles: {
      ".obsidian/app.json": JSON.stringify({ openBehavior: "daily" }),
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", template: "Templates/Daily" }),
      ".obsidian/plugins/templater-obsidian/data.json": JSON.stringify({ trigger_on_file_creation: true }),
      "Templates/Daily.md": "title: <% tp.file.title %>\n",
      "Other.md": "elsewhere\n",
      // Loads in three seconds, so the daily note waits for it.
      ".basalt/plugins/slow/main.js":
        'const { Plugin } = require("basalt"); module.exports = class extends Plugin { async onload() { await new Promise((r) => setTimeout(r, 3000)); } };',
      ".basalt/plugins/slow/manifest.json": JSON.stringify({ id: "slow", name: "Slow", version: "0.0.1" }),
      ".basalt/plugins/templater-lite/main.js": readFileSync(join(templater, "main.js"), "utf8"),
      ".basalt/plugins/templater-lite/manifest.json": readFileSync(join(templater, "manifest.json"), "utf8"),
    },
  });

  test("leaves you on a note you opened while it waited", async ({ page, vault }) => {
    await openApp(page, vault);
    await enable(page, "Templater Lite");
    await enable(page, "Slow");
    const next = await page.context().newPage();
    await openApp(next, vault);
    await openNote(next, "Other");
    await settle(next, 4500);
    await expect(next.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Other");
    expect(vault.exists(`Daily/${today}.md`)).toBe(false);
  });
});

const slowPlugin = (ms: number, id: string, name: string) => ({
  [`.basalt/plugins/${id}/main.js`]: `const { Plugin } = require("basalt"); module.exports = class extends Plugin { async onload() { await new Promise((r) => setTimeout(r, ${ms})); } };`,
  [`.basalt/plugins/${id}/manifest.json`]: JSON.stringify({ id, name, version: "0.0.1" }),
});
const templaterDaily = {
  ".obsidian/app.json": JSON.stringify({ openBehavior: "daily" }),
  ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", template: "Templates/Daily" }),
  ".obsidian/plugins/templater-obsidian/data.json": JSON.stringify({ trigger_on_file_creation: true }),
  "Templates/Daily.md": "title: <% tp.file.title %>\n",
  ".basalt/plugins/templater-lite/main.js": readFileSync(join(templater, "main.js"), "utf8"),
  ".basalt/plugins/templater-lite/manifest.json": readFileSync(join(templater, "manifest.json"), "utf8"),
};

test.describe("a vault that opens its daily note from a Templater template, while it waits", () => {
  test.use({ vaultFiles: { ...templaterDaily, ...slowPlugin(3000, "zz-slow", "Zz Slow") } });

  // A reload with Ideas open, while the daily note waits for Zz Slow.
  async function reloadOnIdeas(page: import("@playwright/test").Page, vault: Parameters<typeof openApp>[1]) {
    await openApp(page, vault);
    await enable(page, "Templater Lite");
    await enable(page, "Zz Slow");
    await openNote(page, "Ideas");
    await settle(page, 1200);
    await page.close();
    const next = await page.context().newPage();
    await openApp(next, vault);
    await expect(activeTab(next)).toHaveText("Ideas");
    return next;
  }

  test("still opens it after a click in the file tree or a side panel", async ({ page, vault }) => {
    test.setTimeout(60000);
    const next = await reloadOnIdeas(page, vault);
    await next.locator(".tree-row", { hasText: "Projects" }).first().click();
    await next.locator(".pane.dock-right .tab.view-tab", { hasText: "Outline" }).click();
    await expect(activeTab(next)).toHaveText(today, { timeout: 10000 });
    expect(vault.read(`Daily/${today}.md`)).toBe(`title: ${today}\n`);
  });

  test("leaves you typing in the note you're on", async ({ page, vault }) => {
    test.setTimeout(60000);
    const next = await reloadOnIdeas(page, vault);
    await next.locator(".pane:not(.dock) .cm-content").first().click();
    await next.keyboard.press("ControlOrMeta+End");
    for (const w of ["one", "two", "three", "four", "five", "six", "seven", "eight"]) {
      await next.keyboard.type(w + " ", { delay: 30 });
      await next.waitForTimeout(400);
    }
    await settle(next, 1500);
    await expect(activeTab(next)).toHaveText("Ideas");
    expect(vault.read("Ideas.md")).toContain("one two three four five six seven eight");
    expect(vault.exists(`Daily/${today}.md`)).toBe(false);
  });
});

test.describe("a vault that opens its daily note from a Templater template, behind a plugin that never loads", () => {
  test.use({
    vaultFiles: {
      ...templaterDaily,
      ".basalt/plugins/aa-hang/main.js": 'const { Plugin } = require("basalt"); module.exports = class extends Plugin { onload() { return new Promise(() => {}); } };',
      ".basalt/plugins/aa-hang/manifest.json": JSON.stringify({ id: "aa-hang", name: "Aa Hang", version: "0.0.1" }),
    },
  });

  test("says Templater Lite was still waiting, not that it's off", async ({ page, vault }) => {
    test.setTimeout(60000);
    await openApp(page, vault);
    await enable(page, "Templater Lite");
    await page.keyboard.press("ControlOrMeta+p");
    await page.locator(".palette-input").first().fill("Open settings");
    await page.keyboard.press("Enter");
    await page.locator(".plugin-row", { hasText: "Aa Hang" }).locator('input[type="checkbox"]').click();
    await settle(page, 500);
    await page.keyboard.press("Escape");
    const next = await page.context().newPage();
    await openApp(next, vault);
    await expect(next.locator(".notice")).toContainText("still waiting on a slow plugin", { timeout: 20000 });
    expect(vault.exists(`Daily/${today}.md`)).toBe(false);
  });
});

/** Another basalt-server over a temp vault of its own. */
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
    root = await fetch(`${url}/api/vault-root`)
      .then(async (r) => (r.ok ? ((await r.json()) as { root: string }).root : ""))
      .catch(() => "");
    if (!root) await new Promise((r) => setTimeout(r, 50));
  }
  return {
    url,
    root,
    exists: (rel: string) => existsSync(join(dir, rel)),
    stop: async () => {
      if (proc.exitCode === null) await new Promise<void>((r) => (proc.once("exit", () => r()), proc.kill()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test.describe("a vault that opens its daily note from a Templater template, switched away from while it waits", () => {
  test.use({ vaultFiles: { ...templaterDaily, ...slowPlugin(4000, "zz-slow", "Zz Slow") } });

  test("makes nothing in the vault you switched to", async ({ page, vault }) => {
    test.setTimeout(60000);
    const other = await otherVault({ "Welcome B.md": "vault b\n" });
    try {
      await openApp(page, vault);
      await enable(page, "Templater Lite");
      await enable(page, "Zz Slow");
      await page.close();
      const next = await page.context().newPage();
      // As in the desktop app: once the window opens the other vault, every
      // command goes to it.
      const rootA = ((await (await fetch(`${vault.url}/api/vault-root`)).json()) as { root: string }).root;
      let backend = vault.url;
      await next.route("**/api/invoke", async (route) => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        if (body.cmd === "open_vault") {
          backend = body.args?.path === other.root ? other.url : vault.url;
          return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: backend === other.url ? other.root : rootA }) });
        }
        return route.fulfill({ response: await route.fetch({ url: `${backend}/api/invoke` }) });
      });
      await openApp(next, vault);
      await settle(next, 1500);
      await next.evaluate((root) => {
        const list = JSON.parse(localStorage.getItem("basalt.recentVaults") ?? "[]");
        list.push({ path: root, name: "B", ts: Date.now() });
        localStorage.setItem("basalt.recentVaults", JSON.stringify(list));
      }, other.root);
      await next.keyboard.press("ControlOrMeta+p");
      await next.locator(".palette-input").first().fill("Switch vault");
      await next.keyboard.press("Enter");
      await next.locator(".vault-item", { hasText: other.root }).click();
      await expect(next.locator(".tree-row.file", { hasText: "Welcome B" })).toBeVisible();
      await settle(next, 5000);
      expect(other.exists(`Daily/${today}.md`)).toBe(false);
      await expect(next.locator(".notice", { hasText: "daily note" })).toHaveCount(0);
    } finally {
      await other.stop();
    }
  });
});

test.describe("a vault that opens its daily note, switched away from while it loads", () => {
  test.use({ vaultFiles: { ".obsidian/app.json": JSON.stringify({ openBehavior: "daily" }), ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily" }) } });

  test("makes no daily note in the vault you switched to", async ({ page, vault }) => {
    test.setTimeout(60000);
    const other = await otherVault({ "Welcome B.md": "vault b\n" });
    try {
      const rootA = ((await (await fetch(`${vault.url}/api/vault-root`)).json()) as { root: string }).root;
      let backend = vault.url;
      let switching!: () => void;
      const switched = new Promise<void>((r) => (switching = r));
      let held = false;
      await page.addInitScript((root) => localStorage.setItem("basalt.recentVaults", JSON.stringify([{ path: root, name: "B", ts: Date.now() }])), other.root);
      // The first vault's notes arrive only once the switch has begun, and the
      // switch itself takes a while, so the first vault finishes loading mid-switch.
      await page.route("**/api/invoke", async (route) => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        if (body.cmd === "open_vault") {
          const toOther = body.args?.path === other.root;
          backend = toOther ? other.url : vault.url;
          if (toOther) {
            switching();
            await new Promise((r) => setTimeout(r, 3000));
          }
          return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: toOther ? other.root : rootA }) });
        }
        const target = backend;
        const res = await route.fetch({ url: `${target}/api/invoke` });
        if (body.cmd === "read_vault" && !held && target === vault.url) {
          held = true;
          await switched;
        }
        return route.fulfill({ response: res });
      });
      await page.goto(vault.url + "/");
      await settle(page, 800);
      await page.getByRole("button", { name: /Command palette/ }).click();
      await page.locator(".palette-input").first().fill("Switch vault");
      await page.keyboard.press("Enter");
      await page.locator(".vault-item", { hasText: other.root }).click();
      await expect(page.locator(".tree-row.file", { hasText: "Welcome B" })).toBeVisible({ timeout: 15000 });
      await settle(page, 2000);
      expect(other.exists(`Daily/${today}.md`)).toBe(false);
    } finally {
      await other.stop();
    }
  });
});

test.describe("a vault that opens its daily note from a Templater template, with a failed switch while it waits", () => {
  test.use({ vaultFiles: { ...templaterDaily, ...slowPlugin(4000, "zz-slow", "Zz Slow") } });

  test("still opens it", async ({ page, vault }) => {
    test.setTimeout(60000);
    await page.context().addInitScript(() => {
      const list = JSON.parse(localStorage.getItem("basalt.recentVaults") ?? "[]");
      if (!list.some((r: { path: string }) => r.path === "/nonexistent/gone")) list.push({ path: "/nonexistent/gone", name: "Gone", ts: 1 });
      localStorage.setItem("basalt.recentVaults", JSON.stringify(list));
    });
    await openApp(page, vault);
    await enable(page, "Templater Lite");
    await enable(page, "Zz Slow");
    await openNote(page, "Ideas");
    await settle(page, 1200);
    await page.close();
    const next = await page.context().newPage();
    // As the desktop core answers for a vault folder that's gone.
    await next.route("**/api/invoke", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (body.cmd === "open_vault" && body.args?.path === "/nonexistent/gone") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ error: "not a folder" }) });
      return route.fallback();
    });
    await openApp(next, vault);
    await expect(activeTab(next)).toHaveText("Ideas");
    await next.keyboard.press("ControlOrMeta+p");
    await next.locator(".palette-input").first().fill("Switch vault");
    await next.keyboard.press("Enter");
    await next.locator(".vault-item", { hasText: "gone" }).click();
    await expect(activeTab(next)).toHaveText(today, { timeout: 15000 });
  });
});

test.describe("a vault that opens its daily note from a Templater template, with Templater Lite gone", () => {
  test.use({ vaultFiles: templaterDaily });

  test("says it didn't load, not that it was waiting", async ({ page, vault }) => {
    await openApp(page, vault);
    await enable(page, "Templater Lite");
    rmSync(vault.path(".basalt/plugins/templater-lite"), { recursive: true, force: true });
    const next = await page.context().newPage();
    await openApp(next, vault);
    await expect(next.locator(".notice", { hasText: "daily note" })).toContainText("Templater Lite didn't load");
  });
});
