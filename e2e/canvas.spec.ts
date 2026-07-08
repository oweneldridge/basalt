import { test, expect } from "@playwright/test";

// Canvas multi-select — drives the real CanvasView against the mock vault's
// Board.canvas fixture (3 text nodes). Needs the full App + a vault, so only
// the app harness can exercise it.
test.beforeEach(async ({ page }) => {
  await page.goto("/app-harness.html");
  // The canvas may already be open (persisted workspace) or need opening.
  if ((await page.locator(".canvas-view").count()) === 0) {
    await page.locator(".tree-row.attachment", { hasText: "Board.canvas" }).click();
  }
  await expect(page.locator(".canvas-view")).toBeVisible();
  await expect(page.locator(".canvas-node")).toHaveCount(3);
});

test("shift-click selects multiple nodes and drag moves them together", async ({ page }) => {
  const nodes = page.locator(".canvas-node");
  const a0 = (await nodes.nth(0).boundingBox())!;
  const b0 = (await nodes.nth(1).boundingBox())!;
  await nodes.nth(0).click();
  await nodes.nth(1).click({ modifiers: ["Shift"] });
  await expect(page.locator(".canvas-selcount")).toHaveText("2 selected");
  // Drag node 0 → both move by the same delta.
  await page.mouse.move(a0.x + a0.width / 2, a0.y + a0.height / 2);
  await page.mouse.down();
  await page.mouse.move(a0.x + a0.width / 2 + 90, a0.y + a0.height / 2, { steps: 6 });
  await page.mouse.up();
  const a1 = (await page.locator(".canvas-node").nth(0).boundingBox())!;
  const b1 = (await page.locator(".canvas-node").nth(1).boundingBox())!;
  expect(Math.round(a1.x - a0.x)).toBeGreaterThan(70);
  expect(Math.round(b1.x - b0.x)).toBeGreaterThan(70); // moved as a group
});

test("delete removes the whole selection", async ({ page }) => {
  const nodes = page.locator(".canvas-node");
  await nodes.nth(0).click();
  await nodes.nth(1).click({ modifiers: ["Shift"] });
  await expect(page.locator(".canvas-selcount")).toHaveText("2 selected");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator(".canvas-view").press("Delete");
  await expect(page.locator(".canvas-node")).toHaveCount(1);
});

test("right-click context menu: duplicate a node and add a card", async ({ page }) => {
  await page.locator(".canvas-node").nth(1).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Duplicate" }).click();
  await expect(page.locator(".canvas-node")).toHaveCount(4);
  await expect(page.locator(".ctx-menu")).toHaveCount(0);
  const view = (await page.locator(".canvas-view").boundingBox())!;
  await page.mouse.click(view.x + 20, view.y + view.height - 20, { button: "right" });
  await page.locator(".ctx-item", { hasText: "Add card here" }).click();
  await expect(page.locator(".canvas-node")).toHaveCount(5);
});
