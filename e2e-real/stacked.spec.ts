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

test.describe("stacked columns and notes changed elsewhere", () => {
  test.use({
    vaultFiles: {
      "Aaa.md": "# Aaa\n\nalpha line\n\nend a\n",
      "Bbb.md": "# Bbb\n",
      "Lat.md": "# cafe\n\nline\n",
    },
  });
  const latin1 = Buffer.from([0x23, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a, 0x0a, 0x6c, 0x69, 0x6e, 0x65, 0x0a]);

  test("a phone edit to a note typed in earlier shows, and isn't overwritten", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Aaa");
    await openNote(page, "Bbb");
    await page.locator(".tab-stack").first().click();
    const col = page.locator(".stacked-col").filter({ has: page.locator(".stacked-col-head", { hasText: "Aaa" }) });
    await col.locator(".cm-line", { hasText: "alpha line" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" mine");
    await expect.poll(() => vault.read("Aaa.md")).toContain("alpha line mine");
    await settle(page, 1000);
    vault.write("Aaa.md", "# Aaa\n\nTHEIRS FROM PHONE\n\nend a\n");
    await expect.poll(() => col.locator(".cm-content").textContent(), { timeout: 5000 }).toContain("THEIRS FROM PHONE");
    await col.locator(".cm-line", { hasText: "end a" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" k");
    await settle(page, 1500);
    expect(vault.read("Aaa.md")).toBe("# Aaa\n\nTHEIRS FROM PHONE\n\nend a k\n");
  });

  test("a column for a note that stopped being UTF-8 can't rewrite it", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Lat");
    await openNote(page, "Aaa");
    await page.locator(".tab-stack").first().click();
    await expect(page.locator(".stacked-col")).toHaveCount(2);
    await settle(page, 1500);
    await vault.stop();
    vault.write("Lat.md", latin1);
    await vault.start();
    await page.reload();
    const col = page.locator(".stacked-col").filter({ has: page.locator(".stacked-col-head", { hasText: "Lat" }) });
    await expect(col.locator(".placeholder")).toHaveText("Couldn't load this note.", { timeout: 10000 });
    await expect(col.locator(".cm-content")).toHaveCount(0);
    expect(vault.readBytes("Lat.md").equals(latin1)).toBe(true);
  });

  test("an open note that stops being UTF-8 while offline isn't rewritten by typing", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Lat");
    await settle(page, 1000);
    await vault.stop();
    vault.write("Lat.md", latin1);
    await vault.start();
    await settle(page, 5000);
    await page.locator(".pane:not(.dock) .cm-content").first().click().catch(() => {});
    await page.keyboard.type("x");
    await settle(page, 2000);
    expect(vault.readBytes("Lat.md").equals(latin1)).toBe(true);
  });
});

test("a column whose first read fails loads once the network is back", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Welcome");
  await openNote(page, "Ideas");
  let failed = false;
  await page.route("**/api/invoke", async (route) => {
    const body = route.request().postData() ?? "";
    if (!failed && body.includes('"cmd":"read_note"') && body.includes("Welcome.md")) {
      failed = true;
      await route.abort();
      return;
    }
    await route.continue().catch(() => {});
  });
  await page.locator(".tab-stack").first().click();
  const col = page.locator(".stacked-col").filter({ has: page.locator(".stacked-col-head", { hasText: "Welcome" }) });
  await expect(col.locator(".placeholder")).toHaveText("Couldn't load this note.");
  expect(failed).toBe(true);
  await expect(col.locator(".cm-content")).toBeVisible({ timeout: 10000 });
});

test("typing in one column doesn't re-request a column that is still loading", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Welcome");
  await openNote(page, "Ideas");
  let reads = 0;
  await page.route("**/api/invoke", async (route) => {
    const body = route.request().postData() ?? "";
    const slow = body.includes('"cmd":"read_note"') && body.includes("Welcome.md");
    if (slow) reads++;
    const res = await route.fetch().catch(() => null);
    if (!res) return;
    if (slow) await new Promise((r) => setTimeout(r, 3000));
    await route.fulfill({ response: res }).catch(() => {});
  });
  await page.locator(".tab-stack").first().click();
  const ideas = page.locator(".stacked-col").filter({ has: page.locator(".stacked-col-head", { hasText: "Ideas" }) });
  await ideas.locator(".cm-line", { hasText: "A list of things" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" twenty characters!!", { delay: 50 });
  await settle(page, 3500);
  expect(reads).toBeLessThanOrEqual(1);
});

