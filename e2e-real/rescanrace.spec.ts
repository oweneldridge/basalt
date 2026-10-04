import { test, expect, openApp, openNote } from "./fixture";
import { mkdirSync } from "node:fs";

const files: Record<string, string> = {};
const filler = "lorem ipsum dolor sit amet ".repeat(150);
for (let i = 0; i < 3000; i++) files[`Bulk/F${Math.floor(i / 100)}/N${i}.md`] = `# N${i}\n\n${filler}\n`;

test.describe("rescan during typing", () => {
  test.use({ vaultFiles: files });
  test.setTimeout(120000);
  test("a rescan while typing never raises a conflict against our own save", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Ideas");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "Something for later" }).click();
    await page.keyboard.press("End");
    let conflictAt = -1;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.type(String.fromCharCode(97 + (i % 26)));
      if (i % 3 === 1) mkdirSync(vault.path(`trigger-${i}`)); // directory event -> vault-rescan
      await page.waitForTimeout(600);
      if (await page.locator(".conflict").isVisible()) { conflictAt = i; break; }
    }
    test.info().annotations.push({ type: "conflictAt", description: String(conflictAt) });
    expect(conflictAt).toBe(-1);
  });
});
