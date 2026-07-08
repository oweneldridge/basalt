import { test, expect } from "@playwright/test";

// Full-app UI tests that the editor-only harness can't reach: they need the
// whole <App/> mounted (panes, sidebars, tabs). Backed by the mocked Tauri
// vault, so no real filesystem / Tauri runtime is involved.
test.beforeEach(async ({ page }) => {
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("sidebar is resizable and the width persists", async ({ page }) => {
  const sidebar = page.locator(".sidebar");
  const before = (await sidebar.boundingBox())!.width;
  const handle = page.locator(".side-resizer").first();
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + 40);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 90, h.y + 40, { steps: 8 });
  await page.mouse.up();
  const after = (await sidebar.boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 60);
  expect(Number(await page.evaluate(() => localStorage.getItem("basalt.leftWidth")))).toBeGreaterThan(before + 60);
});

test("hiding the sidebar lets the editor area expand", async ({ page }) => {
  const mainBefore = (await page.locator("main.main").boundingBox())!.width;
  await page.locator('[title^="Toggle sidebar"]').click();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  const mainAfter = (await page.locator("main.main").boundingBox())!.width;
  expect(mainAfter).toBeGreaterThan(mainBefore);
  await page.locator('[title^="Toggle sidebar"]').click();
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("opening a note shows an editor + tab, and a pane can split", async ({ page }) => {
  await page.getByRole("button", { name: "Welcome" }).click();
  await expect(page.locator(".cm-editor")).toHaveCount(1);
  await expect(page.locator(".tab")).toHaveCount(1);
  // The Welcome note's table renders interactively.
  await expect(page.locator(".cm-md-table-wrap")).toBeVisible();
  await page.locator('button:has-text("⊟")').first().click();
  await expect(page.locator(".cm-editor")).toHaveCount(2);
  await expect(page.locator(".pane-resizer")).toHaveCount(1);
});

test("a linked pane follows notes opened in another pane", async ({ page }) => {
  // Clean workspace so we start from a single pane.
  await page.evaluate(() => {
    const v = localStorage.getItem("basalt.lastVault");
    localStorage.clear();
    if (v) localStorage.setItem("basalt.lastVault", v);
  });
  await page.reload();
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await expect(page.locator(".cm-editor")).toHaveCount(1);
  await page.locator('button:has-text("⊟")').first().click();
  await expect(page.locator(".cm-editor")).toHaveCount(2);
  // Link the second pane, then open a different note in the first.
  await page.locator(".tab-link").nth(1).click();
  await expect(page.locator(".tab-link").nth(1)).toHaveClass(/active/);
  await page.locator(".pane").first().locator(".cm-content").click();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  // Both panes now show Ideas.
  await expect(page.locator(".pane .tab.active .tab-name")).toHaveText(["Ideas", "Ideas"]);
});
