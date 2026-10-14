import { test, expect, type Page } from "@playwright/test";

// A slow vault switch on the mock: opening "Other" takes `ms`.
async function slowSwitch(page: Page, ms = 4000) {
  await page.evaluate((delay) => {
    const w = window as unknown as { __mockHook: (cmd: string) => Promise<void> | void };
    w.__mockHook = (cmd) => (cmd === "open_vault" ? new Promise((r) => setTimeout(r, delay)) : undefined);
  }, ms);
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Switch vault");
  await expect(page.locator(".palette-item").first()).toContainText("Switch vault");
  await page.keyboard.press("Enter");
  await page.locator(".vault-item", { hasText: "/mock/other" }).first().click();
  await expect(page.locator("main.main")).toHaveAttribute("inert", "");
}

async function load(page: Page, hotkeys: Record<string, string> = {}) {
  await page.addInitScript((h) => {
    localStorage.setItem("basalt.recentVaults", JSON.stringify([{ path: "/mock/other", name: "other", ts: Date.now() }]));
    localStorage.setItem("basalt-hotkeys", JSON.stringify(h));
  }, hotkeys);
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
}

const opened = (page: Page) => expect(page.locator("main.main")).not.toHaveAttribute("inert", { timeout: 10000 });

test("a vault switch says what's opening, holds focus on that, and gives it back to the note", async ({ page }) => {
  await load(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await slowSwitch(page);
  const status = page.locator(".switch-status");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveText("Opening other…");
  await expect(status).toBeFocused();
  await opened(page);
  await expect(status).toHaveText("");
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".pane:not(.dock)"))).toBe(true);
});

test("a plugin's ribbon icon and status bar items wait during a switch", async ({ page }) => {
  await load(page);
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Open settings");
  await page.keyboard.press("Enter");
  await page.locator(".plugin-row", { hasText: "Demo Plugin" }).locator('input[type="checkbox"]').check();
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings")).toHaveCount(0);
  await expect(page.locator(".ribbon-plugin-btn")).toHaveCount(1);
  await slowSwitch(page);
  await expect(page.locator(".ribbon-plugin-btn")).toHaveAttribute("aria-disabled", "true");
  await page.locator(".ribbon-plugin-btn").click({ force: true });
  expect(await page.evaluate(() => (window as unknown as { __demoRibbon: number }).__demoRibbon)).toBe(0);
  await expect(page.locator(".status-bar-plugins")).toHaveAttribute("inert", "");
  await opened(page);
  await expect(page.locator(".ribbon-plugin-btn")).not.toHaveAttribute("aria-disabled");
  await expect(page.locator(".status-bar-plugins")).not.toHaveAttribute("inert");
});

// Each key pressed (not modifiers) and whether its default was prevented, once
// it was handled. Seen first, before anything can stop it.
async function watchKeys(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __keys: KeyboardEvent[] };
    w.__keys = [];
    window.addEventListener("keydown", (e) => w.__keys.push(e), true);
  });
  return () =>
    page.evaluate(() =>
      (window as unknown as { __keys: KeyboardEvent[] }).__keys
        .filter((e) => !["Meta", "Control", "Alt", "Shift"].includes(e.key))
        .map((e) => `${e.key}:${e.defaultPrevented}`),
    );
}

test("during a switch, shortcuts are held but for the palette, and typing in it works", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await load(page, { "new-note": "alt+n" });
  const notes = () => page.locator(".tree-row.file").count();
  const before = await notes();
  const keys = await watchKeys(page);
  await slowSwitch(page, 8000);
  const start = (await keys()).length;
  const since = async () => (await keys()).slice(start);
  // Outside the palette: an app shortcut and an Option hotkey are held.
  await page.keyboard.press("ControlOrMeta+o");
  await page.keyboard.press("Alt+n");
  expect(await since()).toEqual(["o:true", "n:true"]);
  await expect(page.locator(".palette-input")).toHaveCount(0);
  // The palette opens, and its field takes select-all, copy, paste and Option.
  await page.keyboard.press("ControlOrMeta+p");
  const input = page.locator(".palette-input").first();
  await expect(input).toBeFocused();
  await page.keyboard.type("vault");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(input).toHaveValue("vaultvault");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Switch");
  await expect(input).toHaveValue("Switch");
  await page.evaluate(() => {
    const el = document.querySelector(".palette-input")!;
    const opts = { bubbles: true, cancelable: true };
    // An Option character (Mac) and an AltGr one (Windows: Ctrl and Alt).
    el.dispatchEvent(new KeyboardEvent("keydown", { ...opts, key: "√", code: "KeyV", altKey: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { ...opts, key: "@", code: "KeyQ", altKey: true, ctrlKey: true, modifierAltGraph: true } as KeyboardEventInit));
  });
  await page.keyboard.press("Alt+n");
  await page.keyboard.press("ControlOrMeta+o");
  const typed = (await since()).slice(2);
  expect(typed.filter((k) => /^(√|@|n|o):/.test(k))).toEqual(["√:false", "@:false", "n:false", "o:true"]);
  await expect(page.locator(".palette-item")).toHaveText([/Switch vault/]);
  await page.keyboard.press("Escape");
  await opened(page);
  expect(await notes()).toBe(before);
});

