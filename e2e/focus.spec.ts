import { test, expect, type Page } from "@playwright/test";

async function fresh(page: Page) {
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace") || k.includes("reading")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
}
const onPage = (page: Page) => page.evaluate(() => document.activeElement === document.body);
const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return a?.getAttribute("role") === "tab" ? `tab:${a.querySelector(".tab-name")?.textContent?.trim()}` : (a?.className.split(" ")[0] ?? "");
  });

test("Reading view takes Tab, shows where focus is and is named for its note", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+e");
  const view = page.locator(".pane:not(.dock) .reading-view").first();
  await expect(view).toHaveAttribute("aria-label", "Reading view: Welcome");
  await page.locator(".pane:not(.dock) [role='tab']", { hasText: "Welcome" }).focus();
  for (let i = 0; i < 6 && !(await view.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(view).toBeFocused();
  expect(await view.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
});

test("Cmd-E with focus on a note's tab leaves it there", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  const tab = page.locator(".pane:not(.dock) [role='tab']", { hasText: "Welcome" });
  await tab.focus();
  await page.keyboard.press("ControlOrMeta+e");
  await expect(page.locator(".pane:not(.dock) .reading-view").first()).toBeVisible();
  await page.waitForTimeout(100);
  await expect(tab).toBeFocused();
  await page.keyboard.press("ControlOrMeta+e");
  await expect(page.locator(".pane:not(.dock) .cm-content").first()).toBeVisible();
  await page.waitForTimeout(100);
  await expect(tab).toBeFocused();
});

test("closing a note in Reading view, by Cmd-W, Delete or the quick switcher, never drops focus on the page", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+e");
  await expect(page.locator(".pane:not(.dock) .reading-view").first()).toBeFocused();
  await page.keyboard.press("ControlOrMeta+w");
  await expect.poll(() => focused(page)).toBe("reading-view");
  // The quick switcher, in Reading view.
  await page.keyboard.press("ControlOrMeta+o");
  await page.keyboard.type("Ideas");
  await page.keyboard.press("Enter");
  await expect(page.locator(".pane:not(.dock) [role='tab']", { hasText: "Ideas" })).toBeVisible();
  await expect.poll(() => onPage(page)).toBe(false);
  // The last note's tab: focus goes to the empty pane's message.
  for (const name of ["Ideas", "Welcome"]) {
    const tab = page.locator(".pane:not(.dock) [role='tab']", { hasText: name });
    if ((await tab.count()) === 0) continue;
    await tab.focus();
    await page.keyboard.press("Delete");
  }
  await expect.poll(() => focused(page)).toBe("placeholder");
});

test("the tab menu's Close and Delete both keep focus on the tabs, and a middle click on a panel's last tab doesn't drop it", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  const tabs = page.locator(".pane:not(.dock) [role='tab']");
  await tabs.filter({ hasText: "Welcome" }).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menu", { name: "Tab actions" }).getByRole("menuitem", { name: "Close", exact: true }).press("Enter");
  await expect(tabs.filter({ hasText: "Welcome" })).toHaveCount(0);
  await page.waitForTimeout(100);
  await expect.poll(() => focused(page)).toBe("tab:Ideas");
  // Every tab of the right panel closed with a middle click from a focused tab.
  const bar = page.locator(".pane.dock-right [role='tablist']").first();
  while ((await bar.getByRole("tab").count()) > 0) {
    const tab = bar.getByRole("tab").first();
    await tab.focus();
    await tab.click({ button: "middle" });
    await page.waitForTimeout(100);
    expect(await onPage(page)).toBe(false);
  }
  // With the panel gone, focus is in the note, not on a tab.
  await expect.poll(() => focused(page)).toBe("cm-content");
});

