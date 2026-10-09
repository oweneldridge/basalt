import { test, expect, openApp, openNote, caretToEnd, settle } from "./fixture";
import type { Page } from "@playwright/test";

// Actions that remount or re-derive the editor must keep what was typed.
const actions: [string, (page: Page) => Promise<void>][] = [
  ["toggle the left sidebar", async (page) => {
    await page.locator('[title^="Toggle sidebar"]').click();
    await page.locator('[title^="Toggle sidebar"]').click();
  }],
  ["toggle Reading view", async (page) => {
    await page.locator('button[title*="Reading"]').first().click();
    await page.locator('button[title*="Reading"]').first().click();
  }],
  ["split right", async (page) => {
    await page.locator('button:has-text("⊟")').first().click();
  }],
  ["edit a property", async (page) => {
    await page.locator(".pane.dock .tab.view-tab", { hasText: "Properties" }).click();
    const row = page.locator(".prop-row", { hasText: "status" });
    await row.locator(".prop-value").fill("paused");
    await row.locator(".prop-value").press("Enter");
  }],
];

for (const [name, act] of actions) {
  test(`typed text survives: ${name}`, async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.folder", { hasText: "Projects" }).click();
    await openNote(page, "Alpha");
    await caretToEnd(page);
    await page.keyboard.type("\ntyped before the action");
    await expect.poll(() => vault.read("Projects/Alpha.md")).toContain("typed before the action");
    await settle(page);
    await act(page);
    await settle(page);
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("!");
    await settle(page, 1200);
    expect(vault.read("Projects/Alpha.md")).toContain("typed before the action");
  });
}

test("typing in the new pane after a split keeps the source pane's text", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await caretToEnd(page);
  await page.keyboard.type("\nfrom the first pane");
  await expect.poll(() => vault.read("Ideas.md")).toContain("from the first pane");
  await settle(page);
  await page.locator('button:has-text("⊟")').first().click();
  await expect(page.locator(".pane:not(.dock) .cm-editor")).toHaveCount(2);
  await page.locator(".pane:not(.dock) .cm-content").nth(1).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" and the second");
  await settle(page, 1200);
  const disk = vault.read("Ideas.md");
  expect(disk).toContain("from the first pane and the second");
  await expect(page.locator(".pane:not(.dock) .cm-content").first()).toContainText("from the first pane and the second");
});

test("a property edit right after typing keeps the newest keystrokes", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.folder", { hasText: "Projects" }).click();
  await openNote(page, "Alpha");
  await page.locator(".pane.dock .tab.view-tab", { hasText: "Properties" }).click();
  await caretToEnd(page);
  await page.keyboard.type("\nlast words");
  const row = page.locator(".prop-row", { hasText: "status" });
  await row.locator(".prop-value").fill("paused");
  await row.locator(".prop-value").press("Enter");
  await settle(page, 1200);
  const disk = vault.read("Projects/Alpha.md");
  expect(disk).toContain("status: paused");
  expect(disk).toContain("last words");
});
