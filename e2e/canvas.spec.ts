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

const openCanvas = async (page: import("@playwright/test").Page, name: string, nodes: object[], edges: object[] = []) => {
  await page.addInitScript(
    ([name, nodes, edges]) => {
      (window as unknown as { __mockExtraFiles: Record<string, string> }).__mockExtraFiles = {
        [`${name}.canvas`]: JSON.stringify({ nodes, edges }),
      };
    },
    [name, nodes, edges] as const,
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

test("a group resized over a smaller one goes under it", async ({ page }) => {
  await openCanvas(page, "Grow", [
    { id: "small", type: "group", label: "Small", x: 200, y: 20, width: 100, height: 80 },
    { id: "big", type: "group", label: "Big", x: 0, y: 0, width: 150, height: 150 },
    { id: "c", type: "text", text: "Far", x: 600, y: 300, width: 100, height: 60 },
  ]);
  await recordWrites(page);
  const big = page.locator('[aria-label="Group: Big"]');
  await page.locator(".canvas-group-label", { hasText: "Big" }).click();
  const k = (await big.boundingBox())!.width / 150;
  const h = (await big.locator(".canvas-handle").boundingBox())!;
  await dragBy(page, { x: h.x + 5, y: h.y + 5 }, 250 * k, 50 * k);
  await expect.poll(() => savedIds(page)).toEqual(["big", "small", "c"]);
  expect(await labelHits(page, "Small")).toBe("Group: Small");
});

test("a group moved over a bigger one with the arrow keys goes on top of it", async ({ page }) => {
  await openCanvas(page, "KeyIn", [
    { id: "small", type: "group", label: "Small", x: 0, y: 0, width: 100, height: 80 },
    { id: "big", type: "group", label: "Big", x: 200, y: -100, width: 400, height: 300 },
  ]);
  await recordWrites(page);
  await page.locator('[aria-label="Group: Small"]').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => savedIds(page)).toEqual(["big", "small"]);
  expect(await labelHits(page, "Small")).toBe("Group: Small");
});

test("a duplicated group goes under the smaller ones it covers", async ({ page }) => {
  await openCanvas(page, "Twin", [
    { id: "big", type: "group", label: "Big", x: 0, y: 0, width: 150, height: 150 },
    { id: "small", type: "group", label: "Small", x: 50, y: 50, width: 60, height: 60 },
  ]);
  await recordWrites(page);
  await page.locator(".canvas-group-label", { hasText: "Big" }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Duplicate" }).click();
  await expect(page.locator(".canvas-group")).toHaveCount(3);
  await expect.poll(async () => (await savedIds(page)).at(-1)).toBe("small");
  expect(await labelHits(page, "Small")).toBe("Group: Small");
});

test("moving a group moves what's inside it, by mouse or keyboard", async ({ page }) => {
  await openCanvas(page, "Holds", [
    { id: "outer", type: "group", label: "Outer", x: -40, y: -60, width: 520, height: 360 },
    { id: "inner", type: "group", label: "Inner", x: 20, y: 0, width: 260, height: 200 },
    { id: "c1", type: "text", text: "In", x: 60, y: 60, width: 160, height: 60 },
    { id: "c2", type: "text", text: "Half", x: 400, y: 0, width: 160, height: 60 },
    { id: "c3", type: "text", text: "Out", x: 700, y: 0, width: 160, height: 60 },
  ]);
  await recordWrites(page);
  const xy = () =>
    page.evaluate(() => {
      const s = (window as unknown as { __saved: string[] }).__saved;
      const nodes = JSON.parse(s[s.length - 1]).nodes as { id: string; x: number; y: number }[];
      return Object.fromEntries(nodes.map((n) => [n.id, [n.x, n.y]]));
    });
  const k = (await page.locator(".canvas-group", { hasText: "Outer" }).boundingBox())!.width / 520;
  const label = (await page.locator(".canvas-group-label", { hasText: "Outer" }).boundingBox())!;
  await dragBy(page, { x: label.x + 5, y: label.y + 5 }, 50 * k, 30 * k);
  await expect.poll(() => writes(page)).toBe(1);
  const moved = await xy();
  const [dx, dy] = [moved.outer[0] + 40, moved.outer[1] + 60];
  expect(dx).toBeGreaterThan(30);
  expect(moved).toEqual({ outer: [-40 + dx, -60 + dy], inner: [20 + dx, dy], c1: [60 + dx, 60 + dy], c2: [400, 0], c3: [700, 0] });
  // The inner group alone takes only its own card, and arrows do the same.
  await page.locator(".canvas-node", { hasText: "Inner" }).first().focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => writes(page)).toBe(2);
  expect(await xy()).toEqual({ ...moved, inner: [40 + dx, dy], c1: [80 + dx, 60 + dy] });
});

// Sends a pointer event the browser itself would send for a touch or pen: a
// cancel, lost capture, or a second finger.
const send = (
  page: import("@playwright/test").Page,
  type: string,
  at: string,
  init: { second?: boolean; x?: number; y?: number; movedTo?: { x: number; y: number } } = {},
) =>
  page.evaluate(
    ([type, at, init]) => {
      const w = window as unknown as { __pid: number; __pressed: EventTarget };
      const el = at === "window" ? window : at === "pressed" ? w.__pressed : document.querySelector(at)!;
      const pointerId = init.second ? w.__pid + 7 : w.__pid;
      // A last move in the same frame, so the cancel lands before it's drawn.
      if (init.movedTo) window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId, clientX: init.movedTo.x, clientY: init.movedTo.y }));
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, clientX: init.x ?? 0, clientY: init.y ?? 0 }));
    },
    [type, at, init] as const,
  );
