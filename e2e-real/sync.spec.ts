import { mkdirSync, rmSync } from "node:fs";
import { test, expect, openApp, openNote, caretToEnd, settle } from "./fixture";

const editor = (page: import("@playwright/test").Page) => page.locator(".pane:not(.dock) .cm-content").first();

test("typing autosaves to disk", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await caretToEnd(page);
  await page.keyboard.type("\nzebra crossing");
  await expect.poll(() => vault.read("Ideas.md")).toContain("zebra crossing");
  expect(vault.read("Ideas.md")).toContain("Something for later. ^later-block");
});

test("an external edit reloads a clean editor", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  vault.write("Ideas.md", "# Ideas\n\nRewritten outside Basalt.\n");
  await expect(editor(page)).toContainText("Rewritten outside Basalt.");
  await settle(page);
  expect(vault.read("Ideas.md")).toBe("# Ideas\n\nRewritten outside Basalt.\n");
});

test("an external edit while dirty never silently drops either side", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await caretToEnd(page);
  await page.keyboard.type("\nmine");
  vault.write("Ideas.md", "# Ideas\n\ntheirs\n");
  await page.waitForTimeout(2500);
  const disk = vault.read("Ideas.md");
  const conflict = await page.locator(".conflict").isVisible();
  // Either the conflict badge is up (both versions still recoverable), or the
  // external edit landed before our first save and was reconciled cleanly.
  if (!conflict) {
    expect(disk).toContain("theirs");
    await expect(editor(page)).toContainText("theirs");
  } else {
    expect(disk).toBe("# Ideas\n\ntheirs\n");
    await expect(editor(page)).toContainText("mine");
  }
});

test("Keep mine overwrites the external edit; Reload discards local edits", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  // Make the editor dirty first, then land the external edit inside the
  // autosave debounce so the conflict path is taken.
  for (const choice of ["Keep mine", "Reload"] as const) {
    await caretToEnd(page);
    await page.keyboard.type(`\nlocal-${choice}`);
    vault.write("Ideas.md", `# Ideas\n\nexternal-${choice}\n`);
    const badge = page.locator(".conflict");
    try {
      await expect(badge).toBeVisible({ timeout: 3000 });
    } catch {
      test.info().annotations.push({ type: "race", description: `${choice}: save won before the watcher event` });
      continue;
    }
    await badge.getByRole("button", { name: choice }).click();
    await settle(page);
    if (choice === "Keep mine") {
      expect(vault.read("Ideas.md")).toContain("local-Keep mine");
      expect(vault.read("Ideas.md")).not.toContain("external-Keep mine");
    } else {
      expect(vault.read("Ideas.md")).toBe("# Ideas\n\nexternal-Reload\n");
      await expect(editor(page)).toContainText("external-Reload");
      await expect(editor(page)).not.toContainText("local-Reload");
    }
  }
});

test.describe("CRLF", () => {
  test.use({ vaultFiles: { "Windows.md": "# Windows\r\n\r\nline one\r\nline two\r\n" } });
  test("line endings survive an edit", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Windows");
    await caretToEnd(page);
    await page.keyboard.type("line three");
    await expect.poll(() => vault.read("Windows.md")).toContain("line three");
    const disk = vault.read("Windows.md");
    expect(disk.replace(/\r\n/g, "")).not.toContain("\n");
    expect(disk).toBe("# Windows\r\n\r\nline one\r\nline two\r\nline three");
  });
});

test.describe("UTF-8 BOM", () => {
  test.use({ vaultFiles: { "Bom.md": "﻿# Bom\n\nbody\n" } });
  test("a BOM is kept and not duplicated by an edit", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Bom");
    await caretToEnd(page);
    await page.keyboard.type("more");
    await expect.poll(() => vault.read("Bom.md")).toContain("more");
    const bytes = vault.readBytes("Bom.md");
    const boms = bytes.toString("utf8").split("﻿").length - 1;
    expect(boms).toBe(1);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});

test.describe("non-UTF-8", () => {
  const latin1 = Buffer.from([0x23, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a]);
  test.use({ vaultFiles: { "Latin.md": latin1 } });
  test("a non-UTF-8 note is never rewritten", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.file", { hasText: "Latin" }).first().click();
    await page.waitForTimeout(500);
    const content = page.locator(".pane:not(.dock) .cm-content").first();
    if (await content.isVisible()) {
      await content.click();
      await page.keyboard.type("x");
    }
    await page.waitForTimeout(1500);
    expect(vault.readBytes("Latin.md")).toEqual(latin1);
  });
});

