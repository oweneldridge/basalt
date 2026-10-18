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

// Opening "other" takes `open` and answers as its own, empty vault, whose
// note list takes `list`. Every call is logged.
async function otherOpens(page: Page, open: number, list: number) {
  await page.evaluate(
    ([o, l]) => {
      const w = window as unknown as { __log: string[]; __other: boolean; __mockHook: (cmd: string, a: Record<string, unknown>) => unknown };
      const after = (ms: number, v?: unknown) => new Promise((r) => setTimeout(() => r(v), ms));
      w.__log = [];
      w.__mockHook = (cmd, a) => {
        w.__log.push(`${cmd}:${String(a.path ?? a.name ?? "")}`);
        if (cmd === "open_vault") {
          w.__other = String(a.path) === "/mock/other";
          return after(o, w.__other ? { result: "/mock/other" } : undefined);
        }
        if (cmd === "read_vault" && w.__other) return after(l, { result: [] });
        if ((cmd === "list_attachments" || cmd === "list_folders") && w.__other) return { result: [] };
      };
    },
    [open, list] as const,
  );
}
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __log: string[] }).__log);

async function pickVault(page: Page, root: string) {
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Switch vault");
  await page.locator(".palette-item", { hasText: "Switch vault" }).first().click();
  await page.locator(".vault-item", { hasText: root }).first().click();
}

test("a switch stops the old vault's plugins at once; the new one's wait until it's open", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("basalt.plugins.enabled./mock/other", JSON.stringify(["demo"])));
  await load(page);
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Open settings");
  await page.keyboard.press("Enter");
  await page.locator(".plugin-row", { hasText: "Demo Plugin" }).locator('input[type="checkbox"]').check();
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings")).toHaveCount(0);
  await expect(page.locator(".ribbon-plugin-btn")).toHaveCount(1);
  await otherOpens(page, 1500, 3000);
  await pickVault(page, "/mock/other");
  await expect(page.locator("main.main")).toHaveAttribute("inert", "");
  await expect(page.locator(".ribbon-plugin-btn")).toHaveCount(0);
  // The new vault's copy loads while its notes are still coming, and waits.
  await expect(page.locator(".ribbon-plugin-btn")).toHaveCount(1, { timeout: 4000 });
  await expect(page.locator("main.main")).toHaveAttribute("inert", "");
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

test("a recording under way when a switch starts is saved into the vault it was made in", async ({ page }) => {
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
  await page.evaluate(() => {
    const w = window as unknown as { __log: string[]; __mockHook: (cmd: string, a: Record<string, unknown>) => unknown };
    w.__log = [];
    w.__mockHook = (cmd, a) => {
      w.__log.push(`${cmd}:${String(a.path ?? a.name ?? "")}:${/!\[\[Recording /.test(String(a.content ?? ""))}`);
      if (cmd === "open_vault") return new Promise((r) => setTimeout(r, 3000));
    };
  });
  await pickVault(page, "/mock/other");
  await expect(page.locator("main.main")).toHaveAttribute("inert", "");
  await expect(page.locator(".rec-indicator")).toHaveCount(0);
  await expect.poll(() => calls(page)).toContainEqual(expect.stringMatching(/^open_vault:/));
  const log = await calls(page);
  const open = log.findIndex((l) => l.startsWith("open_vault:"));
  // Its file, then the note with its embed, both before the vault goes.
  expect(log.slice(0, open).some((l) => /^write_attachment:Recording /.test(l))).toBe(true);
  expect(log.slice(0, open)).toContainEqual("write_note:/mock/vault/Ideas.md:true");
  await opened(page);
});

async function fakeRecorder(page: Page) {
  await page.addInitScript(() => {
    // @ts-expect-error test shim
    navigator.mediaDevices = navigator.mediaDevices || {};
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] }) as unknown as MediaStream;
    const g = globalThis as unknown as { __rec: string[] };
    g.__rec = [];
    class FakeRec {
      mimeType = "audio/webm";
      state = "inactive";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
        setTimeout(() => this.ondataavailable?.({ data: new Blob(["x"], { type: "audio/webm" }) }), 10);
      }
      pause() {
        this.state = "paused";
        g.__rec.push("pause");
      }
      resume() {
        this.state = "recording";
        g.__rec.push("resume");
      }
      stop() {
        this.state = "inactive";
        g.__rec.push("stop");
        this.onstop?.();
      }
    }
    // @ts-expect-error test shim
    window.MediaRecorder = FakeRec;
  });
}

test("a recording under way when a switch is turned down goes on, and is saved when stopped", async ({ page }) => {
  await fakeRecorder(page);
  await load(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
  await page.evaluate(() => {
    const w = window as unknown as { __log: string[]; __mockConfirm: () => boolean; __mockHook: (cmd: string, a: Record<string, unknown>) => unknown };
    w.__log = [];
    w.__mockConfirm = () => false;
    w.__mockHook = (cmd, a) => {
      w.__log.push(`${cmd}:${String(a.path ?? a.name ?? "")}`);
      if (cmd === "write_note") return Promise.reject("disk full");
    };
  });
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.type("unsaved");
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Record audio");
  await page.keyboard.press("Enter");
  await expect(page.locator(".rec-indicator")).toBeVisible();
  await pickVault(page, "/mock/other");
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __rec: string[] }).__rec)).toEqual(["pause", "resume"]);
  await opened(page);
  await expect(page.locator(".rec-indicator")).toBeVisible();
  expect((await calls(page)).filter((l) => /^(write_attachment|open_vault):/.test(l))).toEqual([]);
  await page.locator(".rec-stop").click();
  await expect(page.locator(".rec-indicator")).toHaveCount(0);
  await expect.poll(() => calls(page)).toContainEqual(expect.stringMatching(/^write_attachment:Recording /));
});

