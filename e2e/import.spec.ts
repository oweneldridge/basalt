import { test, expect } from "@playwright/test";

// "Import from Obsidian" — the mock returns a fixture .obsidian config
// (theme obsidian, accent #ff8800, font 19, 3 hotkeys, 2 community plugins).
test("Import from Obsidian applies appearance + hotkeys and reports plugins", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".sidebar");
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".settings")).toBeVisible();
  await page.locator(".settings-row", { hasText: "Import settings from Obsidian" }).locator("button").click();

  // Appearance applied to the live CSS vars.
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#ff8800");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-size").trim())).toBe("19px");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");

  // Report: 2 of 3 hotkeys mapped, and the community plugins listed (not run).
  await expect(page.locator(".import-report")).toContainText("2 hotkeys imported");
  await expect(page.locator(".import-report")).toContainText("1 couldn");
  await expect(page.locator(".import-plugins li")).toHaveText(["dataview", "templater-obsidian"]);
});
