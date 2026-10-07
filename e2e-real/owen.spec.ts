import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
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

  test("show and hide as soon as the setting changes", async ({ page, vault }) => {
    await openApp(page, vault);
    const row = page.locator(".tree-row", { hasText: ".unisonbak.0.Ideas" });
    const setting = page.getByLabel("Show hidden files (names starting with a dot)");
    await page.getByRole("button", { name: "Settings" }).click();
    await setting.check();
    await expect(row).toHaveCount(1, { timeout: 1500 });
    // Hiding drops them from what's loaded, without reading a big vault again.
    await vault.stop();
    await setting.uncheck();
    await expect(row).toHaveCount(0, { timeout: 1500 });
    await vault.start();
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

test.describe("Link all", () => {
  const body =
    'Ideas in prose\nmath $Ideas^2$ here\n%% Ideas\nstill Ideas %%\n\n    Ideas in code\n\n<span title="Ideas">x</span>\n<!-- Ideas -->\n' +
    "Run `echo $$` now\n\n$$\nIdeas + x\n$$\n\n> [!ideas] T\n\nnote[^Ideas] and ideas@x.com\n\n[Ideas]: https://x.com/a\n";
  test.use({ vaultFiles: { "Odd.md": body } });

  test("links only mentions in the text, not in math, comments, code or HTML", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Ideas");
    await page.locator(".pane.dock .tab.view-tab", { hasText: "Backlinks" }).click();
    const unlinked = page.locator(".panel-section").nth(1);
    await expect(unlinked.locator(".ref-group", { hasText: "Odd" }).locator(".ref-child")).toHaveCount(1);
    await unlinked.locator(".link-all-btn").click();
    await expect.poll(() => vault.read("Odd.md")).toBe(body.replace("Ideas in prose", "[[Ideas]] in prose"));
  });
});

test.describe("backlink counts", () => {
  test.use({ vaultFiles: { "Mentions.md": "Ideas, then ideas again, and #ideas\n" } });

  test("count every match, as Obsidian does, and list a line once", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Ideas");
    await page.locator(".pane.dock .tab.view-tab", { hasText: "Backlinks" }).click();
    const linked = page.locator(".panel-section").first();
    await expect(linked.locator(".panel-title .count")).toHaveText("5");
    const welcome = linked.locator(".ref-group", { hasText: "Welcome" });
    await expect(welcome.locator(".ref-group-head .count")).toHaveText("4");
    await expect(welcome.locator(".ref-child")).toHaveCount(3);
    const unlinked = page.locator(".panel-section").nth(1);
    await expect(unlinked.locator(".panel-title .count")).toHaveText("2");
    await expect(unlinked.locator(".ref-group", { hasText: "Mentions" }).locator(".ref-child")).toHaveCount(1);
    await unlinked.locator(".link-all-btn").click();
    await expect.poll(() => vault.read("Mentions.md")).toBe("[[Ideas]], then [[ideas]] again, and #ideas\n");
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
    await page.locator(".tree-row.attachment", { hasText: "Board" }).click();
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
    await page.locator(".tree-row.attachment", { hasText: "Cards" }).click();
    await page.locator(".canvas-node-content a", { hasText: "CARDLINK" }).click();
    await page.waitForTimeout(500);
    expect(page.url()).toBe(start);
  });
});

test.describe("arrow keys past block widgets", () => {
  const body = [
    "# Steps",
    "",
    "intro",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "$$x^2 + y^2$$",
    "",
    '<svg viewBox="0 0 100 60" width="100"><line x1="0" y1="0" x2="100" y2="60" stroke="currentColor"/></svg>',
    "",
    "p one",
    "",
    "p two",
    "",
    "p three",
  ].join("\n");
  test.use({ vaultFiles: { "Steps.md": body } });

  test("ArrowUp moves one line at a time", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Steps");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "p three" }).click();
    const lineNo = async () => Number(/Ln (\d+)/.exec((await page.locator(".status-bar").textContent()) ?? "")?.[1]);
    expect(await lineNo()).toBe(17);
    const seen: number[] = [];
    for (let k = 0; k < 4; k++) {
      await page.keyboard.press("ArrowUp");
      seen.push(await lineNo());
    }
    expect(seen).toEqual([16, 15, 14, 13]);
    // Past the blank line, one step skips the drawing's own source line.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    expect(await lineNo()).toBe(10);
  });
});

test("the word count goes when the note is closed, as in Obsidian", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  const words = page.locator(".status-bar-item", { hasText: "words" });
  await expect(words).not.toHaveText("0 words");
  await page.locator(".pane:not(.dock) .tab", { hasText: "Ideas" }).locator(".tab-close").click();
  await expect(words).toHaveCount(0);
  await expect(page.locator(".status-bar")).not.toContainText("Ln ");
});

test.describe("clicking a rendered drawing", () => {
  const note = '# D\n\n<svg viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor"/></svg>\n\nafter\n';
  test.use({ vaultFiles: { "D.md": note } });

  test("puts the caret after it, so typing doesn't break it", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "D");
    await page.locator(".pane:not(.dock) .cm-html-block svg").click();
    await page.keyboard.type("Z");
    await settle(page, 1200);
    const disk = vault.read("D.md");
    expect(disk).toContain("\n<svg viewBox");
    expect(disk).toContain("</svg>Z\n");
  });
});

test.describe("clicks in the space around blocks", () => {
  test.use({
    vaultFiles: {
      "P.md": "---\ntitle: P\nstatus: draft\ntags: [alpha]\n---\nfirst-body\n\nsecond\n",
      "T.md": "# T\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nafter table\n",
      "E.md": "# E\n\n![[Inner]]\n\nafter embed\n",
      "Inner.md": "inner text\n",
    },
  });

  test("never type in front of the properties", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "P");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "second" }).click();
    const box = (await page.locator(".pane:not(.dock) .cm-properties").boundingBox())!;
    await page.mouse.click(box.x + 100, box.y + box.height + 9);
    await page.keyboard.type("Hello");
    await settle(page, 1500);
    const disk = vault.read("P.md");
    expect(disk.startsWith("---\ntitle: P\nstatus: draft\ntags: [alpha]\n---\n")).toBe(true);
    expect(disk).toMatch(/\n---\n[^\n]*Hello/);
  });

  test("below a table or an embed go after it", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "T");
    const table = (await page.locator(".pane:not(.dock) .cm-md-table").boundingBox())!;
    await page.mouse.click(table.x + 20, table.y + table.height + 5);
    await page.keyboard.type("K");
    await settle(page, 1200);
    expect(vault.read("T.md")).toContain("| a | b |\n| - | - |\n| 1 | 2 |\nK");
    await openNote(page, "E");
    const embed = (await page.locator(".pane:not(.dock) .cm-embed").first().boundingBox())!;
    await page.mouse.click(embed.x + 20, embed.y + embed.height + 2);
    await page.keyboard.type("J");
    await settle(page, 1200);
    expect(vault.read("E.md")).toContain("![[Inner]]\nJ");
  });
});

test.describe("an image map in a note", () => {
  test.use({
    vaultFiles: {
      "Map.md":
        '# Map\n\n<div><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="200" height="100" usemap="#m"><map name="m"><area shape="rect" coords="0,0,200,100" href="https://evil.example/area"></map></div>\n',
    },
  });

  test("never navigates the app's tab", async ({ page, vault }) => {
    await openApp(page, vault);
    const start = page.url();
    await openNote(page, "Map");
    await page.locator('button[title^="Toggle Reading view"]').click();
    const img = (await page.locator(".reading-view img[usemap]").boundingBox())!;
    await page.mouse.click(img.x + 50, img.y + 50);
    await page.waitForTimeout(500);
    expect(page.url()).toBe(start);
  });
});