test("a recording at a switch that goes on past unsaved changes is saved first, and asks once", async ({ page }) => {
  await fakeRecorder(page);
  await load(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
  await page.evaluate(() => {
    const w = window as unknown as { __log: string[]; __mockConfirm: () => boolean; __mockHook: (cmd: string, a: Record<string, unknown>) => unknown };
    w.__log = [];
    w.__mockConfirm = () => (w.__log.push("asked"), true);
    w.__mockHook = (cmd, a) => {
      w.__log.push(`${cmd}:${String(a.path ?? a.name ?? "")}`);
      if (cmd === "write_note") return Promise.reject("disk full");
    };
  });
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.type("unsaved");
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Record audio");
  await page.keyboard.press("Enter");
  await expect(page.locator(".rec-indicator")).toBeVisible();
  await pickVault(page, "/mock/other");
  await opened(page);
  const log = await calls(page);
  const after = log.slice(log.indexOf("asked"), log.findIndex((l) => l.startsWith("open_vault:")));
  // Its file, and no second try at the note the question let go.
  expect(after.filter((l) => !l.startsWith("read_") && !l.startsWith("list_"))).toEqual(["asked", expect.stringMatching(/^write_attachment:Recording /)]);
  expect(log.filter((l) => l === "asked")).toHaveLength(1);
});

test("a slide show closes at a switch", async ({ page }) => {
  await load(page);
  await page.locator(".tree-row.file", { hasText: "Deck" }).first().click();
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Start presentation");
  await page.keyboard.press("Enter");
  await expect(page.locator(".slides-overlay")).toHaveCount(1);
  await slowSwitch(page);
  await expect(page.locator(".slides-overlay")).toHaveCount(0);
});

for (const [name, open] of [
  ["editor menu", async (p: Page) => {
    await p.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
    await p.locator(".pane:not(.dock) .cm-content").first().click({ button: "right" });
  }],
  ["file menu", (p: Page) => p.locator(".tree-row.file", { hasText: "Ideas" }).first().click({ button: "right" })],
  ["attachment menu", (p: Page) => p.locator(".tree-row.attachment", { hasText: "Board" }).first().click({ button: "right" })],
  ["folder menu", (p: Page) => p.locator(".tree-row.folder", { hasText: "Projects" }).first().click({ button: "right" })],
] as const) {
  test(`the ${name} closes at a switch`, async ({ page }) => {
    await load(page);
    await open(page);
    await expect(page.locator(".ctx-menu")).toHaveCount(1);
    await slowSwitch(page);
    await expect(page.locator(".ctx-menu")).toHaveCount(0);
  });
}

for (const [name, open] of [
  ["new folder", async (p: Page) => {
    await p.keyboard.press("ControlOrMeta+p");
    await p.locator(".palette-input").first().fill("New folder…");
    await p.keyboard.press("Enter");
  }],
  ["folder rename", async (p: Page) => {
    await p.locator(".tree-row.folder", { hasText: "Projects" }).first().click({ button: "right" });
    await p.locator(".ctx-item", { hasText: /Rename/ }).first().click();
  }],
  ["template", async (p: Page) => {
    await p.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
    await p.locator(".pane:not(.dock) .cm-content").first().click();
    await p.keyboard.press("ControlOrMeta+p");
    await p.locator(".palette-input").first().fill("Insert template");
    await p.keyboard.press("Enter");
    await p.locator(".palette-item", { hasText: "Ask" }).first().click();
  }],
] as const) {
  test(`a ${name} prompt closes at a switch`, async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __mockExtraFiles: Record<string, string> }).__mockExtraFiles = { "Templates/Ask.md": 'Hi <% tp.system.prompt("Your name?") %>\n' };
    });
    await load(page);
    await open(page);
    await expect(page.locator(".prompt-input")).toBeVisible();
    await slowSwitch(page);
    await expect(page.locator(".prompt-input")).toHaveCount(0);
  });
}

test("a link that starts a switch closes the quick switcher, which makes nothing", async ({ page }) => {
  await load(page);
  await otherOpens(page, 3000, 0);
  await page.keyboard.press("ControlOrMeta+o");
  await expect(page.locator(".palette-input").first()).toBeFocused();
  await page.locator(".palette-input").first().fill("Made During Switch");
  await page.evaluate(() => (window as unknown as { __mockEmit: (n: string, p: unknown) => void }).__mockEmit("deep-link-open", "basalt://open?vault=/mock/other"));
  await expect(page.locator("main.main")).toHaveAttribute("inert", "");
  await expect(page.locator(".palette-input")).toHaveCount(0);
  await expect(page.locator(".switch-status")).toBeFocused();
  await page.keyboard.press("Enter");
  await opened(page);
  expect((await calls(page)).filter((c) => c.startsWith("create_note"))).toEqual([]);
});