const watchPointer = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    window.addEventListener(
      "pointerdown",
      (e) => {
        const w = window as unknown as { __pid: number; __pressed: EventTarget };
        w.__pid = e.pointerId;
        if (e.isTrusted) w.__pressed = e.target!;
      },
      true,
    ),
  );
const nodeA = '.canvas-node[aria-label="Text: Node A"]';

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });
  test("a card follows a finger, and the browser doesn't take the drag to scroll", async ({ page }) => {
    await recordWrites(page);
    const a = page.locator(nodeA);
    const box = (await a.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const at = (dx: number) => [{ x: box.x + 20 + dx, y: box.y + box.height / 2, id: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(0) });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(i * 10) });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => writes(page)).toBe(1);
    expect(Math.round((await a.boundingBox())!.x - box.x)).toBe(80);
  });

  for (const where of ["Node B", "empty space", "the resize handle", "a connection anchor"]) {
    test(`a second finger on ${where} mid-drag changes nothing`, async ({ page }) => {
      await recordWrites(page);
      const a = page.locator(nodeA);
      const b = page.locator(".canvas-node", { hasText: "Node B" });
      const box = (await a.boundingBox())!;
      const b0 = (await b.boundingBox())!;
      const view = (await page.locator(".canvas-view").boundingBox())!;
      const transform = await page.locator(".canvas-world").evaluate((el) => (el as HTMLElement).style.transform);
      const cdp = await page.context().newCDPSession(page);
      const one = (dx: number) => ({ x: box.x + 20 + dx, y: box.y + box.height / 2, id: 1 });
      const touch = (type: string, touchPoints: object[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
      await touch("touchStart", [one(0)]);
      for (let i = 1; i <= 4; i++) await touch("touchMove", [one(i * 10)]);
      await expect.poll(async () => Math.round((await a.boundingBox())!.x - box.x)).toBe(40);
      const spot = async () => {
        if (where === "Node B") return { x: b0.x + 10, y: b0.y + 10 };
        if (where === "empty space") return { x: view.x + 10, y: view.y + view.height - 10 };
        const r = (await a.locator(where === "the resize handle" ? ".canvas-handle" : ".canvas-anchor-bottom").boundingBox())!;
        // The card clips each one's outer half.
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 - 3 };
      };
      const p = await spot();
      const two = (d: number) => ({ x: p.x + d, y: p.y + d, id: 2 });
      await touch("touchStart", [one(40), two(0)]);
      for (let i = 1; i <= 4; i++) await touch("touchMove", [one(40), two(i * 30)]);
      await page.waitForTimeout(100);
      expect(Math.round((await a.boundingBox())!.x - box.x)).toBe(40);
      expect((await a.boundingBox())!.width).toBe(box.width);
      await expect(page.locator(".canvas-edges path[stroke-dasharray]")).toHaveCount(0);
      await touch("touchMove", [one(40)]);
      for (let i = 5; i <= 6; i++) await touch("touchMove", [one(i * 10)]);
      await touch("touchEnd", []);
      await expect.poll(() => writes(page)).toBe(1);
      expect(Math.round((await a.boundingBox())!.x - box.x)).toBe(60);
      expect((await b.boundingBox())!).toEqual(b0);
      expect(await page.locator(".canvas-world").evaluate((el) => (el as HTMLElement).style.transform)).toBe(transform);
      expect(await b.evaluate((el) => (el as HTMLElement).style.boxShadow)).toBe("");
      expect(await a.evaluate((el) => (el as HTMLElement).style.boxShadow)).not.toBe("");
    });
  }
});

