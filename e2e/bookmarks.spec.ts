import { test, expect } from "@playwright/test";

// Bookmarks — the frontend flow against the mock's in-memory bookmarks store
// (the .obsidian/bookmarks.json write itself + structure preservation is unit-
// tested in Rust: bookmark_toggle_preserves_groups_and_unknown_fields).
test("bookmark a note, see it in the panel, then remove it", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator('.ribbon-btn[title^="Command palette"]').click();
  await page.locator(".palette-input").first().fill("Bookmark");
  await page.keyboard.press("Enter");
  await page.locator(".pane.dock .tab.view-tab", { hasText: "Bookmarks" }).click();
  await expect(page.locator(".pane.dock .leaf-view")).toContainText("Ideas");
  // Context menu reflects state + removes.
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Remove bookmark" })).toBeVisible();
  await page.locator(".ctx-item", { hasText: "Remove bookmark" }).click();
  await expect(page.locator(".pane.dock .leaf-view")).not.toContainText("Ideas");
});
