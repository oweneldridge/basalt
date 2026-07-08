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
