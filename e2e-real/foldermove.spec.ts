import { test, expect, openApp, openNote, caretToEnd, settle } from "./fixture";

async function renameFolder(page: import("@playwright/test").Page, name: string, to: string) {
  await page.locator(".tree-row.folder", { hasText: name }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename folder…" }).click();
  await page.locator(".prompt-input").fill(to);
  await page.locator(".prompt-input").press("Enter");
}

test("moved note: typed text survives a folder rename and the next keystroke", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.folder", { hasText: "Projects" }).click();
  await openNote(page, "Alpha");
  await caretToEnd(page);
  await page.keyboard.type("\ntyped before the move");
  await expect.poll(() => vault.read("Projects/Alpha.md")).toContain("typed before the move");
  await settle(page);
  await renameFolder(page, "Projects", "Work");
  await expect.poll(() => vault.exists("Work/Alpha.md")).toBe(true);
  await settle(page);
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("!");
  await settle(page, 1500);
  const disk = vault.read("Work/Alpha.md");
  expect(disk).toContain("typed before the move");
});

test("unmoved linking note: a folder move's link rewrite survives the next keystroke", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Welcome");
  await caretToEnd(page);
  await page.keyboard.type("\ntyped in welcome");
  await expect.poll(() => vault.read("Welcome.md")).toContain("typed in welcome");
  await settle(page);
  await renameFolder(page, "Projects", "Work");
  await expect.poll(() => vault.read("Welcome.md")).toContain("Project: [[Alpha]]");
  await settle(page);
  await page.locator(".pane:not(.dock) .cm-line", { hasText: "typed in welcome" }).first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await settle(page, 1500);
  const disk = vault.read("Welcome.md");
  expect(disk).toContain("typed in welcome!");
  expect(disk).not.toContain("[[Projects/Alpha]]");
});

test.describe("attachment links", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  test.use({
    vaultFiles: {
      "Media/shot one.png": png,
      "Gallery.md": "# Gallery\n\n![first](Media/shot%20one.png)\n![[Media/shot one.png]]\n",
    },
  });

  test("a markdown image with an encoded space shows in both views", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Gallery");
    const pane = page.locator(".pane:not(.dock)").first();
    await expect(pane.locator('img.cm-md-image[alt="first"]')).toHaveAttribute("src", /^data:image\/png/);
    await page.locator('button[title^="Toggle Reading view"]').click();
    await expect(pane.locator(".reading-view img.md-image")).toHaveAttribute("src", /^data:image\/png/);
  });

  test("a folder rename rewrites markdown and wiki attachment links on disk", async ({ page, vault }) => {
    await openApp(page, vault);
    await renameFolder(page, "Media", "Images");
    await expect.poll(() => vault.exists("Images/shot one.png")).toBe(true);
    await expect.poll(() => vault.read("Gallery.md")).not.toContain("Media/");
    const disk = vault.read("Gallery.md");
    expect(disk).toContain("![first](shot%20one.png)");
    expect(disk).toContain("![[shot one.png]]");
  });
});

test("a title rename entered during a slow folder move keeps the note in the new folder", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.folder", { hasText: "Projects" }).click();
  await openNote(page, "Alpha");
  await page.route("**/api/invoke", async (route) => {
    const slow = (route.request().postData() ?? "").includes('"cmd":"rename_folder"');
    const res = await route.fetch().catch(() => null);
    if (!res) return;
    if (slow) await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ response: res }).catch(() => {});
  });
  await renameFolder(page, "Projects", "Work");
  const title = page.locator(".pane:not(.dock) input.inline-title").first();
  await title.fill("Alpha2");
  await title.press("Enter");
  await expect.poll(() => vault.exists("Work/Alpha2.md"), { timeout: 10000 }).toBe(true);
  await settle(page, 1500);
  expect(vault.exists("Projects")).toBe(false);
  expect(vault.exists("Work/Alpha.md")).toBe(false);
});

test.describe("attachments with # in the name", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  test.use({
    vaultFiles: {
      "Media/a#b.png": png,
      "Media/a.md": "# A\n",
      "Gallery.md": "# Gallery\n\n![first](Media/a%23b.png)\n",
    },
  });

  test("a folder rename updates the link", async ({ page, vault }) => {
    await openApp(page, vault);
    await renameFolder(page, "Media", "Images");
    await expect.poll(() => vault.exists("Images/a#b.png")).toBe(true);
    await expect.poll(() => vault.read("Gallery.md")).not.toContain("Media/");
    expect(vault.read("Gallery.md")).toBe("# Gallery\n\n![first](a%23b.png)\n");
  });

  test("renaming a note named like the part before # leaves the link alone", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.folder", { hasText: "Media" }).click();
    await openNote(page, "a");
    await page.locator("input.inline-title").first().fill("z");
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await expect.poll(() => vault.exists("Media/z.md")).toBe(true);
    await settle(page, 1500);
    expect(vault.read("Gallery.md")).toBe("# Gallery\n\n![first](Media/a%23b.png)\n");
  });
});

