import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, openApp, openNote, settle, ROOT } from "./fixture";

// Obsidian's "Default file to open: Daily note" (openBehavior in app.json).
const d = new Date();
const pad = (n: number) => String(n).padStart(2, "0");
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const activeTab = (page: import("@playwright/test").Page) => page.locator(".pane:not(.dock) .tab.active .tab-name").first();

// Turns a plugin on in Settings.
const enable = async (page: import("@playwright/test").Page, name: string) => {
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Open settings");
  await page.keyboard.press("Enter");
  const box = page.locator(".plugin-row", { hasText: name }).locator('input[type="checkbox"]');
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