test.describe("clicks on the edges of rendered blocks", () => {
  test.use({
    vaultFiles: {
      "Edge.md": "---\ntitle: P\ntags: [a]\n---\nfirst body\n\nBELOW\n\nEND\n",
      "Code.md": "---\ntitle: C\n---\n```latex\nx\n```\n\nEND\n",
      "Merm.md": "top\n\nABOVE\n\n```mermaid\ngraph TD\nA-->B\n```\n\nBELOW\n\nEND\n",
      "Math.md": "top\n\nABOVE\n\n$$\nx^2\n$$\n\nBELOW\n\nEND\n",
      "FmCallout.md": "---\ntitle: N\n---\n> [!note] Hi\n> body\n\nEND\n",
      "FmHead.md": "---\ntitle: H\n---\n# Heading one\n\nEND\n",
      "FmList.md": "---\ntitle: L\n---\n- item one\n\nEND\n",
      "Formula.md": "---\ntitle: M\n---\n$$\nx^2\n$$\n\nEND\n",
      "Last.md": "ABOVE\n\n$$x^2+1$$",
    },
  });

  test("never type into the hidden frontmatter", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Edge");
    const content = (await page.locator(".pane:not(.dock) .cm-content").first().boundingBox())!;
    for (const [dx, dy, ch] of [
      [200, -0.5, "Z"],
      [200, 0, "Y"],
      [10, -4, "Q"],
    ] as const) {
      await page.locator(".pane:not(.dock) .cm-line", { hasText: "END" }).click();
      const box = (await page.locator(".pane:not(.dock) .cm-properties").boundingBox())!;
      await page.mouse.click(dx === 10 ? content.x + 10 : box.x + dx, box.y + box.height + dy);
      await page.keyboard.type(ch);
    }
    await settle(page, 1500);
    const disk = vault.read("Edge.md");
    expect(disk.startsWith("---\ntitle: P\ntags: [a]\n---\n")).toBe(true);
  });

  test("never type after a diagram's closing fence", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Merm");
    await expect(page.locator(".pane:not(.dock) .cm-mermaid svg")).toBeVisible({ timeout: 15000 });
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "END" }).click();
    const m = (await page.locator(".pane:not(.dock) .cm-mermaid").boundingBox())!;
    await page.mouse.click(m.x + 60, m.y + m.height - 0.5);
    await page.keyboard.type("Z");
    await settle(page, 1500);
    expect(vault.read("Merm.md")).not.toContain("```Z");
  });

  test("selections that start at the bottom of the properties keep the frontmatter", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Edge");
    const content = (await page.locator(".pane:not(.dock) .cm-content").first().boundingBox())!;
    for (const act of ["double", "triple", "gutter", "shift", "drag"] as const) {
      await page.locator(".pane:not(.dock) .cm-line", { hasText: act === "shift" ? "BELOW" : "END" }).click();
      const box = (await page.locator(".pane:not(.dock) .cm-properties").boundingBox())!;
      const x = box.x + 120;
      const y = box.y + box.height;
      if (act === "double") await page.mouse.dblclick(x, y);
      else if (act === "triple") await page.mouse.click(x, y, { clickCount: 3 });
      else if (act === "gutter") await page.mouse.click(content.x + 10, y - 1, { clickCount: 3 });
      else if (act === "shift") {
        await page.keyboard.down("Shift");
        await page.mouse.click(x, y);
        await page.keyboard.up("Shift");
      } else {
        const end = (await page.locator(".pane:not(.dock) .cm-line", { hasText: "END" }).boundingBox())!;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, end.y + 5, { steps: 6 });
        await page.mouse.up();
      }
      await page.keyboard.type("Z");
      await expect(page.locator(".pane:not(.dock) .cm-properties"), act).toHaveCount(1, { timeout: 2000 });
    }
    await settle(page, 1500);
    expect(vault.read("Edge.md").startsWith("---\ntitle: P\ntags: [a]\n---\n")).toBe(true);
  });

  test("a cursor added near the properties keeps the others", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Edge");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "END" }).click();
    await page.keyboard.press("End");
    const box = (await page.locator(".pane:not(.dock) .cm-properties").boundingBox())!;
    await page.keyboard.down("Meta");
    await page.mouse.click(box.x + 120, box.y - 4);
    await page.keyboard.up("Meta");
    await page.keyboard.type("W");
    await settle(page, 1500);
    const disk = vault.read("Edge.md");
    expect(disk.startsWith("---\ntitle: P\ntags: [a]\n---\n")).toBe(true);
    expect(disk).toContain("ENDW");
  });

  test("clicks along a math block's edges type inside its delimiters", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Math");
    for (const [edge, dy, ch] of [
      ["bottom", 0, "Z"],
      ["bottom", -3, "Y"],
      ["top", 3, "Q"],
    ] as const) {
      await page.locator(".pane:not(.dock) .cm-line", { hasText: "END" }).click();
      const m = page.locator(".pane:not(.dock) .cm-math-block");
      await expect(m.locator(".katex")).toBeVisible();
      const box = (await m.boundingBox())!;
      await page.mouse.click(box.x + 60, (edge === "top" ? box.y : box.y + box.height) + dy);
      await page.keyboard.type(ch);
    }
    await settle(page, 1500);
    const disk = vault.read("Math.md");
    expect(disk).toMatch(/\nABOVE\n\n\$\$[^\n$]*\n/);
    expect(disk).toMatch(/\n[^\n$]*\$\$\n\nBELOW\n/);
  });

  test("a click in the gap under the properties keeps the first line's markup", async ({ page, vault }) => {
    await openApp(page, vault);
    for (const note of ["FmHead", "FmList"]) {
      await openNote(page, note);
      await page.locator(".pane:not(.dock) .cm-line", { hasText: "END" }).click();
      const box = (await page.locator(".pane:not(.dock) .cm-properties").boundingBox())!;
      await page.mouse.click(box.x + 200, box.y + box.height + 9);
      await page.keyboard.type("Z");
    }
    await settle(page, 1500);
    expect(vault.read("FmHead.md")).toContain("---\n# Heading");
    expect(vault.read("FmList.md")).toContain("---\n- item");
  });

  test("math right under the properties stays math", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Formula");
    for (const [dy, ch] of [
      [0, "Z"],
      [-0.5, "Y"],
    ] as const) {
      await page.locator(".pane:not(.dock) .cm-line", { hasText: "END" }).click();
      const box = (await page.locator(".pane:not(.dock) .cm-properties").boundingBox())!;
      await page.mouse.click(box.x + 120, box.y + box.height + dy);
      await page.keyboard.type(ch);
    }
    await settle(page, 1500);
    expect(vault.read("Formula.md")).toMatch(/^---\ntitle: M\n---\n\$\$/);
  });

  test("a drag from the top of the note selects the properties too", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Edge");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "END" }).click();
    const box = (await page.locator(".pane:not(.dock) .cm-properties").boundingBox())!;
    const end = (await page.locator(".pane:not(.dock) .cm-line", { hasText: "END" }).boundingBox())!;
    await page.mouse.move(box.x + 120, box.y - 3);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, end.y + 5, { steps: 8 });
    await page.mouse.up();
    expect(await page.evaluate(() => document.getSelection()?.toString() ?? "")).toContain("title: P");
  });

  test("a code block under the properties keeps its own padding below the gap", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Code");
    const first = page.locator(".pane:not(.dock) .cm-after-properties");
    await expect(first).toHaveCount(1);
    const style = await first.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { border: cs.borderTopWidth, padding: cs.paddingTop };
    });
    expect(style).toEqual({ border: "18px", padding: "6px" });
    // The top corners stay as round as any code block's, inside the gap.
    expect(await first.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("6px 24px");
  });

  test("a click below a note's last math block continues the note after it", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Last");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "ABOVE" }).click();
    const m = page.locator(".pane:not(.dock) .cm-math-block");
    await expect(m.locator(".katex")).toBeVisible();
    const box = (await m.boundingBox())!;
    await page.mouse.click(box.x + 60, box.y + box.height + 60);
    await page.keyboard.press("Enter");
    await page.keyboard.type("Z");
    await settle(page, 1500);
    expect(vault.read("Last.md")).toBe("ABOVE\n\n$$x^2+1$$\nZ");
  });

  test("a callout under the properties starts its bar below the gap", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "FmCallout");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "END" }).click();
    const line = page.locator(".pane:not(.dock) .cm-line.cm-after-properties");
    await expect(line).toHaveClass(/cm-callout/);
    const style = await line.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { gap: cs.borderTopWidth, bar: cs.borderLeftStyle, shadow: cs.boxShadow.includes("inset") };
    });
    expect(style).toEqual({ gap: "18px", bar: "none", shadow: true });
  });
});

test.describe("line breaks in Reading view", () => {
  test.use({ vaultFiles: { "Lines.md": "# Lines\n\ny = x^2\nx = 4\ny = 16 = height\n" } });

  test("each line keeps its break, as in Obsidian by default", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Lines");
    await page.locator('button[title^="Toggle Reading view"]').click();
    const para = page.locator(".reading-view p", { hasText: "x = 4" });
    await expect(para.locator("br")).toHaveCount(2);
  });
});

test.describe("line breaks with Strict line breaks on", () => {
  test.use({
    vaultFiles: {
      "Lines.md": "# Lines\n\ny = x^2\nx = 4\n",
      ".obsidian/app.json": '{"strictLineBreaks": true}',
    },
  });

  test("lines join into one, as in Obsidian", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Lines");
    await page.locator('button[title^="Toggle Reading view"]').click();
    const para = page.locator(".reading-view p", { hasText: "x = 4" });
    await expect(para).toBeVisible();
    await expect(para.locator("br")).toHaveCount(0);
  });
});

test.describe("a table's cells in Live Preview", () => {
  test.use({
    vaultFiles: {
      "Cells.md": "# Cells\n\n| a | b |\n| - | - |\n| $x^2$ | ==hi== |\n| ~~old~~ | #tag and #2026 |\n\nEND\n",
      "Tall.md": "# Tall\n\n$$x^2+1$$\n\n$$\n\\frac{a}{b} + \\sum_{i=1}^{n} x_i\n$$\n\n| q | r |\n| - | - |\n| $\\frac{1}{2}$ | $\\int_0^1 x\\,dx$ |\n\nBELOW\n\nEND\n",
    },
  });

  test("render math, highlights, strikethrough and tags", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Cells");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "END" }).click();
    const t = page.locator(".pane:not(.dock) .cm-md-table");
    await expect(t.locator(".katex")).toHaveCount(1);
    await expect(t).not.toContainText("$x^2$");
    await expect(t.locator("mark")).toHaveText("hi");
    await expect(t.locator("s")).toHaveText("old");
    await expect(t.locator(".cm-tag")).toHaveText(["#tag"]);
  });

  test("lines below math stay where a click lands once it renders", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Tall");
    // Nothing else may make CodeMirror measure again: the formulas alone must.
    await expect(page.locator(".pane:not(.dock) .cm-math-block .katex")).toHaveCount(2);
    await expect(page.locator(".pane:not(.dock) .cm-md-table .katex")).toHaveCount(2);
    await page.waitForTimeout(500);
    const offsets = await page.evaluate(() => {
      const el = document.querySelector(".pane:not(.dock) .cm-content") as HTMLElement & { cmTile?: { root: { view: any } } };
      const view = el.cmTile!.root.view;
      return [...el.querySelectorAll(".cm-line")].map((l) => {
        const blk = view.lineBlockAt(view.posAtDOM(l, 0));
        return Math.round(l.getBoundingClientRect().top - (blk.top + view.documentTop));
      });
    });
    expect(offsets.every((o: number) => Math.abs(o) <= 1)).toBe(true);
  });
});

test("a focused side panel isn't reported as a saved note", async ({ page, vault }) => {
  await openApp(page, vault);
  await page.getByRole("button", { name: "▸ Projects" }).click();
  await expect(page).toHaveTitle("Files · Basalt");
  await expect(page.locator(".status", { hasText: "Saved" })).toHaveCount(0);
});

test.describe("clicks on blank space inside the Properties box", () => {
  test.use({ vaultFiles: { "Box.md": "---\ntitle: Box\nstatus: draft\n---\nbody line\n\nEND\n" } });

  test("never type in front of the frontmatter", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Box");
    for (const fx of [0.55, 0.75, 0.95]) {
      for (const dy of [1, 2, 3, 4]) {
        await page.locator(".pane:not(.dock) .cm-line", { hasText: "END" }).click();
        const box = (await page.locator(".pane:not(.dock) .cm-properties").boundingBox())!;
        await page.mouse.click(box.x + box.width * fx, box.y + box.height - dy);
        await page.keyboard.type("Z");
      }
    }
    await settle(page, 1500);
    expect(vault.read("Box.md").startsWith("---\ntitle: Box\nstatus: draft\n---\n")).toBe(true);
  });
});

