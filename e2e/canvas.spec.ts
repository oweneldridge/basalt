import { test, expect } from "@playwright/test";

// Canvas multi-select — drives the real CanvasView against the mock vault's
// Board.canvas fixture (3 text nodes). Needs the full App + a vault, so only
// the app harness can exercise it.
test.beforeEach(async ({ page }) => {
  await page.goto("/app-harness.html");
  // The canvas may already be open (persisted workspace) or need opening.
  if ((await page.locator(".canvas-view").count()) === 0) {
    await page.locator(".tree-row.attachment", { hasText: "Board" }).click();
  }
  await expect(page.locator(".canvas-view")).toBeVisible();
  await expect(page.locator(".canvas-node")).toHaveCount(3);
});

test("shift-click selects multiple nodes and drag moves them together", async ({ page }) => {
  const node = (t: string) => page.locator(".canvas-node", { hasText: t });
  const a0 = (await node("Node A").boundingBox())!;
  const b0 = (await node("Node B").boundingBox())!;
  await node("Node A").click();
  await node("Node B").click({ modifiers: ["Shift"] });
  await expect(page.locator(".canvas-selcount")).toHaveText("2 selected");
  // Drag node A → both move by the same delta.
  await page.mouse.move(a0.x + a0.width / 2, a0.y + a0.height / 2);
  await page.mouse.down();
  await page.mouse.move(a0.x + a0.width / 2 + 90, a0.y + a0.height / 2, { steps: 6 });
  await page.mouse.up();
  const a1 = (await node("Node A").boundingBox())!;
  const b1 = (await node("Node B").boundingBox())!;
  expect(Math.round(a1.x - a0.x)).toBeGreaterThan(70);
  expect(Math.round(b1.x - b0.x)).toBeGreaterThan(70); // moved as a group
});

test("a dragged card is saved last, as Obsidian brings it to the front", async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as { __saved: string[]; __mockHook: (cmd: string, a: { content?: string }) => void };
    w.__saved = [];
    w.__mockHook = (cmd, a) => void (cmd === "write_canvas" && w.__saved.push(String(a.content)));
  });
  const box = (await page.locator(".canvas-node", { hasText: "Node A" }).boundingBox())!;
  await page.locator(".canvas-node", { hasText: "Node B" }).click();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".canvas-node")).toHaveText([/Node B/, /Node C/, /Node A/]);
  const ids = () =>
    page.evaluate(() => {
      const saved = (window as unknown as { __saved: string[] }).__saved;
      return saved.length ? (JSON.parse(saved[saved.length - 1]).nodes as { id: string }[]).map((n) => n.id) : [];
    });
  await expect.poll(ids).toEqual(["a2", "a3", "a1"]);
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

test("cards work from the keyboard: focus selects, arrows move, Enter edits, Delete removes", async ({ page }) => {
  const cards = page.getByRole("group").filter({ has: page.locator(".canvas-node-content") });
  await expect(cards).toHaveCount(3);
  const first = page.locator(".canvas-node").first();
  await expect(first).toHaveAttribute("aria-roledescription", "card");
  await expect(first).toHaveAttribute("aria-label", /^Text: /);
  await first.focus();
  const box0 = (await first.boundingBox())!;
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  const box1 = (await first.boundingBox())!;
  expect(Math.round(box1.x - box0.x)).toBeGreaterThan(5);
  expect(Math.round(box1.y - box0.y)).toBeGreaterThan(Math.round(box1.x - box0.x));
  await page.keyboard.press("Enter");
  const input = page.locator(".canvas-text-input");
  await expect(input).toBeFocused();
  await page.keyboard.type("Typed by keyboard");
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(first).toBeFocused();
  await expect(first).toContainText("Typed by keyboard");
  await page.keyboard.press("Delete");
  await expect(page.locator(".canvas-node")).toHaveCount(2);
});
