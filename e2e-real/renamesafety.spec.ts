import { rmSync } from "node:fs";
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
