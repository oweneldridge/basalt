import { test, expect } from "@playwright/test";

test("a change to a note's time alone moves it in a base, without reading the note", async ({ page }) => {
  await page.addInitScript((files) => {
    (window as unknown as { __mockExtraFiles: Record<string, string> }).__mockExtraFiles = files;
  }, { "Old.base": "views:\n  - type: list\n    name: Old\n    filters: 'file.mtime.year < 2021'\n", "Gamma.md": "# Gamma\n" });
  await page.goto("/app-harness.html");
  await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
  const view = page.locator(".pane:not(.dock) .base-view");
  await expect(view).toBeVisible();
  await expect(view.getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(0);
  const then = Date.UTC(2020, 4, 2);
  await page.evaluate(
    (t) =>
      (window as unknown as { __mockEmit: (n: string, p: unknown) => void }).__mockEmit("vault-changed", [
        { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: t, ctime: t, size: 8, statsOnly: true },
      ]),
    then,
  );
  await expect(view.getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1);
});
