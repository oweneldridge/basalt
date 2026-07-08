import { test, expect } from "@playwright/test";

// Bases editor — opens the mock vault's Notes.base and exercises the group-by
// control (a data-mutating .base edit; the serialize round-trip is unit-tested
// in bases.test.ts, this guards the UI wiring).
test("base editor exposes a working Group by control", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.locator(".tree-row.attachment", { hasText: "Notes.base" }).click();
  await page.getByRole("button", { name: "✎ Edit" }).click();
  const editor = page.locator(".base-editor");
  await expect(editor).toBeVisible();
  await expect(page.locator(".base-editor-title", { hasText: "Group by" })).toBeVisible();
  const gb = page.locator(".base-editor-section", { hasText: "Group by" });
  await gb.locator("select").selectOption("file.name");
  await expect(gb.locator(".base-sort-dir")).toBeVisible(); // direction toggle appears once grouped
});

test("filter builder: add conditions that persist through a re-parse", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.attachment", { hasText: "Notes.base" }).click();
  await page.getByRole("button", { name: "\u270e Edit" }).click();
  const fs = page.locator(".base-editor-section", { hasText: "Filter" });
  await fs.locator(".base-filter-add").click();
  await fs.locator(".base-filter-input").first().fill('status != "done"');
  await fs.locator(".base-filter-input").first().blur();
  await fs.locator(".base-filter-add").click();
  await fs.locator(".base-filter-input").nth(1).fill("priority > 1");
  await fs.locator(".base-filter-input").nth(1).blur();
  await expect(fs.locator(".base-filter-cond")).toHaveCount(2);
  await expect(fs.locator(".base-filter-combinator")).toBeVisible();
  // Re-parse: close + reopen the editor; the conditions survive (were saved).
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "\u270e Edit" }).click();
  await page.getByRole("button", { name: "\u270e Edit" }).click();
  const reopened = page.locator(".base-editor-section", { hasText: "Filter" }).locator(".base-filter-input");
  await expect(reopened).toHaveCount(2);
  await expect(reopened.nth(0)).toHaveValue('status != "done"');
  await expect(reopened.nth(1)).toHaveValue("priority > 1");
});
