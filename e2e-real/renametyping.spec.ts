import { test, expect, openApp, openNote, settle } from "./fixture";

test("typing right after an inline-title rename keeps every keystroke and no old file", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  // Simulate a slow link / cloud read for the renamed file only.
  await page.route("**/api/invoke", async (route) => {
    const body = route.request().postData() ?? "";
    if (body.includes('"cmd":"read_note"') && body.includes("Ideas Renamed.md")) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    await route.continue();
  });
  const title = page.locator("input.inline-title").first();
  await title.fill("Ideas Renamed");
  await page.locator(".pane:not(.dock) .cm-line", { hasText: "Something for later" }).click(); // blur -> rename
  await page.keyboard.press("End");
  await page.keyboard.type(" AAA", { delay: 30 });
  await page.waitForTimeout(400);
  await page.keyboard.type(" BBB", { delay: 30 });
  await settle(page, 3500);
  const shown = await page.locator(".pane:not(.dock) .cm-content").first().innerText();
  const newDisk = vault.exists("Ideas Renamed.md") ? vault.read("Ideas Renamed.md") : "(missing)";
  const oldDisk = vault.exists("Ideas.md") ? vault.read("Ideas.md") : "(missing)";
  test.info().annotations.push({ type: "editor", description: JSON.stringify(shown.slice(-60)) });
  test.info().annotations.push({ type: "new", description: JSON.stringify(newDisk.slice(-60)) });
  test.info().annotations.push({ type: "old", description: JSON.stringify(oldDisk.slice(-60)) });
  expect(oldDisk).toBe("(missing)");
  expect(newDisk).toContain("AAA");
  expect(newDisk).toContain("BBB");
});

test("an autosave while the rename is in flight doesn't recreate the old file", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  // The rename reaches the server at once; its reply arrives late, so the
  // autosave for what's typed meanwhile fires before the app knows the new path.
  await page.route("**/api/invoke", async (route) => {
    const body = route.request().postData() ?? "";
    if (!body.includes('"cmd":"rename_note"')) return route.continue();
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({ response });
  });
  const title = page.locator("input.inline-title").first();
  await title.fill("Ideas Renamed");
  await page.locator(".pane:not(.dock) .cm-line", { hasText: "Something for later" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" during", { delay: 30 });
  await expect.poll(() => vault.exists("Ideas Renamed.md")).toBe(true);
  await page.waitForTimeout(2500);
  await page.keyboard.type(" after", { delay: 30 });
  await settle(page, 2000);
  test.info().annotations.push({ type: "old", description: vault.exists("Ideas.md") ? JSON.stringify(vault.read("Ideas.md")) : "(missing)" });
  test.info().annotations.push({ type: "new", description: JSON.stringify(vault.read("Ideas Renamed.md")) });
  expect(vault.exists("Ideas.md")).toBe(false);
  const disk = vault.read("Ideas Renamed.md");
  expect(disk).toContain("Something for later. ^later-block during after");
  await expect(page.locator(".pane:not(.dock) .cm-content").first()).toContainText("during after");
});

test("with the watcher silent, a save during the rename waits for it", async ({ page, vault }) => {
  // No change events: nothing tells the app the old file is gone, so only the
  // rename itself can hold the save back.
  await page.route("**/api/events", (r) => r.abort());
  await openApp(page, vault);
  await openNote(page, "Ideas");
  const writes: string[] = [];
  page.on("request", (r) => {
    const body = r.postData() ?? "";
    if (r.url().includes("/api/invoke") && body.includes('"cmd":"write_note"')) {
      writes.push(/"path":"([^"]+)"/.exec(body)?.[1]?.split("/").pop() ?? "?");
    }
  });
  await page.route("**/api/invoke", async (route) => {
    if (!(route.request().postData() ?? "").includes('"cmd":"rename_note"')) return route.continue();
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 2000));
    await route.fulfill({ response });
  });
  await page.locator("input.inline-title").first().fill("Ideas Renamed");
  await page.locator(".pane:not(.dock) .cm-line", { hasText: "Something for later" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" held", { delay: 30 });
  await expect.poll(() => vault.read("Ideas Renamed.md"), { timeout: 8000 }).toContain("^later-block held");
  await settle(page);
  expect(writes).not.toContain("Ideas.md");
  expect(vault.exists("Ideas.md")).toBe(false);
});
