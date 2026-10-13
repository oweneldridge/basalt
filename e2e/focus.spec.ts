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
  expect(await icon.evaluate((el) => getComputedStyle(el).outlineOffset)).toBe("-2px");
});
