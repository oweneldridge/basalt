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
  // The plugin's addStatusBarItem shows in the bottom status bar.
  await expect(page.locator(".status-bar .plugin-status-item")).toContainText("demo-plugin-ok");
  // Its addRibbonIcon shows in the ribbon and its callback fires on click.
  await expect(page.locator(".ribbon-plugin-btn")).toHaveAttribute("title", "Demo action");
  await page.keyboard.press("Escape"); // close settings so the ribbon isn't covered
  await expect(page.locator(".settings")).toHaveCount(0);
  await page.locator(".ribbon-plugin-btn").click();
  expect(await page.evaluate(() => (window as unknown as { __demoRibbon: number }).__demoRibbon)).toBe(1);
  // metadataCache.getFileCache returns parsed tags/headings for a real note.
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").first().fill("Dump Ideas metadata");
  await page.keyboard.press("Enter");
  const meta = await page.evaluate(() => (window as unknown as { __ideasMeta: { tags: string[]; headings: { heading: string }[] } }).__ideasMeta);
  expect(meta.tags).toContain("tag/one");
  expect(meta.headings.map((h) => h.heading)).toContain("Ideas");
  // registerView adds a right-panel tab that mounts the plugin's content.
  await page.locator(".pane.dock .tab.view-tab", { hasText: "Demo View" }).click();
  await expect(page.locator(".pane.dock .plugin-view-mount")).toHaveText("demo-view-content");
  // vault.rename mutates the vault through the host.
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").first().fill("Vault rename Ideas");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tree-row.file", { hasText: "IdeasViaPlugin" })).toHaveCount(1);
});
