import { readdirSync, statSync } from "node:fs";
import { test, expect, openApp, openNote, settle } from "./fixture";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const board = {
  nodes: [
    { id: "t1", type: "text", text: "Card A", x: 0, y: 0, width: 200, height: 80 },
    { id: "f1", type: "file", file: "Media/shot one.png", x: 300, y: 0, width: 200, height: 200 },
  ],
  edges: [],
};
const gallery = "# Gallery\n\n![first](Media/shot%20one.png)\n![[shot one.png|200]]\n![[Media/shot one.png]]\n\nPlan: [[Board.canvas]]\n";

test.use({
  vaultFiles: {
    "Media/shot one.png": png,
    "Media/taken.png": png,
    "Gallery.md": gallery,
    "Board.canvas": JSON.stringify(board, null, "\t"),
    "Bare.md": "Only ![[shot one.png]] here\n",
    "Tasks.base": "views:\n  - type: table\n    name: Table\n",
    "Dash.md": "![[Tasks.base]]\n",
    "Links.canvas": JSON.stringify({ nodes: [{ id: "c1", type: "text", text: "see [[Gallery]] and ![[Media/shot one.png]]", x: 0, y: 0, width: 300, height: 80 }], edges: [] }),
    "Sketches/Idea.canvas": JSON.stringify({ nodes: [{ id: "p1", type: "text", text: "Idea card", x: 0, y: 0, width: 200, height: 80 }], edges: [] }),
  },
});

async function renameFromMenu(page: import("@playwright/test").Page, row: string, to: string) {
  await page.locator(".tree-row.folder", { hasText: "Media" }).first().click();
  await page.locator(".tree-row.file", { hasText: row }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".prompt-input").fill(to);
  await page.locator(".prompt-input").press("Enter");
}

test("renaming an image rewrites every link and canvas card that shows it", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.folder", { hasText: "Media" }).first().click();
  await page.locator(".tree-row.file", { hasText: "shot one" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await expect(page.locator(".prompt-input")).toHaveValue("Media/shot one");
  await page.locator(".prompt-input").fill("Media/sunset");
  await page.locator(".prompt-input").press("Enter");
  await expect.poll(() => vault.exists("Media/sunset.png")).toBe(true);
  expect(vault.exists("Media/shot one.png")).toBe(false);
  await expect.poll(() => vault.read("Gallery.md")).not.toContain("shot");
  expect(vault.read("Gallery.md")).toBe(
    "# Gallery\n\n![first](sunset.png)\n![[sunset.png|200]]\n![[sunset.png]]\n\nPlan: [[Board.canvas]]\n",
  );
  await expect.poll(() => JSON.parse(vault.read("Board.canvas")).nodes[1].file).toBe("Media/sunset.png");
  await expect(page.locator(".tree-row.file", { hasText: "sunset" })).toBeVisible();
  await openNote(page, "Gallery");
  await expect(page.locator(".pane:not(.dock) img.cm-md-image[alt='first']")).toHaveAttribute("src", /^data:image\/png/);
});

test("dragging an image onto a folder moves it and fixes folder-qualified links", async ({ page, vault }) => {
  await openApp(page, vault);
  const bareBefore = statSync(vault.path("Bare.md")).mtimeMs;
  await page.locator(".tree-row.folder", { hasText: "Media" }).first().click();
  await page
    .locator(".tree-row.file", { hasText: "shot one" })
    .first()
    .dragTo(page.locator(".tree-row.folder", { hasText: "Projects" }).first());
  await expect.poll(() => vault.exists("Projects/shot one.png")).toBe(true);
  expect(vault.exists("Media/shot one.png")).toBe(false);
  await expect.poll(() => vault.read("Gallery.md")).not.toContain("Media/");
  expect(vault.read("Gallery.md")).toBe(
    "# Gallery\n\n![first](shot%20one.png)\n![[shot one.png|200]]\n![[shot one.png]]\n\nPlan: [[Board.canvas]]\n",
  );
  await expect.poll(() => JSON.parse(vault.read("Board.canvas")).nodes[1].file).toBe("Projects/shot one.png");
  expect(statSync(vault.path("Bare.md")).mtimeMs).toBe(bareBefore);
});

test("a name that's taken changes nothing", async ({ page, vault }) => {
  await openApp(page, vault);
  await renameFromMenu(page, "shot one", "Media/taken");
  await expect(page.locator(".status-error")).toContainText(/already exists/);
  expect(vault.exists("Media/shot one.png")).toBe(true);
  expect(vault.read("Gallery.md")).toBe(gallery);
});

test("an open canvas renamed mid-edit keeps the edit and saves to its new name", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.file", { hasText: "Board" }).first().click();
  await expect(page.locator(".canvas-node").first()).toBeVisible();
  await page.getByRole("button", { name: /card/i }).first().click();
  await page.locator(".tree-row.file", { hasText: "Board" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await expect(page.locator(".prompt-input")).toHaveValue("Board");
  await page.locator(".prompt-input").fill("Boards/Plan");
  await page.locator(".prompt-input").press("Enter");
  await expect.poll(() => vault.exists("Boards/Plan.canvas")).toBe(true);
  expect(JSON.parse(vault.read("Boards/Plan.canvas")).nodes.length).toBe(3);
  await expect.poll(() => vault.read("Gallery.md")).toContain("Plan: [[Plan.canvas]]");
  await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toContainText("Plan");
  await page.getByRole("button", { name: /card/i }).first().click();
  await expect.poll(() => JSON.parse(vault.read("Boards/Plan.canvas")).nodes.length).toBe(4);
  await settle(page, 1500);
  expect(vault.exists("Board.canvas")).toBe(false);
});

test("a case-only rename updates the links to the new case", async ({ page, vault }) => {
  await openApp(page, vault);
  await renameFromMenu(page, "shot one", "Media/Shot One");
  await expect.poll(() => vault.read("Gallery.md")).toContain("Shot One");
  expect(vault.read("Gallery.md")).toBe(
    "# Gallery\n\n![first](Shot%20One.png)\n![[Shot One.png|200]]\n![[Shot One.png]]\n\nPlan: [[Board.canvas]]\n",
  );
  expect(readdirSync(vault.path("Media")).sort()).toEqual(["Shot One.png", "taken.png"]);
  await expect.poll(() => JSON.parse(vault.read("Board.canvas")).nodes[1].file).toBe("Media/Shot One.png");
});

test("renaming a base rewrites its embeds", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.file", { hasText: "Tasks" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".prompt-input").fill("Views/Todo");
  await page.locator(".prompt-input").press("Enter");
  await expect.poll(() => vault.read("Dash.md")).toBe("![[Todo.base]]\n");
  expect(vault.exists("Views/Todo.base")).toBe(true);
  expect(vault.exists("Tasks.base")).toBe(false);
});

test("the tree lists a file without its extension and tags the extension, as Obsidian does", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.folder", { hasText: "Media" }).first().click();
  const shot = page.locator(".tree-row.file", { hasText: "shot one" }).first();
  await expect(shot.locator(".tree-name")).toHaveText("shot one");
  await expect(shot.locator(".file-tag")).toHaveText("png");
  await expect(shot.locator(".file-tag")).toHaveCSS("text-transform", "uppercase");
  await expect(page.locator(".tree-row.file", { hasText: "Board" }).first().locator(".file-tag")).toHaveText("canvas");
  await expect(page.locator(".tree-row.file", { hasText: "Gallery" }).first().locator(".file-tag")).toHaveCount(0);
  await expect(shot).toHaveCSS("font-style", "normal");
});