test("a switch the unsaved-changes question cancels lets go at once", async ({ page }) => {
  await load(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
  await page.evaluate(() => {
    const w = window as unknown as { __mockHook: (cmd: string) => Promise<{ result: unknown } | void> | void };
    w.__mockHook = (cmd) => (cmd === "write_note" ? Promise.reject("disk full") : undefined);
  });
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.type("unsaved");
  await page.evaluate(() => {
    const w = window as unknown as { __asked: number; __mockConfirm: () => boolean };
    w.__asked = 0;
    w.__mockConfirm = () => (w.__asked++, false);
  });
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Switch vault");
  await expect(page.locator(".palette-item").first()).toContainText("Switch vault");
  await page.keyboard.press("Enter");
  await page.locator(".vault-item", { hasText: "/mock/other" }).first().click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(1);
  await opened(page);
  await expect(page.locator(".switch-status")).toHaveText("");
  await expect(page.locator(".pane:not(.dock) .cm-content").first()).toContainText("unsaved");
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("daily");
  await expect(page.locator(".palette-item")).toHaveText([/daily/i]);
});

test("a switch closes the graph, menus and prompts of the vault that's going", async ({ page }) => {
  await load(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
  const pick = async () => {
    await page.keyboard.press("ControlOrMeta+p");
    await page.locator(".palette-input").first().fill("Switch vault");
    await expect(page.locator(".palette-item").first()).toContainText("Switch vault");
    await page.keyboard.press("Enter");
    await page.locator(".vault-item", { hasText: "/mock/other" }).first().click();
    await expect(page.locator(".switch-status")).toHaveText("");
  };
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Open graph view");
  await page.keyboard.press("Enter");
  await expect(page.locator(".graph-overlay")).toHaveCount(1);
  await pick();
  await expect(page.locator(".graph-overlay")).toHaveCount(0);
  await page.locator(".pane:not(.dock) .tab", { hasText: "Ideas" }).first().click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Tab actions" })).toBeVisible();
  await pick();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await expect(page.locator(".prompt-input")).toBeVisible();
  await pick();
  await expect(page.locator(".prompt-input")).toHaveCount(0);
});

test("a recording can't be stopped into a note while a vault opens", async ({ page }) => {
  await page.addInitScript(() => {
    // @ts-expect-error test shim
    navigator.mediaDevices = navigator.mediaDevices || {};
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] }) as unknown as MediaStream;
    class FakeRec {
      mimeType = "audio/webm";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        setTimeout(() => this.ondataavailable?.({ data: new Blob(["x"], { type: "audio/webm" }) }), 10);
      }
      stop() {
        this.onstop?.();
      }
    }
    // @ts-expect-error test shim
    window.MediaRecorder = FakeRec;
  });
  await load(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Record audio");
  await page.keyboard.press("Enter");
  await expect(page.locator(".rec-indicator")).toBeVisible();
  await slowSwitch(page);
  for (const b of [".rec-stop", ".rec-discard"]) {
    await expect(page.locator(b)).toHaveAttribute("aria-disabled", "true");
    await page.locator(b).click({ force: true });
  }
  await expect(page.locator(".rec-indicator")).toBeVisible();
  await opened(page);
  await expect(page.locator(".rec-stop")).not.toHaveAttribute("aria-disabled");
});