for (const how of ["pointercancel", "lostpointercapture"]) {
  test(`a card drag ended by ${how} puts the card back and saves nothing`, async ({ page }) => {
    await recordWrites(page);
    await watchPointer(page);
    const a = page.locator(nodeA);
    const box = (await a.boundingBox())!;
    // Pressed on the card's text, which re-renders as the card moves.
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 4 });
    await expect.poll(async () => (await a.boundingBox())!.x).toBeGreaterThan(box.x + 30);
    // The browser sends a lost capture to the element that had it.
    await send(page, how, how === "pointercancel" ? "window" : "pressed", { movedTo: { x: box.x + 120, y: box.y + box.height / 2 } });
    await page.mouse.move(box.x + 160, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await a.boundingBox())!.x)).toBe(Math.round(box.x));
    expect(await writes(page)).toBe(0);
    // Nothing is left stuck: the next drag moves and saves.
    await dragBy(page, { x: box.x + 20, y: box.y + box.height / 2 }, 60);
    await expect.poll(() => writes(page)).toBe(1);
  });
}

test("another pointer's moves, lift or cancel don't touch a card's drag", async ({ page }) => {
  await recordWrites(page);
  await watchPointer(page);
  const a = page.locator(nodeA);
  const b = page.locator(".canvas-node", { hasText: "Node B" });
  const box = (await a.boundingBox())!;
  const b0 = (await b.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 4 });
  await send(page, "pointerdown", '.canvas-node[aria-label="Text: Node B"]', { second: true, x: b0.x + 10, y: b0.y + 10 });
  await send(page, "pointermove", "window", { second: true, x: box.x + 400, y: box.y + 300 });
  await page.waitForTimeout(100);
  expect(Math.round((await a.boundingBox())!.x - box.x)).toBe(40);
  await send(page, "pointerup", "window", { second: true, x: box.x + 400, y: box.y + 300 });
  await send(page, "pointercancel", "window", { second: true });
  await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 2 });
  await page.mouse.up();
  await expect.poll(() => writes(page)).toBe(1);
  const after = (await a.boundingBox())!;
  expect(Math.round(after.x - box.x)).toBe(60);
  expect(Math.round(after.y - box.y)).toBe(0);
  expect((await b.boundingBox())!).toEqual(b0);
  await expect(page.locator(".canvas-selcount")).toHaveCount(0);
  expect(await b.evaluate((el) => (el as HTMLElement).style.boxShadow)).toBe("");
});

