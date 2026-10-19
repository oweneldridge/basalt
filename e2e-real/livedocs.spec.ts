import { test, expect, openApp, openNote, settle } from "./fixture";

test("a slow tab load in one pane never reverts typing in another pane on the same note", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await page.locator('button:has-text("⊟")').first().click(); // split: pane 2 shows Ideas too
  await expect(page.locator(".pane:not(.dock) .cm-editor")).toHaveCount(2);
  // In the new (focused) pane, open Welcome so its tabs are [Ideas, Welcome].
  await page.locator(".pane:not(.dock)").nth(1).locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+o");
  await page.keyboard.type("Welcome");
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await expect(page.locator(".pane:not(.dock)").nth(1).locator(".tab.active .tab-name")).toHaveText("Welcome");
  let slow = false;
  await page.route("**/api/invoke", async (route) => {
    const body = route.request().postData() ?? "";
    if (slow && body.includes('"cmd":"read_note"') && body.includes("Ideas.md")) {
      const resp = await route.fetch(); // read disk NOW, deliver late (slow link)
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({ response: resp });
      return;
    }
    await route.continue();
  });
  slow = true;
  // Close Welcome in pane 2: it falls back to Ideas and reads it (slowly).
  await page.locator(".pane:not(.dock)").nth(1).locator(".tab.active").hover();
  await page.locator(".pane:not(.dock)").nth(1).locator('.tab.active button[title^="Close"], .tab.active .tab-close').first().click();
  // Meanwhile, type in pane 1's Ideas editor.
  await page.locator(".pane:not(.dock)").first().locator(".cm-line", { hasText: "Something for later" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" TYPED-IN-PANE-1", { delay: 20 });
  await page.waitForTimeout(2500);
  const pane1 = await page.locator(".pane:not(.dock)").first().locator(".cm-content").innerText();
  test.info().annotations.push({ type: "pane1", description: JSON.stringify(pane1.slice(-60)) });
  await page.locator(".pane:not(.dock)").first().locator(".cm-line").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await settle(page, 1500);
  const disk = vault.read("Ideas.md");
  test.info().annotations.push({ type: "disk", description: JSON.stringify(disk.slice(-60)) });
  expect(disk).toContain("TYPED-IN-PANE-1");
});
