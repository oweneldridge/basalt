import { test, expect, type Page } from "@playwright/test";

async function load(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("basalt.recentVaults", JSON.stringify([{ path: "/mock/other", name: "other", ts: Date.now() }]));
  });
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
}

test("a vault switch is named while it runs, says when it's done, and says why buttons wait", async ({ page }) => {
  await load(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.evaluate(() => {
    (window as unknown as { __mockHook: (cmd: string) => Promise<void> | void }).__mockHook = (cmd) =>
      cmd === "open_vault" ? new Promise((r) => setTimeout(r, 2500)) : undefined;
  });
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Switch vault");
  await page.keyboard.press("Enter");
  await page.locator(".vault-item", { hasText: "/mock/other" }).first().click();
  await expect(page.getByRole("status", { name: "Opening other" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Search (⌘⇧F)" })).toHaveAttribute("title", "Search (⌘⇧F), once the vault is open");
  await expect(page.getByRole("button", { name: "Settings" })).toHaveAttribute("title", "Settings (⌘,), once the vault is open");
  await expect(page.getByRole("status").filter({ hasText: "Opened other" })).toHaveCount(1, { timeout: 10000 });
  await expect(page.getByRole("button", { name: "Search (⌘⇧F)" })).toHaveAttribute("title", "Search (⌘⇧F)");
  await expect(page.getByRole("status").filter({ hasText: "Opened other" })).toHaveCount(0, { timeout: 8000 });
});

test("only a failed save is announced as not saved", async ({ page }) => {
  await load(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
  await page.evaluate(() => {
    (window as unknown as { __mockHook: (cmd: string) => Promise<void> | void }).__mockHook = (cmd) =>
      cmd === "write_note" ? Promise.reject("disk full") : undefined;
  });
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.type("x");
  await expect(page.getByRole("alert")).toHaveText("Not saved: disk full", { timeout: 10000 });
});

test("an error that isn't a failed save isn't announced as one", async ({ page }) => {
  await load(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
  const tab = page.locator(".pane:not(.dock) [role='tab']", { hasText: "Ideas" });
  await tab.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Pin/ }).click();
  await tab.focus();
  await page.keyboard.press("ControlOrMeta+w");
  await expect(page.getByRole("alert")).toHaveText("Unpin the tab before closing it");
});

test("a canvas that fails to save is announced as not saved", async ({ page }) => {
  await load(page);
  await page.locator(".tree-row.attachment", { hasText: "Board" }).click();
  await page.evaluate(() => {
    (window as unknown as { __mockHook: (cmd: string) => Promise<void> | void }).__mockHook = (cmd) =>
      cmd === "write_canvas" ? Promise.reject("disk full") : undefined;
  });
  const box = (await page.locator(".canvas-node", { hasText: "Node A" }).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole("alert")).toHaveText("Not saved: disk full", { timeout: 10000 });
});