test("a cancelled pan, rubber band, resize or connection stops where it was", async ({ page }) => {
  await recordWrites(page);
  await watchPointer(page);
  const view = (await page.locator(".canvas-view").boundingBox())!;
  const world = page.locator(".canvas-world");
  const transform = () => world.evaluate((el) => (el as HTMLElement).style.transform);
  // Pan from an empty corner; a second finger doesn't move it, a cancel ends it.
  const x = view.x + 10;
  const y = view.y + view.height - 10;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y - 5, { steps: 4 });
  const panned = await transform();
  await send(page, "pointermove", "window", { second: true, x: x + 300, y: y - 300 });
  expect(await transform()).toBe(panned);
  await send(page, "pointercancel", "window");
  await page.mouse.move(x + 120, y - 40, { steps: 4 });
  expect(await transform()).toBe(panned);
  await page.mouse.up();
  await expect(page.locator(".canvas-view")).toHaveCSS("cursor", "grab");
  // A rubber band over the cards, cancelled, selects nothing.
  await page.keyboard.down("Shift");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(view.x + view.width - 10, view.y + 10, { steps: 4 });
  await expect(page.locator(".canvas-band")).toHaveCount(1);
  await send(page, "pointercancel", "window");
  await expect(page.locator(".canvas-band")).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.locator(".canvas-selcount")).toHaveCount(0);
  // A resize, cancelled, goes back to the size it had.
  const a = page.locator(nodeA);
  await a.click();
  const size = (await a.boundingBox())!;
  const handle = (await a.locator(".canvas-handle").boundingBox())!;
  await page.mouse.move(handle.x + 5, handle.y + 5);
  await page.mouse.down();
  await page.mouse.move(handle.x + 65, handle.y + 45, { steps: 4 });
  await expect.poll(async () => (await a.boundingBox())!.width).toBeGreaterThan(size.width + 30);
  await send(page, "pointercancel", "window", { movedTo: { x: handle.x + 85, y: handle.y + 55 } });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await a.boundingBox())!.width)).toBe(Math.round(size.width));
  // A connection, cancelled over another card, isn't made.
  const anchor = (await a.locator(".canvas-anchor-right").boundingBox())!;
  const b = (await page.locator(".canvas-node", { hasText: "Node B" }).boundingBox())!;
  await page.mouse.move(anchor.x + anchor.width / 2 - 3, anchor.y + anchor.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await expect(page.locator(".canvas-edges path[stroke-dasharray]")).toHaveCount(1);
  await send(page, "pointercancel", "window");
  await expect(page.locator(".canvas-edges path[stroke-dasharray]")).toHaveCount(0);
  await page.mouse.up();
  expect(await writes(page)).toBe(0);
});

test("a selected card's anchors and resize handle can be pressed in full", async ({ page }) => {
  await page.locator(".canvas-node", { hasText: "Node A" }).click();
  // Each one's middle, and a point beyond it, away from the card.
  const out: [string, number, number][] = [[".canvas-anchor-top", 0, -3], [".canvas-anchor-right", 3, 0], [".canvas-anchor-bottom", 0, 3], [".canvas-anchor-left", -3, 0], [".canvas-handle", 3, 3]];
  for (const [sel, dx, dy] of out) {
    const r = (await page.locator(".canvas-node", { hasText: "Node A" }).locator(sel).boundingBox())!;
    const [cx, cy] = [r.x + r.width / 2, r.y + r.height / 2];
    for (const [x, y] of [[cx, cy], [cx + dx, cy + dy]]) {
      expect(await page.evaluate(([x, y, sel]) => !!document.elementFromPoint(x as number, y as number)?.closest(sel as string), [x, y, sel] as const), `${sel} at ${x},${y}`).toBe(true);
    }
  }
});

type Saved = { nodes: { id: string; x: number; y: number; width: number; height: number; text?: string; color?: string }[]; edges: { id: string }[] };
const lastSaved = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __saved: string[] }).__saved;
    return s.length ? (JSON.parse(s[s.length - 1]) as Saved) : null;
  });
const savedNode = async (page: import("@playwright/test").Page, id: string) => (await lastSaved(page))?.nodes.find((n) => n.id === id);
const undo = (page: import("@playwright/test").Page) => page.keyboard.press("ControlOrMeta+z");
const redo = (page: import("@playwright/test").Page) => page.keyboard.press("ControlOrMeta+Shift+z");
const onCanvas = (page: import("@playwright/test").Page) => page.evaluate(() => !!document.activeElement?.closest(".canvas-view"));
const selectedCount = (page: import("@playwright/test").Page) =>
  page.locator(".canvas-node").evaluateAll((els) => els.filter((el) => (el as HTMLElement).style.boxShadow !== "").length);

