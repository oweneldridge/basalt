import { renameSync, utimesSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, openApp, openNote } from "./fixture";

const view = (page: Page) => page.locator(".pane:not(.dock) .base-view");
const OLD = "views:\n  - type: list\n    name: Old\n    filters: 'file.mtime.year < 2021'\n";
const then = new Date("2020-05-02T12:00:00Z");
const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

test.describe("a note's stats", () => {
  test.use({ vaultFiles: { "Old.base": OLD, "Projects/Beta.md": "# Beta\n" } });

  test("a note touched outside the app, its time only, is filtered by its new time", async ({ page, vault }) => {
    test.setTimeout(40000);
    await openApp(page, vault);
    await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
    await expect(view(page).getByRole("listitem").filter({ hasText: "Beta" })).toHaveCount(0);
    // Long enough that the file's own making is out of the watcher's flags, so
    // the touch comes as a change of time alone.
    await page.waitForTimeout(10000);
    utimesSync(vault.path("Projects/Beta.md"), then, then);
    await expect(view(page).getByRole("listitem").filter({ hasText: "Beta" })).toHaveCount(1, { timeout: 8000 });
  });
});

test.describe("an old note", () => {
  test.use({ vaultFiles: { "Old.base": OLD, "Gamma.md": "# Gamma\n" } });

  test("edited here, it takes the new time from the file", async ({ page, vault }) => {
    utimesSync(vault.path("Gamma.md"), then, then);
    await openApp(page, vault);
    await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
    await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1);
    await openNote(page, "Gamma");
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("edited");
    await expect.poll(() => vault.read("Gamma.md")).toContain("edited");
    await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
    await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(0, { timeout: 8000 });
  });

  test("changed and then touched outside the app at once, both its text and time arrive", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Gamma");
    await page.waitForTimeout(1500);
    writeFileSync(vault.path("Gamma.md"), "# Gamma\n\nfrom the phone\n");
    utimesSync(vault.path("Gamma.md"), then, then);
    await expect(page.locator(".pane:not(.dock) .cm-content").first()).toContainText("from the phone", { timeout: 8000 });
    await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
    await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1, { timeout: 8000 });
  });
});

test.describe("a note synced while we save", () => {
  test.use({ vaultFiles: { "Old.base": OLD, "Beta.md": "# Beta\n" } });

  test("a synced change that lands during our own save keeps its time", async ({ page, vault }) => {
    test.setTimeout(60000);
    await page.route("**/api/invoke", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (body.cmd === "write_note" && String(body.args?.path).endsWith("Beta.md")) await new Promise((r) => setTimeout(r, 2500));
      return route.fallback();
    });
    await openApp(page, vault);
    await openNote(page, "Beta");
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("z");
    await page.waitForTimeout(900); // the save is out, and held
    writeFileSync(vault.path(".Beta.sync"), "# Beta\n\nsynced\n");
    utimesSync(vault.path(".Beta.sync"), then, then);
    renameSync(vault.path(".Beta.sync"), vault.path("Beta.md"));
    await page.waitForTimeout(5000);
    const reload = page.getByRole("button", { name: "Reload", exact: true });
    if (await reload.count()) await reload.first().click();
    await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
    await expect(view(page).getByRole("listitem").filter({ hasText: "Beta" })).toHaveCount(1, { timeout: 8000 });
  });
});

test.describe("a note the app makes", () => {
  test.use({
    vaultFiles: {
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", template: "Templates/Daily" }),
      "Templates/Daily.md": "## Log\n",
      "Daily/2020-01-01.md": "old\n",
      "Today.base": "views:\n  - type: list\n    name: Today\n    filters: 'file.inFolder(\"Daily\") && file.ctime.year > 2000 && file.size > 0'\n",
    },
  });

  test("today's daily note has a date and size at once, without a rescan", async ({ page, vault }) => {
    test.setTimeout(60000);
    await openApp(page, vault);
    await page.waitForTimeout(3000); // the folders' own events are long gone
    await page.keyboard.press("ControlOrMeta+p");
    await page.locator(".palette-input").first().fill("Open today's daily note");
    await page.keyboard.press("Enter");
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText(today);
    await page.locator(".tree-row.attachment", { hasText: "Today" }).click();
    await expect(view(page).getByRole("listitem").filter({ hasText: today })).toHaveCount(1, { timeout: 6000 });
  });
});
