import { statSync } from "node:fs";
import { test, expect, openApp, openNote, settle } from "./fixture";

test("moving a note leaves notes whose links read the same untouched", async ({ page, vault }) => {
  await openApp(page, vault);
  const before = (rel: string) => statSync(vault.path(rel)).mtimeMs;
  const welcome = before("Welcome.md");
  const alpha = before("Projects/Alpha.md");
  const text = vault.read("Welcome.md");
  await openNote(page, "Ideas");
  await page.evaluate(() => {
    const target = [...document.querySelectorAll<HTMLElement>(".tree-row.folder")].find((r) => r.textContent?.includes("Projects"))!;
    const dt = new DataTransfer();
    dt.setData("application/x-basalt-note", document.querySelector<HTMLElement>(".tree-row.file.active")!.dataset.path!);
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => vault.exists("Projects/Ideas.md")).toBe(true);
  await settle(page, 1500);
  expect(vault.read("Welcome.md")).toBe(text);
  expect(before("Welcome.md")).toBe(welcome);
  expect(before("Projects/Alpha.md")).toBe(alpha);
});