test.describe("task checkboxes in Live Preview", () => {
  test.use({ vaultFiles: { "Tasks.md": "# Tasks\n\n- [ ] one\n- [x] two\n\nEND\n" } });

  test("a click toggles the task", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Tasks");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "END" }).click();
    const boxes = page.locator(".pane:not(.dock) .cm-task-checkbox");
    await expect(boxes).toHaveCount(2);
    await boxes.nth(0).click();
    await expect(boxes).toHaveCount(2);
    await boxes.nth(1).click();
    await settle(page, 1500);
    expect(vault.read("Tasks.md")).toBe("# Tasks\n\n- [x] one\n- [ ] two\n\nEND\n");
  });
});

test.describe("clicks on lines with hidden markup", () => {
  const note = [
    "# Heading text",
    "",
    "> quote text",
    "",
    "> [!note] Callout title",
    "> body",
    "",
    "- [x] done item",
    "",
    "- plain item",
    "",
    "text ends **bold**",
    "",
    "> text ends ==hi==",
    "",
    "- text ends ~~gone~~",
    "",
    "some **bold** text",
    "",
    "END",
    "",
  ].join("\n");
  test.use({ vaultFiles: { "Edges.md": note } });

  const line = (page: import("@playwright/test").Page, text: string | RegExp) =>
    page.locator(".pane:not(.dock) .cm-line", { hasText: text }).first();
  const reset = (page: import("@playwright/test").Page) => line(page, /^END$/).click();
  const charAt = (page: import("@playwright/test").Page, lineText: string, word: string) =>
    page.evaluate(
      ([lt, w]) => {
        const el = [...document.querySelectorAll(".pane:not(.dock) .cm-line")].find((l) => l.textContent?.includes(lt));
        const walker = document.createTreeWalker(el!, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const i = n.textContent!.indexOf(w);
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 1);
          const b = r.getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        }
        return null;
      },
      [lineText, word] as const,
    );

  test("a click left of a line starts typing after its markup", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Edges");
    for (const text of ["Heading text", "quote text", "Callout title", "done item", "plain item"]) {
      await reset(page);
      const box = (await line(page, text).boundingBox())!;
      await page.mouse.click(box.x + 2, box.y + box.height / 2);
      await page.keyboard.type("Z");
    }
    await settle(page, 1500);
    const disk = vault.read("Edges.md");
    for (const want of ["# ZHeading text", "> Zquote text", "> [!note] ZCallout title", "- [x] Zdone item", "- Zplain item"])
      expect(disk).toContain(want);
  });

  test("a click past the end of a line types after its closing markup", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Edges");
    for (const text of ["text ends bold", "text ends hi", "text ends gone"]) {
      await reset(page);
      const box = (await line(page, text).boundingBox())!;
      await page.mouse.click(box.x + box.width - 12, box.y + box.height / 2);
      await page.keyboard.type("Z");
    }
    await settle(page, 1500);
    const disk = vault.read("Edges.md");
    for (const want of ["text ends **bold**Z", "> text ends ==hi==Z", "- text ends ~~gone~~Z"]) expect(disk).toContain(want);
  });

  test("a double-click selects the word, never its markup", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Edges");
    for (const [lineText, word] of [
      ["some", "bold"],
      ["Heading", "Heading"],
      ["quote text", "quote"],
      ["text ends hi", "hi"],
    ] as const) {
      await reset(page);
      const at = (await charAt(page, lineText, word))!;
      await page.mouse.dblclick(at.x, at.y);
      await page.keyboard.type("X");
    }
    await settle(page, 1500);
    const disk = vault.read("Edges.md");
    for (const want of ["some **X** text", "# X text", "> X text", "> text ends ==X=="]) expect(disk).toContain(want);
  });
});

test.describe("typing lists", () => {
  test.use({ vaultFiles: { "List.md": "Notes\n", "Kids.md": "- a\n- b\n\t- child\n- c\n", "Ord.md": "1. a\n2. b\n3. c\n" } });

  const caretAtEnd = async (page: import("@playwright/test").Page, text: string) => {
    await page.locator(".pane:not(.dock) .cm-line", { hasText: text }).first().click();
    await page.keyboard.press("End");
  };

  test("Enter on an empty item leaves the list, as in Obsidian", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "List");
    await caretAtEnd(page, "Notes");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- a");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.type("b");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("c");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("after list");
    await settle(page, 1500);
    expect(vault.read("List.md")).toBe("Notes\n- a\n\t- b\n- c\nafter list\n");
  });

  test("Tab and Shift-Tab move an item's children with it", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Kids");
    await caretAtEnd(page, "b");
    await page.keyboard.press("Tab");
    await settle(page, 1200);
    expect(vault.read("Kids.md")).toBe("- a\n\t- b\n\t\t- child\n- c\n");
    await page.keyboard.press("Shift+Tab");
    await settle(page, 1200);
    expect(vault.read("Kids.md")).toBe("- a\n- b\n\t- child\n- c\n");
  });

  test("Tab on a numbered item starts its own list at 1", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Ord");
    await caretAtEnd(page, "b");
    await page.keyboard.press("Tab");
    await settle(page, 1200);
    expect(vault.read("Ord.md")).toBe("1. a\n\t1. b\n2. c\n");
  });
});

test.describe("lines below content that loads late", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="320"><rect width="200" height="320" fill="#88a"/></svg>';
  test.use({
    vaultFiles: {
      "Diagram.md": "above\n\n```mermaid\ngraph TD\nA-->B\nB-->C\nC-->D\n```\n\nbelow one\nbelow two\nbelow three\n",
      "Picture.md": "above\n\n![[tall.svg]]\n\nbelow one\nbelow two\nbelow three\n",
      "tall.svg": svg,
      "Embedded.md": "above\n\n![[Inner]]\n\nbelow one\nbelow two\nbelow three\n",
      "Inner.md": "inner one\n\ninner two\n\ninner three\n",
    },
  });

  const offsets = (page: import("@playwright/test").Page) =>
    page.evaluate(() => {
      const el = document.querySelector(".pane:not(.dock) .cm-content") as HTMLElement & { cmTile?: { root: { view: any } } };
      const view = el.cmTile!.root.view;
      return [...el.querySelectorAll(".cm-line")].map((l) => {
        const blk = view.lineBlockAt(view.posAtDOM(l, 0));
        return Math.round(l.getBoundingClientRect().top - (blk.top + view.documentTop));
      });
    });

  for (const [note, ready] of [
    ["Diagram", ".cm-mermaid svg"],
    ["Picture", "img[src]"],
    ["Embedded", ".cm-embed .cm-embed-note, .cm-embed :text('inner three')"],
  ] as const) {
    test(`stay where clicks land below a ${note.toLowerCase()}`, async ({ page, vault }) => {
      await openApp(page, vault);
      await openNote(page, note);
      await expect(page.locator(`.pane:not(.dock) ${ready}`).first()).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(600);
      expect((await offsets(page)).every((o: number) => Math.abs(o) <= 1)).toBe(true);
      await page.locator(".pane:not(.dock) .cm-line", { hasText: "below two" }).click();
      await page.keyboard.press("End");
      await page.keyboard.type(" EDIT");
      await settle(page, 1200);
      expect(vault.read(`${note}.md`)).toContain("below two EDIT\n");
    });
  }
});

test.describe("a note with missing images", () => {
  const note = "before\n\n![my diagram](assets/does-not-exist.png)\n\n![[nope-missing.png]]\n\nafter\n";
  test.use({ vaultFiles: { "Missing.md": note } });

  test("is never rewritten by showing them as missing", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Missing");
    await expect(page.locator(".pane:not(.dock) .cm-content")).toContainText("my diagram", { timeout: 10000 });
    await page.waitForTimeout(6500); // past the one retry for a missing image
    await settle(page, 1500);
    expect(vault.read("Missing.md")).toBe(note);
  });
});

test.describe("a moved note's relative image link", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );
  test.use({ vaultFiles: { "Topic/Note.md": "# Note\n\n![pic](assets/pic.png)\n\nend\n", "Topic/assets/pic.png": png } });

  test("still shows the image, as in Obsidian", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.getByRole("button", { name: "▸ Topic" }).click();
    await openNote(page, "Note");
    await expect(page.locator(".pane:not(.dock) img.cm-md-image[src^='data:']")).toHaveCount(1);
    await page.evaluate(() => {
      const folder = [...document.querySelectorAll<HTMLElement>(".tree-row.folder")].find((r) => r.textContent?.includes("Projects"))!;
      const dt = new DataTransfer();
      dt.setData("application/x-basalt-note", document.querySelector<HTMLElement>(".tree-row.file.active")!.dataset.path!);
      folder.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => vault.exists("Projects/Note.md"), { timeout: 10000 }).toBe(true);
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "end" }).click();
    await expect(page.locator(".pane:not(.dock) img.cm-md-image[src^='data:']")).toHaveCount(1, { timeout: 10000 });
    await page.waitForTimeout(6500); // past a missing image's retry
    await settle(page, 1500);
    expect(vault.read("Projects/Note.md")).not.toContain("🖼");
    expect(vault.read("Projects/Note.md")).toContain("](");
  });
});

test.describe("closing tabs", () => {
  test("a side panel's tab closes without an error", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Ideas");
    const right = page.locator(".pane.dock").filter({ has: page.getByRole("tab", { name: "Outline" }) });
    await right.getByRole("tab", { name: "Backlinks" }).click();
    await right.getByRole("tab", { name: "Backlinks" }).locator("button").click();
    await expect(right.getByRole("tab", { name: "Backlinks" })).toHaveCount(0);
    await expect(right.getByRole("tab", { selected: true })).toHaveCount(1);
    await expect(page.locator(".status-error")).toHaveCount(0);
  });

  test("Cmd-W never closes the editor area or the side panels", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Ideas");
    for (let k = 0; k < 4; k++) await page.keyboard.press("Meta+w");
    await expect(page.locator(".pane:not(.dock)")).toHaveCount(1);
    await expect(page.getByRole("tab", { name: "Files" })).toHaveCount(1);
    await page.reload();
    await expect(page.locator(".pane:not(.dock)")).toHaveCount(1);
    await expect(page.getByRole("tab", { name: "Files" })).toHaveCount(1);
  });
});

