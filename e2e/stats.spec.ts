import { test, expect, type Page } from "@playwright/test";

const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const base = (filter: string) => `views:\n  - type: list\n    name: V\n    filters: '${filter}'\n`;
async function load(page: Page, files: Record<string, string>) {
  await page.addInitScript((f) => ((window as unknown as { __mockExtraFiles: Record<string, string> }).__mockExtraFiles = f), files);
  await page.goto("/app-harness.html");
  await expect(page.locator(".sidebar")).toBeVisible();
}
const view = (page: Page) => page.locator(".pane:not(.dock) .base-view");
async function run(page: Page, label: string) {
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill(label);
  await page.keyboard.press("Enter");
}
const emit = (page: Page, c: object) =>
  page.evaluate((x) => (window as unknown as { __mockEmit: (n: string, p: unknown) => void }).__mockEmit("vault-changed", [x]), c);

test("today's daily note has its creation time at once", async ({ page }) => {
  await load(page, { "New.base": base("file.ctime.year > 2024") });
  await run(page, "Open today's daily note");
  await expect(page.locator(".pane:not(.dock) .tab.active .tab-name").first()).toHaveText(today);
  await page.locator(".tree-row.attachment", { hasText: "New" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: today })).toHaveCount(1);
});

test("a new note has its creation time at once", async ({ page }) => {
  await load(page, { "New.base": base("file.ctime.year > 2024") });
  await run(page, "New note");
  await page.waitForTimeout(500);
  await page.locator(".tree-row.attachment", { hasText: "New" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Untitled" })).toHaveCount(1);
});

test("a copy has its creation time and byte size at once", async ({ page }) => {
  await load(page, { "New.base": base("file.ctime.year > 2024 && file.size == 4"), "Cafe.md": "é\nx" });
  await page.locator(".tree-row.file", { hasText: "Cafe" }).first().click({ button: "right" });
  await page.getByText("Make a copy").click();
  await page.waitForTimeout(500);
  await page.locator(".tree-row.attachment", { hasText: "New" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Cafe copy" })).toHaveCount(1);
});

test("a time-only change carries a new creation time", async ({ page }) => {
  await load(page, { "Old.base": base("file.ctime.year < 2021"), "Gamma.md": "# Gamma\n" });
  await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(0);
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: 1_700_000_000_000, ctime: Date.UTC(2020, 4, 2), size: 8, statsOnly: true });
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1);
});

test("a time-only change carries a new size", async ({ page }) => {
  await load(page, { "Big.base": base("file.size == 12345"), "Gamma.md": "# Gamma\n" });
  await page.locator(".tree-row.attachment", { hasText: "Big" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(0);
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: 1_700_000_000_000, ctime: 1_700_000_000_000, size: 12345, statsOnly: true });
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1);
});

test("a new note's text change, then a change of its time alone: the note is still read", async ({ page }) => {
  await load(page, {});
  await page.waitForTimeout(500);
  const t = 1_700_000_000_000;
  await emit(page, { path: "/mock/vault/Fresh.md", rel: "Fresh.md", mtime: t, ctime: t, size: 0 });
  await emit(page, { path: "/mock/vault/Fresh.md", rel: "Fresh.md", mtime: t + 5, ctime: t, size: 0, statsOnly: true });
  await expect(page.locator(".tree-row.file", { hasText: "Fresh" })).toHaveCount(1);
});

test("a note whose time alone changes twice isn't read", async ({ page }) => {
  await load(page, { "Gamma.md": "# Gamma\n" });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const w = window as unknown as { __reads: number; __mockHook: (cmd: string, a: { path?: string }) => void };
    w.__reads = 0;
    w.__mockHook = (cmd, a) => {
      if (cmd === "read_note" && a.path?.endsWith("Gamma.md")) w.__reads++;
    };
  });
  const t = 1_700_000_000_000;
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: t + 1, ctime: t, size: 8, statsOnly: true });
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: t + 2, ctime: t, size: 8, statsOnly: true });
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as unknown as { __reads: number }).__reads)).toBe(0);
});

