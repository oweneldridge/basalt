import { test, expect } from "@playwright/test";

const applied = (page: import("@playwright/test").Page) =>
  page.evaluate(() => [...document.querySelectorAll("style[data-basalt-snippet]")].map((s) => (s as HTMLElement).dataset.basaltSnippet).sort());

test("Obsidian's snippets follow Obsidian's enabled list until switched here", async ({ page }) => {
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect.poll(() => applied(page)).toEqual(["mine", "obs-on"]);
  await page.keyboard.press("ControlOrMeta+Comma");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.locator(".plugin-row", { hasText: "obs-off" }).locator("input").check();
  await dialog.locator(".plugin-row", { hasText: "obs-on" }).locator("input").uncheck();
  await expect.poll(() => applied(page)).toEqual(["mine", "obs-off"]);
  await page.reload();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect.poll(() => applied(page)).toEqual(["mine", "obs-off"]);
});
