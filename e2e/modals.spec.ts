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

test("the root font size is the user's own until they zoom, and zoom persists", async ({ page }) => {
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe("");
  await page.keyboard.press("ControlOrMeta+Equal");
  await expect.poll(() => page.evaluate(() => document.documentElement.style.fontSize)).toBe("110%");
  await page.reload();
  await expect(page.locator(".sidebar")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe("110%");
  await page.keyboard.press("ControlOrMeta+Digit0");
  await expect.poll(() => page.evaluate(() => document.documentElement.style.fontSize)).toBe("");
});

test("tabs work from the keyboard: arrows move, Enter opens, Delete closes", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  const tabs = page.locator(".pane:not(.dock) [role='tab']");
  await expect(tabs).toHaveCount(2);
  await tabs.filter({ hasText: "Ideas" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.filter({ hasText: "Welcome" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tabs.filter({ hasText: "Welcome" })).toHaveAttribute("aria-selected", "true");
  await tabs.filter({ hasText: "Welcome" }).focus();
  await page.keyboard.press("Delete");
  await expect(tabs).toHaveCount(1);
  await expect(page.getByRole("tablist", { name: "Open notes" })).toBeVisible();
});
