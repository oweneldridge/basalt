import { test, expect } from "@playwright/test";

// Plugin API — the mock vault ships a "Demo Plugin" that registers a settings
// tab and a vault event listener. Verifies the settings-tab API + that enabling
// a plugin (which runs its code) works headless.
test("a plugin can register a settings tab that renders in Settings", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter((k) => k.includes("workspace") || k.includes("plugins"))
      .forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.waitForSelector(".sidebar");
  // Open settings via the command palette (portable across OSes).
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").first().fill("Open settings");
  await page.keyboard.press("Enter");
  await expect(page.locator(".settings")).toBeVisible();
  await expect(page.locator(".plugin-name", { hasText: "Demo Plugin" })).toBeVisible();
  // No settings panel until the plugin is enabled (its onload registers it).
  await expect(page.locator(".plugin-settings-toggle")).toHaveCount(0);
  await page.locator(".plugin-row", { hasText: "Demo Plugin" }).locator('input[type="checkbox"]').check();
  await expect(page.locator(".plugin-settings-toggle")).toHaveCount(1);
  await page.locator(".plugin-settings-toggle").click();
  await expect(page.locator(".plugin-settings-mount")).toContainText("Hello from the demo plugin settings");
});
