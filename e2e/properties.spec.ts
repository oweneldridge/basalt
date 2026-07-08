import { test, expect } from "@playwright/test";

// Properties panel — the mock's WithProps.md has frontmatter (status/priority/done).
test("Properties panel edits, adds, and removes frontmatter", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace") || k.includes("rightTab")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.file", { hasText: "WithProps" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator(".pane.dock .tab.view-tab", { hasText: "Properties" }).click();
  await expect(page.locator(".properties .prop-key")).toHaveText(["status", "priority", "done"]);
  // Edit a value.
  const statusRow = page.locator(".prop-row", { hasText: "status" });
  await statusRow.locator(".prop-value").fill("final");
  await statusRow.locator(".prop-value").press("Enter");
  await expect(statusRow.locator(".prop-value")).toHaveValue("final");
  // Add a property.
  await page.locator(".prop-add .prop-value").fill("author");
  await page.locator(".prop-add-btn").click();
  await expect(page.locator(".properties .prop-key")).toContainText(["author"]);
  // Remove a property.
  await page.locator(".prop-row", { hasText: "priority" }).locator(".prop-del").click();
  await expect(page.locator(".properties .prop-key")).toHaveText(["status", "done", "author"]);
});