test("a link to the vault that's going opens its note once that vault is open again", async ({ page }) => {
  await load(page);
  await slowSwitch(page, 2500);
  const tabs = () => page.locator(".pane:not(.dock) .tab").allTextContents();
  const before = await tabs();
  await page.evaluate(() => (window as unknown as { __mockEmit: (n: string, p: unknown) => void }).__mockEmit("deep-link-open", "basalt://open?vault=/mock/vault&note=Ideas.md"));
  await page.waitForTimeout(300);
  expect(await tabs()).toEqual(before);
  await opened(page);
  await expect(page.locator(".pane:not(.dock) .tab", { hasText: "Ideas" })).toHaveCount(1);
});

test("a switch held behind a slow save takes no typing meanwhile", async ({ page }) => {
  await load(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.evaluate(() => {
    const w = window as unknown as { __mockHook: (cmd: string) => Promise<void> | void };
    w.__mockHook = (cmd) => (cmd === "write_note" ? new Promise((r) => setTimeout(r, 2000)) : undefined);
  });
  await page.keyboard.type("q");
  await pickVault(page, "/mock/other");
  await page.waitForTimeout(300);
  await expect(page.locator("main.main")).toHaveAttribute("inert", "");
  await expect(page.locator(".switch-status")).toHaveText("Opening other…");
});

test("a save that never answers can't hold a switch: it asks, and goes on if told to", async ({ page }) => {
  test.setTimeout(60000);
  await load(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.evaluate(() => {
    const w = window as unknown as { __asked: string[]; __mockConfirm: () => boolean; __opens: number; __mockHook: (cmd: string) => unknown };
    w.__asked = [];
    w.__opens = 0;
    w.__mockConfirm = () => (w.__asked.push("asked"), w.__asked.length > 1);
    w.__mockHook = (cmd) => {
      if (cmd === "open_vault") w.__opens++;
      return cmd === "write_note" ? new Promise(() => {}) : undefined;
    };
  });
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("kept");
  const asked = () => page.evaluate(() => (window as unknown as { __asked: string[] }).__asked.length);
  // Turned down: the hold lets go, and the typing is still there.
  await pickVault(page, "/mock/other");
  await expect(page.locator("main.main")).toHaveAttribute("inert", "");
  await expect.poll(asked, { timeout: 8000 }).toBe(1);
  await opened(page);
  await expect(page.locator(".pane:not(.dock) .cm-content").first()).toContainText("kept");
  expect(await page.evaluate(() => (window as unknown as { __opens: number }).__opens)).toBe(0);
  // Told to go on: the vault opens.
  await pickVault(page, "/mock/other");
  await expect.poll(asked, { timeout: 8000 }).toBe(2);
  await opened(page);
  expect(await page.evaluate(() => (window as unknown as { __opens: number }).__opens)).toBe(1);
});

for (const [late, canvas] of [
  [false, false],
  [true, false],
  [true, true],
] as const) {
  test(`after switching anyway past a ${canvas ? "canvas " : ""}save that ${late ? "answers late" : "never answers"}, the new vault's status is its own`, async ({ page }) => {
    test.setTimeout(60000);
    await load(page);
    if (canvas) {
      await page.locator(".tree-row.attachment", { hasText: "Board" }).click();
      await expect(page.locator(".canvas-node")).toHaveCount(3);
    } else {
      await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
      await page.locator(".pane:not(.dock) .cm-content").first().click();
    }
    await page.evaluate((answers) => {
      const w = window as unknown as { __mockConfirm: () => boolean; __other: boolean; __newSave: boolean; __oldDone: () => void; __mockHook: (cmd: string, a: Record<string, unknown>) => unknown };
      const other = { path: "/mock/other/Other.md", rel: "Other.md", name: "Other", content: "other\n", mtime: 1, ctime: 1, size: 6 };
      w.__mockConfirm = () => true;
      // The old vault's save answers once the new vault's is under way, or never.
      let old = () => {};
      w.__oldDone = () => old();
      w.__mockHook = (cmd, a) => {
        if (cmd === "open_vault") return (w.__other = true), { result: "/mock/other" };
        if (cmd === "write_note" && w.__other) return (w.__newSave = true), new Promise(() => {});
        if (cmd === "write_note" || cmd === "write_canvas") return new Promise((r) => answers && (old = () => r({ result: null })));
        if (!w.__other) return;
        if (cmd === "read_vault") return { result: [other] };
        if (cmd === "read_note") return { result: other.content };
        if (cmd === "list_attachments" || cmd === "list_folders") return { result: [] };
      };
    }, late);
    if (canvas) {
      await page.locator(".canvas-node").first().click();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.locator(".canvas-view").press("Delete");
      await expect(page.locator(".canvas-node")).toHaveCount(2);
    } else {
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type("kept");
    }
    await page.waitForTimeout(1200);
    await pickVault(page, "/mock/other");
    await opened(page);
    const status = page.locator(".status").first();
    await expect(status).not.toContainText("Saving");
    await page.locator(".tree-row.file", { hasText: "Other" }).first().click();
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await page.keyboard.type("new");
    await expect.poll(() => page.evaluate(() => (window as unknown as { __newSave: boolean }).__newSave)).toBe(true);
    await expect(status).toHaveText("Saving…");
    await page.evaluate(() => (window as unknown as { __oldDone: () => void }).__oldDone());
    await page.waitForTimeout(500);
    await expect(status).toHaveText("Saving…");
  });
}

test("a switch says what it's opening while an earlier one loads and a later one fails", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "basalt.recentVaults",
      JSON.stringify([
        { path: "/mock/other", name: "other", ts: Date.now() },
        { path: "/mock/bad", name: "bad", ts: Date.now() - 1 },
      ]),
    );
  });
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __mockHook: (cmd: string, a: Record<string, unknown>) => unknown };
    w.__mockHook = (cmd, a) => {
      if (cmd === "open_vault" && a.path === "/mock/bad") return Promise.reject("not a folder");
      if (cmd === "open_vault") return new Promise((r) => setTimeout(r, 1000));
      if (cmd === "read_vault") return new Promise((r) => setTimeout(r, 3000));
    };
  });
  const status = page.locator(".switch-status");
  await pickVault(page, "/mock/other");
  await expect(status).toHaveText("Opening other…");
  await pickVault(page, "/mock/bad");
  await expect(status).toHaveText("Opening bad…");
  // The failed one is done; the first is still loading.
  await expect(page.getByRole("alert")).toHaveText(/Couldn.t open vault/, { timeout: 5000 });
  await expect(status).toHaveText("Opening other…");
  await expect(page.locator("main.main")).toHaveAttribute("inert", "");
  await opened(page);
  await expect(status).toHaveText("");
  await expect(page.getByRole("status").filter({ hasText: "Opened other" })).toHaveCount(1);
});

