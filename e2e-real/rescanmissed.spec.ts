import { test, expect, openApp, openNote, settle } from "./fixture";

test("an external edit seen only by a reconnect rescan is not overwritten by a non-active dirty note", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await openNote(page, "Welcome"); // tabs [Ideas, Welcome], active Welcome
  await page.locator(".tab-stack").first().click();
  const ideasCol = page.locator(".stacked-col").filter({ has: page.locator(".stacked-col-head", { hasText: "Ideas" }) });
  await expect(ideasCol.locator(".cm-content")).toContainText("A list of things to try");
  await vault.stop(); // network drop / laptop sleep
  await ideasCol.locator(".cm-line", { hasText: "Something for later" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" MINE");
  await page.waitForTimeout(1200); // autosave fails while the server is gone; edit stays pending
  vault.write("Ideas.md", "# Ideas\n\nTHEIRS written while Basalt was offline\n");
  await vault.start(); // SSE reconnects -> full resync (rescan)
  await page.waitForTimeout(4000);
  const conflictAfterResync = await page.locator(".conflict").isVisible();
  await ideasCol.locator(".cm-line").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" more");
  await settle(page, 2000);
  const disk = vault.read("Ideas.md");
  const conflict = await page.locator(".conflict").isVisible();
  test.info().annotations.push({ type: "result", description: `conflictAfterResync=${conflictAfterResync} conflictNow=${conflict} disk=${JSON.stringify(disk)}` });
  expect(disk.includes("THEIRS") || conflict).toBe(true);
});