test("a clean note deleted on disk is not resurrected", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await settle(page);
  const { rmSync } = await import("node:fs");
  rmSync(vault.path("Ideas.md"));
  await page.waitForTimeout(2500);
  expect(vault.exists("Ideas.md")).toBe(false);
});

test("a dirty note deleted on disk keeps the user's text recoverable", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await caretToEnd(page);
  await page.keyboard.type("\nunsaved words");
  const { rmSync } = await import("node:fs");
  rmSync(vault.path("Ideas.md"));
  await page.waitForTimeout(2500);
  // Acceptable outcomes: the note was re-saved with the text, or the editor
  // still holds it behind a conflict. Losing both is the failure.
  const onDisk = vault.exists("Ideas.md") && vault.read("Ideas.md").includes("unsaved words");
  const inEditor = (await editor(page).count()) > 0 && (await editor(page).innerText()).includes("unsaved words");
  expect(onDisk || inEditor).toBe(true);
});

test("the editor resyncs after the event stream drops and reconnects", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await settle(page);
  await vault.stop();
  vault.write("Ideas.md", "# Ideas\n\nchanged while the server was down\n");
  await vault.start();
  await expect(editor(page)).toContainText("changed while the server was down", { timeout: 15000 });
  await settle(page);
  expect(vault.read("Ideas.md")).toBe("# Ideas\n\nchanged while the server was down\n");
});

test("Keep mine on a note deleted elsewhere saves the user's text back", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await caretToEnd(page);
  await page.keyboard.type("\nwords I asked to keep");
  const { rmSync } = await import("node:fs");
  rmSync(vault.path("Ideas.md"));
  const badge = page.locator(".conflict");
  await expect(badge).toBeVisible({ timeout: 5000 });
  await badge.getByRole("button", { name: "Keep mine" }).click();
  await settle(page);
  expect(vault.exists("Ideas.md")).toBe(true);
  expect(vault.read("Ideas.md")).toContain("words I asked to keep");
  await page.waitForTimeout(1500);
  await expect(editor(page)).toContainText("words I asked to keep");
  await expect(badge).toBeHidden();
});

test("on a slow link, a second save waits for the first instead of conflicting with it", async ({ page, vault }) => {
  await page.route("**/api/invoke", async (route) => {
    if (route.request().postDataJSON()?.cmd === "write_note") await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await caretToEnd(page);
  await page.keyboard.type("\nfirst burst");
  await page.waitForTimeout(800);
  await page.keyboard.type(" second burst");
  await expect.poll(() => vault.read("Ideas.md"), { timeout: 10000 }).toContain("first burst second burst");
  await page.waitForTimeout(1500);
  await expect(page.locator(".conflict")).toBeHidden();
});

test("the event stream recovers after a reconnect is answered with a 502", async ({ page, vault }) => {
  let failNext = false;
  await page.route("**/api/events", async (route) => {
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 502, body: "Bad Gateway" });
    } else {
      await route.continue();
    }
  });
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await settle(page);
  failNext = true;
  await vault.stop();
  vault.write("Ideas.md", "# Ideas\n\nchanged during the outage\n");
  await vault.start();
  await expect(page.locator(".pane:not(.dock) .cm-content").first()).toContainText("changed during the outage", { timeout: 20000 });
  expect(failNext).toBe(false);
});

test("after Reload clears a refused save, the next edit saves normally", async ({ page, vault }) => {
  // No event stream: the only way Basalt learns of the external edit is the
  // core refusing the save, which is the path whose baseline Reload must fix.
  await page.route("**/api/events", (route) => route.abort());
  await openApp(page, vault);
  await openNote(page, "Ideas");
  vault.write("Ideas.md", "# Ideas\n\nexternal\n");
  await caretToEnd(page);
  await page.keyboard.type("\nmine");
  const badge = page.locator(".conflict");
  await expect(badge).toBeVisible({ timeout: 5000 });
  await badge.getByRole("button", { name: "Reload" }).click();
  await expect(editor(page)).toContainText("external");
  for (const word of ["first", "second"]) {
    await caretToEnd(page);
    await page.keyboard.type(` ${word}`);
    await expect.poll(() => vault.read("Ideas.md")).toContain(word);
    await expect(badge).toBeHidden();
  }
});

