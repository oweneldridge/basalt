import { test, expect, openApp, openNote, settle } from "./fixture";

test("stacked column: an external edit is not reverted by the next keystroke", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Welcome");
  await openNote(page, "Ideas");
  await page.locator(".tab-stack").first().click();
  await expect(page.locator(".stacked-col")).toHaveCount(2);
  const ideasCol = page.locator(".stacked-col", { hasText: "Ideas" }).filter({ has: page.locator(".stacked-col-head", { hasText: "Ideas" }) });
  await expect(ideasCol.locator(".cm-content")).toContainText("A list of things to try");
  vault.write("Ideas.md", "# Ideas\n\nWRITTEN BY OBSIDIAN\n");
  await page.waitForTimeout(2500); // watcher + debounce
  const shown = await ideasCol.locator(".cm-content").innerText();
  test.info().annotations.push({ type: "column-after-external", description: JSON.stringify(shown) });
  await ideasCol.locator(".cm-line").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" typed");
  await settle(page, 1500);
  const disk = vault.read("Ideas.md");
  const conflict = await page.locator(".conflict").isVisible();
  test.info().annotations.push({ type: "disk", description: JSON.stringify(disk) + " conflict=" + conflict });
  expect(disk.includes("WRITTEN BY OBSIDIAN") || conflict).toBe(true);
});

test("stacked column: an outside edit back to text typed earlier still shows", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Welcome");
  await openNote(page, "Ideas");
  await page.locator(".tab-stack").first().click();
  const col = page.locator(".stacked-col").filter({ has: page.locator(".stacked-col-head", { hasText: "Ideas" }) });
  await col.locator(".cm-line", { hasText: "A list of things" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" hello");
  await expect.poll(() => vault.read("Ideas.md")).toContain("try. hello");
  await settle(page, 1000);
  vault.write("Ideas.md", vault.read("Ideas.md").replace("try. hello", "try. hel"));
  await expect.poll(() => col.locator(".cm-content").textContent(), { timeout: 5000 }).not.toContain("hello");
  await col.locator(".cm-line", { hasText: "Something for later" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" X");
  await settle(page, 1500);
  expect(vault.read("Ideas.md")).toBe("# Ideas\n\nA list of things to try. hel\n\n## Later\n\nSomething for later. ^later-block X\n");
});

test.describe("a stacked column and a pane on the same note", () => {
  test.use({ vaultFiles: { "Src.md": "# Src\n\nmid\n\nend\n", "Other.md": "# Other\n" } });

  async function stackBeside(page: import("@playwright/test").Page) {
    await openNote(page, "Src");
    await page.getByRole("button", { name: "Split right" }).first().click();
    const panes = page.locator(".pane:not(.dock)");
    await expect(panes).toHaveCount(2);
    await page.locator(".tree-row.file", { hasText: "Src" }).first().click();
    await page.locator(".tree-row.file", { hasText: "Other" }).first().click();
    const right = panes.filter({ has: page.locator(".tab", { hasText: "Other" }) });
    const left = panes.filter({ hasNot: page.locator(".tab", { hasText: "Other" }) });
    await right.getByRole("button", { name: /Stack tabs/ }).click();
    await expect(right.locator(".stacked-col")).toHaveCount(2);
    const col = right.locator(".stacked-col").filter({ has: page.locator(".stacked-col-head", { hasText: "Src" }) });
    return { left, col };
  }

  test("a deletion made in the pane survives the column's next keystroke", async ({ page, vault }) => {
    await openApp(page, vault);
    const { left, col } = await stackBeside(page);
    await col.locator(".cm-line", { hasText: "mid" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" hello");
    await expect.poll(() => vault.read("Src.md")).toContain("mid hello");
    await settle(page, 800);
    await left.locator(".cm-line", { hasText: "mid hello" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect.poll(() => vault.read("Src.md")).toContain("mid hel\n");
    await settle(page, 800);
    await col.locator(".cm-line", { hasText: "end" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Z");
    await settle(page, 1500);
    expect(vault.read("Src.md")).toBe("# Src\n\nmid hel\n\nend Z\n");
  });

  for (const delay of [0, 400]) {
    test(`renaming the note keeps typing in its column (replies ${delay} ms late)`, async ({ page, vault }) => {
      await openApp(page, vault);
      const { left, col } = await stackBeside(page);
      if (delay) {
        await page.route("**/api/invoke", async (route) => {
          const res = await route.fetch().catch(() => null);
          if (!res) return;
          await new Promise((r) => setTimeout(r, delay));
          await route.fulfill({ response: res }).catch(() => {});
        });
      }
      await left.locator("input.inline-title").fill("Src New");
      await col.locator(".cm-line", { hasText: "mid" }).click();
      await page.keyboard.press("End");
      const typed = "abcdefghijklmnopqrstuvwxyz0123456789";
      await page.keyboard.type(typed, { delay: 30 });
      await expect.poll(() => vault.exists("Src New.md"), { timeout: 10000 }).toBe(true);
      await settle(page, 2500);
      expect(vault.read("Src New.md")).toBe(`# Src\n\nmid${typed}\n\nend\n`);
      expect(vault.exists("Src.md")).toBe(false);
    });
  }
});
