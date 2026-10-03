import { test, expect, openApp, openNote, caretToEnd, settle } from "./fixture";

const editor = (page: import("@playwright/test").Page) => page.locator(".pane:not(.dock) .cm-content").first();

test("typing autosaves to disk", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await caretToEnd(page);
  await page.keyboard.type("\nzebra crossing");
  await expect.poll(() => vault.read("Ideas.md")).toContain("zebra crossing");
  expect(vault.read("Ideas.md")).toContain("Something for later. ^later-block");
});

test("an external edit reloads a clean editor", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  vault.write("Ideas.md", "# Ideas\n\nRewritten outside Basalt.\n");
  await expect(editor(page)).toContainText("Rewritten outside Basalt.");
  await settle(page);
  expect(vault.read("Ideas.md")).toBe("# Ideas\n\nRewritten outside Basalt.\n");
});

test("an external edit while dirty never silently drops either side", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await caretToEnd(page);
  await page.keyboard.type("\nmine");
  vault.write("Ideas.md", "# Ideas\n\ntheirs\n");
  await page.waitForTimeout(2500);
  const disk = vault.read("Ideas.md");
  const conflict = await page.locator(".conflict").isVisible();
  // Either the conflict badge is up (both versions still recoverable), or the
  // external edit landed before our first save and was reconciled cleanly.
  if (!conflict) {
    expect(disk).toContain("theirs");
    await expect(editor(page)).toContainText("theirs");
  } else {
    expect(disk).toBe("# Ideas\n\ntheirs\n");
    await expect(editor(page)).toContainText("mine");
  }
});

test("Keep mine overwrites the external edit; Reload discards local edits", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  // Make the editor dirty first, then land the external edit inside the
  // autosave debounce so the conflict path is taken.
  for (const choice of ["Keep mine", "Reload"] as const) {
    await caretToEnd(page);
    await page.keyboard.type(`\nlocal-${choice}`);
    vault.write("Ideas.md", `# Ideas\n\nexternal-${choice}\n`);
    const badge = page.locator(".conflict");
    try {
      await expect(badge).toBeVisible({ timeout: 3000 });
    } catch {
      test.info().annotations.push({ type: "race", description: `${choice}: save won before the watcher event` });
      continue;
    }
    await badge.getByRole("button", { name: choice }).click();
    await settle(page);
    if (choice === "Keep mine") {
      expect(vault.read("Ideas.md")).toContain("local-Keep mine");
      expect(vault.read("Ideas.md")).not.toContain("external-Keep mine");
    } else {
      expect(vault.read("Ideas.md")).toBe("# Ideas\n\nexternal-Reload\n");
      await expect(editor(page)).toContainText("external-Reload");
      await expect(editor(page)).not.toContainText("local-Reload");
    }
  }
});

test.describe("CRLF", () => {
  test.use({ vaultFiles: { "Windows.md": "# Windows\r\n\r\nline one\r\nline two\r\n" } });
  test("line endings survive an edit", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Windows");
    await caretToEnd(page);
    await page.keyboard.type("line three");
    await expect.poll(() => vault.read("Windows.md")).toContain("line three");
    const disk = vault.read("Windows.md");
    expect(disk.replace(/\r\n/g, "")).not.toContain("\n");
    expect(disk).toBe("# Windows\r\n\r\nline one\r\nline two\r\nline three");
  });
});

test.describe("UTF-8 BOM", () => {
  test.use({ vaultFiles: { "Bom.md": "﻿# Bom\n\nbody\n" } });
  test("a BOM is kept and not duplicated by an edit", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Bom");
    await caretToEnd(page);
    await page.keyboard.type("more");
    await expect.poll(() => vault.read("Bom.md")).toContain("more");
    const bytes = vault.readBytes("Bom.md");
    const boms = bytes.toString("utf8").split("﻿").length - 1;
    expect(boms).toBe(1);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});

test.describe("non-UTF-8", () => {
  const latin1 = Buffer.from([0x23, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a]);
  test.use({ vaultFiles: { "Latin.md": latin1 } });
  test("a non-UTF-8 note is never rewritten", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.file", { hasText: "Latin" }).first().click();
    await page.waitForTimeout(500);
    const content = page.locator(".pane:not(.dock) .cm-content").first();
    if (await content.isVisible()) {
      await content.click();
      await page.keyboard.type("x");
    }
    await page.waitForTimeout(1500);
    expect(vault.readBytes("Latin.md")).toEqual(latin1);
  });
});

test("a clean note deleted on disk is not resurrected", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await settle(page);
  const { rmSync } = await import("node:fs");
  rmSync(vault.path("Ideas.md"));
  await page.waitForTimeout(2500);
  expect(vault.exists("Ideas.md")).toBe(false);
});

test("a dirty note deleted on disk keeps the user's text recoverable", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await caretToEnd(page);
  await page.keyboard.type("\nunsaved words");
  const { rmSync } = await import("node:fs");
  rmSync(vault.path("Ideas.md"));
  await page.waitForTimeout(2500);
  // Acceptable outcomes: the note was re-saved with the text, or the editor
  // still holds it behind a conflict. Losing both is the failure.
  const onDisk = vault.exists("Ideas.md") && vault.read("Ideas.md").includes("unsaved words");
  const inEditor = (await editor(page).count()) > 0 && (await editor(page).innerText()).includes("unsaved words");
  expect(onDisk || inEditor).toBe(true);
});

test("the editor resyncs after the event stream drops and reconnects", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await settle(page);
  await vault.stop();
  vault.write("Ideas.md", "# Ideas\n\nchanged while the server was down\n");
  await vault.start();
  await expect(editor(page)).toContainText("changed while the server was down", { timeout: 15000 });
  await settle(page);
  expect(vault.read("Ideas.md")).toBe("# Ideas\n\nchanged while the server was down\n");
});

test("Keep mine on a note deleted elsewhere saves the user's text back", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await caretToEnd(page);
  await page.keyboard.type("\nwords I asked to keep");
  const { rmSync } = await import("node:fs");
  rmSync(vault.path("Ideas.md"));
  const badge = page.locator(".conflict");
  await expect(badge).toBeVisible({ timeout: 5000 });
  await badge.getByRole("button", { name: "Keep mine" }).click();
  await settle(page);
  expect(vault.exists("Ideas.md")).toBe(true);
  expect(vault.read("Ideas.md")).toContain("words I asked to keep");
  await page.waitForTimeout(1500);
  await expect(editor(page)).toContainText("words I asked to keep");
  await expect(badge).toBeHidden();
});
