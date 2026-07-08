import { test, expect } from "@playwright/test";

// Movable views/leaves (Option A). A view (Outline) can live as a tab in a pane
// alongside notes, renders the last active note's content, and persists.
test("a view can be opened as a tab, renders, and survives reload", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();

  // Open the Outline as a movable view tab.
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").first().fill("Open outline in a new tab");
  await page.keyboard.press("Enter");

  await expect(page.locator(".pane:not(.dock) .tab.view-tab", { hasText: "Outline" })).toHaveCount(1);
  await expect(page.locator(".pane:not(.dock) .leaf-view")).toContainText("Welcome"); // outline of the active note
  await expect(page.locator(".pane:not(.dock) .cm-editor")).toHaveCount(0); // view active, not the editor

  // Switching back to the note restores the editor.
  await page.locator(".pane:not(.dock) .tab", { hasText: "Welcome" }).click();
  await expect(page.locator(".pane:not(.dock) .cm-editor")).toHaveCount(1);

  // The view tab persists across a reload.
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.locator(".pane:not(.dock) .tab.view-tab", { hasText: "Outline" })).toHaveCount(1);
});

test("a fresh vault has a right dock of view leaves that tracks the active note", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.waitForSelector(".sidebar");
  // The dock is a pane in the tree holding the built-in views as tabs.
  await expect(page.locator(".pane.dock .tab.view-tab .tab-name")).toContainText([
    "Backlinks",
    "Outline",
    "Properties",
    "Tags",
    "Bookmarks",
  ]);
  // Its Outline tracks the active note.
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await page.locator(".pane.dock .tab.view-tab", { hasText: "Outline" }).click();
  await expect(page.locator(".pane.dock .leaf-view")).toContainText("Welcome");
  // Toggling the right sidebar removes the dock pane.
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").first().fill("Toggle right sidebar");
  await page.keyboard.press("Enter");
  await expect(page.locator(".pane.dock")).toHaveCount(0);
});
