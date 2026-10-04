import { test, expect } from "@playwright/test";

test("typing while Settings is open never reaches the note, and Escape returns focus", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  const editor = page.locator(".pane:not(.dock) .cm-content").first();
  await editor.click();
  const before = await editor.innerText();
  await page.keyboard.press("ControlOrMeta+Comma");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await page.keyboard.type("ZZZ");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).not.toHaveClass(/cm-content/);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await editor.innerText()).toBe(before);
  await expect(editor).toBeFocused();
});

test("the command palette is a labelled dialog that closes on Escape", async ({ page }) => {
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+p");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-label", /.+/);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("the editor and glyph-only buttons have accessible names", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await expect(page.getByRole("textbox", { name: "Editing Welcome" })).toBeVisible();
  for (const name of ["Split right", "New note", "Collapse all", "Open a note (⌘O)"]) {
    await expect(page.getByRole("button", { name }).first()).toBeVisible();
  }
});

test("the root font size is the user's own until they zoom, and zoom persists", async ({ page }) => {
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe("");
  await page.keyboard.press("ControlOrMeta+Equal");
  await expect.poll(() => page.evaluate(() => document.documentElement.style.fontSize)).toBe("110%");
  await page.reload();
  await expect(page.locator(".sidebar")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe("110%");
  await page.keyboard.press("ControlOrMeta+Digit0");
  await expect.poll(() => page.evaluate(() => document.documentElement.style.fontSize)).toBe("");
});

test("tabs work from the keyboard: arrows move, Enter opens, Delete closes", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  const tabs = page.locator(".pane:not(.dock) [role='tab']");
  await expect(tabs).toHaveCount(2);
  await tabs.filter({ hasText: "Ideas" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.filter({ hasText: "Welcome" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tabs.filter({ hasText: "Welcome" })).toHaveAttribute("aria-selected", "true");
  await tabs.filter({ hasText: "Welcome" }).focus();
  await page.keyboard.press("Delete");
  await expect(tabs).toHaveCount(1);
  await expect(page.getByRole("tablist", { name: "Open notes" })).toBeVisible();
});

test("the palette is a combobox whose active option is announced", async ({ page }) => {
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+p");
  const box = page.getByRole("dialog").getByRole("combobox");
  await expect(box).toBeFocused();
  const first = await box.getAttribute("aria-activedescendant");
  expect(first).toBeTruthy();
  await expect(page.locator(`[id="${first}"]`)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  const second = await box.getAttribute("aria-activedescendant");
  expect(second).not.toBe(first);
  await expect(page.locator(`[id="${second}"]`)).toHaveAttribute("role", "option");
});

test("links can be followed from the keyboard in the editor and in Reading view", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace") || k.includes("reading") || k.includes("source")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  const activeTab = page.locator(".pane:not(.dock) .tab.active .tab-name").first();
  // Editor: Source mode shows the raw link; put the caret inside it.
  await page.locator('button[title^="Toggle Source"], button:has-text("Source")').first().click();
  await page.locator(".pane:not(.dock) .cm-line", { hasText: "[[Ideas]]" }).first().click();
  await page.keyboard.press("Home");
  for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowRight"); // "See [[Id|eas]]"
  await page.keyboard.press("Alt+Enter");
  await expect(activeTab).toHaveText("Ideas");
  // Reading view: Tab-reachable links that open on Enter.
  await page.locator('button:has-text("Source")').first().click();
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await page.locator('button[title^="Toggle Reading view"]').click();
  const link = page.locator(".reading-view a.md-wikilink", { hasText: "Ideas" }).first();
  await expect(link).toHaveAttribute("role", "link");
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(activeTab).toHaveText("Ideas");
});

test("context menus open and work from the keyboard", async ({ page }) => {
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
  const row = page.locator(".tree-row.file", { hasText: "Ideas" }).first();
  await row.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "File actions" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(row).toBeFocused();
});

test("pane resizers are separators that move with the arrow keys", async ({ page }) => {
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
  const dock = page.locator(".pane.dock-left");
  const before = (await dock.boundingBox())!.width;
  const sep = page.getByRole("separator", { name: "Resize panes" }).first();
  await sep.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  expect((await dock.boundingBox())!.width).toBeGreaterThan(before + 20);
});

test("the window title names the open note", async ({ page }) => {
  await page.goto("/app-harness.html");
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await expect(page).toHaveTitle("Ideas · Basalt");
});

test("landmarks are named: the editor area and both side panels", async ({ page }) => {
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("complementary", { name: "Files" })).toBeVisible();
  // Every side region has its own name, so they're told apart in a landmarks list.
  const names = await page.getByRole("complementary").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((n) => !!n)).toBe(true);
});

test("the graph is a named dialog with labelled controls; Escape returns focus", async ({ page }) => {
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
  const opener = page.locator(".ribbon").getByRole("button", { name: "Graph view" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Graph view" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("searchbox", { name: "Filter notes" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Global" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("img", { name: /^Graph of \d+ notes and \d+ links$/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("with reduced motion the graph is drawn once it settles, not animated", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.locator(".ribbon").getByRole("button", { name: "Graph view" }).click();
  const snap = () => page.locator(".graph-canvas-wrap canvas").evaluate((c: HTMLCanvasElement) => c.toDataURL());
  const blank = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".graph-canvas-wrap canvas")!;
    const e = document.createElement("canvas");
    e.width = c.width;
    e.height = c.height;
    return e.toDataURL();
  });
  await expect.poll(snap, { timeout: 10000 }).not.toBe(blank);
  const a = await snap();
  await page.waitForTimeout(500);
  expect(await snap()).toBe(a);
});

test("buttons, tabs and checkboxes are at least 24 by 24 pixels", async ({ page }) => {
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await expect(page.locator(".tab.active .tab-close").first()).toBeVisible();
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, [role=button], [role=tab], input[type=checkbox]")]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24))
      .map(({ el, r }) => `${Math.round(r.width)}x${Math.round(r.height)} ${el.getAttribute("aria-label") ?? el.textContent}`),
  );
  expect(small).toEqual([]);
});
