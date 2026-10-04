import { test, expect, openApp, openNote, caretToEnd, settle } from "./fixture";

async function renameFolder(page: import("@playwright/test").Page, name: string, to: string) {
  await page.locator(".tree-row.folder", { hasText: name }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename folder…" }).click();
  await page.locator(".prompt-input").fill(to);
  await page.locator(".prompt-input").press("Enter");
}

test("moved note: typed text survives a folder rename and the next keystroke", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.folder", { hasText: "Projects" }).click();
  await openNote(page, "Alpha");
  await caretToEnd(page);
  await page.keyboard.type("\ntyped before the move");
  await expect.poll(() => vault.read("Projects/Alpha.md")).toContain("typed before the move");
  await settle(page);
  await renameFolder(page, "Projects", "Work");
  await expect.poll(() => vault.exists("Work/Alpha.md")).toBe(true);
  await settle(page);
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("!");
  await settle(page, 1500);
  const disk = vault.read("Work/Alpha.md");
  expect(disk).toContain("typed before the move");
});

test("unmoved linking note: a folder move's link rewrite survives the next keystroke", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Welcome");
  await caretToEnd(page);
  await page.keyboard.type("\ntyped in welcome");
  await expect.poll(() => vault.read("Welcome.md")).toContain("typed in welcome");
  await settle(page);
  await renameFolder(page, "Projects", "Work");
  await expect.poll(() => vault.read("Welcome.md")).toContain("Project: [[Alpha]]");
  await settle(page);
  await page.locator(".pane:not(.dock) .cm-line", { hasText: "typed in welcome" }).first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await settle(page, 1500);
  const disk = vault.read("Welcome.md");
  expect(disk).toContain("typed in welcome!");
  expect(disk).not.toContain("[[Projects/Alpha]]");
});
