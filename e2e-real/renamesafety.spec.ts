import { mkdirSync, rmSync } from "node:fs";
import { test, expect, openApp, openNote, caretToEnd, settle } from "./fixture";

test("edits to a new note at a renamed note's old path never land in the renamed note", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await page.locator("input.inline-title").first().fill("Ideas Renamed");
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await expect.poll(() => vault.exists("Ideas Renamed.md")).toBe(true);
  await settle(page);
  const renamed = vault.read("Ideas Renamed.md");
  // A different note now arrives at the old path, gets edited, then vanishes.
  vault.write("Ideas.md", "# Fresh ideas\n\nnew note body\n");
  const newRow = page.locator(".tree-row.file").filter({ has: page.getByText("Ideas", { exact: true }) });
  await expect(newRow).toBeVisible();
  await newRow.click();
  await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Ideas");
  await caretToEnd(page);
  await page.keyboard.type("\nfresh");
  // Deleted elsewhere before the autosave: the tab is left with unsaved edits.
  rmSync(vault.path("Ideas.md"));
  await expect(page.locator(".conflict")).toBeVisible({ timeout: 5000 });
  await page.keyboard.type(" WRONGFILE");
  await settle(page, 1500);
  expect(vault.read("Ideas Renamed.md")).toBe(renamed);
  expect(vault.read("Ideas Renamed.md")).not.toContain("WRONGFILE");
});

test.describe("typing during a folder move", () => {
  test.use({
    vaultFiles: {
      "Projects/Alpha.md": "# Alpha\n\nSee [[Projects/Beta]].\n\nLast line\n",
      "Projects/Beta.md": "# Beta\n",
      "Projects/Gamma.md": "# Gamma\n\nLast line\n",
    },
  });

  for (const [name, links] of [
    ["Alpha", "whose own links get rewritten"],
    ["Gamma", "with no links to rewrite"],
  ] as const) {
    test(`text typed in a moved note ${links} reaches disk`, async ({ page, vault }) => {
      await openApp(page, vault);
      await page.locator(".tree-row.folder", { hasText: "Projects" }).click();
      await openNote(page, name);
      // Slow reads stretch the link-rewrite pass, so typing lands inside it.
      let slow = true;
      await page.route("**/api/invoke", async (route) => {
        if (slow && (route.request().postData() ?? "").includes('"cmd":"read_note"')) await new Promise((r) => setTimeout(r, 1200));
        await route.continue().catch(() => {});
      });
      await page.locator(".tree-row.folder", { hasText: "Projects" }).click({ button: "right" });
      await page.locator(".ctx-item", { hasText: "Rename folder…" }).click();
      await page.locator(".prompt-input").fill("Work");
      await page.locator(".prompt-input").press("Enter");
      await expect.poll(() => vault.exists(`Work/${name}.md`)).toBe(true);
      await page.locator(".pane:not(.dock) .cm-line", { hasText: "Last line" }).click();
      await page.keyboard.press("End");
      await page.keyboard.type(" TYPED", { delay: 40 });
      slow = false;
      await settle(page, 4000);
      await expect(page.locator(".pane:not(.dock) .cm-content").first()).toContainText("Last line TYPED");
      await expect.poll(() => vault.read(`Work/${name}.md`), { timeout: 8000 }).toContain("Last line TYPED");
      expect(vault.exists(`Projects/${name}.md`)).toBe(false);
    });
  }
});

test("after Keep mine brings back a note deleted elsewhere, typing saves normally", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await caretToEnd(page);
  await page.keyboard.type("\nmine");
  rmSync(vault.path("Ideas.md"));
  const conflict = page.locator(".conflict");
  await expect(conflict).toBeVisible({ timeout: 5000 });
  await conflict.getByRole("button", { name: "Keep mine" }).click();
  await expect.poll(() => (vault.exists("Ideas.md") ? vault.read("Ideas.md") : "")).toContain("mine");
  await expect(conflict).toBeHidden();
  // Focus is back in the editor: keep typing without clicking.
  await expect(page.locator(".pane:not(.dock) .cm-content").first()).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" more");
  await settle(page, 1500);
  await page.keyboard.type(" again");
  await settle(page, 1500);
  await expect(conflict).toBeHidden();
  expect(vault.read("Ideas.md")).toContain("mine more again");
});