// A plugin of "other" asks to make a note as it loads, while the switch is still under way.
async function makerAsksAsOtherOpens(page: Page) {
  await page.addInitScript(() => localStorage.setItem("basalt.plugins.enabled./mock/other", JSON.stringify(["maker"])));
  await load(page);
  await otherOpens(page, 300, 2000);
  await page.evaluate(() => {
    const w = window as unknown as { __mockHook: (cmd: string, a: Record<string, unknown>) => unknown };
    const next = w.__mockHook;
    const code =
      'const { Plugin } = require("basalt"); module.exports = class extends Plugin { onload() { if (globalThis.__made) return; globalThis.__made = 1; this.app.vault.create("Made On Load.md", "x"); } };';
    w.__mockHook = (cmd, a) => {
      if (cmd === "list_plugins") return { result: [{ id: "maker", name: "Maker", version: "1", description: "", author: "", minAppVersion: "", data: null, code }] };
      if (cmd === "create_note") {
        next(cmd, a);
        return { result: `/mock/other/${String(a.name)}.md` };
      }
      return next(cmd, a);
    };
  });
  await pickVault(page, "/mock/other");
  await expect.poll(() => page.evaluate(() => (globalThis as { __made?: number }).__made)).toBe(1);
  expect((await calls(page)).filter((c) => c.startsWith("create_note"))).toEqual([]);
}

test("a plugin's change made as its vault opens waits for that, even through a second switch", async ({ page }) => {
  await makerAsksAsOtherOpens(page);
  await pickVault(page, "/mock/other");
  await opened(page);
  await expect.poll(() => calls(page)).toContainEqual("create_note:Made On Load");
  const log = await calls(page);
  expect(log.indexOf("create_note:Made On Load")).toBeGreaterThan(log.lastIndexOf("open_vault:/mock/other"));
});

test("a plugin's change made as its vault opens is dropped if a second switch leaves that vault", async ({ page }) => {
  await makerAsksAsOtherOpens(page);
  await page.evaluate(() =>
    localStorage.setItem("basalt.recentVaults", JSON.stringify([{ path: "/mock/other", name: "other", ts: Date.now() }, { path: "/mock/vault", name: "vault", ts: Date.now() - 1 }])),
  );
  await pickVault(page, "/mock/vault");
  await opened(page);
  await expect.poll(() => calls(page)).toContainEqual("open_vault:/mock/vault");
  await page.waitForTimeout(1000);
  expect((await calls(page)).filter((c) => c.startsWith("create_note"))).toEqual([]);
});

test("a startup daily note waits for the vault it's for, and isn't made in the next", async ({ page }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    localStorage.setItem(
      "basalt.recentVaults",
      JSON.stringify([
        { path: "/mock/b", name: "b", ts: Date.now() },
        { path: "/mock/c", name: "c", ts: Date.now() - 1 },
      ]),
    );
  });
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
  await page.evaluate(() => {
    const w = window as unknown as { __log: string[]; __at: string; __asked: number; __mockConfirm: () => Promise<boolean>; __mockHook: (cmd: string, a: Record<string, unknown>) => unknown };
    w.__log = [];
    w.__at = "/mock/vault";
    w.__asked = 0;
    // The first question is answered at once; the second, for C, after a while.
    w.__mockConfirm = () => new Promise((r) => setTimeout(() => r(true), w.__asked++ === 0 ? 0 : 3000));
    w.__mockHook = (cmd, a) => {
      w.__log.push(`${cmd}@${w.__at}`);
      if (cmd === "write_note") return Promise.reject("disk full");
      if (cmd === "open_vault") {
        return new Promise((r) =>
          setTimeout(() => {
            w.__at = String(a.path);
            r({ result: a.path });
          }, 1000),
        );
      }
      if (cmd === "read_obsidian_config") return { result: w.__at === "/mock/b" ? { openBehavior: "daily" } : {} };
      if (["read_vault", "list_attachments", "list_folders", "list_plugins"].includes(cmd) && w.__at !== "/mock/vault") return { result: [] };
      if (cmd === "create_note") return { result: `${w.__at}/${String(a.name)}.md` };
    };
  });
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.type("unsaved");
  await pickVault(page, "/mock/b");
  await page.waitForTimeout(300);
  // While B opens, C is asked for; its question holds the switch a while.
  await pickVault(page, "/mock/c");
  await opened(page);
  await page.waitForTimeout(500);
  const log = await page.evaluate(() => (window as unknown as { __log: string[] }).__log);
  expect(log).toContainEqual("open_vault@/mock/b");
  expect(log.filter((l) => l.startsWith("create_note"))).toEqual([]);
});

