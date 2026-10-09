import { test, expect } from "@playwright/test";

// The mock vault lives at /mock/vault, so its Obsidian vault name is "vault".
const extra = {
  "Links.md":
    "# Links\n\n[same vault](obsidian://open?vault=vault&file=Ideas)\n\n[by path](obsidian://open?path=%2Fmock%2Fvault%2FWelcome.md)\n\n[search](obsidian://search?vault=vault&query=later)\n\n[other vault](obsidian://open?vault=elsewhere&file=Ideas)\n",
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((files) => {
    (window as unknown as { __mockExtraFiles: Record<string, string> }).__mockExtraFiles = files;
  }, extra);
  await page.goto("/app-harness.html");
  await page.locator(".tree-row.file", { hasText: "Links" }).click();
  await page.locator('button[title^="Toggle Reading view"]').click();
});

const reading = (page: import("@playwright/test").Page) => page.locator(".pane:not(.dock) .reading-view");
const activeTab = (page: import("@playwright/test").Page) => page.locator(".pane:not(.dock) .tab.active .tab-name").first();

test("an obsidian:// link to this vault opens the note in Basalt", async ({ page }) => {
  await reading(page).getByRole("link", { name: "same vault" }).click();
  await expect(activeTab(page)).toHaveText("Ideas");
});

test("an obsidian:// link by absolute path inside the vault opens the note", async ({ page }) => {
  await reading(page).getByRole("link", { name: "by path" }).click();
  await expect(activeTab(page)).toHaveText("Welcome");
});

test("an obsidian:// search link opens Search with the query", async ({ page }) => {
  await reading(page).getByRole("link", { name: "search" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("combobox").or(page.getByRole("dialog").locator("input")).first()).toHaveValue("later");
});

test("a link to another vault isn't handled in Basalt", async ({ page }) => {
  await reading(page).getByRole("link", { name: "other vault" }).click();
  await expect(activeTab(page)).toHaveText("Links");
});