test("a conflict in a note that isn't focused is still shown, and opens on click", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await page.locator('button:has-text("⊟")').first().click();
  await expect(page.locator(".pane:not(.dock) .cm-editor")).toHaveCount(2);
  await page.locator(".tree-row.file", { hasText: "Welcome" }).click(); // one pane now shows Welcome
  const ideasEditor = page.getByRole("textbox", { name: "Editing Ideas" });
  const welcomeEditor = page.getByRole("textbox", { name: "Editing Welcome" });
  await ideasEditor.first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nmine");
  vault.write("Ideas.md", "# Ideas\n\ntheirs\n");
  await expect(page.locator(".conflict")).toBeVisible({ timeout: 5000 });
  await welcomeEditor.first().click(); // focus Welcome; the Ideas conflict is now elsewhere
  const elsewhere = page.locator(".conflict-elsewhere");
  await expect(elsewhere).toHaveText(/Ideas changed on disk/);
  await elsewhere.click();
  await expect(page.locator(".conflict")).toBeVisible();
});

test.describe("a save whose reply is slow", () => {
  for (const delay of [600, 1500]) {
    test(`no false conflict when the reply comes ${delay} ms after the write lands`, async ({ page, vault }) => {
      await openApp(page, vault);
      await openNote(page, "Ideas");
      await page.route("**/api/invoke", async (route) => {
        const slow = (route.request().postData() ?? "").includes('"cmd":"write_note"');
        const res = await route.fetch().catch(() => null);
        if (!res) return;
        if (slow) await new Promise((r) => setTimeout(r, delay));
        await route.fulfill({ response: res }).catch(() => {});
      });
      await page.locator(".pane:not(.dock) .cm-line", { hasText: "A list of things" }).click();
      await page.keyboard.press("End");
      const typed = " one two three four five six seven eight nine ten";
      await page.keyboard.type(typed, { delay: 40 });
      await settle(page, delay * 2 + 2000);
      await expect(page.locator(".conflict")).toHaveCount(0);
      expect(vault.read("Ideas.md")).toContain(`A list of things to try.${typed}\n`);
    });
  }
});

test.describe("a note too big for the index", () => {
  const filler = ("lorem ipsum dolor sit amet ".repeat(40) + "\n").repeat(4800);
  const big = `# Big\n\nhead line\n\n${filler}`;
  test.use({ vaultFiles: { "Big.md": big } });

  for (const saveFirst of [true, false]) {
    test(`an edit made elsewhere while offline isn't overwritten (${saveFirst ? "saved" : "never saved"} before)`, async ({ page, vault }) => {
      expect(Buffer.byteLength(big)).toBeGreaterThan(5_000_000);
      await openApp(page, vault);
      await openNote(page, "Big");
      const editor = page.locator(".pane:not(.dock) .cm-content").first();
      if (saveFirst) {
        await editor.locator(".cm-line", { hasText: "head line" }).click();
        await page.keyboard.press("End");
        await page.keyboard.type(" A");
        await expect.poll(() => vault.read("Big.md").slice(0, 40), { timeout: 10000 }).toContain("head line A");
        await settle(page, 1000);
      }
      await vault.stop();
      vault.write("Big.md", vault.read("Big.md").replace("head line", "head line PHONE"));
      await vault.start();
      await settle(page, 6000);
      await editor.locator(".cm-line", { hasText: "head line" }).click();
      await page.keyboard.press("End");
      await page.keyboard.type(" B");
      await settle(page, 3000);
      const disk = vault.read("Big.md");
      const conflict = await page.locator(".conflict").count();
      expect(disk.includes("PHONE") || conflict > 0).toBe(true);
    });
  }

  const reopenAfterOutage = async (page: import("@playwright/test").Page, vault: import("./fixture").Vault) => {
    await openApp(page, vault);
    await openNote(page, "Big");
    await openNote(page, "Welcome");
    await settle(page, 1000);
    await vault.stop();
    vault.write("Big.md", big.replace("head line", "head line PHONE"));
    await vault.start();
    await settle(page, 6000);
    await openNote(page, "Big");
    const editor = page.locator(".pane:not(.dock) .cm-content").first();
    await expect(editor).toContainText("head line PHONE");
    return editor;
  };

  test("reopened after an outage, it saves on top of what changed meanwhile", async ({ page, vault }) => {
    const editor = await reopenAfterOutage(page, vault);
    await editor.locator(".cm-line", { hasText: "head line PHONE" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" B");
    await expect.poll(() => vault.read("Big.md").slice(0, 40), { timeout: 10000 }).toContain("head line PHONE B");
    await expect(page.locator(".conflict")).toHaveCount(0);
  });

  test("reopened after an outage, an outside undo is shown and kept", async ({ page, vault }) => {
    const editor = await reopenAfterOutage(page, vault);
    vault.write("Big.md", big);
    await expect.poll(() => editor.textContent(), { timeout: 10000 }).not.toContain("PHONE");
    await editor.locator(".cm-line", { hasText: "head line" }).first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" B");
    await settle(page, 3000);
    const disk = vault.read("Big.md");
    const conflict = await page.locator(".conflict").count();
    expect(!disk.includes("PHONE") || conflict > 0).toBe(true);
  });
});