test.describe("dollar amounts in Live Preview", () => {
  test.use({ vaultFiles: { "Money.md": "Copay +$25 and OOP +$25.\n\nprice $5 and `$var` here\n\n| a | b |\n| - | - |\n| $10 | $20 |\n\narea $x^2$ here\n\nEND\n" } });

  test("stay text, while real math renders", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Money");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    await expect(page.locator(".pane:not(.dock) .cm-line", { hasText: "Copay" })).toContainText("Copay +$25 and OOP +$25.");
    const price = page.locator(".pane:not(.dock) .cm-line", { hasText: "price" });
    await expect(price).toContainText("price $5 and");
    await expect(price.locator(".cm-math")).toHaveCount(0);
    await expect(page.locator(".pane:not(.dock) .cm-md-table")).toContainText("$10");
    await expect(page.locator(".pane:not(.dock) .cm-math")).toHaveCount(1);
  });
});

test.describe("a click beside an image", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#8a8"/></svg>';
  test.use({ vaultFiles: { "Beside.md": "top line\n\n![a|150](pic.svg)\n\n![[pic.svg|200]]\n\nbottom line\n", "pic.svg": svg } });

  test("types after the image, as before", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Beside");
    for (const [i, ch] of [
      [0, "Z"],
      [1, "Y"],
    ] as const) {
      await page.locator(".pane:not(.dock) .cm-line", { hasText: "top line" }).click();
      const img = page.locator(".pane:not(.dock) img.cm-md-image").nth(i);
      await expect(img).toHaveAttribute("src", /^data:/);
      const box = (await img.boundingBox())!;
      await page.mouse.click(box.x + box.width + 40, box.y + box.height / 2);
      await page.keyboard.type(ch);
    }
    await settle(page, 1500);
    const disk = vault.read("Beside.md");
    expect(disk).toContain("![a|150](pic.svg)Z");
    expect(disk).toContain("![[pic.svg|200]]Y");
  });
});

test.describe("clicking a tag", () => {
  test.use({ vaultFiles: { "Tagged.md": "one #alpha line\n", "Mentions.md": "`#alpha` in code only\n" } });

  test("searches the tag, not its text", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.getByRole("tab", { name: "Tags" }).click();
    await page.locator(".tag-name-btn", { hasText: "alpha" }).click();
    await expect(page.locator("input[type=search], .modal input").first()).toHaveValue(/^tag:#alpha/);
  });
});

test.describe("the quick switcher", () => {
  test.use({ vaultFiles: { "Kubernetes CLI Tools.md": "---\naliases:\n  - kubectl reference\n---\nbody\n" } });

  test("finds a note by its alias", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.keyboard.press("Meta+o");
    await page.locator(".palette-input").fill("kubectl ref");
    await expect(page.locator(".palette-item").first()).toContainText("Kubernetes CLI Tools");
  });
});

test("Cmd-E switches between editing and Reading view", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await page.locator(".pane:not(.dock) .cm-content").click();
  await page.keyboard.press("Meta+e");
  await expect(page.locator(".pane:not(.dock) .reading-view")).toHaveCount(1);
  await page.keyboard.press("Meta+e");
  await expect(page.locator(".pane:not(.dock) .reading-view")).toHaveCount(0);
  await expect(page.locator(".pane:not(.dock) .cm-content")).toHaveCount(1);
});

test.describe("link autocomplete", () => {
  test.use({ vaultFiles: { "Getting Started Guide.md": "guide\n", "Draft.md": "start\n" } });

  test("Enter picks the matching note, not Create new note", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Draft");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "start" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" [[Getting St");
    await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.press("End");
    await page.keyboard.type(" [[Brand New Idea");
    await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("Create new note");
    await page.keyboard.press("Enter");
    await settle(page, 1500);
    expect(vault.read("Draft.md")).toContain("[[Getting Started Guide]]");
    expect(vault.read("Draft.md")).toContain("[[Brand New Idea]]");
  });
});

test.describe("callouts in Live Preview", () => {
  test.use({ vaultFiles: { "Callouts.md": "> [!warning]\n> body one\n\n> [!tip] Custom title\n> body two\n\n> [!note]- Folded\n> hidden\n\nEND\n" } });

  test("show a default title and fold only when marked foldable", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Callouts");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const titles = page.locator(".pane:not(.dock) .cm-callout-title");
    await expect(titles.nth(0)).toContainText("Warning");
    await expect(titles.nth(1)).toContainText("Custom title");
    await expect(titles.nth(1)).not.toContainText("Tip");
    await expect(page.locator(".pane:not(.dock) .cm-callout-fold")).toHaveCount(1);
  });
});

test.describe("tasks with other statuses", () => {
  test.use({ vaultFiles: { "States.md": "- [ ] open\n- [x] done\n- [/] doing\n- [-] dropped\n1. [ ] numbered\n\nEND\n" } });

  test("render as checkboxes and toggle", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "States");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const boxes = page.locator(".pane:not(.dock) .cm-task-checkbox");
    await expect(boxes).toHaveCount(5);
    await boxes.nth(2).click();
    await settle(page, 1500);
    expect(vault.read("States.md")).toContain("- [ ] doing\n");
  });
});

test.describe("ticking a task in Reading view", () => {
  const long = Array.from({ length: 80 }, (_, i) => `- [ ] task ${i}`).join("\n") + "\n";
  test.use({ vaultFiles: { "Long.md": long } });

  test("keeps the scroll position", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Long");
    await page.locator('button[title^="Toggle Reading view"]').click();
    const view = page.locator(".pane:not(.dock) .reading-view");
    const box = view.locator("li", { hasText: "task 70" }).locator("input");
    await box.scrollIntoViewIfNeeded();
    const before = await view.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(200);
    await box.click();
    await settle(page, 1500);
    expect(vault.read("Long.md")).toContain("- [x] task 70");
    const after = await view.evaluate((el) => el.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(40);
  });
});

test.describe("links to headings, blocks and footnotes", () => {
  const filler = (tag: string) => Array.from({ length: 90 }, (_, i) => `${tag} line ${i}`).join("\n\n");
  const guide =
    "# Guide\n\n[[#Far heading]]\n\n[back](#Far%20heading)\n\nSee this[^1].\n\n" +
    `${filler("top")}\n\n## Far heading\n\nfar text\n\n${filler("mid")}\n\nThe block line ^blk\n\n${filler("end")}\n\n[^1]: The footnote.\n`;
  test.use({
    vaultFiles: {
      "Guide.md": guide,
      "Source.md": "# Source\n\n[[Guide#Far heading]]\n\n[blockref](Guide#^blk)\n\n[plain](Target)\n",
      "Target.md": "# Target\n\ntarget body\n",
    },
  });
  const reading = (page: import("@playwright/test").Page) => page.locator(".pane:not(.dock) .reading-view");

  test("open another note at the heading or block in Reading view", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Source");
    await page.locator('button[title^="Toggle Reading view"]').click();
    await reading(page).locator(".md-wikilink", { hasText: "Far heading" }).click();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Guide");
    await expect(reading(page).locator("h2", { hasText: "Far heading" })).toBeInViewport();
    await page.locator(".tree-row.file", { hasText: "Source" }).first().click();
    await reading(page).locator(".md-link", { hasText: "blockref" }).click();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Guide");
    await expect(reading(page).locator("p", { hasText: "The block line" })).toBeInViewport();
  });

  test("scroll within the note in Reading view, again after scrolling away", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Guide");
    await page.locator('button[title^="Toggle Reading view"]').click();
    const far = reading(page).locator("h2", { hasText: "Far heading" });
    await reading(page).locator(".md-wikilink", { hasText: "Far heading" }).click();
    await expect(far).toBeInViewport();
    await reading(page).evaluate((el) => (el.scrollTop = 0));
    await reading(page).locator(".md-wikilink", { hasText: "Far heading" }).click();
    await expect(far).toBeInViewport();
    await reading(page).evaluate((el) => (el.scrollTop = 0));
    await reading(page).locator(".md-link", { hasText: "back" }).click();
    await expect(far).toBeInViewport();
    await reading(page).evaluate((el) => (el.scrollTop = 0));
    await reading(page).locator(".footnote-ref a").click();
    await expect(reading(page).locator(".footnotes li", { hasText: "The footnote." })).toBeInViewport();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Guide");
  });

  test("a link without .md opens the note", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Source");
    await page.locator('button[title^="Toggle Reading view"]').click();
    await reading(page).locator(".md-link", { hasText: "plain" }).click();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Target");
    await page.locator('button[title^="Toggle Reading view"]').click();
    await openNote(page, "Source");
    await page.locator(".pane:not(.dock) .cm-md-link", { hasText: "plain" }).click();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Target");
    expect(vault.exists("Target.md.md")).toBe(false);
  });

  test("a same-note link scrolls the editor too", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Guide");
    await page.locator(".pane:not(.dock) .cm-wikilink", { hasText: "Far heading" }).click();
    // The caret lands on the heading, so its markup shows, as in Obsidian.
    const heading = page.locator(".pane:not(.dock) .cm-line", { hasText: /^## Far heading$/ });
    await expect(heading).toBeInViewport();
    await page.locator(".pane:not(.dock) .cm-scroller").evaluate((el) => (el.scrollTop = 0));
    await page.locator(".pane:not(.dock) .cm-wikilink", { hasText: "Far heading" }).click();
    await expect(heading).toBeInViewport();
  });
});

test.describe("a selection in Reading view", () => {
  test.use({ vaultFiles: { "Read.md": "# Read\n\nA sentence to copy from.\n", "Other.md": "other\n" } });

  test("stays when the app updates around it", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Read");
    await page.locator('button[title^="Toggle Reading view"]').click();
    const para = page.locator(".pane:not(.dock) .reading-view p", { hasText: "A sentence" });
    await para.click({ clickCount: 3 });
    await para.evaluate((el) => el.setAttribute("data-probe", "1"));
    expect(await page.evaluate(() => String(window.getSelection()))).toContain("A sentence to copy from.");
    vault.write("Other.md", "other, changed elsewhere\n");
    vault.write("New.md", "a new note\n");
    await expect(page.locator(".tree-row.file", { hasText: "New" })).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(page.locator(".reading-view p[data-probe]")).toHaveCount(1);
    expect(await page.evaluate(() => String(window.getSelection()))).toContain("A sentence to copy from.");
  });
});