test("a tab's close button has a tooltip, and an icon tab shows its name while it has keyboard focus", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await expect(page.locator(".pane:not(.dock) .tab-close").first()).toHaveAttribute("title", "Close Welcome");
  const icon = page.locator(".pane.dock-right [role='tab']").first();
  const nameWidth = () => icon.locator(".tab-name").evaluate((el) => el.getBoundingClientRect().width);
  expect(await nameWidth()).toBeLessThanOrEqual(1);
  await page.locator(".pane:not(.dock) [role='tab']").first().focus();
  await page.keyboard.press("Tab"); // keyboard focus, so :focus-visible applies
  await icon.focus();
  expect(await nameWidth()).toBeGreaterThan(10);
  expect(await icon.evaluate((el) => getComputedStyle(el).outlineOffset)).toBe("-4px");
});

const notePanes = (page: Page) => page.locator(".pane:not(.dock)");
const menu = async (page: Page, tab: import("@playwright/test").Locator, item: string) => {
  await tab.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menu", { name: "Tab actions" }).getByRole("menuitem", { name: item, exact: true }).press("Enter");
};
const focusedPaneIsDock = (page: Page) => page.evaluate(() => document.querySelector(".pane.focused")?.classList.contains("dock") ?? null);
// Records each pane that becomes the focused one, from now on: "dock" or "note".
async function watchPaneFocus(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __paneFocus: string[] };
    w.__paneFocus = [];
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        if (el.classList.contains("pane") && el.classList.contains("focused") && !(r.oldValue ?? "").split(" ").includes("focused"))
          w.__paneFocus.push(el.classList.contains("dock") ? "dock" : "note");
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
  });
  return () => page.evaluate(() => (window as unknown as { __paneFocus: string[] }).__paneFocus);
}

test("closing a split next to a canvas leaves focus on the canvas's tab, and Cmd-W then closes it, not a panel", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.attachment", { hasText: "Board" }).click();
  await expect(page.locator(".canvas-node")).toHaveCount(3);
  await menu(page, notePanes(page).first().getByRole("tab", { name: /Board/ }), "Split right");
  await expect(notePanes(page)).toHaveCount(2);
  const paneFocus = await watchPaneFocus(page);
  await menu(page, notePanes(page).nth(1).getByRole("tab").first(), "Close");
  await expect(notePanes(page)).toHaveCount(1);
  await expect.poll(() => focused(page)).toBe("tab:Board.canvas");
  expect(await focusedPaneIsDock(page)).toBe(false);
  expect(await paneFocus()).not.toContain("dock");
  await page.keyboard.press("ControlOrMeta+w");
  await expect(page.locator(".canvas-node")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Files" })).toHaveCount(1);
});

test("closing a note over a canvas leaves focus on the canvas's tab", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.attachment", { hasText: "Board" }).click();
  await page.locator(".tree-row.file", { hasText: "Deck" }).click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+w");
  await expect(page.locator(".canvas-node")).toHaveCount(3);
  await expect.poll(() => focused(page)).toBe("tab:Board.canvas");
});

test("in a split, Cmd-W and the quick switcher keep focus in the pane they ran in", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await menu(page, notePanes(page).first().getByRole("tab", { name: /Ideas/ }), "Split right");
  await expect(notePanes(page)).toHaveCount(2);
  const right = notePanes(page).nth(1);
  await right.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+o");
  await page.keyboard.type("Deck");
  await page.keyboard.press("Enter");
  await expect(right.locator("[role='tab'][aria-selected='true']")).toContainText("Deck");
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".pane:not(.dock)") && document.activeElement?.closest(".pane") === document.querySelectorAll(".pane:not(.dock)")[1])).toBe(true);
  await page.keyboard.press("ControlOrMeta+e");
  await expect(right.locator(".reading-view")).toBeVisible();
  await right.locator(".reading-view").focus();
  await page.keyboard.press("ControlOrMeta+w");
  await expect(right.locator("[role='tab'][aria-selected='true']")).toContainText("Ideas");
  await expect(right.locator(".reading-view")).toBeFocused();
});

