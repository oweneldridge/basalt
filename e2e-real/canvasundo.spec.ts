import { test, expect, openApp, settle } from "./fixture";

const card = (id: string, text: string, x = 0) => ({ id, type: "text", text, x, y: 0, width: 200, height: 80 });
const canvas = (...nodes: object[]) => JSON.stringify({ nodes, edges: [] }, null, "\t");
const ids = (json: string) => (JSON.parse(json).nodes as { id: string }[]).map((n) => n.id);

test.use({ vaultFiles: { "Board.canvas": canvas(card("a1", "Card A")), "Sketches/Idea.canvas": canvas(card("p1", "Idea card")) } });

async function addCard(page: import("@playwright/test").Page) {
  await page.locator('button[title="Add a card"]').click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".canvas-text-input")).toHaveCount(0);
}

test("undo after a canvas is renamed into a folder saves to its new name", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.file", { hasText: "Board" }).first().click();
  await expect(page.locator(".canvas-node")).toHaveCount(1);
  await addCard(page);
  await expect.poll(() => ids(vault.read("Board.canvas")).length).toBe(2);
  await page.locator(".tree-row.file", { hasText: "Board" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".prompt-input").fill("Boards/Plan");
  await page.locator(".prompt-input").press("Enter");
  await expect.poll(() => vault.exists("Boards/Plan.canvas")).toBe(true);
  await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toContainText("Plan");
  await page.locator(".canvas-node").first().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".canvas-node")).toHaveCount(1);
  await expect.poll(() => ids(vault.read("Boards/Plan.canvas"))).toEqual(["a1"]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => ids(vault.read("Boards/Plan.canvas")).length).toBe(2);
  await settle(page, 1200);
  expect(vault.exists("Board.canvas")).toBe(false);
  await expect(page.locator(".conflict")).toHaveCount(0);
});

test("undo after a canvas's folder is renamed saves to its new place", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.folder", { hasText: "Sketches" }).first().click();
  await page.locator(".tree-row.file", { hasText: "Idea" }).first().click();
  await expect(page.locator(".canvas-node")).toHaveCount(1);
  await addCard(page);
  await expect.poll(() => ids(vault.read("Sketches/Idea.canvas")).length).toBe(2);
  await page.locator(".tree-row.folder", { hasText: "Sketches" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename folder…" }).click();
  await page.locator(".prompt-input").fill("Ideas");
  await page.locator(".prompt-input").press("Enter");
  await expect.poll(() => vault.exists("Ideas/Idea.canvas")).toBe(true);
  await page.locator(".canvas-node").first().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => ids(vault.read("Ideas/Idea.canvas"))).toEqual(["p1"]);
  await settle(page, 1200);
  expect(vault.exists("Sketches/Idea.canvas")).toBe(false);
});

test("an edit made outside while a canvas is open can't be undone over", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.file", { hasText: "Board" }).first().click();
  await addCard(page);
  await expect.poll(() => ids(vault.read("Board.canvas")).length).toBe(2);
  await settle(page, 1200);
  const outside = canvas(card("a1", "Changed outside", 300));
  vault.write("Board.canvas", outside);
  await expect(page.locator(".canvas-node", { hasText: "Changed outside" })).toHaveCount(1);
  await expect(page.locator(".canvas-node")).toHaveCount(1);
  await page.locator(".canvas-node").first().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await settle(page, 1500);
  expect(vault.read("Board.canvas")).toBe(outside);
  await expect(page.locator(".canvas-node", { hasText: "Changed outside" })).toHaveCount(1);
});

test("a canvas made where a renamed one was starts with no history of its own", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.file", { hasText: "Board" }).first().click();
  await addCard(page);
  await expect.poll(() => ids(vault.read("Board.canvas")).length).toBe(2);
  await page.locator(".tree-row.file", { hasText: "Board" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".prompt-input").fill("Plan");
  await page.locator(".prompt-input").press("Enter");
  await expect.poll(() => vault.exists("Plan.canvas")).toBe(true);
  await settle(page, 1200);
  const same = vault.read("Plan.canvas");
  vault.write("Board.canvas", same);
  await page.locator(".tree-row.file", { hasText: "Board" }).first().click();
  await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toContainText("Board");
  await expect(page.locator(".canvas-node")).toHaveCount(2);
  await page.locator(".canvas-node").first().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await settle(page, 1500);
  expect(vault.read("Board.canvas")).toBe(same);
  expect(vault.read("Plan.canvas")).toBe(same);
});

test.describe("two canvases renamed while closed", () => {
  test.use({ vaultFiles: { "One.canvas": canvas(card("o1", "One")), "Two.canvas": canvas(card("w1", "Two")) } });
  test("each opens with a history of its own", async ({ page, vault }) => {
    await openApp(page, vault);
    for (const [from, to] of [["One", "One2"], ["Two", "Two2"]]) {
      await page.locator(".tree-row.file", { hasText: from }).first().click({ button: "right" });
      await page.locator(".ctx-item", { hasText: "Rename…" }).click();
      await page.locator(".prompt-input").fill(to);
      await page.locator(".prompt-input").press("Enter");
      await expect.poll(() => vault.exists(`${to}.canvas`)).toBe(true);
    }
    await page.locator(".tree-row.file", { hasText: "One2" }).first().click();
    await addCard(page);
    await expect.poll(() => ids(vault.read("One2.canvas")).length).toBe(2);
    await page.locator(".canvas-node").first().focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => ids(vault.read("One2.canvas"))).toEqual(["o1"]);
    await settle(page, 1200);
    // The same text in the other, so only its own history tells them apart.
    const same = vault.read("One2.canvas");
    vault.write("Two2.canvas", same);
    await settle(page, 1200);
    await page.locator(".tree-row.file", { hasText: "Two2" }).first().click();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toContainText("Two2");
    await page.locator(".canvas-node").first().focus();
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await settle(page, 1500);
    expect(vault.read("Two2.canvas")).toBe(same);
    await expect(page.locator('button[title="Redo"]')).toBeDisabled();
  });
});
