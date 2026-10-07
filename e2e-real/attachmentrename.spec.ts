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
