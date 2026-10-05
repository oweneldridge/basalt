import { test, expect, openApp, openNote, settle } from "./fixture";

test.describe("inline SVG in a note", () => {
  const svg = [
    "# Drawing",
    "",
    "Text before.",
    "",
    '<svg viewBox="0 0 420 320" width="420" xmlns="http://www.w3.org/2000/svg" style="max-width:100%" onload="window.__svgHacked=1">',
    '<line x1="40" y1="290" x2="395" y2="290" stroke="#e8710a" stroke-width="1"/>',
    '<text x="55" y="48" font-size="12" fill="#1a73e8">orange: slope 5</text>',
    "<script>window.__svgHacked=2</script>",
    '<foreignObject width="10" height="10"><div onclick="1">x</div></foreignObject>',
    '<animate attributeName="href" to="javascript:alert(1)"/>',
    "</svg>",
    "",
    "Text after #real",
  ].join("\n");
  test.use({ vaultFiles: { "Drawing.md": svg } });

  test("renders, sanitized, in Live Preview and Reading view", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Drawing");
    const pane = page.locator(".pane:not(.dock)").first();
    const live = pane.locator(".cm-html-block svg");
    await expect(live).toHaveCount(1);
    await expect(live.locator("line")).toHaveCount(1);
    await expect(live.locator("text")).toHaveText("orange: slope 5");
    await expect(pane.locator(".cm-html-block script, .cm-html-block foreignObject, .cm-html-block animate")).toHaveCount(0);
    expect(await live.getAttribute("onload")).toBeNull();
    await expect(pane.locator(".cm-tag", { hasText: "#e8710a" })).toHaveCount(0);
    await page.locator('button[title^="Toggle Reading view"]').click();
    const read = pane.locator(".reading-view .raw-html svg");
    await expect(read).toHaveCount(1);
    await expect(read.locator("line")).toHaveCount(1);
    await expect(pane.locator(".reading-view script, .reading-view foreignObject")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __svgHacked?: number }).__svgHacked)).toBeUndefined();
    expect(vault.read("Drawing.md")).toBe(svg);
  });
});

test.describe("hidden files", () => {
  test.use({ vaultFiles: { ".unisonbak.0.Ideas.md": "backup words\n", "Projects/.unisonbak.1.Alpha.md": "backup words\n" } });

  test("stay out of the tree, search and switcher until shown", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.folder", { hasText: "Projects" }).click();
    await expect(page.locator(".tree-row", { hasText: "unisonbak" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+o");
    await page.locator(".palette-input").first().fill("unisonbak");
    await expect(page.locator("[role=option]", { hasText: "Create note" })).toHaveCount(1);
    await expect(page.locator("[role=option]", { hasText: ".unisonbak" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await page.locator(".palette-input").first().fill("backup words");
    await page.waitForTimeout(500);
    await expect(page.locator("[role=option]", { hasText: "unisonbak" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Show hidden files (names starting with a dot)").check();
    await page.keyboard.press("Escape");
    await expect(page.locator(".tree-row", { hasText: ".unisonbak.0.Ideas" })).toHaveCount(1, { timeout: 10000 });
    await page.keyboard.press("ControlOrMeta+o");
    await page.locator(".palette-input").first().fill("unisonbak");
    await expect(page.locator("[role=option]", { hasText: ".unisonbak" }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    expect(vault.exists(".unisonbak.0.Ideas.md")).toBe(true);
    expect(vault.exists("Projects/.unisonbak.1.Alpha.md")).toBe(true);
  });
});

test("the word count stays when a side panel is focused", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  const words = page.locator(".status-bar-item", { hasText: "words" });
  await expect(words).not.toHaveText("0 words");
  const before = await words.textContent();
  await page.locator(".pane.dock .tab.view-tab", { hasText: "Outline" }).click();
  await expect(words).toHaveText(before ?? "");
});

test.describe("unlinked mentions", () => {
  test.use({ vaultFiles: { "Target.md": "# Target\n", "Src.md": "see Target here\n" } });

  test("Link in the Backlinks panel links the mention", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Target");
    await page.locator(".pane.dock .tab.view-tab", { hasText: "Backlinks" }).click();
    await page.locator(".ref-link-btn").first().click();
    await expect.poll(() => vault.read("Src.md")).toBe("see [[Target]] here\n");
  });
});

test.describe("a canvas edited during a rename's canvas write", () => {
  test.use({
    vaultFiles: {
      "Board.canvas": JSON.stringify({
        nodes: [
          { id: "f1", type: "file", file: "Ideas.md", x: 0, y: 0, width: 240, height: 120 },
          { id: "a1", type: "text", text: "a1", x: 300, y: 0, width: 200, height: 60 },
        ],
        edges: [],
      }),
    },
  });

  test("keeps the card and the fixed reference", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Ideas");
    await page.getByRole("button", { name: "Split right" }).first().click();
    await expect(page.locator(".pane:not(.dock)")).toHaveCount(2);
    await page.locator(".tree-row.attachment", { hasText: "Board.canvas" }).click();
    const addCard = page.locator('button[title="Add a card"]');
    await expect(addCard).toBeVisible();
    let release: () => void = () => {};
    let held = false;
    await page.route("**/api/invoke", async (route) => {
      const body = route.request().postData() ?? "";
      const res = await route.fetch().catch(() => null);
      if (!res) return;
      if (!held && body.includes('"cmd":"write_canvas"')) {
        held = true;
        await new Promise<void>((r) => (release = r));
      }
      await route.fulfill({ response: res }).catch(() => {});
    });
    const ideasPane = page.locator(".pane:not(.dock)").filter({ has: page.locator(".tab.active", { hasText: "Ideas" }) });
    const title = ideasPane.locator("input.inline-title").first();
    await title.fill("Ideas Renamed");
    await title.press("Enter");
    await expect.poll(() => held, { timeout: 10000 }).toBe(true);
    await addCard.click();
    await page.waitForTimeout(100);
    release();
    await settle(page, 2000);
    await addCard.click();
    await settle(page, 2000);
    const board = JSON.parse(vault.read("Board.canvas")) as { nodes: { id: string; file?: string }[] };
    expect(board.nodes.length).toBe(4);
    expect(board.nodes.find((n) => n.id === "f1")?.file).toBe("Ideas Renamed.md");
  });
});

test.describe("links inside rendered HTML", () => {
  test.use({
    vaultFiles: {
      "Links.md": '# Links\n\n<svg viewBox="0 0 200 40"><a xlink:href="https://evil.example/phish"><text x="5" y="25">XLINK</text></a></svg>\n\nend\n',
      "Cards.canvas": JSON.stringify({
        nodes: [{ id: "t1", type: "text", text: '<div><a href="https://evil.example/card">CARDLINK</a></div>', x: 0, y: 0, width: 260, height: 80 }],
        edges: [],
      }),
    },
  });

  test("never navigate the app's tab", async ({ page, vault }) => {
    await openApp(page, vault);
    const start = page.url();
    await openNote(page, "Links");
    await page.locator('button[title^="Toggle Reading view"]').click();
    await page.locator(".reading-view text", { hasText: "XLINK" }).click();
    await page.waitForTimeout(500);
    expect(page.url()).toBe(start);
    await page.locator('button[title^="Toggle Reading view"]').click();
    await page.locator(".tree-row.attachment", { hasText: "Cards.canvas" }).click();
    await page.locator(".canvas-node-content a", { hasText: "CARDLINK" }).click();
    await page.waitForTimeout(500);
    expect(page.url()).toBe(start);
  });
});