test.describe("stacked columns and slow reads", () => {
  test.use({
    vaultFiles: {
      "Xnote.md": "# Xnote\n\nalpha\n\nomega\n",
      "Ynote.md": "# Ynote\n",
      "Other.md": "# Other\n\nbody\n",
      "Aaa.md": "# Aaa\n\nalpha line\n\nend a\n",
      "Bbb.md": "# Bbb\n",
    },
  });

  test("opening a note slowly doesn't revert its column", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Other");
    await page.getByRole("button", { name: "Split right" }).first().click();
    const panes = page.locator(".pane:not(.dock)");
    await expect(panes).toHaveCount(2);
    await page.locator(".tree-row.file", { hasText: "Xnote" }).first().click();
    await page.locator(".tree-row.file", { hasText: "Ynote" }).first().click();
    const right = panes.filter({ has: page.locator(".tab", { hasText: "Ynote" }) });
    const left = panes.filter({ hasNot: page.locator(".tab", { hasText: "Ynote" }) });
    await right.getByRole("button", { name: /Stack tabs/ }).click();
    const col = right.locator(".stacked-col").filter({ has: page.locator(".stacked-col-head", { hasText: "Xnote" }) });
    await expect(col.locator(".cm-content")).toBeVisible();
    let landed = false;
    await page.route("**/api/invoke", async (route) => {
      const body = route.request().postData() ?? "";
      const res = await route.fetch().catch(() => null);
      if (!res) return;
      if (!landed && body.includes('"cmd":"read_note"') && body.includes("/Xnote.md")) {
        await new Promise((r) => setTimeout(r, 2500));
        await route.fulfill({ response: res }).catch(() => {});
        landed = true;
        return;
      }
      await route.fulfill({ response: res }).catch(() => {});
    });
    await left.locator(".cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+o");
    await page.locator(".palette-input").first().fill("Xnote");
    await page.keyboard.press("Enter");
    await col.locator(".cm-line", { hasText: "alpha" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Q");
    await expect.poll(() => vault.read("Xnote.md"), { timeout: 5000 }).toContain("alpha Q");
    await expect.poll(() => landed, { timeout: 10000 }).toBe(true);
    await settle(page, 800);
    await col.locator(".cm-line", { hasText: "omega" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" R");
    await settle(page, 1500);
    expect(vault.read("Xnote.md")).toBe("# Xnote\n\nalpha Q\n\nomega R\n");
  });

  test("a rescan's outside edit to a column-only note survives a keystroke as it lands", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Aaa");
    await openNote(page, "Bbb");
    await page.locator(".tab-stack").first().click();
    const col = page.locator(".stacked-col").filter({ has: page.locator(".stacked-col-head", { hasText: "Aaa" }) });
    await col.locator(".cm-line", { hasText: "end a" }).click();
    await page.keyboard.press("End");
    await settle(page, 800);
    const holds: Record<string, () => void> = {};
    let typed: Promise<void> | null = null;
    await page.route("**/api/invoke", async (route) => {
      const body = route.request().postData() ?? "";
      const cmd = /"cmd":"([a-z_]+)"/.exec(body)?.[1] ?? "";
      const res = await route.fetch().catch(() => null);
      if (!res) return;
      if ((cmd === "read_vault" || cmd === "list_attachments") && !(cmd in holds)) {
        await new Promise<void>((r) => (holds[cmd] = r));
        if (cmd === "read_vault") {
          const sent = route.fulfill({ response: res }).catch(() => {});
          typed = page.keyboard.type("Q");
          await sent;
          return;
        }
      }
      await route.fulfill({ response: res }).catch(() => {});
    });
    await vault.stop();
    vault.write("Aaa.md", "# Aaa\n\nPHONE line\n\nend a\n");
    await vault.start();
    await expect.poll(() => "read_vault" in holds && "list_attachments" in holds, { timeout: 15000 }).toBe(true);
    holds.list_attachments();
    await page.waitForTimeout(100);
    holds.read_vault();
    await expect.poll(() => typed !== null).toBe(true);
    await typed;
    await settle(page, 2500);
    const disk = vault.read("Aaa.md");
    expect(disk.includes("PHONE") || (await page.locator(".conflict").count()) > 0).toBe(true);
  });
});