test.describe("moving a note while its title rename runs", () => {
  test.use({ vaultFiles: { "Notes/Alpha.md": "# Alpha\n", "Work/keep.md": "# keep\n" } });

  test("the move keeps the new title", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.folder", { hasText: "Notes" }).click();
    await openNote(page, "Alpha");
    await page.route("**/api/invoke", async (route) => {
      const slow = (route.request().postData() ?? "").includes('"cmd":"rename_note"');
      const res = await route.fetch().catch(() => null);
      if (!res) return;
      if (slow) await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({ response: res }).catch(() => {});
    });
    const title = page.locator(".pane:not(.dock) input.inline-title").first();
    await title.fill("Alpha Retitled");
    await title.press("Enter");
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      const target = [...document.querySelectorAll<HTMLElement>(".tree-row.folder")].find((r) => r.textContent?.includes("Work"))!;
      const dt = new DataTransfer();
      dt.setData("application/x-basalt-note", document.querySelector<HTMLElement>(".tree-row.file.active")!.dataset.path!);
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => vault.exists("Work/Alpha Retitled.md"), { timeout: 10000 }).toBe(true);
    await settle(page, 1000);
    expect(vault.exists("Notes/Alpha.md")).toBe(false);
    expect(vault.exists("Work/Alpha.md")).toBe(false);
  });
});

test("typing during a folder move with a slow reply raises no false conflict", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.folder", { hasText: "Projects" }).click();
  await openNote(page, "Alpha");
  await page.route("**/api/invoke", async (route) => {
    const slow = (route.request().postData() ?? "").includes('"cmd":"rename_folder"');
    const res = await route.fetch().catch(() => null);
    if (!res) return;
    if (slow) await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({ response: res }).catch(() => {});
  });
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await renameFolder(page, "Projects", "Work");
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  let conflicts = 0;
  for (const ch of " typed-during-move") {
    await page.keyboard.type(ch);
    await page.waitForTimeout(120);
    conflicts += await page.locator(".conflict").count();
  }
  await expect.poll(() => vault.exists("Work/Alpha.md"), { timeout: 10000 }).toBe(true);
  await settle(page, 2500);
  expect(conflicts).toBe(0);
  await expect(page.locator(".conflict")).toHaveCount(0);
  expect(vault.read("Work/Alpha.md")).toContain("typed-during-move");
  expect(vault.exists("Projects")).toBe(false);
});

test.describe("a folder move with the linking note in two panes", () => {
  test.use({ vaultFiles: { "A/X.md": "# X\n", "Old/B/X.md": "# old X\n", "Linker.md": "# S\n\nsee [[A/X]]\n\nend\n" } });

  test("fixes the link once while it's typed in", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Linker");
    await page.locator('button:has-text("⊟")').first().click();
    await expect(page.locator(".pane:not(.dock)")).toHaveCount(2);
    let release: () => void = () => {};
    let held = false;
    await page.route("**/api/invoke", async (route) => {
      const body = route.request().postData() ?? "";
      const res = await route.fetch().catch(() => null);
      if (!res) return;
      if (!held && body.includes('"cmd":"rename_folder"')) {
        held = true;
        await new Promise<void>((r) => (release = r));
      }
      await route.fulfill({ response: res }).catch(() => {});
    });
    await page.locator(".pane:not(.dock)").first().locator(".cm-line", { hasText: /^end$/ }).click();
    await page.keyboard.press("End");
    await renameFolder(page, "A", "B");
    await expect.poll(() => held).toBe(true);
    await page.locator(".pane:not(.dock)").first().locator(".cm-line", { hasText: /^end$/ }).click();
    await page.keyboard.press("End");
    await page.keyboard.type("Q");
    release();
    await expect.poll(() => vault.exists("B/X.md"), { timeout: 10000 }).toBe(true);
    await settle(page, 3000);
    expect(vault.read("Linker.md")).toBe("# S\n\nsee [[B/X]]\n\nendQ\n");
  });
});
