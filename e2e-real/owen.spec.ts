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