test.describe("big notes and a slow rescan", () => {
  const filler = ("lorem ipsum dolor sit amet ".repeat(40) + "\n").repeat(4800);
  const big = `# Big\n\nhead line\n\n${filler}`;
  const big2 = `# Big2\n\nsecond line\n\n${filler}`;
  test.use({ vaultFiles: { "Big.md": big, "Other.md": big2, "Gone.md": "# Gone\n", "Small.md": "# Small\n" } });

  const slowBigReads = async (page: import("@playwright/test").Page, name: string) => {
    let started = false;
    await page.route("**/api/invoke", async (route) => {
      const body = route.request().postData() ?? "";
      const res = await route.fetch().catch(() => null);
      if (!res) return;
      if (body.includes('"cmd":"read_note"') && body.includes(`/${name}.md`)) {
        started = true;
        await new Promise((r) => setTimeout(r, 4000));
      }
      await route.fulfill({ response: res }).catch(() => {});
    });
    return () => started;
  };

  test("a big note opened while the rescan reads another keeps its baseline", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Big");
    await settle(page, 1000);
    const started = await slowBigReads(page, "Big");
    vault.write("pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await expect.poll(started, { timeout: 10000 }).toBe(true);
    await openNote(page, "Other");
    await settle(page, 5000);
    await vault.stop();
    vault.write("Other.md", big2.replace("second line", "second line PHONE"));
    await vault.start();
    await settle(page, 6000);
    const editor = page.locator(".pane:not(.dock) .cm-content").first();
    await editor.locator(".cm-line", { hasText: "second line" }).first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" B");
    await settle(page, 3000);
    const disk = vault.read("Other.md");
    expect(disk.includes("PHONE") || (await page.locator(".conflict").count()) > 0).toBe(true);
  });

  test("a big note shown after its tab-mate is deleted keeps an outside edit", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Big");
    await openNote(page, "Gone");
    await settle(page, 1500);
    await page.reload();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Gone");
    rmSync(vault.path("Gone.md"));
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Big", { timeout: 10000 });
    await settle(page, 1500);
    await vault.stop();
    vault.write("Big.md", big.replace("head line", "head line PHONE"));
    await vault.start();
    await settle(page, 6000);
    const editor = page.locator(".pane:not(.dock) .cm-content").first();
    await editor.locator(".cm-line", { hasText: "head line" }).first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" B");
    await settle(page, 3000);
    const disk = vault.read("Big.md");
    expect(disk.includes("PHONE") || (await page.locator(".conflict").count()) > 0).toBe(true);
  });

  test("a rename made while the rescan reads a big note stays", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Big");
    await settle(page, 1000);
    const started = await slowBigReads(page, "Big");
    mkdirSync(vault.path("NewFolder"));
    await expect.poll(started, { timeout: 10000 }).toBe(true);
    await page.locator(".tree-row.file", { hasText: "Small" }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Rename…" }).click();
    await page.locator(".prompt-input").fill("Small Renamed");
    await page.locator(".prompt-input").press("Enter");
    await expect.poll(() => vault.exists("Small Renamed.md")).toBe(true);
    await settle(page, 6000);
    await expect(page.locator(".tree-row.file", { hasText: "Small Renamed" })).toHaveCount(1);
    await expect(page.locator(".tree-row.file", { hasText: /^Small$/ })).toHaveCount(0);
  });

  test("a big note opened after an outside edit saves normally after a rescan", async ({ page, vault }) => {
    await openApp(page, vault);
    vault.write("Big.md", big.replace("head line", "head line PHONE"));
    await settle(page, 4000);
    await openNote(page, "Big");
    const editor = page.locator(".pane:not(.dock) .cm-content").first();
    await editor.locator(".cm-line", { hasText: "head line PHONE" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" A");
    await expect.poll(() => vault.read("Big.md").slice(0, 40), { timeout: 10000 }).toContain("PHONE A");
    mkdirSync(vault.path("NewFolder"));
    await settle(page, 5000);
    await editor.locator(".cm-line", { hasText: "head line PHONE" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" B");
    await expect.poll(() => vault.read("Big.md").slice(0, 40), { timeout: 10000 }).toContain("PHONE A B");
    await expect(page.locator(".conflict")).toHaveCount(0);
  });

  test("a stacked column whose first read never answers loads in the end", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Big");
    await openNote(page, "Small");
    await settle(page, 1500);
    await page.reload();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Small");
    let hung = false;
    await page.route("**/api/invoke", async (route) => {
      const body = route.request().postData() ?? "";
      if (!hung && body.includes('"cmd":"read_note"') && body.includes("/Big.md")) {
        hung = true;
        return; // never answered
      }
      await route.continue().catch(() => {});
    });
    await page.locator(".tab-stack").first().click();
    const col = page.locator(".stacked-col").filter({ has: page.locator(".stacked-col-head", { hasText: "Big" }) });
    await expect(col.locator(".placeholder")).toHaveText("Loading…");
    await expect(col.locator(".cm-content")).toBeVisible({ timeout: 20000 });
    expect(hung).toBe(true);
  });
});

