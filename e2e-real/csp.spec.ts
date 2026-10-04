import { test, expect, openApp, openNote } from "./fixture";

const showcase = [
  "# Showcase",
  "",
  "Inline math $x^2$ and a block:",
  "",
  "$$",
  "\\int_0^1 x\\,dx",
  "$$",
  "",
  "```mermaid",
  "flowchart LR",
  "  A --> B",
  "```",
  "",
  '<div class="raw">raw <b>html</b></div>',
  "",
  "![[Tasks.base]]",
  "",
].join("\n");

test.describe("the web app's security headers", () => {
  test.use({
    vaultFiles: {
      "Showcase.md": showcase,
      "Tasks.base": "views:\n  - type: list\n    name: All\n",
      "Board.canvas": JSON.stringify({ nodes: [{ id: "a", type: "text", text: "card", x: 0, y: 0, width: 200, height: 80 }], edges: [] }),
    },
  });

  test("every response carries the CSP and friends", async ({ vault }) => {
    for (const path of ["/", "/api/vault-root", "/no/such/route"]) {
      const r = await fetch(vault.url + path);
      expect(r.headers.get("content-security-policy"), path).toContain("frame-ancestors 'none'");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  test("injected scripts don't run, plugins' eval does, and the app renders without violations", async ({ page, vault }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
    });
    page.on("pageerror", (e) => violations.push(`pageerror: ${e.message}`));
    await openApp(page, vault);
    const injected = await page.evaluate(() => {
      const s = document.createElement("script");
      s.textContent = "window.__injected = true";
      document.body.append(s);
      return (window as unknown as { __injected?: boolean }).__injected ?? false;
    });
    expect(injected).toBe(false);
    await expect.poll(() => violations.some((v) => /inline script/i.test(v) && /Content Security Policy/i.test(v))).toBe(true);
    violations.length = 0;
    expect(await page.evaluate(() => new Function("return 1 + 1")())).toBe(2);

    await openNote(page, "Showcase");
    await expect(page.locator(".pane:not(.dock) .embed-base .base-view")).toBeVisible();
    await page.locator('button[title^="Toggle Reading view"]').click();
    const reading = page.locator(".pane:not(.dock) .reading-view");
    await expect(reading.locator("svg").first()).toBeVisible({ timeout: 15000 });
    await expect(reading.locator(".raw b")).toHaveText("html");
    await page.locator(".tree-row.attachment", { hasText: "Board.canvas" }).click();
    await expect(page.locator(".canvas-node")).toHaveCount(1);
    await page.waitForTimeout(500);
    expect(violations).toEqual([]);
  });
});