test("during a switch the palette offers only Switch vault, and Cmd-Shift-P isn't it", async ({ page }) => {
  await load(page, { "new-note": "mod+shift+p" });
  const notes = () => page.locator(".tree-row.file").count();
  const before = await notes();
  await slowSwitch(page);
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.waitForTimeout(200);
  await expect(page.locator(".palette-input")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("daily");
  await expect(page.getByText("No matching command")).toBeVisible();
  await page.locator(".palette-input").first().fill("");
  await expect(page.locator(".palette-item")).toHaveText([/Switch vault/]);
  await page.keyboard.press("Escape");
  await opened(page);
  expect(await notes()).toBe(before);
});

test("two switches at once hold until the last is done", async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    const w = window as unknown as { __mockHook: (cmd: string, a: Record<string, unknown>) => unknown };
    w.__mockHook = (cmd) => {
      if (cmd === "open_vault") return new Promise((r) => setTimeout(r, 1500));
      if (cmd === "read_vault") return new Promise((r) => setTimeout(r, 1500));
    };
  });
  await pickVault(page, "/mock/other");
  await page.waitForTimeout(800);
  await pickVault(page, "/mock/other");
  // The first has given way to the second, which is still opening.
  await page.waitForTimeout(2400);
  await expect(page.locator("main.main")).toHaveAttribute("inert", "");
  await expect(page.locator(".switch-status")).toHaveText("Opening other…");
  await opened(page);
});

test("text editing keys work in the palette during a switch, shortcuts don't", async ({ page }) => {
  await load(page);
  const keys = await watchKeys(page);
  await slowSwitch(page, 8000);
  await page.keyboard.press("ControlOrMeta+p");
  const input = page.locator(".palette-input").first();
  await expect(input).toBeFocused();
  await input.fill("abc");
  const start = (await keys()).length;
  for (const k of ["x", "z", "y", "ArrowLeft", "ArrowRight", "Backspace", "Delete", "Home", "End"]) await page.keyboard.press(`ControlOrMeta+${k}`);
  await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
  await page.keyboard.press("ControlOrMeta+Shift+p");
  expect((await keys()).slice(start)).toEqual([
    "x:false", "z:false", "y:false", "ArrowLeft:false", "ArrowRight:false", "Backspace:false", "Delete:false", "Home:false", "End:false",
    "ArrowLeft:true", "p:true",
  ]);
  if (process.platform === "darwin") {
    // A Mac field's Ctrl keys: to the start, to the end, delete back.
    await input.fill("bc");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("a");
    await page.keyboard.press("Control+e");
    await page.keyboard.type("dd");
    await page.keyboard.press("Control+h");
    await expect(input).toHaveValue("abcd");
    const at = (await keys()).length;
    await page.keyboard.press("Control+s");
    expect((await keys()).slice(at)).toEqual(["s:true"]);
  }
});

test("the sidebar button works during a switch", async ({ page }) => {
  await load(page);
  await expect(page.locator(".sidebar")).toHaveCount(1);
  await slowSwitch(page);
  await page.getByRole("button", { name: /Toggle sidebar/ }).click();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator("main.main")).toHaveAttribute("inert", "");
});

test("focus on a ribbon button stays there when a link starts a switch", async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    const w = window as unknown as { __mockHook: (cmd: string) => Promise<void> | void };
    w.__mockHook = (cmd) => (cmd === "open_vault" ? new Promise((r) => setTimeout(r, 3000)) : undefined);
  });
  await page.getByRole("button", { name: /Toggle sidebar/ }).focus();
  await page.evaluate(() => (window as unknown as { __mockEmit: (n: string, p: unknown) => void }).__mockEmit("deep-link-open", "basalt://open?vault=/mock/other"));
  await expect(page.locator(".switch-status")).toHaveText("Opening other…");
  await expect(page.getByRole("button", { name: /Toggle sidebar/ })).toBeFocused();
});

test("a palette being typed in keeps focus when a link starts a second switch", async ({ page }) => {
  await load(page);
  await slowSwitch(page);
  await page.keyboard.press("ControlOrMeta+p");
  const input = page.locator(".palette-input").first();
  await expect(input).toBeFocused();
  await page.evaluate(() => {
    localStorage.setItem("basalt.recentVaults", JSON.stringify([{ path: "/mock/third", name: "third", ts: Date.now() }]));
    (window as unknown as { __mockEmit: (n: string, p: unknown) => void }).__mockEmit("deep-link-open", "basalt://open?vault=/mock/third");
  });
  await expect(page.locator(".switch-status")).toHaveText("Opening third…");
  await expect(input).toBeFocused();
});