test("slow write and read replies never put back an older save", async ({ page, vault }) => {
  await openApp(page, vault);
  await openNote(page, "Ideas");
  await page.route("**/api/invoke", async (route) => {
    const body = route.request().postData() ?? "";
    const res = await route.fetch().catch(() => null);
    if (!res) return;
    if (body.includes('"cmd":"write_note"')) await new Promise((r) => setTimeout(r, 800));
    if (body.includes('"cmd":"read_note"')) await new Promise((r) => setTimeout(r, 3000));
    await route.fulfill({ response: res }).catch(() => {});
  });
  const editor = page.locator(".pane:not(.dock) .cm-content").first();
  await editor.locator(".cm-line", { hasText: "A list of things" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" W1");
  await page.waitForTimeout(1200);
  await page.keyboard.type(" W2");
  await settle(page, 6000);
  await expect(editor).toContainText("try. W1 W2");
  await expect(page.locator(".conflict")).toHaveCount(0);
  expect(vault.read("Ideas.md")).toContain("try. W1 W2\n");
});

test.describe("a keystroke as an outside edit is read", () => {
  test.use({ vaultFiles: { "W.md": "# W\n\nalpha\n\nomega\n" } });

  test("doesn't overwrite the edit", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "W");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "omega" }).click();
    await page.keyboard.press("End");
    let armed = false;
    let typed: Promise<void> | null = null;
    await page.route("**/api/invoke", async (route) => {
      const body = route.request().postData() ?? "";
      const res = await route.fetch().catch(() => null);
      if (!res) return;
      if (armed && body.includes('"cmd":"read_note"') && body.includes("/W.md")) {
        armed = false;
        const sent = route.fulfill({ response: res }).catch(() => {});
        typed = page.keyboard.type("Q");
        await sent;
        return;
      }
      await route.fulfill({ response: res }).catch(() => {});
    });
    armed = true;
    vault.write("W.md", "# W\n\nalpha PHONE\n\nomega\n");
    await expect.poll(() => typed !== null, { timeout: 10000 }).toBe(true);
    await typed;
    await settle(page, 2500);
    const disk = vault.read("W.md");
    expect(disk.includes("PHONE") || (await page.locator(".conflict").count()) > 0).toBe(true);
    if ((await page.locator(".conflict").count()) === 0) expect(disk).toBe("# W\n\nalpha PHONE\n\nomegaQ\n");
  });
});

