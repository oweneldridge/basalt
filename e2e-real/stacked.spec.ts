import { test, expect, openApp, openNote, settle } from "./fixture";

test("stacked column: an external edit is not reverted by the next keystroke", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Welcome");
  await openNote(page, "Ideas");
  await page.locator(".tab-stack").first().click();
  await expect(page.locator(".stacked-col")).toHaveCount(2);
  const ideasCol = page.locator(".stacked-col", { hasText: "Ideas" }).filter({ has: page.locator(".stacked-col-head", { hasText: "Ideas" }) });
  await expect(ideasCol.locator(".cm-content")).toContainText("A list of things to try");
  vault.write("Ideas.md", "# Ideas\n\nWRITTEN BY OBSIDIAN\n");
  await page.waitForTimeout(2500); // watcher + debounce
  const shown = await ideasCol.locator(".cm-content").innerText();
  test.info().annotations.push({ type: "column-after-external", description: JSON.stringify(shown) });
  await ideasCol.locator(".cm-line").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" typed");
  await settle(page, 1500);
  const disk = vault.read("Ideas.md");
  const conflict = await page.locator(".conflict").isVisible();
  test.info().annotations.push({ type: "disk", description: JSON.stringify(disk) + " conflict=" + conflict });
  expect(disk.includes("WRITTEN BY OBSIDIAN") || conflict).toBe(true);
});
