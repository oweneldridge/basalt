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