test("a switch turned down at the question brings the vault's plugins back", async ({ page }) => {
  await load(page);
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Open settings");
  await page.keyboard.press("Enter");
  await page.locator(".plugin-row", { hasText: "Demo Plugin" }).locator('input[type="checkbox"]').check();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ribbon-plugin-btn")).toHaveCount(1);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
  await page.evaluate(() => {
    const w = window as unknown as { __mockConfirm: () => Promise<boolean>; __mockHook: (cmd: string) => unknown };
    w.__mockHook = (cmd) => (cmd === "write_note" ? Promise.reject("disk full") : undefined);
    w.__mockConfirm = () => new Promise((r) => setTimeout(() => r(false), 1000));
  });
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.type("unsaved");
  await pickVault(page, "/mock/other");
  await expect(page.locator("main.main")).toHaveAttribute("inert", "");
  await expect(page.locator(".ribbon-plugin-btn")).toHaveCount(0);
  await opened(page);
  await expect(page.locator(".ribbon-plugin-btn")).toHaveCount(1);
  await expect(page.locator(".pane:not(.dock) .cm-content").first()).toContainText("unsaved");
});

for (const [how, answer] of [
  ["answers", "r({ result: null })"],
  ["fails", "j('disk full')"],
] as const) {
  test(`a save that ${how} after the switch it was given up for leaves the new vault alone`, async ({ page }) => {
    test.setTimeout(60000);
    await load(page);
    await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await otherOpens(page, 0, 0);
    await page.evaluate((late) => {
      const w = window as unknown as { __mockHook: (cmd: string, a: Record<string, unknown>) => unknown };
      const next = w.__mockHook;
      // Late: after the switch has asked about it and gone on.
      const settle = new Function("r", "j", late) as (r: (v: unknown) => void, j: (e: unknown) => void) => void;
      w.__mockHook = (cmd, a) => (cmd === "write_note" ? new Promise((r, j) => setTimeout(() => settle(r, j), 6000)) : next(cmd, a));
    }, answer);
    await page.keyboard.type("late");
    await page.waitForTimeout(1200);
    await pickVault(page, "/mock/other");
    await opened(page);
    await expect(page.locator(".tree-row.file")).toHaveCount(0);
    await page.waitForTimeout(2500); // the save has answered
    await expect(page.locator(".tree-row.file")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveText("");
  });
}

test("a load of plugins under way stops at a switch", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("basalt.plugins.enabled./mock/vault", JSON.stringify(["slow", "second"]));
    const plugin = (id: string, onload: string) => ({ id, name: id, version: "1", description: "", author: "", minAppVersion: "", data: null, code: `const { Plugin } = require("basalt"); module.exports = class extends Plugin { ${onload} };` });
    (window as unknown as { __mockHook: (cmd: string) => unknown }).__mockHook = (cmd) =>
      cmd === "list_plugins"
        ? { result: [plugin("slow", "async onload() { globalThis.__slow = 1; await new Promise((r) => setTimeout(r, 1500)); }"), plugin("second", "onload() { globalThis.__second = 1; }")] }
        : undefined;
  });
  await load(page);
  await expect.poll(() => page.evaluate(() => (globalThis as { __slow?: number }).__slow)).toBe(1);
  await slowSwitch(page, 3000);
  await page.waitForTimeout(2000); // the slow one's load is done; the switch is still opening
  expect(await page.evaluate(() => (globalThis as { __second?: number }).__second)).toBeUndefined();
});

test("a recording whose file is still being saved when the switch goes on isn't put in the new vault's note", async ({ page }) => {
  test.setTimeout(60000);
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
  await page.evaluate(() => {
    const w = window as unknown as { __other: boolean; __mockHook: (cmd: string, a: Record<string, unknown>) => unknown };
    const other = { path: "/mock/other/Other.md", rel: "Other.md", name: "Other", content: "other\n", mtime: 1, ctime: 1, size: 6 };
    w.__mockHook = (cmd, a) => {
      if (cmd === "write_attachment") return new Promise((r) => setTimeout(() => r(undefined), 6000));
      if (cmd === "open_vault") return (w.__other = true), { result: "/mock/other" };
      if (!w.__other) return;
      if (cmd === "read_vault") return { result: [other] };
      if (cmd === "read_note" && a.path === other.path) return { result: other.content };
      if (cmd === "list_attachments" || cmd === "list_folders") return { result: [] };
    };
  });
  await pickVault(page, "/mock/other");
  await opened(page);
  await page.locator(".tree-row.file", { hasText: "Other" }).first().click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.waitForTimeout(6500); // the file is saved
  await expect(page.locator(".pane:not(.dock) .cm-content").first()).not.toContainText("Recording");
});

