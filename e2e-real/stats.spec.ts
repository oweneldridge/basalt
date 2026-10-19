import { renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, openApp, openNote, settle } from "./fixture";

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
    let hold = false;
    // A rescan would bring the stats from disk: keep it out of the way.
    await page.route("**/api/invoke", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (hold && body.cmd === "read_vault") await new Promise((r) => setTimeout(r, 8000));
      return route.fallback();
    });
    await openApp(page, vault);
    await page.waitForTimeout(3000); // the folders' own events are long gone
    hold = true;
    await page.keyboard.press("ControlOrMeta+p");
    await page.locator(".palette-input").first().fill("Open today's daily note");
    await page.keyboard.press("Enter");
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText(today);
    await page.locator(".tree-row.attachment", { hasText: "Today" }).click();
    await expect(view(page).getByRole("listitem").filter({ hasText: today })).toHaveCount(1, { timeout: 3000 });
  });
});

test.describe("a note changed twice outside the app", () => {
  test.use({ vaultFiles: { "Old.base": OLD, "Gamma.md": "# Gamma\n" } });

  test("a slow read of its text doesn't bring back the time a later change replaced", async ({ page, vault }) => {
    test.setTimeout(60000);
    let held = 0;
    let armed = false;
    await page.route("**/api/invoke", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (armed && body.cmd === "read_note" && String(body.args?.path).endsWith("Gamma.md") && held++ === 0) await new Promise((r) => setTimeout(r, 4000));
      return route.fallback();
    });
    await openApp(page, vault);
    await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
    await expect(view(page)).toBeVisible();
    await page.waitForTimeout(10000); // past the watcher's memory of the file's making
    armed = true;
    writeFileSync(vault.path("Gamma.md"), "# Gamma\n\nfrom the phone\n");
    await page.waitForTimeout(1500); // the change's read is out, and slow
    utimesSync(vault.path("Gamma.md"), then, then);
    await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1, { timeout: 4000 });
    await page.waitForTimeout(4000); // the slow read has landed
    expect(held).toBeGreaterThan(0);
    await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1);
  });
});

// Basalt's own writes give a note its new stats at once, as a save does.
const RECENT = "views:\n  - type: list\n    name: Recent\n    filters: 'file.mtime.year > 2024'\n";
// Any rescan would bring the stats from disk; keep it out of the way.
async function noRescan(page: import("@playwright/test").Page) {
  const state = { hold: false };
  await page.route("**/api/invoke", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (state.hold && body.cmd === "read_vault") await new Promise((r) => setTimeout(r, 15000));
    return route.fallback();
  });
  return state;
}

test.describe("a note Basalt rewrites", () => {
  test.use({ vaultFiles: { "Recent.base": RECENT, "Target.md": "# Target\n", "Src.md": "see Target here\n", "Old.md": "# Old\n", "Linker.md": "see [[Old]]\n" } });

  test("has its new time once a mention in it is linked", async ({ page, vault }) => {
    utimesSync(vault.path("Src.md"), then, then);
    const rescan = await noRescan(page);
    await openApp(page, vault);
    await page.waitForTimeout(1500);
    rescan.hold = true;
    await openNote(page, "Target");
    await page.locator(".pane.dock .tab.view-tab", { hasText: "Backlinks" }).click();
    await page.locator(".ref-link-btn").first().click();
    await expect.poll(() => vault.read("Src.md")).toBe("see [[Target]] here\n");
    await page.locator(".tree-row.attachment", { hasText: "Recent" }).click();
    await expect(view(page).getByRole("listitem").filter({ hasText: "Src" })).toHaveCount(1, { timeout: 3000 });
  });

  test("has its new time once a rename fixes a link in it", async ({ page, vault }) => {
    utimesSync(vault.path("Linker.md"), then, then);
    const rescan = await noRescan(page);
    await openApp(page, vault);
    await page.waitForTimeout(1500);
    rescan.hold = true;
    await page.locator(".tree-row.file", { hasText: "Old" }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Rename…" }).click();
    await page.locator(".prompt-input").fill("New");
    await page.locator(".prompt-input").press("Enter");
    await expect.poll(() => vault.read("Linker.md")).toBe("see [[New]]\n");
    await page.locator(".tree-row.attachment", { hasText: "Recent" }).click();
    await expect(view(page).getByRole("listitem").filter({ hasText: "Linker" })).toHaveCount(1, { timeout: 3000 });
  });
});

test.describe("a note reloaded from disk after a save conflict", () => {
  test.use({ vaultFiles: { "Recent.base": RECENT, "Gamma.md": "# Gamma\n" } });

  test("has its new time", async ({ page, vault }) => {
    utimesSync(vault.path("Gamma.md"), then, then);
    // No watcher: only the save finds out the note changed.
    await page.route("**/api/events", (route) => route.abort());
    await openApp(page, vault);
    await openNote(page, "Gamma");
    writeFileSync(vault.path("Gamma.md"), "# Gamma\n\nfrom the phone\n");
    utimesSync(vault.path("Gamma.md"), then, then);
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("z");
    const reload = page.getByRole("button", { name: "Reload", exact: true });
    await expect(reload.first()).toBeVisible({ timeout: 8000 });
    await reload.first().click();
    await expect(page.locator(".pane:not(.dock) .cm-content").first()).toContainText("from the phone");
    await page.locator(".tree-row.attachment", { hasText: "Recent" }).click();
    await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1, { timeout: 3000 });
  });
});