test("a note created while a rescan is reading saves without a false conflict", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  let slow = true;
  // The listing is taken at once; its reply arrives late, after the new note.
  await page.route("**/api/invoke", async (route) => {
    if (!slow || !(route.request().postData() ?? "").includes('"cmd":"read_vault"')) return route.continue().catch(() => {});
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({ response }).catch(() => {});
  });
  mkdirSync(vault.path("trigger-rescan")); // a folder event makes the app re-read the vault
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "New note" }).first().click();
  await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText(/Untitled/);
  const name = (await page.locator(".pane:not(.dock) .tab.active .tab-name").first().textContent())!;
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.type("typed during the rescan");
  await page.waitForTimeout(3000);
  slow = false;
  await page.keyboard.type(" and after");
  await settle(page, 1500);
  await expect(page.locator(".conflict")).toBeHidden();
  await expect.poll(() => vault.read(`${name}.md`)).toContain("typed during the rescan and after");
});

test("in stacked tabs, typing in a new note at a renamed note's old path stays in that note", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Welcome");
  await openNote(page, "Ideas");
  await page.locator("input.inline-title").first().fill("Ideas Renamed");
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await expect.poll(() => vault.exists("Ideas Renamed.md")).toBe(true);
  await settle(page);
  const renamed = vault.read("Ideas Renamed.md");
  vault.write("Ideas.md", "# Fresh ideas\n\nnew note body\n");
  const newRow = page.locator(".tree-row.file").filter({ has: page.getByText("Ideas", { exact: true }) });
  await expect(newRow).toBeVisible();
  await newRow.click();
  await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Ideas");
  await page.locator(".pane:not(.dock) .tab", { hasText: "Ideas Renamed" }).click();
  await page.locator(".tab-stack").first().click();
  const col = page.locator(".stacked-col").filter({ has: page.locator(".stacked-col-head", { hasText: /^Ideas$/ }) });
  await expect(col.locator(".cm-content")).toContainText("new note body");
  await col.locator(".cm-line", { hasText: "new note body" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" TYPED-IN-NEW");
  await settle(page, 1500);
  expect(vault.read("Ideas Renamed.md")).toBe(renamed);
  expect(vault.read("Ideas.md")).toContain("new note body TYPED-IN-NEW");
});

test.describe("typing during a folder move's link pass", () => {
  test.use({
    vaultFiles: {
      "Projects/Gamma.md": "# Gamma\n\nSee [[Projects/Beta]].\n\nLast line\n",
      "Projects/Beta.md": "# Beta\n",
      "R1.md": "# R1\n\n[[Projects/Gamma]]\n",
      "R2.md": "# R2\n\n[[Projects/Beta]]\n",
    },
  });

  test("text typed after the note's own rewrite is saved, without a conflict, and keeps the fix", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.folder", { hasText: "Projects" }).click();
    await openNote(page, "Gamma");
    let slow = true;
    await page.route("**/api/invoke", async (route) => {
      if (slow && (route.request().postData() ?? "").includes('"cmd":"read_note"')) await new Promise((r) => setTimeout(r, 1200));
      await route.continue().catch(() => {});
    });
    await page.locator(".tree-row.folder", { hasText: "Projects" }).click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Rename folder…" }).click();
    await page.locator(".prompt-input").fill("Work");
    await page.locator(".prompt-input").press("Enter");
    // Gamma's own link is fixed on disk while the pass goes on to R1 and R2.
    await expect.poll(() => (vault.exists("Work/Gamma.md") ? vault.read("Work/Gamma.md") : ""), { timeout: 10000 }).toContain("[[Beta]]");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "Last line" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" TYPED", { delay: 30 });
    await expect.poll(() => vault.read("Work/Gamma.md"), { timeout: 8000 }).toContain("Last line TYPED");
    slow = false;
    await expect.poll(() => vault.read("R2.md"), { timeout: 15000 }).toContain("[[Beta]]");
    await settle(page, 1500);
    await page.keyboard.type("!");
    await settle(page, 1500);
    await expect(page.locator(".conflict")).toBeHidden();
    const disk = vault.read("Work/Gamma.md");
    expect(disk).toContain("Last line TYPED!");
    expect(disk).toContain("[[Beta]]");
  });
});