test.describe("links to files that don't exist", () => {
  test.use({
    vaultFiles: {
      "Links.md":
        "# Links\n\n[[Exists]] and [[Missing]]\n\n[e](Exists.md) and [m](Gone%20Too)\n\n[[#Links]] and [[doc.pdf]] and [web](https://example.com)\n\nEND\n",
      "Exists.md": "here\n",
      "doc.pdf": "%PDF-1.4\n",
    },
  });

  test("show faded in Live Preview and Reading view", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Links");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const pane = page.locator(".pane:not(.dock)");
    await expect(pane.locator(".cm-wikilink.is-unresolved")).toHaveText(["Missing"]);
    await expect(pane.locator(".cm-md-link.is-unresolved")).toHaveText(["m"]);
    await expect(pane.locator(".cm-wikilink:not(.is-unresolved)")).toHaveCount(3);
    await page.locator('button[title^="Toggle Reading view"]').click();
    await expect(pane.locator(".reading-view .is-unresolved")).toHaveText(["Missing", "m"]);
    await pane.locator(".reading-view .md-wikilink", { hasText: "Missing" }).click();
    await expect(pane.locator(".tab.active .tab-name").first()).toHaveText("Missing");
    await page.locator(".tree-row.file", { hasText: "Links" }).first().click();
    await expect(pane.locator(".reading-view .is-unresolved")).toHaveText(["m"]);
  });
});

test.describe("the hover preview", () => {
  const long = Array.from({ length: 400 }, (_, i) => `filler sentence number ${i} to push the second part far down`).join("\n\n");
  test.use({
    vaultFiles: {
      "Hub.md": "# Hub\n\n[[Other#Part two]] and [[Other]] and [[#Hub section]]\n\nEND\n\n## Hub section\n\nHub section text.\n",
      "Other.md": `# Other\n\nFirst part text.\n\n${long}\n\n## Part two\n\nSecond part text, see [[Third]].\n\n![[Third]]\n\n## Part three\n\nThird part text.\n`,
      "Third.md": "Embedded words from Third.\n",
    },
  });
  const preview = (page: import("@playwright/test").Page) => page.locator(".hover-preview");

  test("shows the linked section with its embeds", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Hub");
    await page.locator('button[title^="Toggle Reading view"]').click();
    await page.locator(".pane:not(.dock) .reading-view .md-wikilink", { hasText: "Part two" }).hover();
    await expect(preview(page)).toBeVisible();
    await expect(preview(page)).toContainText("Second part text");
    await expect(preview(page)).not.toContainText("First part text.");
    await expect(preview(page)).not.toContainText("Third part text.");
    await expect(preview(page)).toContainText("Embedded words from Third.");
    await preview(page).locator(".md-wikilink", { hasText: "Third" }).click();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Third");
    await expect(preview(page)).toBeHidden();
  });

  test("of a link to a heading in the same note shows that section", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Hub");
    await page.locator('button[title^="Toggle Reading view"]').click();
    await page.locator(".pane:not(.dock) .reading-view .md-wikilink", { hasText: "Hub section" }).hover();
    await expect(preview(page)).toContainText("Hub section text.");
    await expect(preview(page)).not.toContainText("END");
  });

  test("closes when the link is clicked", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Hub");
    const link = page.locator(".pane:not(.dock) .cm-wikilink", { hasText: /^Other$/ });
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    await link.hover();
    await expect(preview(page)).toBeVisible();
    await link.click();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Other");
    await page.waitForTimeout(600);
    await expect(preview(page)).toBeHidden();
  });

  test("never opens for a link clicked before it shows", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Hub");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    await page.locator(".pane:not(.dock) .cm-wikilink", { hasText: /^Other$/ }).click();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Other");
    await page.waitForTimeout(800);
    await expect(preview(page)).toBeHidden();
  });
});

test.describe("empty folders", () => {
  test("show in the tree, and New folder makes one without a note", async ({ page, vault }) => {
    mkdirSync(vault.path("Empty"));
    mkdirSync(vault.path("Projects/Sub/Deeper"), { recursive: true });
    await openApp(page, vault);
    await expect(page.locator(".tree-row.folder", { hasText: "Empty" })).toBeVisible();
    await page.locator(".tree-row.folder", { hasText: "Projects" }).click();
    await page.locator(".tree-row.folder", { hasText: "Sub" }).click();
    await expect(page.locator(".tree-row.folder", { hasText: "Deeper" })).toBeVisible();

    await page.locator(".tree-row.folder", { hasText: "Empty" }).click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "New folder…" }).click();
    await page.locator(".prompt-input").fill("Fresh");
    await page.locator(".prompt-input").press("Enter");
    await expect.poll(() => vault.exists("Empty/Fresh") && statSync(vault.path("Empty/Fresh")).isDirectory()).toBe(true);
    expect(readdirSync(vault.path("Empty/Fresh"))).toEqual([]);
    await expect(page.locator(".tree-row.folder", { hasText: "Fresh" })).toBeVisible();

    page.once("dialog", (d) => void d.accept());
    await page.locator(".tree-row.folder", { hasText: "Fresh" }).click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Delete folder" }).click();
    await expect.poll(() => vault.exists("Empty/Fresh")).toBe(false);
    await expect(page.locator(".tree-row.folder", { hasText: "Fresh" })).toHaveCount(0);
  });
});

test.describe("the status bar", () => {
  test.use({
    vaultFiles: {
      "Count.md": "---\ntitle: Count\ntags: [a, b]\n---\nOne two three.\n",
      "Board.canvas": JSON.stringify({ nodes: [], edges: [] }),
      "Big.md": "word ".repeat(60000) + "\n",
    },
  });

  test("counts a very large note once it settles", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Big");
    await expect(page.locator(".status-bar")).toContainText("60,000 words");
    await expect(page.locator(".status-bar")).toContainText("300,001 characters");
  });

  test("counts as Obsidian does: no frontmatter, the selection, notes only", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Count");
    const bar = page.locator(".status-bar");
    await expect(bar).toContainText("3 words");
    await expect(bar).toContainText("15 characters");
    const line = page.locator(".pane:not(.dock) .cm-line", { hasText: "One two three." });
    await line.click();
    await expect(bar).toContainText("Ln 5");
    const two = await line.evaluate((el) => {
      const text = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes("two"))!;
      const range = document.createRange();
      const at = text.textContent!.indexOf("two");
      range.setStart(text, at);
      range.setEnd(text, at + 3);
      const r = range.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.dblclick(two.x, two.y);
    await expect(bar).toContainText("1 word ");
    await expect(bar).toContainText("3 characters");
    await page.keyboard.press("Shift+End");
    await expect(bar).toContainText("2 words");
    await expect(bar).toContainText("10 characters");
    await page.keyboard.press("ArrowRight");
    await expect(bar).toContainText("3 words");
    await page.locator('button[title^="Toggle Reading view"]').click();
    await expect(bar).not.toContainText("Ln ");
    await expect(bar).toContainText("3 words");
    await page.locator('button[title^="Toggle Reading view"]').click();
    await page.locator(".tree-row.attachment", { hasText: "Board" }).click();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toContainText("Board");
    await expect(bar).not.toContainText("words");
    await expect(bar).not.toContainText("Ln ");
  });
});

test.describe("Cmd-B with nothing selected", () => {
  test.use({ vaultFiles: { "Fmt.md": "make this bold\n" } });

  test("bolds the word at the caret", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Fmt");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "make this bold" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.press("End");
    await page.keyboard.type(" now");
    await settle(page, 1500);
    expect(vault.read("Fmt.md")).toBe("make this **bold** now\n");
  });
});

test.describe("a link's text in Live Preview", () => {
  test.use({ vaultFiles: { "Shown.md": "[[Projects/Alpha#Goals]] and [[#Top]] and [[Alpha|named]]\n\nEND\n" } });

  test("reads as Obsidian shows it", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Shown");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    await expect(page.locator(".pane:not(.dock) .cm-wikilink")).toHaveText(["Projects/Alpha > Goals", "Top", "named"]);
    await page.locator('button[title^="Toggle Reading view"]').click();
    await expect(page.locator(".pane:not(.dock) .reading-view .md-wikilink")).toHaveText(["Projects/Alpha > Goals", "Top", "named"]);
  });
});

test.describe("comments in Live Preview", () => {
  test.use({ vaultFiles: { "Cmt.md": "before %%inline note%% after\n\n%%\nblock line\n%%\n\n`code %%not%%` x\n\n    indented %%code%% too\n\nEND\n" } });

  test("show dimmed, as in Obsidian, not hidden", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Cmt");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const pane = page.locator(".pane:not(.dock)");
    await expect(pane.locator(".cm-line", { hasText: "before" })).toHaveText("before %%inline note%% after");
    await expect(pane.locator(".cm-comment", { hasText: "inline note" })).toHaveCount(1);
    await expect(pane.locator(".cm-line", { hasText: "block line" }).locator(".cm-comment")).toHaveCount(1);
    await expect(pane.locator(".cm-comment", { hasText: "%%not%%" })).toHaveCount(0);
    await expect(pane.locator(".cm-comment", { hasText: "%%code%%" })).toHaveCount(0);
    await page.locator('button[title^="Toggle Reading view"]').click();
    await expect(pane.locator(".reading-view pre", { hasText: "indented %%code%% too" })).toHaveCount(1);
    await expect(pane.locator(".reading-view")).not.toContainText("inline note");
  });
});

test.describe("tags", () => {
  test.use({ vaultFiles: { "Tg.md": "#café #日本 \\#notatag (#paren) #42 **#bold** #a/b-c\n\nEND\n" } });

  test("are read as Obsidian reads them, in both views", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Tg");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const want = ["#café", "#日本", "#bold", "#a/b-c"];
    await expect(page.locator(".pane:not(.dock) .cm-tag")).toHaveText(want);
    await page.locator('button[title^="Toggle Reading view"]').click();
    await expect(page.locator(".pane:not(.dock) .reading-view .md-tag")).toHaveText(want);
  });
});

