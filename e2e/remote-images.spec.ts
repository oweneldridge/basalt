import { test, expect, type Page } from "@playwright/test";

const extra = {
  "Pictures.md": '# Pictures\n\n![cat](https://img.example.test/cat.png)\n\n<div><img src="https://img.example.test/dog.png" alt="dog"></div>\n\nend\n',
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function open(page: Page, remote: boolean): Promise<string[]> {
  const hits: string[] = [];
  await page.route("https://img.example.test/**", (route) => {
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
});
