import { test, expect, type Page } from "@playwright/test";

const extra = {
  "Sneaky.md": [
    "# Sneaky",
    "",
    '<div><img src="&#1;https://img.example.test/ctrl.png" alt="a"></div>',
    "",
    '<div><img src="ht&#9;tps://img.example.test/tab.png" alt="b"></div>',
    "",
    '<div><img src="\\\\img.example.test/bs.png" alt="c"></div>',
    "",
    '<div><img src="/\\img.example.test/bs2.png" alt="d"></div>',
    "",
    '<div><svg width="10" height="10"><rect width="10" height="10" fill="url(https://img.example.test/fill.svg#p)"/></svg></div>',
    "",
    '<div><svg width="10" height="10"><rect width="10" height="10" mask="url(\\68ttps://img.example.test/escaped.png)"/></svg></div>',
    "",
    "```mermaid",
    "flowchart LR",
    "  B@{ img: https://img.example.test/unquoted.png, label: u }",
    "```",
    "",
    "```mermaid",
    "flowchart LR",
    '  A@{ img: "https://img.example.test/mermaid.png", label: "pic", pos: "t", w: 20, h: 20 }',
    "```",
    "",
    "end of sneaky",
    "",
  ].join("\n"),
  "Tricky.md": [
    "# Tricky",
    "",
    "![noslash](https:img.example.test/noslash.png)",
    "",
    '<div><svg width="10" height="10"><image href="https://img.example.test/svg.png" width="10" height="10"/></svg></div>',
    "",
    '<div><video poster="https://img.example.test/poster.png"></video></div>',
    "",
    '<div><picture><source srcset="https://img.example.test/source.png"><img alt="pic"></picture></div>',
    "",
    '<div><table><tr><td background="https://img.example.test/bg.png">cell</td></tr></table></div>',
    "",
    '<div><input type="image" src="https://img.example.test/input.png" alt="go"></div>',
    "",
  ].join("\n"),
  "Pictures.md": '# Pictures\n\n![cat](https://img.example.test/cat.png)\n\n<div><img src="https://img.example.test/dog.png" alt="dog"></div>\n\nend\n',
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function open(page: Page, remote: boolean): Promise<string[]> {
  const hits: string[] = [];
  await page.route(/img\.example\.test/, (route) => {
    hits.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  await page.addInitScript(
    ([files, on]) => {
      (window as unknown as { __mockExtraFiles: Record<string, string> }).__mockExtraFiles = files as Record<string, string>;
      localStorage.setItem("basalt-remote-images", String(on));
    },
    [extra, remote] as const,
  );
  await page.goto("/app-harness.html");
  await page.locator(".tree-row.file", { hasText: "Pictures" }).click();
  return hits;
}

const pane = (page: Page) => page.locator(".pane:not(.dock)");

test("with remote images off, notes show placeholders and fetch nothing", async ({ page }) => {
  const hits = await open(page, false);
  const editor = pane(page).locator(".cm-content .md-image-blocked");
  await expect(editor).toHaveCount(2);
  await expect(editor.first()).toContainText("img.example.test");
  await page.locator('button[title^="Toggle Reading view"]').click();
  const reading = pane(page).locator(".reading-view");
  await expect(reading.locator(".md-image-blocked")).toHaveCount(2);
  await expect(reading.locator("img")).toHaveCount(0);
  expect(hits).toEqual([]);
});

test("with remote images on, they load", async ({ page }) => {
  const hits = await open(page, true);
  await expect(pane(page).locator(".cm-content img.cm-md-image")).toHaveAttribute("src", "https://img.example.test/cat.png");
  await page.locator('button[title^="Toggle Reading view"]').click();
  await expect(pane(page).locator(".reading-view img")).toHaveCount(2);
  await expect.poll(() => hits.length).toBeGreaterThanOrEqual(2);
});

test("the setting is a labelled checkbox in Settings", async ({ page }) => {
  await open(page, true);
  await page.keyboard.press("ControlOrMeta+,");
  const box = page.getByRole("checkbox", { name: "Load remote images" });
  await expect(box).toBeChecked();
  await box.uncheck();
  expect(await page.evaluate(() => localStorage.getItem("basalt-remote-images"))).toBe("false");
  // The page now refuses remote images until it reloads, and says so.
  await box.check();
  await expect(page.getByRole("checkbox", { name: /Load remote images \(after a reload\)/ })).toBeChecked();
});

test("with remote images off, no other kind of tag or link fetches one either", async ({ page }) => {
  const hits = await open(page, false);
  await page.locator(".tree-row.file", { hasText: "Tricky" }).click();
  await expect(pane(page).locator(".cm-content")).toContainText("Tricky");
  await page.waitForTimeout(500);
  await page.locator('button[title^="Toggle Reading view"]').click();
  await expect(pane(page).locator(".reading-view")).toContainText("cell");
  await page.waitForTimeout(800);
  expect(hits).toEqual([]);
});

test("odd URL spellings, SVG url() references and Mermaid images don't fetch either", async ({ page }) => {
  const hits = await open(page, false);
  await page.locator(".tree-row.file", { hasText: "Sneaky" }).click();
  await expect(pane(page).locator(".cm-content")).toContainText("end of sneaky");
  await page.waitForTimeout(800);
  await page.locator('button[title^="Toggle Reading view"]').click();
  await expect(pane(page).locator(".reading-view")).toContainText("end of sneaky");
  await expect(pane(page).locator(".reading-view .md-mermaid svg").first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(800);
  expect(hits).toEqual([]);
});