test.describe("escaped characters in Live Preview", () => {
  test.use({ vaultFiles: { "Esc.md": "ESC \\*not italic\\* and \\#nottag end\n\nEND\n" } });

  test("hide their backslash until the caret reaches them", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Esc");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const line = page.locator(".pane:not(.dock) .cm-line", { hasText: "ESC" });
    await expect(line).toHaveText("ESC *not italic* and #nottag end");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    await expect(line).toHaveText("ESC \\*not italic* and #nottag end");
    expect(vault.read("Esc.md")).toBe("ESC \\*not italic\\* and \\#nottag end\n\nEND\n");
  });
});

test.describe("a link with formatting in its text", () => {
  test.use({ vaultFiles: { "Fmt2.md": "[plain **bold** and *it*](https://example.com)\n\nEND\n" } });

  test("shows the formatting in Live Preview", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Fmt2");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const link = page.locator(".pane:not(.dock) .cm-md-link");
    await expect(link).toHaveText("plain bold and it");
    await expect(link.locator("strong")).toHaveText("bold");
    await expect(link.locator("em")).toHaveText("it");
  });
});

test.describe("inline HTML in Live Preview", () => {
  test.use({
    vaultFiles: { "Html.md": 'a <span style="color:red">red</span> <b>bold</b> <font color="green">grn</font> <i>it</i> z\n\nEND\n' },
  });

  test("renders the tags Reading view renders, with no raw markup", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Html");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const line = page.locator(".pane:not(.dock) .cm-line").first();
    await expect(line).toHaveText("a red bold grn it z");
    await expect(line.locator(".cm-html-b")).toHaveCSS("font-weight", "700");
    await expect(line.locator(".cm-html-i")).toHaveCSS("font-style", "italic");
    await expect(line.locator(".cm-html-font")).toHaveCSS("color", "rgb(0, 128, 0)");
  });
});

test.describe("footnotes in Live Preview", () => {
  test.use({ vaultFiles: { "Fn.md": "A claim[^1] and an aside^[said in passing] here.\n\n[^1]: The source.\n\nEND\n" } });

  test("show as small raised marks, as in Obsidian", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Fn");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const line = page.locator(".pane:not(.dock) .cm-line").first();
    await expect(line).toHaveText("A claim1 and an asidesaid in passing here.");
    await expect(line.locator(".cm-footnote-ref")).toHaveText("1");
    await expect(line.locator(".cm-footnote-inline")).toHaveText("said in passing");
    await expect(line.locator(".cm-footnote-inline")).toHaveCSS("vertical-align", "super");
    await expect(page.locator(".pane:not(.dock) .cm-line", { hasText: "The source." })).toHaveText("[^1]: The source.");
  });
});

test.describe("a line right under a table", () => {
  test.use({ vaultFiles: { "Tbl.md": "first\n| a | b |\n| - | - |\n| 1 | 2 |\nSource: a sentence\nnext\nEND\n" } });

  test("is its own line, as in Obsidian, and the arrow keys reach it", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Tbl");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    await expect(page.locator(".pane:not(.dock) .cm-line", { hasText: "Source: a sentence" })).toHaveCount(1);
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^first$/ }).click();
    const ln = async () => Number(/Ln (\d+)/.exec((await page.locator(".status-bar-item", { hasText: "Ln " }).textContent()) ?? "")?.[1]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    expect(await ln()).toBeLessThan(7);
    await page.locator('button[title^="Toggle Reading view"]').click();
    await expect(page.locator(".pane:not(.dock) .reading-view p", { hasText: "Source: a sentence" })).toHaveCount(1);
    await expect(page.locator(".pane:not(.dock) .reading-view td", { hasText: "Source" })).toHaveCount(0);
  });
});

test.describe("a table in Live Preview", () => {
  const t = [
    "| Left | Center | Right |",
    "|:-----|:------:|------:|",
    "| [[Projects/Alpha#Goals]] | [ext](https://example.com) | a<br>b |",
    "| [[Ideas\\|the ideas]] | x | y |",
    "",
    "END",
  ].join("\n");
  test.use({ vaultFiles: { "T.md": t + "\n" } });

  test("aligns columns, breaks lines at <br>, and its links open", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "T");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const table = page.locator(".pane:not(.dock) .cm-md-table-wrap");
    const align = (sel: string) => table.locator(sel).evaluateAll((els) => els.map((e) => getComputedStyle(e).textAlign));
    expect(await align("th")).toEqual(["left", "center", "right"]);
    expect(await align("tbody tr:first-child td")).toEqual(["left", "center", "right"]);
    await expect(table.locator("td br")).toHaveCount(1);
    const alpha = table.locator(".cm-wikilink").first();
    await expect(alpha).toHaveText("Projects/Alpha > Goals");
    await expect(alpha).toHaveAttribute("data-target", "Projects/Alpha#Goals");
    await table.locator(".cm-wikilink", { hasText: "the ideas" }).click();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Ideas");
  });
});

test.describe("callout colours", () => {
  test.use({ vaultFiles: { "Co.md": "> [!warning]\n> careful\n\n> [!tip] Hint\n> body\n\n> [!my-type2]\n> x\n\nEND\n" } });

  test("follow the type, the same in both views", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Co");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const pane = page.locator(".pane:not(.dock)");
    const lpColor = (i: number) => pane.locator(".cm-callout-title").nth(i).evaluate((e) => getComputedStyle(e).color);
    const lp = [await lpColor(0), await lpColor(1), await lpColor(2)];
    expect(new Set(lp).size).toBe(3);
    await expect(pane.locator(".cm-callout-title")).toHaveCount(3);
    await page.locator('button[title^="Toggle Reading view"]').click();
    const rv = await pane.locator(".reading-view .md-callout-title").evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
    expect(rv).toEqual(lp);
  });
});

test.describe("quotes and bare links in Live Preview", () => {
  test.use({ vaultFiles: { "Q.md": "Body text line\n\n> a quote line\n\n> [!tip] Tip\n> callout body\n\nsee https://example.com/path here\n\nEND\n" } });

  test("sit on the text column, in plain type, and links take the link colour", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Q");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const left = (text: string) =>
      page.locator(".pane:not(.dock) .cm-line", { hasText: text }).evaluate((e) => {
        const r = document.createRange();
        r.selectNodeContents(e);
        return [...r.getClientRects()].find((x) => x.width > 0)!.left;
      });
    const body = await left("Body text line");
    expect(await left("a quote line")).toBeGreaterThan(body);
    expect(await left("callout body")).toBeGreaterThan(body);
    await expect(page.locator(".pane:not(.dock) .cm-line", { hasText: "a quote line" })).toHaveCSS("font-style", "normal");
    const link = page.locator(".pane:not(.dock) .cm-md-link", { hasText: "example.com" });
    const own = await link.evaluate((e) => getComputedStyle(e).color);
    const inner = await link.evaluate((e) => getComputedStyle(e.querySelector("span") ?? e).color);
    expect(inner).toBe(own);
  });
});

test.describe("block widgets in Live Preview", () => {
  test.use({
    vaultFiles: { "W.md": "Body text\n\n```query\ntag:#x\n```\n\n<div>html block</div>\n\n![[Inner]]\n\nEND\n", "Inner.md": "Inner words.\n" },
  });

  test("start on the text column, as Reading view's do", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "W");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const pane = page.locator(".pane:not(.dock)");
    const x = (loc: import("@playwright/test").Locator) => loc.evaluate((e) => e.getBoundingClientRect().left);
    const body = await pane.locator(".cm-line", { hasText: "Body text" }).evaluate((e) => {
      const r = document.createRange();
      r.selectNodeContents(e);
      return r.getClientRects()[0].left;
    });
    for (const sel of [".cm-query .query-error", ".cm-html-block > *", ".cm-embed .embed"]) {
      expect(Math.abs((await x(pane.locator(sel).first())) - body)).toBeLessThan(4);
    }
  });
});

test.describe("code blocks", () => {
  test.use({ vaultFiles: { "Code.md": "```js\nconst answer = \"forty\"; // note\nfunction go() { return 42; }\n```\n\nEND\n" } });

  test("are coloured the same in both views", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Code");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const pane = page.locator(".pane:not(.dock)");
    const colors = async (scope: import("@playwright/test").Locator) => ({
      keyword: await scope.locator(".code-keyword", { hasText: "const" }).evaluate((e) => getComputedStyle(e).color),
      string: await scope.locator(".code-string").first().evaluate((e) => getComputedStyle(e).color),
      number: await scope.locator(".code-value", { hasText: "42" }).evaluate((e) => getComputedStyle(e).color),
    });
    const lp = await colors(pane.locator(".cm-content"));
    expect(new Set(Object.values(lp)).size).toBe(3);
    await page.locator('button[title^="Toggle Reading view"]').click();
    expect(await colors(pane.locator(".reading-view"))).toEqual(lp);
  });
});

test.describe("a property being typed", () => {
  test.use({ vaultFiles: { "Prop.md": "---\ntitle: Stress\n---\nbody\n" } });

  test("is kept by Cmd-E and by closing the tab", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Prop");
    const input = page.locator(".pane:not(.dock) .cm-properties input").first();
    await input.click();
    await page.keyboard.press("End");
    await page.keyboard.type("XYZ");
    await page.keyboard.press("ControlOrMeta+e");
    await page.keyboard.press("ControlOrMeta+e");
    await expect.poll(() => vault.read("Prop.md")).toContain("StressXYZ");
    await page.locator(".pane:not(.dock) .cm-properties input").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("2");
    await page.keyboard.press("ControlOrMeta+w");
    await expect.poll(() => vault.read("Prop.md")).toContain("StressXYZ2");
    // Ctrl-Tab to another tab keeps it too.
    await openNote(page, "Ideas");
    await openNote(page, "Prop");
    await page.locator(".pane:not(.dock) .cm-properties input").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("3");
    await page.keyboard.press("Control+Tab");
    await expect.poll(() => vault.read("Prop.md")).toContain("StressXYZ23");
  });
});

test.describe("a loose numbered list", () => {
  test.use({ vaultFiles: { "Loose.md": "1. alpha\n\n2. bravo\n\n3. charlie\n\nEND\n" } });

  test("numbers as Obsidian does through Tab and Shift-Tab", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Loose");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "bravo" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Tab");
    await settle(page, 1200);
    // Obsidian renumbers the edited line and the one after it, not past a gap.
    expect(vault.read("Loose.md")).toBe("1. alpha\n\n\t1. bravo\n\n3. charlie\n\nEND\n");
    await page.keyboard.press("Shift+Tab");
    await settle(page, 1200);
    expect(vault.read("Loose.md")).toBe("1. alpha\n\n2. bravo\n\n3. charlie\n\nEND\n");
  });
});