for (const [canvas, first] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const) {
  test(`a ${canvas ? "canvas " : ""}retry save begun while a switch fails clears Saving when it answers${first ? " first" : ""}`, async ({ page }) => {
    test.setTimeout(60000);
    await page.addInitScript(() => {
      localStorage.setItem("basalt.recentVaults", JSON.stringify([{ path: "/mock/bad", name: "bad", ts: Date.now() }]));
    });
    await page.goto("/app-harness.html");
    await expect(page.locator(".sidebar")).toBeVisible();
    if (canvas) {
      await page.locator(".tree-row.attachment", { hasText: "Board" }).click();
      await expect(page.locator(".canvas-node")).toHaveCount(3);
    } else {
      await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
      await page.locator(".pane:not(.dock) .cm-content").first().click();
    }
    await page.evaluate((write) => {
      const w = window as unknown as { __writes: number; __failOpen: () => void; __answer: () => void; __mockConfirm: () => boolean; __mockHook: (cmd: string) => unknown };
      w.__writes = 0;
      w.__mockConfirm = () => true;
      w.__failOpen = () => {};
      w.__answer = () => {};
      w.__mockHook = (cmd) => {
        if (cmd === "open_vault") return new Promise((_, j) => (w.__failOpen = () => j("not a folder")));
        if (cmd !== write) return;
        // Its save and the switch's fail; the retry hangs.
        if (++w.__writes < 3) return Promise.reject("disk full");
        return new Promise((r) => (w.__answer = () => r({ result: null })));
      };
    }, canvas ? "write_canvas" : "write_note");
    const writes = () => page.evaluate(() => (window as unknown as { __writes: number }).__writes);
    if (canvas) {
      await page.locator(".canvas-node").first().click();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.locator(".canvas-view").press("Delete");
    } else {
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type("z");
    }
    await expect.poll(writes).toBe(1); // a retry is set for 2 s on
    await pickVault(page, "/mock/bad");
    await expect.poll(writes, { timeout: 8000 }).toBe(3); // the retry, while the open is under way
    await expect(page.locator("main.main")).toHaveAttribute("inert", "");
    const answer = () => page.evaluate(() => (window as unknown as { __answer: () => void }).__answer());
    const status = page.locator(".status").first();
    if (first) {
      await answer();
      await expect(status).toHaveText("Saved");
    }
    await page.evaluate(() => (window as unknown as { __failOpen: () => void }).__failOpen());
    await opened(page);
    if (!first) await answer();
    await expect(status).not.toContainText("Saving");
    await expect(page.locator(".tree-row.file", { hasText: "Ideas" })).toHaveCount(1);
  });
}

// "other" has a Projects folder too, and a note linking into it; "/mock/bad"
// fails to open when the test calls __failOpen. Each call is logged as
// "vault:cmd:args" or "other:cmd:args"; `old` answers for the vault being left,
// with `oneAtATime` in a queue that runs one call at a time, as the desktop
// core does.
async function otherWithProjects(page: Page, old: (cmd: string, a: Record<string, unknown>) => unknown = () => undefined, oneAtATime = false) {
  await page.evaluate(
    ([oldSrc, serial]) => {
      const w = window as unknown as { __log: string[]; __other: boolean; __failOpen: () => void; __mockConfirm: () => boolean; __mockHook: (cmd: string, a: Record<string, unknown>) => unknown };
      const plan = { path: "/mock/other/Projects/Plan.md", rel: "Projects/Plan.md", name: "Plan", content: "plan\n", mtime: 1, ctime: 1, size: 5 };
      const hub = { path: "/mock/other/Hub.md", rel: "Hub.md", name: "Hub", content: "see [[Projects/Plan]]\n", mtime: 1, ctime: 1, size: 22 };
      const oldHook = new Function(`return ${oldSrc}`)() as (cmd: string, a: Record<string, unknown>) => unknown;
      w.__log = [];
      w.__mockConfirm = () => (w.__log.push("asked"), true);
      let queue: Promise<unknown> = Promise.resolve();
      const answer = (cmd: string, a: Record<string, unknown>) => {
        w.__log.push(`${w.__other ? "other" : "vault"}:${cmd}:${JSON.stringify(a).slice(0, 80)}`);
        if (cmd === "open_vault" && a.path === "/mock/bad") return new Promise((_, j) => (w.__failOpen = () => j("not a folder")));
        if (cmd === "open_vault") {
          w.__other = String(a.path) === "/mock/other";
          return w.__other ? { result: "/mock/other" } : undefined;
        }
        if (!w.__other) return oldHook(cmd, a);
        if (cmd === "read_vault") return { result: [plan, hub] };
        if (cmd === "read_note") return String(a.path).startsWith("/mock/other/") ? { result: String(a.path).endsWith("Hub.md") ? hub.content : plan.content } : Promise.reject("path escapes vault");
        if (cmd === "list_attachments") return { result: [] };
        if (cmd === "list_folders") return { result: ["Projects"] };
        return { result: null };
      };
      w.__mockHook = (cmd, a) => {
        if (/read_obsidian|list_css|debug_log|start_watching|list_plugins|read_image|take_pending/.test(cmd)) return;
        if (!serial) return answer(cmd, a);
        const p = queue.then(() => answer(cmd, a));
        queue = p.catch(() => {});
        return p;
      };
    },
    [old.toString(), oneAtATime] as const,
  );
}
const inOther = async (page: Page, cmd: string) => (await calls(page)).filter((l) => l.startsWith(`other:${cmd}:`));

test("a folder move held by a save that stops answering moves nothing once the switch gives up on it", async ({ page }) => {
  test.setTimeout(60000);
  await load(page);
  await page.locator(".tree-row.folder", { hasText: "Projects" }).first().click();
  await page.locator(".tree-row.file", { hasText: "Roadmap" }).first().click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await otherWithProjects(page, (cmd) => {
    const w = window as unknown as { __release: () => void };
    if (cmd === "write_note") return new Promise((r) => (w.__release = () => r({ result: null })));
  });
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("typed");
  await expect.poll(async () => (await calls(page)).filter((l) => l.startsWith("vault:write_note:"))).toHaveLength(1);
  await page.locator(".tree-row.folder", { hasText: "Projects" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: /Rename/ }).first().click();
  await page.locator(".prompt-input").fill("Plans");
  await page.locator(".prompt-input").press("Enter");
  await pickVault(page, "/mock/other");
  await opened(page);
  await expect(page.locator(".tree-row.file", { hasText: "Hub" })).toHaveCount(1);
  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await page.waitForTimeout(1500);
  expect((await calls(page)).filter((l) => /:rename_folder:/.test(l))).toEqual([]);
  expect(await inOther(page, "write_note")).toEqual([]);
  await expect(page.getByRole("alert")).toHaveText("");
  await expect(page.locator(".tree-row.folder", { hasText: "Projects" })).toHaveCount(1);
});