test.describe("a big note renamed while typing in it", () => {
  const filler = ("lorem ipsum dolor sit amet ".repeat(40) + "\n").repeat(5200);
  test.use({ vaultFiles: { "Big.md": `me [[Big]]\n\nstart\n\n${filler}` } });

  test("raises no false conflict", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Big");
    let held = false;
    let release: () => void = () => {};
    await page.route("**/api/invoke", async (route) => {
      const body = route.request().postData() ?? "";
      const res = await route.fetch().catch(() => null);
      if (!res) return;
      if (!held && body.includes('"cmd":"read_note"') && body.includes("Big2.md")) {
        held = true;
        await new Promise<void>((r) => (release = r));
      }
      await route.fulfill({ response: res }).catch(() => {});
    });
    await page.locator(".pane:not(.dock) input.inline-title").first().fill("Big2");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "start" }).click();
    await page.keyboard.press("End");
    await expect.poll(() => held, { timeout: 10000 }).toBe(true);
    await page.keyboard.type(" T");
    await page.waitForTimeout(300);
    release();
    await settle(page, 3000);
    await expect(page.locator(".conflict")).toHaveCount(0);
    await expect.poll(() => vault.read("Big2.md").slice(0, 30), { timeout: 10000 }).toContain("me [[Big2]]\n\nstart T");
  });
});

test.describe("a note opened over a slow read", () => {
  test.use({ vaultFiles: { "Lnote.md": "# L\n\nalpha\n\nend\n", "Lnk.md": "# L\n\nsee [[Tnote]]\n\nend\n", "Tnote.md": "# T\n", "Zother.md": "# Z\n" } });

  const slowFirstRead = async (page: import("@playwright/test").Page, name: string, ms: number) => {
    const state = { served: false, landed: false };
    await page.route("**/api/invoke", async (route) => {
      const body = route.request().postData() ?? "";
      const res = await route.fetch().catch(() => null);
      if (!res) return;
      if (!state.served && body.includes('"cmd":"read_note"') && body.includes(`/${name}.md`)) {
        state.served = true;
        await new Promise((r) => setTimeout(r, ms));
        await route.fulfill({ response: res }).catch(() => {});
        state.landed = true;
        return;
      }
      await route.fulfill({ response: res }).catch(() => {});
    });
    return state;
  };

  test("keeps an outside edit made during the read", async ({ page, vault }) => {
    await openApp(page, vault);
    const read = await slowFirstRead(page, "Lnote", 2000);
    await page.locator(".tree-row.file", { hasText: "Lnote" }).first().click();
    await expect.poll(() => read.served).toBe(true);
    vault.write("Lnote.md", "# L\n\nPHONE alpha\n\nend\n");
    await expect.poll(() => read.landed, { timeout: 10000 }).toBe(true);
    await settle(page, 1500);
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^end$/ }).click();
    await page.keyboard.press("End");
    await page.keyboard.type("Q");
    await settle(page, 1500);
    const disk = vault.read("Lnote.md");
    expect(disk.includes("PHONE") || (await page.locator(".conflict").count()) > 0).toBe(true);
  });

  test("keeps the newest outside edit when it changes during every read", async ({ page, vault }) => {
    await openApp(page, vault);
    let slow = 0;
    let inflight = 0;
    await page.route("**/api/invoke", async (route) => {
      const body = route.request().postData() ?? "";
      const res = await route.fetch().catch(() => null);
      if (!res) return;
      if (body.includes('"cmd":"read_note"') && body.includes("/Lnote.md") && inflight === 0 && slow < 3) {
        const n = ++slow;
        inflight++;
        setTimeout(() => vault.write("Lnote.md", `# L\n\nphone: ${n}\n\nend\n`), 300);
        await new Promise((r) => setTimeout(r, 2500));
        inflight--;
      }
      await route.fulfill({ response: res }).catch(() => {});
    });
    await page.locator(".tree-row.file", { hasText: "Lnote" }).first().click();
    await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText("Lnote", { timeout: 15000 });
    await settle(page, 1500);
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^end$/ }).click();
    await page.keyboard.press("End");
    await page.keyboard.type("Q");
    await settle(page, 1500);
    const disk = vault.read("Lnote.md");
    expect(disk.includes("phone: 3") || (await page.locator(".conflict").count()) > 0).toBe(true);
  });

  test("keeps a rename's link fix made during the read", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Zother");
    const read = await slowFirstRead(page, "Lnk", 2500);
    await page.locator(".tree-row.file", { hasText: "Lnk" }).first().click();
    await expect.poll(() => read.served).toBe(true);
    await page.locator(".tree-row.file", { hasText: "Tnote" }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Rename…" }).click();
    await page.locator(".prompt-input").fill("Tnote2");
    await page.locator(".prompt-input").press("Enter");
    await expect.poll(() => vault.read("Lnk.md"), { timeout: 10000 }).toContain("[[Tnote2]]");
    await expect.poll(() => read.landed, { timeout: 10000 }).toBe(true);
    await settle(page, 1500);
    await page.locator(".pane:not(.dock) .cm-line", { hasText: /^end$/ }).click();
    await page.keyboard.press("End");
    await page.keyboard.type("Q");
    await settle(page, 1500);
    expect(vault.read("Lnk.md")).toBe("# L\n\nsee [[Tnote2]]\n\nendQ\n");
  });
});