test.describe("an HTML comment with text after it", () => {
  test.use({ vaultFiles: { "Hc.md": "<!-- c --> visible tail\n\n<!-- only a comment -->\n\npara\n" } });

  test("keeps the text in Reading view", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Hc");
    await page.locator('button[title^="Toggle Reading view"]').click();
    const view = page.locator(".pane:not(.dock) .reading-view");
    await expect(view).toContainText("visible tail");
    await expect(view).not.toContainText("only a comment");
    await expect(view).toContainText("para");
  });
});

test.describe("a table row wider than its header", () => {
  test.use({ vaultFiles: { "Wide.md": "| a | b |\n| - | - |\n| 1 | 2 | extra words |\n\nEND\n" } });

  test("shows the extra cell in both views", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Wide");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    await expect(page.locator(".pane:not(.dock) .cm-md-table-wrap td", { hasText: "extra words" })).toHaveCount(1);
    await page.locator('button[title^="Toggle Reading view"]').click();
    await expect(page.locator(".pane:not(.dock) .reading-view td", { hasText: "extra words" })).toHaveCount(1);
  });
});

test.describe("a link in a property", () => {
  test.use({ vaultFiles: { "Pl.md": '---\nup: "[[Ideas]]"\n---\nbody\n' } });

  test("opens from Reading view", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Pl");
    await page.locator('button[title^="Toggle Reading view"]').click();
    await page.locator(".pane:not(.dock) .reading-view .md-properties .md-wikilink", { hasText: "Ideas" }).click();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Ideas");
  });
});

test.describe("a PDF embed with a page", () => {
  const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
  test.use({ vaultFiles: { "Paper notes.md": "![[doc.pdf#page=3]]\n\n![[doc.pdf#height=250]]\n\nEND\n", "doc.pdf": pdf } });

  test("opens at that page, in both views", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Paper notes");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const lp = page.locator(".pane:not(.dock) .cm-content embed.md-media-pdf");
    await expect(lp).toHaveCount(2);
    expect(await lp.first().getAttribute("src")).toMatch(/#page=3$/);
    await expect(lp.nth(1)).toHaveCSS("height", "250px");
    await page.locator('button[title^="Toggle Reading view"]').click();
    const rv = page.locator(".pane:not(.dock) .reading-view embed.md-media-pdf");
    await expect(rv).toHaveCount(2);
    expect(await rv.first().getAttribute("src")).toMatch(/#page=3$/);
  });
});

test.describe("a folded heading", () => {
  test.use({ vaultFiles: { "Fold.md": "# A\nhidden one\nhidden two\n# B\nafter\n" } });

  test("opens instead of letting Backspace or Delete change what it hides", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Fold");
    const pane = page.locator(".pane:not(.dock)");
    await pane.locator(".cm-line", { hasText: "after" }).click();
    await pane.locator(".cm-fold-marker").first().click({ force: true });
    await expect(pane.locator(".cm-line", { hasText: "hidden one" })).toHaveCount(0);
    // Typing still goes to the editor after the gutter click.
    await page.keyboard.type("!");
    await settle(page, 900);
    expect(vault.read("Fold.md")).toContain("after!");
    await pane.locator(".cm-line", { hasText: /^# B$|^B$/ }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");
    await expect(pane.locator(".cm-line", { hasText: "hidden two" })).toHaveCount(1);
    await settle(page, 900);
    expect(vault.read("Fold.md")).toBe("# A\nhidden one\nhidden two\n# B\nafter!\n");
  });

  test("shows the section when typing after its placeholder", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Fold");
    const pane = page.locator(".pane:not(.dock)");
    await pane.locator(".cm-line", { hasText: "after" }).click();
    await pane.locator(".cm-fold-marker").first().click({ force: true });
    await expect(pane.locator(".cm-line", { hasText: "hidden one" })).toHaveCount(0);
    await pane.locator(".cm-line").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("Z");
    await expect(pane.locator(".cm-line", { hasText: "hidden twoZ" })).toHaveCount(1);
    await expect.poll(() => vault.read("Fold.md")).toBe("# A\nhidden one\nhidden twoZ\n# B\nafter\n");
  });

  test("opens instead of letting a selection that seems to end at the heading change it", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Fold");
    const pane = page.locator(".pane:not(.dock)");
    const fold = async () => {
      await pane.locator(".cm-line", { hasText: "after" }).click();
      await pane.locator(".cm-fold-marker").first().click({ force: true });
      await expect(pane.locator(".cm-line", { hasText: "hidden one" })).toHaveCount(0);
    };
    const gestures: [string, () => Promise<void>][] = [
      ["Shift+End, Backspace", async () => { await page.keyboard.press("Shift+End"); await page.keyboard.press("Backspace"); }],
      ["Shift+End, typing", async () => { await page.keyboard.press("Shift+End"); await page.keyboard.type("New"); }],
      ["Shift+Home from the end, typing", async () => { await page.keyboard.press("End"); await page.keyboard.press("Shift+Home"); await page.keyboard.type("Fresh"); }],
    ];
    for (const [name, act] of gestures) {
      await fold();
      await page.keyboard.press("ControlOrMeta+Home");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect(pane.locator(".cm-line", { hasText: "hidden one" })).toHaveCount(0);
      await act();
      await expect(pane.locator(".cm-line", { hasText: "hidden two" }), name).toHaveCount(1);
      await settle(page, 900);
      // Keys after the first go into the heading; what it hid stays.
      expect(vault.read("Fold.md"), name).toMatch(/^#[^\n]*\nhidden one\nhidden two\n# B\nafter\n$/);
      vault.write("Fold.md", "# A\nhidden one\nhidden two\n# B\nafter\n");
      await expect(pane.locator(".cm-line").first()).toHaveText(/^(# )?A$/);
    }
  });

  test("opens instead of letting the right-click Cut or Paste change it", async ({ page, vault, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openApp(page, vault);
    await openNote(page, "Fold");
    const pane = page.locator(".pane:not(.dock)");
    for (const item of ["Cut", "Paste"]) {
      await pane.locator(".cm-line", { hasText: "after" }).click();
      await page.evaluate(() => navigator.clipboard.writeText("PASTED"));
      await pane.locator(".cm-fold-marker").first().click({ force: true });
      await expect(pane.locator(".cm-line", { hasText: "hidden one" })).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+Home");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Shift+End");
      const box = (await pane.locator(".cm-selectionBackground").first().boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
      await page.locator(".ctx-item", { hasText: new RegExp(`^${item}$`) }).click();
      await expect(pane.locator(".cm-line", { hasText: "hidden two" }), item).toHaveCount(1);
      await settle(page, 900);
      expect(vault.read("Fold.md"), item).toBe("# A\nhidden one\nhidden two\n# B\nafter\n");
    }
  });

  test("lets a selection the user made be deleted, hidden text and all", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Fold");
    const pane = page.locator(".pane:not(.dock)");
    await pane.locator(".cm-line", { hasText: "after" }).click();
    await pane.locator(".cm-fold-marker").first().click({ force: true });
    await expect(pane.locator(".cm-line", { hasText: "hidden one" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await expect.poll(() => vault.read("Fold.md")).toBe("");
  });
});

test.describe("links inside a Live Preview embed", () => {
  test.use({
    vaultFiles: {
      "Host.md": "![[Embedded]]\n\nend\n",
      "Embedded.md": "Go to [[#Target]] or [md](#Target) or [[NavA]] or [web](https://example.com/x).\n\n## Target\n\ntext\n",
      "NavA.md": "# NavA\n",
    },
  });

  test("open, as in Obsidian, and leave the embed rendered", async ({ page, vault }) => {
    await openApp(page, vault);
    const pane = page.locator(".pane:not(.dock)").first();
    const active = pane.locator(".tab.active .tab-name");
    const embed = pane.locator(".cm-embed");
    const host = async () => {
      await openNote(page, "Host");
      await pane.locator(".cm-line", { hasText: /^end$/ }).click();
    };
    await host();
    await embed.locator(".md-wikilink", { hasText: "NavA" }).click();
    await expect(active).toHaveText("NavA");
    await host();
    await embed.locator(".md-wikilink", { hasText: "Target" }).click();
    await expect(active).toHaveText("Embedded");
    await host();
    await embed.locator(".md-link", { hasText: "md" }).click();
    await expect(active).toHaveText("Embedded");
    expect(vault.read("Host.md")).toBe("![[Embedded]]\n\nend\n");
  });
});

test.describe("pasting HTML", () => {
  test.use({ vaultFiles: { "Paste.md": "start\n\n```\ncode here\n```\n\nEND\n" } });

  const paste = (page: import("@playwright/test").Page, html: string, text: string) =>
    page.locator(".pane:not(.dock) .cm-content").evaluate(
      (el, [h, t]) => {
        const dt = new DataTransfer();
        dt.setData("text/html", h);
        dt.setData("text/plain", t);
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      },
      [html, text],
    );

  test("turns a web page into Markdown, and leaves code and plain text alone", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Paste");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><h2>Plan</h2>' +
      '<p>Read <a href="https://example.com/a b">the doc</a> and <span style="font-weight:700">ship</span> it, <i>soon</i>.</p>' +
      '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol start="3"><li>third</li></ol>' +
      "<blockquote><p>quoted</p></blockquote><pre><code class=\"language-js\">let x = 1;\n</code></pre>" +
      "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2|3</td></tr></table></b>";
    await paste(page, html, "Plan Read the doc and ship it, soon.");
    await settle(page, 1200);
    const body = vault.read("Paste.md").split("END\n")[1];
    expect(body).toBe(
      "## Plan\n\nRead [the doc](https://example.com/a%20b) and **ship** it, *soon*.\n\n" +
        "- one\n- two\n\t- nested\n\n3. third\n\n> quoted\n\n```js\nlet x = 1;\n```\n\n" +
        "| a | b |\n| --- | --- |\n| 1 | 2\\|3 |" +
        "\n",
    );
    // Plain text with no formatting pastes as it is.
    await paste(page, "<span>just *text*</span>", "just *text*");
    await settle(page, 1200);
    expect(vault.read("Paste.md")).toContain("2\\|3 |just *text*");
    // Into a code block, never converted.
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "code here" }).click();
    await page.keyboard.press("End");
    await paste(page, "<b>bold</b>", "bold");
    await settle(page, 1200);
    expect(vault.read("Paste.md")).toContain("code herebold\n");
  });

  test("keeps every item of a list indented the way Chromium writes it, and code as it was", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Paste");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await paste(
      page,
      "<ul><li>parent</li><ul><li>child one</li><li>child two</li></ul><li>after</li></ul><p><code>a`b</code></p><pre>x\n```\ny</pre>",
      "parent\nchild one\nchild two\nafter\na`b\nx\n```\ny",
    );
    await settle(page, 1200);
    expect(vault.read("Paste.md").split("END\n")[1]).toBe(
      "- parent\n\t- child one\n\t- child two\n- after\n\n``a`b``\n\n````\nx\n```\ny\n````\n",
    );
  });
});

test.describe("the vault's own settings", () => {
  test.use({
    vaultFiles: {
      ".obsidian/app.json": '{"promptDelete": false, "showLineNumber": true, "readableLineLength": false}',
      "Gone.md": "to delete\n",
    },
  });

  test("line numbers, full width, and deleting without a prompt, as in Obsidian", async ({ page, vault }) => {
    let dialogs = 0;
    page.on("dialog", (d) => {
      dialogs++;
      void d.accept();
    });
    await openApp(page, vault);
    await openNote(page, "Ideas");
    await expect(page.locator(".pane:not(.dock) .cm-lineNumbers")).toBeVisible();
    await expect(page.locator(".app")).not.toHaveClass(/readable-width/);
    await page.locator(".tree-row.file", { hasText: "Gone" }).click({ button: "right" });
    await page.locator(".ctx-item", { hasText: /^Delete/ }).click();
    await expect.poll(() => vault.exists("Gone.md")).toBe(false);
    expect(dialogs).toBe(0);
  });
});

test.describe("navigation history", () => {
  test.use({ vaultFiles: { "First.md": "[[Second]]\n", "Second.md": "[[Third]]\n", "Third.md": "end\n" } });

  test("goes back and forward through the notes shown, as in Obsidian", async ({ page, vault }) => {
    await openApp(page, vault);
    const active = page.locator(".pane:not(.dock) .tab.active .tab-name").first();
    await openNote(page, "First");
    await openNote(page, "Second");
    await openNote(page, "Third");
    await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(active).toHaveText("Second");
    await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(active).toHaveText("First");
    await page.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    await expect(active).toHaveText("Second");
    // A new note from here drops what was ahead.
    await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
    await expect(active).toHaveText("Ideas");
    await page.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    await expect(active).toHaveText("Ideas");
    await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(active).toHaveText("Second");
    // From inside the editor too.
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(active).toHaveText("First");
  });

  test("skips a deleted note and the note showing, and follows a renamed one", async ({ page, vault }) => {
    await openApp(page, vault);
    const active = page.locator(".pane:not(.dock) .tab.active .tab-name").first();
    for (const n of ["Third", "First", "Second", "First"]) await openNote(page, n);
    rmSync(vault.path("Second.md"));
    await expect(page.locator(".tree-row.file", { hasText: "Second" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(active).toHaveText("Third");
    await openNote(page, "First");
    await page.locator(".tree-row.file", { hasText: "Third" }).click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Rename…" }).click();
    await page.locator(".prompt-input").fill("Third renamed");
    await page.locator(".prompt-input").press("Enter");
    await expect(page.locator(".tree-row.file", { hasText: "Third renamed" })).toHaveCount(1);
    await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(active).toHaveText("Third renamed");
  });
});

test.describe("a callout inside a callout", () => {
  test.use({ vaultFiles: { "Nest.md": "> [!note] Outer\n> outer text\n> > [!tip] Inner\n> > inner text\n\nEND\n" } });

  test("shows its own title and bar in Live Preview", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Nest");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const inner = page.locator(".pane:not(.dock) .cm-callout-inner-title");
    await expect(inner).toHaveText("💡Inner");
    await expect(page.locator(".pane:not(.dock) .cm-quote-inner")).toHaveCount(2);
    await expect(page.locator(".pane:not(.dock) .cm-callout-title")).toHaveText("🗒️Outer");
  });
});

test.describe("hiding dot files while one is being typed in", () => {
  test.use({ vaultFiles: { ".dotnote.md": "dot\n" } });

  test("saves the typing first, with no false conflict", async ({ page, vault }) => {
    await openApp(page, vault);
    const setting = page.getByLabel("Show hidden files (names starting with a dot)");
    await page.getByRole("button", { name: "Settings" }).click();
    await setting.check();
    await page.keyboard.press("Escape");
    await page.locator(".tree-row.file", { hasText: ".dotnote" }).click();
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" typed");
    await page.getByRole("button", { name: "Settings" }).click();
    await setting.uncheck();
    await page.keyboard.press("Escape");
    await expect.poll(() => vault.read(".dotnote.md")).toBe("dot\n typed");
    await settle(page, 1200);
    await expect(page.locator(".app")).not.toContainText("changed on disk");
  });
});

test.describe("renumbering a list next to other lists", () => {
  test.use({
    vaultFiles: {
      "AfterBullets.md": "- a\n- b\n\n1. x\n2. y\n3. z\n",
      "Delims.md": "1. a\n2. b\n\n1) x\n2) y\n",
      "Zeros.md": "01. a\n02. b\n03. c\n",
    },
  });
  const tabRoundTrip = async (page: import("@playwright/test").Page, line: string) => {
    await page.locator(".pane:not(.dock) .cm-line", { hasText: line }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Tab");
  };

  test("numbers as Obsidian does next to other lists", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "AfterBullets");
    await tabRoundTrip(page, "y");
    await settle(page, 1200);
    expect(vault.read("AfterBullets.md")).toBe("- a\n- b\n\n1. x\n\t1. y\n2. z\n");
    await page.keyboard.press("Shift+Tab");
    await settle(page, 1200);
    expect(vault.read("AfterBullets.md")).toBe("- a\n- b\n\n1. x\n2. y\n3. z\n");

    await openNote(page, "Delims");
    await tabRoundTrip(page, "b");
    await page.keyboard.press("Shift+Tab");
    await settle(page, 1200);
    // Obsidian counts on across a blank line, whatever the delimiter.
    expect(vault.read("Delims.md")).toBe("1. a\n2. b\n\n3) x\n4) y\n");

    await openNote(page, "Zeros");
    await tabRoundTrip(page, "b");
    await settle(page, 1200);
    expect(vault.read("Zeros.md")).toBe("01. a\n\t1. b\n2. c\n");
  });
});

test.describe("a property field just focused", () => {
  test.use({ vaultFiles: { "Quoted.md": '---\ntitle: "Duck.ai"\ntags:\n  - one\n---\nbody\n' } });

  test("leaves the file alone when nothing was typed", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Quoted");
    await page.locator(".pane:not(.dock) .cm-properties input").first().click();
    await page.keyboard.press("ControlOrMeta+e");
    await page.keyboard.press("ControlOrMeta+e");
    await page.locator(".pane:not(.dock) .cm-properties .cm-prop-pill input").first().click();
    await page.keyboard.press("ControlOrMeta+e");
    await settle(page, 1500);
    expect(vault.read("Quoted.md")).toBe('---\ntitle: "Duck.ai"\ntags:\n  - one\n---\nbody\n');
  });
});

