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

  test("an external edit reloads the canvas and the next edit saves without a false conflict", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.file", { hasText: "Board" }).first().click();
    await expect(page.locator(".canvas-node").first()).toBeVisible();
    const external = { ...board, nodes: [...board.nodes, { id: "x1", type: "text", text: "From outside", x: 0, y: 200, width: 200, height: 80 }] };
    vault.write("Board.canvas", JSON.stringify(external, null, "\t"));
    await expect(page.locator(".canvas-node", { hasText: "From outside" })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: /card/i }).first().click();
    await expect.poll(() => JSON.parse(vault.read("Board.canvas")).nodes.length, { timeout: 5000 }).toBe(4);
    await expect(page.locator(".conflict")).toBeHidden();
    expect(JSON.parse(vault.read("Board.canvas")).nodes.some((n: { id: string }) => n.id === "x1")).toBe(true);
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

test.describe("Properties sidebar YAML", () => {
  const src = [
    "---",
    'title: "Re: Budget"',
    'up: "[[Ideas]]"',
    "priority: 3",
    "done: true",
    "when: 2026-10-03",
    "authors:",
    '  - "Doe, Jane"',
    "  - Smith",
    "---",
    "# Typed",
    "",
  ].join("\n");
  test.use({ vaultFiles: { "Typed.md": src } });

  test("focusing and leaving every field changes nothing on disk", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Typed");
    await page.locator(".pane.dock .tab.view-tab", { hasText: "Properties" }).click();
    const inputs = page.locator(".properties input.prop-value");
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
      await inputs.nth(i).focus();
      await inputs.nth(i).blur();
    }
    await settle(page, 1000);
    expect(vault.read("Typed.md")).toBe(src);
  });

  test("editing a quoted text value keeps the YAML valid", async ({ page, vault }) => {
    const { parse } = await import("yaml");
    await openApp(page, vault);
    await openNote(page, "Typed");
    await page.locator(".pane.dock .tab.view-tab", { hasText: "Properties" }).click();
    const title = page.locator(".prop-row", { hasText: "title" }).locator(".prop-value");
    await title.fill("Re: Budget v2");
    await title.press("Enter");
    await expect.poll(() => vault.read("Typed.md")).toContain("v2");
    const fm = parse(vault.read("Typed.md").split("---")[1]);
    expect(fm).toMatchObject({ title: "Re: Budget v2", up: "[[Ideas]]", priority: 3, done: true, authors: ["Doe, Jane", "Smith"] });
  });
});

test.describe("reading-view tasks", () => {
  const src = ["- [ ] Pay rent", "", "> [!todo] Today", "> - [ ] Write report", ""].join("\n");
  test.use({ vaultFiles: { "Tasks.md": src } });
  test("ticking a task inside a callout ticks that task", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Tasks");
    await page.locator('button[title^="Toggle Reading view"]').click();
    await page.locator("li.md-task", { hasText: "Write report" }).locator("input").click();
    await expect.poll(() => vault.read("Tasks.md")).toContain("> - [x] Write report");
    expect(vault.read("Tasks.md")).toContain("- [ ] Pay rent");
  });
});

test("rename leaves a linking note with an open conflict alone and says so", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Welcome");
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nmine, unsaved");
  const theirs = vault.read("Welcome.md").replace("# Welcome", "# Welcome (edited elsewhere)");
  vault.write("Welcome.md", theirs);
  await expect(page.locator(".conflict")).toBeVisible({ timeout: 5000 });
  await renameFromTree(page, "Ideas", "Ideas Renamed");
  await expect.poll(() => vault.exists("Ideas Renamed.md")).toBe(true);
  await expect(page.locator(".status")).toContainText("Welcome.md (unsaved edits)");
  expect(vault.read("Welcome.md")).toBe(theirs);
  await expect(page.locator(".pane:not(.dock) .cm-content").first()).toContainText("mine, unsaved");
  expect(vault.read("Projects/Alpha.md")).toContain("[[Ideas Renamed]]");
});

test.describe("link resolution order", () => {
  test.use({
    vaultFiles: {
      "Archive/Meeting.md": "# old meeting\n",
      "Work/Meeting.md": "# current meeting\n",
      "Work/Index.md": "Next: [[Meeting]]\n",
    },
  });
  const renameRow = async (page: import("@playwright/test").Page, rel: string, to: string) => {
    // Both rows read "Meeting" in the tree; filter results carry the full path.
    await page.locator(".sidebar .filter").fill("Meeting");
    await page.locator(`.note-item[title="${rel}"]`).click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Rename…" }).click();
    await page.locator(".prompt-input").fill(to);
    await page.locator(".prompt-input").press("Enter");
  };
  test("renaming the copy Obsidian doesn't resolve to leaves the link alone", async ({ page, vault }) => {
    await openApp(page, vault);
    await renameRow(page, "Archive/Meeting.md", "Archive/Meeting 2019");
    await expect.poll(() => vault.exists("Archive/Meeting 2019.md")).toBe(true);
    await settle(page);
    expect(vault.read("Work/Index.md")).toBe("Next: [[Meeting]]\n");
  });
  test("renaming the copy in the linking note's folder rewrites the link", async ({ page, vault }) => {
    await openApp(page, vault);
    await renameRow(page, "Work/Meeting.md", "Work/Standup");
    await expect.poll(() => vault.read("Work/Index.md")).toBe("Next: [[Standup]]\n");
  });
});