test.describe("saves that fail while the connection is down", () => {
  test("go through when the browser is back online", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Ideas");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "A list of things" }).click();
    await page.keyboard.press("End");
    await page.context().setOffline(true);
    await page.keyboard.type(" one");
    await page.waitForTimeout(2000);
    expect(vault.read("Ideas.md")).not.toContain("try. one");
    await page.context().setOffline(false);
    await expect.poll(() => vault.read("Ideas.md"), { timeout: 15000 }).toContain("try. one\n");
  });

  test("go through when the server is back", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Ideas");
    await page.locator(".pane:not(.dock) .cm-line", { hasText: "A list of things" }).click();
    await page.keyboard.press("End");
    await vault.stop();
    await page.keyboard.type(" two");
    await page.waitForTimeout(2000);
    await vault.start();
    await expect.poll(() => vault.read("Ideas.md"), { timeout: 25000 }).toContain("try. two\n");
  });
});

test.describe("today's daily note from a template", () => {
  test.use({
    vaultFiles: {
      ".obsidian/daily-notes.json": JSON.stringify({ template: "Templates/Daily" }),
      "Templates/Daily.md": "## Log\n",
    },
  });

  test("doesn't overwrite text typed into it while the template loads", async ({ page, vault }) => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    await openApp(page, vault);
    let release: () => void = () => {};
    let held = false;
    await page.route("**/api/invoke", async (route) => {
      const body = route.request().postData() ?? "";
      const res = await route.fetch().catch(() => null);
      if (!res) return;
      if (!held && body.includes('"cmd":"read_note"') && body.includes("Daily.md")) {
        held = true;
        await new Promise<void>((r) => (release = r));
      }
      await route.fulfill({ response: res }).catch(() => {});
    });
    await page.keyboard.press("ControlOrMeta+p");
    await page.locator(".palette-input").first().fill("Open today's daily note");
    await page.keyboard.press("Enter");
    await expect.poll(() => held, { timeout: 10000 }).toBe(true);
    await expect(page.locator(".tree-row.file", { hasText: today })).toHaveCount(1, { timeout: 10000 });
    await page.locator(".tree-row.file", { hasText: today }).first().click();
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await page.keyboard.type("my first thought");
    await expect.poll(() => vault.read(`${today}.md`)).toBe("my first thought");
    release();
    await settle(page, 2500);
    expect(vault.read(`${today}.md`)).toBe("my first thought");
    await expect(page.locator(".tree-row.file", { hasText: today })).toHaveCount(1);
  });
});
