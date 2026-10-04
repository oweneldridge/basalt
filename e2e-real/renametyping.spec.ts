import { test, expect, openApp, openNote, settle } from "./fixture";

test("typing right after an inline-title rename keeps every keystroke and no old file", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  // Simulate a slow link / cloud read for the renamed file only.
  await page.route("**/api/invoke", async (route) => {
    const body = route.request().postData() ?? "";
    if (body.includes('"cmd":"read_note"') && body.includes("Ideas Renamed.md")) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    await route.continue();
  });
  const title = page.locator("input.inline-title").first();
  await title.fill("Ideas Renamed");
  await page.locator(".pane:not(.dock) .cm-line", { hasText: "Something for later" }).click(); // blur -> rename
  await page.keyboard.press("End");
  await page.keyboard.type(" AAA", { delay: 30 });
  await page.waitForTimeout(400);
  await page.keyboard.type(" BBB", { delay: 30 });
  await settle(page, 3500);
  const shown = await page.locator(".pane:not(.dock) .cm-content").first().innerText();
  const newDisk = vault.exists("Ideas Renamed.md") ? vault.read("Ideas Renamed.md") : "(missing)";
  const oldDisk = vault.exists("Ideas.md") ? vault.read("Ideas.md") : "(missing)";
  test.info().annotations.push({ type: "editor", description: JSON.stringify(shown.slice(-60)) });
  test.info().annotations.push({ type: "new", description: JSON.stringify(newDisk.slice(-60)) });
  test.info().annotations.push({ type: "old", description: JSON.stringify(oldDisk.slice(-60)) });
  expect(oldDisk).toBe("(missing)");
  expect(newDisk).toContain("AAA");
  expect(newDisk).toContain("BBB");
});
