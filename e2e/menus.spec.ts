import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.waitForSelector(".sidebar");
});

test("tab context menu: close others keeps the right-clicked tab", async ({ page }) => {
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await expect(page.locator(".pane .tab")).toHaveCount(2);
  const first = page.locator(".pane .tab").nth(0);
  const name = await first.locator(".tab-name").textContent();
  await first.click({ button: "right" });
  await expect(page.locator(".ctx-menu .ctx-item")).toHaveText([
    "Close",
    "Close others",
    "Close to the right",
    "Pin",
    "Split right",
  ]);
  await page.locator(".ctx-item", { hasText: "Close others" }).click();
  await expect(page.locator(".pane .tab")).toHaveCount(1);
  await expect(page.locator(".pane .tab .tab-name")).toHaveText(name!);
});

test("file context menu: Make a copy creates a duplicate note", async ({ page }) => {
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click({ button: "right" });
  const items = page.locator(".ctx-menu .ctx-item");
  await expect(items.filter({ hasText: "Open to the right" })).toHaveCount(1);
  await expect(items.filter({ hasText: "Make a copy" })).toHaveCount(1);
  await expect(items.filter({ hasText: "Copy path" })).toHaveCount(1);
  await page.locator(".ctx-item", { hasText: "Make a copy" }).click();
  await expect(page.locator(".tree-row.file", { hasText: "Ideas copy" })).toHaveCount(1);
});

test("sidebar: collapse-all hides nested files; reveal-active brings them back", async ({ page }) => {
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("tree.expanded")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.folder", { hasText: "Projects" }).click();
  await expect(page.locator(".tree-row.file", { hasText: "Roadmap" })).toHaveCount(1);
  await page.locator('.icon-btn[title="Collapse all"]').click();
  await expect(page.locator(".tree-row.file", { hasText: "Roadmap" })).toHaveCount(0);
  // Open the nested note, collapse again, then reveal it.
  await page.keyboard.press("Meta+o");
  await page.locator(".palette-input").first().fill("Roadmap");
  await page.keyboard.press("Enter");
  await page.locator('.icon-btn[title="Collapse all"]').click();
  await expect(page.locator(".tree-row.file", { hasText: "Roadmap" })).toHaveCount(0);
  await page.locator('.icon-btn[title="Reveal active file"]').click();
  await expect(page.locator(".tree-row.file.active", { hasText: "Roadmap" })).toHaveCount(1);
});

test("inline title renames the note", async ({ page }) => {
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await expect(page.locator(".inline-title")).toHaveValue("Ideas");
  await page.locator(".inline-title").fill("IdeasRenamed");
  await page.locator(".inline-title").press("Enter");
  await expect(page.locator(".pane .tab.active .tab-name")).toHaveText("IdeasRenamed");
  await expect(page.locator(".tree-row.file", { hasText: "IdeasRenamed" })).toHaveCount(1);
});
