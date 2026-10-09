import { test, expect, openApp, settle } from "./fixture";

// Obsidian's "Default file to open: Daily note" (openBehavior in app.json).
const d = new Date();
const pad = (n: number) => String(n).padStart(2, "0");
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const activeTab = (page: import("@playwright/test").Page) => page.locator(".pane:not(.dock) .tab.active .tab-name").first();

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