test("the quick switcher in Reading view puts focus in the note, from a tab or a side panel", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+e");
  for (const [from, to] of [
    [page.locator(".pane:not(.dock) [role='tab']", { hasText: "Welcome" }), "Ideas"],
    [page.locator(".pane.dock-right [role='tab']").first(), "Deck"],
  ] as const) {
    await from.focus();
    await page.keyboard.press("ControlOrMeta+o");
    await page.keyboard.type(to);
    await page.keyboard.press("Enter");
    const view = page.locator(".pane:not(.dock) .reading-view").first();
    await expect(view).toHaveAttribute("aria-label", `Reading view: ${to}`);
    await expect(view).toBeFocused();
  }
});

test("focus rings on tabs and Reading view are in the text's colour, and the ring clears the active tab's underline", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+e");
  const tab = page.locator(".pane:not(.dock) [role='tab']", { hasText: "Welcome" });
  await tab.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const ring = (el: Element) => {
    const c = getComputedStyle(el);
    return { style: c.outlineStyle, ring: c.outlineColor, text: c.color, offset: c.outlineOffset };
  };
  const t = await tab.evaluate(ring);
  expect(t.style).toBe("solid");
  expect(t.ring).toBe(t.text);
  expect(t.offset).toBe("-4px");
  const view = page.locator(".pane:not(.dock) .reading-view").first();
  for (let i = 0; i < 6 && !(await view.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  const r = await view.evaluate(ring);
  expect(r.style).toBe("solid");
  expect(r.ring).toBe(r.text);
});

test("an icon tab's name shows under the bar on keyboard focus without moving anything", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  const dock = page.locator(".pane.dock-right");
  const bar = dock.locator("[role='tablist']").first();
  const box = () => bar.evaluate((el) => { const r = el.getBoundingClientRect(); const b = el.closest(".pane")!.querySelector(".pane-body")!.getBoundingClientRect(); return { h: r.height, body: b.top }; });
  const before = await box();
  await page.locator(".pane:not(.dock) [role='tab']").first().focus();
  await page.keyboard.press("Tab");
  for (const tab of await dock.getByRole("tab").all()) {
    await tab.focus();
    const name = tab.locator(".tab-name");
    const n = await name.evaluate((el) => { const r = el.getBoundingClientRect(); const p = el.closest(".pane")!.getBoundingClientRect(); return { w: r.width, inside: r.left >= p.left && r.right <= p.right && r.bottom <= p.bottom }; });
    expect(n.w).toBeGreaterThan(10);
    expect(n.inside).toBe(true);
    expect(await box()).toEqual(before);
  }
});

test("slides keep focus on the slide as it moves", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Deck" }).click();
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("presentation");
  await page.keyboard.press("Enter");
  const slide = page.locator(".slides-content .reading-view");
  await slide.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".slides-count")).toHaveText("2 / 3");
  await expect(slide).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".slides-count")).toHaveText("1 / 3");
  await expect(slide).toBeFocused();
});

test("the same note in two panes has two Reading views with different names", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+e");
  await expect(page.getByRole("region", { name: "Reading view: Ideas" })).toHaveCount(1);
  await menu(page, notePanes(page).first().getByRole("tab", { name: /Ideas/ }), "Split right");
  await expect(page.getByRole("region", { name: "Reading view: Ideas, pane 1" })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Reading view: Ideas, pane 2" })).toHaveCount(1);
});

test("a middle click on a tab in the other split leaves the focused pane as it was", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await menu(page, notePanes(page).first().getByRole("tab", { name: /Ideas/ }), "Split right");
  await notePanes(page).nth(1).locator(".cm-content").click();
  await notePanes(page).first().getByRole("tab", { name: /Welcome/ }).click({ button: "middle" });
  await expect(notePanes(page).first().getByRole("tab", { name: /Welcome/ })).toHaveCount(0);
  await expect(notePanes(page).nth(1)).toHaveClass(/focused/);
  await expect(notePanes(page).first()).not.toHaveClass(/focused/);
});

