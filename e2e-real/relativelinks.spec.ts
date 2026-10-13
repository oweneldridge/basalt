import { test, expect, openApp, openNote } from "./fixture";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function renameFromTree(page: import("@playwright/test").Page, name: string, to: string) {
  await page.locator(".tree-row.file", { hasText: name }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".prompt-input").fill(to);
  await page.locator(".prompt-input").press("Enter");
}

test.describe("relative links next to a root note with the same path", () => {
  test.use({
    vaultFiles: {
      ".obsidian/app.json": JSON.stringify({ newLinkFormat: "relative" }),
      "projects/A.md": "See [[Old]] and [m](Old.md) and [[Old2]].\n",
      "projects/Old.md": "# the projects note\n",
      "projects/Old2.md": "# the sub note\n",
      "Done.md": "# root Done\n",
      "sub/Leaf.md": "# root Leaf\n",
    },
  });

  test("a rename writes ./ where the bare path would open the root note", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.folder", { hasText: "projects" }).first().click();
    await renameFromTree(page, "Old", "projects/Done");
    await expect.poll(() => vault.read("projects/A.md")).not.toContain("[[Old]]");
    await renameFromTree(page, "Old2", "projects/sub/Leaf");
    await expect.poll(() => vault.read("projects/A.md")).not.toContain("[[Old2]]");
    expect(vault.read("projects/A.md")).toBe("See [[./Done]] and [m](./Done.md) and [[./sub/Leaf]].\n");
  });
});

test.describe("a relative link picked from the suggestions", () => {
  test.use({
    vaultFiles: {
      ".obsidian/app.json": JSON.stringify({ newLinkFormat: "relative" }),
      "projects/A.md": "See",
      "projects/Done.md": "# the projects Done\n",
      "projects/Other.md": "# other\n",
      "Done.md": "# root Done\n",
    },
  });

  test("keeps ./ only where the bare path would open the root note", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.folder", { hasText: "projects" }).first().click();
    await openNote(page, "A");
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" [[Done");
    await page.locator(".cm-tooltip-autocomplete li", { hasText: "projects/Done.md" }).first().click();
    await page.keyboard.type(" [[Other");
    await page.locator(".cm-tooltip-autocomplete li", { hasText: "projects/Other.md" }).first().click();
    await expect.poll(() => vault.read("projects/A.md")).toBe("See [[./Done]] [[Other]]");
  });
});

test.describe("a folder rename with a # in a file's name", () => {
  test.use({ vaultFiles: { "media/a#b.png": png, "Hub.md": "![x](<media/a%23b.png>) and [y](<media/a%23b.png>)\n" } });

  test("an angled link to it is written so it still opens that file", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.folder", { hasText: "media" }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Rename" }).first().click();
    await page.locator(".prompt-input").fill("pics");
    await page.locator(".prompt-input").press("Enter");
    await expect.poll(() => vault.exists("pics/a#b.png")).toBe(true);
    await expect.poll(() => vault.read("Hub.md")).not.toContain("media/");
    expect(vault.read("Hub.md")).toBe("![x](a%23b.png) and [y](a%23b.png)\n");
  });
});
