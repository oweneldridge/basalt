import { test, expect } from "@playwright/test";

test("typing while Settings is open never reaches the note, and Escape returns focus", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  const editor = page.locator(".pane:not(.dock) .cm-content").first();
  await editor.click();
  const before = await editor.innerText();
  await page.keyboard.press("ControlOrMeta+Comma");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await page.keyboard.type("ZZZ");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).not.toHaveClass(/cm-content/);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await editor.innerText()).toBe(before);
  await expect(editor).toBeFocused();
});

test("the command palette is a labelled dialog that closes on Escape", async ({ page }) => {
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+p");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-label", /.+/);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("the editor and glyph-only buttons have accessible names", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await expect(page.getByRole("textbox", { name: "Editing Welcome" })).toBeVisible();
  for (const name of ["Split right", "New note", "Collapse all", "Open a note (⌘O)"]) {
    await expect(page.getByRole("button", { name }).first()).toBeVisible();
  }
});
