import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("Enter runs the only command left though the mouse was on a lower row", async ({ page }) => {
  await page.getByRole("button", { name: /^Command palette/ }).click();
  const row = page.locator(".palette-item").nth(5);
  await row.hover();
  await expect(row).toHaveAttribute("aria-selected", "true");
  // Typing and Enter at once, before anything else runs.
  await page.locator(".palette-input").evaluate((el: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "Switch vault");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await expect(page.locator(".vault-item").first()).toBeVisible();
});

test("the first row is picked again when the list gets shorter", async ({ page }) => {
  await page.getByRole("button", { name: /^Command palette/ }).click();
  await page.locator(".palette-item").nth(5).hover();
  await page.locator(".palette-input").fill("Switch vault");
  await expect(page.locator(".palette-item")).toHaveCount(1);
  await expect(page.locator(".palette-item").first()).toHaveAttribute("aria-selected", "true");
  const id = await page.locator(".palette-item").first().getAttribute("id");
  await expect(page.locator(".palette-input")).toHaveAttribute("aria-activedescendant", id!);
});

test("arrow keys move from the row the mouse picked", async ({ page }) => {
  await page.getByRole("button", { name: /^Command palette/ }).click();
  await page.locator(".palette-item").nth(2).hover();
  await page.locator(".palette-input").press("ArrowDown");
  await expect(page.locator(".palette-item").nth(3)).toHaveAttribute("aria-selected", "true");
  await page.locator(".palette-input").press("ArrowUp");
  await page.locator(".palette-input").press("ArrowUp");
  await expect(page.locator(".palette-item").nth(1)).toHaveAttribute("aria-selected", "true");
});

test("Enter opens the first note when the quick switcher's list shrinks under the mouse", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+o");
  const rows = page.locator(".palette-item");
  await expect(rows.nth(3)).toBeVisible();
  const before = await rows.count();
  await rows.nth(before - 1).hover();
  await expect(rows.nth(before - 1)).toHaveAttribute("aria-selected", "true");
  // Every note but Welcome goes from disk.
  await page.evaluate(() => {
    const w = window as unknown as { __mockHook: (cmd: string) => Promise<{ result: unknown } | void> | void; __mockEmit: (n: string, p: unknown) => void };
    const content = "# Welcome\n";
    w.__mockHook = (cmd) => (cmd === "read_vault" ? Promise.resolve({ result: [{ path: "/mock/vault/Welcome.md", rel: "Welcome.md", name: "Welcome", content, mtime: 1, ctime: 1, size: content.length }] }) : undefined);
    w.__mockEmit("vault-rescan", null);
  });
  await expect.poll(() => rows.count()).toBeLessThan(before - 1);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  await page.locator(".palette-input").press("Enter");
  await expect(page.locator(".palette-input")).toHaveCount(0);
  await expect(page.locator(".pane:not(.dock) .cm-content").first()).toHaveAttribute("aria-label", "Editing Welcome");
});

test("typing picks the first match, though the list still reaches the row the mouse picked", async ({ page }) => {
  await page.getByRole("button", { name: /^Command palette/ }).click();
  await page.locator(".palette-item").nth(2).hover();
  await expect(page.locator(".palette-item").nth(2)).toHaveAttribute("aria-selected", "true");
  await page.locator(".palette-input").fill("o");
  await expect.poll(() => page.locator(".palette-item").count()).toBeGreaterThan(3);
  await expect(page.locator(".palette-item").first()).toHaveAttribute("aria-selected", "true");
});