test.describe("a pasted image that finishes saving after you leave the note", () => {
  // Its link is longer than the placeholder it replaces.
  const BIGGER = "views:\n  - type: list\n    name: Bigger\n    filters: 'file.size > 40'\n";
  test.use({ vaultFiles: { "Bigger.base": BIGGER, "Holder.md": "# Holder\n", "Other.md": "# Other\n" } });

  test("leaves the note with its new size", async ({ page, vault }) => {
    test.setTimeout(60000);
    const rescan = await noRescan(page);
    await page.route("**/api/invoke", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (body.cmd === "write_attachment") await new Promise((r) => setTimeout(r, 3000));
      return route.fallback();
    });
    await openApp(page, vault);
    await page.waitForTimeout(1500);
    rescan.hold = true;
    await openNote(page, "Holder");
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.evaluate(() => {
      const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([png], "image.png", { type: "image/png" }));
      document.querySelector(".pane:not(.dock) .cm-content")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => vault.read("Holder.md")).toContain("uploading-");
    await openNote(page, "Other");
    await page.locator(".tree-row.attachment", { hasText: "Bigger" }).click();
    await expect(view(page).getByRole("listitem").filter({ hasText: "Holder" })).toHaveCount(0);
    await expect.poll(() => vault.read("Holder.md"), { timeout: 10000 }).toContain(".png]]");
    expect(statSync(vault.path("Holder.md")).size).toBeGreaterThan(40);
    await expect(view(page).getByRole("listitem").filter({ hasText: "Holder" })).toHaveCount(1, { timeout: 3000 });
  });
});

test.describe("a note deleted elsewhere while you type, kept", () => {
  const MADE = "views:\n  - type: list\n    name: Made\n    filters: 'file.ctime.year > 2024'\n";
  test.use({ vaultFiles: { "Made.base": MADE, "Gamma.md": "# Gamma\n" } });

  test("is written back with its creation time", async ({ page, vault }) => {
    test.setTimeout(60000);
    const rescan = await noRescan(page);
    await openApp(page, vault);
    await openNote(page, "Gamma");
    await page.waitForTimeout(1500);
    rescan.hold = true;
    // Its saves fail meanwhile, so the typing is still unsaved when the note goes.
    const failing = async (route: import("@playwright/test").Route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (body.cmd === "write_note") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ error: "disk busy" }) });
      return route.fallback();
    };
    await page.route("**/api/invoke", failing);
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("mine");
    await page.waitForTimeout(1200);
    rmSync(vault.path("Gamma.md"));
    const keep = page.getByRole("button", { name: "Keep mine", exact: true });
    await expect(keep.first()).toBeVisible({ timeout: 8000 });
    await page.unroute("**/api/invoke", failing);
    await keep.first().click();
    await expect.poll(() => vault.exists("Gamma.md") && vault.read("Gamma.md")).toContain("mine");
    await page.locator(".tree-row.attachment", { hasText: "Made" }).click();
    await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1, { timeout: 3000 });
  });
});