test.describe("undo and redo", () => {
  test("a drag of two cards is one step, and each undo and redo is saved", async ({ page }) => {
    await recordWrites(page);
    const a = page.locator(nodeA);
    const b = page.locator(".canvas-node", { hasText: "Node B" });
    await a.click();
    await b.click({ modifiers: ["Shift"] });
    const a0 = (await a.boundingBox())!;
    await dragBy(page, { x: a0.x + 20, y: a0.y + a0.height / 2 }, 60, 30);
    await expect.poll(() => writes(page)).toBe(1);
    const moved = await lastSaved(page);
    const a1 = moved.nodes.find((n) => n.id === "a1")!;
    expect(a1.x).toBeGreaterThan(20);
    expect(moved.nodes.find((n) => n.id === "a2")!.x).toBe(240 + a1.x);
    await undo(page);
    await expect.poll(() => writes(page)).toBe(2);
    expect((await lastSaved(page))!.nodes.map((n) => [n.id, n.x, n.y])).toEqual([["a1", 0, 0], ["a2", 240, 0], ["a3", 0, 160]]);
    expect(Math.round((await a.boundingBox())!.x)).toBe(Math.round(a0.x));
    // What moved is still selected, and the keys still reach the canvas.
    expect(await selectedCount(page)).toBe(2);
    expect(await onCanvas(page)).toBe(true);
    await undo(page);
    await page.waitForTimeout(700);
    expect(await writes(page)).toBe(2);
    await redo(page);
    await expect.poll(() => writes(page)).toBe(3);
    expect(await lastSaved(page))!.toEqual(moved);
  });

  test("a group's move, with what's inside it, is one step", async ({ page }) => {
    await openCanvas(page, "Holds", [
      { id: "outer", type: "group", label: "Outer", x: -40, y: -60, width: 520, height: 360 },
      { id: "c1", type: "text", text: "In", x: 60, y: 60, width: 160, height: 60 },
      { id: "c3", type: "text", text: "Out", x: 700, y: 0, width: 160, height: 60 },
    ]);
    await recordWrites(page);
    const k = (await page.locator(".canvas-group").boundingBox())!.width / 520;
    const label = (await page.locator(".canvas-group-label").boundingBox())!;
    await dragBy(page, { x: label.x + 5, y: label.y + 5 }, 50 * k, 30 * k);
    await expect.poll(() => writes(page)).toBe(1);
    const moved = await lastSaved(page);
    expect((await savedNode(page, "c1"))?.x).toBeGreaterThan(90);
    await undo(page);
    await expect.poll(() => writes(page)).toBe(2);
    expect((await lastSaved(page))!.nodes.map((n) => [n.id, n.x, n.y])).toEqual([["outer", -40, -60], ["c1", 60, 60], ["c3", 700, 0]]);
    await redo(page);
    await expect.poll(() => writes(page)).toBe(3);
    expect(await lastSaved(page))!.toEqual(moved);
  });

  test("a resize undoes and redoes", async ({ page }) => {
    await recordWrites(page);
    const a = page.locator(nodeA);
    await a.click();
    const handle = (await a.locator(".canvas-handle").boundingBox())!;
    await dragBy(page, { x: handle.x + 5, y: handle.y + 5 }, 60, 40);
    await expect.poll(() => writes(page)).toBe(1);
    const grown = await savedNode(page, "a1");
    expect(grown.width).toBeGreaterThan(190);
    await undo(page);
    await expect.poll(() => writes(page)).toBe(2);
    expect(await savedNode(page, "a1"))?.toMatchObject({ width: 160, height: 60 });
    await redo(page);
    await expect.poll(() => writes(page)).toBe(3);
    expect(await savedNode(page, "a1"))?.toMatchObject({ width: grown.width, height: grown.height });
  });

  test("a new card goes on undo, the selection with it, and focus stays on the canvas", async ({ page }) => {
    await recordWrites(page);
    await page.locator('button[title="Add a card"]').click();
    await expect(page.locator(".canvas-text-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".canvas-node")).toHaveCount(4);
    await expect(page.locator(".canvas-colors")).toHaveCount(1);
    await expect.poll(() => writes(page)).toBe(1);
    await undo(page);
    await expect(page.locator(".canvas-node")).toHaveCount(3);
    await expect(page.locator(".canvas-colors")).toHaveCount(0);
    await expect.poll(() => onCanvas(page)).toBe(true);
    await expect.poll(() => writes(page)).toBe(2);
    expect((await lastSaved(page))!.nodes.map((n) => n.id)).toEqual(["a1", "a2", "a3"]);
    await redo(page);
    await expect(page.locator(".canvas-node")).toHaveCount(4);
    await expect.poll(() => writes(page)).toBe(3);
    expect((await lastSaved(page))!.nodes).toHaveLength(4);
  });

  test("a delete of two cards comes back whole, with the connection it took", async ({ page }) => {
    await openCanvas(
      page,
      "Linked",
      [
        { id: "p", type: "text", text: "P", x: 0, y: 0, width: 160, height: 60 },
        { id: "q", type: "text", text: "Q", x: 300, y: 0, width: 160, height: 60 },
        { id: "r", type: "text", text: "R", x: 0, y: 200, width: 160, height: 60 },
      ],
      [{ id: "e1", fromNode: "p", fromSide: "right", toNode: "q", toSide: "left" }],
    );
    await recordWrites(page);
    const edges = page.locator(".canvas-edges > g");
    await expect(edges).toHaveCount(1);
    await page.locator('.canvas-node[aria-label="Text: P"]').click();
    await page.locator('.canvas-node[aria-label="Text: R"]').click({ modifiers: ["Shift"] });
    await page.keyboard.press("Delete");
    await expect(page.locator(".canvas-node")).toHaveCount(1);
    await expect(edges).toHaveCount(0);
    await undo(page);
    await expect(page.locator(".canvas-node")).toHaveCount(3);
    await expect(edges).toHaveCount(1);
    await expect.poll(() => writes(page)).toBeGreaterThan(0);
    await expect.poll(async () => (await lastSaved(page))!.edges.map((e) => e.id)).toEqual(["e1"]);
    expect((await lastSaved(page))!.nodes.map((n) => n.id)).toEqual(["p", "q", "r"]);
    await redo(page);
    await expect(page.locator(".canvas-node")).toHaveCount(1);
    await expect.poll(async () => (await lastSaved(page))!.nodes.map((n) => n.id)).toEqual(["q"]);
  });

  test("a colour undoes and redoes, and picking the colour a card has isn't a step", async ({ page }) => {
    await recordWrites(page);
    await page.locator(nodeA).click();
    await page.locator('.canvas-color-dot[title="Color 1"]').click();
    await expect.poll(() => writes(page)).toBe(1);
    expect((await savedNode(page, "a1"))?.color).toBe("1");
    await page.locator('.canvas-color-dot[title="Color 1"]').click();
    await page.locator(nodeA).focus();
    await undo(page);
    await expect.poll(async () => (await savedNode(page, "a1"))?.color).toBeUndefined();
    await redo(page);
    await expect.poll(async () => (await savedNode(page, "a1"))?.color).toBe("1");
  });

  test("a connection undoes and redoes", async ({ page }) => {
    await recordWrites(page);
    const a = page.locator(nodeA);
    await a.click();
    const anchor = (await a.locator(".canvas-anchor-right").boundingBox())!;
    const b = (await page.locator(".canvas-node", { hasText: "Node B" }).boundingBox())!;
    await page.mouse.move(anchor.x + anchor.width / 2 - 3, anchor.y + anchor.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
    await page.mouse.up();
    const edges = page.locator(".canvas-edges > g");
    await expect(edges).toHaveCount(1);
    await expect.poll(() => writes(page)).toBe(1);
    const made = (await lastSaved(page))!.edges;
    await a.focus();
    await undo(page);
    await expect(edges).toHaveCount(0);
    await expect.poll(() => writes(page)).toBe(2);
    expect((await lastSaved(page))!.edges).toEqual([]);
    await redo(page);
    await expect(edges).toHaveCount(1);
    await expect.poll(() => writes(page)).toBe(3);
    expect((await lastSaved(page))!.edges).toEqual(made);
  });

  test("a card's text edit undoes and redoes", async ({ page }) => {
    await recordWrites(page);
    const a = page.locator(nodeA);
    await a.dblclick();
    await page.locator(".canvas-text-input").fill("Changed");
    await page.keyboard.press("Escape");
    await expect(page.locator(".canvas-node").first()).toContainText("Changed");
    await expect(page.locator(".canvas-node").first()).toBeFocused();
    await undo(page);
    await expect(page.locator(".canvas-node").first()).toContainText("Node A");
    await expect.poll(async () => (await savedNode(page, "a1"))?.text).toBe("Node A");
    await redo(page);
    await expect(page.locator(".canvas-node").first()).toContainText("Changed");
    await expect.poll(async () => (await savedNode(page, "a1"))?.text).toBe("Changed");
  });

  test("an edit after an undo leaves nothing to redo", async ({ page }) => {
    await recordWrites(page);
    const a = page.locator(nodeA);
    await a.focus();
    await page.keyboard.press("ArrowRight");
    await undo(page);
    await expect(page.locator('button[title="Redo"]')).toBeEnabled();
    await page.locator(".canvas-node", { hasText: "Node B" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator('button[title="Redo"]')).toBeDisabled();
    await expect.poll(async () => (await savedNode(page, "a2"))?.y).toBe(20);
    const before = await writes(page);
    await redo(page);
    await page.waitForTimeout(700);
    expect(await writes(page)).toBe(before);
    expect((await savedNode(page, "a1"))?.x).toBe(0);
  });

  test("while a card's text is edited the keys are its own", async ({ page }) => {
    await recordWrites(page);
    const a = page.locator(nodeA);
    await a.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => writes(page)).toBe(1);
    const b = page.locator(".canvas-node", { hasText: "Node B" });
    const input = page.locator(".canvas-text-input");
    await b.dblclick();
    await page.keyboard.press("End");
    await page.keyboard.type(" more");
    await undo(page);
    await expect(input).toBeFocused();
    await expect(input).not.toHaveValue("Node B more");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
    expect((await savedNode(page, "a1"))?.x).toBe(20);
    // Undone on the canvas, the text and then the move, and neither redo key
    // redoes from a card's editor.
    await a.focus();
    await undo(page);
    await undo(page);
    await expect.poll(async () => (await savedNode(page, "a1"))?.x).toBe(0);
    await b.dblclick();
    await redo(page);
    await page.keyboard.press("ControlOrMeta+y");
    await expect(input).toBeFocused();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
    expect((await savedNode(page, "a1"))?.x).toBe(0);
  });

  test("a change from outside starts a fresh history, so undo can't write over it", async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as { __saved: string[]; __outside?: string; __mockHook: (cmd: string, a: { content?: string; path?: string }) => unknown };
      w.__saved = [];
      w.__mockHook = (cmd, a) => {
        if (cmd === "write_canvas") return w.__saved.push(String(a.content)), { result: null };
        if (cmd === "read_note" && w.__outside && String(a.path).endsWith("/Board.canvas")) return { result: w.__outside };
      };
    });
    await page.locator(nodeA).focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => writes(page)).toBe(1);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const w = window as unknown as { __outside: string; __mockEmit: (n: string, p: unknown) => void };
      w.__outside = JSON.stringify({
        nodes: [
          { id: "a1", type: "text", text: "Outside", x: 500, y: 0, width: 160, height: 60 },
          { id: "a2", type: "text", text: "Node B", x: 240, y: 0, width: 160, height: 60 },
        ],
        edges: [],
      });
      w.__mockEmit("vault-rescan", null);
    });
    await expect(page.locator(".canvas-node")).toHaveCount(2);
    await expect(page.locator(nodeA)).toHaveCount(0);
    await expect(page.locator('button[title="Undo"]')).toBeDisabled();
    await page.locator(".canvas-node").first().focus();
    await undo(page);
    await page.waitForTimeout(700);
    expect(await writes(page)).toBe(1);
    await expect(page.locator(".canvas-node", { hasText: "Outside" })).toHaveCount(1);
    // A new edit undoes back to what came from outside, not past it.
    await page.locator(".canvas-node", { hasText: "Node B" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await savedNode(page, "a2"))?.y).toBe(20);
    await undo(page);
    await expect.poll(async () => (await lastSaved(page))!.nodes.map((n) => [n.id, n.text, n.x, n.y])).toEqual([["a1", "Outside", 500, 0], ["a2", "Node B", 240, 0]]);
  });

  test("an undo pressed mid-drag waits, and the drag keeps the edit before it", async ({ page }) => {
    await recordWrites(page);
    const a = page.locator(nodeA);
    await a.click();
    await page.locator('.canvas-color-dot[title="Color 2"]').click();
    await expect.poll(() => writes(page)).toBe(1);
    const box = (await a.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 4 });
    await undo(page);
    await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 2 });
    await page.mouse.up();
    await expect.poll(() => writes(page)).toBe(2);
    expect(await savedNode(page, "a1"))?.toMatchObject({ color: "2" });
    expect((await savedNode(page, "a1"))?.x).toBeGreaterThan(30);
  });

  test("the Undo and Redo buttons step through the edits", async ({ page }) => {
    await recordWrites(page);
    const undoBtn = page.locator('button[title="Undo"]');
    const redoBtn = page.locator('button[title="Redo"]');
    await expect(undoBtn).toBeDisabled();
    await expect(redoBtn).toBeDisabled();
    await page.locator(nodeA).focus();
    await page.keyboard.press("ArrowDown");
    await expect(undoBtn).toBeEnabled();
    await undoBtn.click();
    await expect.poll(async () => (await savedNode(page, "a1"))?.y).toBe(0);
    await expect(undoBtn).toBeDisabled();
    await expect.poll(() => onCanvas(page)).toBe(true);
    await redoBtn.click();
    await expect.poll(async () => (await savedNode(page, "a1"))?.y).toBe(20);
    await expect(redoBtn).toBeDisabled();
  });

  for (const [platform, mod, other] of [["Linux x86_64", "Control", "Meta"], ["MacIntel", "Meta", "Control"]] as const) {
    test(`on ${platform.startsWith("Mac") ? "a Mac" : "Linux"} the keys go with ${mod}, and Y redoes too`, async ({ page }) => {
      await page.addInitScript((p) => Object.defineProperty(navigator, "platform", { get: () => p }), platform);
      await page.reload();
      if ((await page.locator(".canvas-view").count()) === 0) await page.locator(".tree-row.attachment", { hasText: "Board" }).click();
      await expect(page.locator(".canvas-node")).toHaveCount(3);
      expect(await page.evaluate(() => navigator.platform)).toBe(platform);
      await recordWrites(page);
      await page.locator(nodeA).focus();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => writes(page)).toBe(1);
      await page.keyboard.press(`${other}+z`);
      await page.keyboard.press(`${mod}+Alt+z`);
      await page.keyboard.press(`${mod}+${other}+z`);
      await page.waitForTimeout(700);
      expect(await writes(page)).toBe(1);
      await page.keyboard.press(`${mod}+z`);
      await expect.poll(async () => (await savedNode(page, "a1"))?.x).toBe(0);
      await page.keyboard.press(`${mod}+Shift+y`);
      await page.waitForTimeout(700);
      expect((await savedNode(page, "a1"))?.x).toBe(0);
      await page.keyboard.press(`${mod}+y`);
      await expect.poll(async () => (await savedNode(page, "a1"))?.x).toBe(20);
    });
  }
});
