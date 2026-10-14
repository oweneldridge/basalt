import { test, expect, type Page } from "@playwright/test";

const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const base = (filter: string) => `views:\n  - type: list\n    name: V\n    filters: '${filter}'\n`;
async function load(page: Page, files: Record<string, string>) {
  await page.addInitScript((f) => ((window as unknown as { __mockExtraFiles: Record<string, string> }).__mockExtraFiles = f), files);
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
}
const view = (page: Page) => page.locator(".pane:not(.dock) .base-view");
async function run(page: Page, label: string) {
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill(label);
  await page.keyboard.press("Enter");
}
const emit = (page: Page, c: object) =>
  page.evaluate((x) => (window as unknown as { __mockEmit: (n: string, p: unknown) => void }).__mockEmit("vault-changed", [x]), c);

test("today's daily note has its creation time at once", async ({ page }) => {
  await load(page, { "New.base": base("file.ctime.year > 2024") });
  await run(page, "Open today's daily note");
  await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText(today);
  await page.locator(".tree-row.attachment", { hasText: "New" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: today })).toHaveCount(1);
});

test("a new note has its creation time at once", async ({ page }) => {
  await load(page, { "New.base": base("file.ctime.year > 2024") });
  await run(page, "New note");
  await page.waitForTimeout(500);
  await page.locator(".tree-row.attachment", { hasText: "New" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Untitled" })).toHaveCount(1);
});

test("a copy has its creation time and byte size at once", async ({ page }) => {
  await load(page, { "New.base": base("file.ctime.year > 2024 && file.size == 4"), "Cafe.md": "é\nx" });
  await page.locator(".tree-row.file", { hasText: "Cafe" }).first().click({ button: "right" });
  await page.getByText("Make a copy").click();
  await page.waitForTimeout(500);
  await page.locator(".tree-row.attachment", { hasText: "New" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Cafe copy" })).toHaveCount(1);
});

test("a time-only change carries a new creation time", async ({ page }) => {
  await load(page, { "Old.base": base("file.ctime.year < 2021"), "Gamma.md": "# Gamma\n" });
  await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(0);
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: 1_700_000_000_000, ctime: Date.UTC(2020, 4, 2), size: 8, statsOnly: true });
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1);
});

test("a time-only change carries a new size", async ({ page }) => {
  await load(page, { "Big.base": base("file.size == 12345"), "Gamma.md": "# Gamma\n" });
  await page.locator(".tree-row.attachment", { hasText: "Big" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(0);
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: 1_700_000_000_000, ctime: 1_700_000_000_000, size: 12345, statsOnly: true });
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1);
});

test("a new note's text change, then a change of its time alone: the note is still read", async ({ page }) => {
  await load(page, {});
  await page.waitForTimeout(500);
  const t = 1_700_000_000_000;
  await emit(page, { path: "/mock/vault/Fresh.md", rel: "Fresh.md", mtime: t, ctime: t, size: 0 });
  await emit(page, { path: "/mock/vault/Fresh.md", rel: "Fresh.md", mtime: t + 5, ctime: t, size: 0, statsOnly: true });
  await expect(page.locator(".tree-row.file", { hasText: "Fresh" })).toHaveCount(1);
});

test("a note whose time alone changes twice isn't read", async ({ page }) => {
  await load(page, { "Gamma.md": "# Gamma\n" });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const w = window as unknown as { __reads: number; __mockHook: (cmd: string, a: { path?: string }) => void };
    w.__reads = 0;
    w.__mockHook = (cmd, a) => {
      if (cmd === "read_note" && a.path?.endsWith("Gamma.md")) w.__reads++;
    };
  });
  const t = 1_700_000_000_000;
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: t + 1, ctime: t, size: 8, statsOnly: true });
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: t + 2, ctime: t, size: 8, statsOnly: true });
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as unknown as { __reads: number }).__reads)).toBe(0);
});

test("a change read during our save, and read again after it, keeps a later change's time", async ({ page }) => {
  await load(page, { "Old.base": base("file.mtime.year < 2021"), "Gamma.md": "# Gamma\n" });
  await page.locator(".tree-row.file", { hasText: "Gamma" }).first().click();
  await page.evaluate(() => {
    const w = window as unknown as { __saved: boolean; __reading: boolean; __read: number; __mockHook: (cmd: string, a: { path?: string }) => Promise<{ result: unknown } | void> };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    w.__read = 0;
    w.__mockHook = async (cmd, a) => {
      if (!a.path?.endsWith("Gamma.md")) return;
      // The save fails on the outside change, so only the watcher sets the note's time.
      if (cmd === "write_note") {
        await sleep(3000);
        w.__saved = true;
        throw "Changed on disk since Basalt last read it";
      }
      if (cmd === "read_note") {
        if (w.__read++ === 0) {
          w.__reading = true;
          await sleep(1000);
        }
        return { result: "# Gamma\n\nfrom the phone\n" };
      }
    };
  });
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("z");
  await page.waitForTimeout(700); // the save is out, and slow
  const t = Date.UTC(2026, 0, 1);
  // Changed outside meanwhile, then touched while that change is read.
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: t, ctime: t, size: 26 });
  await page.waitForFunction(() => (window as unknown as { __reading: boolean }).__reading);
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: Date.UTC(2020, 4, 2), ctime: t, size: 26, statsOnly: true });
  await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1);
  // The read overlapped the save, so it's read again once the save has settled.
  await page.waitForFunction(() => (window as unknown as { __saved: boolean }).__saved);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as { __read: number }).__read)).toBeGreaterThan(1);
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1);
});

test("a note a plugin makes has its creation time and byte size at once", async ({ page }) => {
  await load(page, { "New.base": base("file.ctime.year > 2024 && file.size == 4") });
  await run(page, "Open settings");
  await page.locator(".plugin-row", { hasText: "Demo Plugin" }).locator('input[type="checkbox"]').check();
  await page.keyboard.press("Escape");
  await run(page, "Vault create a note");
  await page.waitForTimeout(500);
  await page.locator(".tree-row.attachment", { hasText: "New" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Made By Plugin" })).toHaveCount(1);
});

test("sorting Files by modified time uses a time that changed under another sort", async ({ page }) => {
  await load(page, { "Zzz.md": "z", "Aaa.md": "a" });
  const order = async () => (await page.locator(".tree-row.file").allTextContents()).filter((t) => /Aaa|Zzz/.test(t));
  await expect.poll(order).toEqual([expect.stringContaining("Aaa"), expect.stringContaining("Zzz")]);
  await emit(page, { path: "/mock/vault/Zzz.md", rel: "Zzz.md", mtime: Date.now() + 86_400_000, ctime: 1_700_000_000_000, size: 1, statsOnly: true });
  await page.waitForTimeout(1000);
  await page.locator(".file-sort").selectOption("mtime-desc");
  await expect.poll(order).toEqual([expect.stringContaining("Zzz"), expect.stringContaining("Aaa")]);
});
