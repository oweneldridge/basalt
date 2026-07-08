import { test, expect } from "@playwright/test";

// Movable views/leaves (Option A). A view (Outline) can live as a tab in a pane
// alongside notes, renders the last active note's content, and persists.
test("a view can be opened as a tab, renders, and survives reload", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();

  // Open the Outline as a movable view tab.
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").first().fill("Open outline in a new tab");
  await page.keyboard.press("Enter");

  await expect(page.locator(".pane:not(.dock) .tab.view-tab", { hasText: "Outline" })).toHaveCount(1);
  await expect(page.locator(".pane:not(.dock) .leaf-view")).toContainText("Welcome"); // outline of the active note
  await expect(page.locator(".pane:not(.dock) .cm-editor")).toHaveCount(0); // view active, not the editor

  // Switching back to the note restores the editor.
  await page.locator(".pane:not(.dock) .tab", { hasText: "Welcome" }).click();
  await expect(page.locator(".pane:not(.dock) .cm-editor")).toHaveCount(1);

  // The view tab persists across a reload.
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.locator(".pane:not(.dock) .tab.view-tab", { hasText: "Outline" })).toHaveCount(1);
});

test("a fresh vault has a right dock of view leaves that tracks the active note", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.waitForSelector(".sidebar");
  // The dock is a pane in the tree holding the built-in views as tabs.
  await expect(page.locator(".pane.dock-right .tab.view-tab .tab-name")).toContainText([
    "Backlinks",
    "Outline",
    "Properties",
    "Tags",
    "Bookmarks",
  ]);
  // Its Outline tracks the active note.
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await page.locator(".pane.dock-right .tab.view-tab", { hasText: "Outline" }).click();
  await expect(page.locator(".pane.dock-right .leaf-view")).toContainText("Welcome");
  // Toggling the right sidebar removes the dock pane.
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").first().fill("Toggle right sidebar");
  await page.keyboard.press("Enter");
  await expect(page.locator(".pane.dock-right")).toHaveCount(0);
});

test("a view tab can be dragged across regions (dock → editor) and to a split", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".sidebar");
  await page.locator(".pane.dock-left .tree-row.file", { hasText: "Welcome" }).click();
  await expect(page.locator(".pane:not(.dock) .cm-editor")).toBeVisible();

  // Drag the Outline tab from the right dock onto the editor pane's tab bar.
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".pane.dock-right .tab.view-tab")].find((t) => t.textContent!.includes("Outline"))!;
    const bar = document.querySelector(".pane:not(.dock) .tab-bar") as HTMLElement;
    const dt = new DataTransfer();
    tab.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
    const r = bar.getBoundingClientRect();
    const o = { dataTransfer: dt, clientX: r.right - 10, clientY: r.top + r.height / 2, bubbles: true, cancelable: true };
    bar.dispatchEvent(new DragEvent("dragover", o));
    bar.dispatchEvent(new DragEvent("drop", o));
    tab.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
  });
  // It left the dock and joined the editor pane's tabs.
  await expect(page.locator(".pane:not(.dock) .tab.view-tab", { hasText: "Outline" })).toHaveCount(1);
  await expect(page.locator(".pane.dock-right .tab.view-tab", { hasText: "Outline" })).toHaveCount(0);

  // Drag the Backlinks tab from the dock onto the editor's bottom edge → new split leaf.
  const before = await page.locator(".pane:not(.dock)").count();
  await page.evaluate(async () => {
    const tab = [...document.querySelectorAll(".pane.dock-right .tab.view-tab")].find((t) => t.textContent!.includes("Backlinks"))!;
    const dt = new DataTransfer();
    tab.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const zone = document.querySelector(".pane:not(.dock) .pane-dropzone") as HTMLElement;
    const r = zone.getBoundingClientRect();
    const o = { dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.bottom - 8, bubbles: true, cancelable: true };
    zone.dispatchEvent(new DragEvent("dragover", o));
    zone.dispatchEvent(new DragEvent("drop", o));
  });
  await expect(page.locator(".pane:not(.dock)")).toHaveCount(before + 1);
  await expect(page.locator(".pane:not(.dock) .tab.view-tab", { hasText: "Backlinks" })).toHaveCount(1);
});

