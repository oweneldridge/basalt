import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.waitForSelector(".sidebar");
});

test("tab context menu: close others keeps the right-clicked tab", async ({ page }) => {
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await expect(page.locator(".pane:not(.dock) .tab")).toHaveCount(2);
  const first = page.locator(".pane:not(.dock) .tab").nth(0);
  const name = await first.locator(".tab-name").textContent();
  await first.click({ button: "right" });
  await expect(page.locator(".ctx-menu .ctx-item")).toHaveText([
    "Close",
    "Close others",
    "Close to the right",
    "Pin",
    "Split right",
    "Move to new window",
  ]);
  await page.locator(".ctx-item", { hasText: "Close others" }).click();
  await expect(page.locator(".pane:not(.dock) .tab")).toHaveCount(1);
  await expect(page.locator(".pane:not(.dock) .tab .tab-name")).toHaveText(name!);
});

test("file context menu: Make a copy creates a duplicate note", async ({ page }) => {
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click({ button: "right" });
  const items = page.locator(".ctx-menu .ctx-item");
  await expect(items.filter({ hasText: "Open to the right" })).toHaveCount(1);
  await expect(items.filter({ hasText: "Make a copy" })).toHaveCount(1);
  await expect(items.filter({ hasText: "Copy path" })).toHaveCount(1);
  await page.locator(".ctx-item", { hasText: "Make a copy" }).click();
  await expect(page.locator(".tree-row.file", { hasText: "Ideas copy" })).toHaveCount(1);
});

test("sidebar: collapse-all hides nested files; reveal-active brings them back", async ({ page }) => {
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("tree.expanded")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.folder", { hasText: "Projects" }).click();
  await expect(page.locator(".tree-row.file", { hasText: "Roadmap" })).toHaveCount(1);
  await page.locator('.icon-btn[title="Collapse all"]').click();
  await expect(page.locator(".tree-row.file", { hasText: "Roadmap" })).toHaveCount(0);
  // Open the nested note, collapse again, then reveal it.
  await page.keyboard.press("Meta+o");
  await page.locator(".palette-input").first().fill("Roadmap");
  await page.keyboard.press("Enter");
  await page.locator('.icon-btn[title="Collapse all"]').click();
  await expect(page.locator(".tree-row.file", { hasText: "Roadmap" })).toHaveCount(0);
  await page.locator('.icon-btn[title="Reveal active file"]').click();
  await expect(page.locator(".tree-row.file.active", { hasText: "Roadmap" })).toHaveCount(1);
});

test("inline title renames the note", async ({ page }) => {
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await expect(page.locator(".inline-title")).toHaveValue("Ideas");
  await page.locator(".inline-title").fill("IdeasRenamed");
  await page.locator(".inline-title").press("Enter");
  await expect(page.locator(".pane:not(.dock) .tab.active .tab-name")).toHaveText("IdeasRenamed");
  await expect(page.locator(".tree-row.file", { hasText: "IdeasRenamed" })).toHaveCount(1);
});

test("dragging a tree note into the editor inserts a wikilink", async ({ page }) => {
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  const inserted = await page.evaluate(() => {
    const content = document.querySelector(".pane .cm-content") as HTMLElement;
    const rect = content.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData("application/x-basalt-note", "/mock/vault/Ideas.md");
    const opts = { dataTransfer: dt, clientX: rect.left + 40, clientY: rect.top + 15, bubbles: true, cancelable: true };
    content.dispatchEvent(new DragEvent("dragover", opts));
    content.dispatchEvent(new DragEvent("drop", opts));
    return document.querySelector(".pane .cm-content")?.textContent ?? "";
  });
  expect(inserted).toContain("[[Ideas]]");
});

test("editor right-click menu: Bold wraps the selection; Cut/Copy gate on selection", async ({ page }) => {
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  const word = page.locator(".cm-content").getByText("first", { exact: false }).first();
  await word.dblclick();
  await word.click({ button: "right" });
  await expect(page.locator(".ctx-menu .ctx-item")).toHaveText(["Cut", "Copy", "Paste", "Bold", "Italic"]);
  await page.locator(".ctx-item", { hasText: "Bold" }).click();
  await expect(page.locator(".pane .cm-content")).toContainText("**first**");
  // No selection → Cut/Copy disabled.
  await page.locator(".pane .cm-content").click();
  await page.locator(".pane .cm-content").click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Cut" })).toBeDisabled();
  await expect(page.locator(".ctx-item", { hasText: "Paste" })).toBeEnabled();
});

test("appearance settings change editor font size and accent color", async ({ page }) => {
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("font") || k.includes("accent")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".settings")).toBeVisible();
  // Font size → the editor scales.
  await page.locator('input[aria-label="Font size"]').fill("22");
  await expect(page.locator(".cm-editor")).toHaveCSS("font-size", "22px");
  // Accent → the --accent custom property updates (native setter so React sees it).
  await page.locator('input[aria-label="Accent color"]').evaluate((el: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, "#ff0000");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()))
    .toBe("#ff0000");
  // Reset clears the override.
  await page.locator(".settings-reset").click();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()))
    .not.toBe("#ff0000");
});
