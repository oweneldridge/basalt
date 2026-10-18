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

const recordWrites = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __saved: string[]; __mockHook: (cmd: string, a: { content?: string }) => void };
    w.__saved = [];
    w.__mockHook = (cmd, a) => void (cmd === "write_canvas" && w.__saved.push(String(a.content)));
  });
const writes = (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as { __saved: string[] }).__saved.length);

test("a click that wobbles a pixel, or a drag back to where it began, isn't a move", async ({ page }) => {
  await recordWrites(page);
  const box = (await page.locator(".canvas-node", { hasText: "Node A" }).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 1, y + 1);
  await page.mouse.up();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y, { steps: 4 });
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(page.locator(".canvas-node")).toHaveText([/Node A/, /Node B/, /Node C/]);
  expect(await writes(page)).toBe(0);
  const after = (await page.locator(".canvas-node", { hasText: "Node A" }).boundingBox())!;
  expect([Math.round(after.x), Math.round(after.y)]).toEqual([Math.round(box.x), Math.round(box.y)]);
});

test("after a group is dragged its cards are still on top, to click and drag", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __mockExtraFiles: Record<string, string> }).__mockExtraFiles = {
      "Grouped.canvas": JSON.stringify({
        nodes: [
          { id: "g1", type: "group", label: "Box", x: -40, y: -60, width: 400, height: 260 },
          { id: "c1", type: "text", text: "Inside", x: 0, y: 0, width: 200, height: 80 },
        ],
        edges: [],
      }),
    };
  });
  await page.reload();
  await page.locator(".tree-row.attachment", { hasText: "Grouped" }).click();
  await expect(page.locator(".canvas-group")).toBeVisible();
  await recordWrites(page);
  const label = (await page.locator(".canvas-group-label").boundingBox())!;
  await page.mouse.move(label.x + 5, label.y + 5);
  await page.mouse.down();
  await page.mouse.move(label.x + 35, label.y + 5, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => writes(page)).toBeGreaterThan(0);
  const saved = await page.evaluate(() => {
    const s = (window as unknown as { __saved: string[] }).__saved;
    return (JSON.parse(s[s.length - 1]).nodes as { id: string }[]).map((n) => n.id);
  });
  expect(saved).toEqual(["g1", "c1"]);
  const card = (await page.locator(".canvas-node", { hasText: "Inside" }).boundingBox())!;
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".canvas-node")?.textContent ?? "", [card.x + card.width / 2, card.y + card.height / 2]);
  expect(hit).toContain("Inside");
});

const openCanvas = async (page: import("@playwright/test").Page, name: string, nodes: object[]) => {
  await page.addInitScript(
    ([name, nodes]) => {
      (window as unknown as { __mockExtraFiles: Record<string, string> }).__mockExtraFiles = {
        [`${name}.canvas`]: JSON.stringify({ nodes, edges: [] }),
      };
    },
    [name, nodes] as const,
  );
  await page.reload();
  await page.locator(".tree-row.attachment", { hasText: name }).click();
  await expect(page.locator(".canvas-node")).toHaveCount(nodes.length);
};
const savedIds = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __saved: string[] }).__saved;
    return s.length ? (JSON.parse(s[s.length - 1]).nodes as { id: string }[]).map((n) => n.id) : [];
  });
// The card a click on this group's label would land on.
const labelHits = async (page: import("@playwright/test").Page, label: string) => {
  const b = (await page.locator(".canvas-group-label", { hasText: label }).boundingBox())!;
  return page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".canvas-node")?.getAttribute("aria-label") ?? "", [b.x + 10, b.y + b.height / 2]);
};
const dragBy = async (page: import("@playwright/test").Page, from: { x: number; y: number }, dx: number, dy = 0) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
  await page.mouse.up();
};

test("a dragged group never covers a group inside it", async ({ page }) => {
  await openCanvas(page, "Nested", [
    { id: "outer", type: "group", label: "Outer", x: -40, y: -60, width: 520, height: 360 },
    { id: "inner", type: "group", label: "Inner", x: 20, y: 0, width: 260, height: 200 },
    { id: "c1", type: "text", text: "Card", x: 60, y: 60, width: 160, height: 60 },
  ]);
  await recordWrites(page);
  expect(await labelHits(page, "Inner")).toBe("Group: Inner");
  const outer = (await page.locator(".canvas-group-label", { hasText: "Outer" }).boundingBox())!;
  await dragBy(page, { x: outer.x + 5, y: outer.y + 5 }, 20);
  await expect.poll(() => savedIds(page)).toEqual(["outer", "inner", "c1"]);
  expect(await labelHits(page, "Inner")).toBe("Group: Inner");
});

test("a group dragged over a smaller one goes under it", async ({ page }) => {
  await openCanvas(page, "Over", [
    { id: "small", type: "group", label: "Small", x: 300, y: 0, width: 120, height: 80 },
    { id: "big", type: "group", label: "Big", x: -40, y: -60, width: 260, height: 200 },
    { id: "c1", type: "text", text: "Card", x: 500, y: 200, width: 160, height: 60 },
  ]);
  await recordWrites(page);
  const big = page.locator(".canvas-group", { hasText: "Big" });
  const k = (await big.boundingBox())!.width / 260;
  const label = (await page.locator(".canvas-group-label", { hasText: "Big" }).boundingBox())!;
  await dragBy(page, { x: label.x + 5, y: label.y + 5 }, 270 * k, 20 * k);
  await expect.poll(() => savedIds(page)).toEqual(["big", "small", "c1"]);
  expect(await labelHits(page, "Small")).toBe("Group: Small");
});
