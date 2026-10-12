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
    await page.locator(".tree-row.attachment", { hasText: "Notes" }).click();
    await page.getByRole("button", { name: "✎ Edit" }).click();
    await expect(page.locator(".base-editor")).toBeVisible();
    expect(await weakControls(page)).toEqual([]);
  });
}

// WCAG 1.4.3: placeholder text needs 4.5:1 against its field.
async function faintPlaceholders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
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
        if (c.length >= 3 && (c.length < 4 || c[3] > 0.5)) return c.slice(0, 3);
      }
      return [255, 255, 255];
    };
    const faint: string[] = [];
    document.querySelectorAll<HTMLInputElement>("input[placeholder]:not(.inline-title), textarea[placeholder]").forEach((el) => {
      if (!el.getBoundingClientRect().width) return;
      const ph = getComputedStyle(el, "::placeholder");
      const c = rgb(ph.color);
      const shown = c.length >= 4 ? c[3] * parseFloat(ph.opacity || "1") : parseFloat(ph.opacity || "1");
      const r = ratio(c.slice(0, 3), behind(el));
      if (r < 4.5 || shown < 1) faint.push(`${r.toFixed(2)} ${el.placeholder}`);
    });
    // CodeMirror boxes (the Bases filter and formula fields) draw their own.
    document.querySelectorAll<HTMLElement>(".cm-placeholder").forEach((el) => {
      if (!el.getBoundingClientRect().width) return;
      const r = ratio(rgb(getComputedStyle(el).color).slice(0, 3), behind(el));
      if (r < 4.5) faint.push(`${r.toFixed(2)} ${el.textContent}`);
    });
    return faint;
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`placeholders and side panels read clearly (${scheme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript((t) => localStorage.setItem("basalt.theme", t), scheme);
    await page.goto("/app-harness.html");
    await expect(page.locator(".sidebar")).toBeVisible();
    expect(await faintPlaceholders(page)).toEqual([]);
    // The Files panel doesn't scroll sideways, and its sort menu sits inside it.
    const files = await page.locator(".sidebar-controls").evaluate((el) => {
      const panel = el.closest(".leaf-view") ?? el.parentElement!;
      const sort = el.querySelector(".file-sort")!.getBoundingClientRect();
      return { overflow: panel.scrollWidth - panel.clientWidth, sortRight: sort.right, panelRight: panel.getBoundingClientRect().right };
    });
    expect(files.overflow).toBeLessThanOrEqual(0);
    expect(files.sortRight).toBeLessThanOrEqual(files.panelRight);
    // Every tab in a side dock is in view, without scrolling.
    for (const bar of await page.locator(".pane.dock .tab-bar").all()) {
      const box = await bar.boundingBox();
      for (const tab of await bar.locator(".tab").all()) {
        const t = await tab.boundingBox();
        expect(t!.x + t!.width).toBeLessThanOrEqual(box!.x + box!.width + 0.5);
        // A tooltip names it, on its name or icon rather than the tab, so the
        // name isn't read out twice.
        expect(await tab.locator("[title], svg title").count()).toBeGreaterThan(0);
        expect(await tab.getAttribute("title")).toBeNull();
      }
    }
    // A note tab in a narrow dock shrinks to fit, its name cut short.
    const narrow = await page.locator(".pane.dock-right .tab-strip").first().evaluate((strip) => {
      const pane = strip.closest(".pane") as HTMLElement;
      pane.style.width = "150px";
      pane.style.flex = "none";
      const tab = document.createElement("div");
      tab.className = "tab";
      tab.innerHTML = '<span class="tab-name">A very long note name that goes on and on</span><button class="tab-close">×</button>';
      strip.append(tab);
      const out = { right: tab.querySelector(".tab-close")!.getBoundingClientRect().right, edge: strip.parentElement!.getBoundingClientRect().right, wide: 0 };
      // In a wide one it keeps a note tab's usual cap.
      pane.style.width = "495px";
      out.wide = tab.getBoundingClientRect().width;
      tab.remove();
      pane.style.width = pane.style.flex = "";
      return out;
    });
    expect(narrow.right).toBeLessThanOrEqual(narrow.edge + 0.5);
    expect(narrow.wide).toBeLessThanOrEqual(200);
    // The Outline icon, all straight lines, is drawn on whole pixels.
    await expect(page.locator(".pane.dock .tab.view-tab", { hasText: "Outline" }).locator(".tab-icon path")).toHaveAttribute("shape-rendering", "crispEdges");
    // So do fields further in: a note's properties, a base's filter and the
    // Graph view's filter.
    await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
    await page.locator(".pane.dock .tab.view-tab", { hasText: "Properties" }).click();
    await expect(page.getByPlaceholder("Add property…").first()).toBeVisible();
    expect(await faintPlaceholders(page)).toEqual([]);
    await page.locator(".tree-row.attachment", { hasText: "Notes" }).click();
    await page.getByRole("button", { name: "\u270e Edit" }).click();
    await page.locator(".base-editor-section", { hasText: "Filter" }).locator(".base-filter-add").click();
    await expect(page.locator(".cm-placeholder").first()).toBeVisible();
    expect(await faintPlaceholders(page)).toEqual([]);
    await page.keyboard.press("ControlOrMeta+p");
    await page.locator(".palette-input").first().fill("Open graph view");
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Filter notes")).toBeVisible();
    expect(await faintPlaceholders(page)).toEqual([]);
    // Six view tabs fit a right dock of the default width on one row.
    const right = page.locator(".pane.dock-right .tab-bar").first();
    expect((await right.boundingBox())!.height).toBeLessThanOrEqual(36);
    // More than fit (plugin views) go onto another row rather than out of sight.
    expect(await right.evaluate((el) => getComputedStyle(el).flexWrap)).toBe("wrap");
    // Each view tab's icon stands out from the bar, and its name isn't faded.
    for (const tab of await right.locator(".tab.view-tab").all()) {
      const { ratio, opacity } = await tab.evaluate((el) => {
        const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        let bg = [255, 255, 255];
        for (let e: Element | null = el; e; e = e.parentElement) {
          const c = rgb(getComputedStyle(e).backgroundColor);
          if (c.length >= 3 && (c.length < 4 || c[3] > 0.5)) {
            bg = c.slice(0, 3);
            break;
          }
        }
        const fg = rgb(getComputedStyle(el.querySelector(".tab-icon")!).color).slice(0, 3);
        const [x, y] = [lum(fg), lum(bg)].sort((p, q) => q - p);
        return { ratio: (x + 0.05) / (y + 0.05), opacity: getComputedStyle(el.querySelector(".tab-name")!).opacity };
      });
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      expect(opacity).toBe("1");
    }
  });
}
