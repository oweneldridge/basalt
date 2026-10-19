import { test, expect } from "@playwright/test";

const extra = {
  "Listed.md": "# Listed\n\n1. Item\n\n   | a | b |\n   | - | - |\n   | 1 | 2 |\n\nAfter\n",
  "Quoted.md": "# Quoted\n\n> | a | b |\n> | - | - |\n> | 1 | 2 |\n\nAfter\n",
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((files) => {
    (window as unknown as { __mockExtraFiles: Record<string, string> }).__mockExtraFiles = files;
  }, extra);
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
});

const pane = (page: import("@playwright/test").Page) => page.locator(".pane:not(.dock)");

test("adding a row to a table in a list item keeps it indented under the item", async ({ page }) => {
  await page.locator(".tree-row.file", { hasText: "Listed" }).click();
  const table = pane(page).locator(".cm-md-table-wrap");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await table.hover();
  await table.locator(".cm-table-addrow-foot").click();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await table.locator(".cm-table-cell", { hasText: "1" }).click();
  // Exact text: toHaveText would normalize away the indentation under test.
  const raw = () => pane(page).locator(".cm-line").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
  await expect.poll(raw).toEqual(expect.arrayContaining(["   | a   | b   |", "   | --- | --- |", "   | 1   | 2   |", "   |     |     |"]));
});

test("a table in a blockquote renders its own columns and keeps its markers", async ({ page }) => {
  await page.locator(".tree-row.file", { hasText: "Quoted" }).click();
  const table = pane(page).locator(".cm-md-table-wrap");
  await expect(table.locator("thead th .cm-table-cell")).toHaveText(["a", "b"]);
  await table.hover();
  await table.locator(".cm-table-addcol-foot").click();
  await expect(table.locator("thead th")).toHaveCount(3);
  // The caret's own line shows its `>` marker in Live Preview.
  await table.locator("thead .cm-table-cell", { hasText: "a" }).click();
  const raw = () => pane(page).locator(".cm-line").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
  await expect.poll(raw).toContain("> | a   | b   |     |");
});