test("move a note tab to a new window (menu records the call + closes the tab)", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => { localStorage.clear(); (window as unknown as { __newWindows: unknown[] }).__newWindows = []; });
  await page.reload();
  await page.locator(".pane.dock-left .tree-row.file", { hasText: "Welcome" }).click();
  await page.locator(".pane.dock-left .tree-row.file", { hasText: "Ideas" }).click();
  await expect(page.locator(".pane:not(.dock) .tab")).toHaveCount(2);
  await page.locator(".pane:not(.dock) .tab", { hasText: "Ideas" }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to new window" }).click();
  // The backend was asked to open a window for this vault + note, and the tab closed here.
  const calls = await page.evaluate(() => (window as unknown as { __newWindows: { vault: string; note: string }[] }).__newWindows);
  expect(calls).toEqual([{ vault: "/mock/vault", note: "Ideas.md" }]);
  await expect(page.locator(".pane:not(.dock) .tab .tab-name")).toHaveText(["Welcome"]);
  // A view tab does NOT offer "Move to new window".
  await page.locator(".pane.dock-right .tab.view-tab").first().click({ button: "right" });
  await expect(page.locator(".ctx-menu .ctx-item", { hasText: "Move to new window" })).toHaveCount(0);
});

test("a window launched with ?vault=&note= opens that note", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/app-harness.html?vault=" + encodeURIComponent("/mock/vault") + "&note=" + encodeURIComponent("Ideas.md"));
  await expect(page.locator(".pane:not(.dock) .cm-editor")).toBeVisible();
  await expect(page.locator(".pane:not(.dock) .tab.active .tab-name")).toHaveText("Ideas");
});

test("a closed dock stays closed across reload (v3 respects the saved layout)", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".sidebar");
  await expect(page.locator(".pane.dock-left")).toHaveCount(1);
  // Close the left dock.
  await page.locator('[title^="Toggle sidebar"]').click();
  await expect(page.locator(".pane.dock-left")).toHaveCount(0);
  await page.waitForTimeout(400); // let the workspace save
  await page.reload();
  await page.waitForTimeout(400);
  // It stays closed; the right dock is untouched.
  await expect(page.locator(".pane.dock-left")).toHaveCount(0);
  await expect(page.locator(".pane.dock-right")).toHaveCount(1);
});

test("Open in new window keeps the note open here; Reset restores the default layout", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => { localStorage.clear(); (window as unknown as { __newWindows: unknown[] }).__newWindows = []; });
  await page.reload();
  await page.locator(".pane.dock-left .tree-row.file", { hasText: "Ideas" }).click();

  // "Open in new window" from the file menu — opens a window but leaves the tab here.
  await page.locator(".pane.dock-left .tree-row.file", { hasText: "Ideas" }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Open in new window" }).click();
  const calls = await page.evaluate(() => (window as unknown as { __newWindows: { vault: string; note: string }[] }).__newWindows);
  expect(calls).toEqual([{ vault: "/mock/vault", note: "Ideas.md" }]);
  await expect(page.locator(".pane:not(.dock) .tab", { hasText: "Ideas" })).toHaveCount(1);

  // Reset to default layout: close the left dock, then reset → both docks back, note kept.
  await page.locator('[title^="Toggle sidebar"]').click();
  await expect(page.locator(".pane.dock-left")).toHaveCount(0);
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").first().fill("Reset to default layout");
  await page.keyboard.press("Enter");
  await expect(page.locator(".pane.dock-left")).toHaveCount(1);
  await expect(page.locator(".pane.dock-right")).toHaveCount(1);
  await expect(page.locator(".pane:not(.dock) .tab.active .tab-name")).toHaveText("Ideas");
});
