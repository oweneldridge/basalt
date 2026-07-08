import { test, expect } from "@playwright/test";

// Presentation mode — opens the mock vault's multi-slide Deck.md and drives the
// slide navigation.
test("start presentation splits a note into navigable slides", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.file", { hasText: "Deck" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator('.ribbon-btn[title^="Command palette"]').click();
  await page.locator(".palette-input").first().fill("presentation");
  await page.keyboard.press("Enter");
  await expect(page.locator(".slides-overlay")).toBeVisible();
  await expect(page.locator(".slides-count")).toHaveText("1 / 3");
  await expect(page.locator(".slides-content")).toContainText("Slide One");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".slides-count")).toHaveText("3 / 3");
  await expect(page.locator(".slides-content")).toContainText("Slide Three");
  await page.keyboard.press("Escape");
  await expect(page.locator(".slides-overlay")).toHaveCount(0);
});
