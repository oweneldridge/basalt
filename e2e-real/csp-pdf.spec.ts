import { test, expect, openApp, openNote } from "./fixture";

// The headless shell has no PDF viewer; full Chromium loads one in a frame,
// which the web CSP has to allow.
test.use({
  channel: "chromium",
  vaultFiles: {
    "Paper.md": "# Paper\n\n![[doc.pdf]]\n",
    "doc.pdf": new Uint8Array(Buffer.from("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 100 100]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")),
  },
});

test("a PDF embed loads under the web CSP", async ({ page, vault }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await openApp(page, vault);
  await openNote(page, "Paper");
  await page.locator('button[title^="Toggle Reading view"]').click();
  await expect(page.locator(".pane:not(.dock) .reading-view embed, .pane:not(.dock) .reading-view object").first()).toBeAttached({ timeout: 10000 });
  await page.waitForTimeout(1500);
  expect(violations).toEqual([]);
});
