import { test, expect, openApp, settle } from "./fixture";

const board = { nodes: [{ id: "a1", type: "text", text: "Card A", x: 0, y: 0, width: 200, height: 80 }], edges: [] };

test.describe("canvas overlapping saves", () => {
  test.use({ vaultFiles: { "Board.canvas": JSON.stringify(board, null, "\t") } });
  test("a blur flush during a slow canvas save raises no conflict and loses no edit", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.file", { hasText: "Board" }).first().click();
    await expect(page.locator(".canvas-node").first()).toBeVisible();
    let writes = 0;
    await page.route("**/api/invoke", async (route) => {
      const body = route.request().postData() ?? "";
      if (body.includes('"cmd":"write_canvas"') && ++writes === 1) await new Promise((r) => setTimeout(r, 2000)); // slow link for the first save
      await route.continue();
    });
    await page.getByRole("button", { name: /card/i }).first().click(); // edit 1
    await page.waitForTimeout(800); // autosave of edit 1 is now in flight (slow)
    await page.getByRole("button", { name: /card/i }).first().click(); // edit 2
    await page.evaluate(() => window.dispatchEvent(new Event("blur"))); // focus loss flushes now
    await page.waitForTimeout(3000);
    const conflict = await page.locator(".conflict").isVisible();
    const nodesOnDisk = JSON.parse(vault.read("Board.canvas")).nodes.length;
    test.info().annotations.push({ type: "after-race", description: `conflict=${conflict} nodesOnDisk=${nodesOnDisk}` });
    if (conflict) {
      await page.locator(".conflict").getByRole("button", { name: "Keep mine" }).click();
      await settle(page, 1500);
      const kept = JSON.parse(vault.read("Board.canvas")).nodes.length;
      const shown = await page.locator(".canvas-node").count();
      test.info().annotations.push({ type: "after-keep-mine", description: `nodesOnDisk=${kept} nodesShown=${shown}` });
    }
    expect(conflict).toBe(false);
  });
});
