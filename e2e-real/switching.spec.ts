import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openApp, openNote, ROOT } from "./fixture";

// A second vault on its own server, for a switch the test can hold.
async function otherVault(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "basalt-e2e-other-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  const port = await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, BASALT_PORT: String(port), BASALT_HOST: "127.0.0.1", BASALT_WEB_DIR: join(ROOT, "dist") };
  delete env.BASALT_AUTH;
  delete env.BASALT_VAULT;
  const proc = spawn(join(ROOT, "target/debug/basalt-server"), ["--vault", dir], { env, stdio: "ignore" });
  let root = "";
  for (let i = 0; i < 100 && !root; i++) {
    root = await fetch(`${url}/api/vault-root`).then(async (r) => (r.ok ? ((await r.json()) as { root: string }).root : "")).catch(() => "");
    if (!root) await new Promise((r) => setTimeout(r, 50));
  }
  return {
    url,
    root,
    files: () => readdirSync(dir, { recursive: true }).map(String).filter((p) => !p.startsWith(".")),
    exists: (rel: string) => existsSync(join(dir, rel)),
    stop: () =>
      new Promise<void>((res) => (proc.exitCode !== null ? res() : (proc.once("exit", () => res()), proc.kill()))).then(() =>
        rmSync(dir, { recursive: true, force: true }),
      ),
  };
}

// Models the desktop core: its commands run one at a time, and opening the
// other vault takes `delay`; after it, every command goes to that vault.
async function holdSwitch(page: Page, from: string, to: { url: string; root: string }, delay: number) {
  let backend = from;
  let queue: Promise<unknown> = Promise.resolve();
  const one = <T,>(fn: () => Promise<T>) => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };
  const sent: string[] = [];
  await page.addInitScript(([r]) => localStorage.setItem("basalt.recentVaults", JSON.stringify([{ path: r, name: "A", ts: Date.now() }])), [to.root]);
  await page.route("**/api/invoke", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (body.cmd === "open_vault" && body.args?.path === to.root) {
      await one(async () => {
        await new Promise((r) => setTimeout(r, delay));
        backend = to.url;
      });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: to.root }) });
    }
    const resp = await one(() => route.fetch({ url: `${backend}/api/invoke` }));
    sent.push(`${body.cmd}@${backend === to.url ? "new" : "old"}`);
    return route.fulfill({ response: resp });
  });
  return sent;
}

async function switchTo(page: Page, root: string) {
  await page.getByRole("button", { name: /Command palette/ }).click();
  await page.locator(".palette-input").first().fill("Switch vault");
  await page.keyboard.press("Enter");
  await page.locator(".vault-item", { hasText: root }).first().click();
}

const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

test.describe("while a slow vault switch is under way", () => {
  test.use({
    vaultFiles: {
      "Note X.md": "x\n",
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "XDaily", template: "XTpl" }),
      "XTpl.md": "x template\n",
    },
  });

  test("the old vault's note takes no typing, and nothing is saved to or made in the new vault", async ({ page, vault }) => {
    test.setTimeout(60000);
    const a = await otherVault({ "Welcome A.md": "a\n" });
    try {
      const sent = await holdSwitch(page, vault.url, a, 3000);
      await openApp(page, vault);
      await openNote(page, "Note X");
      await page.waitForTimeout(800);
      await switchTo(page, a.root);
      await page.waitForTimeout(300);
      // Typing, and today's daily note from the keyboard, while A's open waits.
      await page.locator(".pane:not(.dock) .cm-content").first().click({ force: true }).catch(() => {});
      await page.keyboard.type("lost?");
      // The command palette still opens, to switch again, but offers nothing else.
      await page.keyboard.press("ControlOrMeta+p");
      await page.locator(".palette-input").first().fill("daily");
      await expect(page.getByText("No matching command")).toBeVisible();
      await page.locator(".palette-input").first().fill("vault");
      await expect(page.locator(".palette-item")).toHaveText([/Switch vault/]);
      await page.keyboard.press("Escape");
      // Other shortcuts wait: the quick switcher could make a note.
      await page.keyboard.press("ControlOrMeta+o");
      await page.waitForTimeout(200);
      await expect(page.locator(".palette-input")).toHaveCount(0);
      await expect(page.locator(".tree-row.file", { hasText: "Welcome A" })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1500);
      expect(vault.read("Note X.md")).toBe("x\n");
      expect(a.files().sort()).toEqual(["Welcome A.md"]);
      expect(a.exists(`XDaily/${today}.md`)).toBe(false);
      expect(sent.filter((s) => s.startsWith("write_note") || s.startsWith("create_note"))).toEqual([]);
      await expect(page.getByText(/Not saved|escapes/)).toHaveCount(0);
      // And the new vault takes typing again.
      await expect(page.locator("main.main")).not.toHaveAttribute("inert");
    } finally {
      await a.stop();
    }
  });
});