test("a change read during our save, and read again after it, keeps a later change's time", async ({ page }) => {
  await load(page, { "Old.base": base("file.mtime.year < 2021"), "Gamma.md": "# Gamma\n" });
  await page.locator(".tree-row.file", { hasText: "Gamma" }).first().click();
  await page.evaluate(() => {
    const w = window as unknown as { __saved: boolean; __reading: boolean; __read: number; __mockHook: (cmd: string, a: { path?: string }) => Promise<{ result: unknown } | void> };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    w.__read = 0;
    w.__mockHook = async (cmd, a) => {
      if (!a.path?.endsWith("Gamma.md")) return;
      // The save fails on the outside change, so only the watcher sets the note's time.
      if (cmd === "write_note") {
        await sleep(3000);
        w.__saved = true;
        throw "Changed on disk since Basalt last read it";
      }
      if (cmd === "read_note") {
        if (w.__read++ === 0) {
          w.__reading = true;
          await sleep(1000);
        }
        return { result: "# Gamma\n\nfrom the phone\n" };
      }
    };
  });
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("z");
  await page.waitForTimeout(700); // the save is out, and slow
  const t = Date.UTC(2026, 0, 1);
  // Changed outside meanwhile, then touched while that change is read.
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: t, ctime: t, size: 26 });
  await page.waitForFunction(() => (window as unknown as { __reading: boolean }).__reading);
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: Date.UTC(2020, 4, 2), ctime: t, size: 26, statsOnly: true });
  await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1);
  // The read overlapped the save, so it's read again once the save has settled.
  await page.waitForFunction(() => (window as unknown as { __saved: boolean }).__saved);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as { __read: number }).__read)).toBeGreaterThan(1);
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1);
});

test("a note a plugin makes has its creation time and byte size at once", async ({ page }) => {
  await load(page, { "New.base": base("file.ctime.year > 2024 && file.size == 4") });
  await run(page, "Open settings");
  await page.locator(".plugin-row", { hasText: "Demo Plugin" }).locator('input[type="checkbox"]').check();
  await page.keyboard.press("Escape");
  await run(page, "Vault create a note");
  await page.waitForTimeout(500);
  await page.locator(".tree-row.attachment", { hasText: "New" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Made By Plugin" })).toHaveCount(1);
});

test("sorting Files by modified time uses a time that changed under another sort", async ({ page }) => {
  await load(page, { "Zzz.md": "z", "Aaa.md": "a" });
  const order = async () => (await page.locator(".tree-row.file").allTextContents()).filter((t) => /Aaa|Zzz/.test(t));
  await expect.poll(order).toEqual([expect.stringContaining("Aaa"), expect.stringContaining("Zzz")]);
  await emit(page, { path: "/mock/vault/Zzz.md", rel: "Zzz.md", mtime: Date.now() + 86_400_000, ctime: 1_700_000_000_000, size: 1, statsOnly: true });
  await page.waitForTimeout(1000);
  await page.locator(".file-sort").selectOption("mtime-desc");
  await expect.poll(order).toEqual([expect.stringContaining("Zzz"), expect.stringContaining("Aaa")]);
});

test("a read sent back behind our save doesn't replace a newer time-only change", async ({ page }) => {
  await load(page, { "Old.base": base("file.mtime.year < 2021"), "Gamma.md": "# Gamma\n" });
  await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
  await expect(view(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Split right" }).click();
  await page.locator(".tree-row.file", { hasText: "Gamma" }).first().click();
  await expect(view(page)).toHaveCount(1);
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as unknown as { __saved: boolean; __read: number; __mockHook: (cmd: string, a: { path?: string }) => Promise<{ result: unknown } | void> };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    w.__read = 0;
    w.__mockHook = async (cmd, a) => {
      if (!a.path?.endsWith("Gamma.md")) return;
      if (cmd === "write_note") {
        await sleep(3000);
        w.__saved = true;
        throw "Changed on disk since Basalt last read it";
      }
      if (cmd === "read_note") {
        if (w.__read++ === 0) {
          // A newer, time-only change comes in just before this read answers.
          await sleep(900);
          (window as unknown as { __mockEmit: (n: string, p: unknown) => void }).__mockEmit("vault-changed", [
            { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: Date.UTC(2020, 4, 2), ctime: Date.UTC(2020, 0, 1), size: 26, statsOnly: true },
          ]);
          await sleep(100);
        }
        return { result: "# Gamma\n\nfrom the phone\n" };
      }
    };
  });
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("z");
  await page.waitForTimeout(700);
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: Date.UTC(2026, 0, 1), ctime: Date.UTC(2020, 0, 1), size: 26 });
  await page.waitForFunction(() => (window as unknown as { __saved: boolean }).__saved, null, { timeout: 10000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __read: number }).__read)).toBeGreaterThan(1);
  // The newest change says 2020.
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1, { timeout: 5000 });
});

