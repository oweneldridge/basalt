import { test, expect, openApp, openNote, settle } from "./fixture";

async function renameFromTree(page: import("@playwright/test").Page, name: string, to: string) {
  await page.locator(".tree-row.file", { hasText: name }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".prompt-input").fill(to);
  await page.locator(".prompt-input").press("Enter");
}

test("renaming a note rewrites every link to it on disk", async ({ page, vault }) => {
  await openApp(page, vault);
  await renameFromTree(page, "Ideas", "Ideas Renamed");
  await expect.poll(() => vault.exists("Ideas Renamed.md")).toBe(true);
  expect(vault.exists("Ideas.md")).toBe(false);
  await expect.poll(() => vault.read("Welcome.md")).toContain("[[Ideas Renamed|my ideas]]");
  const welcome = vault.read("Welcome.md");
  expect(welcome).toContain("[[Ideas Renamed#Later]]");
  expect(welcome).toContain("[ideas](Ideas%20Renamed.md)");
  expect(welcome).toContain("![[Ideas Renamed]]");
  expect(vault.read("Projects/Alpha.md")).toContain("Depends on [[Ideas Renamed]].");
  expect(vault.read("Ideas Renamed.md")).toContain("^later-block");
});

test.describe("rename into a basename collision", () => {
  test.use({ vaultFiles: { "Archive/Ideas Moved.md": "# old archive copy\n" } });
  test("a move that makes the bare name ambiguous qualifies the links", async ({ page, vault }) => {
    await openApp(page, vault);
    await renameFromTree(page, "Ideas", "Notes/Ideas Moved");
    await expect.poll(() => vault.exists("Notes/Ideas Moved.md")).toBe(true);
    await expect.poll(() => vault.read("Projects/Alpha.md")).not.toContain("[[Ideas]]");
    const alpha = vault.read("Projects/Alpha.md");
    // Obsidian's "shortest" format falls back to the full path when the bare
    // name is ambiguous; a bare [[Ideas Moved]] would resolve to Archive/.
    expect(alpha).toContain("[[Notes/Ideas Moved]]");
  });
});

test("delete moves the note into the vault trash", async ({ page, vault }) => {
  await openApp(page, vault);
  page.on("dialog", (d) => void d.accept());
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click({ button: "right" });
  await page.locator(".ctx-item.danger", { hasText: "Delete" }).click();
  await expect.poll(() => vault.exists("Ideas.md")).toBe(false);
  expect(vault.exists(".trash/Ideas.md")).toBe(true);
  expect(vault.read(".trash/Ideas.md")).toContain("^later-block");
});

test("editing a property rewrites only that frontmatter line", async ({ page, vault }) => {
  const before = vault.read("Projects/Alpha.md");
  await openApp(page, vault);
  await page.locator(".tree-row.folder", { hasText: "Projects" }).click();
  await openNote(page, "Alpha");
  await page.locator(".pane.dock .tab.view-tab", { hasText: "Properties" }).click();
  const row = page.locator(".prop-row", { hasText: "status" });
  await row.locator(".prop-value").fill("paused");
  await row.locator(".prop-value").press("Enter");
  await expect.poll(() => vault.read("Projects/Alpha.md")).toContain("status: paused");
  await settle(page);
  expect(vault.read("Projects/Alpha.md")).toBe(before.replace("status: active", "status: paused"));
});

const board = {
  nodes: [
    { id: "a1", type: "text", text: "Card A", x: 0, y: 0, width: 200, height: 80, styleAttributes: { shape: "pill" } },
    { id: "w1", type: "widget-from-a-plugin", x: 300, y: 0, width: 100, height: 100, config: { keep: true } },
  ],
  edges: [{ id: "e1", fromNode: "a1", toNode: "w1", fromSide: "right", toSide: "left", customFlag: 1 }],
  metadata: { version: "1.0-1.0", frontmatter: {} },
};

test.describe("canvas", () => {
  test.use({ vaultFiles: { "Board.canvas": JSON.stringify(board, null, "\t") } });
  test("an edit keeps node types, fields and keys Basalt doesn't model", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.file", { hasText: "Board" }).first().click();
    await expect(page.locator(".canvas-node").first()).toBeVisible();
    await page.getByRole("button", { name: /card/i }).first().click();
    await expect.poll(() => JSON.parse(vault.read("Board.canvas")).nodes.length).toBe(3);
    const saved = JSON.parse(vault.read("Board.canvas"));
    const widget = saved.nodes.find((n: { id: string }) => n.id === "w1");
    expect(widget).toMatchObject({ type: "widget-from-a-plugin", config: { keep: true } });
    expect(saved.nodes.find((n: { id: string }) => n.id === "a1").styleAttributes).toEqual({ shape: "pill" });
    expect(saved.edges[0]).toMatchObject({ id: "e1", customFlag: 1 });
    expect(saved.metadata).toEqual({ version: "1.0-1.0", frontmatter: {} });
  });
});

test.describe("links in properties", () => {
  test.use({
    vaultFiles: {
      "Meeting.md": '---\nrelated: "[[Ideas]]"\nsee:\n  - "[[Ideas#Later]]"\n  - "[[Welcome]]"\n---\n# Meeting\n',
    },
  });
  test("renaming a note rewrites wikilinks inside frontmatter properties", async ({ page, vault }) => {
    await openApp(page, vault);
    await renameFromTree(page, "Ideas", "Ideas Renamed");
    await expect.poll(() => vault.exists("Ideas Renamed.md")).toBe(true);
    await expect.poll(() => vault.read("Welcome.md")).toContain("[[Ideas Renamed|my ideas]]");
    const meeting = vault.read("Meeting.md");
    expect(meeting).toContain('related: "[[Ideas Renamed]]"');
    expect(meeting).toContain('  - "[[Ideas Renamed#Later]]"');
    expect(meeting).toContain('  - "[[Welcome]]"');
  });
});
