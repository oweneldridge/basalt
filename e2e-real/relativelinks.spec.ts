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

const rel = { ".obsidian/app.json": JSON.stringify({ newLinkFormat: "relative" }) };
async function renameRow(page: import("@playwright/test").Page, folder: string | null, name: string, to: string) {
  if (folder) await page.locator(".tree-row.folder", { hasText: folder }).first().click();
  await page.locator(".tree-row.file", { hasText: name }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".prompt-input").fill(to);
  await page.locator(".prompt-input").press("Enter");
}

test.describe("a note renamed to a name a root note has", () => {
  test.use({ vaultFiles: { ...rel, "projects/Oldie.md": "self [[Oldie]] and [[Oldie#H]] and [s](Oldie.md#H)\n# H\n", "Done.md": "# root\n" } });
  test("self-link after rename into a root-shadowed name", async ({ page, vault }) => {
    await openApp(page, vault);
    await renameRow(page, "projects", "Oldie", "projects/Done");
    await expect.poll(() => vault.exists("projects/Done.md")).toBe(true);
    await expect.poll(() => vault.read("projects/Done.md")).not.toContain("Oldie");
    expect(vault.read("projects/Done.md")).toBe("self [[./Done]] and [[./Done#H]] and [s](./Done.md#H)\n# H\n");
  });
});

test.describe("a note moved up next to a root folder of the same name", () => {
  test.use({ vaultFiles: { ...rel, "p/x/Mover.md": "to [[../sub/Bee]] and ![[../sub/pic.png]]\n", "p/sub/Bee.md": "# p bee\n", "sub/Bee.md": "# root bee\n", "p/sub/pic.png": png, "sub/pic.png": png } });
  test("own links after the note moves up a folder", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.folder", { hasText: "p" }).first().click();
    await renameRow(page, "x", "Mover", "p/Mover");
    await expect.poll(() => vault.exists("p/Mover.md")).toBe(true);
    await expect.poll(() => vault.read("p/Mover.md")).not.toContain("../");
    expect(vault.read("p/Mover.md")).toBe("to [[./sub/Bee]] and ![[./sub/pic.png]]\n");
  });
});

test.describe("an attachment renamed under its note, next to a root one", () => {
  test.use({ vaultFiles: { ...rel, "projects/Hub.md": "![[old.png]] and [i](old.png)\n", "projects/old.png": png, "sub/pic.png": png } });
  test("attachment renamed under the linking note's folder", async ({ page, vault }) => {
    await openApp(page, vault);
    await renameRow(page, "projects", "old", "projects/sub/pic");
    await expect.poll(() => vault.exists("projects/sub/pic.png")).toBe(true);
    await expect.poll(() => vault.read("projects/Hub.md")).not.toContain("old");
    expect(vault.read("projects/Hub.md")).toBe("![[./sub/pic.png]] and [i](./sub/pic.png)\n");
  });
});

test.describe("a mention linked next to a root note with its name", () => {
  test.use({ vaultFiles: { ...rel, "q/Src.md": "see Zed here\n", "q/Zed.md": "# q one\n", "Zed.md": "# root one\n" } });
  test("linking a mention next to a root note with the same name", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.folder", { hasText: "q" }).first().click();
    await openNote(page, "Zed");
    await page.locator(".pane.dock .tab.view-tab", { hasText: "Backlinks" }).click();
    await page.locator(".ref-group", { hasText: "Src" }).locator(".ref-link-btn").first().click();
    await expect.poll(() => vault.read("q/Src.md")).not.toBe("see Zed here\n");
    expect(vault.read("q/Src.md")).toBe("see [[./Zed|Zed]] here\n");
  });
});

test.describe("a suggestion next to a note whose name ends the same", () => {
  test.use({ vaultFiles: { ...rel, "Kit/Src.md": "See", "Kit/sub.md": "# k sub\n", "Kitsub.md": "# ksub\n" } });
  test("picking a same-folder note writes the plain name Obsidian would", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.folder", { hasText: "Kit" }).first().click();
    await openNote(page, "Src");
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" [[sub");
    await page.locator(".cm-tooltip-autocomplete li", { hasText: "Kit/sub.md" }).first().click();
    await expect.poll(() => vault.read("Kit/Src.md")).toBe("See [[sub]]");
  });
});

test.describe("a rename within a folder", () => {
  test.use({ vaultFiles: { ...rel, "projects/Oldie.md": "self [[Oldie]]\n", "projects/Src.md": "to [[Oldie]] and [m](Oldie.md)\n" } });
  test("rename within a folder writes bare relative links", async ({ page, vault }) => {
    await openApp(page, vault);
    await renameRow(page, "projects", "Oldie", "projects/Fresh");
    await expect.poll(() => vault.read("projects/Src.md")).not.toContain("Oldie");
    await expect.poll(() => vault.read("projects/Fresh.md")).not.toContain("Oldie");
    expect(vault.read("projects/Fresh.md")).toBe("self [[Fresh]]\n");
    expect(vault.read("projects/Src.md")).toBe("to [[Fresh]] and [m](Fresh.md)\n");
  });
});

test.describe("a note moved up a folder, nothing shadowing", () => {
  test.use({ vaultFiles: { ...rel, "p/x/Mover.md": "to [[../sub/Bee]] and ![[../sub/pic.png]]\n", "p/sub/Bee.md": "# p bee\n", "p/sub/pic.png": png, "o/sub/Bee.md": "# o\n", "o/sub/pic.png": png } });
  test("own links after the note moves up a folder, nothing shadowing", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.folder", { hasText: "p" }).first().click();
    await renameRow(page, "x", "Mover", "p/Mover");
    await expect.poll(() => vault.exists("p/Mover.md")).toBe(true);
    await expect.poll(() => vault.read("p/Mover.md")).not.toContain("../");
    expect(vault.read("p/Mover.md")).toBe("to [[sub/Bee]] and ![[sub/pic.png]]\n");
  });
});

test.describe("an attachment renamed under its folder, nothing shadowing", () => {
  test.use({ vaultFiles: { ...rel, "projects/Hub.md": "![[old.png]] and [i](old.png)\n", "projects/old.png": png } });
  test("attachment renamed under the folder, nothing shadowing", async ({ page, vault }) => {
    await openApp(page, vault);
    await renameRow(page, "projects", "old", "projects/sub/pic");
    await expect.poll(() => vault.exists("projects/sub/pic.png")).toBe(true);
    await expect.poll(() => vault.read("projects/Hub.md")).not.toContain("old");
    expect(vault.read("projects/Hub.md")).toBe("![[sub/pic.png]] and [i](sub/pic.png)\n");
  });
});

test.describe("a mention linked, nothing shadowing", () => {
  test.use({ vaultFiles: { ...rel, "q/Src.md": "see Zed here\n", "q/Zed.md": "# q one\n" } });
  test("linking a mention with nothing shadowing", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.folder", { hasText: "q" }).first().click();
    await openNote(page, "Zed");
    await page.locator(".pane.dock .tab.view-tab", { hasText: "Backlinks" }).click();
    await page.locator(".ref-group", { hasText: "Src" }).locator(".ref-link-btn").first().click();
    await expect.poll(() => vault.read("q/Src.md")).not.toBe("see Zed here\n");
    expect(vault.read("q/Src.md")).toBe("see [[Zed]] here\n");
  });
});