test("an older read that lands after a newer one leaves the newer one's text and stats", async ({ page }) => {
  await load(page, { "Size.base": base("file.size == 20"), "Gamma.md": "# Gamma\n" });
  await page.locator(".tree-row.attachment", { hasText: "Size" }).click();
  await expect(view(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Split right" }).click();
  await page.locator(".tree-row.file", { hasText: "Gamma" }).first().click();
  await page.evaluate(() => {
    const w = window as unknown as { __read: number; __mockHook: (cmd: string, a: { path?: string }) => Promise<{ result: unknown } | void> };
    w.__read = 0;
    w.__mockHook = async (cmd, a) => {
      if (cmd !== "read_note" || !a.path?.endsWith("Gamma.md")) return;
      if (w.__read++ === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        return { result: "old text\n" };
      }
      return { result: "new text, 20 bytes\n" };
    };
  });
  const t = Date.UTC(2026, 0, 1);
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: t, ctime: t, size: 9 });
  await page.waitForTimeout(700);
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: t + 1000, ctime: t, size: 20 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __read: number }).__read)).toBe(2);
  await page.waitForTimeout(1500);
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1);
  await expect(page.locator(".pane:not(.dock) .cm-content").last()).toContainText("new text, 20 bytes");
});

test("an old vault's change read across a switch stays out of the new vault", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("basalt.recentVaults", JSON.stringify([{ path: "/mock/other", name: "other", ts: Date.now() }]));
  });
  await load(page, { "Gamma.md": "# Gamma\n" });
  const writes: string[] = [];
  await page.exposeFunction("__noteWrite", (c: string) => writes.push(c));
  await page.evaluate(() => {
    const w = window as unknown as { __other: boolean; __mockHook: (cmd: string, a: { path?: string; content?: string }) => Promise<{ result: unknown } | void> };
    w.__mockHook = async (cmd, a) => {
      if (cmd === "open_vault" && String(a.path).includes("other")) {
        w.__other = true;
        return { result: "/mock/other" };
      }
      if (cmd === "read_vault" && w.__other)
        return { result: [{ path: "/mock/other/Gamma.md", rel: "Gamma.md", name: "Gamma", content: "other gamma\n", mtime: 1, ctime: 1, size: 12 }] };
      if ((cmd === "list_attachments" || cmd === "list_folders") && w.__other) return { result: [] };
      if (cmd === "read_note" && a.path === "/mock/vault/Gamma.md") {
        await new Promise((r) => setTimeout(r, 2500));
        return { result: "OLD VAULT TEXT\n" };
      }
      if (cmd === "read_note" && a.path === "/mock/other/Gamma.md") return { result: "other gamma\n" };
      if (cmd === "write_note") {
        (window as unknown as { __noteWrite: (c: string) => void }).__noteWrite(String(a.content));
        return { result: undefined };
      }
    };
  });
  await emit(page, { path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: 5, ctime: 5, size: 15 });
  await page.waitForTimeout(500); // its read is under way
  await page.keyboard.press("ControlOrMeta+p");
  await page.locator(".palette-input").first().fill("Switch vault");
  await page.locator(".palette-item", { hasText: "Switch vault" }).first().click();
  await page.locator(".vault-item", { hasText: "/mock/other" }).first().click();
  await expect(page.locator("main.main")).not.toHaveAttribute("inert", { timeout: 10000 });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /^Search/ }).click();
  await page.locator(".palette-input").first().fill("other gamma");
  await expect(page.locator(".palette-item")).toHaveCount(1);
  await page.locator(".palette-input").first().fill("OLD VAULT");
  await page.waitForTimeout(500);
  await expect(page.locator(".palette-item")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.locator(".tree-row.file", { hasText: "Gamma" }).first().click();
  await expect(page.locator(".pane:not(.dock) .cm-content").first()).toContainText("other gamma");
  await page.locator(".pane:not(.dock) .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("q");
  await expect.poll(() => writes.length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(writes.some((c) => c.includes("OLD VAULT"))).toBe(false);
});

test("a save's time isn't replaced by an older time-only change delivered as it lands", async ({ page }) => {
  await load(page, { "Old.base": base("file.mtime.year < 2021"), "Gamma.md": "# Gamma\n" });
  await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
  await expect(view(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Split right" }).click();
  await page.locator(".tree-row.file", { hasText: "Gamma" }).first().click();
  await page.evaluate(() => {
    const w = window as unknown as { __done: boolean; __mockHook: (cmd: string, a: { path?: string; content?: string }) => Promise<{ result: unknown } | void> };
    const fire = (x: object) => (window as unknown as { __mockEmit: (n: string, p: unknown) => void }).__mockEmit("vault-changed", [x]);
    w.__mockHook = async (cmd, a) => {
      if (cmd !== "write_note" || !a.path?.endsWith("Gamma.md")) return;
      // A sync's touch from before the save, delivered just as it lands...
      fire({ path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: Date.UTC(2020, 4, 2), ctime: Date.UTC(2020, 0, 1), size: 8, statsOnly: true });
      const content = String(a.content);
      // ...then the save's own echo, with its real time.
      setTimeout(() => {
        fire({ path: "/mock/vault/Gamma.md", rel: "Gamma.md", mtime: Date.now(), ctime: Date.UTC(2020, 0, 1), size: new TextEncoder().encode(content).length });
        w.__done = true;
      }, 600);
    };
  });
  await page.locator(".pane:not(.dock) .cm-content").last().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("z");
  await page.waitForFunction(() => (window as unknown as { __done: boolean }).__done, null, { timeout: 10000 });
  await page.waitForTimeout(1500);
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(0);
});

const old2020 = (rel: string) => ({ path: `/mock/vault/${rel}`, rel, mtime: Date.UTC(2020, 4, 2), ctime: Date.UTC(2020, 0, 1), size: 12, statsOnly: true });

test("a task ticked in a query has its note's new time", async ({ page }) => {
  await load(page, { "Old.base": base("file.mtime.year < 2021"), "Todo.md": "- [ ] alpha\n", "Q.md": "```dataview\nTASK\n```\n" });
  await emit(page, old2020("Todo.md"));
  await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Todo" })).toHaveCount(1);
  await page.getByRole("button", { name: "Split right" }).click();
  await page.locator(".tree-row.file", { hasText: "Q" }).first().click();
  await page.getByRole("button", { name: "Reading" }).click();
  const box = page.locator(".query-task", { hasText: "alpha" }).locator("input").first();
  await expect(box).toBeVisible();
  await box.check();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Todo" })).toHaveCount(0);
});

test("a note a plugin modifies has its new time", async ({ page }) => {
  await load(page, { "Old.base": base("file.mtime.year < 2021"), "Gamma.md": "# Gamma\n" });
  await emit(page, old2020("Gamma.md"));
  await page.locator(".tree-row.attachment", { hasText: "Old" }).click();
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(1);
  await run(page, "Open settings");
  await page.locator(".plugin-row", { hasText: "Demo Plugin" }).locator('input[type="checkbox"]').check();
  await page.keyboard.press("Escape");
  await run(page, "Vault modify Gamma");
  await expect(view(page).getByRole("listitem").filter({ hasText: "Gamma" })).toHaveCount(0);
});
