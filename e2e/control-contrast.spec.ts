import { test, expect, type Page } from "@playwright/test";

// WCAG 1.4.11: the edge of a text field or select needs 3:1 against what's
// around it (its border, or its own fill if it has no border).
async function weakControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const opaque = (c: number[]) => c.length >= 3 && (c.length < 4 || c[3] > 0.5);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const behind = (el: Element | null): number[] => {
      for (let e = el; e; e = e.parentElement) {
        const c = rgb(getComputedStyle(e).backgroundColor);
        if (opaque(c)) return c.slice(0, 3);
      }
      return [255, 255, 255];
    };
    const sel = "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=hidden]), select, textarea";
    const weak: string[] = [];
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const cs = getComputedStyle(el);
      const around = behind(el.parentElement);
      const bordered = ["top", "right", "bottom", "left"].some(
        (s) => cs.getPropertyValue(`border-${s}-style`) !== "none" && parseFloat(cs.getPropertyValue(`border-${s}-width`)) > 0,
      );
      const edge = bordered ? ratio(rgb(cs.borderBottomColor).slice(0, 3), around) : 0;
      const fill = rgb(cs.backgroundColor);
      const body = opaque(fill) ? ratio(fill.slice(0, 3), around) : 1;
      const best = Math.max(edge, body);
      if (best < 3) weak.push(`${best.toFixed(2)} ${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.className}`);
    });
    return weak;
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`inputs and selects have visible edges (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript((t) => localStorage.setItem("basalt.theme", t), scheme);
    await page.goto("/app-harness.html");
    await expect(page.locator(".sidebar")).toBeVisible();
    expect(await weakControls(page)).toEqual([]);
    await page.locator(".tree-row.attachment", { hasText: "Notes.base" }).click();
    await page.getByRole("button", { name: "✎ Edit" }).click();
    await expect(page.locator(".base-editor")).toBeVisible();
    expect(await weakControls(page)).toEqual([]);
  });
}
