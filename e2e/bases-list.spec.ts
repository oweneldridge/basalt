import { test, expect } from "@playwright/test";

const base = (views: string) => `filters: 'file.inFolder("Lists")'\nviews:\n${views}`;
const extra = {
  "Lists/Apple.md": "---\nstatus: open\nowner: Ann\n---\n# Apple\n",
  "Lists/Bean.md": "# Bean\n",
  "Lists/Cherry.md": "---\nstatus: done\n---\n# Cherry\n",
  "Plain.base": base(
    "  - type: list\n    name: Plain\n    order:\n      - file.name\n      - status\n      - owner\n    sort:\n      - property: file.name\n        direction: ASC\n",
  ),
  "Indented.base": base(
    "  - type: list\n    name: Indented\n    markers: number\n    indentProperties: true\n    order:\n      - status\n      - file.name\n    sort:\n      - property: file.name\n        direction: ASC\n",
  ),
  "Bare.base": base("  - type: list\n    name: Bare\n    markers: none\n    separator: ' / '\n    order:\n      - file.name\n      - status\n"),
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((files) => {
    (window as unknown as { __mockExtraFiles: Record<string, string> }).__mockExtraFiles = files;
  }, extra);
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await expect(page.locator(".sidebar")).toBeVisible();
});

const view = (page: import("@playwright/test").Page) => page.locator(".pane:not(.dock) .base-view");

test("a list view joins each file's non-empty properties with the separator", async ({ page }) => {
  await page.locator(".tree-row.attachment", { hasText: "Plain" }).click();
  const list = view(page).locator("ul.base-list-bullet");
  await expect(list.getByRole("listitem")).toHaveText(["Apple, open, Ann", "Bean", "Cherry, done"]);
  await list.getByRole("button", { name: "Bean" }).click();
  await expect(page.locator(".pane:not(.dock) .cm-content")).toContainText("Bean");
});

test("numbered, indented list skips files whose first property is empty", async ({ page }) => {
  await page.locator(".tree-row.attachment", { hasText: "Indented" }).click();
  const list = view(page).locator("ol.base-list-number");
  const items = list.locator(":scope > li");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).locator(".base-list-nested > li")).toHaveText(["Apple"]);
  await expect(items.nth(0)).toContainText("open");
  await expect(items.nth(1)).toContainText("done");
  await expect(list).not.toContainText("Bean");
});

test("a list without markers keeps list semantics and uses its separator", async ({ page }) => {
  await page.locator(".tree-row.attachment", { hasText: "Bare" }).click();
  const list = view(page).getByRole("list");
  await expect(list).toHaveClass(/base-list-none/);
  await expect(list.getByRole("listitem").filter({ hasText: "Cherry" })).toHaveText("Cherry / done");
});

test("the view editor switches a base to a numbered list and saves it", async ({ page }) => {
  await page.locator(".tree-row.attachment", { hasText: "Plain" }).click();
  await view(page).getByRole("button", { name: "✎ Edit" }).click();
  const editor = page.locator(".base-editor");
  await editor.getByLabel("Markers").selectOption("number");
  await expect(view(page).locator("ol.base-list-number").getByRole("listitem")).toHaveCount(3);
  await editor.getByLabel("Indent properties").check();
  await expect(editor.getByLabel("Separator")).toHaveCount(0);
  await expect(view(page).locator(".base-list-nested").first()).toBeVisible();
  await page.waitForTimeout(700);
  await view(page).getByRole("button", { name: "✎ Edit" }).click();
  await view(page).getByRole("button", { name: "✎ Edit" }).click();
  await expect(editor.getByLabel("Markers")).toHaveValue("number");
  await expect(editor.getByLabel("Indent properties")).toBeChecked();
  await editor.getByLabel("Type").selectOption("table");
  await expect(view(page).locator(".base-table")).toBeVisible();
});
