import { test, expect } from "@playwright/test";

// Full-app UI tests that the editor-only harness can't reach: they need the
// whole <App/> mounted (panes, sidebars, tabs). Backed by the mocked Tauri
// vault, so no real filesystem / Tauri runtime is involved.
test.beforeEach(async ({ page }) => {
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("the file explorer lives in a resizable left dock", async ({ page }) => {
  await expect(page.locator(".pane.dock-left .sidebar")).toBeVisible();
  const dock = page.locator(".pane.dock-left");
  const before = (await dock.boundingBox())!.width;
  const handle = page.locator(".pane-resizer").first(); // between left dock + editor
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + 40);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 90, h.y + 40, { steps: 8 });
  await page.mouse.up();
  expect((await dock.boundingBox())!.width).toBeGreaterThan(before + 50);
});

test("toggling the left sidebar hides and shows the file explorer", async ({ page }) => {
  await expect(page.locator(".pane.dock-left")).toHaveCount(1);
  await page.locator('[title^="Toggle sidebar"]').click();
  await expect(page.locator(".pane.dock-left")).toHaveCount(0);
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.locator('[title^="Toggle sidebar"]').click();
  await expect(page.locator(".pane.dock-left")).toHaveCount(1);
});

test("opening a note shows an editor + tab, and a pane can split", async ({ page }) => {
  await page.getByRole("button", { name: "Welcome" }).click();
  await expect(page.locator(".cm-editor")).toHaveCount(1);
  await expect(page.locator(".pane:not(.dock) .tab")).toHaveCount(1);
  // The Welcome note's table renders interactively.
  await expect(page.locator(".cm-md-table-wrap")).toBeVisible();
  await page.locator('button:has-text("⊟")').first().click();
  await expect(page.locator(".cm-editor")).toHaveCount(2);
  await expect(page.locator(".pane-resizer")).toHaveCount(3);
});

test("a linked pane follows notes opened in another pane", async ({ page }) => {
  // Clean workspace so we start from a single pane.
  await page.evaluate(() => {
    const v = localStorage.getItem("basalt.lastVault");
    localStorage.clear();
    if (v) localStorage.setItem("basalt.lastVault", v);
  });
  await page.reload();
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await expect(page.locator(".cm-editor")).toHaveCount(1);
  await page.locator('button:has-text("⊟")').first().click();
  await expect(page.locator(".cm-editor")).toHaveCount(2);
  // Link the second pane, then open a different note in the first.
  await page.locator(".tab-link").nth(1).click();
  await expect(page.locator(".tab-link").nth(1)).toHaveClass(/active/);
  await page.locator(".pane:not(.dock)").first().locator(".cm-content").click();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  // Both panes now show Ideas.
  await expect(page.locator(".pane:not(.dock) .tab.active .tab-name")).toHaveText(["Ideas", "Ideas"]);
});

test("stacking a tab group spreads all open notes as columns", async ({ page }) => {
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await expect(page.locator(".cm-editor")).toHaveCount(1);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await expect(page.locator(".pane:not(.dock) .tab")).toHaveCount(2);
  // Stack → a column per open note, each an editable editor.
  await page.locator(".pane:not(.dock) .tab-stack").click();
  await expect(page.locator(".stacked-col")).toHaveCount(2);
  await expect(page.locator(".stacked-col-head")).toHaveText(["Welcome", "Ideas"]);
  await expect(page.locator(".stacked-col .cm-editor")).toHaveCount(2);
  // Edit the 2nd column; the edit saves back and survives unstack + re-stack.
  await page.locator(".stacked-col").nth(1).locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" STACKEDIT");
  await page.waitForTimeout(700); // debounced save
  await page.locator(".stacked-col-head").nth(1).click();
  await expect(page.locator(".stacked-tabs")).toHaveCount(0);
  await expect(page.locator(".pane:not(.dock) .tab.active .tab-name")).toHaveText("Ideas");
  await expect(page.locator(".pane:not(.dock) .cm-content")).toContainText("STACKEDIT");
  // Re-stack → the 2nd column reloads the SAVED content from disk.
  await page.locator(".pane:not(.dock) .tab-stack").click();
  await expect(page.locator(".stacked-col").nth(1).locator(".cm-content")).toContainText("STACKEDIT");
});

test("the status bar shows word count and a live cursor position", async ({ page }) => {
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await expect(page.locator(".status-bar")).toBeVisible();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await expect(page.locator(".status-bar")).toContainText("words");
  await page.locator(".pane .cm-content").click();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".status-bar")).toContainText(/Ln \d+, Col \d+/);
});

test("dragging a tab to a pane edge splits the pane and moves the tab", async ({ page }) => {
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await expect(page.locator(".pane:not(.dock) .tab")).toHaveCount(2);
  // Begin dragging the active tab → the edge drop-zones appear.
  await page.evaluate(() => {
    const tab = document.querySelector(".pane:not(.dock) .tab.active") as HTMLElement;
    (window as unknown as { __dt: DataTransfer }).__dt = new DataTransfer();
    tab.dispatchEvent(new DragEvent("dragstart", { dataTransfer: (window as unknown as { __dt: DataTransfer }).__dt, bubbles: true }));
  });
  await expect(page.locator(".pane:not(.dock) .pane-dropzone")).toHaveCount(1);
  // Drop it on the right edge.
  await page.evaluate(() => {
    const dt = (window as unknown as { __dt: DataTransfer }).__dt;
    const zone = document.querySelector(".pane:not(.dock) .pane-dropzone") as HTMLElement;
    const r = zone.getBoundingClientRect();
    const o = { dataTransfer: dt, clientX: r.left + r.width * 0.9, clientY: r.top + r.height * 0.5, bubbles: true, cancelable: true };
    zone.dispatchEvent(new DragEvent("dragover", o));
    zone.dispatchEvent(new DragEvent("drop", o));
  });
  await expect(page.locator(".pane:not(.dock)")).toHaveCount(2);
  await expect(page.locator(".cm-editor")).toHaveCount(2);
  await expect(page.locator(".pane-resizer")).toHaveCount(3);
  // The dragged "Ideas" tab is alone in the new (focused) split.
  await expect(page.locator(".pane.focused .tab")).toHaveCount(1);
  await expect(page.locator(".pane.focused .tab .tab-name")).toHaveText("Ideas");
});
