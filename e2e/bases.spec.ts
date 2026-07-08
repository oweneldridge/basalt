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
  await fs.locator(".base-filter-input .cm-content").first().click();
  await page.keyboard.type('status != "done"');
  await fs.locator(".base-editor-title").first().click(); // blur → commit
  await fs.locator(".base-filter-add").click();
  await fs.locator(".base-filter-input .cm-content").nth(1).click();
  await page.keyboard.type("priority > 1");
  await fs.locator(".base-editor-title").first().click(); // blur → commit
  await expect(fs.locator(".base-filter-cond")).toHaveCount(2);
  await expect(fs.locator(".base-filter-combinator")).toBeVisible();
  // Re-parse: close + reopen the editor; the conditions survive (were saved).
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "\u270e Edit" }).click();
  await page.getByRole("button", { name: "\u270e Edit" }).click();
  const reopened = page.locator(".base-editor-section", { hasText: "Filter" }).locator(".base-filter-input .cm-content");
  await expect(reopened).toHaveCount(2);
  await expect(reopened.nth(0)).toContainText('status != "done"');
  await expect(reopened.nth(1)).toContainText("priority > 1");
});

test("formula authoring: add a formula, persist it, use it as a column", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.attachment", { hasText: "Notes.base" }).click();
  await page.locator("button").filter({ hasText: "Edit" }).first().click();
  const f = page.locator(".base-editor-section", { hasText: "Formulas" });
  await f.getByRole("button", { name: "+ Add formula" }).click();
  await f.locator(".base-formula-name").fill("ppu");
  await f.locator(".base-formula-name").blur();
  await f.locator(".base-formula-expr .cm-content").click();
  await page.keyboard.type("price / quantity");
  await f.locator(".base-editor-title").first().click(); // blur → commit
  await page.waitForTimeout(700); // save debounce
  // Re-parse: the formula persists...
  await page.locator("button").filter({ hasText: "Edit" }).first().click();
  await page.locator("button").filter({ hasText: "Edit" }).first().click();
  const f2 = page.locator(".base-editor-section", { hasText: "Formulas" });
  await expect(f2.locator(".base-formula-name")).toHaveValue("ppu");
  await expect(f2.locator(".base-formula-expr .cm-content")).toContainText("price / quantity");
  // ...and is now offered as a column.
  await expect(page.locator(".base-add-col option", { hasText: "ppu" })).toHaveCount(1);
});

test("formula editor: expression autocomplete + live validation", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.attachment", { hasText: "Notes.base" }).click();
  await page.locator("button").filter({ hasText: "Edit" }).first().click();
  const f = page.locator(".base-editor-section", { hasText: "Formulas" });
  await f.getByRole("button", { name: "+ Add formula" }).click();
  const editor = f.locator(".base-formula-expr .cm-content");
  await expect(editor).toBeVisible();
  // Autocomplete: "file." offers file members.
  await editor.click();
  await page.keyboard.type("file.");
  await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible();
  await expect(page.locator(".cm-tooltip-autocomplete li", { hasText: "mtime" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  // Live validation: an incomplete expression flags an error, then clears.
  await page.keyboard.type("name ==");
  await expect(f.locator(".expr-error")).toBeVisible();
  await page.keyboard.type(' "x"');
  await expect(f.locator(".expr-error")).toHaveCount(0);
});
