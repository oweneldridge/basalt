import { test, expect, openApp, openNote, caretToEnd } from "./fixture";

test("two tabs typing into one note never silently drop an edit", async ({ browser, vault }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  for (const p of [a, b]) {
    await openApp(p, vault);
    await openNote(p, "Ideas");
  }
  await caretToEnd(a);
  await a.keyboard.type("\nfrom-tab-a");
  await caretToEnd(b);
  await b.keyboard.type("\nfrom-tab-b");
  await a.waitForTimeout(3000);
  const disk = vault.read("Ideas.md");
  const conflictA = await a.locator(".conflict").isVisible();
  const conflictB = await b.locator(".conflict").isVisible();
  const textA = await a.locator(".pane:not(.dock) .cm-content").first().innerText();
  const textB = await b.locator(".pane:not(.dock) .cm-content").first().innerText();
  test.info().annotations.push({
    type: "outcome",
    description: JSON.stringify({ disk, conflictA, conflictB, aHasA: textA.includes("from-tab-a"), bHasB: textB.includes("from-tab-b") }),
  });
  // Each tab's text must survive somewhere: on disk, or in its own editor
  // behind a conflict badge.
  const aSafe = disk.includes("from-tab-a") || (conflictA && textA.includes("from-tab-a"));
  const bSafe = disk.includes("from-tab-b") || (conflictB && textB.includes("from-tab-b"));
  expect(aSafe && bSafe).toBe(true);
  await ctx.close();
});
