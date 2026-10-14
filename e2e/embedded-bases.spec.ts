import { test, expect } from "@playwright/test";

const extra = {
  "Embedder.md": "# Embedder\n\n![[Notes.base#All notes]]\n",
  "Hub.md": "# Hub\n\n```base\nviews:\n  - type: table\n    name: Linking here\n    filters: 'file.hasLink(this.file)'\n    order:\n      - file.name\n```\n",
  "Points.md": "# Points\n\nsee [[Hub]]\n",
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((files) => {
    (window as unknown as { __mockExtraFiles: Record<string, string> }).__mockExtraFiles = files;
  }, extra);
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("an embedded base renders its table in the editor and in Reading view", async ({ page }) => {
  await page.locator(".tree-row.file", { hasText: "Embedder" }).click();
  const embed = page.locator(".pane:not(.dock) .embed-base");
  await expect(embed.locator(".base-view")).toBeVisible();
  await expect(embed.getByRole("cell", { name: "Welcome", exact: true })).toBeVisible();
  await page.locator('button[title^="Toggle Reading view"]').click();
  await expect(page.locator(".reading-view .embed-base .base-view").getByRole("cell", { name: "Welcome", exact: true })).toBeVisible();
});

test("a base code block lists the notes linking to the note it sits in", async ({ page }) => {
  await page.locator(".tree-row.file", { hasText: "Hub" }).click();
  const block = page.locator(".pane:not(.dock) .cm-base-block .base-view");
  await expect(block).toBeVisible();
  await expect(block.getByRole("cell", { name: "Points", exact: true })).toBeVisible();
  await expect(block.getByRole("cell", { name: "Welcome", exact: true })).toHaveCount(0);
  // Clicking the table body puts the caret in the block and shows the YAML.
  await page.locator(".pane:not(.dock) .cm-base-block .base-count").click();
  await expect(page.locator(".pane:not(.dock) .cm-content")).toContainText("file.hasLink(this.file)");
});