test("a folder move queued behind a slow note rename moves nothing once the switch gives up on them", async ({ page }) => {
  test.setTimeout(60000);
  await load(page);
  await otherWithProjects(page, (cmd) => (cmd === "rename_note" ? new Promise((r) => setTimeout(() => r(undefined), 6000)) : undefined), true);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".prompt-input").fill("Ideas2");
  await page.locator(".prompt-input").press("Enter");
  await page.locator(".tree-row.folder", { hasText: "Projects" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: /Rename/ }).first().click();
  await page.locator(".prompt-input").fill("Plans");
  await page.locator(".prompt-input").press("Enter");
  await pickVault(page, "/mock/other");
  await opened(page);
  await expect(page.locator(".tree-row.file", { hasText: "Hub" })).toHaveCount(1);
  await page.waitForTimeout(1500);
  const l = await calls(page);
  expect(l.filter((x) => /:rename_folder:/.test(x))).toEqual([]);
  expect(l.filter((x) => x.startsWith("other:") && !/:(read_vault|list_attachments|list_folders|read_note):/.test(x))).toEqual([]);
  expect(l).not.toContain("asked");
  await expect(page.getByRole("alert")).toHaveText("");
});

async function loadWithBad(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("basalt.recentVaults", JSON.stringify(["other", "bad"].map((n, i) => ({ path: `/mock/${n}`, name: n, ts: Date.now() - i }))));
  });
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
}
const failOpen = (page: Page) => page.evaluate(() => (window as unknown as { __failOpen: () => void }).__failOpen());

test("a folder move held by a save that stops answering goes on when the switch fails", async ({ page }) => {
  test.setTimeout(60000);
  await loadWithBad(page);
  await page.locator(".tree-row.folder", { hasText: "Projects" }).first().click();
  await page.locator(".tree-row.file", { hasText: "Roadmap" }).first().click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await otherWithProjects(page, (cmd) => {
    const w = window as unknown as { __release: () => void };
    if (cmd === "write_note" && !w.__release) return new Promise((r) => (w.__release = () => r({ result: null })));
  });
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("typed");
  await expect.poll(async () => (await calls(page)).filter((l) => l.startsWith("vault:write_note:"))).toHaveLength(1);
  await page.locator(".tree-row.folder", { hasText: "Projects" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: /Rename/ }).first().click();
  await page.locator(".prompt-input").fill("Plans");
  await page.locator(".prompt-input").press("Enter");
  await pickVault(page, "/mock/bad");
  await expect.poll(() => calls(page), { timeout: 8000 }).toContainEqual(expect.stringMatching(/^vault:open_vault:/));
  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await page.waitForTimeout(500);
  await failOpen(page);
  await opened(page);
  await expect.poll(() => calls(page)).toContainEqual(expect.stringMatching(/^vault:rename_folder:/));
  await expect(page.locator(".tree-row.folder", { hasText: "Plans" })).toHaveCount(1);
});

test("a folder move queued behind a rename goes on when a switch that stopped waiting for them fails", async ({ page }) => {
  test.setTimeout(60000);
  await loadWithBad(page);
  await otherWithProjects(page, (cmd) => (cmd === "rename_note" ? new Promise((_, j) => setTimeout(() => j("busy"), 6000)) : undefined), true);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".prompt-input").fill("Ideas2");
  await page.locator(".prompt-input").press("Enter");
  await page.locator(".tree-row.folder", { hasText: "Projects" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: /Rename/ }).first().click();
  await page.locator(".prompt-input").fill("Plans");
  await page.locator(".prompt-input").press("Enter");
  await pickVault(page, "/mock/bad");
  // The rename has failed, and the open is under way.
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __failOpen?: unknown }).__failOpen), { timeout: 10000 }).toBe("function");
  await page.waitForTimeout(500);
  await failOpen(page);
  await opened(page);
  await expect.poll(() => calls(page)).toContainEqual(expect.stringMatching(/^vault:rename_folder:/));
});

test("a file rename held by a save that stops answering does nothing once the switch gives up on it", async ({ page }) => {
  test.setTimeout(60000);
  await load(page);
  await page.locator(".tree-row.file", { hasText: "Ideas" }).first().click();
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await otherWithProjects(page, (cmd) => {
    const w = window as unknown as { __release: () => void };
    if (cmd === "write_note") return new Promise((r) => (w.__release = () => r({ result: null })));
  });
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("typed");
  await expect.poll(async () => (await calls(page)).filter((l) => l.startsWith("vault:write_note:"))).toHaveLength(1);
  await page.locator(".tree-row.attachment", { hasText: "Board" }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".prompt-input").fill("Board2");
  await page.locator(".prompt-input").press("Enter");
  await pickVault(page, "/mock/other");
  await opened(page);
  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await page.waitForTimeout(1000);
  expect((await calls(page)).filter((l) => /:rename_attachment:/.test(l))).toEqual([]);
  await expect(page.getByRole("alert")).toHaveText("");
});