test.describe("a heading link inside an embed", () => {
  test.use({
    vaultFiles: {
      "Host.md": "# Host\n\n![[Embedded]]\n\nEND\n",
      "Embedded.md": "See [[#Far part]] and [there](#Far%20part).\n\n" + "filler\n\n".repeat(80) + "## Far part\n\nfar text\n",
    },
  });

  test("goes to the embedded note's heading", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Host");
    await page.locator('button[title^="Toggle Reading view"]').click();
    await page.locator(".pane:not(.dock) .reading-view .embed .md-wikilink", { hasText: "Far part" }).click();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Embedded");
    await expect(page.locator(".pane:not(.dock) .reading-view h2", { hasText: "Far part" })).toBeInViewport();
  });
});

test.describe("Backspace on a quote line written without a space", () => {
  test.use({ vaultFiles: { "Bs.md": "> [!note] T\n>body\n\nEND\n" } });

  test("deletes one character, never the marker with it", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Bs");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "body" }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Backspace");
    await settle(page, 1200);
    expect(vault.read("Bs.md")).toBe("> [!note] T\n>ody\n\nEND\n");
  });
});

test.describe("an image in an HTML block", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  test.use({ vaultFiles: { "Html img.md": '<div align="center"><img src="assets/pic.png" alt="P" width="40"></div>\n\nEND\n', "assets/pic.png": png } });

  test("shows the vault's image in both views", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Html img");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^END$/ }).click();
    const lp = page.locator(".pane:not(.dock) .cm-html-block img");
    await expect(lp).toHaveAttribute("src", /^(data:|blob:|asset:|http)/);
    await expect.poll(() => lp.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    await page.locator('button[title^="Toggle Reading view"]').click();
    const rv = page.locator(".pane:not(.dock) .reading-view img");
    await expect.poll(() => rv.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  });
});

test.describe("search", () => {
  test.use({
    vaultFiles: {
      "Plan.md": "---\nstatus: draft\n---\n# Plan\n- [ ] call Alice about budget\n- [x] email Bob about budget\n",
      "Other.md": "budget talk\n",
    },
  });

  test("counts its results and knows Obsidian's operators", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.keyboard.press("ControlOrMeta+Shift+f");
    const input = page.locator(".palette-input").first();
    await input.fill("budget");
    await expect(page.locator(".palette-summary")).toHaveText("3 results in 2 notes");
    await input.fill("task-todo:budget");
    await expect(page.locator("[role=option]")).toHaveCount(1);
    await expect(page.locator("[role=option]")).toContainText("call Alice");
    await input.fill("[status:draft] budget");
    await expect(page.locator(".palette-summary")).toHaveText("2 results in 1 note");
  });
});