test("typing in a canvas card while its rename waits is kept", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.file", { hasText: "Board" }).first().click();
  await expect(page.locator(".canvas-node").first()).toBeVisible();
  await page.route("**/api/invoke", async (route) => {
    const slow = (route.request().postData() ?? "").includes('"cmd":"rename_folder"');
    const res = await route.fetch().catch(() => null);
    if (!res) return;
    if (slow) await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({ response: res }).catch(() => {});
  });
  await page.locator(".tree-row.folder", { hasText: "Media" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename folder…" }).click();
  await page.locator(".prompt-input").fill("Pics");
  await page.locator(".prompt-input").press("Enter");
  await page.locator(".tree-row.file", { hasText: "Board" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".prompt-input").fill("Board2");
  await page.locator(".prompt-input").press("Enter");
  await page.locator(".canvas-node", { hasText: "Card A" }).dblclick();
  await page.keyboard.press("End");
  await page.keyboard.type(" typed while waiting");
  await expect.poll(() => vault.exists("Board2.canvas"), { timeout: 15000 }).toBe(true);
  await settle(page, 1500);
  const card = JSON.parse(vault.read("Board2.canvas")).nodes.find((n: { id: string }) => n.id === "t1");
  expect(card.text).toContain("typed while waiting");
});

test("typing in a canvas card while its folder's move waits is kept", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.locator(".tree-row.folder", { hasText: "Sketches" }).first().click();
  await page.locator(".tree-row.file", { hasText: "Idea" }).first().click();
  await expect(page.locator(".canvas-node").first()).toBeVisible();
  await page.route("**/api/invoke", async (route) => {
    const slow = (route.request().postData() ?? "").includes('"cmd":"rename_attachment"');
    const res = await route.fetch().catch(() => null);
    if (!res) return;
    if (slow) await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({ response: res }).catch(() => {});
  });
  await renameFromMenu(page, "taken", "Media/taken2");
  await page.locator(".tree-row.folder", { hasText: "Sketches" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename folder…" }).click();
  await page.locator(".prompt-input").fill("Ideas");
  await page.locator(".prompt-input").press("Enter");
  await page.locator(".canvas-node", { hasText: "Idea card" }).dblclick();
  await page.keyboard.press("End");
  await page.keyboard.type(" typed while waiting");
  await expect.poll(() => vault.exists("Ideas/Idea.canvas"), { timeout: 15000 }).toBe(true);
  await settle(page, 1500);
  expect(JSON.parse(vault.read("Ideas/Idea.canvas")).nodes[0].text).toContain("typed while waiting");
});

test("links in a canvas text card follow renames and moves, as in Obsidian", async ({ page, vault }) => {
  await openApp(page, vault);
  const card = () => JSON.parse(vault.read("Links.canvas")).nodes[0].text as string;
  await page.locator(".tree-row.file", { hasText: "Gallery" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".prompt-input").fill("Photos");
  await page.locator(".prompt-input").press("Enter");
  await expect.poll(card).toBe("see [[Photos]] and ![[Media/shot one.png]]");
  await renameFromMenu(page, "shot one", "Media/sunset");
  await expect.poll(card).toBe("see [[Photos]] and ![[sunset.png]]");
  await page.locator(".tree-row.folder", { hasText: "Media" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename folder…" }).click();
  await page.locator(".prompt-input").fill("Pics");
  await page.locator(".prompt-input").press("Enter");
  await expect.poll(() => vault.exists("Pics/sunset.png")).toBe(true);
  await settle(page, 1000);
  expect(card()).toBe("see [[Photos]] and ![[sunset.png]]");
});

test.describe("a rename right after another", () => {
  const many: Record<string, string | Uint8Array> = { "Media/qqpic.png": png };
  for (let i = 0; i < 300; i++) many[`Many/n${i}.md`] = `# n${i}\n\n![[qqpic.png]]\n`;
  test.use({ vaultFiles: many });

  test("keeps every link on the file, even while the vault is read again", async ({ page, vault }) => {
    await openApp(page, vault);
    const all = () => Array.from({ length: 300 }, (_, i) => vault.read(`Many/n${i}.md`)).join("");
    for (const [from, to] of [["qqpic", "Media/qqpic2"], ["qqpic2", "Media/qqpic3"]]) {
      await page.locator(".tree-row.folder", { hasText: "Media" }).first().click();
      await page.locator(".tree-row.file", { hasText: from }).first().click({ button: "right" });
      await page.locator(".ctx-item", { hasText: "Rename…" }).click();
      await page.locator(".prompt-input").fill(to);
      await page.locator(".prompt-input").press("Enter");
      const name = to.split("/").pop() + ".png";
      await expect.poll(all, { timeout: 30000 }).not.toMatch(new RegExp(`!\\[\\[${from}\\.png`));
      expect(all().split(`![[${name}]]`).length - 1).toBe(300);
      await page.locator(".tree-row.folder", { hasText: "Media" }).first().click();
    }
  });

  test("keeps the fixed links when a vault read already under way returns", async ({ page, vault }) => {
    await openApp(page, vault);
    const all = () => Array.from({ length: 300 }, (_, i) => vault.read(`Many/n${i}.md`)).join("");
    let held = 0;
    await page.route("**/api/invoke", async (route) => {
      const slow = (route.request().postData() ?? "").includes('"cmd":"read_vault"');
      const res = await route.fetch().catch(() => null);
      if (!res) return;
      if (slow) {
        held++;
        await new Promise((r) => setTimeout(r, 3000));
      }
      await route.fulfill({ response: res }).catch(() => {});
    });
    vault.write("Media/other.png", png); // a file from outside: the vault is read again
    await expect.poll(() => held, { timeout: 5000 }).toBeGreaterThan(0);
    for (const [from, to] of [["qqpic", "Media/qqpic2"], ["qqpic2", "Media/qqpic3"]]) {
      await page.locator(".tree-row.folder", { hasText: "Media" }).first().click();
      await page.locator(".tree-row.file", { hasText: from }).first().click({ button: "right" });
      await page.locator(".ctx-item", { hasText: "Rename…" }).click();
      await page.locator(".prompt-input").fill(to);
      await page.locator(".prompt-input").press("Enter");
      await expect.poll(all, { timeout: 30000 }).not.toMatch(new RegExp(`!\\[\\[${from}\\.png`));
      await page.waitForTimeout(3500);
      await page.locator(".tree-row.folder", { hasText: "Media" }).first().click();
    }
    expect(all().split("![[qqpic3.png]]").length - 1).toBe(300);
  });
});