test("a note opened from the file tree goes to the note pane focused last", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await menu(page, notePanes(page).first().getByRole("tab", { name: /Ideas/ }), "Split right");
  await notePanes(page).nth(1).locator(".cm-content").click();
  await page.locator(".tree-row.file", { hasText: "Deck" }).click();
  await expect(notePanes(page).nth(1).locator("[role='tab'][aria-selected='true']")).toContainText("Deck");
  await expect(notePanes(page).first().getByRole("tab", { name: /Deck/ })).toHaveCount(0);
});

test("deleting a note from the file tree's keyboard menu keeps focus in the tree", async ({ page }) => {
  await fresh(page);
  const row = page.locator(".tree-row.file", { hasText: "Deck" });
  await row.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menu").getByRole("menuitem", { name: "Delete", exact: true }).press("Enter");
  await expect(page.locator(".tree-row.file", { hasText: "Deck" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".sidebar .tree-row"))).toBe(true);
});

test("a long link in a callout wraps instead of scrolling Reading view sideways", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __mockExtraFiles: Record<string, string> }).__mockExtraFiles = {
      "Long.md": "> [!note] Links\n> https://example.com/a/very/long/path/that/does/not/break/anywhere/at/all/" + "a".repeat(200) + "\n",
    };
  });
  await fresh(page);
  await page.setViewportSize({ width: 800, height: 700 });
  await page.locator(".tree-row.file", { hasText: "Long" }).click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+e");
  const view = page.locator(".pane:not(.dock) .reading-view").first();
  await expect(view.locator(".md-callout")).toHaveCount(1);
  const { sw, cw } = await view.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
});

test("a split whose notes are deleted elsewhere hands focus to a note pane, not a side panel", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await menu(page, notePanes(page).first().getByRole("tab", { name: /Ideas/ }), "Split right");
  const right = notePanes(page).nth(1);
  await right.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+o");
  await page.keyboard.type("Deck");
  await page.keyboard.press("Enter");
  await right.getByRole("tab", { name: /Ideas/ }).click({ button: "middle" });
  await expect(right.getByRole("tab")).toHaveCount(1);
  await right.locator(".cm-content").click();
  const paneFocus = await watchPaneFocus(page);
  await page.evaluate(() => {
    const w = window as unknown as {
      __mockHook: (cmd: string, a: { path?: string }) => Promise<void> | void;
      __mockEmit: (n: string, p: unknown) => void;
    };
    w.__mockHook = (cmd, a) => (cmd === "read_note" && a.path?.endsWith("Deck.md") ? Promise.reject("gone") : undefined);
    w.__mockEmit("vault-changed", [{ path: "/mock/vault/Deck.md", rel: "Deck.md", mtime: 1, ctime: 1, size: 0 }]);
  });
  await expect(notePanes(page)).toHaveCount(1);
  await page.waitForTimeout(200);
  expect(await paneFocus()).not.toContain("dock");
  expect(await focusedPaneIsDock(page)).toBe(false);
});

test("refocusing passes over a match that can't take focus", async ({ page }) => {
  await fresh(page);
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  // Something the selectors match that isn't focusable, ahead of the editor.
  await page.evaluate(() => {
    const decoy = document.createElement("div");
    decoy.className = "cm-content";
    document.querySelector(".pane:not(.dock) .tab-bar")!.prepend(decoy);
  });
  await page.locator(".pane:not(.dock) .cm-content").last().click();
  await page.keyboard.press("ControlOrMeta+e");
  await expect(page.locator(".pane:not(.dock) .reading-view")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+w");
  await expect(page.locator(".pane:not(.dock) .reading-view")).toHaveAttribute("aria-label", "Reading view: Welcome");
  await expect(page.locator(".pane:not(.dock) .tab-bar > .cm-content")).toHaveCount(1);
  await expect.poll(() => focused(page)).toBe("reading-view");
});
